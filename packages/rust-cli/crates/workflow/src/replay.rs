//! Replay: the settlement-order gate (Node `replay-order.ts` `ReplaySettleOrder`) and the cached
//! settlement of journal rows (Node `scheduler.ts` `releaseCachedAsk` and `settleCachedAsk`).
//!
//! Site ordinals are assigned when calls arrive, so the calls a fan-out makes after an await are numbered
//! in the order the branches completed. A resumed run must release cached settlements in the order the
//! first lifetime settled them, not in call order. The gate holds each release until every earlier entry
//! of the recorded order has been released. Instances outside the order pass through at once.
//!
//! Node delivers each release in a microtask (`queueMicrotask`), so releases of one batch run together,
//! after the call that created them. Here that is a `Job::GateFlush` in the engine's job queue.
use crate::engine::WorkflowDriver;
use crate::engine::WorkflowEngine;
use crate::error::WorkflowError;
use crate::event::{AskFacts, NodeOutcome, RunEvent};
use crate::journal::JournalPort;
use crate::model::Ref;
use anyhow::{Result, bail};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

/// A continuation the engine runs later, as a promise reaction or a `queueMicrotask` would.
#[derive(Debug, Clone, PartialEq)]
pub enum Job {
    /// First dispatch of an actor: the session is known, record it on the actor row, then dispatch.
    SessionReady { actor_id: String, node_id: u64 },
    /// The dispatch continuation of one live ask.
    Dispatch { node_id: u64 },
    /// Deliver the gate's queued releases.
    GateFlush,
}

/// The settlement of a journal row that a resumed ask or world node replays. `facts` is the ask's birth facts
/// (Node `cachedAskFacts`); a world node has none.
#[derive(Debug, Clone, PartialEq)]
pub struct CachedSettle {
    pub instance: Ref,
    pub ticket: u64,
    pub outcome: CachedOutcome,
    pub facts: Option<AskFacts>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CachedOutcome {
    /// The recorded result of a completed ask.
    Completed(Value),
    /// The recorded error JSON of a failed ask.
    Failed(Value),
}

/// A release waiting for the gate or the job queue.
#[derive(Debug, Clone, PartialEq)]
pub enum Release {
    Cached(CachedSettle),
}

/// Gate state. `position` is the recorded settlement order (instance key → index); `cursor` is the next
/// index to release; `parked` holds releases that arrived before their turn, keyed by index.
#[derive(Debug, Default)]
pub struct ReplayGate {
    position: HashMap<String, usize>,
    order_len: usize,
    cursor: usize,
    parked: BTreeMap<usize, Release>,
    queue: Vec<Release>,
    flushing: bool,
    opened: bool,
}

impl ReplayGate {
    /// The gate of a fresh run: no order, so every hold releases at once.
    pub fn empty() -> Self {
        Self::default()
    }

    /// The gate for a resumed run, from the instance keys in the recorded settlement order.
    pub fn new(order: &[String]) -> Self {
        let position = order
            .iter()
            .enumerate()
            .map(|(index, key)| (key.clone(), index))
            .collect();
        Self {
            position,
            order_len: order.len(),
            ..Self::default()
        }
    }
}

impl<J: JournalPort, D: WorkflowDriver> WorkflowEngine<J, D> {
    /// Node `holdForReplay`: release now when the instance is not in the recorded order, or the gate is
    /// open, or its turn has passed; otherwise park it until its turn.
    pub(crate) fn hold_for_replay(&mut self, instance: &Ref, release: Release) -> Result<()> {
        let position = self.gate.position.get(&instance.key()).copied();
        match position {
            Some(at) if !self.gate.opened && at >= self.gate.cursor => {
                self.gate.parked.insert(at, release);
                self.gate_pump();
                Ok(())
            }
            _ => self.execute_release(release),
        }
    }

    /// Node `pump`: move every parked release whose turn has come into the delivery queue.
    pub(crate) fn gate_pump(&mut self) {
        while self.gate.cursor < self.gate.order_len {
            let Some(release) = self.gate.parked.remove(&self.gate.cursor) else {
                break;
            };
            self.gate.cursor += 1;
            self.gate_enqueue(release);
        }
    }

    /// Node `enqueue`: one flush job per batch; later releases join the same batch.
    fn gate_enqueue(&mut self, release: Release) {
        self.gate.queue.push(release);
        if self.gate.flushing {
            return;
        }
        self.gate.flushing = true;
        self.jobs.push_back(Job::GateFlush);
    }

    /// Node `flush`: deliver the queued batch in FIFO order.
    pub(crate) fn gate_flush(&mut self) -> Result<()> {
        self.gate.flushing = false;
        let batch = std::mem::take(&mut self.gate.queue);
        for release in batch {
            self.execute_release(release)?;
        }
        Ok(())
    }

    /// Node `open`: the run settled. Deliver the queued batch, then every parked release in order, and
    /// keep the gate open from now on (later holds release at once).
    pub(crate) fn gate_open(&mut self) -> Result<()> {
        if self.gate.opened {
            return Ok(());
        }
        self.gate.opened = true;
        self.gate_flush()?;
        let mut releases = Vec::new();
        for index in self.gate.cursor..self.gate.order_len {
            if let Some(release) = self.gate.parked.remove(&index) {
                releases.push(release);
            }
        }
        self.gate.cursor = self.gate.order_len;
        releases.extend(std::mem::take(&mut self.gate.parked).into_values());
        for release in releases {
            self.execute_release(release)?;
        }
        Ok(())
    }

    /// Node `settleCachedAsk`: the recorded outcome, recorded as a cached settlement event, then the
    /// caller's settlement. A recorded failure replays as the same rejection.
    pub(crate) fn settle_cached(&mut self, cached: CachedSettle) -> Result<()> {
        match cached.outcome {
            CachedOutcome::Completed(value) => {
                self.record(RunEvent::NodeSettled {
                    instance: cached.instance,
                    outcome: NodeOutcome::Ok,
                    cached: true,
                    error: None,
                    facts: cached.facts,
                    phase: None,
                })?;
                self.push_outcome(cached.ticket, Ok(value));
            }
            CachedOutcome::Failed(error) => {
                self.record(RunEvent::NodeSettled {
                    instance: cached.instance.clone(),
                    outcome: NodeOutcome::Failed,
                    cached: true,
                    error: Some(error.clone()),
                    facts: cached.facts,
                    phase: None,
                })?;
                let Some(parsed) = WorkflowError::from_json(&error) else {
                    bail!(
                        "journal: unreadable error on replayed node {}",
                        cached.instance.key()
                    );
                };
                self.push_outcome(cached.ticket, Err(parsed));
            }
        }
        Ok(())
    }
}
