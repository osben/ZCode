//! Fork: the off-peak ticket of one model request (Node `OffPeakTicketAuthority`, `core/src/runtime/off-peak/
//! model-binding.ts`; specs/fork-rust-automations.md, slice 3 layer B, option 1). A request carries an optional source
//! ([`TicketSource`] on [`crate::model::RequestOptions`]); `None` is an ordinary request and changes nothing. The wait,
//! the renewal and the retry belong to the source's owner (the agent's run), never to the Host round trip.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;

use crate::model::ModelError;
use crate::provider::SuppliedAuth;

/// The header that names the ticket an attempt is sent on (Node `x-off-peak-ticket-id`).
pub const TICKET_HEADER: &str = "x-off-peak-ticket-id";

/// The ticket one attempt uses: its id, and the credentials the Host supplied for it. `auth` is None when the run has
/// no credentials of its own: the ordinary request auth source then supplies them (Node `this.requestAuth ?? …`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub id: String,
    pub auth: Option<SuppliedAuth>,
}

#[async_trait]
pub trait OffPeakTicketSource: Send + Sync {
    /// Node `waitForTicket` and the resolve of the request auth: waits until the run may use a ticket.
    async fn acquire(&self) -> Result<Ticket, ModelError>;

    /// Node `retryExpired`: whether `error`, a refusal from `provider`, is the expired-ticket refusal of this run.
    fn refused_as_expired(&self, provider: &str, error: &ModelError) -> bool;

    /// Node `ticketExpired`: the attempt on `ticket_id` was refused. Returns once the request may be sent again: at
    /// once when that ticket was already replaced, after the renewal otherwise. An error once the run has ended.
    async fn expired(&self, ticket_id: &str) -> Result<(), ModelError>;
}

/// A shared ticket source, carried by a request. Equality is identity: two requests are on the same run only when they
/// hold the same source.
#[derive(Clone)]
pub struct TicketSource(pub Arc<dyn OffPeakTicketSource>);

impl fmt::Debug for TicketSource {
    /// The identity equality is defined by, so two unequal sources can be told apart when debugging.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OffPeakTicketSource({:p})", Arc::as_ptr(&self.0))
    }
}

impl PartialEq for TicketSource {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for TicketSource {}

#[cfg(test)]
#[path = "off_peak_ticket_tests.rs"]
mod tests;
