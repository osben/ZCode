//! Fork: the OffPeak tools' requests to the desktop Host's off-peak store (Node `offpeak-port.ts` `requestClient`;
//! specs/fork-rust-automations.md, slice 3). Every request carries the owner session's `workspace` ref, and the Host's
//! result is checked against the method's reply schema. A business failure of `offPeak/create` is a reply, not an error.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::off_peak::{OffPeakError, OffPeakPort};
use serde_json::Value;

use rust_cli_kernel_api::off_peak_ticket::TicketSource;

use crate::context::Context;
use crate::inbound::Inbound;
use crate::off_peak_control::LIFECYCLE;
use crate::off_peak_ticket::{Notify, RunTickets};

pub struct HostOffPeak {
    context: Arc<Context>,
}

impl HostOffPeak {
    pub fn new(context: Arc<Context>) -> Self {
        Self { context }
    }
}

#[async_trait]
impl OffPeakPort for HostOffPeak {
    /// Fork (slice 3 layer B): the run's ticket source, while the run is open for `session`.
    fn ticket(&self, session: &SessionId, execution: &str) -> Option<TicketSource> {
        if !self.context.off_peak.has_run(session.as_str(), execution) {
            return None;
        }
        let context = self.context.clone();
        let notify: Notify = Arc::new(move |note: &Value| {
            context.peer.try_notify(LIFECYCLE, note);
        });
        Some(TicketSource(Arc::new(RunTickets::new(
            self.context.off_peak.clone(),
            session.as_str(),
            execution,
            notify,
        ))))
    }

    async fn request(
        &self,
        session: &SessionId,
        method: &str,
        mut params: Value,
    ) -> Result<Value, OffPeakError> {
        // Fail closed before anything is sent: only a method with a reply schema is an off-peak request, and params
        // that are not an object cannot carry the workspace.
        if !matches!(
            method,
            rust_cli_kernel_api::off_peak::CREATE | rust_cli_kernel_api::off_peak::LIST
        ) || !Inbound::get().knows_reply(method)
        {
            return Err(OffPeakError::new(format!(
                "{method} is not an off-peak method"
            )));
        }
        if !self.context.off_peak.tools_enabled(session.as_str()) {
            return Err(OffPeakError::new(
                "The off-peak tools are not enabled for this session",
            ));
        }
        let Some(fields) = params.as_object_mut() else {
            return Err(OffPeakError::new(format!(
                "{method} params must be an object"
            )));
        };
        let workspace = self
            .context
            .workspace_ref(session.as_str())
            .ok_or_else(|| OffPeakError::new("Session workspace is unavailable"))?;
        fields.insert("workspace".to_owned(), workspace);
        let result = self
            .context
            .peer
            .request(method, &params)
            .await
            .map_err(|error| OffPeakError {
                code: Some(error.code),
                message: error.message,
            })?;
        Inbound::get()
            .reply(method, &result)
            .map_err(|error| OffPeakError::new(format!("invalid {method} reply: {error}")))?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "off_peak_port_tests.rs"]
mod tests;
