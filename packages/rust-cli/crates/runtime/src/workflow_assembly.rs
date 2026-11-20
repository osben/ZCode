//! The production assembly of a workflow run's actor wiring (W7-3; spec 9.12 to 9.15).
//!
//! W7-5's run service composes these pieces. It builds the turn side of a run's actors (`actor_turns`), attaches the
//! run's registrations to its owner (`attach_run`), and feeds the owner from the actors' model stream (`AskObserver`).
//! Nothing here decides what a run does; the module connects the workflow's ports to the agents and the process.
//!
//! The binding (the W7 decision): the run service lives in `runtime` and reaches compile and spawn through the
//! `kernel-api` ports. The governor is a port the workflow crate names. Its production adapter is in `cli`, and the
//! caller passes it in, so this module does not depend on the model crate.
//!
//! Threads. The turn side's `SessionCloser` runs on an ask thread, outside any runtime, and the agents call it
//! synchronously. The observer posts to the mailbox and does not wait, so it is safe on the turn thread and on the
//! model stream's task.
use std::sync::Arc;

use anyhow::{Result, anyhow};
use rust_cli_agents::Agents;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelNotice;
use rust_cli_workflow::actor_feed::{AskFeed, FeedEvent};
use rust_cli_workflow::actor_mailbox::{ActorHandle, MailboxRun};
use rust_cli_workflow::actor_turns::{MailboxTurns, SessionCloser, TurnRunner};
use rust_cli_workflow::driver_owner::{ActorDriverOwner, ActorSessions};
use rust_cli_workflow::event::LastTool;
use rust_cli_workflow::journal::JournalPort;
use rust_cli_workflow::model::AskWait;
use rust_cli_workflow::model_failure::ThreadClock;
use rust_cli_workflow::residency::SessionResidency;
use rust_cli_workflow::run_concurrency::RunConcurrency;

/// What the session close needs from the agents: release an actor's child session once no turn runs on it.
pub trait ActorSessionRelease: Send + Sync + 'static {
    fn release_actor_session(&self, child: &SessionId) -> std::result::Result<(), String>;
}

impl ActorSessionRelease for Agents {
    fn release_actor_session(&self, child: &SessionId) -> std::result::Result<(), String> {
        Agents::release_actor_session(self, child)
    }
}

/// The production `SessionCloser` (spec 9.15 item 3): closing one actor's session releases its child on the agents.
pub struct AgentSessionCloser<R: ActorSessionRelease> {
    release: Arc<R>,
}

impl<R: ActorSessionRelease> AgentSessionCloser<R> {
    pub fn new(release: Arc<R>) -> Self {
        Self { release }
    }
}

impl<R: ActorSessionRelease> SessionCloser for AgentSessionCloser<R> {
    fn close(&self, session: &str) -> Result<()> {
        self.release
            .release_actor_session(&SessionId::new(session))
            .map_err(|error| anyhow!("the actor's session {session} was not released: {error}"))
    }
}

/// The turn side of a run's actors, with the production closer. The run service passes it to `NodeActorSessions` (spec
/// 9.15 item 3: `MailboxTurns::new` refuses closes, so production always uses this).
pub fn actor_turns<R: ActorSessionRelease>(
    runner: Arc<dyn TurnRunner>,
    mailbox: ActorHandle,
    release: Arc<R>,
) -> MailboxTurns {
    MailboxTurns::with_closer(runner, mailbox, Arc::new(AgentSessionCloser::new(release)))
}

/// What a run's launch registers with the process, and the mailbox its owner serves.
pub struct RunRegistrations<'a> {
    pub residency: &'a SessionResidency,
    pub concurrency: Arc<dyn RunConcurrency>,
    pub mailbox: ActorHandle,
}

/// Node's launch registrations, in the order the spec gives: the residency guard first (9.15 item 2), so a failed attach
/// fails the launch before any run starts; then the governor's bound and listener (9.12 item 3); then the redrive and
/// stall clocks on the production clock (9.14, divergence 30).
pub fn attach_run<J: JournalPort, S: ActorSessions>(
    owner: &mut ActorDriverOwner<J, S>,
    registrations: RunRegistrations<'_>,
) -> Result<()> {
    let RunRegistrations {
        residency,
        concurrency,
        mailbox,
    } = registrations;
    owner.attach_residency(residency, Arc::new(MailboxRun::new(mailbox.clone())))?;
    owner.attach_concurrency(concurrency, mailbox.clone());
    owner.attach_redrive(mailbox, Arc::new(ThreadClock));
    Ok(())
}

/// The turn side's feed of one actor session (spec 9.12 item 2, 9.14 divergences 36 and 39). The turn side calls it with
/// the session's model notices and tool starts, and each observation is posted to the owner's mailbox. The posts do not
/// wait, so the caller never blocks on the owner.
pub struct AskObserver {
    feed: AskFeed,
    mailbox: ActorHandle,
    session: String,
}

impl AskObserver {
    pub fn new(mailbox: ActorHandle, session: &str) -> Self {
        Self {
            feed: AskFeed::new(),
            mailbox,
            session: session.to_owned(),
        }
    }

    /// A new ask on the session: the previous ask's wait state is forgotten.
    pub fn reset(&mut self) {
        self.feed.reset();
    }

    /// The ask's next request waits for a slot in the governor's queue.
    pub fn waiting_for_slot(&mut self) {
        if let Some(event) = self.feed.waiting(AskWait::slot()) {
            self.post(event);
        }
    }

    /// One notice of the session's model stream (a retry, a stall, or a resume).
    pub fn notice(&mut self, notice: &ModelNotice) {
        for event in self.feed.notice(notice) {
            self.post(event);
        }
    }

    /// A model request of the actor completed (the stall clock resets).
    pub fn request_completed(&self) {
        self.post(FeedEvent::RequestCompleted);
    }

    /// The ask's latest tool started.
    pub fn tool_started(&self, name: &str, target: Option<&str>) {
        self.post(FeedEvent::LastTool(LastTool {
            name: name.to_owned(),
            target: target.map(str::to_owned),
        }));
    }

    fn post(&self, event: FeedEvent) {
        // The owner is gone only once the run has settled, and an observation then has nothing to report to.
        let _ = self.mailbox.feed(&self.session, event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_cli_kernel_api::model::ModelError;
    use rust_cli_workflow::actor_mailbox::ActorMailbox;
    use rust_cli_workflow::actor_sessions::ActorTurns;
    use rust_cli_workflow::actor_turns::TurnInput;
    use rust_cli_workflow::driver_owner::ActorSessionRequest;
    use rust_cli_workflow::engine::{AskMessage, AskStats, EngineConfig};
    use rust_cli_workflow::journal::MemoryJournal;
    use rust_cli_workflow::model::Ref;
    use rust_cli_workflow::run_concurrency::ConcurrencyListener;
    use serde_json::json;
    use std::sync::Mutex;

    /// Records the release calls, and answers with `answer` for each.
    #[derive(Default)]
    struct FakeRelease {
        released: Mutex<Vec<String>>,
        answer: Mutex<Option<String>>,
    }

    impl ActorSessionRelease for FakeRelease {
        fn release_actor_session(&self, child: &SessionId) -> std::result::Result<(), String> {
            self.released
                .lock()
                .expect("released")
                .push(child.as_str().to_owned());
            match self.answer.lock().expect("answer").clone() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
    }

    /// The owner's turn side. Every turn it is asked to start is recorded, and the turn itself is left running.
    #[derive(Default)]
    struct FakeSessions {
        started: Arc<Mutex<Vec<Ref>>>,
    }

    impl ActorSessions for FakeSessions {
        fn create_session(&mut self, _request: &ActorSessionRequest) -> Result<String> {
            Ok("sess_1".to_owned())
        }
        fn start_turn(
            &mut self,
            _session: &str,
            instance: &Ref,
            _message: &AskMessage,
            _input: &TurnInput,
            _interaction: &str,
        ) -> Result<()> {
            self.started.lock().expect("started").push(instance.clone());
            Ok(())
        }
        fn cancel_turn(&mut self, _session: &str, _instance: &Ref) -> Result<()> {
            Ok(())
        }
        fn reject_parked(&mut self, _session: &str, _qid: &str) -> Result<()> {
            Ok(())
        }
        fn deliver_answer(&mut self, _session: &str, _qid: &str, _answer: &str) -> Result<()> {
            Ok(())
        }
        fn close_session(&mut self, _session: &str) -> Result<()> {
            Ok(())
        }
    }

    /// Records each governor call a run makes.
    #[derive(Default)]
    struct FakeConcurrency {
        bounds: Mutex<Vec<(String, u64)>>,
        cleared: Mutex<Vec<String>>,
    }

    impl RunConcurrency for FakeConcurrency {
        fn set_run_bound(&self, run_id: &str, bound: u64) {
            self.bounds
                .lock()
                .expect("bounds")
                .push((run_id.to_owned(), bound));
        }
        fn clear_run_bound(&self, run_id: &str) {
            self.cleared
                .lock()
                .expect("cleared")
                .push(run_id.to_owned());
        }
        fn subscribe(
            &self,
            _run_id: &str,
            _listener: ConcurrencyListener,
        ) -> Box<dyn FnOnce() + Send> {
            Box::new(|| {})
        }
    }

    fn config(parent: Option<&str>) -> EngineConfig {
        let mut config = EngineConfig {
            run_id: "wf_run".to_owned(),
            parent_session_id: parent.map(str::to_owned),
            ..Default::default()
        };
        config.caps.max_concurrency = 4.0;
        config.ask_specs.insert(
            "plain".into(),
            rust_cli_workflow::engine::AskSpec {
                typed: false,
                schema: None,
            },
        );
        config
    }

    /// Spec 9.15 item 3: the session closer releases the child through the agents, and a refusal keeps its cause.
    #[test]
    fn the_closer_releases_the_child_and_keeps_a_refusal() {
        let release = Arc::new(FakeRelease::default());
        let closer = AgentSessionCloser::new(release.clone());
        closer.close("sess_1").expect("released");
        assert_eq!(*release.released.lock().expect("released"), ["sess_1"]);

        *release.answer.lock().expect("answer") = Some("still running".to_owned());
        let error = closer.close("sess_2").expect_err("refused");
        assert!(error.to_string().contains("still running"), "{error:#}");
        assert!(error.to_string().contains("sess_2"), "{error:#}");
    }

    /// The turn side built by `actor_turns` closes an idle session through the production closer, not the refusing
    /// `NoCloser` of `MailboxTurns::new`.
    #[test]
    fn the_turn_side_closes_an_idle_session_through_the_agents() {
        struct NoRunner;
        impl TurnRunner for NoRunner {
            fn run_turn(
                &self,
                _session: &str,
                _interaction: &str,
                _turn: &TurnInput,
                _cancel: &std::sync::atomic::AtomicBool,
            ) -> std::result::Result<String, rust_cli_workflow::model_failure::TurnFailure>
            {
                Ok(String::new())
            }
        }
        let (_mailbox, handle) = ActorMailbox::new();
        let release = Arc::new(FakeRelease::default());
        let mut turns = actor_turns(Arc::new(NoRunner), handle, release.clone());
        turns.close_session("sess_9").expect("closed");
        assert_eq!(*release.released.lock().expect("released"), ["sess_9"]);
    }

    /// Spec 9.12 item 3 and 9.15 item 2: a run with a parent attaches its residency, governor bound and clock, and its
    /// settlement releases the governor bound and the parent's guard.
    #[test]
    fn a_run_is_registered_on_launch_and_released_at_settlement() {
        let residency = SessionResidency::new();
        let concurrency = Arc::new(FakeConcurrency::default());
        let (_mailbox, handle) = ActorMailbox::new();
        let mut owner = ActorDriverOwner::new(
            config(Some("ses_parent")),
            MemoryJournal::new(),
            FakeSessions::default(),
        )
        .expect("owner");
        attach_run(
            &mut owner,
            RunRegistrations {
                residency: &residency,
                concurrency: concurrency.clone(),
                mailbox: handle,
            },
        )
        .expect("launch");
        assert_eq!(
            *concurrency.bounds.lock().expect("bounds"),
            [("wf_run".to_owned(), 4)],
            "the run binds its cap"
        );
        owner.complete(json!("done")).expect("settles");
        assert_eq!(*concurrency.cleared.lock().expect("cleared"), ["wf_run"]);
        residency
            .close("ses_parent")
            .expect("the settled run holds no guard, so the close returns at once");
    }

    /// Spec 9.15 item 2: a run with no parent session cannot be made resident, so its launch fails before anything is
    /// bound.
    #[test]
    fn a_run_without_a_parent_session_fails_its_launch_before_binding() {
        let residency = SessionResidency::new();
        let concurrency = Arc::new(FakeConcurrency::default());
        let (_mailbox, handle) = ActorMailbox::new();
        let mut owner =
            ActorDriverOwner::new(config(None), MemoryJournal::new(), FakeSessions::default())
                .expect("owner");
        let error = attach_run(
            &mut owner,
            RunRegistrations {
                residency: &residency,
                concurrency: concurrency.clone(),
                mailbox: handle,
            },
        )
        .expect_err("the launch is refused");
        assert!(error.to_string().contains("parent session"), "{error:#}");
        assert!(concurrency.bounds.lock().expect("bounds").is_empty());
    }

    /// The observer posts the feed the owner routes: a retry notice reaches the owner as a feed, and the owner serves it.
    #[test]
    fn the_observer_feeds_the_live_ask_in_the_order_it_reports() {
        let (mailbox, handle) = ActorMailbox::new();
        let sessions = FakeSessions::default();
        let started = sessions.started.clone();
        let mut owner =
            ActorDriverOwner::new(config(Some("ses_parent")), MemoryJournal::new(), sessions)
                .expect("owner");
        let actor = owner
            .create_actor("plain", Some("worker"), None)
            .expect("actor");
        owner.ask("plain", &actor, "go").expect("ask");
        owner.drain().expect("drain");
        let session = owner.session_of(&actor).expect("the ask's session");
        let instance = started.lock().expect("started")[0].clone();
        let mut observer = AskObserver::new(handle, &session);
        // One retry notice is two requests (its retry, then its wait); the tool start is a third.
        observer.notice(&ModelNotice::Retrying {
            attempt: 1,
            max_retries: 3,
            delay_ms: 1_000,
            error: ModelError::Overloaded {
                message: "busy".to_owned(),
            },
        });
        observer.tool_started("Read", Some("a.rs"));
        for _ in 0..3 {
            mailbox
                .serve_next(&mut owner)
                .expect("a queued feed is served");
        }
        owner
            .ask_stats(
                &instance,
                AskStats {
                    tokens: 1.0,
                    tool_calls: 1.0,
                    turns: 1.0,
                    world_tool_calls: None,
                },
            )
            .expect("stats");
        let payloads: Vec<String> = owner
            .events()
            .expect("events")
            .into_iter()
            .map(|event| event.payload_json)
            .collect();
        let waiting = payloads
            .iter()
            .position(|payload| payload.contains("\"node-waiting\""))
            .expect("the retry's wait is journaled");
        let progress = payloads
            .iter()
            .position(|payload| payload.contains("\"node-progress\""))
            .expect("the resolved turn is journaled");
        assert!(waiting < progress, "the feed is served in order");
        assert!(
            payloads[progress].contains("Read"),
            "the tool fed last is the progress's last tool: {}",
            payloads[progress]
        );
    }
}
