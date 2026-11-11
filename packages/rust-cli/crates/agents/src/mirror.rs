//! Fork (node_desktop): the live runs of subagents, per child session, for the child session's actor (a side tab on
//! a running subagent streams its run; specs/fork-rust-agent-parity.md). The run itself writes the child session; this
//! only relays what it did, with a replay of the current run for a late subscriber. The App's telemetry reads runs
//! through [`Mirrors::run_feed`], which also replays a finished run that nobody read live (specs/fork-rust-agent-parity.md,
//! "Child runs").

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use futures_util::StreamExt;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::agents::{ChildLive, ChildLiveFeed};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::model::{BlockDelta, ModelSelection};
use rust_cli_kernel_api::orchestration::{QueryError, QueryEvent, QueryStop};
use rust_cli_kernel_api::session_api::TurnOutcome;
use tokio::sync::broadcast;

/// The live buffer of one subscriber; one that falls further behind gets a new feed.
const CAPACITY: usize = 4096;

/// The finished runs kept for a late [`Mirrors::run_feed`]. A run is kept only when it finished with no subscriber,
/// which happens when the parent's watch has not subscribed yet; the parent subscribes within its next table read, so
/// a few runs are enough.
const KEPT_FINISHED: usize = 16;

struct Mirror {
    /// The current run's `Started` (run number and model); None between runs.
    started: Option<(u64, ModelSelection)>,
    /// Messages stored during the current run.
    committed: Vec<Message>,
    /// Events since the last stored message (deltas merged, the latest progress per tool).
    events: Vec<QueryEvent>,
    sender: broadcast::Sender<ChildLive>,
}

impl Mirror {
    fn new() -> Self {
        Self {
            started: None,
            committed: Vec::new(),
            events: Vec::new(),
            sender: broadcast::channel(CAPACITY).0,
        }
    }

    fn clear(&mut self) {
        self.committed.clear();
        self.events.clear();
    }

    fn running(&self) -> bool {
        self.started.is_some()
    }

    /// Records `event`; for a `Finished` that no subscriber receives, returns the whole run to keep.
    fn record(&mut self, event: &ChildLive) -> Option<Vec<ChildLive>> {
        match event {
            ChildLive::Started { run, selection } => {
                self.started = Some((*run, selection.clone()));
                self.clear();
            }
            ChildLive::Event(event) if self.running() => self.push(event),
            ChildLive::Committed(message) if self.running() => {
                self.committed.push(message.clone());
                self.events.clear();
            }
            ChildLive::Finished(_) => {
                let unread = (self.running() && self.sender.receiver_count() == 0).then(|| {
                    let mut run = self.replay();
                    run.push(event.clone());
                    run
                });
                self.started = None;
                self.clear();
                return unread;
            }
            ChildLive::Event(_) | ChildLive::Committed(_) => {}
        }
        None
    }

    fn push(&mut self, event: &QueryEvent) {
        if let QueryEvent::Delta {
            message,
            index,
            delta,
        } = event
            && let Some(QueryEvent::Delta {
                message: last_message,
                index: last_index,
                delta: last,
            }) = self.events.last_mut()
            && last_message == message
            && last_index == index
            && merge(last, delta)
        {
            return;
        }
        if let QueryEvent::ToolProgress { tool_use, .. } = event {
            self.events.retain(
                |known| !matches!(known, QueryEvent::ToolProgress { tool_use: known, .. } if known == tool_use),
            );
        }
        self.events.push(event.clone());
    }

    fn replay(&self) -> Vec<ChildLive> {
        let Some((run, selection)) = &self.started else {
            return Vec::new();
        };
        std::iter::once(ChildLive::Started {
            run: *run,
            selection: selection.clone(),
        })
        .chain(self.committed.iter().cloned().map(ChildLive::Committed))
        .chain(self.events.iter().cloned().map(ChildLive::Event))
        .collect()
    }
}

/// Appends `next` to `delta` when both are the same kind.
fn merge(delta: &mut BlockDelta, next: &BlockDelta) -> bool {
    match (delta, next) {
        (BlockDelta::Text(text), BlockDelta::Text(more))
        | (BlockDelta::Thinking(text), BlockDelta::Thinking(more))
        | (BlockDelta::Signature(text), BlockDelta::Signature(more))
        | (BlockDelta::InputJson(text), BlockDelta::InputJson(more)) => {
            text.push_str(more);
            true
        }
        _ => false,
    }
}

#[derive(Default)]
struct Inner {
    mirrors: HashMap<SessionId, Mirror>,
    /// Finished runs no subscriber read live, oldest first (see [`KEPT_FINISHED`]).
    finished: VecDeque<(SessionId, Vec<ChildLive>)>,
    /// The last run number handed out.
    runs: u64,
}

#[derive(Default)]
pub(crate) struct Mirrors(Mutex<Inner>);

impl Mirrors {
    /// The number of a run about to start (unique within the process, increasing).
    pub(crate) fn next_run(&self) -> u64 {
        let mut inner = self.0.lock_unpoisoned();
        inner.runs += 1;
        inner.runs
    }

    pub(crate) fn publish(&self, session: &SessionId, event: ChildLive) {
        let mut inner = self.0.lock_unpoisoned();
        let inner = &mut *inner;
        if matches!(event, ChildLive::Started { .. }) {
            inner.finished.retain(|(kept, _)| kept != session);
        }
        let mirror = inner
            .mirrors
            .entry(session.clone())
            .or_insert_with(Mirror::new);
        if let Some(run) = mirror.record(&event) {
            if inner.finished.len() == KEPT_FINISHED {
                inner.finished.pop_front();
            }
            inner.finished.push_back((session.clone(), run));
        }
        let _ = mirror.sender.send(event);
        if !mirror.running() && mirror.sender.receiver_count() == 0 {
            inner.mirrors.remove(session);
        }
    }

    /// The side tab's feed: the current run so far and the later events.
    pub(crate) fn feed(&self, session: &SessionId) -> ChildLiveFeed {
        self.subscribe(session, false)
    }

    /// The telemetry's feed: like [`Self::feed`], but a child that is not running replays its last finished run that
    /// no subscriber read live, once.
    pub(crate) fn run_feed(&self, session: &SessionId) -> ChildLiveFeed {
        self.subscribe(session, true)
    }

    fn subscribe(&self, session: &SessionId, finished: bool) -> ChildLiveFeed {
        let mut inner = self.0.lock_unpoisoned();
        let inner = &mut *inner;
        inner
            .mirrors
            .retain(|_, mirror| mirror.running() || mirror.sender.receiver_count() > 0);
        let mirror = inner
            .mirrors
            .entry(session.clone())
            .or_insert_with(Mirror::new);
        let receiver = mirror.sender.subscribe();
        let mut replay = mirror.replay();
        if finished
            && replay.is_empty()
            && let Some(at) = inner.finished.iter().position(|(kept, _)| kept == session)
            && let Some((_, run)) = inner.finished.remove(at)
        {
            replay = run;
        }
        ChildLiveFeed {
            replay,
            live: futures_util::stream::unfold(receiver, |mut receiver| async move {
                // A lagged or closed receiver ends the stream; the subscriber takes a new feed.
                receiver.recv().await.ok().map(|event| (event, receiver))
            })
            .boxed(),
        }
    }
}

/// The `Started` / `Finished` pair of one child run. Dropping it unfinished (the run was cancelled) still ends the run
/// for the subscribers.
pub(crate) struct MirrorRun {
    core: Option<std::sync::Arc<crate::Core>>,
    session: SessionId,
    outcome: Option<TurnOutcome>,
}

impl MirrorRun {
    pub(crate) fn start(
        core: &std::sync::Arc<crate::Core>,
        session: &SessionId,
        selection: &ModelSelection,
    ) -> Self {
        let core = core.node_desktop.then(|| core.clone());
        if let Some(core) = &core {
            let run = core.mirrors.next_run();
            core.mirrors.publish(
                session,
                ChildLive::Started {
                    run,
                    selection: selection.clone(),
                },
            );
        }
        Self {
            core,
            session: session.clone(),
            outcome: None,
        }
    }

    pub(crate) fn finish(&mut self, outcome: TurnOutcome) {
        self.outcome = Some(outcome);
    }
}

impl Drop for MirrorRun {
    fn drop(&mut self) {
        if let Some(core) = &self.core {
            let outcome = self.outcome.take().unwrap_or(TurnOutcome::Interrupted);
            core.mirrors
                .publish(&self.session, ChildLive::Finished(outcome));
        }
    }
}

/// The turn outcome of a child run's result (the session actor's mapping of the same stops).
pub(crate) fn outcome(result: &Result<QueryStop, QueryError>) -> TurnOutcome {
    match result {
        Ok(QueryStop::Completed) => TurnOutcome::Success,
        Ok(QueryStop::Aborted) => TurnOutcome::Interrupted,
        Ok(QueryStop::HookStopped) => TurnOutcome::HookStopped,
        Ok(QueryStop::StopHookPrevented) => TurnOutcome::StopHookPrevented,
        Ok(QueryStop::MaxTurns) => TurnOutcome::Failed {
            message: "reached the maximum number of turns".to_owned(),
        },
        Ok(QueryStop::Blocked { message } | QueryStop::ApiError { message }) => {
            TurnOutcome::Failed {
                message: message.clone(),
            }
        }
        Err(error) => TurnOutcome::Failed {
            message: error.to_string(),
        },
    }
}

#[cfg(test)]
#[path = "mirror_tests.rs"]
mod tests;
