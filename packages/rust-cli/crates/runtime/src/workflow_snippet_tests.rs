//! The snippet service on the Rust engine (specs/fork-rust-workflow-engine.md, 9.28, W7-8c). A fake runner stands in for the
//! helper and the child: the test plays the child by calling the handler the run gave it, then settles the child's outcome.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::workflow_analysis::WorkflowDiagnostic;
use rust_cli_kernel_api::workflow_child::ChildStop;
use rust_cli_kernel_api::workflow_child::{
    ChildEvent, ChildHandler, ChildRequest, Completion, Outcome, RequestType, StopReason, WireError,
};
use rust_cli_kernel_api::workflow_snippet::{
    RunningSnippet, SnippetCheck, SnippetLaunch, SnippetOutcome, SnippetRequest, SnippetStart,
    WorkflowSnippetError, WorkflowSnippetPort, WorkflowSnippetRunner,
};
use rust_cli_workflow::world_read::{GlobHits, GrepHits, RunOutcome, RunRequest, WorldReadPorts};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{ReturnRefusal, SnippetService, return_refusal};

/// The fake world-read port: `read_text` answers "hello"; the other members are not used by these tests.
struct Reads {
    read: Result<String, String>,
    /// How long `read_text` blocks, as a slow world read does (a `run` can take minutes).
    delay: std::time::Duration,
}

impl WorldReadPorts for Reads {
    fn glob(&self, _pattern: &str, _limit: usize) -> Result<GlobHits, String> {
        Err("glob is not used here".to_owned())
    }

    fn read_text(&self, _path: &str) -> Result<String, String> {
        std::thread::sleep(self.delay);
        self.read.clone()
    }

    fn grep(
        &self,
        _pattern: &str,
        _glob: Option<&str>,
        _head_limit: usize,
    ) -> Result<GrepHits, String> {
        Err("grep is not used here".to_owned())
    }

    fn run(&self, _request: &RunRequest) -> Result<RunOutcome, String> {
        Err("run is not used here".to_owned())
    }
}

fn reads() -> Arc<dyn WorldReadPorts> {
    Arc::new(Reads {
        read: Ok("hello".to_owned()),
        delay: std::time::Duration::ZERO,
    })
}

fn slow_reads(delay: std::time::Duration) -> Arc<dyn WorldReadPorts> {
    Arc::new(Reads {
        read: Ok("late".to_owned()),
        delay,
    })
}

enum StartMode {
    Run,
    /// The start never returns (a compile or spawn that hangs).
    Hang,
    /// The start spawns a child (a guard that sets `stopped` when dropped) and then never returns.
    SpawnThenHang(Arc<AtomicBool>),
    Reject(Vec<WorkflowDiagnostic>),
    Fail(String),
}

struct Launch {
    handler: Arc<dyn ChildHandler>,
    finish: Option<oneshot::Sender<Outcome>>,
    stop: CancellationToken,
}

/// The fake runner. In `Run` mode each start records the handler and a child that ends when the test finishes it, or when
/// it is stopped (as the real runner's outcome does).
struct FakeRunner {
    mode: StartMode,
    check: Result<SnippetCheck, WorkflowSnippetError>,
    launch: Mutex<Option<Launch>>,
}

impl FakeRunner {
    fn running() -> Self {
        Self {
            mode: StartMode::Run,
            check: Ok(SnippetCheck::Ready { world_run: false }),
            launch: Mutex::new(None),
        }
    }

    fn with_mode(mode: StartMode) -> Self {
        Self {
            mode,
            ..Self::running()
        }
    }

    /// The handler of the launch, once the service has started the child.
    async fn wait_for_handler(&self) -> Arc<dyn ChildHandler> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(launch) = self.launch.lock().unwrap().as_ref() {
                return launch.handler.clone();
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the service did not start a child within 5s"
            );
            tokio::task::yield_now().await;
        }
    }

    /// Ends the child with `outcome`, as the host would.
    fn finish(&self, outcome: Outcome) {
        let sender = self
            .launch
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|launch| launch.finish.take());
        if let Some(sender) = sender {
            let _ = sender.send(outcome);
        }
    }

    fn stop_requested(&self) -> bool {
        self.launch
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|launch| launch.stop.is_cancelled())
    }
}

#[async_trait]
impl WorkflowSnippetRunner for FakeRunner {
    async fn check(&self, _code: &str) -> Result<SnippetCheck, WorkflowSnippetError> {
        self.check.clone()
    }

    async fn start(
        &self,
        _launch: SnippetLaunch,
        handler: Arc<dyn ChildHandler>,
    ) -> Result<SnippetStart, WorkflowSnippetError> {
        match &self.mode {
            StartMode::Reject(diagnostics) => Ok(SnippetStart::Rejected(diagnostics.clone())),
            StartMode::Hang => std::future::pending().await,
            StartMode::SpawnThenHang(stopped) => {
                let _child = SpawnedChild(stopped.clone());
                std::future::pending().await
            }
            StartMode::Fail(message) => Err(WorkflowSnippetError {
                message: message.clone(),
            }),
            StartMode::Run => {
                let (tx, rx) = oneshot::channel::<Outcome>();
                let stop = CancellationToken::new();
                *self.launch.lock().unwrap() = Some(Launch {
                    handler,
                    finish: Some(tx),
                    stop: stop.clone(),
                });
                let stopped = stop.clone();
                let outcome: futures_util::future::BoxFuture<'static, Outcome> =
                    Box::pin(async move {
                        tokio::select! {
                            _ = stopped.cancelled() => Outcome::Stopped {
                                reason: StopReason::Interrupted,
                                cause: "the run was stopped".to_owned(),
                            },
                            outcome = rx => outcome.unwrap_or(Outcome::Stopped {
                                reason: StopReason::Interrupted,
                                cause: "the child went away".to_owned(),
                            }),
                        }
                    });
                Ok(SnippetStart::Started(RunningSnippet {
                    entry_path: PathBuf::from("/work/.zcode/workflow-runs/entry.mjs"),
                    stop: ChildStop::new(stop),
                    outcome,
                }))
            }
        }
    }
}

/// A stand-in for a spawned child's guard: dropping it is what stops the child.
struct SpawnedChild(Arc<AtomicBool>);

impl Drop for SpawnedChild {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn request(code: &str, timeout_ms: u64) -> SnippetRequest {
    SnippetRequest {
        code: code.to_owned(),
        cwd: PathBuf::from("/work"),
        timeout_ms,
    }
}

fn completed(value: Option<Value>) -> Outcome {
    Outcome::Completed(Completion {
        ok: true,
        value,
        error: None,
    })
}

fn log(message: &str) -> ChildEvent {
    ChildEvent::Log {
        message: message.to_owned(),
    }
}

fn world_read_request(id: &str, op: &str, args: Vec<Value>) -> ChildRequest {
    ChildRequest {
        id: id.to_owned(),
        request_type: RequestType::WorldRead,
        site_id: "read-file".to_owned(),
        actor: None,
        instructions: None,
        name: None,
        prompt: None,
        op: Some(op.to_owned()),
        artifact_op: None,
        args: Some(args),
    }
}

/// Runs `code` on a service whose runner is `fake`, in a task, so the test can play the child meanwhile.
fn spawn_eval(
    service: &Arc<SnippetService>,
    code: &str,
    timeout_ms: u64,
) -> tokio::task::JoinHandle<Result<SnippetOutcome, WorkflowSnippetError>> {
    let service = service.clone();
    let request = request(code, timeout_ms);
    tokio::spawn(async move { service.eval(request).await })
}

#[tokio::test]
async fn a_snippet_that_returns_a_value_settles_completed_with_its_logs() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "return 3;", 5_000);
    let handler = fake.wait_for_handler().await;
    handler.event(log("hello"));
    fake.finish(completed(Some(json!(3))));
    assert_eq!(
        eval.await.unwrap().unwrap(),
        SnippetOutcome::Completed {
            value: Some(json!(3)),
            logs: vec!["hello".to_owned()],
            logs_truncated: false,
        }
    );
}

#[tokio::test]
async fn a_snippet_that_returns_nothing_reports_no_value() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "log('x');", 5_000);
    let _handler = fake.wait_for_handler().await;
    fake.finish(completed(None));
    assert_eq!(
        eval.await.unwrap().unwrap(),
        SnippetOutcome::Completed {
            value: None,
            logs: Vec::new(),
            logs_truncated: false,
        }
    );
}

#[tokio::test]
async fn a_script_error_fails_as_a_driver_error_with_the_script_message() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "throw new Error('boom');", 5_000);
    let _handler = fake.wait_for_handler().await;
    fake.finish(Outcome::Completed(Completion {
        ok: false,
        value: None,
        error: Some(WireError {
            name: "Error".to_owned(),
            message: "boom".to_owned(),
            code: None,
            violations: None,
            final_text: None,
            stack: None,
        }),
    }));
    assert_eq!(
        eval.await.unwrap().unwrap(),
        SnippetOutcome::Failed {
            code: "DriverError".to_owned(),
            message: "boom".to_owned(),
            logs: Vec::new(),
            logs_truncated: false,
        }
    );
}

#[tokio::test]
async fn a_host_interruption_fails_as_interrupted_with_the_host_cause() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "return 1;", 5_000);
    let _handler = fake.wait_for_handler().await;
    fake.finish(Outcome::Stopped {
        reason: StopReason::Interrupted,
        cause: "The workflow sandbox process exited (code=1, signal=null) before completing"
            .to_owned(),
    });
    assert_eq!(
        eval.await.unwrap().unwrap(),
        SnippetOutcome::Failed {
            code: "Interrupted".to_owned(),
            message: "The workflow sandbox process exited (code=1, signal=null) before completing"
                .to_owned(),
            logs: Vec::new(),
            logs_truncated: false,
        }
    );
}

#[tokio::test]
async fn a_snippet_past_its_wall_clock_is_stopped_and_fails_as_interrupted() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "while (true) {}", 20);
    let _handler = fake.wait_for_handler().await;
    assert_eq!(
        eval.await.unwrap().unwrap(),
        SnippetOutcome::Failed {
            code: "Interrupted".to_owned(),
            message: "The workflow sandbox process exceeded its wall-clock timeout of 20ms"
                .to_owned(),
            logs: Vec::new(),
            logs_truncated: false,
        }
    );
    assert!(fake.stop_requested(), "the child is stopped at the timeout");
}

#[tokio::test]
async fn a_world_read_is_answered_from_the_read_port_inside_the_workspace() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "return await files.read('a.txt');", 5_000);
    let handler = fake.wait_for_handler().await;
    let answer = handler
        .request(world_read_request("r1", "read", vec![json!("a.txt")]), None)
        .await;
    assert_eq!(answer, Ok(json!("hello")));
    fake.finish(completed(Some(json!("hello"))));
    assert!(matches!(
        eval.await.unwrap().unwrap(),
        SnippetOutcome::Completed { .. }
    ));
}

#[tokio::test]
async fn a_world_read_that_escapes_the_workspace_is_refused_to_the_child() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "return 0;", 5_000);
    let handler = fake.wait_for_handler().await;
    let answer = handler
        .request(
            world_read_request("r2", "read", vec![json!("../secret.txt")]),
            None,
        )
        .await;
    let error = answer.expect_err("a path outside the workspace is refused");
    assert_eq!(error.name, "WorkflowError");
    assert!(error.message.contains("secret.txt"), "{}", error.message);
    fake.finish(completed(None));
    let _ = eval.await;
}

#[tokio::test]
async fn an_ask_from_the_child_is_refused_because_the_scratch_facade_has_no_actors() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "return 0;", 5_000);
    let handler = fake.wait_for_handler().await;
    let ask = ChildRequest {
        id: "a1".to_owned(),
        request_type: RequestType::Ask,
        site_id: "ask-site".to_owned(),
        actor: None,
        instructions: Some("say hi".to_owned()),
        name: None,
        prompt: None,
        op: None,
        artifact_op: None,
        args: None,
    };
    let error = handler
        .request(ask, None)
        .await
        .expect_err("an ask is refused");
    assert_eq!(error.code.as_deref(), Some("DriverError"));
    fake.finish(completed(None));
    let _ = eval.await;
}

#[tokio::test]
async fn an_artifact_publish_is_refused_because_a_snippet_has_no_store() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "return 0;", 5_000);
    let handler = fake.wait_for_handler().await;
    let publish = ChildRequest {
        id: "p1".to_owned(),
        request_type: RequestType::PublishArtifact,
        site_id: "artifact-site".to_owned(),
        actor: None,
        instructions: None,
        name: None,
        prompt: None,
        op: None,
        artifact_op: Some("file".to_owned()),
        args: Some(vec![json!("out.md")]),
    };
    let error = handler
        .request(publish, None)
        .await
        .expect_err("a publish is refused");
    assert_eq!(error.code.as_deref(), Some("ArtifactStoreUnavailable"));
    fake.finish(completed(None));
    let _ = eval.await;
}

#[tokio::test]
async fn a_return_value_over_the_cap_fails_as_artifact_too_large() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "return 'x'.repeat(300000);", 5_000);
    let _handler = fake.wait_for_handler().await;
    fake.finish(completed(Some(json!("x".repeat(300_000)))));
    match eval.await.unwrap().unwrap() {
        SnippetOutcome::Failed { code, message, .. } => {
            assert_eq!(code, "ArtifactTooLarge");
            assert!(
                message.contains("over the cap of 262144 bytes"),
                "{message}"
            );
        }
        other => panic!("expected an artifact failure, got {other:?}"),
    }
}

#[tokio::test]
async fn logs_are_capped_at_a_hundred_items_of_2048_characters_and_say_so() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "return 0;", 5_000);
    let handler = fake.wait_for_handler().await;
    for index in 0..101 {
        handler.event(log(&format!("line {index}")));
    }
    handler.event(log(&"y".repeat(3_000)));
    fake.finish(completed(None));
    match eval.await.unwrap().unwrap() {
        SnippetOutcome::Completed {
            logs,
            logs_truncated,
            ..
        } => {
            assert!(logs_truncated);
            assert_eq!(logs.len(), 100);
            assert_eq!(logs[0], "line 0");
            assert_eq!(logs[99], "line 99");
        }
        other => panic!("expected completion, got {other:?}"),
    }
}

#[tokio::test]
async fn a_long_log_line_is_cut_to_2048_characters() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "return 0;", 5_000);
    let handler = fake.wait_for_handler().await;
    handler.event(log(&"y".repeat(3_000)));
    fake.finish(completed(None));
    match eval.await.unwrap().unwrap() {
        SnippetOutcome::Completed {
            logs,
            logs_truncated,
            ..
        } => {
            assert!(logs_truncated);
            assert_eq!(logs.len(), 1);
            assert_eq!(logs[0].chars().count(), 2048);
        }
        other => panic!("expected completion, got {other:?}"),
    }
}

#[tokio::test]
async fn a_snippet_the_runner_rejects_reports_its_diagnostics_and_runs_nothing() {
    let diagnostic = WorkflowDiagnostic {
        code: 2304,
        line: 1,
        column: 1,
        message: "Cannot find name 'agent'.".to_owned(),
    };
    let fake = Arc::new(FakeRunner::with_mode(StartMode::Reject(vec![
        diagnostic.clone(),
    ])));
    let service = SnippetService::new(fake.clone(), reads());
    let outcome = service
        .eval(request("agent('x');", 5_000))
        .await
        .expect("a rejected snippet is an outcome");
    assert_eq!(outcome, SnippetOutcome::Diagnostics(vec![diagnostic]));
    assert!(
        fake.launch.lock().unwrap().is_none(),
        "no child was started"
    );
}

#[tokio::test]
async fn a_runner_failure_is_a_port_error() {
    let fake = Arc::new(FakeRunner::with_mode(StartMode::Fail(
        "the compile helper failed: down".to_owned(),
    )));
    let service = SnippetService::new(fake, reads());
    let error = service
        .eval(request("return 1;", 5_000))
        .await
        .expect_err("a failed start is an error");
    assert_eq!(error.message, "the compile helper failed: down");
}

#[tokio::test]
async fn the_check_is_the_runners_check() {
    let mut fake = FakeRunner::running();
    fake.check = Ok(SnippetCheck::Ready { world_run: true });
    let service = SnippetService::new(Arc::new(fake), reads());
    assert_eq!(
        service.check("world.run('git', [])").await.unwrap(),
        SnippetCheck::Ready { world_run: true }
    );
}

// ocr round 1 (PR #584): the wall clock covers a world read in flight, the start, and the request shapes.

#[tokio::test]
async fn the_timeout_settles_the_run_while_a_world_read_is_in_flight() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(
        fake.clone(),
        slow_reads(std::time::Duration::from_millis(1500)),
    ));
    let eval = spawn_eval(&service, "return await files.read('a.txt');", 50);
    let handler = fake.wait_for_handler().await;
    // The child's read is in flight for 1.5s; the request is not awaited to its answer.
    let read = tokio::spawn(async move {
        handler
            .request(
                world_read_request("slow", "read", vec![json!("a.txt")]),
                None,
            )
            .await
    });
    let started = std::time::Instant::now();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(1), eval)
        .await
        .expect("the eval settles at its timeout, not when the read returns")
        .unwrap()
        .unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert!(matches!(
        outcome,
        SnippetOutcome::Failed { ref code, .. } if code == "Interrupted"
    ));
    read.abort();
}

#[tokio::test]
async fn a_start_that_never_returns_is_bounded_by_the_timeout() {
    let fake = Arc::new(FakeRunner::with_mode(StartMode::Hang));
    let service = SnippetService::new(fake, reads());
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        service.eval(request("return 1;", 50)),
    )
    .await
    .expect("the eval settles at its timeout")
    .unwrap();
    assert_eq!(
        outcome,
        SnippetOutcome::Failed {
            code: "Interrupted".to_owned(),
            message: "The workflow sandbox process exceeded its wall-clock timeout of 50ms"
                .to_owned(),
            logs: Vec::new(),
            logs_truncated: false,
        }
    );
}

#[tokio::test]
async fn a_world_read_without_an_op_is_refused_as_a_contract_error() {
    let fake = Arc::new(FakeRunner::running());
    let service = Arc::new(SnippetService::new(fake.clone(), reads()));
    let eval = spawn_eval(&service, "return 0;", 5_000);
    let handler = fake.wait_for_handler().await;
    let mut request = world_read_request("r3", "read", vec![json!("a.txt")]);
    request.op = None;
    let error = handler
        .request(request, None)
        .await
        .expect_err("a read without an op is refused");
    assert_eq!(error.code.as_deref(), Some("DriverError"));
    assert!(error.message.contains("no op"), "{}", error.message);
    fake.finish(completed(None));
    let _ = eval.await;
}

#[tokio::test]
async fn a_start_dropped_at_the_deadline_stops_the_child_it_spawned() {
    let stopped = Arc::new(AtomicBool::new(false));
    let fake = Arc::new(FakeRunner::with_mode(StartMode::SpawnThenHang(
        stopped.clone(),
    )));
    let service = SnippetService::new(fake, reads());
    let outcome = service.eval(request("return 1;", 50)).await.unwrap();
    assert!(
        matches!(&outcome, SnippetOutcome::Failed { code, .. } if code == "Interrupted"),
        "{outcome:?}"
    );
    assert!(
        stopped.load(Ordering::SeqCst),
        "the child spawned by the start that the deadline dropped was not stopped"
    );
}

/// A value whose serialization fails, as a return value can in principle.
struct Unserializable;

impl serde::Serialize for Unserializable {
    fn serialize<S: serde::Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom("no bytes for this value"))
    }
}

#[test]
fn a_return_value_that_cannot_be_serialized_is_refused_not_passed_on() {
    assert!(matches!(
        return_refusal(&Unserializable),
        Some(ReturnRefusal::Unserializable(_))
    ));
    assert_eq!(return_refusal(&json!({"count": 3})), None);
}
