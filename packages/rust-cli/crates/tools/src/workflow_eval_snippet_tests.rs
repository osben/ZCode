//! EvalWorkflowSnippet's tests (specs/fork-rust-workflow-engine.md, 9.28, W7-8c). They port the cases of Node's
//! `eval-workflow-snippet-tool.test.ts` that the Rust tool shares (sources, the skill gate, the confirmation, the result text)
//! and run the tool's `validate_input`, `check_permissions` and `call` in the executor's order.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::ids::ToolUseId;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::testing::OpsOverride;
use rust_cli_kernel_api::tool::{Tool, ToolError, ToolOutput, ToolUseContext, Validation};
use rust_cli_kernel_api::workflow_analysis::WorkflowDiagnostic;
use rust_cli_kernel_api::workflow_snippet::{
    SnippetCheck, SnippetOutcome, SnippetRequest, WorkflowSnippetError, WorkflowSnippetPort,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::test_more::{Ctx, output_text};

/// The port the tool reaches: a fixed check and a fixed outcome, and a record of every run.
struct FakePort {
    check: Result<SnippetCheck, WorkflowSnippetError>,
    outcome: Result<SnippetOutcome, WorkflowSnippetError>,
    runs: Mutex<Vec<SnippetRequest>>,
}

impl FakePort {
    fn answering(outcome: SnippetOutcome) -> Arc<Self> {
        Arc::new(Self {
            check: Ok(SnippetCheck::Ready { world_run: false }),
            outcome: Ok(outcome),
            runs: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait]
impl WorkflowSnippetPort for FakePort {
    async fn check(&self, _code: &str) -> Result<SnippetCheck, WorkflowSnippetError> {
        self.check.clone()
    }

    async fn eval(&self, request: SnippetRequest) -> Result<SnippetOutcome, WorkflowSnippetError> {
        self.runs.lock().unwrap().push(request);
        self.outcome.clone()
    }
}

/// A session whose history is fixed: the skill probe reads the Skill calls still visible to the model.
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

struct Harness {
    _guard: tempfile::TempDir,
    cwd: PathBuf,
    port: Arc<FakePort>,
    tool: EvalWorkflowSnippetTool,
}

impl Harness {
    fn new(port: Arc<FakePort>) -> Self {
        let guard = tempfile::TempDir::new().expect("tempdir");
        let cwd = guard.path().join("project");
        let tool = EvalWorkflowSnippetTool::new(port.clone());
        Self {
            _guard: guard,
            cwd,
            port,
            tool,
        }
    }

    fn context(&self, history: Vec<Message>) -> ToolUseContext {
        let mut ctx = Ctx::with_ops(Arc::new(History(history))).build();
        ctx.workspace.root = rust_cli_kernel_api::env::EnvPath::new(self.cwd.display().to_string());
        ctx
    }

    fn with_skill(&self) -> ToolUseContext {
        self.context(loaded_skill())
    }

    /// The executor's order: the permission decision first, then the call (a refused decision never reaches it).
    async fn run(&self, input: Value) -> Result<ToolOutput, ToolError> {
        let ctx = self.with_skill();
        if let PermissionDecision::Deny { message } =
            self.tool.check_permissions(&input, &ctx).await
        {
            return Err(ToolError::Failed { message });
        }
        let (tx, _rx) = mpsc::channel(4);
        self.tool.call(input, ctx, tx).await
    }

    fn write(&self, name: &str, text: &str) {
        rust_cli_fs::write_text(&self.cwd.join(name), text).expect("write the snippet file");
    }
}

async fn validation_of(harness: &Harness, input: &Value, history: Vec<Message>) -> Validation {
    let ctx = harness.context(history);
    harness.tool.validate_input(input, &ctx).await
}

fn invalid_message(validation: &Validation) -> (String, Option<i32>) {
    match validation {
        Validation::Invalid {
            message,
            error_code,
        } => (message.clone(), *error_code),
        Validation::Ok => panic!("expected the input to be refused"),
    }
}

fn completed(value: Option<Value>, logs: &[&str]) -> SnippetOutcome {
    SnippetOutcome::Completed {
        value,
        logs: logs.iter().map(|line| (*line).to_owned()).collect(),
        logs_truncated: false,
    }
}

fn diagnostic(line: i64, column: i64, message: &str) -> WorkflowDiagnostic {
    WorkflowDiagnostic {
        code: 2322,
        line,
        column,
        message: message.to_owned(),
    }
}

const READ_ONLY: &str = "return [1, 2, 3].reduce((a, b) => a + b, 0);";
const WITH_WORLD_RUN: &str = "return await world.run('git', ['status']);";

// ---- input shape and the skill gate (validate_input) ----

#[tokio::test]
async fn both_sources_are_refused_with_the_conflict_text_and_the_400_code() {
    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    let input = json!({"code": "return 1;", "path": "snip.ts"});
    let (message, code) = invalid_message(&validation_of(&harness, &input, loaded_skill()).await);
    assert_eq!(code, Some(400));
    assert_eq!(message, EVAL_SOURCE_CONFLICT_ERROR);
    assert!(message.contains("Passing both is ambiguous."));
}

#[tokio::test]
async fn no_source_is_refused_with_the_missing_text_and_the_parse_hint() {
    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    let (message, code) =
        invalid_message(&validation_of(&harness, &json!({}), loaded_skill()).await);
    assert_eq!(code, Some(400));
    assert!(
        message.starts_with("No snippet source arrived."),
        "{message}"
    );
    assert!(message.contains("not valid JSON"), "{message}");
}

#[tokio::test]
async fn a_script_key_the_model_does_not_declare_is_refused() {
    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    let input = json!({"code": "return 1;", "script": "return 1;"});
    let (message, _) = invalid_message(&validation_of(&harness, &input, loaded_skill()).await);
    assert!(message.contains("script"), "{message}");
}

#[tokio::test]
async fn a_timeout_outside_one_second_to_ten_minutes_is_refused() {
    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    for timeout in [999, 600_001] {
        let input = json!({"code": "return 1;", "timeoutMs": timeout});
        let (message, _) = invalid_message(&validation_of(&harness, &input, loaded_skill()).await);
        assert!(message.contains("timeoutMs"), "{timeout}: {message}");
    }
    let ok = json!({"code": "return 1;", "timeoutMs": 1000});
    assert!(matches!(
        validation_of(&harness, &ok, loaded_skill()).await,
        Validation::Ok
    ));
}

#[tokio::test]
async fn without_the_dynamic_workflows_skill_the_call_is_refused_with_428() {
    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    let (message, code) =
        invalid_message(&validation_of(&harness, &json!({"code": "return 1;"}), Vec::new()).await);
    assert_eq!(code, Some(428));
    // Node's shared gate text (core `tool/handlers/workflow-skill-gate.ts`; W9h, 9.64).
    assert_eq!(
        message,
        "EvalWorkflowSnippet needs the `dynamic-workflows` skill loaded in this session before it accepts a script. Call the Skill tool with skill \"dynamic-workflows\" first — it carries the facade declarations the script is checked against, the authoring rules and this tool's full contract — then call EvalWorkflowSnippet again. Nothing was started."
    );
}

// ---- the confirmation (check_permissions) ----

#[tokio::test]
async fn a_read_only_snippet_proceeds_without_a_confirmation() {
    let harness = Harness::new(FakePort::answering(completed(Some(json!(6)), &[])));
    let decision = harness
        .tool
        .check_permissions(&json!({"code": READ_ONLY}), &harness.with_skill())
        .await;
    assert_eq!(
        decision,
        PermissionDecision::Allow {
            updated_input: None
        }
    );
}

#[tokio::test]
async fn a_snippet_with_a_world_run_asks_an_ordinary_confirmation() {
    let port = Arc::new(FakePort {
        check: Ok(SnippetCheck::Ready { world_run: true }),
        outcome: Ok(completed(None, &[])),
        runs: Mutex::new(Vec::new()),
    });
    let harness = Harness::new(port);
    let decision = harness
        .tool
        .check_permissions(&json!({"code": WITH_WORLD_RUN}), &harness.with_skill())
        .await;
    match decision {
        PermissionDecision::Ask {
            message,
            always_ask,
            independent,
            ..
        } => {
            assert!(message.contains("must be confirmed"), "{message}");
            assert!(!always_ask, "EvalWorkflowSnippet is not an always-ask tool");
            assert!(!independent);
        }
        other => panic!("expected an ask, got {other:?}"),
    }
}

#[tokio::test]
async fn a_snippet_that_does_not_compile_proceeds_so_the_call_can_report_its_diagnostics() {
    let port = Arc::new(FakePort {
        check: Ok(SnippetCheck::Diagnostics(vec![diagnostic(1, 7, "bad")])),
        outcome: Ok(SnippetOutcome::Diagnostics(vec![diagnostic(1, 7, "bad")])),
        runs: Mutex::new(Vec::new()),
    });
    let harness = Harness::new(port);
    let decision = harness
        .tool
        .check_permissions(&json!({"code": "return x;"}), &harness.with_skill())
        .await;
    assert!(matches!(decision, PermissionDecision::Allow { .. }));
}

#[tokio::test]
async fn a_port_that_cannot_check_denies_with_its_message() {
    let port = Arc::new(FakePort {
        check: Err(WorkflowSnippetError {
            message: "the compile helper failed: down".to_owned(),
        }),
        outcome: Ok(completed(None, &[])),
        runs: Mutex::new(Vec::new()),
    });
    let harness = Harness::new(port);
    let decision = harness
        .tool
        .check_permissions(&json!({"code": READ_ONLY}), &harness.with_skill())
        .await;
    assert_eq!(
        decision,
        PermissionDecision::Deny {
            message: "the compile helper failed: down".to_owned()
        }
    );
}

// ---- the path source ----

#[tokio::test]
async fn a_path_is_read_whole_even_when_it_starts_with_a_metadata_block() {
    let harness = Harness::new(FakePort::answering(completed(Some(json!(1)), &[])));
    let source = "/* zcode-workflow\n{\"description\":\"not metadata here\"}\n*/\nreturn 1;";
    harness.write("snip.ts", source);
    let decision = harness
        .tool
        .check_permissions(&json!({"path": "snip.ts"}), &harness.with_skill())
        .await;
    assert!(matches!(decision, PermissionDecision::Allow { .. }));
    let (tx, _rx) = mpsc::channel(4);
    harness
        .tool
        .call(json!({"path": "snip.ts"}), harness.with_skill(), tx)
        .await
        .expect("the snippet runs");
    let runs = harness.port.runs.lock().unwrap();
    assert_eq!(runs[0].code, source);
}

#[tokio::test]
async fn a_missing_path_is_denied_and_names_the_file() {
    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    let decision = harness
        .tool
        .check_permissions(&json!({"path": "missing.ts"}), &harness.with_skill())
        .await;
    match decision {
        PermissionDecision::Deny { message } => {
            assert!(
                message.starts_with("The workflow script file missing.ts could not be read:"),
                "{message}"
            );
            assert!(
                message
                    .ends_with("Pass `path` for a file that exists, or submit the script inline.")
            );
        }
        other => panic!("expected a denial, got {other:?}"),
    }
}

#[tokio::test]
async fn a_path_outside_the_workspace_is_denied() {
    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    let decision = harness
        .tool
        .check_permissions(&json!({"path": "../outside.ts"}), &harness.with_skill())
        .await;
    match decision {
        PermissionDecision::Deny { message } => {
            assert!(message.contains("is outside the workspace"), "{message}");
        }
        other => panic!("expected a denial, got {other:?}"),
    }
}

#[tokio::test]
async fn diagnostics_from_a_path_name_the_file_and_line() {
    let port = Arc::new(FakePort {
        check: Ok(SnippetCheck::Diagnostics(vec![diagnostic(
            3,
            5,
            "Cannot find name 'x'.",
        )])),
        outcome: Ok(SnippetOutcome::Diagnostics(vec![diagnostic(
            3,
            5,
            "Cannot find name 'x'.",
        )])),
        runs: Mutex::new(Vec::new()),
    });
    let harness = Harness::new(port);
    harness.write("draft.ts", "const a = 1;\n\nreturn x;");
    let output = harness
        .run(json!({"path": "draft.ts"}))
        .await
        .expect("the call reports diagnostics");
    assert_eq!(
        output_text(&output),
        "The snippet has errors:\ndraft.ts:L3:C5 Cannot find name 'x'.\n\nNOTE: The snippet was NOT executed — fix the errors above and call the tool again."
    );
    assert_eq!(output.display["ok"], json!(false));
}

// ---- the call and the result text ----

#[tokio::test]
async fn a_completed_snippet_reports_its_return_value_and_logs() {
    let harness = Harness::new(FakePort::answering(completed(
        Some(json!({"total": 6})),
        &["step one"],
    )));
    let output = harness
        .run(json!({"code": READ_ONLY}))
        .await
        .expect("the snippet runs");
    let text = output_text(&output);
    assert!(text.starts_with("The snippet completed in "), "{text}");
    assert!(
        text.contains("ms.\nReturn value:\n{\n  \"total\": 6\n}"),
        "{text}"
    );
    assert!(text.ends_with("\n\nLogs:\n- step one"), "{text}");
    assert_eq!(output.display["ok"], json!(true));
    assert_eq!(output.display["logs"], json!(["step one"]));
}

// Fork (W9h, 9.64): Node `createEvalWorkflowSnippetDisplay` names the card kind, so the projection carries the display
// on the row and the card shows `工作流片段 · N ms` (desktop E2E DWY-01). Without `kind` the row had no display.
#[tokio::test]
async fn the_display_names_its_kind_and_carries_the_duration() {
    let harness = Harness::new(FakePort::answering(completed(Some(json!(1)), &[])));
    let output = harness
        .run(json!({"code": READ_ONLY}))
        .await
        .expect("the snippet runs");
    assert_eq!(output.display["kind"], json!("eval_workflow_snippet"));
    assert!(output.display["durationMs"].is_u64(), "{}", output.display);
    assert!(output.display.get("truncated").is_none());
}

// Node keeps the last 40 log entries, each within 1,024 bytes, and the response within 4,000 bytes, and marks the
// display `truncated` when it cut anything.
#[tokio::test]
async fn the_display_keeps_the_log_tail_and_marks_a_cut() {
    let many: Vec<String> = (0..45).map(|index| format!("log {index}")).collect();
    let refs: Vec<&str> = many.iter().map(String::as_str).collect();
    let harness = Harness::new(FakePort::answering(completed(None, &refs)));
    let output = harness
        .run(json!({"code": READ_ONLY}))
        .await
        .expect("the snippet runs");
    let logs = output.display["logs"].as_array().expect("logs");
    assert_eq!(logs.len(), 40);
    assert_eq!(logs[0], json!("log 5"));
    assert_eq!(logs[39], json!("log 44"));
    assert_eq!(output.display["truncated"], json!(true));
}

#[tokio::test]
async fn a_string_return_value_is_shown_unquoted_and_no_value_is_said_so() {
    let harness = Harness::new(FakePort::answering(completed(Some(json!("done")), &[])));
    let text = output_text(
        &harness
            .run(json!({"code": READ_ONLY}))
            .await
            .expect("the snippet runs"),
    );
    assert!(text.ends_with("Return value:\ndone"), "{text}");

    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    let text = output_text(
        &harness
            .run(json!({"code": READ_ONLY}))
            .await
            .expect("the snippet runs"),
    );
    assert!(text.ends_with("It returned no value."), "{text}");
}

#[tokio::test]
async fn truncated_logs_say_so_after_the_last_item() {
    let port = FakePort::answering(SnippetOutcome::Completed {
        value: None,
        logs: vec!["a".to_owned()],
        logs_truncated: true,
    });
    let harness = Harness::new(port);
    let text = output_text(
        &harness
            .run(json!({"code": READ_ONLY}))
            .await
            .expect("the snippet runs"),
    );
    assert!(
        text.ends_with("\n\nLogs:\n- a\n- … (logs truncated)"),
        "{text}"
    );
}

#[tokio::test]
async fn a_failed_snippet_reports_its_code_and_message() {
    let harness = Harness::new(FakePort::answering(SnippetOutcome::Failed {
        code: "Interrupted".to_owned(),
        message: "exceeded its wall-clock timeout of 1000ms".to_owned(),
        logs: vec!["before".to_owned()],
        logs_truncated: false,
    }));
    let output = harness
        .run(json!({"code": READ_ONLY}))
        .await
        .expect("a failed snippet is an output");
    assert_eq!(
        output_text(&output),
        "The snippet failed (Interrupted): exceeded its wall-clock timeout of 1000ms\n\nLogs:\n- before"
    );
    assert_eq!(output.display["ok"], json!(false));
}

#[tokio::test]
async fn an_inline_snippet_reports_diagnostics_without_a_location() {
    let port = FakePort::answering(SnippetOutcome::Diagnostics(vec![diagnostic(2, 9, "bad")]));
    let harness = Harness::new(port);
    let output = harness
        .run(json!({"code": "const x = 1;\nreturn y;"}))
        .await
        .expect("the call reports diagnostics");
    assert_eq!(
        output_text(&output),
        "The snippet has errors:\nL2:C9 bad\n\nNOTE: The snippet was NOT executed — fix the errors above and call the tool again."
    );
    assert_eq!(output.display["diagnostics"][0]["line"], json!(2));
}

#[tokio::test]
async fn a_port_failure_fails_the_call_with_its_message() {
    let port = Arc::new(FakePort {
        check: Ok(SnippetCheck::Ready { world_run: false }),
        outcome: Err(WorkflowSnippetError {
            message: "the workflow engine failed: journal".to_owned(),
        }),
        runs: Mutex::new(Vec::new()),
    });
    let harness = Harness::new(port);
    let error = harness
        .run(json!({"code": READ_ONLY}))
        .await
        .expect_err("a port failure fails the call");
    match error {
        ToolError::Failed { message } => assert_eq!(message, "the workflow engine failed: journal"),
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[tokio::test]
async fn the_requested_timeout_is_passed_and_the_default_is_one_minute() {
    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    harness.run(json!({"code": READ_ONLY})).await.expect("runs");
    harness
        .run(json!({"code": READ_ONLY, "timeoutMs": 5000}))
        .await
        .expect("runs");
    let runs = harness.port.runs.lock().unwrap();
    assert_eq!(runs[0].timeout_ms, 60_000);
    assert_eq!(runs[1].timeout_ms, 5_000);
    assert_eq!(runs[0].cwd, harness.cwd);
}

#[tokio::test]
async fn the_snippet_that_was_approved_is_the_snippet_that_runs() {
    let port = Arc::new(FakePort {
        check: Ok(SnippetCheck::Ready { world_run: true }),
        outcome: Ok(completed(None, &[])),
        runs: Mutex::new(Vec::new()),
    });
    let harness = Harness::new(port);
    let ctx = harness.with_skill();
    let input = json!({"code": WITH_WORLD_RUN});
    let decision = harness.tool.check_permissions(&input, &ctx).await;
    assert!(matches!(decision, PermissionDecision::Ask { .. }));
    let (tx, _rx) = mpsc::channel(4);
    harness
        .tool
        .call(input, ctx, tx)
        .await
        .expect("the approved snippet runs");
    assert_eq!(harness.port.runs.lock().unwrap()[0].code, WITH_WORLD_RUN);
}

#[test]
fn the_tool_is_deferred_read_only_false_and_budgeted_to_24000_bytes() {
    let tool = EvalWorkflowSnippetTool::new(FakePort::answering(completed(None, &[])));
    assert_eq!(tool.name(), "EvalWorkflowSnippet");
    assert!(tool.should_defer());
    assert!(!tool.is_read_only(&json!({})));
    assert_eq!(tool.result_budget_truncate_bytes(), Some(24_000));
    assert_eq!(
        tool.input_schema(),
        contract("EvalWorkflowSnippet").input_schema
    );
}

// ocr round 1 (PR #584): a `path` is contained by its real location, so a symlink inside the workspace cannot lead out.

#[cfg(unix)]
#[tokio::test]
async fn a_symlink_inside_the_workspace_that_leads_out_is_denied() {
    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    harness.write("keep.ts", "return 0;");
    let outside = harness.cwd.parent().expect("a parent").join("outside.ts");
    rust_cli_fs::write_text(&outside, "return 1;").expect("the outside file");
    rust_cli_fs::symlink(&outside, &harness.cwd.join("link.ts")).expect("the symlink");
    let decision = harness
        .tool
        .check_permissions(&json!({"path": "link.ts"}), &harness.with_skill())
        .await;
    match decision {
        PermissionDecision::Deny { message } => {
            assert!(message.contains("is outside the workspace"), "{message}");
        }
        other => panic!("expected a denial, got {other:?}"),
    }
    assert!(harness.port.runs.lock().unwrap().is_empty());
}

// ocr round 1 (PR #584): a snippet with world.run must not run without the confirmation of its own call.

#[tokio::test]
async fn a_world_run_snippet_without_its_confirmation_is_not_run_and_the_model_is_asked_to_call_again()
 {
    let port = Arc::new(FakePort {
        check: Ok(SnippetCheck::Ready { world_run: true }),
        outcome: Ok(completed(None, &[])),
        runs: Mutex::new(Vec::new()),
    });
    let harness = Harness::new(port);
    let (tx, _rx) = mpsc::channel(4);
    let error = harness
        .tool
        .call(json!({"code": WITH_WORLD_RUN}), harness.with_skill(), tx)
        .await
        .expect_err("no confirmation, no run");
    match error {
        ToolError::Failed { message } => {
            assert!(message.contains("no confirmation"), "{message}");
            assert!(message.contains("Call it again"), "{message}");
        }
        other => panic!("expected a failure, got {other:?}"),
    }
    assert!(harness.port.runs.lock().unwrap().is_empty(), "nothing ran");
}

#[tokio::test]
async fn the_approval_table_evicts_only_the_oldest_approval() {
    let port = Arc::new(FakePort {
        check: Ok(SnippetCheck::Ready { world_run: true }),
        outcome: Ok(completed(None, &[])),
        runs: Mutex::new(Vec::new()),
    });
    let harness = Harness::new(port);
    let input = json!({"code": WITH_WORLD_RUN});
    for index in 0..=256 {
        let mut ctx = harness.with_skill();
        ctx.tool_use = ToolUseId::new(format!("toolu_{index}"));
        let decision = harness.tool.check_permissions(&input, &ctx).await;
        assert!(matches!(decision, PermissionDecision::Ask { .. }));
    }
    // The newest approval survives the cap; the oldest (toolu_0) was evicted.
    let mut newest = harness.with_skill();
    newest.tool_use = ToolUseId::new("toolu_256");
    let (tx, _rx) = mpsc::channel(4);
    harness
        .tool
        .call(input.clone(), newest, tx)
        .await
        .expect("the newest approval still runs");
    let mut oldest = harness.with_skill();
    oldest.tool_use = ToolUseId::new("toolu_0");
    let (tx, _rx) = mpsc::channel(4);
    assert!(harness.tool.call(input, oldest, tx).await.is_err());
}

#[tokio::test]
async fn reading_a_path_leaves_the_executor_free_while_the_file_is_read() {
    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    harness.write("snip.ts", READ_ONLY);
    let ctx = harness.with_skill();
    let finished = AtomicBool::new(false);
    let saw_read_in_flight = AtomicBool::new(false);
    let decide = async {
        let decision = harness
            .tool
            .check_permissions(&json!({"path": "snip.ts"}), &ctx)
            .await;
        finished.store(true, Ordering::SeqCst);
        decision
    };
    // Polled on the same single-thread executor as the decision: it runs while the read is still in flight only if the
    // read does not hold the executor.
    let probe = async {
        saw_read_in_flight.store(!finished.load(Ordering::SeqCst), Ordering::SeqCst);
    };
    let (decision, ()) = tokio::join!(decide, probe);
    assert!(
        saw_read_in_flight.load(Ordering::SeqCst),
        "the snippet file was read on the executor thread"
    );
    assert!(matches!(decision, PermissionDecision::Allow { .. }));
}

#[tokio::test]
async fn a_repeated_check_for_one_tool_use_keeps_one_approval() {
    let port = Arc::new(FakePort {
        check: Ok(SnippetCheck::Ready { world_run: true }),
        outcome: Ok(completed(None, &[])),
        runs: Mutex::new(Vec::new()),
    });
    let harness = Harness::new(port);
    let input = json!({"code": WITH_WORLD_RUN});
    let mut ctx = harness.with_skill();
    ctx.tool_use = ToolUseId::new("toolu_repeated");
    for _ in 0..2 {
        assert!(matches!(
            harness.tool.check_permissions(&input, &ctx).await,
            PermissionDecision::Ask { .. }
        ));
    }
    assert_eq!(harness.tool.pending(), 1);
}

#[tokio::test]
async fn an_explicit_null_is_refused_by_the_schema_as_zod_refuses_it() {
    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    for input in [
        json!({"code": null}),
        json!({"path": null}),
        json!({"code": "return 1;", "timeoutMs": null}),
    ] {
        let (message, code) =
            invalid_message(&validation_of(&harness, &input, loaded_skill()).await);
        assert_eq!(code, None, "a schema refusal has no error code: {input}");
        assert!(message.contains("null"), "{input}: {message}");
    }
}

#[tokio::test]
async fn an_integral_timeout_written_as_a_float_is_accepted_as_zod_accepts_it() {
    let harness = Harness::new(FakePort::answering(completed(None, &[])));
    let input = json!({"code": "return 1;", "timeoutMs": 5000.0});
    assert!(matches!(
        validation_of(&harness, &input, loaded_skill()).await,
        Validation::Ok
    ));
    let fractional = json!({"code": "return 1;", "timeoutMs": 5000.5});
    let (message, code) =
        invalid_message(&validation_of(&harness, &fractional, loaded_skill()).await);
    assert_eq!(code, None);
    assert!(message.contains("timeoutMs"), "{message}");
}
