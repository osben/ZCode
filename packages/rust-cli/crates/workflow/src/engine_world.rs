//! World reads and world runs (Node `engine/engine-world.ts`; specs/fork-rust-workflow-engine.md section 9.5).
//!
//! A world node is an ordinal of its own, like an ask. It is not subject to the actor FIFO or the cap (Node:
//! harness I/O). A recorded completed or failed row replays through the settle-order gate with no driver call.
//! A running row is redriven. A world run closes the amend import cache before it executes, because it may
//! change the workspace. The import queue answers a world read from the predecessor only while the cache is
//! open.
use crate::canon::{canonical_json, fnv1a};
use crate::engine::{WorkflowDriver, WorkflowEngine};
use crate::error::{ErrorCode, WorkflowError};
use crate::event::{ImportCloseCause, NodeOutcome, RunEvent};
use crate::journal::JournalPort;
use crate::model::{NodeKind, NodeRow, NodeStatus, Ref, StoredEvent};
use crate::replay::{CachedOutcome, CachedSettle, Release};
use crate::scheduler::hash_mismatch;
use anyhow::Result;
use rust_cli_base::js::json::stringify;
use rust_cli_base::js::string::{utf16_len, utf16_prefix};
use serde_json::{Value, json};
use std::collections::HashSet;

/// Node `TRUNCATED_ARG_MAX_CHARS`: the preview of one argument in truncation mode, in UTF-16 units.
const TRUNCATED_ARG_MAX_UNITS: usize = 400;
/// Node `MAX_ARGS_KEPT`.
const MAX_ARGS_KEPT: usize = 8;
/// Node `WORLD_READ_INPUT_MAX_BYTES`.
pub const WORLD_READ_INPUT_MAX_BYTES: usize = 4096;

/// Node `boundWorldReadInput`: the `{op, args}` written with the row. Within the byte limit it is the plain
/// object. Above it, each argument is a bounded string preview and the object is marked `truncated`.
pub fn bound_world_read_input(op: &str, args: &[Value]) -> Value {
    let plain = json!({"op": op, "args": args});
    if stringify(&plain).len() <= WORLD_READ_INPUT_MAX_BYTES {
        return plain;
    }
    let previews: Vec<Value> = args
        .iter()
        .take(MAX_ARGS_KEPT)
        .map(|arg| Value::String(preview_arg(arg)))
        .collect();
    json!({"op": op, "args": previews, "truncated": true})
}

/// Node `previewArg`: a string as is, anything else as its JSON text, cut to 400 UTF-16 units with an ellipsis.
fn preview_arg(value: &Value) -> String {
    let text = match value {
        Value::String(text) => text.clone(),
        other => stringify(other),
    };
    if utf16_len(&text) > TRUNCATED_ARG_MAX_UNITS {
        format!("{}…", utf16_prefix(&text, TRUNCATED_ARG_MAX_UNITS))
    } else {
        text
    }
}

/// Node `inputHash({op, args})`: FNV-1a over the canonical JSON of the object.
pub fn world_input_hash(op: &str, args: &Value) -> String {
    fnv1a(&canonical_json(&json!({"op": op, "args": args})))
}

/// Node `readWorld`'s rejection for a driver failure that is not a workflow error.
pub fn world_read_driver_error(op: &str, args: &Value) -> WorkflowError {
    WorkflowError::new(
        ErrorCode::DriverError,
        format!("World read failed: {op} {}.", canonical_json(args)),
    )
}

/// A live world node the driver is executing: its ticket and the facts admission fixed (Node's closure over
/// `kind`, `hash` and `input` in `readWorld`).
#[derive(Debug, Clone)]
pub(crate) struct WorldLive {
    pub(crate) ticket: u64,
    pub(crate) kind: NodeKind,
    pub(crate) hash: String,
    pub(crate) input: Value,
}

impl<J: JournalPort, D: WorkflowDriver> WorkflowEngine<J, D> {
    /// Node `worldRead`: one world read (`op` other than `run`) or world run (`op == "run"`) at the next ordinal
    /// of `site_id`. Returns the ticket. The settlement arrives as an `AskOutcome` with that ticket. A live read
    /// is executed by the driver and finished through [`WorkflowEngine::world_read_settled`].
    pub fn world_read(&mut self, site_id: &str, op: &str, args: Vec<Value>) -> Result<u64> {
        let ticket = self.allocate_ticket();
        if self.is_settled() {
            let error = self.run_error();
            self.push_outcome(ticket, Err(error));
            return Ok(ticket);
        }
        let ordinal = self.identity.next_ordinal(site_id);
        let instance = Ref::new(site_id, ordinal);
        let args_value = Value::Array(args);
        let hash = world_input_hash(op, &args_value);
        let input =
            bound_world_read_input(op, args_value.as_array().map_or(&[][..], Vec::as_slice));

        if let Some(row) = self.journal.get_node(&self.run_id, &instance)? {
            if row.input_hash != hash {
                let error = hash_mismatch(&instance, &row.input_hash, &hash);
                self.fail_run(error.clone())?;
                self.push_outcome(ticket, Err(error));
                return Ok(ticket);
            }
            // A completed or failed row settles from the journal, with no driver call. A running row was
            // interrupted during execution and runs live again below.
            let outcome = match row.status {
                NodeStatus::Completed => {
                    Some(CachedOutcome::Completed(row.result.unwrap_or(Value::Null)))
                }
                NodeStatus::Failed => Some(CachedOutcome::Failed(row.error.unwrap_or(Value::Null))),
                NodeStatus::Running => None,
            };
            if let Some(outcome) = outcome {
                self.hold_for_replay(
                    &instance,
                    Release::Cached(CachedSettle {
                        instance: instance.clone(),
                        ticket,
                        outcome,
                        facts: None,
                    }),
                )?;
                return Ok(ticket);
            }
        }

        let kind = if op == "run" {
            NodeKind::WorldRun
        } else {
            NodeKind::WorldRead
        };
        // Consult the import queue only when the run has no row (replay takes precedence) and the cache is
        // still open. A hit writes a completed row and settles without the driver.
        let imported = if self.import_closed {
            None
        } else {
            self.imported_world.take(&hash)
        };
        if let Some(entry) = imported {
            self.journal.put_node(world_row(
                &self.run_id,
                &instance,
                kind,
                &hash,
                Some(input),
                NodeStatus::Completed,
                Some(entry.result.clone()),
                None,
            ))?;
            self.record(RunEvent::NodeSettled {
                instance,
                outcome: NodeOutcome::Ok,
                cached: true,
                error: None,
                facts: None,
                phase: None,
            })?;
            self.push_outcome(ticket, Ok(entry.result));
            return Ok(ticket);
        }

        // A live world run is a write. The cache closes before the effect, and only here.
        if kind == NodeKind::WorldRun {
            self.close_import_cache(&instance, ImportCloseCause::WorldRun, None)?;
        }
        // The running row is written at admission, so an interrupted read can run again on resume.
        self.journal.put_node(world_row(
            &self.run_id,
            &instance,
            kind,
            &hash,
            Some(input.clone()),
            NodeStatus::Running,
            None,
            None,
        ))?;
        self.record(RunEvent::WorldQueued {
            instance: instance.clone(),
            kind,
            phase: None,
        })?;
        self.record(RunEvent::WorldDispatched {
            instance: instance.clone(),
        })?;
        self.world_live.insert(
            instance.key(),
            WorldLive {
                ticket,
                kind,
                hash,
                input,
            },
        );
        self.driver.start_world_read(&instance, op, &args_value);
        Ok(ticket)
    }

    /// Node `settleWorldRead`: the driver finished a live world node. A failure that is not a workflow error is
    /// wrapped with [`world_read_driver_error`] by the host. After run settlement the outcome is the run error,
    /// and nothing is written.
    pub fn world_read_settled(
        &mut self,
        instance: &Ref,
        result: Result<Value, WorkflowError>,
    ) -> Result<()> {
        let Some(live) = self.world_live.remove(&instance.key()) else {
            return Ok(());
        };
        if self.is_settled() {
            let error = self.run_error();
            self.push_outcome(live.ticket, Err(error));
            return Ok(());
        }
        match result {
            Ok(value) => {
                self.journal.put_node(world_row(
                    &self.run_id,
                    instance,
                    live.kind,
                    &live.hash,
                    Some(live.input),
                    NodeStatus::Completed,
                    Some(value.clone()),
                    None,
                ))?;
                self.record(RunEvent::NodeSettled {
                    instance: instance.clone(),
                    outcome: NodeOutcome::Ok,
                    cached: false,
                    error: None,
                    facts: None,
                    phase: None,
                })?;
                self.push_outcome(live.ticket, Ok(value));
            }
            Err(error) => {
                let error_json = error.to_json();
                self.journal.put_node(world_row(
                    &self.run_id,
                    instance,
                    live.kind,
                    &live.hash,
                    Some(live.input),
                    NodeStatus::Failed,
                    None,
                    Some(error_json.clone()),
                ))?;
                self.record(RunEvent::NodeSettled {
                    instance: instance.clone(),
                    outcome: NodeOutcome::Failed,
                    cached: false,
                    error: Some(error_json),
                    facts: None,
                    phase: None,
                })?;
                self.push_outcome(live.ticket, Err(error));
            }
        }
        Ok(())
    }

    /// Node `askMutating`: a subagent in an active ask is about to run a mutating tool. Only the first write
    /// closes the cache. Observations after the run or the ask settled are ignored.
    pub fn ask_mutating(&mut self, instance: &Ref) -> Result<()> {
        if self.is_settled() || !self.is_live_ask(instance) {
            return Ok(());
        }
        let actor_name = self.live_actor_name(instance);
        self.close_import_cache(instance, ImportCloseCause::MutatingTool, actor_name)
    }

    /// The driver's write of an ask's message boundary (Node `workflow-driver-transcript.ts`, a `putNode` of the
    /// recorded row with `messageBoundary`). The engine does not compute it.
    pub fn set_message_boundary(&mut self, instance: &Ref, boundary: u64) -> Result<()> {
        let Some(mut row) = self.journal.get_node(&self.run_id, instance)? else {
            return Ok(());
        };
        row.message_boundary = Some(boundary);
        self.journal.put_node(row)
    }

    /// Node `closeImportCache`: idempotent. The closure event is written only for an amended run.
    pub(crate) fn close_import_cache(
        &mut self,
        instance: &Ref,
        cause: ImportCloseCause,
        actor_name: Option<String>,
    ) -> Result<()> {
        if self.import_closed {
            return Ok(());
        }
        self.import_closed = true;
        if self.imported_cache.is_none() {
            return Ok(());
        }
        self.record(RunEvent::ImportCacheClosed {
            instance: instance.clone(),
            cause,
            actor_name,
        })
    }
}

/// Node `putNode` of a world row. The input and the result or error are written as the row carries them.
#[allow(clippy::too_many_arguments)]
fn world_row(
    run_id: &str,
    instance: &Ref,
    kind: NodeKind,
    hash: &str,
    input: Option<Value>,
    status: NodeStatus,
    result: Option<Value>,
    error: Option<Value>,
) -> NodeRow {
    NodeRow {
        run_id: run_id.to_owned(),
        site_id: instance.site_id.clone(),
        ordinal: instance.ordinal,
        kind,
        actor_site_id: None,
        actor_ordinal: None,
        actor_seq: None,
        input_hash: hash.to_owned(),
        status,
        result,
        error,
        stats: None,
        input,
        message_boundary: None,
    }
}

/// Node `recoverImportClosure` input: the closure state and the asks that ran live, from this run's events.
/// The event order decides `queued_before_close`: a `node-queued` before the first closure was admitted while
/// the cache was open.
#[derive(Debug, Default)]
pub(crate) struct RecoveredClosure {
    pub(crate) live: HashSet<String>,
    pub(crate) queued_before_close: HashSet<String>,
    pub(crate) closed: bool,
}

pub(crate) fn recover_import_closure(events: &[StoredEvent]) -> RecoveredClosure {
    let mut recovered = RecoveredClosure::default();
    for event in events {
        let Ok(value) = serde_json::from_str::<Value>(&event.payload_json) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("import-cache-closed") => recovered.closed = true,
            Some("node-queued") if value.get("kind").and_then(Value::as_str) == Some("ask") => {
                let Some(key) = instance_key(&value) else {
                    continue;
                };
                recovered.live.insert(key.clone());
                if !recovered.closed {
                    recovered.queued_before_close.insert(key);
                }
            }
            _ => {}
        }
    }
    recovered
}

fn instance_key(event: &Value) -> Option<String> {
    let instance = event.get("instance")?;
    let site = instance.get("siteId")?.as_str()?;
    let ordinal = instance.get("ordinal")?.as_u64()?;
    Some(Ref::new(site, ordinal).key())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_input_is_the_plain_object() {
        let input = bound_world_read_input("git.log", &[json!("main")]);
        assert_eq!(input, json!({"op": "git.log", "args": ["main"]}));
    }

    #[test]
    fn a_long_input_keeps_eight_bounded_previews_and_is_marked_truncated() {
        let long = "x".repeat(5000);
        let args: Vec<Value> = (0..10).map(|_| json!(long.clone())).collect();
        let input = bound_world_read_input("run", &args);
        assert_eq!(input["truncated"], json!(true));
        let kept = input["args"].as_array().expect("args");
        assert_eq!(kept.len(), 8);
        let first = kept[0].as_str().expect("string preview");
        assert_eq!(utf16_len(first), 401);
        assert!(first.ends_with('…'));
    }
}
