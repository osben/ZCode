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
