//! Session residency and `LiveRunGuard` (W6b part 6; spec section 9.15).
//!
//! Node keeps the App resident while a run is live: a launch registers its settlement as residency-blocking work. Here
//! the parent session of a run holds a [`LiveRunGuard`] from the launch to the settlement, and the guard is what keeps
//! the session from being evicted. The guard is dropped when the run settles, which is the one release.
//!
//! Rules.
//! - A session with a live guard is not evicted: [`SessionResidency::try_evict`] refuses.
//! - Closing a session stops each of its live runs as `interrupted` ([`LiveRun::stop_interrupted`]), then waits until
//!   every guard is dropped. The run's settlement is what drops it. A close of an idle session returns at once.
//! - A session that is closed or evicted refuses a new guard: a launch after close is a wiring error.
//!
//! The run service that creates guards is W7. Until then, the guard is tested with fake runs and with a real owner.
use anyhow::{Result, anyhow};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

/// A live run as the residency ledger sees it. The run service implements it (W7).
pub trait LiveRun: Send + Sync {
    /// Stop the run as `interrupted` (Node's close of a live run). The run settles later, and that settlement drops its
    /// guard. It is called outside the ledger's lock, so it may settle the run at once.
    fn stop_interrupted(&self);
}

/// A live guard's id, and the run it holds.
type LiveEntry = (u64, Arc<dyn LiveRun>);

#[derive(Default)]
struct State {
    next_id: u64,
    /// The live guards of each session, with the run each one holds.
    live: HashMap<String, Vec<LiveEntry>>,
    /// Sessions that were closed or evicted: a new guard on them is refused.
    retired: HashSet<String>,
}

struct Shared {
    state: Mutex<State>,
    /// Signalled whenever a guard is dropped, so a close waiting on its runs can look again.
    settled: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The residency ledger. One per process; the sessions it names are the owners' parent sessions.
pub struct SessionResidency {
    shared: Arc<Shared>,
}

/// One live run of a session. Dropping it is the run's settlement.
pub struct LiveRunGuard {
    shared: Arc<Shared>,
    session: String,
    id: u64,
}

impl fmt::Debug for LiveRunGuard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LiveRunGuard")
            .field("session", &self.session)
            .field("id", &self.id)
            .finish()
    }
}

impl Drop for LiveRunGuard {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        let empty = match state.live.get_mut(&self.session) {
            Some(runs) => {
                runs.retain(|(id, _)| *id != self.id);
                runs.is_empty()
            }
            None => false,
        };
        if empty {
            state.live.remove(&self.session);
        }
        drop(state);
        self.shared.settled.notify_all();
    }
}

impl SessionResidency {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State::default()),
                settled: Condvar::new(),
            }),
        }
    }

    /// Register a live run on `session`. The guard lasts until the run settles.
    pub fn acquire(
        &self,
        session: &str,
        run_id: &str,
        run: Arc<dyn LiveRun>,
    ) -> Result<LiveRunGuard> {
        let mut state = self.shared.lock();
        if state.retired.contains(session) {
            return Err(anyhow!(
                "session {session} is closed or evicted, so run {run_id} cannot be launched on it"
            ));
        }
        state.next_id += 1;
        let id = state.next_id;
        state
            .live
            .entry(session.to_owned())
            .or_default()
            .push((id, run));
        Ok(LiveRunGuard {
            shared: self.shared.clone(),
            session: session.to_owned(),
            id,
        })
    }

    /// Evict the session when no live run holds it. An evicted session refuses new guards. Returns whether it was
    /// evicted.
    pub fn try_evict(&self, session: &str) -> bool {
        let mut state = self.shared.lock();
        if state.live.get(session).is_some_and(|runs| !runs.is_empty()) {
            return false;
        }
        state.retired.insert(session.to_owned());
        true
    }

    /// Close the session: refuse new runs, stop each live run as interrupted, then wait until every one has settled.
    pub fn close(&self, session: &str) -> Result<()> {
        let runs: Vec<Arc<dyn LiveRun>> = {
            let mut state = self.shared.lock();
            state.retired.insert(session.to_owned());
            state
                .live
                .get(session)
                .map(|runs| runs.iter().map(|(_, run)| run.clone()).collect())
                .unwrap_or_default()
        };
        // Stopped outside the lock: a stop may settle its run at once, and a settlement takes the lock.
        for run in &runs {
            run.stop_interrupted();
        }
        let mut state = self.shared.lock();
        while state.live.get(session).is_some_and(|runs| !runs.is_empty()) {
            state = self
                .shared
                .settled
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        state.live.remove(session);
        Ok(())
    }

    /// The number of live runs the session holds.
    pub fn live_runs(&self, session: &str) -> usize {
        self.shared.lock().live.get(session).map_or(0, Vec::len)
    }
}

impl Default for SessionResidency {
    fn default() -> Self {
        Self::new()
    }
}
