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
fn ended() -> ModelError {
    ModelError::Cancelled
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
                Poll::Ended => return Err(ended()),
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
            Expiry::Ended => return Err(ended()),
            Expiry::Immediate => return Ok(()),
            Expiry::Renewing(notes) => {
                // Sent by a task of its own, not by this attempt: an attempt dropped mid-send (its turn ends, a cancel)
                // must not lose the request, which is the only trigger of the Host's renewal. A send that cannot be
                // delivered ends the run, so its attempts do not wait for an answer nobody can give.
                let sink = self.sink.clone();
                let runs = self.runs.clone();
                let session = self.session.clone();
                let execution = self.execution_id.clone();
                tokio::spawn(async move {
                    for note in &notes {
                        if !sink.send(note).await {
                            runs.abandon_undelivered(&session, &execution);
                            return;
                        }
                    }
                });
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
                Poll::Ended => return Err(ended()),
                Poll::Ready(_) | Poll::Pending => changed.await,
            }
        }
    }
}

#[cfg(test)]
#[path = "off_peak_ticket_tests.rs"]
mod tests;
