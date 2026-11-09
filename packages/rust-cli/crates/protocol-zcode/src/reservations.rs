//! Fork: per-item reservations for an in-flight command (Node `reserveQueueItem`, see
//! [`crate::live::Live::reserve_promotion`]). A reservation lasts while its guard lives.

use std::collections::HashSet;
use std::sync::Mutex;

use rust_cli_base::sync::LockUnpoisoned;

#[derive(Default)]
pub struct Reservations(Mutex<HashSet<String>>);

/// A held reservation, released when dropped.
pub struct Reservation<'a> {
    owner: &'a Reservations,
    item: String,
}

impl Reservations {
    /// `None` while another guard holds the item.
    pub fn reserve(&self, item: &str) -> Option<Reservation<'_>> {
        self.0
            .lock_unpoisoned()
            .insert(item.to_owned())
            .then(|| Reservation {
                owner: self,
                item: item.to_owned(),
            })
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.owner.0.lock_unpoisoned().remove(&self.item);
    }
}

#[cfg(test)]
mod tests {
    use super::Reservations;

    #[test]
    fn an_item_is_reserved_once_until_its_guard_drops() {
        let reservations = Reservations::default();
        let first = reservations.reserve("q1");
        assert!(first.is_some());
        assert!(reservations.reserve("q1").is_none());
        assert!(reservations.reserve("q2").is_some());
        drop(first);
        assert!(reservations.reserve("q1").is_some());
    }
}
