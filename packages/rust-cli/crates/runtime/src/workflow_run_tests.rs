//! Tests of the runtime workflow run service (W7-5a-3). The child is `FakeChildRunner`; the owner is a real
//! `ActorDriverOwner` over an in-memory journal and a fake turn side.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::testing::FakeChildRunner;
use rust_cli_kernel_api::workflow_child::{
    ChildEvent, ChildHandler, ChildRequest, Completion, CreateActor, LaunchError, LaunchInput,
    Outcome, RequestType, WireError, WorkflowChildRunner,
};
use rust_cli_workflow::actor_mailbox::ActorMailbox;
use rust_cli_workflow::actor_turns::TurnInput;
use rust_cli_workflow::driver_owner::{ActorDriverOwner, ActorSessionRequest, ActorSessions};
use rust_cli_workflow::engine::{AskMessage, AskSpec, EngineConfig, RunSettlement};
use rust_cli_workflow::journal::MemoryJournal;
use rust_cli_workflow::model::Ref;
use rust_cli_workflow::residency::SessionResidency;
use rust_cli_workflow::run_concurrency::{ConcurrencyListener, RunConcurrency};
use serde_json::{Map, json};

use super::{
    CloseReport, FAILURE_BUFFER_LIMIT, Hosted, HostedOwner, LaunchFailure, OwnerFactory,
    WireBridge, WorkflowRunService, buffer_failures,
};
use crate::workflow_assembly::RunRegistrations;

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
    fn subscribe(&self, _run_id: &str, _listener: ConcurrencyListener) -> Box<dyn FnOnce() + Send> {
        Box::new(|| {})
    }
}

/// The turn side the owner needs. Sessions are created on demand; turns are left running.
#[derive(Default)]
struct FakeSessions;

impl ActorSessions for FakeSessions {
    fn create_session(&mut self, _request: &ActorSessionRequest) -> Result<String> {
        Ok("sess_1".to_owned())
    }
    fn start_turn(
        &mut self,
        _session: &str,
        _instance: &Ref,
        _message: &AskMessage,
        _input: &TurnInput,
        _interaction: &str,
    ) -> Result<()> {
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

/// A test owner that serves its run normally, but holds its thread until `release` is dropped, so the run never
/// settles while the test closes the service. Its attach is the real one, so it holds the residency guard.
struct HeldOwner {
    inner: Box<dyn HostedOwner>,
    release: std::sync::mpsc::Receiver<()>,
}

impl HostedOwner for HeldOwner {
    fn attach(&mut self, registrations: RunRegistrations<'_>) -> Result<()> {
        self.inner.attach(registrations)
    }
    fn serve(self: Box<Self>) -> Vec<(String, String)> {
        let HeldOwner { inner, release } = *self;
        let _ = release.recv();
        inner.serve()
    }
}

fn config(run_id: &str, parent: Option<&str>) -> EngineConfig {
    let mut config = EngineConfig {
        run_id: run_id.to_owned(),
        parent_session_id: parent.map(str::to_owned),
        ..Default::default()
    };
    config.caps.max_concurrency = 4.0;
    config.ask_specs.insert(
        "plain".into(),
        AskSpec {
            typed: false,
            schema: None,
        },
    );
    config
}

fn input(run_id: &str) -> LaunchInput {
    LaunchInput {
        script_text: "return 1".to_owned(),
        run_id: run_id.to_owned(),
        args: Some(Map::new()),
        resumed_from: None,
        cwd: std::path::PathBuf::from("project"),
    }
}

fn plain_factory() -> OwnerFactory {
    Arc::new(|config, mailbox: ActorMailbox, _handle| {
        let owner = ActorDriverOwner::new(config, MemoryJournal::new(), FakeSessions)?;
        Ok(Box::new(Hosted::new(owner, mailbox)) as Box<dyn HostedOwner>)
    })
}

struct Harness {
    service: WorkflowRunService,
    runner: Arc<FakeChildRunner>,
    concurrency: Arc<FakeConcurrency>,
    residency: Arc<SessionResidency>,
}

fn harness_with(owners: OwnerFactory, residency: SessionResidency) -> Harness {
    let runner = Arc::new(FakeChildRunner::new());
    let concurrency = Arc::new(FakeConcurrency::default());
    let residency = Arc::new(residency);
    let service = WorkflowRunService::new(
        residency.clone(),
        concurrency.clone(),
        runner.clone(),
        owners,
    );
    Harness {
        service,
        runner,
        concurrency,
        residency,
    }
}

fn harness() -> Harness {
    harness_with(plain_factory(), SessionResidency::new())
}

/// Polls until `done` holds, or fails the test after five seconds. It yields, so the run's spawned tasks can progress on
/// the test's single-threaded runtime.
async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn completed(value: serde_json::Value) -> Outcome {
    Outcome::Completed(Completion {
        ok: true,
        value: Some(value),
        error: None,
    })
}

#[tokio::test]
async fn a_launched_run_holds_its_guard_and_bound_until_its_child_completes() {
    let h = harness();
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    assert_eq!(h.runner.launches().len(), 1, "the child started once");
    assert_eq!(
        *h.concurrency.bounds.lock_unpoisoned(),
        [("wf_1".to_owned(), 4)],
        "the run binds its cap at launch"
    );
    assert_eq!(h.residency.live_runs("ses_p"), 1, "the run is resident");

    h.runner.finish(0, completed(json!("done")));

    wait_until("the run to settle", || h.residency.live_runs("ses_p") == 0).await;
    wait_until("the run's entry to be collected", || {
        h.service.run_count() == 0
    })
    .await;
    assert_eq!(*h.concurrency.cleared.lock_unpoisoned(), ["wf_1"]);
}

#[tokio::test]
async fn a_rejected_script_starts_no_child_and_leaves_nothing_behind() {
    let h = harness();
    h.runner.refuse_next(LaunchError::Rejected {
        diagnostics: Vec::new(),
        message: None,
    });
    let error = h
        .service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect_err("refused");
    assert!(
        matches!(&error, LaunchFailure::Child(inner) if matches!(**inner, LaunchError::Rejected { .. })),
        "{error}"
    );
    assert_eq!(h.residency.live_runs("ses_p"), 0, "no guard is held");
    assert!(h.concurrency.bounds.lock_unpoisoned().is_empty());
    assert_eq!(h.service.run_count(), 0, "no map entry");
    assert!(h.runner.launches().is_empty(), "no child was started");
}

#[tokio::test]
async fn a_run_without_a_parent_session_is_refused_before_anything_starts() {
    let h = harness();
    let error = h
        .service
        .launch(input("wf_1"), config("wf_1", None))
        .await
        .expect_err("refused");
    assert!(matches!(error, LaunchFailure::NoParentSession), "{error}");
    assert!(h.runner.launches().is_empty(), "no child was started");
    assert!(h.concurrency.bounds.lock_unpoisoned().is_empty());
    assert_eq!(h.service.run_count(), 0);
}

#[tokio::test]
async fn a_residency_refusal_stops_the_child_it_started_and_keeps_no_entry() {
    // A retired session refuses guards: close the parent first, so the attach is refused.
    let h = harness();
    h.residency.close("ses_p").expect("the idle session closes");
    let error = h
        .service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect_err("refused");
    assert!(matches!(error, LaunchFailure::Attach(_)), "{error}");
    assert_eq!(h.service.run_count(), 0, "no map entry");
    assert!(h.concurrency.bounds.lock_unpoisoned().is_empty());
    assert_eq!(
        h.runner.launches().len(),
        1,
        "the child started before the refusal"
    );
    wait_until("the refused child to be stopped", || {
        h.runner.stop_requested(0)
    })
    .await;
}

#[tokio::test]
async fn a_closed_service_refuses_a_launch_and_starts_nothing() {
    let h = harness();
    h.service.close().await;
    let error = h
        .service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect_err("refused");
    assert!(matches!(error, LaunchFailure::Closed), "{error}");
    assert!(h.runner.launches().is_empty());
}

#[tokio::test]
async fn a_duplicate_live_run_id_is_refused() {
    let h = harness();
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    let error = h
        .service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect_err("refused");
    assert!(matches!(error, LaunchFailure::Duplicate(_)), "{error}");
    assert_eq!(h.runner.launches().len(), 1);
}

#[tokio::test]
async fn close_stops_a_live_run_as_interrupted_and_waits_for_its_guard() {
    let h = harness();
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    let report = h.service.close().await;
    assert_eq!(
        report,
        CloseReport {
            stopped: 1,
            stuck: Vec::new(),
            close_failures: Vec::new(),
        }
    );
    assert!(h.runner.stop_requested(0), "the child was stopped");
    assert_eq!(h.residency.live_runs("ses_p"), 0, "the guard is released");
    assert_eq!(*h.concurrency.cleared.lock_unpoisoned(), ["wf_1"]);
    assert_eq!(h.service.run_count(), 0);
}

#[tokio::test]
async fn close_reports_a_run_whose_residency_does_not_close_in_time_as_stuck() {
    // The owner's thread holds until this sender is dropped at the end of the test, so the run never settles.
    let (_hold, release) = std::sync::mpsc::channel::<()>();
    let slot = Arc::new(Mutex::new(Some(release)));
    let base = plain_factory();
    let held: OwnerFactory = Arc::new(move |config, mailbox, handle| {
        let inner = base(config, mailbox, handle)?;
        let release = slot.lock_unpoisoned().take().expect("one launch");
        Ok(Box::new(HeldOwner { inner, release }) as Box<dyn HostedOwner>)
    });
    let h = harness_with(
        held,
        SessionResidency::with_close_wait(Duration::from_millis(50)),
    );
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    let report = h.service.close().await;
    assert_eq!(report.stuck, ["wf_1"], "the held run is stuck: {report:?}");
    assert!(h.runner.stop_requested(0), "the child was still stopped");
}

#[tokio::test]
async fn a_child_log_and_phase_do_not_wedge_the_owner_and_the_run_still_completes() {
    let h = harness();
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    let handler = h.runner.launches()[0].handler.clone();
    handler.event(ChildEvent::Log {
        message: "hello".to_owned(),
    });
    handler.event(ChildEvent::PhaseEntered {
        name: "first".to_owned(),
    });
    h.runner.finish(0, completed(json!(1)));
    wait_until("the run to settle", || h.residency.live_runs("ses_p") == 0).await;
}

#[tokio::test]
async fn a_child_error_fails_the_run_and_releases_it() {
    let h = harness();
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    h.runner.finish(
        0,
        Outcome::Completed(Completion {
            ok: false,
            value: None,
            error: Some(WireError {
                name: "Error".to_owned(),
                message: "the script threw".to_owned(),
                code: None,
                violations: None,
                final_text: None,
                stack: None,
            }),
        }),
    );
    wait_until("the failed run to settle", || {
        h.residency.live_runs("ses_p") == 0
    })
    .await;
    assert_eq!(*h.concurrency.cleared.lock_unpoisoned(), ["wf_1"]);
}

#[tokio::test]
async fn an_ask_for_an_unknown_actor_is_answered_with_the_engines_error() {
    let h = harness();
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    let handler = h.runner.launches()[0].handler.clone();
    let request = ChildRequest {
        id: "r1".to_owned(),
        request_type: RequestType::Ask,
        site_id: "plain".to_owned(),
        actor: Some("nope".to_owned()),
        instructions: Some("go".to_owned()),
        name: None,
        prompt: None,
        op: None,
        artifact_op: None,
        args: None,
    };
    let answer = handler
        .request(request, Some("wf_1:plain#1".to_owned()))
        .await;
    let error = answer.expect_err("the ask is refused");
    assert_eq!(error.name, "UnknownActor", "{error:?}");
    assert_eq!(error.code.as_deref(), Some("UnknownActor"));
}

#[tokio::test]
async fn create_actor_refuses_an_actor_when_the_owner_is_gone() {
    let (mailbox, handle) = ActorMailbox::new();
    drop(mailbox);
    let bridge = WireBridge::new(handle);
    let refused = bridge
        .create_actor(&CreateActor {
            local_id: "a".to_owned(),
            site_id: "plain".to_owned(),
            name: None,
            persona: None,
        })
        .await;
    assert!(
        refused.is_err(),
        "a bridge whose owner is gone refuses the actor: {refused:?}"
    );
}

#[tokio::test]
async fn create_actor_through_a_launched_run_returns_the_engine_id() {
    let h = harness();
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    let handler = h.runner.launches()[0].handler.clone();
    let id = handler
        .create_actor(&CreateActor {
            local_id: "a".to_owned(),
            site_id: "plain".to_owned(),
            name: Some("worker".to_owned()),
            persona: None,
        })
        .await
        .expect("the engine creates the actor");
    assert!(!id.is_empty(), "the engine returns the actor's id");
}

#[test]
fn a_launch_failure_is_a_std_error_that_reads_as_its_text() {
    let error: Box<dyn std::error::Error> = Box::new(LaunchFailure::Closed);
    assert!(error.to_string().contains("closed"), "{error}");
}

/// Runs `f` on its own thread and waits up to five seconds. `None` means it did not finish in time (a deadlock or a
/// blocked caller) or panicked. The body builds whatever runtime it needs.
fn within_secs<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(f());
    });
    receiver.recv_timeout(Duration::from_secs(5)).ok()
}

fn current_thread() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime")
}

#[tokio::test]
async fn a_run_that_settles_engine_side_stops_its_child_and_frees_its_id() {
    // A residency close stops the live run through its owner, so the run settles without the child's outcome.
    let h = harness();
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    h.residency
        .close("ses_p")
        .expect("the run is stopped and its guard released");
    wait_until("the child to be stopped", || h.runner.stop_requested(0)).await;
    wait_until("the run's entry to be collected", || {
        h.service.run_count() == 0
    })
    .await;
    h.residency.reopen("ses_p");
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("the id is free again");
    assert_eq!(h.runner.launches().len(), 2);
}

#[test]
fn the_owner_factory_may_read_the_service_without_deadlock() {
    let outcome = within_secs(|| {
        let slot: Arc<Mutex<Option<WorkflowRunService>>> = Arc::new(Mutex::new(None));
        let read = slot.clone();
        let base = plain_factory();
        let factory: OwnerFactory = Arc::new(move |config, mailbox, handle| {
            if let Some(service) = read.lock_unpoisoned().clone() {
                let _ = service.run_count();
            }
            base(config, mailbox, handle)
        });
        let runner = Arc::new(FakeChildRunner::new());
        let service = WorkflowRunService::new(
            Arc::new(SessionResidency::new()),
            Arc::new(FakeConcurrency::default()),
            runner,
            factory,
        );
        *slot.lock_unpoisoned() = Some(service.clone());
        current_thread().block_on(service.launch(input("wf_1"), config("wf_1", Some("ses_p"))))
    });
    let launched = outcome.expect("the launch returned: the factory did not deadlock");
    assert!(launched.is_ok(), "{launched:?}");
}

#[test]
fn a_declare_artifact_event_does_not_block_the_host_reader() {
    let returned = within_secs(|| {
        let runtime = current_thread();
        runtime.block_on(async {
            // The owner is never served here, so any blocking call the event makes would never return.
            let (mailbox, handle) = ActorMailbox::new();
            let bridge = WireBridge::new(handle);
            bridge.event(ChildEvent::DeclareArtifact {
                site_id: "plain".to_owned(),
                op: "publish".to_owned(),
                args: Vec::new(),
            });
            drop(mailbox);
        });
        true
    });
    assert_eq!(returned, Some(true), "the event returned to its caller");
}

#[test]
fn create_actor_does_not_hold_the_runtime_while_the_owner_is_busy() {
    let ticks = within_secs(|| {
        let runtime = current_thread();
        runtime.block_on(async {
            // The owner is never served, so the create waits for it. Other tasks must still run meanwhile.
            let (mailbox, handle) = ActorMailbox::new();
            let bridge = WireBridge::new(handle);
            let actor = CreateActor {
                local_id: "a".to_owned(),
                site_id: "plain".to_owned(),
                name: None,
                persona: None,
            };
            let pending = tokio::spawn(bridge.create_actor(&actor));
            let mut ticks = 0;
            for _ in 0..5 {
                tokio::time::sleep(Duration::from_millis(10)).await;
                ticks += 1;
            }
            let still_waiting = !pending.is_finished();
            drop(mailbox);
            let refused = pending.await.expect("the create task ends");
            (ticks, still_waiting, refused.is_err())
        })
    });
    assert_eq!(
        ticks,
        Some((5, true, true)),
        "other tasks ran while the create waited, and the create was refused once its owner was gone"
    );
}

#[tokio::test]
async fn two_concurrent_launches_of_one_run_id_start_one_child() {
    // The fake's start does not yield, so this wrapper makes the two launches interleave before either starts a child.
    struct Yielding(Arc<FakeChildRunner>);
    #[async_trait::async_trait]
    impl WorkflowChildRunner for Yielding {
        async fn start(
            &self,
            input: LaunchInput,
            handler: Arc<dyn ChildHandler>,
        ) -> Result<rust_cli_kernel_api::workflow_child::RunningChild, LaunchError> {
            tokio::task::yield_now().await;
            self.0.start(input, handler).await
        }
    }
    let runner = Arc::new(FakeChildRunner::new());
    let service = WorkflowRunService::new(
        Arc::new(SessionResidency::new()),
        Arc::new(FakeConcurrency::default()),
        Arc::new(Yielding(runner.clone())),
        plain_factory(),
    );
    let (first, second) = tokio::join!(
        service.launch(input("wf_1"), config("wf_1", Some("ses_p"))),
        service.launch(input("wf_1"), config("wf_1", Some("ses_p"))),
    );
    let outcomes = [first.is_ok(), second.is_ok()];
    assert_eq!(outcomes.iter().filter(|ok| **ok).count(), 1, "{outcomes:?}");
    assert_eq!(runner.launches().len(), 1, "only the winner starts a child");
}

#[test]
fn the_failure_buffer_is_bounded_and_keeps_the_first_failures() {
    let mut buffer = Vec::new();
    let failures: Vec<(String, String)> = (0..100)
        .map(|index| (format!("wf_{index}"), "close failed".to_owned()))
        .collect();
    buffer_failures(&mut buffer, failures);
    assert_eq!(buffer.len(), FAILURE_BUFFER_LIMIT);
    assert_eq!(buffer[0].0, "wf_0");
}

/// An owner whose serve panics once attached, so it holds the run's guard the way a real owner does.
struct PanickingOwner {
    inner: Box<dyn HostedOwner>,
}

impl HostedOwner for PanickingOwner {
    fn attach(&mut self, registrations: RunRegistrations<'_>) -> Result<()> {
        self.inner.attach(registrations)
    }
    fn serve(self: Box<Self>) -> Vec<(String, String)> {
        panic!("the owner exploded")
    }
}

#[tokio::test]
async fn an_owner_that_panics_stops_its_child_frees_its_id_and_is_reported_at_close() {
    let panic_once = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let base = plain_factory();
    let factory: OwnerFactory = Arc::new(move |config, mailbox, handle| {
        let inner = base(config, mailbox, handle)?;
        if panic_once.swap(false, std::sync::atomic::Ordering::SeqCst) {
            Ok(Box::new(PanickingOwner { inner }) as Box<dyn HostedOwner>)
        } else {
            Ok(inner)
        }
    });
    let h = harness_with(factory, SessionResidency::new());
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    wait_until("the panicked run's child to be stopped", || {
        h.runner.stop_requested(0)
    })
    .await;
    wait_until("the panicked run's entry to be collected", || {
        h.service.run_count() == 0
    })
    .await;
    assert_eq!(
        h.residency.live_runs("ses_p"),
        0,
        "the panicked owner's guard is released"
    );
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("the id is free again");
    let report = h.service.close().await;
    assert!(
        report
            .close_failures
            .iter()
            .any(|(_, text)| text.contains("panic")),
        "the panic is reported at close: {report:?}"
    );
}

#[tokio::test]
async fn a_declare_artifact_fails_the_run_before_a_later_complete_can_settle_it() {
    // Each round sends the event, then a complete from another thread. The event is sent before that thread starts, so
    // the owner must see the failure first. The settlement is read after both requests are served.
    for round in 0..200 {
        let (mailbox, handle) = ActorMailbox::new();
        let mut owner = ActorDriverOwner::new(
            config(&format!("wf_{round}"), Some("ses_p")),
            MemoryJournal::new(),
            FakeSessions,
        )
        .expect("owner");
        let bridge = WireBridge::new(handle.clone());
        bridge.event(ChildEvent::DeclareArtifact {
            site_id: "plain".to_owned(),
            op: "publish".to_owned(),
            args: Vec::new(),
        });
        let completer = handle.clone();
        let complete = std::thread::spawn(move || completer.complete(json!("done")));
        mailbox
            .serve_next(&mut owner)
            .expect("the first request is served");
        mailbox
            .serve_next(&mut owner)
            .expect("the second request is served");
        let _ = complete.join();
        assert!(
            matches!(owner.settlement(), Some(RunSettlement::Errored { .. })),
            "round {round}: the run must fail, not complete: {:?}",
            owner.settlement()
        );
    }
}

// 9.31 (W7-5b): progress fan-out and quota auto-resume through the service's hooks.

/// Records each progress call: the parent session, the progress payload and the projection deltas.
#[derive(Default)]
struct RecordingProgress {
    calls: Mutex<Vec<(String, serde_json::Value, Vec<serde_json::Value>)>>,
    /// The thread each record arrived on (finding 8: the backlog is not delivered on the launch task).
    threads: Mutex<Vec<std::thread::ThreadId>>,
}

impl rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort for RecordingProgress {
    fn record(
        &self,
        parent_session_id: &str,
        progress: &serde_json::Value,
        deltas: &[serde_json::Value],
    ) -> Result<(), String> {
        self.threads
            .lock_unpoisoned()
            .push(std::thread::current().id());
        self.calls.lock_unpoisoned().push((
            parent_session_id.to_owned(),
            progress.clone(),
            deltas.to_vec(),
        ));
        Ok(())
    }
}

/// The reference instant of the quota tests (2026-10-15T08:00:00Z, the workflow module's clock).
const NOW: u64 = 1_792_051_200_000;
const MINUTE: u64 = 60_000;
const HOUR: u64 = 60 * MINUTE;

/// A stopped run whose failure names a quota stop with `reset_at`, owned by `parent`.
fn quota_stopped_row(run: &str, parent: &str, reset_at: u64) -> rust_cli_workflow::model::RunRow {
    use rust_cli_workflow::model::{Caps, RunRow, RunStatus, StopReason};
    RunRow {
        run_id: run.to_owned(),
        parent_session_id: Some(parent.to_owned()),
        cwd: None,
        name: None,
        tool_call_id: None,
        script_text: None,
        script_hash: None,
        args: None,
        resumed_from: None,
        caps: Caps::default(),
        spent_tokens: 0.0,
        status: RunStatus::Stopped,
        stop_reason: Some(StopReason::Provider),
        superseded_by: None,
        failure: Some(json!({
            "code": "ProviderStop",
            "providerStop": { "kind": "quota", "reason": "rate_limited", "resetAt": reset_at },
        })),
        result: None,
    }
}

/// The run rows, the reads made, and each read's session. Lists are answered per parent, in row order.
#[derive(Default)]
struct FakeReads {
    rows: Vec<(String, rust_cli_workflow::model::RunRow)>,
    reads: Mutex<Vec<String>>,
}

impl crate::workflow_quota::QuotaRunReads for FakeReads {
    fn get_run(&self, run_id: &str) -> Result<Option<rust_cli_workflow::model::RunRow>, String> {
        self.reads.lock_unpoisoned().push(run_id.to_owned());
        Ok(self
            .rows
            .iter()
            .find(|(_, row)| row.run_id == run_id)
            .map(|(_, row)| row.clone()))
    }

    fn list_session_runs(
        &self,
        parent_session_id: &str,
        limit: usize,
    ) -> Result<Vec<rust_cli_workflow::model::RunRow>, String> {
        Ok(self
            .rows
            .iter()
            .filter(|(parent, _)| parent == parent_session_id)
            .take(limit)
            .map(|(_, row)| row.clone())
            .collect())
    }
}

/// Answers every resume `Resumed`, and records the run ids asked for.
#[derive(Default)]
struct FakeResumer {
    calls: Mutex<Vec<String>>,
}

impl crate::workflow_quota::QuotaRunResumer for FakeResumer {
    fn resume(
        &self,
        run_id: &str,
    ) -> Result<rust_cli_workflow::quota_resume::ResumeAnswer, String> {
        self.calls.lock_unpoisoned().push(run_id.to_owned());
        Ok(rust_cli_workflow::quota_resume::ResumeAnswer::Resumed)
    }
}

/// One armed timer: its delay, and the job the module gave the clock.
type ArmedJob = (u64, Box<dyn FnOnce() + Send>);

/// A clock whose timers wait until the test runs them: `run_next` pops the first armed timer and runs it.
struct FakeClock {
    jobs: Mutex<std::collections::VecDeque<ArmedJob>>,
}

impl FakeClock {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            jobs: Mutex::new(std::collections::VecDeque::new()),
        })
    }

    /// The delays of the timers armed and not yet run, in arming order.
    fn delays(&self) -> Vec<u64> {
        self.jobs
            .lock_unpoisoned()
            .iter()
            .map(|(delay, _)| *delay)
            .collect()
    }

    /// Runs the first armed timer, and returns its delay. The lock is released before the job runs: a job may arm.
    fn run_next(&self) -> Option<u64> {
        let next = self.jobs.lock_unpoisoned().pop_front();
        next.map(|(delay, job)| {
            job();
            delay
        })
    }
}

impl rust_cli_workflow::model_failure::RedriveClock for FakeClock {
    fn after(&self, delay_ms: u64, job: Box<dyn FnOnce() + Send>) -> bool {
        self.jobs.lock_unpoisoned().push_back((delay_ms, job));
        true
    }

    fn random(&self) -> f64 {
        0.5
    }

    fn now_ms(&self) -> u64 {
        NOW
    }
}

#[tokio::test]
async fn a_launched_run_publishes_its_progress_to_its_parent_in_journal_order() {
    let h = harness();
    let progress = Arc::new(RecordingProgress::default());
    h.service.configure_progress(progress.clone(), 4.0);
    h.service
        .launch(input("wf_p"), config("wf_p", Some("ses_p")))
        .await
        .expect("launched");
    h.runner.finish(0, completed(json!("done")));
    wait_until("the run to settle", || h.service.run_count() == 0).await;

    let calls = progress.calls.lock_unpoisoned();
    assert!(!calls.is_empty(), "the run's events reach the sink");
    assert!(calls.iter().all(|(parent, _, _)| parent == "ses_p"));
    // run-started was journaled before the sink attached: the backlog is delivered first, in order.
    assert_eq!(calls[0].1["eventType"], json!("run-started"));
    let sequences: Vec<u64> = calls
        .iter()
        .map(|(_, progress, _)| progress["sequence"].as_u64().unwrap())
        .collect();
    assert!(
        sequences.windows(2).all(|pair| pair[0] < pair[1]),
        "sequences rise: {sequences:?}"
    );
    assert!(
        calls
            .iter()
            .all(|(_, progress, _)| progress["runId"] == json!("wf_p"))
    );
    assert!(calls.iter().any(|(_, _, deltas)| !deltas.is_empty()));
}

#[tokio::test]
async fn open_session_resumes_a_due_quota_stop_and_arms_the_rest() {
    let reads = Arc::new(FakeReads {
        rows: vec![
            (
                "ses_q".into(),
                quota_stopped_row("due", "ses_q", NOW - HOUR),
            ),
            (
                "ses_q".into(),
                quota_stopped_row("later", "ses_q", NOW + 2 * HOUR),
            ),
        ],
        ..Default::default()
    });
    let resumer = Arc::new(FakeResumer::default());
    let clock = FakeClock::new();
    let h = harness();
    h.service
        .configure_quota(reads, resumer.clone(), clock.clone());

    h.service.open_session("ses_q");

    assert_eq!(
        clock.delays(),
        [0, 2 * HOUR + MINUTE],
        "the due stop is armed now, the later one at its reset plus a minute"
    );
    clock.run_next().expect("the due timer");
    assert_eq!(*resumer.calls.lock_unpoisoned(), ["due"]);
}

#[tokio::test]
async fn close_disposes_the_quota_modules_so_no_armed_timer_resumes_a_run() {
    let reads = Arc::new(FakeReads {
        rows: vec![(
            "ses_q".into(),
            quota_stopped_row("due", "ses_q", NOW - HOUR),
        )],
        ..Default::default()
    });
    let resumer = Arc::new(FakeResumer::default());
    let clock = FakeClock::new();
    let h = harness();
    h.service
        .configure_quota(reads, resumer.clone(), clock.clone());
    h.service.open_session("ses_q");
    assert_eq!(clock.delays().len(), 1, "the due stop is armed");

    let report = h.service.close().await;
    assert_eq!(report.stopped, 0);
    clock.run_next();
    assert!(
        resumer.calls.lock_unpoisoned().is_empty(),
        "a timer that fires after close resumes nothing"
    );
}

#[tokio::test]
async fn a_settled_run_reads_its_row_through_its_session_quota_module() {
    let reads = Arc::new(FakeReads::default());
    let h = harness();
    h.service.configure_quota(
        reads.clone(),
        Arc::new(FakeResumer::default()),
        FakeClock::new(),
    );
    h.service
        .launch(input("wf_q"), config("wf_q", Some("ses_q")))
        .await
        .expect("launched");
    h.runner.finish(0, completed(json!("done")));
    wait_until("the settlement to read its row", || {
        reads.reads.lock_unpoisoned().iter().any(|id| id == "wf_q")
    })
    .await;
}

#[tokio::test]
async fn the_unwired_resume_is_refused_once_and_never_retried() {
    use crate::workflow_quota::UnwiredResume;
    let reads = Arc::new(FakeReads {
        rows: vec![(
            "ses_q".into(),
            quota_stopped_row("due", "ses_q", NOW - HOUR),
        )],
        ..Default::default()
    });
    let clock = FakeClock::new();
    let h = harness();
    h.service
        .configure_quota(reads, Arc::new(UnwiredResume), clock.clone());
    h.service.open_session("ses_q");
    clock.run_next().expect("the due timer");
    assert!(
        clock.delays().is_empty(),
        "a refusal that says the run cannot be resumed arms no retry"
    );
}

#[test]
fn the_session_port_reads_and_lists_only_its_own_session() {
    use crate::workflow_quota::SessionQuotaPort;
    use rust_cli_workflow::quota_resume::{QuotaResumePort, Refusal, ResumeAnswer};
    let reads = Arc::new(FakeReads {
        rows: vec![
            ("ses_a".into(), quota_stopped_row("run_a", "ses_a", NOW)),
            ("ses_b".into(), quota_stopped_row("run_b", "ses_b", NOW)),
        ],
        ..Default::default()
    });
    let resumer = Arc::new(FakeResumer::default());
    let port = SessionQuotaPort::new("ses_a".into(), reads, resumer.clone());
    let listed = port.list_session_runs(64).expect("listed");
    assert_eq!(
        listed
            .iter()
            .map(|row| row.run_id.as_str())
            .collect::<Vec<_>>(),
        ["run_a"],
        "the scan sees the session's runs only"
    );
    assert_eq!(
        port.get_run("run_b").expect("read").map(|row| row.run_id),
        None,
        "a row of another session is not read through this port"
    );
    assert_eq!(
        port.get_run("run_a").expect("read").map(|row| row.run_id),
        Some("run_a".to_owned()),
        "the session's own row is read"
    );
    assert_eq!(
        port.resume("run_a").expect("answered"),
        ResumeAnswer::Resumed
    );
    assert_eq!(
        port.resume("run_b").expect("answered"),
        ResumeAnswer::Refused(Refusal::Other("run_not_in_session".to_owned())),
        "a resume for another session's run is refused without reaching the resumer"
    );
    assert_eq!(*resumer.calls.lock_unpoisoned(), ["run_a"]);
}

/// Re-review 2: a parent whose scan found nothing to resume keeps no hooks once the scan is done.
#[tokio::test]
async fn open_session_holds_no_hooks_for_a_parent_with_nothing_to_resume() {
    let h = harness();
    h.service.configure_quota(
        Arc::new(FakeReads::default()),
        Arc::new(FakeResumer::default()),
        FakeClock::new(),
    );
    h.service.open_session("ses_n");
    assert_eq!(
        h.service.session_entries(),
        0,
        "an idle parent after its scan holds no hooks"
    );
}

/// Re-review 2: a session whose timer fired and left the module idle is dropped, without any later settlement.
#[tokio::test]
async fn a_session_whose_timer_has_fired_is_dropped_when_it_goes_idle() {
    let reads = Arc::new(FakeReads {
        rows: vec![(
            "ses_t".into(),
            quota_stopped_row("due", "ses_t", NOW - HOUR),
        )],
        ..Default::default()
    });
    let clock = FakeClock::new();
    let h = harness();
    h.service
        .configure_quota(reads, Arc::new(FakeResumer::default()), clock.clone());
    h.service.open_session("ses_t");
    assert_eq!(
        h.service.session_entries(),
        1,
        "the armed timer keeps the session's hooks"
    );
    clock.run_next().expect("the due timer");
    assert_eq!(
        h.service.session_entries(),
        0,
        "the timer fired and the module went idle, so the session is dropped"
    );
}

/// Re-review 3: a launch with neither progress nor quota configured builds no session hooks.
#[tokio::test]
async fn a_launch_with_no_hooks_configured_holds_no_session_entry() {
    let h = harness();
    h.service
        .launch(input("wf_n"), config("wf_n", Some("ses_n")))
        .await
        .expect("launched");
    assert_eq!(
        h.service.session_entries(),
        0,
        "nothing to install, so no entry"
    );
    h.runner.finish(0, completed(json!("done")));
    wait_until("the run to settle", || h.service.run_count() == 0).await;
}

/// Finding 1: a close that lands between the caller's check and the module's creation leaves no module behind, so a
/// scan after close arms nothing. The hook closes the service on another thread at the racing point.
#[tokio::test]
async fn a_session_open_racing_close_creates_no_quota_module() {
    let reads = Arc::new(FakeReads {
        rows: vec![(
            "ses_r".into(),
            quota_stopped_row("due", "ses_r", NOW - HOUR),
        )],
        ..Default::default()
    });
    let clock = FakeClock::new();
    let h = harness();
    h.service
        .configure_quota(reads, Arc::new(FakeResumer::default()), clock.clone());
    let service = h.service.clone();
    h.service.set_hook_before_quota_module(Box::new(move || {
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("runtime")
                .block_on(service.close());
        })
        .join()
        .expect("close finished");
    }));
    h.service.open_session("ses_r");
    assert!(
        clock.delays().is_empty(),
        "a module created after close would arm the due stop"
    );
}

/// Finding 2: a launch refused after its child started keeps no session hooks.
#[tokio::test]
async fn a_refused_launch_leaves_no_session_hooks_behind() {
    let owners: OwnerFactory = Arc::new(|_, _, _| Err(anyhow::anyhow!("the owner refused")));
    let h = harness_with(owners, SessionResidency::new());
    h.service
        .configure_progress(Arc::new(RecordingProgress::default()), 4.0);
    let launched = h
        .service
        .launch(input("wf_x"), config("wf_x", Some("ses_x")))
        .await;
    assert!(launched.is_err(), "the factory's refusal fails the launch");
    assert_eq!(
        h.service.session_entries(),
        0,
        "a refused launch builds no session hooks"
    );
}

/// Finding 2: a session whose last run settled, with no armed quota timer, is dropped; a later launch rebuilds it.
#[tokio::test]
async fn an_idle_session_is_dropped_when_its_last_run_settles() {
    let h = harness();
    h.service
        .configure_progress(Arc::new(RecordingProgress::default()), 4.0);
    h.service
        .launch(input("wf_e"), config("wf_e", Some("ses_e")))
        .await
        .expect("launched");
    assert_eq!(
        h.service.session_entries(),
        1,
        "the session holds its hooks while its run is live"
    );
    h.runner.finish(0, completed(json!("done")));
    wait_until("the run to settle", || h.service.run_count() == 0).await;
    wait_until("the idle session to be dropped", || {
        h.service.session_entries() == 0
    })
    .await;
}

/// Finding 8: the progress backlog reaches the sink on the owner's thread, not on the launch task.
#[tokio::test]
async fn the_progress_backlog_is_delivered_on_the_owner_thread_not_the_launch_task() {
    let h = harness();
    let progress = Arc::new(RecordingProgress::default());
    h.service.configure_progress(progress.clone(), 4.0);
    let launcher = std::thread::current().id();
    h.service
        .launch(input("wf_t"), config("wf_t", Some("ses_t")))
        .await
        .expect("launched");
    wait_until("the backlog to be delivered", || {
        !progress.threads.lock_unpoisoned().is_empty()
    })
    .await;
    assert!(
        progress
            .threads
            .lock_unpoisoned()
            .iter()
            .all(|thread| *thread != launcher),
        "no progress is delivered on the launching task"
    );
    h.runner.finish(0, completed(json!("done")));
    wait_until("the run to settle", || h.service.run_count() == 0).await;
}

/// Finding 5: a second sink on one owner does not replay the backlog (the first sink has it already).
#[test]
fn a_second_progress_sink_does_not_replay_the_backlog() {
    use rust_cli_workflow::model::StoredEvent;
    use rust_cli_workflow::run_progress::RunProgress;
    struct Collect(Arc<Mutex<Vec<u64>>>);
    impl RunProgress for Collect {
        fn progress(&mut self, stored: &StoredEvent) {
            self.0.lock_unpoisoned().push(stored.sequence);
        }
    }
    let mut owner =
        ActorDriverOwner::new(config("wf_once", None), MemoryJournal::new(), FakeSessions)
            .expect("owner");
    let first = Arc::new(Mutex::new(Vec::new()));
    owner.set_progress(Box::new(Collect(first.clone())));
    assert!(
        !first.lock_unpoisoned().is_empty(),
        "the backlog reaches the first sink"
    );
    let second = Arc::new(Mutex::new(Vec::new()));
    owner.set_progress(Box::new(Collect(second.clone())));
    assert!(
        second.lock_unpoisoned().is_empty(),
        "a second sink gets no replay"
    );
}

/// Review of #586 (ocr, finding 1): the owner factory runs on the blocking pool. A slow factory (a migration check that
/// waits on a busy database) must not hold the executor: a task ticking on the same current-thread runtime keeps running
/// while the factory blocks.
#[tokio::test]
async fn a_slow_owner_factory_does_not_stall_the_executor() {
    use std::sync::atomic::{AtomicU64, Ordering};
    let ticks = Arc::new(AtomicU64::new(0));
    let observed = Arc::new(AtomicU64::new(0));
    let factory_ticks = ticks.clone();
    let factory_observed = observed.clone();
    let base = plain_factory();
    let factory: OwnerFactory = Arc::new(move |config, mailbox, handle| {
        let before = factory_ticks.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(300));
        let after = factory_ticks.load(Ordering::SeqCst);
        factory_observed.store(after - before, Ordering::SeqCst);
        base(config, mailbox, handle)
    });
    let h = harness_with(factory, SessionResidency::new());
    let ticker_ticks = ticks.clone();
    let ticker = tokio::spawn(async move {
        loop {
            ticker_ticks.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    h.service
        .launch(input("wf_slow"), config("wf_slow", Some("ses_p")))
        .await
        .expect("launched");
    ticker.abort();
    let during = observed.load(Ordering::SeqCst);
    assert!(
        during >= 5,
        "the executor ticked {during} times while the factory blocked; it must keep running"
    );
}

/// 9.40: an answer for a question that no live run of the session holds is refused as `unknown_question`. The live run
/// of the session is asked (its owner answers `None`); another session has no live run to ask.
#[tokio::test]
async fn resolve_question_is_refused_as_unknown_when_no_live_run_of_the_session_holds_it() {
    use rust_cli_kernel_api::ids::{QuestionId, SessionId};
    use rust_cli_kernel_api::workflow_run::{
        DynamicWorkflowRunSessions, ResolveQuestionRefusalReason, ResolveQuestionResult,
    };
    let h = harness();
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    let qid = QuestionId::new("dwfq-wf_1-0");
    let own = h
        .service
        .for_session(&SessionId::new("ses_p"))
        .resolve_question(&qid, "use staging")
        .await
        .expect("answered");
    assert!(
        matches!(
            own,
            ResolveQuestionResult::Refused {
                reason: ResolveQuestionRefusalReason::UnknownQuestion,
                ..
            }
        ),
        "{own:?}"
    );
    let other = h
        .service
        .for_session(&SessionId::new("ses_q"))
        .resolve_question(&qid, "use staging")
        .await
        .expect("answered");
    assert!(
        matches!(other, ResolveQuestionResult::Refused { .. }),
        "{other:?}"
    );
    h.runner.finish(0, completed(json!("done")));
    wait_until("the run to settle", || h.residency.live_runs("ses_p") == 0).await;
}

#[tokio::test]
async fn a_live_run_is_listed_under_its_own_parent_and_its_snapshot_reads_from_memory() {
    // Fork (W7-11, 9.44): the reminder's reads. Only a parent's own live runs are listed, and a run's snapshot is its
    // parent's projection entry, present once the progress port is configured.
    let h = harness();
    h.service
        .configure_progress(Arc::new(RecordingProgress::default()), 4.0);
    h.service
        .launch(input("wf_live"), config("wf_live", Some("ses_p")))
        .await
        .expect("launched");
    assert_eq!(h.service.live_run_ids_of("ses_p"), ["wf_live"]);
    assert!(
        h.service.live_run_ids_of("ses_other").is_empty(),
        "another parent's runs are not listed"
    );
    // The projection entry is written by the progress path after the launch returns, so it is awaited, not read at once.
    wait_until("the run to have a projection entry", || {
        h.service.run_snapshot_of("ses_p", "wf_live").is_some()
    })
    .await;
    let snapshot = h
        .service
        .run_snapshot_of("ses_p", "wf_live")
        .expect("the run has a projection entry");
    assert_eq!(snapshot["runId"], json!("wf_live"));
    assert!(h.service.run_snapshot_of("ses_other", "wf_live").is_none());
    assert!(h.service.run_snapshot_of("ses_p", "wf_missing").is_none());

    h.runner.finish(0, completed(json!("done")));
    wait_until("the run to settle", || h.service.run_count() == 0).await;
    assert!(
        h.service.live_run_ids_of("ses_p").is_empty(),
        "a settled run is no longer live"
    );
}

/// 9.42: a store of settled rows with their timestamps, for the detail read. The other reads are not used here.
#[derive(Default)]
struct DetailStore {
    rows: Vec<(rust_cli_workflow::model::RunRow, i64, i64)>,
    /// The journal's events of each run, in order. The detail read replays them through the real reducer.
    events: Vec<(String, Vec<serde_json::Value>)>,
}

impl rust_cli_workflow::run_store::RunStore for DetailStore {
    fn non_terminal_runs(
        &self,
        _parent: &str,
    ) -> anyhow::Result<Vec<rust_cli_workflow::model::RunRow>> {
        Ok(Vec::new())
    }
    fn interrupt_run(&self, _run_id: &str) -> anyhow::Result<bool> {
        Ok(false)
    }
    fn runs_of_session(
        &self,
        _parent: &str,
        _limit: usize,
    ) -> anyhow::Result<Vec<rust_cli_workflow::run_store::RunListRow>> {
        Ok(Vec::new())
    }
    fn list_runs(
        &self,
        _query: &rust_cli_workflow::run_store::RunListQuery,
    ) -> anyhow::Result<Vec<rust_cli_workflow::run_store::RunListRow>> {
        Ok(Vec::new())
    }
    fn get_run(&self, run_id: &str) -> anyhow::Result<Option<rust_cli_workflow::model::RunRow>> {
        Ok(self
            .rows
            .iter()
            .find(|(row, _, _)| row.run_id == run_id)
            .map(|(row, _, _)| row.clone()))
    }
    fn amend_preflight(
        &self,
        _predecessor_run_id: &str,
    ) -> anyhow::Result<
        Result<rust_cli_workflow::model::RunRow, rust_cli_workflow::import_build::ImportRefusal>,
    > {
        anyhow::bail!("the detail store has no journal to preflight an amendment from")
    }
    fn amend_import(
        &self,
        _predecessor_run_id: &str,
    ) -> anyhow::Result<rust_cli_workflow::import_build::BuildOutcome> {
        anyhow::bail!("the detail store has no journal to import an amended run from")
    }
    fn run_detail(
        &self,
        run_id: &str,
        default_concurrency: Option<f64>,
    ) -> anyhow::Result<Option<rust_cli_workflow::run_store::RunDetail>> {
        let Some((row, created, updated)) =
            self.rows.iter().find(|(row, _, _)| row.run_id == run_id)
        else {
            return Ok(None);
        };
        // The situation snapshot (9.46) of the same events: no node or actor rows, and no clock on the events.
        let stored: Vec<rust_cli_node_store::dwf::StoredEvent> = self
            .events
            .iter()
            .filter(|(id, _)| id == run_id)
            .flat_map(|(_, events)| events.iter().cloned())
            .enumerate()
            .map(|(index, event)| rust_cli_node_store::dwf::StoredEvent {
                sequence: i64::try_from(index + 1).unwrap_or(i64::MAX),
                event,
                time_created: 0,
            })
            .collect();
        // The state is the real reducer's replay of the run's events, as the SQLite store folds them.
        let state = default_concurrency.and_then(|default| {
            let record = rust_cli_node_store::dwf::RunRecord {
                run_id: run_id.to_owned(),
                parent_session_id: row.parent_session_id.clone(),
                ..Default::default()
            };
            rust_cli_node_store::replay_run_state(
                &record,
                &stored,
                default,
                &rust_cli_node_store::WORKFLOW_RUN_LIMITS,
            )?
            .runs
            .into_iter()
            .find(|run| run.get("runId").and_then(serde_json::Value::as_str) == Some(run_id))
        });
        let roster = rust_cli_workflow::run_roster::build_roster(
            &rust_cli_workflow::run_roster::RosterFacts {
                state: state.as_ref(),
                events: &stored,
                nodes: &[],
                actors: &[],
                terminal: matches!(
                    row.status,
                    rust_cli_workflow::model::RunStatus::Completed
                        | rust_cli_workflow::model::RunStatus::Errored
                        | rust_cli_workflow::model::RunStatus::Stopped
                ),
            },
        );
        Ok(Some(rust_cli_workflow::run_store::RunDetail {
            run: rust_cli_workflow::run_store::RunListRow {
                run: row.clone(),
                time_created: *created,
                time_updated: *updated,
            },
            state,
            roster,
        }))
    }
}

fn settled_row(
    run: &str,
    parent: &str,
    status: rust_cli_workflow::model::RunStatus,
) -> rust_cli_workflow::model::RunRow {
    use rust_cli_workflow::model::{Caps, RunRow};
    RunRow {
        run_id: run.to_owned(),
        parent_session_id: Some(parent.to_owned()),
        cwd: Some("project".to_owned()),
        name: Some("nightly".to_owned()),
        tool_call_id: None,
        script_text: Some("return 1".to_owned()),
        script_hash: None,
        args: None,
        resumed_from: None,
        caps: Caps::default(),
        spent_tokens: 42.0,
        status,
        stop_reason: None,
        superseded_by: None,
        failure: None,
        result: Some(json!("done")),
    }
}

/// 9.42: the detail read answers from the journal row with its timestamps and result, for the parent that owns it and
/// for another session (Node reads any journal row). An unknown id is an answer (`None`), not an error.
#[tokio::test]
async fn get_run_detail_reads_the_journal_row_for_the_owner_and_another_session() {
    use rust_cli_kernel_api::ids::{SessionId, WorkflowRunId};
    use rust_cli_kernel_api::workflow_run::DynamicWorkflowRunSessions;
    use rust_cli_workflow::model::RunStatus;
    let h = harness();
    // The run's journal, as the owner writes it: the replay of these events is the projected state the detail reads.
    // One node is waiting, one settled ok, one settled failed; one question is open; one hole is waiting.
    let journal = vec![
        json!({"type": "run-launched", "subagentModel": "m-1"}),
        json!({"type": "node-waiting", "instance": {"siteId": "ask#1", "ordinal": 1}}),
        json!({"type": "node-settled", "instance": {"siteId": "ask#2", "ordinal": 1},
               "outcome": "ok", "cached": false, "sourceSessionId": "sess-x"}),
        json!({"type": "node-settled", "instance": {"siteId": "ask#3", "ordinal": 1},
               "outcome": "failed", "cached": false, "sourceSessionId": "sess-x"}),
        json!({"type": "escalation-raised", "qid": "dwfq-wf_done-0", "question": "which branch?",
               "actor": {"siteId": "agent#1", "ordinal": 1}, "actorName": "poet", "askedAt": 1_500}),
        // The journal does not carry a hole's type (the reducer's `type` is the event's own key, and the compiled script
        // holds the type), so the fixture has none. The detail reports the hole without a type (divergence 437).
        json!({"type": "hole-reached", "instance": {"siteId": "hole#1", "ordinal": 1},
               "name": "gate", "reachedAt": 1_600}),
    ];
    let store = DetailStore {
        events: vec![("wf_done".to_owned(), journal)],
        rows: vec![
            (
                settled_row("wf_done", "ses_p", RunStatus::Completed),
                1_000,
                2_000,
            ),
            (
                settled_row("wf_live", "ses_p", RunStatus::Running),
                3_000,
                4_000,
            ),
        ],
    };
    assert!(h.service.set_store(Arc::new(store)));
    // The replay needs the configured default concurrency (the service's progress port sets it).
    h.service
        .configure_progress(Arc::new(RecordingProgress::default()), 4.0);
    let owner = h.service.for_session(&SessionId::new("ses_p"));
    let detail = owner
        .get_run_detail(&WorkflowRunId::new("wf_done"))
        .await
        .expect("answered")
        .expect("found");
    assert_eq!(detail["runId"], "wf_done");
    assert_eq!(detail["label"], "nightly");
    assert_eq!(detail["labelSource"], "name");
    assert_eq!(detail["status"], "completed");
    assert_eq!(detail["createdAt"], 1_000);
    assert_eq!(detail["updatedAt"], 2_000);
    assert_eq!(detail["ownedByThisSession"], true);
    assert_eq!(detail["usage"]["spentTokens"], 42);
    assert_eq!(detail["result"], "done");
    // 9.42: the journal's projected state gives the pending questions with their ids, the holes, the node counts and the
    // launch settings.
    assert_eq!(detail["pendingQuestions"][0]["qid"], "dwfq-wf_done-0");
    assert_eq!(detail["pendingQuestions"][0]["actor"], "agent#1@1");
    assert_eq!(detail["pendingQuestions"][0]["actorName"], "poet");
    assert_eq!(detail["pendingQuestions"][0]["question"], "which branch?");
    assert_eq!(detail["pendingQuestions"][0]["askedAt"], 1_500);
    assert_eq!(detail["holes"][0]["name"], "gate");
    assert_eq!(detail["holes"][0]["state"], "waiting");
    // The reducer's node entries: a waiting node is running, an ok settle is completed, a failed settle is failed.
    assert_eq!(detail["usage"]["nodesObserved"], 3);
    assert_eq!(detail["usage"]["nodesRunning"], 1);
    assert_eq!(detail["usage"]["nodesCompleted"], 1);
    assert_eq!(detail["usage"]["nodesFailed"], 1);
    // 9.46: the situation snapshot reaches the detail: the parked questions are known (the replay ran), and the log tail
    // of this journal is empty.
    assert_eq!(detail["health"]["pendingQuestionsKnown"], true);
    assert_eq!(detail["logTail"], json!([]));
    // The replay keeps the subagent model on the progress path, not in the run entry, so the detail does not show it yet
    // (divergence 436).
    assert!(detail.get("subagentModel").is_none());
    assert!(detail.get("possiblyInterrupted").is_none());

    let other = h.service.for_session(&SessionId::new("ses_q"));
    let seen = other
        .get_run_detail(&WorkflowRunId::new("wf_live"))
        .await
        .expect("answered")
        .expect("found");
    assert_eq!(seen["ownedByThisSession"], false);
    assert_eq!(
        seen["possiblyInterrupted"], true,
        "a live run another session owns is not confirmed alive"
    );

    assert!(
        owner
            .get_run_detail(&WorkflowRunId::new("wf_missing"))
            .await
            .expect("answered")
            .is_none()
    );
}

/// 9.42: a run this session has launched but whose row is not written yet is reported from its registry entry, as Node's
/// gap form does. A build with no store cannot read the journal, so the detail read is the optional-member fallback.
#[tokio::test]
async fn get_run_detail_reports_a_launched_run_before_its_row_and_refuses_without_a_store() {
    use rust_cli_kernel_api::ids::{SessionId, WorkflowRunId};
    use rust_cli_kernel_api::workflow_run::DynamicWorkflowRunSessions;
    let h = harness();
    let owner = h.service.for_session(&SessionId::new("ses_p"));
    let no_store = owner.get_run_detail(&WorkflowRunId::new("wf_1")).await;
    assert!(
        matches!(&no_store, Err(error) if error.is_unsupported()),
        "{no_store:?}"
    );

    assert!(h.service.set_store(Arc::new(DetailStore::default())));
    h.service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    let gap = owner
        .get_run_detail(&WorkflowRunId::new("wf_1"))
        .await
        .expect("answered")
        .expect("found");
    assert_eq!(gap["status"], "pending");
    assert_eq!(gap["ownedByThisSession"], true);
    h.runner.finish(0, completed(json!("done")));
    wait_until("the run to settle", || h.residency.live_runs("ses_p") == 0).await;
}
