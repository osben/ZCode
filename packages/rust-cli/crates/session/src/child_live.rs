//! Fork (node_desktop): the actor of a subagent's child session mirrors the subagent's live run (kernel-api
//! `ChildLive`), so a side tab on a running subagent streams it like Node's child topic
//! (specs/fork-rust-agent-parity.md, side-pane tab of a running subagent).
//!
//! The run is owned by the agents crate and stores its messages itself: a mirrored message only goes into this actor's
//! in-memory history and its event log, never through a commit.

use std::sync::Mutex;

use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::agents::{ChildLive, ChildLiveFeed};
use rust_cli_kernel_api::ids::TurnId;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::session_api::{Command, KernelEvent, TurnOutcome};

use crate::actor::Actor;

#[derive(Default)]
pub(crate) struct Mirror {
    /// Taken before the cold load; applied after the first view (its replay then follows the view's `last_seq`).
    /// In a mutex only so the actor stays `Sync` (the streams are not; crate::watched does the same).
    pending: Option<Mutex<ChildLiveFeed>>,
    live: Option<Mutex<BoxStream<'static, ChildLive>>>,
    /// The mirrored run's turn while it runs.
    turn: Option<TurnId>,
    /// Stream deltas were mirrored since the last mirrored message.
    draft: bool,
}

impl Mirror {
    pub(crate) fn new(feed: Option<ChildLiveFeed>) -> Self {
        Self {
            pending: feed.map(Mutex::new),
            ..Self::default()
        }
    }

    /// A mirrored run is live: the view reports running and turn-starting commands are refused.
    pub(crate) fn running(&self) -> bool {
        self.turn.is_some()
    }
}

/// The feed taken at the cold load shows a running child run.
pub(crate) fn running(feed: Option<&ChildLiveFeed>) -> bool {
    feed.is_some_and(|feed| matches!(feed.replay.first(), Some(ChildLive::Started)))
}

/// The next mirrored event; `None` when the live stream ended (the receiver fell behind). Pending without a stream.
pub(crate) async fn next(mirror: &mut Mirror) -> Option<ChildLive> {
    match mirror.live.as_mut() {
        Some(live) => live.get_mut_unpoisoned().next().await,
        None => std::future::pending().await,
    }
}

/// Commands that would start this actor's own turn next to the mirrored run.
pub(crate) fn starts_turn(command: &Command) -> bool {
    matches!(
        command,
        Command::Submit { .. }
            | Command::SubmitWith { .. }
            | Command::SubmitContent { .. }
            | Command::Compact { .. }
            | Command::Bash { .. }
            | Command::Rewind { .. }
            | Command::RewindTurnFiles { .. }
            | Command::ResumeGoal
    )
}

impl Actor {
    /// After the first view was served.
    pub(crate) fn attach_child_live(&mut self) {
        let Some(feed) = self.mirror.pending.take() else {
            return;
        };
        let feed = feed
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.mirror.live = Some(Mutex::new(feed.live));
        for event in feed.replay {
            self.on_child_live(event);
        }
    }

    pub(crate) async fn on_child_live_next(&mut self, next: Option<ChildLive>) {
        match next {
            Some(event) => self.on_child_live(event),
            None => self.resync_child_live().await,
        }
    }

    fn on_child_live(&mut self, event: ChildLive) {
        match event {
            ChildLive::Started => {
                if self.mirror.turn.is_none() {
                    let turn = self.deps.ids.turn();
                    self.mirror.turn = Some(turn.clone());
                    self.log.append(KernelEvent::TurnStarted {
                        turn,
                        command: None,
                    });
                }
            }
            ChildLive::Event(event) => {
                let Some(turn) = self.mirror.turn.clone() else {
                    return;
                };
                let event = crate::turn::kernel_event(turn, event);
                self.mirror.draft |= matches!(event, KernelEvent::StreamDelta { .. });
                self.log.append(event);
            }
            ChildLive::Committed(message) => self.mirrored_message(message),
            ChildLive::Finished(outcome) => self.finish_mirrored(outcome),
        }
    }

    fn mirrored_message(&mut self, message: Message) {
        let draft = std::mem::take(&mut self.mirror.draft);
        if self.messages.iter().any(|known| known.id() == message.id()) {
            // The cold load already holds it (stored after the feed was taken): a draft streamed for it would stay
            // next to the loaded row, so the projection rebuilds from the view instead.
            if draft {
                self.history_reread();
            }
            return;
        }
        self.messages.push(message.clone());
        self.log.append(KernelEvent::MessageDone { message });
    }

    fn finish_mirrored(&mut self, outcome: TurnOutcome) {
        let Some(turn) = self.mirror.turn.take() else {
            return;
        };
        self.mirror.draft = false;
        let usage = self
            .messages
            .iter()
            .rev()
            .find_map(|message| match message {
                Message::Assistant(assistant) => assistant.usage,
                _ => None,
            });
        self.log.append(KernelEvent::TurnFinished {
            turn,
            outcome,
            usage,
        });
    }

    /// The receiver fell behind: take a new feed first, then re-read the stored history, so nothing stored in between
    /// is missed (a message in both is skipped).
    async fn resync_child_live(&mut self) {
        self.mirror.live = None;
        let feed = self.deps.agents.child_live(&self.meta.id);
        match self.deps.store.load(&self.meta.id).await {
            Ok(loaded) => {
                self.messages = loaded.messages;
                self.earlier = loaded.earlier;
            }
            Err(error) => {
                tracing::warn!(%error, "the subagent session could not be re-read after its live run fell behind");
            }
        }
        self.mirror.draft = false;
        self.history_reread();
        let Some(feed) = feed else {
            self.finish_mirrored(TurnOutcome::Success);
            return;
        };
        if !matches!(feed.replay.first(), Some(ChildLive::Started)) {
            self.finish_mirrored(TurnOutcome::Success);
        }
        self.mirror.live = Some(Mutex::new(feed.live));
        for event in feed.replay {
            self.on_child_live(event);
        }
    }

    /// The projection rebuilds from the next view; the generation is the rewind's and does not move.
    fn history_reread(&mut self) {
        self.log.append(KernelEvent::HistoryRewritten {
            generation: self.generation,
        });
    }
}

#[cfg(test)]
#[path = "child_live_tests.rs"]
mod tests;
