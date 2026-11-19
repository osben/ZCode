//! The ask scheduler (Node `engine/scheduler.ts` and `scheduler-types.ts`): admission with per-actor FIFO
//! and the replay hold rule, dispatch under the run's concurrency cap, node rows and events, and the
//! settlement of an ask. Typed submit and turn-end handling are in `scheduler_submit.rs`.
//!
//! Admission order is per actor (`actorSeq`). A recorded row takes its recorded seq; a live ask takes the
//! next seq once every recorded row of the actor has been admitted. Settlement of an ask finishes the
//! node, updates the row, emits `node-settled`, and starts the next queued ask.
use crate::canon::{canonical_json, fnv1a};
use crate::engine::{
    AskMessage, AskSpec, AskStats, WorkflowDriver, WorkflowEngine, describe_cause,
};
use crate::error::{ErrorCode, Mismatch, WorkflowError};
use crate::event::{AskFacts, NodeOutcome, RunEvent};
use crate::imported_cache::{ActorSessionSeed, ImportedActorState, imported_ask_record};
use crate::journal::JournalPort;
use crate::model::{ActorRow, NodeKind, NodeRow, NodeStatus, Ref};
use crate::persona::persona_model;
use crate::replay::{CachedOutcome, CachedSettle, Job, Release};
use anyhow::{Result, anyhow};
use rust_cli_base::js::string::{trim as js_trim, utf16_prefix};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, VecDeque};

/// Node `REPAIR_ATTEMPTS`: rejected submits a typed ask may repair in place.
pub const REPAIR_ATTEMPTS: u32 = 3;
/// Node `NUDGE_ATTEMPTS`: silent turns a typed ask may be nudged through.
pub const NUDGE_ATTEMPTS: u32 = 1;
/// Node `INSTRUCTIONS_HEAD_MAX_CHARS`, counted in UTF-16 units as `String.prototype.slice` does.
const INSTRUCTIONS_HEAD_MAX_UNITS: usize = 240;

/// Node `inputHash`: FNV-1a over the canonical JSON of the instructions string.
pub fn input_hash(instructions: &str) -> String {
    fnv1a(&canonical_json(&Value::String(instructions.to_owned())))
}

/// Node `hashMismatch`: a replay hit whose input differs from the recorded one.
pub fn hash_mismatch(instance: &Ref, expected: &str, got: &str) -> WorkflowError {
    WorkflowError {
        mismatch: Some(Mismatch {
            expected: expected.to_owned(),
            got: got.to_owned(),
        }),
        ..WorkflowError::new(
            ErrorCode::InputHashMismatch,
            format!(
                "Replay hit at {} but inputHash differs (expected {expected}, got {got}): the script is not deterministic, so the journal cannot be replayed.",
                instance.key()
            ),
        )
    }
}

/// Node `headOfInstructions`: the trimmed instructions, bounded to 240 UTF-16 units; absent for empty text.
/// Deviation: when a surrogate pair straddles unit 240, Node keeps the high half (a lone surrogate, which
/// `JSON.stringify` writes as `\ud83d`). A Rust `String` cannot hold that, so the pair is dropped and the
/// head is one unit shorter. Pinned by `engine_tests::instructions_head_cuts_by_utf16_units`.
pub fn instructions_head(instructions: &str) -> Option<String> {
    let trimmed = js_trim(instructions);
    if trimmed.is_empty() {
        return None;
    }
    Some(utf16_prefix(trimmed, INSTRUCTIONS_HEAD_MAX_UNITS).to_owned())
}

/// How an actor's session is obtained (Node `actor.sessionPromise`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionState {
    None,
    Ready(String),
    /// The driver could not create the session; the message is the bounded cause.
    Failed(String),
    /// The journal's recorded session id is not the minted one (Node `createActorSession`'s reattachment check).
    /// The driver is not called, so no session is created.
    Mismatched {
        expected: String,
        got: String,
    },
}

/// An ask whose recorded row decides its settlement (Node `pendingRecorded`).
#[derive(Debug, Clone, PartialEq)]
pub enum PendingRecorded {
    /// The row was running when the process died: dispatch it again at its recorded position.
    Running {
        instance: Ref,
        instructions: String,
        hash: String,
        spec: AskSpec,
        ticket: u64,
    },
    /// The row settled: replay its outcome through the gate.
    Settled {
        instance: Ref,
        instructions: String,
        row: Box<NodeRow>,
        ticket: u64,
    },
}

/// A miss waiting for its admission turn (Node `pendingLive`).
#[derive(Debug, Clone, PartialEq)]
pub struct PendingLive {
    pub instance: Ref,
    pub instructions: String,
    pub hash: String,
    pub spec: AskSpec,
    pub ticket: u64,
}

/// Actor state (Node `Actor`). `name` is the createActor argument; `persona` the normalized spec.
#[derive(Debug)]
pub struct Actor {
    pub(crate) actor_ref: Ref,
    pub(crate) name: Option<String>,
    pub(crate) persona: Value,
    pub(crate) recorded_count: u64,
    pub(crate) next_admit_seq: u64,
    pub(crate) pending_recorded: BTreeMap<u64, PendingRecorded>,
    pub(crate) pending_live: VecDeque<PendingLive>,
    pub(crate) live_queue: VecDeque<u64>,
    pub(crate) current: Option<u64>,
    pub(crate) session: SessionState,
    /// Import consumption state, when a predecessor candidate matched (Node `actor.imported`).
    pub(crate) imported: Option<ImportedActorState>,
}

impl Actor {
    /// `recorded_count` is the number of ask rows the journal already holds for this actor.
    pub(crate) fn new(
        actor_ref: Ref,
        name: Option<String>,
        persona: Value,
        recorded_count: u64,
    ) -> Self {
        Self {
            actor_ref,
            name,
            persona,
            recorded_count,
            next_admit_seq: 0,
            pending_recorded: BTreeMap::new(),
            pending_live: VecDeque::new(),
            live_queue: VecDeque::new(),
            current: None,
            session: SessionState::None,
            imported: None,
        }
    }
}

/// A live ask (Node `AskNode`), from admission until its settlement.
#[derive(Debug)]
pub struct AskNode {
    pub(crate) instance: Ref,
    pub(crate) actor_id: String,
    pub(crate) actor_ref: Ref,
    pub(crate) actor_seq: u64,
    pub(crate) instructions: String,
    pub(crate) hash: String,
    pub(crate) spec: AskSpec,
    pub(crate) ticket: u64,
    pub(crate) repairs_remaining: u32,
    pub(crate) nudges_remaining: u32,
    pub(crate) dispatched: bool,
    pub(crate) last_stats: Option<Value>,
    pub(crate) instructions_head: Option<String>,
}

impl<J: JournalPort, D: WorkflowDriver> WorkflowEngine<J, D> {
    /// The actor of an ask. Every ask is admitted to a registered actor (the ask path checks first), so
    /// a miss here is an engine bug and is reported as such.
    pub(crate) fn actor(&self, actor_id: &str) -> Result<&Actor> {
        self.actors
            .get(actor_id)
            .ok_or_else(|| anyhow!("workflow engine: unknown actor {actor_id}"))
    }

    fn actor_mut(&mut self, actor_id: &str) -> Result<&mut Actor> {
        self.actors
            .get_mut(actor_id)
            .ok_or_else(|| anyhow!("workflow engine: unknown actor {actor_id}"))
    }

    /// Node `admitAsk`: a fresh ordinal, then either the recorded row decides the outcome, or the ask
    /// joins the actor's pending misses.
    pub(crate) fn admit_ask(
        &mut self,
        ticket: u64,
        site_id: &str,
        actor_id: &str,
        instructions: &str,
        spec: AskSpec,
    ) -> Result<()> {
        let ordinal = self.identity.next_ordinal(site_id);
        let instance = Ref::new(site_id, ordinal);
        let hash = input_hash(instructions);
        if let Some(row) = self.journal.get_node(&self.run_id, &instance)? {
            if row.input_hash != hash {
                let error = hash_mismatch(&instance, &row.input_hash, &hash);
                self.fail_run(error.clone())?;
                self.push_outcome(ticket, Err(error));
                return Ok(());
            }
            let seq = row.actor_seq.unwrap_or(0);
            let pending = if row.status == NodeStatus::Running {
                PendingRecorded::Running {
                    instance,
                    instructions: instructions.to_owned(),
                    hash,
                    spec,
                    ticket,
                }
            } else {
                PendingRecorded::Settled {
                    instance,
                    instructions: instructions.to_owned(),
                    row: Box::new(row),
                    ticket,
                }
            };
            self.actor_mut(actor_id)?
                .pending_recorded
                .insert(seq, pending);
            return self.drain_admission(actor_id);
        }
        self.actor_mut(actor_id)?
            .pending_live
            .push_back(PendingLive {
                instance,
                instructions: instructions.to_owned(),
                hash,
                spec,
                ticket,
            });
        self.drain_admission(actor_id)?;
        self.pump_all()
    }

    /// Node `drainAdmission`: admit in seq order while the next seq is recorded, then live misses once
    /// every recorded row of the actor has been admitted. Then start what the cap allows.
    fn drain_admission(&mut self, actor_id: &str) -> Result<()> {
        loop {
            let seq = self.actor(actor_id)?.next_admit_seq;
            if let Some(pending) = self.actor_mut(actor_id)?.pending_recorded.remove(&seq) {
                self.actor_mut(actor_id)?.next_admit_seq += 1;
                self.run_pending_recorded(actor_id, seq, pending)?;
                continue;
            }
            let live_ready = {
                let actor = self.actor(actor_id)?;
                seq >= actor.recorded_count && !actor.pending_live.is_empty()
            };
            if !live_ready {
                break;
            }
            let Some(live) = ({
                let actor = self.actor_mut(actor_id)?;
                actor.next_admit_seq += 1;
                actor.pending_live.pop_front()
            }) else {
                break;
            };
            // Node `tryImportedSettle`: a fresh miss may be answered by the predecessor's transcript. A hit
            // settles here and never reaches the driver.
            if self.try_imported_settle(actor_id, seq, &live)? {
                continue;
            }
            // Node `carriedAt`: this miss continues the predecessor's in-flight ask.
            let prior = self
                .actor(actor_id)?
                .imported
                .as_ref()
                .is_some_and(|imported| imported.carried_at(seq));
            self.admit_live(
                actor_id,
                seq,
                LiveAsk {
                    instance: live.instance,
                    instructions: live.instructions,
                    hash: live.hash,
                    spec: live.spec,
                    ticket: live.ticket,
                    prior,
                },
            )?;
        }
        self.pump_actor(actor_id)
    }

    /// Node `tryImportedSettle`: answer a fresh ask from the import cache. The hit writes one real row and a
    /// cached settlement (with the birth facts, read after the take). Returns whether it hit.
    fn try_imported_settle(
        &mut self,
        actor_id: &str,
        seq: u64,
        live: &PendingLive,
    ) -> Result<bool> {
        let closed = self.import_closed;
        let actor_ref = self.actor(actor_id)?.actor_ref.clone();
        let Some(imported) = self.actor_mut(actor_id)?.imported.as_mut() else {
            return Ok(false);
        };
        let entry = if closed {
            imported.take_if_pure(seq, &live.hash)
        } else {
            imported.take(seq, &live.hash)
        };
        let Some(entry) = entry else {
            return Ok(false);
        };
        let source = imported.source_session_at(seq);
        self.journal.put_node(imported_ask_record(
            &self.run_id,
            &live.instance,
            &actor_ref,
            seq,
            &live.hash,
            &entry,
        ))?;
        self.record(RunEvent::NodeSettled {
            instance: live.instance.clone(),
            outcome: NodeOutcome::Ok,
            cached: true,
            error: None,
            facts: Some(AskFacts {
                actor: actor_ref,
                actor_seq: seq,
                instructions_head: instructions_head(&live.instructions),
                source_session_id: source,
            }),
            phase: None,
        })?;
        self.push_outcome(live.ticket, Ok(entry.result));
        Ok(true)
    }

    /// Node `reconcile` in the recorded branch of `admitAsk`: rebuild the import divergence from a recorded row,
    /// using the event facts of the first lifetime (see `recover_import_closure`).
    fn reconcile_recorded_ask(
        &mut self,
        actor_id: &str,
        instance: &Ref,
        seq: u64,
        recorded_hash: &str,
    ) -> Result<()> {
        let was_live = self.live_before_resume.contains(&instance.key());
        let queued_before_close = self.queued_before_close.contains(&instance.key());
        if let Some(imported) = self.actor_mut(actor_id)?.imported.as_mut() {
            imported.reconcile_recorded(seq, recorded_hash, was_live, queued_before_close);
        }
        Ok(())
    }

    fn run_pending_recorded(
        &mut self,
        actor_id: &str,
        seq: u64,
        pending: PendingRecorded,
    ) -> Result<()> {
        match pending {
            PendingRecorded::Running {
                instance,
                instructions,
                hash,
                spec,
                ticket,
            } => {
                self.reconcile_recorded_ask(actor_id, &instance, seq, &hash)?;
                self.admit_live(
                    actor_id,
                    seq,
                    LiveAsk {
                        instance,
                        instructions,
                        hash,
                        spec,
                        ticket,
                        prior: true,
                    },
                )
            }
            PendingRecorded::Settled {
                instance,
                instructions,
                row,
                ticket,
            } => {
                let row = *row;
                self.reconcile_recorded_ask(actor_id, &instance, seq, &row.input_hash)?;
                // The birth facts are read after the reconciliation (Node `cachedAskFacts` in the closure).
                let source = self
                    .actor(actor_id)?
                    .imported
                    .as_ref()
                    .and_then(|imported| imported.source_session_at(seq));
                let facts = AskFacts {
                    actor: self.actor(actor_id)?.actor_ref.clone(),
                    actor_seq: seq,
                    instructions_head: instructions_head(&instructions),
                    source_session_id: source,
                };
                let outcome = if row.status == NodeStatus::Completed {
                    CachedOutcome::Completed(row.result.unwrap_or(Value::Null))
                } else {
                    CachedOutcome::Failed(row.error.unwrap_or(Value::Null))
                };
                self.hold_for_replay(
                    &instance,
                    Release::Cached(CachedSettle {
                        instance: instance.clone(),
                        ticket,
                        outcome,
                        facts: Some(facts),
                    }),
                )
            }
        }
    }

    /// Node `admitLive`: the live node, its running row (written at admission, so a crash leaves it
    /// redispatchable), and the `node-queued` event. `prior` marks an ask whose transcript predates this
    /// dispatch (stats then omit `worldToolCalls`).
    fn admit_live(&mut self, actor_id: &str, seq: u64, ask: LiveAsk) -> Result<()> {
        let LiveAsk {
            instance,
            instructions,
            hash,
            spec,
            ticket,
            prior,
        } = ask;
        if prior {
            self.prior_transcript.insert(instance.key());
        }
        let head = instructions_head(&instructions);
        let actor_ref = self.actor(actor_id)?.actor_ref.clone();
        let node_id = self.next_node_id;
        self.next_node_id += 1;
        self.live.insert(
            node_id,
            AskNode {
                instance: instance.clone(),
                actor_id: actor_id.to_owned(),
                actor_ref: actor_ref.clone(),
                actor_seq: seq,
                instructions,
                hash: hash.clone(),
                spec,
                ticket,
                repairs_remaining: REPAIR_ATTEMPTS,
                nudges_remaining: NUDGE_ATTEMPTS,
                dispatched: false,
                last_stats: None,
                instructions_head: head.clone(),
            },
        );
        self.live_index.insert(instance.key(), node_id);
        self.journal.put_node(NodeRow {
            run_id: self.run_id.clone(),
            site_id: instance.site_id.clone(),
            ordinal: instance.ordinal,
            kind: NodeKind::Ask,
            actor_site_id: Some(actor_ref.site_id.clone()),
            actor_ordinal: Some(actor_ref.ordinal),
            actor_seq: Some(seq),
            input_hash: hash,
            status: NodeStatus::Running,
            result: None,
            error: None,
            stats: None,
            input: None,
            message_boundary: None,
            artifact_id: None,
        })?;
        self.actor_mut(actor_id)?.live_queue.push_back(node_id);
        self.record(RunEvent::NodeQueued {
            instance,
            actor: actor_ref,
            actor_seq: seq,
            instructions_head: head,
            phase: None,
        })
    }

    /// Node `pumpActor`: start the actor's next ask when it has none running, the run is live and the
    /// cap has room.
    pub(crate) fn pump_actor(&mut self, actor_id: &str) -> Result<()> {
        if self.is_settled() {
            return Ok(());
        }
        let actor = self.actor(actor_id)?;
        if actor.current.is_some() || self.active_asks >= self.caps.max_concurrency {
            return Ok(());
        }
        let Some(&node_id) = actor.live_queue.front() else {
            return Ok(());
        };
        let actor = self.actor_mut(actor_id)?;
        actor.live_queue.pop_front();
        actor.current = Some(node_id);
        self.active_asks += 1.0;
        self.dispatch(actor_id, node_id)
    }

    /// Node `dispatch` up to its first `await`: the session is created now, if needed. The rest runs as
    /// jobs (one hop for an actor with a session, two for the first dispatch).
    fn dispatch(&mut self, actor_id: &str, node_id: u64) -> Result<()> {
        if self.actor(actor_id)?.session != SessionState::None {
            self.jobs.push_back(Job::Dispatch { node_id });
            return Ok(());
        }
        let actor_ref = self.actor(actor_id)?.actor_ref.clone();
        let persona = self.actor(actor_id)?.persona.clone();
        // Node `ensureSession`: the seed is known only at the divergence point, so it is read here.
        let seed: Option<ActorSessionSeed> = self
            .actor(actor_id)?
            .imported
            .as_ref()
            .and_then(ImportedActorState::seed);
        // Node `createActorSession`: the journal's session id is a record; the driver's minting rule is authoritative.
        // A recorded id that differs means the rule drifted, so the session is not created. A driver with no rule
        // (`minted_session_id` is None) is not checked.
        let minted = self.driver.minted_session_id(&self.run_id, &actor_ref);
        let recorded = self
            .journal
            .get_actor(&self.run_id, &actor_ref)?
            .and_then(|row| row.session_id);
        let session = match (recorded, minted) {
            (Some(expected), Some(got)) if expected != got => {
                SessionState::Mismatched { expected, got }
            }
            _ => match self
                .driver
                .create_actor_session(&actor_ref, &persona, seed.as_ref())
            {
                Ok(id) => SessionState::Ready(id),
                Err(error) => SessionState::Failed(describe_cause(&format!("{error}"))),
            },
        };
        self.actor_mut(actor_id)?.session = session;
        self.jobs.push_back(Job::SessionReady {
            actor_id: actor_id.to_owned(),
            node_id,
        });
        Ok(())
    }

    /// The session is known (Node `ensureSession`'s callback): record it on the actor row. A failed
    /// session records nothing and the dispatch fails on its own continuation.
    pub(crate) fn session_ready(&mut self, actor_id: &str, node_id: u64) -> Result<()> {
        if let SessionState::Ready(session) = self.actor(actor_id)?.session.clone() {
            let actor = self.actor(actor_id)?;
            let actor_ref = actor.actor_ref.clone();
            let name = actor.name.clone();
            let persona = actor.persona.clone();
            let resolved_model = self
                .journal
                .get_actor(&self.run_id, &actor_ref)?
                .and_then(|row| row.resolved_model);
            self.journal.put_actor(ActorRow {
                run_id: self.run_id.clone(),
                site_id: actor_ref.site_id.clone(),
                ordinal: actor_ref.ordinal,
                name,
                persona: Some(persona),
                session_id: Some(session),
                resolved_model,
            })?;
        }
        self.jobs.push_back(Job::Dispatch { node_id });
        Ok(())
    }

    /// Node `dispatch` after its `await`: a node that settled or a run that settled does nothing; a
    /// failed session fails the node; otherwise record `node-dispatched` and start the ask.
    pub(crate) fn dispatch_continue(&mut self, node_id: u64) -> Result<()> {
        if self.is_settled() {
            return Ok(());
        }
        let Some(node) = self.live.get(&node_id) else {
            return Ok(());
        };
        let actor_id = node.actor_id.clone();
        let instance = node.instance.clone();
        let instructions = node.instructions.clone();
        let spec = node.spec.clone();
        let head = node.instructions_head.clone();
        let actor = self.actor(&actor_id)?;
        let session = match &actor.session {
            SessionState::Ready(id) => id.clone(),
            SessionState::Failed(message) => {
                let error = WorkflowError::new(
                    ErrorCode::DriverError,
                    format!("Failed to create the subagent session: {message}"),
                );
                return self.settle_failed(node_id, error);
            }
            SessionState::Mismatched { expected, got } => {
                let error = WorkflowError::new(
                    ErrorCode::DriverError,
                    format!(
                        "Subagent session identity mismatch for {}: the journaled session id and the minted one differ.",
                        actor.actor_ref.key()
                    ),
                )
                .with_mismatch(expected.clone(), got.clone());
                return self.settle_failed(node_id, error);
            }
            SessionState::None => {
                return Err(anyhow!("workflow engine: dispatch before its session"));
            }
        };
        let actor_name = actor.name.clone();
        let persona_model_name = persona_model(&actor.persona);
        let actor_ref = actor.actor_ref.clone();
        self.record(RunEvent::NodeDispatched {
            instance: instance.clone(),
            actor: actor_ref,
            actor_name,
            actor_persona_model: persona_model_name,
            instructions_head: head,
            phase: None,
            actor_phase: None,
        })?;
        if let Some(node) = self.live.get_mut(&node_id) {
            node.dispatched = true;
        }
        self.driver.start_ask(
            &session,
            &instance,
            &AskMessage {
                instructions,
                typed: spec.typed,
                schema: spec.schema,
            },
        );
        Ok(())
    }

    /// Node `settleOk`: the node row completes, `node-settled` is recorded, the next ask may start, and
    /// the caller's promise resolves.
    pub(crate) fn settle_ok(&mut self, node_id: u64, artifact: Value) -> Result<()> {
        let Some(node) = self.take_live(node_id) else {
            return Ok(());
        };
        let stats = self.node_stats(&node);
        let row = node_row(
            &self.run_id,
            &node,
            NodeStatus::Completed,
            Some(artifact.clone()),
            None,
            stats,
        );
        self.journal.put_node(row)?;
        self.record(RunEvent::NodeSettled {
            instance: node.instance.clone(),
            outcome: NodeOutcome::Ok,
            cached: false,
            error: None,
            facts: None,
            phase: None,
        })?;
        self.release_actor_slot(&node, node_id);
        self.pump_all()?;
        self.push_outcome(node.ticket, Ok(artifact));
        Ok(())
    }

    /// Node `settleFailed`: the node row fails with the error (replay must reproduce it), `node-settled`
    /// is recorded, and only this ask rejects. The run continues unless the caller fails it.
    pub(crate) fn settle_failed(&mut self, node_id: u64, error: WorkflowError) -> Result<()> {
        let Some(node) = self.take_live(node_id) else {
            return Ok(());
        };
        let stats = self.node_stats(&node);
        let error_json = error.to_json();
        let row = node_row(
            &self.run_id,
            &node,
            NodeStatus::Failed,
            None,
            Some(error_json.clone()),
            stats,
        );
        self.journal.put_node(row)?;
        self.record(RunEvent::NodeSettled {
            instance: node.instance.clone(),
            outcome: NodeOutcome::Failed,
            cached: false,
            error: Some(error_json),
            facts: None,
            phase: None,
        })?;
        self.release_actor_slot(&node, node_id);
        self.pump_all()?;
        self.push_outcome(node.ticket, Err(error));
        Ok(())
    }

    /// Remove a live node from the scheduler's tables (Node `liveNodes.delete`).
    fn take_live(&mut self, node_id: u64) -> Option<AskNode> {
        let node = self.live.remove(&node_id)?;
        self.live_index.remove(&node.instance.key());
        Some(node)
    }

    /// Node `finishLiveNode`, the actor side: free the actor's slot and the cap. The caller starts the
    /// waiting asks (`pump_all`) before this, as Node does.
    fn release_actor_slot(&mut self, node: &AskNode, node_id: u64) {
        if let Some(actor) = self.actors.get_mut(&node.actor_id)
            && actor.current == Some(node_id)
        {
            actor.current = None;
            self.active_asks -= 1.0;
        }
    }

    /// Stats of a settling node, journaled (Node `nodeRecordFor`).
    fn node_stats(&self, node: &AskNode) -> Option<Value> {
        node.last_stats
            .clone()
            .map(|stats| self.journaled_stats(&node.instance, stats))
    }

    /// Node `noteStats`: a live node keeps the stats for its settlement; a settled row is backfilled.
    pub(crate) fn note_stats(&mut self, instance: &Ref, stats: AskStats) -> Result<()> {
        let json = stats.to_json();
        if let Some(node_id) = self.live_node_id(instance)
            && let Some(node) = self.live.get_mut(&node_id)
        {
            node.last_stats = Some(json);
            return Ok(());
        }
        let Some(mut recorded) = self.journal.get_node(&self.run_id, instance)? else {
            return Ok(());
        };
        recorded.stats = Some(self.journaled_stats(instance, json));
        self.journal.put_node(recorded)
    }

    /// Node `journaledStats`: `worldToolCalls` is dropped for an ask whose transcript predates the
    /// dispatch, because the driver's counter did not see the earlier calls.
    fn journaled_stats(&self, instance: &Ref, stats: Value) -> Value {
        if !self.prior_transcript.contains(&instance.key()) {
            return stats;
        }
        let Value::Object(fields) = stats else {
            return stats;
        };
        let mut kept = Map::new();
        for (key, value) in fields {
            if key != "worldToolCalls" {
                kept.insert(key, value);
            }
        }
        Value::Object(kept)
    }
}

/// The fields of an ask that is admitted live (the arguments of Node's `admitLive`).
struct LiveAsk {
    instance: Ref,
    instructions: String,
    hash: String,
    spec: AskSpec,
    ticket: u64,
    prior: bool,
}

/// The node row of a settling ask (Node `nodeRecordFor`).
fn node_row(
    run_id: &str,
    node: &AskNode,
    status: NodeStatus,
    result: Option<Value>,
    error: Option<Value>,
    stats: Option<Value>,
) -> NodeRow {
    NodeRow {
        run_id: run_id.to_owned(),
        site_id: node.instance.site_id.clone(),
        ordinal: node.instance.ordinal,
        kind: NodeKind::Ask,
        actor_site_id: Some(node.actor_ref.site_id.clone()),
        actor_ordinal: Some(node.actor_ref.ordinal),
        actor_seq: Some(node.actor_seq),
        input_hash: node.hash.clone(),
        status,
        result,
        error,
        stats,
        input: None,
        message_boundary: None,
        artifact_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heads_are_trimmed_and_bounded_in_utf16_units() {
        assert_eq!(instructions_head("  go  "), Some("go".to_owned()));
        assert_eq!(instructions_head("   "), None);
        let long = "a".repeat(300);
        assert_eq!(instructions_head(&long).map(|head| head.len()), Some(240));
        // Each emoji is two UTF-16 units: 120 of them fill the bound exactly.
        let wide = "😀".repeat(130);
        assert_eq!(
            instructions_head(&wide).map(|head| head.encode_utf16().count()),
            Some(240)
        );
    }

    #[test]
    fn the_hash_is_fnv_over_the_json_string() {
        assert_eq!(input_hash("go"), fnv1a("\"go\""));
    }
}
