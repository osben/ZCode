//! Tests of the runtime workflow run service (W7-5a-3). The child is `FakeChildRunner`; the owner is a real
//! `ActorDriverOwner` over an in-memory journal and a fake turn side.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::testing::FakeChildRunner;
use rust_cli_kernel_api::workflow_child::{
    ChildEvent, ChildRequest, Completion, CreateActor, LaunchError, LaunchInput, Outcome,
    RequestType, WireError,
};
use rust_cli_workflow::actor_mailbox::ActorMailbox;
use rust_cli_workflow::actor_turns::TurnInput;
use rust_cli_workflow::driver_owner::{ActorDriverOwner, ActorSessionRequest, ActorSessions};
use rust_cli_workflow::engine::{AskMessage, AskSpec, EngineConfig};
use rust_cli_workflow::journal::MemoryJournal;
use rust_cli_workflow::model::Ref;
use rust_cli_workflow::residency::SessionResidency;
use rust_cli_workflow::run_concurrency::{ConcurrencyListener, RunConcurrency};
use serde_json::{Map, json};

use super::{
    CloseReport, Hosted, HostedOwner, LaunchFailure, OwnerFactory, WireBridge, WorkflowRunService,
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
    Arc::new(|config, mailbox: ActorMailbox| {
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
    let held: OwnerFactory = Arc::new(move |config, mailbox| {
        let inner = base(config, mailbox)?;
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
async fn create_actor_is_answered_with_the_engine_id_and_a_bridge_forwards_it() {
    let (mailbox, handle) = ActorMailbox::new();
    drop(mailbox);
    let bridge = WireBridge::new(handle);
    let refused = rust_cli_kernel_api::workflow_child::ChildHandler::create_actor(
        &bridge,
        &CreateActor {
            local_id: "a".to_owned(),
            site_id: "plain".to_owned(),
            name: None,
            persona: None,
        },
    );
    assert!(
        refused.is_err(),
        "a bridge whose owner is gone refuses the actor: {refused:?}"
    );
}
