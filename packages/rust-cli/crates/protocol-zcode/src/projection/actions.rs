//! Fork: row actions (`rowBaseFields.actions`) the App shows as the edit, retry and fork buttons, computed the way
//! Node's `materializeCommandRowActions` does (bootstrap `zcode-protocol-v4/product-projection.ts`;
//! specs/fork-rust-agent-parity.md). Each recompute upserts only the rows whose actions changed, so the latest target
//! moving from one row to another upserts both rows.
//!
//! `canRewindFiles` follows the turn header's `fileChanges` summary and the kernel's `rewindable` flag
//! (`KernelEvent::FileChanges`; the App's "conversation + files" rewind button).

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

use super::{Projection, RowKind, state::Phase};

/// A row action a command asks for; the command is accepted only when the row currently offers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowAction {
    Edit,
    Retry,
    Fork,
    /// Fork: the `v4/conversation/fileChanges` query (any turn header row, like Node's row rule).
    FileChanges,
    /// Fork: `v4/conversation/fileRewindPreview` and the `applyFileRewind` command (a finished
    /// turn offering `canRewindFiles`).
    FileRewind,
}

impl RowAction {
    fn flag(self) -> Option<&'static str> {
        match self {
            Self::Edit => Some("canEdit"),
            Self::Retry => Some("canRetry"),
            Self::Fork => Some("canFork"),
            Self::FileRewind => Some("canRewindFiles"),
            // Node's `fileChanges` query needs only a turnHeader row (product-projection.ts).
            Self::FileChanges => None,
        }
    }
}

/// What a row action command needs from the row it targets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowTarget {
    /// The typed user message of the row's turn (the rewind and fork anchor).
    pub user_message: String,
    /// The assistant message of an `assistantText` row.
    pub assistant_message: Option<String>,
}

/// Why a row action command has no target, like Node's `resolveRowActionTarget`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetMiss {
    /// The projection no longer holds the row, or the row's `entityId` changed: `proto.staleTarget`.
    Stale,
    /// The row exists but does not offer the action now: `guard.actionUnavailable`.
    Unavailable,
}

impl TargetMiss {
    /// The Node reason code of the refusal.
    pub fn code(self) -> &'static str {
        match self {
            Self::Stale => "proto.staleTarget",
            Self::Unavailable => "guard.actionUnavailable",
        }
    }
}

fn turn_of(row: &Map<String, Value>) -> &str {
    row.get("turnId")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn is_real_user(row: &Map<String, Value>) -> bool {
    RowKind::of(row) == Some(RowKind::UserInput) && row["origin"] == "realUser"
}

impl Projection {
    fn turn_user_message(&self, turn: &str) -> Option<String> {
        self.rows
            .iter()
            .find(|row| is_real_user(row) && turn_of(row) == turn)
            .and_then(|row| row["entityId"].as_str().map(str::to_owned))
    }

    /// Recomputes every row's actions and appends a `row.upserted` for each row whose actions changed. One pass
    /// builds the per-turn facts, so a recompute is linear in the rows.
    pub(super) fn refresh_actions(&mut self, out: &mut Vec<Value>) {
        let compacting = self.compacting;
        let blocking = self.phase == Phase::Running || compacting;
        let mut headers: HashMap<&str, &str> = HashMap::new();
        let mut users: HashSet<&str> = HashSet::new();
        let mut latest_by_turn: HashMap<&str, usize> = HashMap::new();
        let (mut latest_user, mut latest_assistant) = (None, None);
        for (at, row) in self.rows.iter().enumerate() {
            let turn = turn_of(row);
            match RowKind::of(row) {
                Some(RowKind::TurnHeader) => {
                    headers.insert(turn, row["state"].as_str().unwrap_or_default());
                }
                Some(RowKind::UserInput) if is_real_user(row) => {
                    users.insert(turn);
                    latest_user = Some(at);
                }
                Some(RowKind::AssistantText) => {
                    latest_by_turn.insert(turn, at);
                    latest_assistant = Some(at);
                }
                _ => {}
            }
        }
        let latest_editable = latest_user.filter(|_| !compacting);
        let latest_retryable = latest_assistant.filter(|&at| {
            let row = &self.rows[at];
            let turn = turn_of(row);
            !blocking
                && row["state"] == "complete"
                && row.contains_key("assistantResponseId")
                && headers.get(turn).is_some_and(|state| *state != "running")
                && users.contains(turn)
        });
        let mut changed = Vec::new();
        for at in 0..self.rows.len() {
            let row = &self.rows[at];
            let mut actions = row
                .get("actions")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            match RowKind::of(row) {
                Some(RowKind::UserInput) => {
                    if Some(at) == latest_editable {
                        actions.insert("canEdit".into(), json!(true));
                        actions.insert("editDisposition".into(), json!("rewind"));
                    } else {
                        actions.remove("canEdit");
                        actions.remove("editDisposition");
                    }
                }
                Some(RowKind::AssistantText) => {
                    if Some(at) == latest_retryable {
                        actions.insert("canRetry".into(), json!(true));
                    } else {
                        actions.remove("canRetry");
                    }
                    let turn = turn_of(row);
                    let can_fork = !compacting
                        && row["state"] == "complete"
                        && headers.get(turn) == Some(&"completedSuccess")
                        && latest_by_turn.get(turn) == Some(&at)
                        && row.contains_key("assistantResponseId")
                        && users.contains(turn);
                    if can_fork {
                        actions.insert("canFork".into(), json!(true));
                    } else {
                        actions.remove("canFork");
                    }
                }
                Some(RowKind::TurnHeader) => {
                    // Fork: `canRewindFiles` like Node's `materializeCommandRowActions`: a finished turn with
                    // active file changes offers the rewind-files action, and only when the kernel reported the
                    // checkpoints rewindable and nothing (running turn, compaction, pending interaction) blocks
                    // completion. Every finished turn with changes offers it, not just the latest.
                    let can_rewind_files = !blocking
                        && row["state"] != "running"
                        && self.pending.is_empty()
                        && row.get("fileChanges").is_some_and(|changes| {
                            changes.get("state").and_then(Value::as_str) == Some("active")
                                && changes
                                    .get("files")
                                    .and_then(Value::as_u64)
                                    .is_some_and(|files| files > 0)
                        })
                        && self
                            .turn_file_changes
                            .get(turn_of(row))
                            .is_some_and(|changes| changes.rewindable);
                    if can_rewind_files {
                        actions.insert("canRewindFiles".into(), json!(true));
                    } else {
                        actions.remove("canRewindFiles");
                    }
                }
                _ => continue,
            }
            let next = (!actions.is_empty()).then(|| Value::Object(actions));
            if row.get("actions") != next.as_ref() {
                changed.push((at, next));
            }
        }
        for (at, next) in changed {
            let row = &mut self.rows[at];
            match next {
                Some(actions) => {
                    row.insert("actions".into(), actions);
                }
                None => {
                    row.remove("actions");
                }
            }
            out.push(json!({"op": "row.upserted", "row": row.clone()}));
        }
    }

    /// The target of a row action command: the row must exist with this `entityId` and offer `action` now (Node's
    /// latest-only guards: an older row lost its action when a newer one became the target).
    pub fn row_target(
        &self,
        row_id: u64,
        entity: &str,
        action: RowAction,
    ) -> Result<RowTarget, TargetMiss> {
        let row = self
            .rows
            .iter()
            .find(|row| row["rowId"].as_u64() == Some(row_id))
            .ok_or(TargetMiss::Stale)?;
        let offered = action.flag().is_none_or(|flag| {
            row.get("actions")
                .and_then(|actions| actions.get(flag))
                .and_then(Value::as_bool)
                == Some(true)
        });
        if row["entityId"] != entity {
            return Err(TargetMiss::Stale);
        }
        if !offered {
            return Err(TargetMiss::Unavailable);
        }
        let target = (|| match RowKind::of(row) {
            Some(RowKind::UserInput) => Some(RowTarget {
                user_message: entity.to_owned(),
                assistant_message: None,
            }),
            Some(RowKind::AssistantText) => Some(RowTarget {
                user_message: self.turn_user_message(turn_of(row))?,
                assistant_message: row["assistantResponseId"].as_str().map(str::to_owned),
            }),
            // Fork: the row queries (`fileChanges`, `fileRewindPreview`, `applyFileRewind`)
            // address a turn header; the target is the turn's typed user message (the kernel's
            // per-turn anchor).
            // A turn opened by a model-only message (a background task notification) has no
            // typed user row; its anchor comes with the turn's file changes.
            Some(RowKind::TurnHeader) => Some(RowTarget {
                user_message: self.turn_user_message(turn_of(row)).or_else(|| {
                    self.turn_file_changes
                        .get(turn_of(row))
                        .and_then(|changes| changes.anchor.clone())
                })?,
                assistant_message: None,
            }),
            _ => None,
        })();
        target.ok_or(TargetMiss::Unavailable)
    }
}
