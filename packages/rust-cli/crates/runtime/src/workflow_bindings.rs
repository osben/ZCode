//! Fork: the production ActorBindingsPort (specs/fork-rust-workflow-engine.md, 9.35, W7-5f). A run's actors read their
//! parent session's bindings here: the model selection, the workspace and the permission mode from the session store, and
//! the parent's interactions channel from the open session (when it is open).
//!
//! The port blocks on the store (`Handle::block_on`). It is called off the runtime's worker threads: the owner's factory
//! runs on the blocking pool, and a launch's mode read is made from a blocking thread too (`record_parent_mode`).
//!
//! Every read fails closed. A session the store does not have is an error for the mode (never recorded as absent, which
//! the actors would read as YOLO), and a read that fails is an error for both reads.

use std::sync::Arc;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::orchestration::Interactions;
use rust_cli_kernel_api::permission::{ExecutionState, PermissionMode};
use rust_cli_kernel_api::store::{LoadedSession, SessionStore, StoreError};
use tokio::runtime::Handle;

use crate::table::OpenSessions;
use crate::workflow_owner::{ActorBindingsPort, ParentBindings};

/// The production port. `store` is the app's session store, `sessions` the open sessions, `handle` the runtime the store
/// is awaited on, and `fallback` the app's default mode, read for a stored session that has none (as the session's own
/// cold read does with `Defaults::mode`).
pub struct SessionBindings {
    store: Arc<dyn SessionStore>,
    sessions: OpenSessions,
    handle: Handle,
    fallback: PermissionMode,
}

impl SessionBindings {
    pub(crate) fn new(
        store: Arc<dyn SessionStore>,
        sessions: OpenSessions,
        handle: Handle,
        fallback: PermissionMode,
    ) -> Self {
        Self {
            store,
            sessions,
            handle,
            fallback,
        }
    }

    /// The stored session, or None when the store does not know it. Any other read failure is an error, and is logged
    /// (the caller refuses the launch or the actor on it).
    fn load(&self, parent: &str) -> Result<Option<LoadedSession>, String> {
        match self
            .handle
            .block_on(self.store.load(&SessionId::new(parent)))
        {
            Ok(loaded) => Ok(Some(loaded)),
            Err(StoreError::NotFound { .. }) => Ok(None),
            Err(error) => {
                tracing::warn!(
                    event = "workflow.bindings.read_failed",
                    parent = parent,
                    error = %error,
                    "a workflow run could not read its parent session"
                );
                Err(error.to_string())
            }
        }
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
    fn parent_bindings(&self, parent: &str) -> Result<Option<ParentBindings>, String> {
        let Some(loaded) = self.load(parent)? else {
            return Ok(None);
        };
        Ok(Some(ParentBindings {
            selection: loaded.model,
            workspace: loaded.meta.workspace,
            interactions: self.asks(parent),
        }))
    }

    /// The mode the session is in now, read as the session's own cold read reads it: a stored mode with its plan flag,
    /// else the app's default mode. An unknown session is an error (the launch is refused, never recorded as absent).
    fn parent_permission_mode(&self, parent: &str) -> Result<Option<PermissionMode>, String> {
        let Some(loaded) = self.load(parent)? else {
            return Err(format!("the parent session {parent} is not known"));
        };
        let state = match loaded.mode {
            Some(stored) => ExecutionState::from_parts(stored, loaded.plan),
            None => ExecutionState::from(self.fallback),
        };
        Ok(Some(state.effective()))
    }
}

#[cfg(test)]
#[path = "workflow_bindings_tests.rs"]
mod tests;
