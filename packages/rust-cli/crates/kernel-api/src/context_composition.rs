//! Context composition store (Node `runtime/context-composition/state.ts` and `bootstrap/.../context-composition/tracker.ts`,
//! spec `specs/fork-rust-agent-parity.md`, "Rust port"): the classified request of each session, written by the query loop
//! after the request is assembled and read by `v4/conversation/contextComposition`.
//!
//! One value per session, shared by the writer (query) and the reader (runtime kernel), so both see the same record.
//! The revision is per process and starts at 0 for each session; it goes up on every change (a request measured, its
//! provider usage attached, or an invalidation).

use std::collections::HashMap;
use std::sync::Mutex;

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

#[derive(Default)]
struct Slot {
    revision: u64,
    record: Option<CompositionRecord>,
}

/// The per-session composition slots. Cheap to share behind an `Arc`.
#[derive(Default)]
pub struct CompositionStore {
    slots: Mutex<HashMap<SessionId, Slot>>,
}

impl CompositionStore {
    /// A request was measured: it becomes the session's record and the revision goes up. Returns the new revision.
    pub fn record(&self, session: &SessionId, record: CompositionRecord) -> u64 {
        let mut slots = self.slots.lock_unpoisoned();
        let slot = slots.entry(session.clone()).or_default();
        slot.revision += 1;
        slot.record = Some(record);
        slot.revision
    }

    /// The provider's usage arrived for the session's current record. Ignored when there is no record (an invalidation
    /// dropped it), so a late response never attaches usage to a newer request's record.
    pub fn set_usage(&self, session: &SessionId, usage: ProviderUsage) -> Option<u64> {
        let mut slots = self.slots.lock_unpoisoned();
        let slot = slots.get_mut(session)?;
        let record = slot.record.as_mut()?;
        record.provider_usage = Some(usage);
        slot.revision += 1;
        Some(slot.revision)
    }

    /// The session's composition changed in a way that makes its record stale (compaction, a model switch, a tool cache
    /// or context-prefix rebuild). The record is dropped and the revision goes up. Returns the new revision.
    pub fn invalidate(&self, session: &SessionId) -> u64 {
        let mut slots = self.slots.lock_unpoisoned();
        let slot = slots.entry(session.clone()).or_default();
        slot.revision += 1;
        slot.record = None;
        slot.revision
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
