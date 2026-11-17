//! Context composition store (Node `runtime/context-composition/state.ts` and `bootstrap/.../context-composition/tracker.ts`,
//! spec `specs/fork-rust-agent-parity.md`, "Rust port"): the classified request of each session, written by the query loop
//! after the request is assembled and read by `v4/conversation/contextComposition`.
//!
//! One value per session, shared by the writer (query) and the reader (runtime kernel), so both see the same record.
//! The revision is per process and starts at 0 for each session. It goes up once per batch of changes: the first change
//! of a session bumps it and publishes, and later changes before the batch ends (Node's microtask, here the next poll
//! of the spawned clearing task) update the record without a new revision (Node `tracker.ts` `markChanged`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use rust_cli_base::sync::LockUnpoisoned;

use crate::ids::SessionId;

/// Node `ContextCompositionItem`: a named part of a category, with its estimated tokens. No text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireItem {
    pub name: String,
    pub tokens: u64,
}

/// Node `ContextCompositionCategory` on the wire: zero categories are not included, `items` is absent when empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireCategory {
    pub id: &'static str,
    pub tokens: u64,
    pub chars: u64,
    pub items: Option<Vec<WireItem>>,
}

/// The provider's usage for the request, as the usage ring reads it (`compact::tokens::measured`): input tokens with
/// cache reads and writes, and that plus the output tokens (`providerContextTokens`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderUsage {
    pub input_tokens: u64,
    pub context_tokens: u64,
}

/// One measured request: the model it was sent to, its categories, and the provider's usage once the response is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompositionRecord {
    pub provider_id: String,
    pub model_id: String,
    pub measured_at_ms: u64,
    pub estimated_tokens: u64,
    pub categories: Vec<WireCategory>,
    pub provider_usage: Option<ProviderUsage>,
}

/// Node `ContextCompositionPhase`: the last measured request (when it is still valid for the model asked about), or the
/// preview of the next request built for that model without side effects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositionPhase {
    Request,
    DraftPreview,
}

/// The answer to `v4/conversation/contextComposition`: the session's revision, the phase, and the composition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompositionAnswer {
    pub revision: u64,
    pub phase: CompositionPhase,
    pub record: CompositionRecord,
    /// The selected model's context window (Node `model.contextWindow`); `None` when the model's capabilities are not
    /// known, and the wire form then reports `freeTokens: null`.
    pub context_window: Option<u64>,
}

#[derive(Default)]
struct Slot {
    revision: u64,
    record: Option<CompositionRecord>,
}

/// One revision change of a session, published to subscribers in the order it happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompositionChange {
    pub session: SessionId,
    pub revision: u64,
}

/// Capacity of the change channel. A subscriber that falls this far behind skips the oldest changes, which is safe: the
/// notification carries only the session and the consumer re-reads the current revision.
const CHANGES: usize = 256;

/// The per-session composition slots, and the channel that publishes each revision change. Cheap to share behind an `Arc`.
pub struct CompositionStore {
    slots: Mutex<HashMap<SessionId, Slot>>,
    /// Sessions whose current batch has already bumped the revision (Node `tracker.ts` `pending`).
    pending: Arc<Mutex<HashSet<SessionId>>>,
    changes: tokio::sync::broadcast::Sender<CompositionChange>,
}

impl Default for CompositionStore {
    fn default() -> Self {
        let (changes, _) = tokio::sync::broadcast::channel(CHANGES);
        Self {
            slots: Mutex::new(HashMap::new()),
            pending: Arc::new(Mutex::new(HashSet::new())),
            changes,
        }
    }
}

impl CompositionStore {
    /// A receiver of every later change (not the ones already made).
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<CompositionChange> {
        self.changes.subscribe()
    }

    fn publish(&self, session: &SessionId, revision: u64) {
        // No subscriber is not an error: nothing is waiting for the change.
        let _ = self.changes.send(CompositionChange {
            session: session.clone(),
            revision,
        });
    }

    /// Applies one change to a slot. The first change of the session in a batch bumps the revision and publishes it;
    /// a later one in the same batch leaves both alone. Returns the revision the slot has now.
    fn apply(&self, slot: &mut Slot, session: &SessionId, change: impl FnOnce(&mut Slot)) -> u64 {
        change(slot);
        if self.pending.lock_unpoisoned().insert(session.clone()) {
            slot.revision += 1;
            self.end_batch_later(session.clone());
            self.publish(session, slot.revision);
        }
        slot.revision
    }

    /// Clears the session's pending mark when the current batch is over. The clearing task runs after the mutating task
    /// yields, so every change made before that poll is in the same batch. Without a runtime nothing is batched.
    fn end_batch_later(&self, session: SessionId) {
        let pending = Arc::clone(&self.pending);
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    pending.lock_unpoisoned().remove(&session);
                });
            }
            Err(_) => {
                pending.lock_unpoisoned().remove(&session);
            }
        }
    }

    /// A request was measured: it becomes the session's record and the revision goes up. Returns the new revision.
    pub fn record(&self, session: &SessionId, record: CompositionRecord) -> u64 {
        let mut slots = self.slots.lock_unpoisoned();
        let slot = slots.entry(session.clone()).or_default();
        self.apply(slot, session, |slot| slot.record = Some(record))
    }

    /// The provider's usage arrived for the session's current record. Ignored when there is no record (an invalidation
    /// dropped it), so a late response never attaches usage to a newer request's record.
    pub fn set_usage(&self, session: &SessionId, usage: ProviderUsage) -> Option<u64> {
        let mut slots = self.slots.lock_unpoisoned();
        let slot = slots.get_mut(session)?;
        let record = slot.record.as_mut()?;
        record.provider_usage = Some(usage);
        Some(self.apply(slot, session, |_| {}))
    }

    /// The session's composition changed in a way that makes its record stale (compaction, a model switch, a tool cache
    /// or context-prefix rebuild). The record is dropped and the revision goes up. Returns the new revision.
    pub fn invalidate(&self, session: &SessionId) -> u64 {
        let mut slots = self.slots.lock_unpoisoned();
        let slot = slots.entry(session.clone()).or_default();
        self.apply(slot, session, |slot| slot.record = None)
    }

    /// The session closed: its record (the largest part of a slot) is dropped. The revision stays, as Node's tracker keeps
    /// its revision map for the life of the process: a session reopened in the same process must not restart at 0,
    /// because the App compares revisions for staleness.
    pub fn forget(&self, session: &SessionId) {
        if let Some(slot) = self.slots.lock_unpoisoned().get_mut(session) {
            slot.record = None;
        }
    }

    /// The current revision; 0 for a session that has never changed.
    pub fn revision(&self, session: &SessionId) -> u64 {
        self.slots
            .lock_unpoisoned()
            .get(session)
            .map_or(0, |slot| slot.revision)
    }

    /// The revision and the current record read together, so a reader never pairs a new revision with an old record.
    pub fn snapshot(&self, session: &SessionId) -> (u64, Option<CompositionRecord>) {
        self.slots
            .lock_unpoisoned()
            .get(session)
            .map_or((0, None), |slot| (slot.revision, slot.record.clone()))
    }
}

#[cfg(test)]
#[path = "context_composition_tests.rs"]
mod tests;
