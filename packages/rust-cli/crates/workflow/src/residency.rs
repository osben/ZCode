//! Session residency and `LiveRunGuard` (W6b part 6; spec section 9.15).
//!
//! Node keeps the App resident while a run is live: a launch registers its settlement as residency-blocking work. Here
//! the parent session of a run holds a [`LiveRunGuard`] from the launch to the settlement, and the guard is what keeps
//! the session from being evicted. The guard is dropped when the run settles, which is the one release.
//!
//! Rules.
//! - A session with a live guard is not evicted: [`SessionResidency::try_evict`] refuses.
//! - Closing a session stops each of its live runs as `interrupted` ([`LiveRun::stop_interrupted`]), then waits until
//!   every guard is dropped. The run's settlement is what drops it. A close of an idle session returns at once. The
//!   wait is bounded ([`DEFAULT_CLOSE_WAIT`] unless built with [`SessionResidency::with_close_wait`]): a close that
//!   cannot finish returns an error naming the session and the runs still live.
//! - A run is stopped at most once, whatever the number of closes. The ledger remembers which guards it has stopped.
//! - A stop cannot close its own session: a close requested from inside [`LiveRun::stop_interrupted`] is refused.
//! - A session that is closed or evicted refuses a new guard: a launch after close is a wiring error.
//!
//! The run service that creates guards is W7. Until then, the guard is tested with fake runs and with a real owner.
use anyhow::{Result, anyhow, bail};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// How long a close waits for the runs it stopped to settle, unless the ledger is built with another bound. A stopped run
/// settles within its own turn's cleanup, which is seconds, so a minute is a wide margin before a close reports a stuck run.
pub const DEFAULT_CLOSE_WAIT: Duration = Duration::from_secs(60);

thread_local! {
    /// Set while this thread is inside a run's `stop_interrupted`, so a close started from there is refused.
    static STOPPING: Cell<bool> = const { Cell::new(false) };
}

/// Sets [`STOPPING`] for the duration of one stop, and clears it on every exit, including a panic.
struct StoppingScope;

impl StoppingScope {
    fn enter() -> Self {
        STOPPING.with(|flag| flag.set(true));
        Self
    }
}

impl Drop for StoppingScope {
    fn drop(&mut self) {
        STOPPING.with(|flag| flag.set(false));
    }
}

/// A live run as the residency ledger sees it. The run service implements it (W7).
///
/// Contract:
/// - The ledger calls `stop_interrupted` at most once per live run, however many closes of its session happen. A
///   concurrent close never stops a run twice, because the ledger marks the run as stopped under its lock.
/// - The call may happen while the run is settling. It must not block on the run's own settlement, which is what the
///   close waits for. It may settle the run synchronously (a fake run does).
/// - It must not call [`SessionResidency::close`] on its own session. The ledger refuses such a call on the same thread,
///   so a violation returns an error rather than deadlocking.
pub trait LiveRun: Send + Sync {
    /// Stop the run as `interrupted` (Node's close of a live run). The run settles later, and that settlement drops its
    /// guard. It is called outside the ledger's lock.
    fn stop_interrupted(&self);
}

/// A live guard's id, the run it names, and the run it holds.
struct LiveEntry {
    id: u64,
    run_id: String,
    run: Arc<dyn LiveRun>,
}

#[derive(Default)]
struct State {
    next_id: u64,
    /// The live guards of each session.
    live: HashMap<String, Vec<LiveEntry>>,
    /// Guards whose run has been stopped by a close. A guard is listed until it is dropped.
    stopped: HashSet<u64>,
    /// Sessions that were closed or evicted: a new guard on them is refused.
    retired: HashSet<String>,
    /// Closes in progress per session (a count: a drain and a close can overlap on one session).
    closing: HashMap<String, usize>,
    /// Sessions reopened while a close of them was in progress. The reopen takes effect when the last such close ends.
    reopen_pending: HashSet<String>,
}

/// Holds a session's close count for the duration of one close. When the last close of a session ends, a reopen that was
/// pending on it takes effect. The close itself never clears the retired mark.
struct CloseScope {
    shared: Arc<Shared>,
    session: String,
}

impl CloseScope {
    fn enter(shared: &Arc<Shared>, session: &str) -> Self {
        *shared.lock().closing.entry(session.to_owned()).or_insert(0) += 1;
        Self {
            shared: shared.clone(),
            session: session.to_owned(),
        }
    }
}

impl Drop for CloseScope {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        let remaining = state.closing.get_mut(&self.session).map_or(0, |count| {
            *count -= 1;
            *count
        });
        if remaining == 0 {
            state.closing.remove(&self.session);
            if state.reopen_pending.remove(&self.session) {
                state.retired.remove(&self.session);
            }
        }
        drop(state);
        self.shared.settled.notify_all();
    }
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
    close_wait: Duration,
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
                runs.retain(|entry| entry.id != self.id);
                runs.is_empty()
            }
            None => false,
        };
        if empty {
            state.live.remove(&self.session);
        }
        state.stopped.remove(&self.id);
        drop(state);
        self.shared.settled.notify_all();
    }
}

impl SessionResidency {
    pub fn new() -> Self {
        Self::with_close_wait(DEFAULT_CLOSE_WAIT)
    }

    /// A ledger whose close waits at most `wait` for the runs it stopped to settle.
    pub fn with_close_wait(wait: Duration) -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State::default()),
                settled: Condvar::new(),
            }),
            close_wait: wait,
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
            .push(LiveEntry {
                id,
                run_id: run_id.to_owned(),
                run,
            });
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

    /// Resume a session in this process: it accepts guards again (divergence 63). Returns `true` when it took effect now.
    /// When a close of the session is still in flight, the reopen does not wait for it: it is pending, and takes effect
    /// when the last such close ends (the close never clears the mark itself). Returns `false` then. A close started
    /// after the reopen supersedes it.
    pub fn reopen(&self, session: &str) -> bool {
        let mut state = self.shared.lock();
        if state.closing.contains_key(session) {
            state.reopen_pending.insert(session.to_owned());
            return false;
        }
        state.retired.remove(session);
        true
    }

    /// Refuse new guards on `session` at once, without waiting. The close path calls this on the async thread, so a
    /// launch that races a close is refused before the blocking close starts.
    pub fn retire(&self, session: &str) {
        self.shared.lock().retired.insert(session.to_owned());
    }

    /// The sessions that hold at least one live guard, in id order.
    pub fn sessions_with_live_runs(&self) -> Vec<String> {
        let state = self.shared.lock();
        let mut sessions: Vec<String> = state
            .live
            .iter()
            .filter(|(_, runs)| !runs.is_empty())
            .map(|(session, _)| session.clone())
            .collect();
        sessions.sort();
        sessions
    }

    /// The shutdown drain: close every session that holds a live run, with one bound for the whole drain (not one per
    /// session). Returns one error per session that did not close, each naming its stuck runs.
    pub fn drain(&self) -> Vec<anyhow::Error> {
        let deadline = Instant::now() + self.close_wait;
        self.sessions_with_live_runs()
            .iter()
            .filter_map(|session| self.close_until(session, deadline).err())
            .collect()
    }

    /// Close the session: refuse new runs, stop each live run that has not been stopped yet, then wait until every
    /// guard is dropped. Errors when the runs are still live after the wait bound, naming them; the session stays
    /// refused, and a later close waits again without stopping a run twice.
    pub fn close(&self, session: &str) -> Result<()> {
        self.close_until(session, Instant::now() + self.close_wait)
    }

    fn close_until(&self, session: &str, deadline: Instant) -> Result<()> {
        if STOPPING.with(Cell::get) {
            bail!("session {session} cannot be closed from inside a run's stop");
        }
        let _scope = CloseScope::enter(&self.shared, session);
        let to_stop: Vec<Arc<dyn LiveRun>> = {
            let mut state = self.shared.lock();
            state.retired.insert(session.to_owned());
            // A close started after a reopen supersedes it: the session is closed again, so nothing is lifted at the end.
            state.reopen_pending.remove(session);
            let State { live, stopped, .. } = &mut *state;
            let mut picked = Vec::new();
            if let Some(runs) = live.get(session) {
                for entry in runs {
                    if stopped.insert(entry.id) {
                        picked.push(entry.run.clone());
                    }
                }
            }
            picked
        };
        // Stopped outside the lock: a stop may settle its run at once, and a settlement takes the lock.
        for run in &to_stop {
            let _scope = StoppingScope::enter();
            run.stop_interrupted();
        }
        let mut state = self.shared.lock();
        loop {
            let still_live: Vec<String> = state
                .live
                .get(session)
                .map(|runs| runs.iter().map(|entry| entry.run_id.clone()).collect())
                .unwrap_or_default();
            if still_live.is_empty() {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                bail!(
                    "session {session} did not close: run(s) {} still live after {:?}",
                    still_live.join(", "),
                    self.close_wait
                );
            }
            let (next, _timed_out) = self
                .shared
                .settled
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
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
