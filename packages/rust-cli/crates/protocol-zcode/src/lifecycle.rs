//! Fork: the session runtime lifecycle the App reads (`session/lifecycle/getState`) and follows
//! (`session/lifecycle/changed`), like Node's `SessionLifecycleController` (bootstrap `session-lifecycle/`;
//! specs/fork-rust-agent-parity.md, "Session lifecycle").
//!
//! The App queries the state before it subscribes and then only accepts snapshots with a higher `revision`. A
//! cold subscribe opens the session, so the agent must announce `ready` with a new revision, or the composer stays
//! blocked on the `unloaded` answer it read first. zcode-rs opens sessions on demand and never fails an activation it
//! reports, so the states are `unloaded` and `ready` only and `lastError` is always null.

use std::collections::HashMap;
use std::sync::Mutex;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::SessionId;
use serde_json::{Value, json};

pub const CHANGED: &str = "session/lifecycle/changed";

/// Per-session revisions; one owner (the server) bumps them on every open and close it reports.
#[derive(Default)]
pub struct Lifecycles {
    revisions: Mutex<HashMap<SessionId, u64>>,
}

impl Lifecycles {
    /// The snapshot for `state` at the current revision.
    pub fn current(&self, session: &SessionId, state: &str) -> Value {
        let revision = self
            .revisions
            .lock_unpoisoned()
            .get(session)
            .copied()
            .unwrap_or(0);
        snapshot(session, state, revision)
    }

    /// Records a change and returns the snapshot to announce.
    pub fn changed(&self, session: &SessionId, state: &str) -> Value {
        let mut revisions = self.revisions.lock_unpoisoned();
        let revision = revisions.entry(session.clone()).or_insert(0);
        *revision += 1;
        snapshot(session, state, *revision)
    }
}

fn snapshot(session: &SessionId, state: &str, revision: u64) -> Value {
    json!({
        "sessionId": session.as_str(),
        "state": state,
        "generation": 0,
        "revision": revision,
        "lastError": null,
    })
}

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod tests;
