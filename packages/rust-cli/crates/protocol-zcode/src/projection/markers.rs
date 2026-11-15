//! Fork: compaction timeline markers, like Node's `onCompactLifecycle` (bootstrap
//! `zcode-protocol-v4/product-projection.ts`; specs/fork-rust-agent-parity.md). One `timelineMarker` row per
//! compaction, in the `assistantWork` lane of the current (or latest) turn: `running` when it starts, then `success`,
//! `failed`, or `cancelled` when its turn ends first. A skipped compaction (too little history) is one `noop` row.
//! A cold projection shows each stored compact boundary as a `success` marker. A forked session shows its fork divider.

use rust_cli_kernel_api::message::CompactTrigger;
use serde_json::{Value, json};

use super::{Projection, RowKind};

fn origin(trigger: CompactTrigger) -> &'static str {
    match trigger {
        CompactTrigger::Manual => "manual",
        CompactTrigger::Auto | CompactTrigger::Reactive => "auto",
    }
}

fn marker_key(count: u64) -> String {
    format!("compact:{count}")
}

/// The source of the fork notice attachment (node-records `FORK_NOTICE_SOURCE`).
pub(super) const FORK_NOTICE_SOURCE: &str = "fork";

impl Projection {
    /// Node `onSessionForked` on the child: the fork divider in the latest turn, from the notice's `forkContext`
    /// (the session's parent when the context does not name it). The UI draws it as the link to the parent.
    pub(super) fn fork_notice(
        &mut self,
        context: &Value,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let Some(parent) = context["parentSessionId"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| self.fork_parent.clone())
        else {
            return;
        };
        let target = context["targetMessageId"].as_str().unwrap_or("unknown");
        let key = format!("fork:{parent}:{target}");
        if self.index.contains_key(&key) {
            return;
        }
        let turn = self.marker_turn();
        let mut row = self.base(&turn, &key, RowKind::TimelineMarker, now, seq);
        row.insert("lane".into(), json!("turnTailBoundary"));
        row.insert(
            "marker".into(),
            json!({"type": "forkNotice", "parentSessionId": parent, "parentRowId": 0}),
        );
        self.append(key, row, out);
    }

    /// Node's `turnIdOf`: the running turn, else the latest one.
    fn marker_turn(&self) -> String {
        if let Some(turn) = &self.turn {
            return turn.id.clone();
        }
        self.rows
            .iter()
            .rev()
            .find_map(|row| row.get("turnId").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default()
    }

    /// B1.1: Node's pending `worktreeCreated` flush at the turn header (product-projection.ts
    /// `onTurnStarted`): the creation fact the create stored becomes a `timelineMarker` row leading the first
    /// turn, before the turn's model divider and header — the fact is recorded before TurnStarted, so the marker
    /// rides the `lightBoundary` lane like Node's flush. The row key is Node's `worktree-created:<path>`; the
    /// index keeps one marker per session, and a rebuilt history (fresh index) draws it again.
    pub(super) fn worktree_created(
        &mut self,
        turn: &str,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let Some(fact) = self.worktree_created.clone() else {
            return;
        };
        let path = fact["path"].as_str().unwrap_or_default();
        let key = format!("worktree-created:{path}");
        if self.index.contains_key(&key) {
            return;
        }
        let mut row = self.base(turn, &key, RowKind::TimelineMarker, now, seq);
        row.insert("lane".into(), json!("lightBoundary"));
        let mut marker = json!({"type": "worktreeCreated"});
        if let Value::Object(fields) = fact {
            for (field, value) in fields {
                marker[field.as_str()] = value.clone();
            }
        }
        row.insert("marker".into(), marker);
        self.append(key, row, out);
    }

    fn append_compact_marker(
        &mut self,
        trigger: CompactTrigger,
        status: &str,
        tokens_before: Option<u64>,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        self.compactions += 1;
        let key = marker_key(self.compactions);
        let entity = format!("compact_{}", self.compactions);
        let turn = self.marker_turn();
        let mut row = self.base(&turn, &entity, RowKind::TimelineMarker, now, seq);
        let mut marker = json!({"type": "compact", "origin": origin(trigger), "status": status});
        if let Some(tokens) = tokens_before {
            marker["tokensBefore"] = json!(tokens);
        }
        row.insert("lane".into(), json!("assistantWork"));
        row.insert("marker".into(), marker);
        // Node `onCompactLifecycle`: a manual compaction carries the input that asked for it.
        if trigger == CompactTrigger::Manual
            && let Some(command) = self.turn.as_ref().and_then(|turn| turn.command.clone())
        {
            row.insert("sourceCommandId".into(), json!(command));
        }
        self.append(key, row, out);
    }

    pub(super) fn compact_started(
        &mut self,
        trigger: CompactTrigger,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        self.append_compact_marker(trigger, "running", None, now, seq, out);
    }

    /// Settles the running marker; a terminal event without a started marker changes nothing.
    pub(super) fn compact_settled(&mut self, status: &str, out: &mut Vec<Value>) {
        let key = marker_key(self.compactions);
        self.upsert(
            &key,
            |row| {
                if let Some(marker) = row.get_mut("marker")
                    && marker["status"] == "running"
                {
                    marker["status"] = json!(status);
                }
            },
            out,
        );
    }

    /// Node `skipped`: one settled `noop` row, no compact work.
    pub(super) fn compact_skipped(
        &mut self,
        trigger: CompactTrigger,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        self.append_compact_marker(trigger, "noop", None, now, seq, out);
    }

    /// A stored compact boundary (cold projection).
    pub(super) fn compacted(
        &mut self,
        trigger: CompactTrigger,
        tokens_before: u64,
        now: u64,
        out: &mut Vec<Value>,
    ) {
        self.append_compact_marker(trigger, "success", Some(tokens_before), now, 0, out);
    }
}
