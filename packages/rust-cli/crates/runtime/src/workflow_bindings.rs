//! Fork: the production ActorBindingsPort (specs/fork-rust-workflow-engine.md, 9.35, W7-5f). A run's actors read their
//! parent session's bindings here: the model selection, the workspace and the permission mode from the session store, and
//! the parent's interactions channel from the open session (when it is open).
//!
//! The owner reads the port on its own thread through the blocking pool, so `parent_bindings` may block on the store.

use std::sync::Arc;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::orchestration::Interactions;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::store::{LoadedSession, SessionStore};
use tokio::runtime::Handle;

use crate::table::OpenSessions;
use crate::workflow_owner::{ActorBindingsPort, ParentBindings};

/// The production port. `store` is the app's session store, `sessions` the open sessions, `handle` the runtime the store
/// is awaited on.
pub struct SessionBindings {
    store: Arc<dyn SessionStore>,
    sessions: OpenSessions,
    handle: Handle,
}

impl SessionBindings {
    pub(crate) fn new(
        store: Arc<dyn SessionStore>,
        sessions: OpenSessions,
        handle: Handle,
    ) -> Self {
        Self {
            store,
            sessions,
            handle,
        }
    }

    /// The stored session, or None when the store does not know it (or cannot read it: the launch is then refused).
    fn load(&self, parent: &str) -> Option<LoadedSession> {
        self.handle
            .block_on(self.store.load(&SessionId::new(parent)))
            .ok()
    }

    /// The parent's session-level asks, when the parent is open. A closed parent has none: its asks then fail at the
    /// actor's ask, as a turn with no channel does.
    fn asks(&self, parent: &str) -> Option<Arc<dyn Interactions>> {
        let sessions = self.sessions.lock_unpoisoned();
        sessions
            .get(&SessionId::new(parent))
            .and_then(|slot| slot.open())
            .map(|session| session.session_asks())
    }
}

impl ActorBindingsPort for SessionBindings {
    fn parent_bindings(&self, parent: &str) -> Option<ParentBindings> {
        let loaded = self.load(parent)?;
        Some(ParentBindings {
            selection: loaded.model,
            workspace: loaded.meta.workspace,
            interactions: self.asks(parent),
        })
    }

    /// The mode the session is in now. Plan is one value in Node's collaboration mode, so an open plan reads as plan.
    fn parent_permission_mode(&self, parent: &str) -> Option<PermissionMode> {
        let loaded = self.load(parent)?;
        Some(if loaded.plan {
            PermissionMode::Plan
        } else {
            loaded.mode.unwrap_or(PermissionMode::Default)
        })
    }
}

#[cfg(test)]
#[path = "workflow_bindings_tests.rs"]
mod tests;
