//! Fork: ending a helper process (specs/fork-rust-node-helper.md F3 "Lifecycle changes" and F4a "Shutdown order"):
//! the idle reclaim, a crash and the breaker, a timed-out call (kept or dropped), a lost link, and the cancel of an
//! abandoned call.

use super::*;

pub(super) fn is_current(state: &State, generation: u64) -> bool {
    matches!(&state.slot, Slot::Running(running) if running.generation == generation)
}

/// Ends the process of `generation` once it has been idle for `idle`. Each wake-up re-checks the state, so a call in
/// flight or a newer process is never reclaimed by a stale timer.
pub(super) async fn reclaim(weak: Weak<NodeHelper>, generation: u64, idle: Duration) {
    loop {
        let Some(helper) = weak.upgrade() else {
            return;
        };
        // The lock lives in this block only: the guard must not be held, or even live, across the sleep below.
        let wake = {
            let mut state = helper.state.lock_unpoisoned();
            let Slot::Running(running) = &state.slot else {
                return;
            };
            if running.generation != generation {
                return;
            }
            if !running.idle() {
                Some(Instant::now() + idle)
            } else if running.last_used.elapsed() >= idle {
                let retired = std::mem::replace(&mut state.slot, Slot::Idle);
                drop(state);
                drop(retired);
                tracing::info!(
                    event = "helper.reclaimed",
                    generation,
                    "the idle node helper was reclaimed"
                );
                None
            } else {
                Some(running.last_used + idle)
            }
        };
        let Some(wake) = wake else {
            return;
        };
        drop(helper);
        tokio::time::sleep_until(wake).await;
    }
}

impl NodeHelper {
    /// A helper process is starting, or running with its connection open.
    pub(super) fn has_process(&self) -> bool {
        match &self.state.lock_unpoisoned().slot {
            Slot::Starting(_) => true,
            Slot::Running(running) => !running.peer.is_closed(),
            Slot::Idle | Slot::Down => false,
        }
    }

    pub(super) fn spawn_reclaim(&self, generation: u64) {
        let weak = self.myself.clone();
        let idle = self.timing.idle;
        drop(self.spawner.spawn("node-helper-idle", async move {
            reclaim(weak, generation, idle).await;
        }));
    }

    pub(super) fn finish(&self, generation: u64) {
        let mut state = self.state.lock_unpoisoned();
        if let Slot::Running(running) = &mut state.slot
            && running.generation == generation
        {
            running.in_flight -= 1;
            running.last_used = Instant::now();
        }
    }

    /// A call of `generation` timed out; `started` is [`Self::heard_count`] when it started. The process is kept when it was heard from since the
    /// call started (an answer, progress or pipe traffic) or when it answers `helper/ping` in time: it is alive and only
    /// this call is slow, and dropping it would close every session's helper pipes. Otherwise it is hung and is dropped
    /// without counting a crash. Returns whether the process was kept.
    pub(super) async fn timed_out(&self, generation: u64, started: u64, peer: &Peer) -> bool {
        let heard = match &self.state.lock_unpoisoned().slot {
            Slot::Running(running) if running.generation == generation => running.heard != started,
            _ => return false,
        };
        let alive = heard || self.answers_ping(peer).await;
        let mut state = self.state.lock_unpoisoned();
        if !is_current(&state, generation) {
            return false;
        }
        if alive {
            if let Slot::Running(running) = &mut state.slot {
                running.heard += 1;
            }
            tracing::warn!(
                event = "helper.call_timed_out",
                generation,
                "a forwarded call timed out; the helper is alive and is kept"
            );
            return true;
        }
        let retired = std::mem::replace(&mut state.slot, Slot::Idle);
        drop(state);
        drop(retired);
        tracing::warn!(
            event = "helper.unavailable",
            reason = "timeout",
            "the node helper was dropped"
        );
        false
    }

    /// Any answer to `helper/ping` within [`Timing::ping`] proves the process is alive, an error answer included.
    async fn answers_ping(&self, peer: &Peer) -> bool {
        match tokio::time::timeout(self.timing.ping, peer.request(PING, &json!({}))).await {
            Ok(Ok(_)) => true,
            Ok(Err(error)) => !(error.code == CONNECTION_CLOSED && peer.is_closed()),
            Err(_elapsed) => false,
        }
    }

    /// The kept process still runs a call its caller gave up on. It is cancelled in the helper with that call's own
    /// cancel, as the Host would, so it neither keeps running nor stays registered under its id: a panel tool call's
    /// pending authorization is withdrawn, a sampling call ends. Fire and forget: the answer does not matter, and a
    /// process dropped meanwhile ends the call anyway.
    pub(super) fn cancel_abandoned(&self, method: &str, params: &Value, peer: &Peer) {
        let Some((cancel_method, cancel)) = abandoned_cancel(method, params) else {
            return;
        };
        let peer = peer.clone();
        let deadline = self.timing.cancel;
        drop(self.spawner.spawn("node-helper-cancel", async move {
            // The helper answers an app tool cancel only as a notification (it never advertises it).
            if cancel_method == super::app_tools::APP_TOOLS_CANCEL {
                let _ = tokio::time::timeout(deadline, peer.notify(cancel_method, &cancel)).await;
            } else {
                let _ = tokio::time::timeout(deadline, peer.request(cancel_method, &cancel)).await;
            }
        }));
    }

    /// The reader of `generation` ended (the process closed its stdout), or a call saw the connection closed.
    pub(super) fn link_lost(&self, generation: u64) {
        let mut state = self.state.lock_unpoisoned();
        if is_current(&state, generation) {
            let retired = self.crashed(&mut state, generation);
            drop(state);
            drop(retired);
        } else {
            tracing::info!(
                event = "helper.exited",
                generation,
                "the node helper exited"
            );
        }
    }

    /// Counts a crash of `generation` and trips the breaker at the limit. Ignored unless `generation` is the running
    /// process, so a crash is counted once however many callers see it. Returns the crashed slot, for the caller to
    /// drop after it releases the lock.
    #[must_use]
    pub(super) fn crashed(&self, state: &mut State, generation: u64) -> Option<Slot> {
        if !is_current(state, generation) {
            return None;
        }
        let retired = std::mem::replace(&mut state.slot, Slot::Idle);
        let now = Instant::now();
        let window = self.timing.crash_window;
        state
            .crashes
            .retain(|at| now.saturating_duration_since(*at) < window);
        state.crashes.push(now);
        tracing::warn!(
            event = "helper.crashed",
            generation,
            crashes = state.crashes.len(),
            "the node helper crashed"
        );
        if state.crashes.len() >= self.timing.crash_limit {
            state.slot = Slot::Down;
            tracing::warn!(
                event = "helper.unavailable",
                reason = "crash_limit",
                "the node helper stays down until this process restarts"
            );
        }
        Some(retired)
    }
}
