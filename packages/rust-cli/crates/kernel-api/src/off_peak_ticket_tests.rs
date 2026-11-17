use std::sync::Arc;

use super::TicketSource;
use super::{OffPeakTicketSource, Ticket};
use crate::model::ModelError;
use crate::provider::SuppliedAuth;

struct Fixed;

#[async_trait::async_trait]
impl OffPeakTicketSource for Fixed {
    async fn acquire(&self) -> Result<Ticket, ModelError> {
        Ok(Ticket {
            id: "tkt_1".to_owned(),
            auth: Some(SuppliedAuth::default()),
        })
    }

    fn refused_as_expired(&self, _provider: &str, _error: &ModelError) -> bool {
        false
    }

    async fn expired(&self, _ticket_id: &str) -> Result<(), ModelError> {
        Ok(())
    }
}

/// A request's source is compared by identity, never by its contents.
#[test]
fn a_ticket_source_is_equal_only_to_itself() {
    let source: Arc<dyn OffPeakTicketSource> = Arc::new(Fixed);
    let same = TicketSource(source.clone());
    assert_eq!(same, TicketSource(source));
    assert_ne!(same, TicketSource(Arc::new(Fixed)));
    assert_eq!(format!("{same:?}"), "OffPeakTicketSource");
}
