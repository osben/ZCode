//! Ported from Node's `list-workflow-runs-tool.test.ts`, `resume-workflow-run-tool.test.ts` and
//! `resolve-workflow-question-tool.test.ts` (the handler projections and the model text goldens).

use std::sync::{Arc, Mutex};

use rust_cli_kernel_api::ids::{QuestionId, SessionId, WorkflowRunId};
use rust_cli_kernel_api::tool::{Tool, ToolError, ToolUseContext, Validation};
use rust_cli_kernel_api::tool_names;
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, DynamicWorkflowRunPort, DynamicWorkflowRunSessions, LateRunSessions,
    ListQuery, ResolveQuestionRefusalReason, ResolveQuestionResult,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::test_more::{Ctx, output_text};

/// A run port with the members the test set. A member left `None` is the optional-member fallback.
#[derive(Default)]
struct FakePort {
    list: Option<Value>,
    resume: Option<Value>,
    resolve: Option<ResolveQuestionResult>,
    /// `Some(None)`: the run is unknown. `Some(Some(detail))`: the detail. `None`: the member is absent.
    detail: Option<Option<Value>>,
    broken: bool,
    queries: Mutex<Vec<ListQuery>>,
    resumed: Mutex<Vec<String>>,
    detailed: Mutex<Vec<String>>,
    answered: Mutex<Vec<(String, String)>>,
}

#[async_trait::async_trait]
impl DynamicWorkflowRunPort for FakePort {
    async fn list_runs(&self, query: ListQuery) -> Result<Value, DynamicWorkflowRunError> {
        self.queries.lock().unwrap().push(query);
        if self.broken {
            return Err(DynamicWorkflowRunError::new("the journal is unavailable"));
        }
        self.list
            .clone()
            .ok_or_else(|| DynamicWorkflowRunError::unsupported("listRuns"))
    }

    async fn resume(&self, run_id: &WorkflowRunId) -> Result<Value, DynamicWorkflowRunError> {
        self.resumed
            .lock()
            .unwrap()
            .push(run_id.as_str().to_owned());
        self.resume
            .clone()
            .ok_or_else(|| DynamicWorkflowRunError::unsupported("resume"))
    }

    async fn get_run_detail(
        &self,
        run_id: &WorkflowRunId,
    ) -> Result<Option<Value>, DynamicWorkflowRunError> {
        self.detailed
            .lock()
            .unwrap()
            .push(run_id.as_str().to_owned());
        match &self.detail {
            Some(answer) => Ok(answer.clone()),
            None => Err(DynamicWorkflowRunError::unsupported("getRunDetail")),
        }
    }

    async fn resolve_question(
        &self,
        qid: &QuestionId,
        answer: &str,
    ) -> Result<ResolveQuestionResult, DynamicWorkflowRunError> {
        self.answered
            .lock()
            .unwrap()
            .push((qid.as_str().to_owned(), answer.to_owned()));
        self.resolve
            .clone()
            .ok_or_else(|| DynamicWorkflowRunError::unsupported("resolveQuestion"))
    }
}

/// The sessions the tools reach: one port for every session, and a record of the sessions asked for.
struct FakeSessions {
    port: Arc<FakePort>,
    asked: Mutex<Vec<String>>,
}

impl DynamicWorkflowRunSessions for FakeSessions {
    fn for_session(&self, session: &SessionId) -> Arc<dyn DynamicWorkflowRunPort> {
        self.asked.lock().unwrap().push(session.as_str().to_owned());
        self.port.clone()
    }
}

fn sessions(port: FakePort) -> (Arc<FakeSessions>, Arc<FakePort>) {
    let port = Arc::new(port);
    let sessions = Arc::new(FakeSessions {
        port: port.clone(),
        asked: Mutex::new(Vec::new()),
    });
    (sessions, port)
}

fn no_service() -> Arc<dyn DynamicWorkflowRunSessions> {
    Arc::new(LateRunSessions::default())
}

fn tool(name: &str, runs: Arc<dyn DynamicWorkflowRunSessions>) -> Arc<dyn Tool> {
    run_tools(runs)
        .into_iter()
        .find(|tool| tool.name() == name)
        .expect("the tool is built")
}

fn context(cwd: &str) -> ToolUseContext {
    let mut ctx = Ctx::new(Arc::new(rust_cli_kernel_api::testing::NoOneToAsk)).build();
    ctx.workspace.root = rust_cli_kernel_api::env::EnvPath::new(cwd.to_owned());
    ctx.session = SessionId::new("ses_runs");
    ctx
}

async fn run(tool: &Arc<dyn Tool>, input: Value, ctx: ToolUseContext) -> Result<String, ToolError> {
    let (tx, _rx) = mpsc::channel(4);
    tool.call(input, ctx, tx)
        .await
        .map(|output| output_text(&output))
}

fn failure(result: Result<String, ToolError>) -> String {
    match result {
        Err(ToolError::Failed { message }) => message,
        other => panic!("the call must fail, got {other:?}"),
    }
}

fn running_item() -> Value {
    json!({
        "runId": "dwfrun-running",
        "label": "nightly triage",
        "labelSource": "name",
        "status": "running",
        "ownedByThisSession": true,
        "createdAt": 1_787_302_800_000_i64,
        "updatedAt": 1_787_303_100_000_i64,
        "spentTokens": 1204
    })
}

fn stranded_item() -> Value {
    json!({
        "runId": "dwfrun-stranded",
        "label": "// triage the failing tests",
        "labelSource": "script",
        "status": "running",
        "ownedByThisSession": false,
        "possiblyInterrupted": true,
        "createdAt": 1_787_212_800_000_i64,
        "updatedAt": 1_787_212_860_000_i64,
        "spentTokens": 0
    })
}

// --- ListWorkflowRuns ----------------------------------------------------------------------------------------------

#[tokio::test]
async fn list_without_a_run_service_says_the_capability_is_absent() {
    let tool = tool(tool_names::LIST_WORKFLOW_RUNS, no_service());
    let message = failure(run(&tool, json!({}), context("/workspace/project")).await);
    assert!(
        message.starts_with("workflow_introspection_unavailable:"),
        "{message}"
    );
    assert!(message.contains("This is a capability gap, not an empty project."));
}

#[tokio::test]
async fn list_with_a_port_that_lacks_the_method_gives_the_same_failure() {
    let unbound = tool(tool_names::LIST_WORKFLOW_RUNS, no_service());
    let without_method = tool(
        tool_names::LIST_WORKFLOW_RUNS,
        sessions(FakePort::default()).0,
    );
    let a = failure(run(&unbound, json!({}), context("/w")).await);
    let b = failure(run(&without_method, json!({}), context("/w")).await);
    assert_eq!(a, b);
}

#[tokio::test]
async fn list_queries_the_session_cwd_with_the_default_limit_and_no_status_filter() {
    let (sessions, port) = sessions(FakePort {
        list: Some(json!({"runs": []})),
        ..FakePort::default()
    });
    let tool = tool(tool_names::LIST_WORKFLOW_RUNS, sessions.clone());
    run(&tool, json!({}), context("/workspace/project"))
        .await
        .expect("answers");
    let queries = port.queries.lock().unwrap();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].cwd, "/workspace/project");
    assert_eq!(queries[0].limit, 20);
    assert_eq!(queries[0].statuses, None);
    assert_eq!(sessions.asked.lock().unwrap().as_slice(), ["ses_runs"]);
}

#[tokio::test]
async fn list_passes_an_explicit_limit_and_statuses_and_clamps_the_limit() {
    let (sessions, port) = sessions(FakePort {
        list: Some(json!({"runs": []})),
        ..FakePort::default()
    });
    let tool = tool(tool_names::LIST_WORKFLOW_RUNS, sessions);
    run(
        &tool,
        json!({"limit": 5, "statuses": ["running", "pending"]}),
        context("/w"),
    )
    .await
    .expect("answers");
    run(&tool, json!({"limit": 5000}), context("/w"))
        .await
        .expect("answers");
    run(&tool, json!({"limit": 0}), context("/w"))
        .await
        .expect("answers");
    let queries = port.queries.lock().unwrap();
    assert_eq!(queries[0].limit, 5);
    assert_eq!(queries[0].statuses.as_ref().map(Vec::len), Some(2));
    assert_eq!(queries[1].limit, 50);
    assert_eq!(queries[2].limit, 1);
}

#[tokio::test]
async fn list_rejects_an_unknown_status_as_invalid_input() {
    let tool = tool(tool_names::LIST_WORKFLOW_RUNS, no_service());
    let verdict = tool
        .validate_input(&json!({"statuses": ["paused"]}), &context("/w"))
        .await;
    assert!(matches!(verdict, Validation::Invalid { .. }));
}

#[tokio::test]
async fn list_renders_one_line_per_run_with_iso_timestamps_and_the_truncation_flag() {
    let (sessions, _) = sessions(FakePort {
        list: Some(json!({"runs": [running_item(), stranded_item()], "truncated": true})),
        ..FakePort::default()
    });
    let tool = tool(tool_names::LIST_WORKFLOW_RUNS, sessions);
    let text = run(&tool, json!({}), context("/w")).await.expect("answers");
    let lines: Vec<&str> = text.split('\n').collect();
    assert_eq!(lines[0], r#"<workflow_runs count="2" truncated="true">"#);
    assert_eq!(*lines.last().unwrap(), "</workflow_runs>");
    assert_eq!(lines.len(), 4);
    assert!(lines[1].contains(r#"id="dwfrun-running""#));
    assert!(lines[1].contains(r#"status="running""#));
    assert!(lines[1].contains(r#"label="nightly triage""#));
    assert!(lines[1].contains(r#"owned_by_this_session="true""#));
    assert!(lines[1].contains(r#"spent_tokens="1204""#));
    assert!(lines[1].contains(r#"updated_at="2026-08-21T09:05:00.000Z""#));
    assert!(!lines[1].contains("possibly_interrupted"));
    assert!(lines[2].contains(r#"possibly_interrupted="true""#));
}

#[tokio::test]
async fn list_says_so_in_words_when_the_project_has_no_runs() {
    let (sessions, _) = sessions(FakePort {
        list: Some(json!({"runs": []})),
        ..FakePort::default()
    });
    let tool = tool(tool_names::LIST_WORKFLOW_RUNS, sessions);
    let text = run(&tool, json!({}), context("/w")).await.expect("answers");
    assert!(text.contains(r#"count="0""#));
    assert!(text.to_lowercase().contains("no workflow runs"));
}

#[tokio::test]
async fn list_escapes_a_label_that_would_break_out_of_the_attribute() {
    let mut item = running_item();
    item["label"] = json!("ship \"it\" & <now>\nsecond line");
    let (sessions, _) = sessions(FakePort {
        list: Some(json!({"runs": [item]})),
        ..FakePort::default()
    });
    let tool = tool(tool_names::LIST_WORKFLOW_RUNS, sessions);
    let text = run(&tool, json!({}), context("/w")).await.expect("answers");
    assert!(text.contains(r#"label="ship &quot;it&quot; &amp; &lt;now&gt; second line""#));
    assert_eq!(text.split('\n').count(), 3);
}

#[tokio::test]
async fn list_reports_a_failed_read_as_a_failure_not_an_empty_list() {
    let (sessions, _) = sessions(FakePort {
        broken: true,
        ..FakePort::default()
    });
    let tool = tool(tool_names::LIST_WORKFLOW_RUNS, sessions);
    let message = failure(run(&tool, json!({}), context("/w")).await);
    assert!(message.contains("the journal is unavailable"), "{message}");
}

// --- ResumeWorkflowRun ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn resume_answers_with_the_backgrounded_guidance_for_the_run() {
    let (sessions, port) = sessions(FakePort {
        resume: Some(json!({"ok": true, "runId": "dwfrun-1"})),
        ..FakePort::default()
    });
    let tool = tool(tool_names::RESUME_WORKFLOW_RUN, sessions);
    let text = run(&tool, json!({"run_id": "dwfrun-1"}), context("/w"))
        .await
        .expect("answers");
    assert_eq!(
        text,
        "The workflow run dwfrun-1 has been resumed and is running in the background. It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait."
    );
    assert_eq!(port.resumed.lock().unwrap().as_slice(), ["dwfrun-1"]);
}

#[tokio::test]
async fn resume_maps_each_refusal_to_its_message_and_keeps_the_discriminator_prefix() {
    let cases: [(Value, &str); 6] = [
        (
            json!({"ok": false, "reason": "not_resumable"}),
            "workflow_run_not_resumable:",
        ),
        (
            json!({"ok": false, "reason": "superseded"}),
            "workflow_run_superseded:",
        ),
        (
            json!({"ok": false, "reason": "already_running"}),
            "workflow_run_already_running:",
        ),
        (
            json!({"ok": false, "reason": "script_missing"}),
            "workflow_run_script_missing:",
        ),
        (
            json!({"ok": false, "reason": "script_mismatch"}),
            "workflow_run_script_mismatch:",
        ),
        (
            json!({"ok": false, "reason": "compile_failed", "message": "L1:C1 boom"}),
            "workflow_run_compile_failed:",
        ),
    ];
    for (answer, prefix) in cases {
        let (sessions, _) = sessions(FakePort {
            resume: Some(answer.clone()),
            ..FakePort::default()
        });
        let tool = tool(tool_names::RESUME_WORKFLOW_RUN, sessions);
        let message = failure(run(&tool, json!({"run_id": "dwfrun-1"}), context("/w")).await);
        assert!(message.starts_with(prefix), "{answer} -> {message}");
    }
}

#[tokio::test]
async fn resume_appends_the_compile_detail_to_a_compile_refusal() {
    let (sessions, _) = sessions(FakePort {
        resume: Some(json!({"ok": false, "reason": "compile_failed", "message": "L1:C1 boom"})),
        ..FakePort::default()
    });
    let tool = tool(tool_names::RESUME_WORKFLOW_RUN, sessions);
    let message = failure(run(&tool, json!({"run_id": "dwfrun-1"}), context("/w")).await);
    assert!(message.ends_with("\nL1:C1 boom"), "{message}");
}

#[tokio::test]
async fn resume_of_an_unknown_run_uses_the_shared_run_not_found_text() {
    let (sessions, _) = sessions(FakePort {
        resume: Some(json!({"ok": false, "reason": "not_found"})),
        ..FakePort::default()
    });
    let tool = tool(tool_names::RESUME_WORKFLOW_RUN, sessions);
    let message = failure(run(&tool, json!({"run_id": "dwfrun-9"}), context("/w")).await);
    assert_eq!(
        message,
        "run_not_found: no workflow run with ID dwfrun-9 exists for this project. Use ListWorkflowRuns to see the runs that do."
    );
}

#[tokio::test]
async fn resume_without_a_run_service_says_this_session_cannot_resume() {
    let tool = tool(tool_names::RESUME_WORKFLOW_RUN, no_service());
    let message = failure(run(&tool, json!({"run_id": "dwfrun-1"}), context("/w")).await);
    assert!(
        message.starts_with("workflow_resume_unavailable:"),
        "{message}"
    );
}

// --- ResolveWorkflowQuestion ---------------------------------------------------------------------------------------

#[tokio::test]
async fn resolve_delivers_the_answer_and_says_the_run_keeps_going() {
    let (sessions, port) = sessions(FakePort {
        resolve: Some(ResolveQuestionResult::Resolved {
            qid: QuestionId::new("dwfq-1"),
        }),
        ..FakePort::default()
    });
    let tool = tool(tool_names::RESOLVE_WORKFLOW_QUESTION, sessions);
    let text = run(
        &tool,
        json!({"question_id": "dwfq-1", "answer": "use the staging key"}),
        context("/w"),
    )
    .await
    .expect("answers");
    assert_eq!(
        text,
        "Answer delivered for question dwfq-1. The subagent that asked has resumed its turn with your answer; the run keeps going as before."
    );
    assert_eq!(
        port.answered.lock().unwrap().as_slice(),
        [("dwfq-1".to_owned(), "use the staging key".to_owned())]
    );
}

#[tokio::test]
async fn resolve_passes_the_service_refusal_message_through_unchanged() {
    let message = "Unknown question id dwfq-404. It may be misspelled.".to_owned();
    let (sessions, _) = sessions(FakePort {
        resolve: Some(ResolveQuestionResult::Refused {
            reason: ResolveQuestionRefusalReason::UnknownQuestion,
            message: message.clone(),
        }),
        ..FakePort::default()
    });
    let tool = tool(tool_names::RESOLVE_WORKFLOW_QUESTION, sessions);
    let got = failure(
        run(
            &tool,
            json!({"question_id": "dwfq-404", "answer": "x"}),
            context("/w"),
        )
        .await,
    );
    assert_eq!(got, message);
}

#[tokio::test]
async fn resolve_without_a_run_service_says_this_session_cannot_answer() {
    let tool = tool(tool_names::RESOLVE_WORKFLOW_QUESTION, no_service());
    let message = failure(
        run(
            &tool,
            json!({"question_id": "dwfq-1", "answer": "x"}),
            context("/w"),
        )
        .await,
    );
    assert!(
        message.starts_with("workflow_question_answering_unavailable:"),
        "{message}"
    );
}

// --- GetWorkflowRun (9.42) -------------------------------------------------------------------------------------------

/// A completed run as the detail read answers it. The tool reads the real clock, so only the clock-free clauses are
/// asserted (e.g. "Completed in 1s."); the ages are pinned in the formatter's own tests, which pass a fixed clock.
fn completed_detail() -> Value {
    json!({
        "runId": "wf_done",
        "label": "nightly",
        "labelSource": "name",
        "status": "completed",
        "ownedByThisSession": true,
        "createdAt": 1_000,
        "updatedAt": 2_000,
        "usage": { "spentTokens": 42 },
        "result": "done"
    })
}

fn stopped_detail(reason: &str) -> Value {
    json!({
        "runId": "wf_stop",
        "label": "nightly",
        "labelSource": "name",
        "status": "stopped",
        "stopReason": reason,
        "ownedByThisSession": true,
        "createdAt": 1_000,
        "updatedAt": 2_000,
        "usage": { "spentTokens": 7 }
    })
}

#[tokio::test]
async fn get_asks_the_calling_sessions_port_for_the_run_and_formats_its_facts() {
    let (sessions, port) = sessions(FakePort {
        detail: Some(Some(completed_detail())),
        ..FakePort::default()
    });
    let tool = tool(tool_names::GET_WORKFLOW_RUN, sessions.clone());
    let text = run(&tool, json!({"run_id": "wf_done"}), context("/w"))
        .await
        .expect("answers");
    assert_eq!(port.detailed.lock().unwrap().as_slice(), ["wf_done"]);
    assert_eq!(sessions.asked.lock().unwrap().as_slice(), ["ses_runs"]);
    assert!(
        text.starts_with("<summary>Completed in 1s.</summary>"),
        "{text}"
    );
    assert!(text.contains("<run_id>wf_done</run_id>"), "{text}");
    assert!(
        text.contains(r#"<label source="name">nightly</label>"#),
        "{text}"
    );
    assert!(text.contains("<status>completed</status>"), "{text}");
    assert!(text.contains("<usage>spent_tokens=42</usage>"), "{text}");
    assert!(text.contains("<result>\ndone\n</result>"), "{text}");
}

#[tokio::test]
async fn get_of_an_unknown_run_is_the_shared_run_not_found_failure() {
    let (sessions, _) = sessions(FakePort {
        detail: Some(None),
        ..FakePort::default()
    });
    let tool = tool(tool_names::GET_WORKFLOW_RUN, sessions);
    let message = failure(run(&tool, json!({"run_id": "wf_9"}), context("/w")).await);
    assert_eq!(
        message,
        "run_not_found: no workflow run with ID wf_9 exists for this project. Use ListWorkflowRuns to see the runs that do."
    );
}

#[tokio::test]
async fn get_without_a_run_service_is_the_introspection_unavailable_failure() {
    let tool = tool(tool_names::GET_WORKFLOW_RUN, no_service());
    let message = failure(run(&tool, json!({"run_id": "wf_1"}), context("/w")).await);
    assert!(
        message.starts_with("workflow_introspection_unavailable:"),
        "{message}"
    );
}

#[tokio::test]
async fn get_of_a_stopped_run_names_the_reason_and_says_how_to_continue_it() {
    let (sessions, _) = sessions(FakePort {
        detail: Some(Some(stopped_detail("user"))),
        ..FakePort::default()
    });
    let tool = tool(tool_names::GET_WORKFLOW_RUN, sessions);
    let text = run(&tool, json!({"run_id": "wf_stop"}), context("/w"))
        .await
        .expect("answers");
    assert!(text.contains("<stop_reason>user</stop_reason>"), "{text}");
    assert!(
        text.contains(
            "This run was stopped on purpose by the user: resume it only when the user asks."
        ),
        "{text}"
    );
    assert!(
        text.contains("<resumable>This run can be continued with ResumeWorkflowRun"),
        "{text}"
    );
}

#[tokio::test]
async fn get_of_a_superseded_run_points_at_its_successor_and_offers_no_resume() {
    let mut detail = stopped_detail("superseded");
    detail["supersededBy"] = json!("wf_new");
    let (sessions, _) = sessions(FakePort {
        detail: Some(Some(detail)),
        ..FakePort::default()
    });
    let tool = tool(tool_names::GET_WORKFLOW_RUN, sessions);
    let text = run(&tool, json!({"run_id": "wf_stop"}), context("/w"))
        .await
        .expect("answers");
    assert!(
        text.contains("<superseded_by>wf_new</superseded_by>"),
        "{text}"
    );
    assert!(
        text.contains(
            "<superseded>This run was stopped by an AmendWorkflow and superseded by run wf_new"
        ),
        "{text}"
    );
    assert!(!text.contains("<resumable>"), "{text}");
}

#[tokio::test]
async fn get_of_a_run_another_session_owns_says_so_and_flags_a_live_run_as_unconfirmed() {
    let detail = json!({
        "runId": "wf_other", "label": "x", "labelSource": "script", "status": "running",
        "ownedByThisSession": false, "possiblyInterrupted": true,
        "createdAt": 1_000, "updatedAt": 2_000, "usage": { "spentTokens": 0 }
    });
    let (sessions, _) = sessions(FakePort {
        detail: Some(Some(detail)),
        ..FakePort::default()
    });
    let tool = tool(tool_names::GET_WORKFLOW_RUN, sessions);
    let text = run(&tool, json!({"run_id": "wf_other"}), context("/w"))
        .await
        .expect("answers");
    assert!(text.contains("Owned by another session."), "{text}");
    assert!(
        text.contains("<owned_by_this_session>false</owned_by_this_session>"),
        "{text}"
    );
    assert!(text.contains("<possibly_interrupted>true"), "{text}");
    // 9.42: the journal answers the pending questions for any run, so no "unknown" is written for this one.
    assert!(!text.contains("unknown"), "{text}");
}

#[tokio::test]
async fn get_escapes_a_failure_message_and_names_its_code() {
    let mut detail = stopped_detail("provider");
    detail["status"] = json!("errored");
    detail["stopReason"] = Value::Null;
    detail["error"] = json!({"code": "ScriptError", "message": "bad <tag> & \"quote\""});
    let (sessions, _) = sessions(FakePort {
        detail: Some(Some(detail)),
        ..FakePort::default()
    });
    let tool = tool(tool_names::GET_WORKFLOW_RUN, sessions);
    let text = run(&tool, json!({"run_id": "wf_stop"}), context("/w"))
        .await
        .expect("answers");
    assert!(text.contains("Errored after 1s."), "{text}");
    assert!(
        text.contains(
            r#"<error code="ScriptError">bad &lt;tag&gt; &amp; &quot;quote&quot;</error>"#
        ),
        "{text}"
    );
}

// --- the set and the declarations -----------------------------------------------------------------------------------

/// The detail's text can be long (a result is the run's whole return value), so GetWorkflowRun has Node's own budget of
/// 400 000 bytes, and the list keeps its 24 000. A shared budget would cut a long result before the routing blocks.
#[test]
fn get_has_the_detail_budget_and_the_list_keeps_its_own() {
    let (sessions, _) = sessions(FakePort::default());
    let get = tool(tool_names::GET_WORKFLOW_RUN, sessions.clone());
    let list = tool(tool_names::LIST_WORKFLOW_RUNS, sessions);
    assert_eq!(get.result_budget_truncate_bytes(), Some(400_000));
    assert_eq!(list.result_budget_truncate_bytes(), Some(24_000));
}

#[test]
fn the_four_tools_come_in_node_order() {
    let names: Vec<String> = run_tools(no_service())
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert_eq!(
        names,
        [
            "ListWorkflowRuns",
            "GetWorkflowRun",
            "ResumeWorkflowRun",
            "ResolveWorkflowQuestion"
        ]
    );
}

#[test]
fn only_the_listing_is_read_only_and_each_is_deferred_and_concurrency_safe() {
    let runs = no_service();
    let list = tool(tool_names::LIST_WORKFLOW_RUNS, runs.clone());
    let resume = tool(tool_names::RESUME_WORKFLOW_RUN, runs.clone());
    let resolve = tool(tool_names::RESOLVE_WORKFLOW_QUESTION, runs);
    assert!(list.is_read_only(&json!({})));
    assert!(!resume.is_read_only(&json!({})));
    assert!(!resolve.is_read_only(&json!({})));
    for tool in [&list, &resume, &resolve] {
        assert!(tool.should_defer());
        assert!(tool.is_concurrency_safe(&json!({})));
    }
}
