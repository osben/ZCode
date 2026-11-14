//! Fork: the Cron tools' requests to the desktop Host's automation store (Node `automation-port.ts`
//! `requestClient`; specs/fork-rust-automations.md, slice 2). Every request carries the owner session's
//! `workspace` ref, so a connection shared by several workspaces never borrows another one (Node
//! `sessionWorkspaceRouting`), and the Host's result is checked against the method's reply schema.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::automation::{AutomationError, AutomationPort};
use rust_cli_kernel_api::ids::SessionId;
use serde_json::Value;

use crate::context::Context;
use crate::inbound::Inbound;

pub struct HostAutomations {
    context: Arc<Context>,
}

impl HostAutomations {
    pub fn new(context: Arc<Context>) -> Self {
        Self { context }
    }
}

#[async_trait]
impl AutomationPort for HostAutomations {
    async fn request(
        &self,
        session: &SessionId,
        method: &str,
        mut params: Value,
    ) -> Result<Value, AutomationError> {
        // Fail closed before anything is sent: a method without a reply schema would answer unchecked data, and
        // params that are not an object cannot carry the workspace.
        if !Inbound::get().knows_reply(method) {
            return Err(AutomationError::new(format!(
                "{method} is not an automation method"
            )));
        }
        let Some(fields) = params.as_object_mut() else {
            return Err(AutomationError::new(format!(
                "{method} params must be an object"
            )));
        };
        let workspace = self
            .context
            .workspace_ref(session.as_str())
            .ok_or_else(|| AutomationError::new("Session workspace is unavailable"))?;
        fields.insert("workspace".to_owned(), workspace);
        let result = self
            .context
            .peer
            .request(method, &params)
            .await
            .map_err(|error| AutomationError {
                code: Some(error.code),
                message: error.message,
            })?;
        Inbound::get()
            .reply(method, &result)
            .map_err(|error| AutomationError::new(format!("invalid {method} reply: {error}")))?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "automation_port_tests.rs"]
mod tests;
