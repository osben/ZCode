//! Fork: the tool context of an MCP App call (specs/fork-rust-node-helper.md F3, `helper/authorizeAppTool`). A panel or
//! the composer calls a helper-hosted tool outside any turn; the pipeline authorizes it in the caller's task with this
//! context. Its prompt is a session-level ask (`AskScope::Session`): a turn's end or interrupt does not cancel it, and
//! an "always allow" answer commits its rules like a turn's prompt does.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvPath, Origin};
use rust_cli_kernel_api::ids::{SessionId, ToolUseId};
use rust_cli_kernel_api::machine::CommandEvents;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::monitor::MonitorArmed;
use rust_cli_kernel_api::orchestration::OrchestrationError;
use rust_cli_kernel_api::session_ops::{RunView, SessionOps};
use rust_cli_kernel_api::tool::ToolUseContext;
use tokio_util::sync::CancellationToken;

use crate::actor::Actor;
use crate::sink::SessionAsks;

impl Actor {
    /// The session's current mode, workspace and model; the user is the origin, as for a `!` command. A running turn's
    /// limits do not apply: Node authorizes an App call apart from the turn.
    pub(crate) fn app_tool_context(
        &self,
        tool_use: ToolUseId,
        cancel: CancellationToken,
    ) -> ToolUseContext {
        let operation = self.deps.ids.operation();
        let interactions = Arc::new(SessionAsks::new(
            self.asks.clone(),
            self.meta.id.clone(),
            self.deps.detached.clone(),
        ));
        let view = RunView {
            turn: Default::default(),
            ..self.run_view()
        };
        ToolUseContext {
            session: self.meta.id.clone(),
            run: self.deps.ids.run(),
            tool_use,
            agent: None,
            workspace: self.meta.workspace.clone(),
            mode: self.mode(),
            base_mode: self.execution.mode,
            cancel,
            machine: self.deps.machines.primary_machine(),
            controller: self.deps.machines.controller(),
            artifacts: self.deps.artifacts.clone(),
            interactions,
            session_ops: Arc::new(Snapshot {
                session: self.meta.id.clone(),
                view,
            }),
            operation: self.deps.operations.with_id(
                self.meta.workspace.environment.clone(),
                operation,
                Origin::User {
                    session: Some(self.meta.id.clone()),
                },
            ),
        }
    }
}

/// The session's state when the context was built (hooks read its model); an App call changes nothing in the session.
struct Snapshot {
    session: SessionId,
    view: RunView,
}

fn refused(what: &str) -> OrchestrationError {
    OrchestrationError::Failed {
        message: format!("an MCP App call cannot {what}"),
    }
}

#[async_trait]
impl SessionOps for Snapshot {
    async fn view(&self) -> Option<RunView> {
        Some(self.view.clone())
    }

    async fn owner_session(&self, _session: &SessionId) -> SessionId {
        self.session.clone()
    }

    async fn conversation(&self) -> Option<Vec<Message>> {
        None
    }

    async fn set_plan(&self, _enabled: bool) -> Result<(), OrchestrationError> {
        Err(refused("change plan mode"))
    }

    async fn set_workspace(&self, _root: EnvPath) -> Result<(), OrchestrationError> {
        Err(refused("change the working directory"))
    }

    async fn freeze_title(&self, _title: String) {}

    async fn arm_monitor(
        &self,
        _monitor: MonitorArmed,
        _events: CommandEvents,
    ) -> Result<(), OrchestrationError> {
        Err(refused("arm a monitor"))
    }
}

#[cfg(test)]
#[path = "app_tool_context_tests.rs"]
mod tests;
