//! Fork: the ticket source of one off-peak run (Node `OffPeakTicketAuthority`, `core/src/runtime/off-peak/
//! model-binding.ts`; specs/fork-rust-automations.md, slice 3 layer B). It reads and drives the run's lifecycle in
//! [`crate::off_peak_control::OffPeakRuns`]: an attempt waits here for a usable ticket, and an expired ticket asks the
//! Host for a renewal that `v4/conversation/offPeakControl` answers. The wait and the renewal stay in the agent.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::model::ModelError;
use rust_cli_kernel_api::off_peak_ticket::{OffPeakTicketSource, Ticket};
use serde_json::Value;

use crate::off_peak_control::{Expiry, OffPeakRuns, Poll};

/// Where the run's lifecycle notifications go (production: the peer's awaited `v4/offPeak/lifecycle` notification).
#[async_trait]
pub(crate) trait LifecycleSink: Send + Sync {
    /// Sends one notification. False when it could not be delivered (the connection is closed).
    async fn send(&self, note: &Value) -> bool;
}

pub struct RunTickets {
    runs: Arc<OffPeakRuns>,
    session: String,
    execution_id: String,
    sink: Arc<dyn LifecycleSink>,
}

impl RunTickets {
    pub(crate) fn new(
        runs: Arc<OffPeakRuns>,
        session: impl Into<String>,
        execution_id: impl Into<String>,
        sink: Arc<dyn LifecycleSink>,
    ) -> Self {
        Self {
            runs,
            session: session.into(),
            execution_id: execution_id.into(),
            sink,
        }
    }
}

/// The error an attempt ends with once its run has ended. A run that ends (cancelled or completed) stops its attempts as
/// cancelled: the run's Node code is its state, and it must not reach the user as a rejected credential.
fn ended(_code: &str) -> ModelError {
    ModelError::Cancelled
}

/// The renewal request could not be sent, so no answer can come: the attempt fails rather than wait for it.
fn undelivered() -> ModelError {
    ModelError::Network {
        message: "off_peak_ticket_request_undelivered".to_owned(),
    }
}

#[async_trait]
impl OffPeakTicketSource for RunTickets {
    /// Node `waitForTicket`: waits until the run may use a ticket, then returns it with its credentials.
    async fn acquire(&self) -> Result<Ticket, ModelError> {
        loop {
            // The waiter is registered before the state is read: a change after the read wakes it, so none is lost.
            let changed = self.runs.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match self.runs.poll_ticket(&self.session, &self.execution_id) {
                Poll::Ready(ticket) => return Ok(ticket),
                Poll::Ended(code) => return Err(ended(code)),
                Poll::Pending => changed.await,
            }
        }
    }

    fn refused_as_expired(&self, provider: &str, error: &ModelError) -> bool {
        self.runs
            .refused_as_expired(&self.session, &self.execution_id, provider, error)
    }

    /// Node `ticketExpired` then `retryExpired`: a stale ticket retries at once; the current one waits for the renewal.
    async fn expired(&self, ticket_id: &str) -> Result<(), ModelError> {
        match self
            .runs
            .expire_ticket(&self.session, &self.execution_id, ticket_id)
        {
            Expiry::Ended(code) => return Err(ended(code)),
            Expiry::Immediate => return Ok(()),
            Expiry::Renewing(notes) => {
                for note in &notes {
                    if !self.sink.send(note).await {
                        return Err(undelivered());
                    }
                }
            }
        }
        loop {
            // Registered before the state is read, as in `acquire`.
            let changed = self.runs.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match self.runs.poll_ticket(&self.session, &self.execution_id) {
                // Replaced: the next acquire takes the renewed ticket.
                Poll::Ready(ticket) if ticket.id != ticket_id => return Ok(()),
                Poll::Ended(code) => return Err(ended(code)),
                Poll::Ready(_) | Poll::Pending => changed.await,
            }
        }
    }
}

#[cfg(test)]
#[path = "off_peak_ticket_tests.rs"]
mod tests;
