//! Ported from `amend-workflow-permission.test.ts` and the amend cases of `amend-workflow-tool.test.ts` that the source
//! and refusal paths of this PR cover (specs/fork-rust-workflow-engine.md, 9.43). The concurrency-only route is tested
//! from 9.52 on (retune in place, its refusals, and the fallback to a revision). Not ported here: the subagent model,
//! script-named models and the GUI settings window (divergences 456 to 459).
//! These run the tool's `validate_input`, `check_permissions` and `call` directly, in the executor's order.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::ids::{SessionId, WorkflowRunId};
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::testing::OpsOverride;
use rust_cli_kernel_api::tool::{Tool, ToolError, ToolOutput, ToolUseContext, Validation};
use rust_cli_kernel_api::workflow_analysis::{
    WorkflowAnalysis, WorkflowAnalysisError, WorkflowAnalyzer, WorkflowDiagnostic,
};
use rust_cli_kernel_api::workflow_run::{
    AmendRefusalReason, AmendRequest, AmendResult, DynamicWorkflowRunError, DynamicWorkflowRunPort,
    DynamicWorkflowRunSessions, RetuneOutcome, RetuneRefusal, RetuneRequest,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::test_more::{Ctx, output_text};

/// The checker: a script containing `BROKEN` has one error on line 1 column 7; `FAIL` makes the check itself fail.
#[derive(Default)]
struct Checker;

#[async_trait]
impl WorkflowAnalyzer for Checker {
    async fn analyze(&self, script: &str) -> Result<WorkflowAnalysis, WorkflowAnalysisError> {
        if script.contains("FAIL") {
            return Err(WorkflowAnalysisError {
                message: "the helper is not running".to_owned(),
            });
        }
        if script.contains("BROKEN") {
            return Ok(WorkflowAnalysis {
                ok: false,
                diagnostics: vec![WorkflowDiagnostic {
                    code: 2322,
                    line: 1,
                    column: 7,
                    message: "Type 'string' is not assignable to type 'number'.".to_owned(),
                }],
            });
        }
        Ok(WorkflowAnalysis {
            ok: true,
            diagnostics: Vec::new(),
        })
    }
}

/// The amend the port answers, and the requests it received.
#[derive(Clone)]
enum Answer {
    Started { superseded: Option<&'static str> },
    Refused(AmendRefusalReason),
}

/// A run port that records each amend and reads the predecessor's stored script (`stored`).
struct FakeRun {
    amends: Mutex<Vec<AmendRequest>>,
    answer: Answer,
    stored: Option<String>,
    default_concurrency: Option<usize>,
    /// The stored-script read fails (a wiring or journal fault, not "no stored script").
    read_fails: bool,
    /// The retune answer; `None` is the port's unsupported default.
    retune: Option<RetuneOutcome>,
    retunes: Mutex<Vec<RetuneRequest>>,
    /// The run's detail (`get_run_detail`); `None` is a run this session does not hold.
    detail: Option<Value>,
}

impl FakeRun {
    fn new(answer: Answer, stored: Option<&str>) -> Arc<Self> {
        Arc::new(Self {
            amends: Mutex::new(Vec::new()),
            answer,
            stored: stored.map(str::to_owned),
            default_concurrency: Some(4),
            read_fails: false,
            retune: None,
            retunes: Mutex::new(Vec::new()),
            detail: None,
        })
    }

    fn with_failing_read(answer: Answer) -> Arc<Self> {
        Arc::new(Self {
            amends: Mutex::new(Vec::new()),
            answer,
            stored: None,
            default_concurrency: Some(4),
            read_fails: true,
            retune: None,
            retunes: Mutex::new(Vec::new()),
            detail: None,
        })
    }

    /// A port whose retune answers `outcome` and whose run detail is `detail`; its amend starts `run-2` over `run-1`.
    fn with_retune(
        outcome: RetuneOutcome,
        detail: Option<Value>,
        stored: Option<&str>,
    ) -> Arc<Self> {
        Arc::new(Self {
            amends: Mutex::new(Vec::new()),
            answer: Answer::Started {
                superseded: Some("run-1"),
            },
            stored: stored.map(str::to_owned),
            default_concurrency: Some(4),
            read_fails: false,
            retune: Some(outcome),
            retunes: Mutex::new(Vec::new()),
            detail,
        })
    }

    fn amends(&self) -> Vec<AmendRequest> {
        self.amends.lock().unwrap().clone()
    }

    fn retunes(&self) -> Vec<RetuneRequest> {
        self.retunes.lock().unwrap().clone()
    }
}

#[async_trait]
impl DynamicWorkflowRunPort for FakeRun {
    fn default_concurrency(&self) -> Option<usize> {
        self.default_concurrency
    }

    async fn amend(&self, request: AmendRequest) -> Result<AmendResult, DynamicWorkflowRunError> {
        self.amends.lock().unwrap().push(request);
        Ok(match &self.answer {
            Answer::Started { superseded } => AmendResult::Started {
                run_id: WorkflowRunId::new("run-2"),
                superseded_run_id: superseded.map(WorkflowRunId::new),
            },
            Answer::Refused(reason) => AmendResult::Refused(*reason),
        })
    }

    async fn get_script(
        &self,
        _run_id: &WorkflowRunId,
    ) -> Result<Option<String>, DynamicWorkflowRunError> {
        if self.read_fails {
            return Err(DynamicWorkflowRunError::new("the journal is busy"));
        }
        Ok(self.stored.clone())
    }

    async fn retune_concurrency(
        &self,
        request: RetuneRequest,
    ) -> Result<RetuneOutcome, DynamicWorkflowRunError> {
        self.retunes.lock().unwrap().push(request);
        match self.retune {
            Some(outcome) => Ok(outcome),
            None => Err(DynamicWorkflowRunError::unsupported("retuneConcurrency")),
        }
    }

    async fn get_run_detail(
        &self,
        _run_id: &WorkflowRunId,
    ) -> Result<Option<Value>, DynamicWorkflowRunError> {
        Ok(self.detail.clone())
    }
}

/// A session whose history shows the dynamic-workflows Skill loaded (the gate reads it).
struct History(Vec<Message>);

#[async_trait]
impl OpsOverride for History {
    async fn conversation(&self) -> Option<Vec<Message>> {
        Some(self.0.clone())
    }
}

fn loaded_skill() -> Vec<Message> {
    vec![
        serde_json::from_value(json!({
            "type": "assistant",
            "id": "msg_skill",
            "content": [{"type": "tool_use", "id": "toolu_skill", "name": "Skill",
                         "input": {"skill": "dynamic-workflows"}}],
            "model": "test-model"
        }))
        .expect("assistant message"),
        serde_json::from_value(json!({
            "type": "user",
            "id": "msg_result",
            "content": [{"type": "tool_result", "tool_use_id": "toolu_skill",
                         "content": [{"type": "text", "text": "skill body"}]}],
            "origin": {"kind": "tool_result", "assistant": "msg_skill"}
        }))
        .expect("user message"),
    ]
}

struct OneSession(Arc<dyn DynamicWorkflowRunPort>);

impl DynamicWorkflowRunSessions for OneSession {
    fn for_session(&self, _session: &SessionId) -> Arc<dyn DynamicWorkflowRunPort> {
        self.0.clone()
    }
}

const CLEAN: &str =
    "interface R { done: boolean }\nconst r = await agent(\"a\").ask<R>(\"do\");\nreturn r.done;";
const REVISED: &str = "interface R { done: boolean }\nconst r = await agent(\"b\").ask<R>(\"again\");\nreturn r.done;";

/// A tool over `port`, with a project directory under a temp root, and a call context in that directory.
fn harness(port: Arc<FakeRun>) -> (AmendWorkflowTool, ToolUseContext, tempfile::TempDir) {
    let guard = tempfile::TempDir::new().expect("tempdir");
    let cwd = guard.path().join("project");
    rust_cli_fs::ensure_dir(&cwd).expect("project dir");
    let sessions: Arc<dyn DynamicWorkflowRunSessions> = Arc::new(OneSession(port));
    let tool = AmendWorkflowTool::new(Arc::new(Checker), Some(sessions));
    let mut ctx = Ctx::with_ops(Arc::new(History(loaded_skill()))).build();
    ctx.workspace.root = rust_cli_kernel_api::env::EnvPath::new(cwd.display().to_string());
    ctx.session = SessionId::new("ses_p");
    (tool, ctx, guard)
}

/// The executor's order: the permission decision reads and checks the revision, then the call runs. A call with no
/// decision for a script that checks is refused (CreateWorkflow's rule), so every test goes through the decision.
async fn run(
    tool: &AmendWorkflowTool,
    input: Value,
    ctx: ToolUseContext,
) -> Result<ToolOutput, ToolError> {
    let _decision = tool.check_permissions(&input, &ctx).await;
    let (tx, _rx) = mpsc::channel(4);
    tool.call(input, ctx, tx).await
}

#[tokio::test]
async fn an_amend_with_a_script_stops_the_predecessor_and_reports_the_successor() {
    let port = FakeRun::new(
        Answer::Started {
            superseded: Some("run-1"),
        },
        None,
    );
    let (tool, ctx, _guard) = harness(port.clone());
    let input = json!({"run_id": "run-1", "script": REVISED});
    let decision = tool.check_permissions(&input, &ctx).await;
    assert!(
        matches!(decision, PermissionDecision::Ask { .. }),
        "a revision that checks asks, always: {decision:?}"
    );
    let output = run(&tool, input, ctx).await.expect("the amend starts");
    let text = output_text(&output);

    let amends = port.amends();
    assert_eq!(amends.len(), 1, "one amend reaches the port");
    assert_eq!(amends[0].predecessor_run_id, WorkflowRunId::new("run-1"));
    assert_eq!(amends[0].script_text, REVISED);
    assert_eq!(amends[0].parent_session_id, Some(SessionId::new("ses_p")));
    assert!(text.contains("Run run-1 was still running"), "{text}");
    assert!(
        text.contains("it has been stopped and superseded"),
        "{text}"
    );
    assert!(
        text.contains("started in the background as run run-2"),
        "{text}"
    );
    assert!(text.contains("you will be notified"), "{text}");
    assert_eq!(output.display["backgroundTaskId"], json!("run-2"));
}

#[tokio::test]
async fn a_settled_predecessor_is_named_as_imported_and_nothing_is_superseded() {
    let port = FakeRun::new(Answer::Started { superseded: None }, None);
    let (tool, ctx, _guard) = harness(port.clone());
    let output = run(&tool, json!({"run_id": "run-1", "script": REVISED}), ctx)
        .await
        .expect("the amend starts");
    let text = output_text(&output);
    assert!(
        text.contains("Run run-1 had already settled; its finished work is imported as cache."),
        "{text}"
    );
    assert!(!text.contains("superseded"), "{text}");
}

#[tokio::test]
async fn a_revision_that_does_not_check_is_reported_and_stops_nothing() {
    let port = FakeRun::new(Answer::Started { superseded: None }, None);
    let (tool, ctx, _guard) = harness(port.clone());
    let input = json!({"run_id": "run-1", "script": format!("{REVISED}\nBROKEN")});
    let decision = tool.check_permissions(&input, &ctx).await;
    assert!(
        matches!(decision, PermissionDecision::Allow { .. }),
        "a revision that does not check is not asked about: {decision:?}"
    );
    let output = run(&tool, input, ctx)
        .await
        .expect("the call answers with diagnostics");
    let text = output_text(&output);
    assert!(
        text.contains("The revised workflow script has errors:"),
        "{text}"
    );
    assert!(text.contains("L1:C7 Type 'string'"), "{text}");
    assert!(text.contains("Run run-1 was not touched."), "{text}");
    assert_eq!(output.display["ok"], json!(false));
    assert!(port.amends().is_empty(), "nothing is stopped or started");
}

#[tokio::test]
async fn an_omitted_script_keeps_the_predecessors_and_says_it_is_unchanged() {
    let port = FakeRun::new(
        Answer::Started {
            superseded: Some("run-1"),
        },
        Some(CLEAN),
    );
    let (tool, ctx, _guard) = harness(port.clone());
    let output = run(&tool, json!({"run_id": "run-1", "name": "again"}), ctx)
        .await
        .expect("the amend starts");
    let text = output_text(&output);
    let amends = port.amends();
    assert_eq!(
        amends[0].script_text, CLEAN,
        "the predecessor's script runs"
    );
    assert_eq!(amends[0].name.as_deref(), Some("again"));
    assert!(
        text.contains("The script of run run-1 started unchanged in the background as run run-2."),
        "{text}"
    );
}

#[tokio::test]
async fn an_omitted_script_with_no_stored_script_is_refused_before_anything_is_stopped() {
    let port = FakeRun::new(Answer::Started { superseded: None }, None);
    let (tool, ctx, _guard) = harness(port.clone());
    let error = run(&tool, json!({"run_id": "run-1"}), ctx)
        .await
        .expect_err("there is nothing to keep");
    let message = format!("{error:?}");
    assert!(
        message.contains("workflow_amend_script_unavailable"),
        "{message}"
    );
    assert!(port.amends().is_empty());
}

#[tokio::test]
async fn a_refused_amend_is_a_failure_with_its_refusal_text_and_changes_nothing() {
    let port = FakeRun::new(Answer::Refused(AmendRefusalReason::MissingBoundaries), None);
    let (tool, ctx, _guard) = harness(port.clone());
    let error = run(&tool, json!({"run_id": "run-1", "script": REVISED}), ctx)
        .await
        .expect_err("a refusal is a failure");
    let message = format!("{error:?}");
    assert!(
        message.contains("workflow_amend_missing_boundaries"),
        "{message}"
    );
    assert!(
        message.contains("Nothing was stopped or created."),
        "{message}"
    );
    assert_eq!(port.amends().len(), 1, "the port answered the refusal");
}

#[tokio::test]
async fn an_unknown_predecessor_is_refused_with_the_run_not_found_text() {
    let port = FakeRun::new(Answer::Refused(AmendRefusalReason::RunNotFound), None);
    let (tool, ctx, _guard) = harness(port.clone());
    let error = run(&tool, json!({"run_id": "run-404", "script": REVISED}), ctx)
        .await
        .expect_err("an unknown run is a failure");
    let message = format!("{error:?}");
    assert!(message.contains("run_not_found"), "{message}");
    assert!(
        message.contains("Nothing was stopped or created"),
        "{message}"
    );
}

#[tokio::test]
async fn a_path_source_is_read_from_its_file_and_the_file_is_the_run_script_path() {
    let port = FakeRun::new(
        Answer::Started {
            superseded: Some("run-1"),
        },
        None,
    );
    let (tool, ctx, guard) = harness(port.clone());
    let file = guard.path().join("project").join("flow.ts");
    rust_cli_fs::write_text(&file, REVISED).expect("the script file");
    run(&tool, json!({"run_id": "run-1", "path": "flow.ts"}), ctx)
        .await
        .expect("the amend starts");
    let amends = port.amends();
    assert_eq!(amends[0].script_text, REVISED);
    assert_eq!(
        amends[0].script_path.as_deref(),
        Some(file.display().to_string().as_str()),
        "the revision records the file it came from"
    );
}

#[tokio::test]
async fn an_inline_revision_records_the_draft_it_wrote_as_its_script_path() {
    let port = FakeRun::new(Answer::Started { superseded: None }, None);
    let (tool, ctx, _guard) = harness(port.clone());
    run(&tool, json!({"run_id": "run-1", "script": REVISED}), ctx)
        .await
        .expect("the amend starts");
    let path = port.amends()[0].script_path.clone().expect("a draft path");
    assert!(path.contains(".zcode/workflow-drafts"), "{path}");
}

#[tokio::test]
async fn a_number_limit_reaches_the_port_and_null_is_the_default() {
    let port = FakeRun::new(Answer::Started { superseded: None }, None);
    let (tool, ctx, _guard) = harness(port.clone());
    run(
        &tool,
        json!({"run_id": "run-1", "script": REVISED, "max_concurrency": 3}),
        ctx,
    )
    .await
    .expect("the amend starts");
    let (tool2, ctx2, _guard2) = harness(port.clone());
    run(
        &tool2,
        json!({"run_id": "run-1", "script": REVISED, "max_concurrency": null}),
        ctx2,
    )
    .await
    .expect("the amend starts");
    let amends = port.amends();
    assert_eq!(amends[0].max_concurrency, Some(3.0));
    assert_eq!(
        amends[1].max_concurrency,
        Some(4.0),
        "null is the port's default"
    );
}

#[tokio::test]
async fn a_concurrency_only_call_is_valid_and_asks_for_nothing() {
    let port = FakeRun::new(Answer::Started { superseded: None }, Some(CLEAN));
    let (tool, ctx, _guard) = harness(port.clone());
    let input = json!({"run_id": "run-1", "max_concurrency": 5});
    assert!(matches!(
        tool.validate_input(&input, &ctx).await,
        Validation::Ok
    ));
    let decision = tool.check_permissions(&input, &ctx).await;
    assert!(
        matches!(decision, PermissionDecision::Allow { .. }),
        "a retune has no script to approve, for any owner: {decision:?}"
    );
}

#[tokio::test]
async fn a_concurrency_only_call_retunes_the_live_run_in_place_with_node_text() {
    let port = FakeRun::with_retune(
        RetuneOutcome::Retuned {
            previous: 4.0,
            max_concurrency: 6.0,
            default_concurrency: 4.0,
        },
        None,
        None,
    );
    let (tool, ctx, _guard) = harness(port.clone());
    let output = run(&tool, json!({"run_id": "run-1", "max_concurrency": 6}), ctx)
        .await
        .expect("the retune applies");
    assert_eq!(
        output_text(&output),
        "Applied to the running run run-1; at most 6 subagents run at once. Run run-1 keeps running under it: nothing was stopped and no new run was started."
    );
    assert!(port.amends().is_empty(), "no successor is started");
    assert_eq!(
        port.retunes(),
        vec![RetuneRequest {
            run_id: WorkflowRunId::new("run-1"),
            max_concurrency: Some(6.0),
        }]
    );
    assert_eq!(output.display["retuned"]["maxConcurrency"], json!(6.0));
    assert_eq!(output.display["retuned"]["previous"], json!(4.0));
    assert_eq!(output.display["retuned"]["defaultConcurrency"], json!(4.0));
    assert!(
        output.display.get("status").is_none(),
        "no backgrounded status"
    );
}

#[tokio::test]
async fn a_retune_to_null_is_the_default_and_says_so() {
    let port = FakeRun::with_retune(
        RetuneOutcome::Retuned {
            previous: 6.0,
            max_concurrency: 4.0,
            default_concurrency: 4.0,
        },
        None,
        None,
    );
    let (tool, ctx, _guard) = harness(port.clone());
    let output = run(
        &tool,
        json!({"run_id": "run-1", "max_concurrency": null}),
        ctx,
    )
    .await
    .expect("the retune to the default applies");
    assert!(
        output_text(&output).contains("at most 4 subagents run at once (the default)"),
        "{}",
        output_text(&output)
    );
    assert_eq!(
        port.retunes()[0].max_concurrency,
        None,
        "null is the default"
    );
}

#[tokio::test]
async fn a_retune_to_one_subagent_uses_the_singular_text() {
    let port = FakeRun::with_retune(
        RetuneOutcome::Retuned {
            previous: 4.0,
            max_concurrency: 1.0,
            default_concurrency: 4.0,
        },
        None,
        None,
    );
    let (tool, ctx, _guard) = harness(port);
    let output = run(&tool, json!({"run_id": "run-1", "max_concurrency": 1}), ctx)
        .await
        .expect("the retune applies");
    assert!(
        output_text(&output).contains("at most 1 subagent runs at once."),
        "{}",
        output_text(&output)
    );
}

#[tokio::test]
async fn a_retune_to_the_limit_in_force_is_refused_with_node_text_and_changes_nothing() {
    let port = FakeRun::with_retune(
        RetuneOutcome::Refused(RetuneRefusal::Unchanged { current: 4.0 }),
        None,
        None,
    );
    let (tool, ctx, _guard) = harness(port.clone());
    let error = run(&tool, json!({"run_id": "run-1", "max_concurrency": 4}), ctx)
        .await
        .expect_err("an unchanged limit is refused");
    let ToolError::Failed { message } = error else {
        panic!("a failure: {error:?}");
    };
    assert_eq!(
        message,
        "workflow_retune_unchanged: run run-1 already runs at the default parallelism (at most 4 subagents at once), so there is nothing to change. Nothing was stopped, created or changed — pass a different `max_concurrency`, or a revised script if you meant to amend the run."
    );
    assert!(port.amends().is_empty());
}

#[tokio::test]
async fn a_retune_of_a_run_that_is_not_live_and_not_owned_is_not_retunable_or_settled() {
    let other_live = json!({"runId": "run-1", "ownedByThisSession": false, "status": "running"});
    let port = FakeRun::with_retune(
        RetuneOutcome::Refused(RetuneRefusal::NotLive),
        Some(other_live),
        Some(CLEAN),
    );
    let (tool, ctx, _guard) = harness(port.clone());
    let error = run(&tool, json!({"run_id": "run-1", "max_concurrency": 5}), ctx)
        .await
        .expect_err("another session's live run is not retuned");
    let ToolError::Failed { message } = error else {
        panic!("a failure");
    };
    assert!(
        message.starts_with(
            "workflow_run_not_retunable: run run-1 is not being executed by this agent"
        ),
        "{message}"
    );
    assert!(port.amends().is_empty());

    let settled = json!({"runId": "run-1", "ownedByThisSession": false, "status": "completed"});
    let port = FakeRun::with_retune(
        RetuneOutcome::Refused(RetuneRefusal::NotLive),
        Some(settled),
        Some(CLEAN),
    );
    let (tool, ctx, _guard) = harness(port.clone());
    let error = run(&tool, json!({"run_id": "run-1", "max_concurrency": 5}), ctx)
        .await
        .expect_err("a settled run is not retuned");
    let ToolError::Failed { message } = error else {
        panic!("a failure");
    };
    assert!(
        message.starts_with("workflow_run_settled: run run-1 settled before the new parallelism limit could take hold"),
        "{message}"
    );
    assert!(port.amends().is_empty());
}

#[tokio::test]
async fn a_user_stopped_run_that_settled_in_the_race_is_not_amended_by_the_fallback() {
    let stopped = json!({"runId": "run-1", "ownedByThisSession": true, "status": "stopped", "stopReason": "user"});
    let port = FakeRun::with_retune(
        RetuneOutcome::Refused(RetuneRefusal::NotLive),
        Some(stopped),
        Some(CLEAN),
    );
    let (tool, ctx, _guard) = harness(port.clone());
    let error = run(&tool, json!({"run_id": "run-1", "max_concurrency": 5}), ctx)
        .await
        .expect_err("a user stop is not revised by a retune");
    let ToolError::Failed { message } = error else {
        panic!("a failure");
    };
    assert!(message.starts_with("workflow_run_settled:"), "{message}");
    assert!(port.amends().is_empty());
}

#[tokio::test]
async fn a_retune_of_an_unknown_run_is_refused_with_the_run_not_found_text() {
    let port = FakeRun::with_retune(
        RetuneOutcome::Refused(RetuneRefusal::NotLive),
        None,
        Some(CLEAN),
    );
    let (tool, ctx, _guard) = harness(port.clone());
    let error = run(&tool, json!({"run_id": "run-9", "max_concurrency": 5}), ctx)
        .await
        .expect_err("an unknown run is refused");
    let ToolError::Failed { message } = error else {
        panic!("a failure");
    };
    assert!(
        message.starts_with("run_not_found: no workflow run with ID run-9"),
        "{message}"
    );
    assert!(port.amends().is_empty());
}

#[tokio::test]
async fn a_retune_race_with_an_owned_live_run_becomes_an_amendment_without_a_window() {
    let owned_running = json!({"runId": "run-1", "ownedByThisSession": true, "status": "running"});
    let port = FakeRun::with_retune(
        RetuneOutcome::Refused(RetuneRefusal::NotLive),
        Some(owned_running),
        Some(CLEAN),
    );
    let (tool, ctx, _guard) = harness(port.clone());
    let input = json!({"run_id": "run-1", "max_concurrency": 5});
    let decision = tool.check_permissions(&input, &ctx).await;
    assert!(
        matches!(decision, PermissionDecision::Allow { .. }),
        "{decision:?}"
    );
    let (tx, _rx) = mpsc::channel(4);
    let output = tool
        .call(input, ctx, tx)
        .await
        .expect("the fallback amends the settled run");
    let amends = port.amends();
    assert_eq!(amends.len(), 1, "one successor starts");
    assert_eq!(
        amends[0].script_text, CLEAN,
        "the predecessor's script is kept"
    );
    assert_eq!(amends[0].max_concurrency, Some(5.0));
    assert_eq!(port.retunes().len(), 1, "the retune was tried first");
    assert!(output_text(&output).contains("started unchanged in the background as run run-2"));
}

#[tokio::test]
async fn a_host_without_a_retune_answers_the_retune_unavailable_text() {
    let port = FakeRun::new(Answer::Started { superseded: None }, Some(CLEAN));
    let (tool, ctx, _guard) = harness(port.clone());
    let error = run(&tool, json!({"run_id": "run-1", "max_concurrency": 5}), ctx)
        .await
        .expect_err("an unsupported retune is refused");
    let ToolError::Failed { message } = error else {
        panic!("a failure");
    };
    assert!(
        message.starts_with("workflow_retune_unavailable:"),
        "{message}"
    );
    assert!(port.amends().is_empty());
}

#[tokio::test]
async fn both_a_script_and_a_path_are_refused_and_a_subagent_model_is_refused() {
    let port = FakeRun::new(Answer::Started { superseded: None }, Some(CLEAN));
    let (tool, ctx, _guard) = harness(port);
    let both = tool
        .validate_input(
            &json!({"run_id": "run-1", "script": CLEAN, "path": "a.ts"}),
            &ctx,
        )
        .await;
    assert!(
        matches!(both, Validation::Invalid { .. }),
        "two sources are ambiguous"
    );
    let model = tool
        .validate_input(
            &json!({"run_id": "run-1", "script": CLEAN, "subagent_model": "x/y"}),
            &ctx,
        )
        .await;
    let Validation::Invalid { message, .. } = model else {
        panic!("this host cannot choose a subagent model");
    };
    assert!(
        message.contains("cannot choose a subagent model"),
        "{message}"
    );
}

#[tokio::test]
async fn an_inherited_script_still_needs_a_confirmation_before_the_call() {
    // The approval is missing (evicted, or the call came without its decision): nothing may stop the live run.
    let port = FakeRun::new(
        Answer::Started {
            superseded: Some("run-1"),
        },
        Some(CLEAN),
    );
    let (tool, ctx, _guard) = harness(port.clone());
    let (tx, _rx) = mpsc::channel(4);
    let error = tool
        .call(json!({"run_id": "run-1"}), ctx, tx)
        .await
        .expect_err("an approval-less inherited revision is refused");
    assert!(
        format!("{error:?}").contains("no confirmation"),
        "{error:?}"
    );
    assert!(port.amends().is_empty(), "nothing is stopped");
}

#[tokio::test]
async fn a_limit_that_is_not_a_whole_number_is_described_as_such() {
    let port = FakeRun::new(Answer::Started { superseded: None }, Some(CLEAN));
    let (tool, ctx, _guard) = harness(port);
    for bad in [json!(2.5), json!("3")] {
        let validation = tool
            .validate_input(&json!({"run_id": "run-1", "max_concurrency": bad}), &ctx)
            .await;
        let Validation::Invalid { message, .. } = validation else {
            panic!("a limit that is not a whole number is refused");
        };
        assert!(message.contains("integer"), "{message}");
        assert!(!message.contains("greater than 0"), "{message}");
    }
}

#[tokio::test]
async fn a_read_failure_of_the_stored_script_is_reported_as_the_failure_it_is() {
    let port = FakeRun::with_failing_read(Answer::Started { superseded: None });
    let (tool, ctx, _guard) = harness(port.clone());
    let error = run(&tool, json!({"run_id": "run-1"}), ctx)
        .await
        .expect_err("the read failed");
    let message = format!("{error:?}");
    assert!(message.contains("the journal is busy"), "{message}");
    assert!(!message.contains("has no stored script"), "{message}");
    assert!(port.amends().is_empty());
}

#[tokio::test]
async fn a_script_file_that_declares_arguments_is_amended_without_validating_them() {
    // Node strips the block and ignores its declarations on the amend path: revisions carry no arguments.
    let port = FakeRun::new(
        Answer::Started {
            superseded: Some("run-1"),
        },
        None,
    );
    let (tool, ctx, guard) = harness(port.clone());
    let file = guard.path().join("project").join("flow.ts");
    rust_cli_fs::write_text(
        &file,
        "/* zcode-workflow\ndescription: a\nargs:\n  n:\n    type: number\n*/\nreturn 1;",
    )
    .expect("the script file");
    run(&tool, json!({"run_id": "run-1", "path": "flow.ts"}), ctx)
        .await
        .expect("the required argument is not the amend's to validate");
    let amends = port.amends();
    assert_eq!(amends[0].script_text, "return 1;", "the block is stripped");
}

#[tokio::test]
async fn an_amend_without_a_loaded_skill_is_refused_when_it_carries_a_script() {
    let port = FakeRun::new(Answer::Started { superseded: None }, Some(CLEAN));
    let guard = tempfile::TempDir::new().expect("tempdir");
    let sessions: Arc<dyn DynamicWorkflowRunSessions> = Arc::new(OneSession(port.clone()));
    let tool = AmendWorkflowTool::new(Arc::new(Checker), Some(sessions));
    let mut ctx = Ctx::with_ops(Arc::new(History(Vec::new()))).build();
    ctx.workspace.root = rust_cli_kernel_api::env::EnvPath::new(guard.path().display().to_string());
    let validation = tool
        .validate_input(&json!({"run_id": "run-1", "script": CLEAN}), &ctx)
        .await;
    assert!(matches!(
        validation,
        Validation::Invalid {
            error_code: Some(428),
            ..
        }
    ));
    let inherited = tool.validate_input(&json!({"run_id": "run-1"}), &ctx).await;
    assert!(
        matches!(inherited, Validation::Ok),
        "a settings-only call reuses the script and needs no skill"
    );
}
