//! Fork: the sessions with a request or a creation in flight (Node `sessionRequestCounts` and `sessionCreationIds`). The
//! server owns the registry: every non-deletion request holds a [`RequestGuard`] for the session ids it carries while
//! it runs, and a create holds a [`CreationGuard`] for its explicit id. Permanent deletion and purge read it through
//! `busy_session_ids`, so a request still in flight cannot race a purge that started before it.
//!
//! Node counts a request under the ids of `collectResidencySessionIds` (`sessionId`, the topic, `commands[].sessionId`)
//! and excludes the two deletion methods; a create claims only the id the caller gave (a generated id is not a
//! deletion target yet).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

/// The in-flight registry. Lock order: none is held across an await; each method takes its one lock briefly.
#[derive(Default)]
pub(crate) struct InFlight {
    requests: Mutex<HashMap<String, usize>>,
    creations: Mutex<HashSet<String>>,
}

impl InFlight {
    /// Counts one request under each id (duplicates count once per request). The guard releases the counts on drop.
    pub(crate) fn request(self: &Arc<Self>, ids: &[String]) -> RequestGuard {
        let mut unique: Vec<String> = Vec::new();
        for id in ids {
            if !unique.contains(id) {
                unique.push(id.clone());
            }
        }
        {
            let mut requests = self
                .requests
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            for id in &unique {
                *requests.entry(id.clone()).or_insert(0) += 1;
            }
        }
        RequestGuard {
            registry: Arc::clone(self),
            ids: unique,
        }
    }

    /// Claims `id` for a create. `None` when a create for it is already in flight.
    pub(crate) fn claim_creation(self: &Arc<Self>, id: &str) -> Option<CreationGuard> {
        let mut creations = self
            .creations
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        creations.insert(id.to_owned()).then(|| CreationGuard {
            registry: Arc::clone(self),
            id: id.to_owned(),
        })
    }

    /// Node's busy test for the request and creation counts of one session.
    pub(crate) fn busy(&self, id: &str) -> bool {
        let requested = self
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .is_some_and(|count| *count > 0);
        requested
            || self
                .creations
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains(id)
    }
}

/// Holds the request counts of its ids until dropped.
pub(crate) struct RequestGuard {
    registry: Arc<InFlight>,
    ids: Vec<String>,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        let mut requests = self
            .registry
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for id in &self.ids {
            if let Some(count) = requests.get_mut(id) {
                *count -= 1;
                if *count == 0 {
                    requests.remove(id);
                }
            }
        }
    }
}

/// Holds a creation claim until dropped.
pub(crate) struct CreationGuard {
    registry: Arc<InFlight>,
    id: String,
}

impl Drop for CreationGuard {
    fn drop(&mut self) {
        self.registry
            .creations
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.id);
    }
}
