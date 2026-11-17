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

/// Where the run's lifecycle notifications go (production: `peer.try_notify(LIFECYCLE, …)`).
pub(crate) type Notify = Arc<dyn Fn(&Value) + Send + Sync>;

pub struct RunTickets {
    runs: Arc<OffPeakRuns>,
    session: String,
    execution_id: String,
    notify: Notify,
}

impl RunTickets {
    pub(crate) fn new(
        runs: Arc<OffPeakRuns>,
        session: impl Into<String>,
        execution_id: impl Into<String>,
        notify: Notify,
    ) -> Self {
        Self {
            runs,
            session: session.into(),
            execution_id: execution_id.into(),
            notify,
        }
    }
}

/// The error an attempt ends with: the Node code, as the message.
fn ended(code: &str) -> ModelError {
    ModelError::Authentication {
        message: code.to_owned(),
    }
}

#[async_trait]
impl OffPeakTicketSource for RunTickets {
    /// Node `waitForTicket`: waits until the run may use a ticket, then returns it with its credentials.
    async fn acquire(&self) -> Result<Ticket, ModelError> {
        loop {
            // The waiter exists before the state is read, so a change in between is not missed.
            let changed = self.runs.changed.notified();
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
                    (self.notify)(note);
                }
            }
        }
        loop {
            let changed = self.runs.changed.notified();
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
