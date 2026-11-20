//! Ported from `create-workflow-tool.test.ts` (the input, `max_concurrency`, `subagent_model` and saved-source cases) and
//! `create-workflow-permission.test.ts` (the confirmation, the always-allow chain and the backgrounded submit). The
//! causality-graph and window-display cases, the model-name bindings and the settings window are not ported (W7-8a
//! divergences, specs/fork-rust-workflow-engine.md 9.27). These run the tool's `validate_input`, `check_permissions`
//! and `call` directly, in the executor's order.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::ids::{SessionId, ToolUseId, WorkflowRunId};
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::orchestration::PermissionGate;
use rust_cli_kernel_api::permission::{
    PermissionDecision, PermissionMode, PermissionRule, PermissionRules, RuleBehavior, RuleSource,
    SourcedRule, syntax::parse_rule,
};
use rust_cli_kernel_api::testing::OpsOverride;
use rust_cli_kernel_api::tool::{Tool, ToolError, ToolOutput, ToolUseContext, Validation};
use rust_cli_kernel_api::workflow_analysis::{
    WorkflowAnalysis, WorkflowAnalysisError, WorkflowAnalyzer, WorkflowDiagnostic,
};
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, DynamicWorkflowRunPort, DynamicWorkflowRunSessions, SubmitRequest,
};
use rust_cli_policy::PolicyGate;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::saved_workflow::{ArgDecl, ArgType, Meta, Scope, Store};
use crate::test_more::{Ctx, output_text};

/// Test file IO through the fs crate's helpers (std::fs is disallowed in this crate).
mod fs {
    use std::io;
    use std::path::Path;

    pub fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
        rust_cli_fs::read_text(path.as_ref())
    }

    pub fn write(path: impl AsRef<Path>, text: &str) -> io::Result<()> {
        rust_cli_fs::write_text(path.as_ref(), text)
    }

    pub fn exists(path: impl AsRef<Path>) -> bool {
        rust_cli_fs::is_regular_file(path.as_ref())
    }
}

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

/// A run port that records each submit. `fail` makes the submit a wiring fault.
struct FakeRun {
    submits: Mutex<Vec<SubmitRequest>>,
    fail: bool,
    default_concurrency: Option<usize>,
}

impl FakeRun {
    fn new(default_concurrency: Option<usize>, fail: bool) -> Arc<Self> {
        Arc::new(Self {
            submits: Mutex::new(Vec::new()),
            fail,
            default_concurrency,
        })
    }

    fn submits(&self) -> Vec<SubmitRequest> {
        self.submits.lock().unwrap().clone()
    }
}

#[async_trait]
impl DynamicWorkflowRunPort for FakeRun {
    fn default_concurrency(&self) -> Option<usize> {
        self.default_concurrency
    }

    async fn submit(
        &self,
        request: SubmitRequest,
    ) -> Result<WorkflowRunId, DynamicWorkflowRunError> {
        self.submits.lock().unwrap().push(request);
        if self.fail {
            return Err(DynamicWorkflowRunError::new("the journal is unavailable"));
        }
        Ok(WorkflowRunId::new("run-1"))
    }
}

/// A session whose history is fixed: the probe reads the Skill calls still visible to the model.
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

/// The one-port form the harness uses: every session answers with the same port.
struct OneSession(Arc<dyn DynamicWorkflowRunPort>);

impl DynamicWorkflowRunSessions for OneSession {
    fn for_session(&self, _session: &SessionId) -> Arc<dyn DynamicWorkflowRunPort> {
        self.0.clone()
    }
}

/// Sessions that answer each session with its own port, as the run service does: one port per parent session (9.29,
/// divergence 322). A session with no port answers with a port that fails.
struct PerSession(Vec<(&'static str, Arc<FakeRun>)>);

impl DynamicWorkflowRunSessions for PerSession {
    fn for_session(&self, session: &SessionId) -> Arc<dyn DynamicWorkflowRunPort> {
        match self.0.iter().find(|(id, _)| *id == session.as_str()) {
            Some((_, port)) => port.clone(),
            None => FakeRun::new(None, true),
        }
    }
}

#[tokio::test]
async fn a_create_workflow_call_submits_through_the_port_of_its_own_session() {
    let first = FakeRun::new(Some(4), false);
    let second = FakeRun::new(Some(9), false);
    let sessions: Arc<dyn DynamicWorkflowRunSessions> = Arc::new(PerSession(vec![
        ("ses_first", first.clone()),
        ("ses_second", second.clone()),
    ]));
    let guard = tempfile::TempDir::new().expect("tempdir");
    let root = guard.path().to_path_buf();
    let cwd = root.join("project");
    let tool =
        CreateWorkflowTool::with_sessions(Arc::new(Checker), Some(sessions), root.join("home"));
    let mut ctx = Ctx::with_ops(Arc::new(History(loaded_skill()))).build();
    ctx.workspace.root = rust_cli_kernel_api::env::EnvPath::new(cwd.display().to_string());
    ctx.session = SessionId::new("ses_second");
    let input = json!({"name": "pr-review", "script": CLEAN, "max_concurrency": 7});
    let decision = tool.check_permissions(&input, &ctx).await;
    assert!(
        !matches!(decision, PermissionDecision::Deny { .. }),
        "the clean script is asked, not denied"
    );
    let (tx, _rx) = mpsc::channel(4);
    let output = tool.call(input, ctx, tx).await.expect("the call runs");
    let text = output_text(&output);

    assert!(
        first.submits().is_empty(),
        "the other session's port is not used"
    );
    let submits = second.submits();
    assert_eq!(
        submits.len(),
        1,
        "the calling session's port receives the submit"
    );
    assert_eq!(
        submits[0].parent_session_id,
        Some(SessionId::new("ses_second")),
        "the run is parented by the calling session"
    );
    assert!(
        text.contains("with ID: run-1"),
        "the port's run id is the result: {text}"
    );
    assert_eq!(
        submits[0].max_concurrency,
        Some(7),
        "the limit the call gave reaches the calling session's port"
    );
    assert!(
        text.contains("At most 7 subagents run at once."),
        "a limit that is not the default is said without the default mark: {text}"
    );
}

const CLEAN: &str =
    "interface R { done: boolean }\nconst r = await agent(\"a\").ask<R>(\"do\");\nreturn r.done;";

struct Harness {
    _guard: tempfile::TempDir,
    cwd: PathBuf,
    home: PathBuf,
    port: Option<Arc<FakeRun>>,
    tool: CreateWorkflowTool,
}

impl Harness {
    fn new(port: Option<Arc<FakeRun>>) -> Self {
        let guard = tempfile::TempDir::new().expect("tempdir");
        let root = guard.path().to_path_buf();
        let cwd = root.join("project");
        let home = root.join("home");
        let runs = port.clone().map(|port| {
            Arc::new(OneSession(port as Arc<dyn DynamicWorkflowRunPort>))
                as Arc<dyn DynamicWorkflowRunSessions>
        });
        let tool = CreateWorkflowTool::with_sessions(Arc::new(Checker), runs, home.clone());
        Self {
            _guard: guard,
            cwd,
            home,
            port,
            tool,
        }
    }

    fn store(&self) -> Store {
        Store::new(&self.cwd, &self.home)
    }

    fn context(&self, history: Vec<Message>) -> ToolUseContext {
        let mut ctx = Ctx::with_ops(Arc::new(History(history))).build();
        ctx.workspace.root = rust_cli_kernel_api::env::EnvPath::new(self.cwd.display().to_string());
        ctx
    }

    fn with_skill(&self) -> ToolUseContext {
        self.context(loaded_skill())
    }

    fn draft(&self, file: &str) -> PathBuf {
        self.cwd.join(".zcode/workflow-drafts").join(file)
    }

    /// The executor's order: the permission decision, then the call (a refused decision never reaches the call).
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

    async fn decide(&self, input: &Value) -> PermissionDecision {
        self.tool.check_permissions(input, &self.with_skill()).await
    }

    /// The call alone, as if no permission decision had been made for it.
    async fn call_without_decision(&self, input: Value) -> Result<ToolOutput, ToolError> {
        let (tx, _rx) = mpsc::channel(4);
        self.tool.call(input, self.with_skill(), tx).await
    }
}

fn inline(script: &str) -> Value {
    json!({"name": "pr-review", "script": script})
}

fn submits_of(harness: &Harness) -> Vec<SubmitRequest> {
    harness
        .port
        .as_ref()
        .map_or_else(Vec::new, |port| port.submits())
}

fn message_of(error: &ToolError) -> String {
    match error {
        ToolError::Failed { message } | ToolError::InvalidInput { message } => message.clone(),
        other => panic!("unexpected error: {other:?}"),
    }
}

fn error_code_of(validation: Validation) -> Option<i32> {
    match validation {
        Validation::Invalid { error_code, .. } => error_code,
        Validation::Ok => None,
    }
}

fn saved_meta(args: Option<Vec<(String, ArgDecl)>>) -> Meta {
    Meta {
        description: "nightly".to_owned(),
        when_to_use: None,
        args,
    }
}

fn arg(ty: ArgType, required: Option<bool>, default: Option<Value>) -> ArgDecl {
    ArgDecl {
        ty,
        description: None,
        required,
        default,
    }
}

/// The policy chain's decision for CreateWorkflow in `mode` under `rules`: `PolicyGate::decide`, the executor's path.
async fn chain_decision(
    harness: &Harness,
    rules: PermissionRules,
    mode: PermissionMode,
    input: &Value,
) -> PermissionDecision {
    let gate = PolicyGate::new(rules);
    let mut ctx = harness.with_skill();
    ctx.mode = mode;
    ctx.base_mode = mode;
    gate.decide(&harness.tool, input, &ctx).await
}

fn rule_set(source: RuleSource, behavior: RuleBehavior) -> PermissionRules {
    PermissionRules {
        version: 1,
        rules: vec![SourcedRule {
            source,
            behavior,
            rule: parse_rule("CreateWorkflow"),
        }],
        ..PermissionRules::default()
    }
}

#[test]
fn the_tool_is_named_deferred_and_not_read_only_and_keeps_the_node_result_budget() {
    let harness = Harness::new(None);
    assert_eq!(harness.tool.name(), "CreateWorkflow");
    assert!(harness.tool.should_defer());
    assert!(!harness.tool.is_read_only(&json!({})));
    assert!(harness.tool.is_concurrency_safe(&json!({})));
    assert_eq!(harness.tool.result_budget_truncate_bytes(), Some(24_000));
}

/// Node `alwaysAsk` with `allowAlways: "session"`: a clean script asks in every mode, and the only option the ask
/// offers beyond allow-once is the whole-tool rule for this session.
#[tokio::test]
async fn a_clean_script_always_asks_and_offers_an_always_allow_for_this_tool() {
    let harness = Harness::new(None);
    let decision = harness.decide(&inline(CLEAN)).await;
    match decision {
        PermissionDecision::Ask {
            suggestions,
            always_ask,
            independent,
            once,
            ..
        } => {
            assert!(always_ask, "asked in every mode");
            assert!(!independent, "the always-allow option is offered");
            assert!(!once);
            assert_eq!(
                suggestions,
                vec![PermissionRule {
                    tool: "CreateWorkflow".to_owned(),
                    content: None
                }]
            );
        }
        other => panic!("a clean script asks: {other:?}"),
    }
}

/// Only a session allow rule skips the ask. A project or user allow rule does not, in any mode, and a deny rule denies.
#[tokio::test]
async fn the_ask_goes_through_the_policy_chain_and_only_a_session_rule_skips_it() {
    let harness = Harness::new(None);
    let input = inline(CLEAN);
    for mode in [
        PermissionMode::Default,
        PermissionMode::AcceptEdits,
        PermissionMode::Plan,
        PermissionMode::Guarded,
        PermissionMode::BypassPermissions,
    ] {
        let decision = chain_decision(&harness, PermissionRules::default(), mode, &input).await;
        assert!(
            matches!(
                decision,
                PermissionDecision::Ask {
                    always_ask: true,
                    ..
                }
            ),
            "{mode:?} asks: {decision:?}"
        );
        for source in [RuleSource::UserSettings, RuleSource::ProjectSettings] {
            let decision = chain_decision(
                &harness,
                rule_set(source, RuleBehavior::Allow),
                mode,
                &input,
            )
            .await;
            assert!(
                matches!(
                    decision,
                    PermissionDecision::Ask {
                        always_ask: true,
                        ..
                    }
                ),
                "{mode:?} under {source:?} allow still asks: {decision:?}"
            );
        }
    }
    let session = chain_decision(
        &harness,
        rule_set(RuleSource::Session, RuleBehavior::Allow),
        PermissionMode::BypassPermissions,
        &input,
    )
    .await;
    assert!(
        matches!(session, PermissionDecision::Allow { .. }),
        "a session allow skips the ask: {session:?}"
    );
    let deny = chain_decision(
        &harness,
        rule_set(RuleSource::ProjectSettings, RuleBehavior::Deny),
        PermissionMode::BypassPermissions,
        &input,
    )
    .await;
    assert!(
        matches!(deny, PermissionDecision::Deny { .. }),
        "a deny rule still denies: {deny:?}"
    );
}

#[tokio::test]
async fn exactly_one_source_is_required_and_args_belong_to_the_path_source() {
    let harness = Harness::new(None);
    let ctx = harness.with_skill();
    let none = harness
        .tool
        .validate_input(&json!({"name": "x"}), &ctx)
        .await;
    assert!(
        matches!(
            &none,
            Validation::Invalid { message, error_code: Some(400) }
                if message.contains("No workflow source arrived")
        ),
        "{none:?}"
    );
    let two = harness
        .tool
        .validate_input(&json!({"script": CLEAN, "path": "a.ts"}), &ctx)
        .await;
    assert!(
        matches!(
            &two,
            Validation::Invalid { message, error_code: Some(400) }
                if message.contains("Provide exactly one workflow source")
        ),
        "{two:?}"
    );
    let args = harness
        .tool
        .validate_input(&json!({"script": CLEAN, "args": {"n": 1}}), &ctx)
        .await;
    assert!(
        matches!(
            &args,
            Validation::Invalid { message, error_code: Some(400) }
                if message.contains("`args` belongs to the `path` source")
        ),
        "{args:?}"
    );
}

#[tokio::test]
async fn a_script_without_the_skill_is_refused_with_428_and_a_saved_run_is_not() {
    let harness = Harness::new(None);
    let no_skill = harness.context(Vec::new());
    let script = harness.tool.validate_input(&inline(CLEAN), &no_skill).await;
    assert_eq!(error_code_of(script), Some(428));
    let saved = harness
        .tool
        .validate_input(&json!({"saved": {"name": "nightly"}}), &no_skill)
        .await;
    assert!(
        matches!(saved, Validation::Ok),
        "a saved run needs no skill"
    );
}

/// Node `resolveCreateSubagentModel`: a host with no model catalog refuses the field outright, before any disk read.
#[tokio::test]
async fn a_subagent_model_is_refused_on_a_host_with_no_model_catalog() {
    let harness = Harness::new(None);
    let input = json!({"script": CLEAN, "subagent_model": "openai/gpt"});
    let validation = harness
        .tool
        .validate_input(&input, &harness.with_skill())
        .await;
    assert!(
        matches!(
            &validation,
            Validation::Invalid { message, error_code: Some(400) }
                if message == "This host cannot choose a subagent model; omit subagent_model."
        ),
        "{validation:?}"
    );
}

#[tokio::test]
async fn max_concurrency_must_be_positive_and_the_name_must_not_be_empty() {
    let harness = Harness::new(None);
    let ctx = harness.with_skill();
    let zero = harness
        .tool
        .validate_input(&json!({"script": CLEAN, "max_concurrency": 0}), &ctx)
        .await;
    assert!(
        matches!(zero, Validation::Invalid { .. }),
        "zero is not a limit"
    );
    let empty = harness
        .tool
        .validate_input(&json!({"script": CLEAN, "name": ""}), &ctx)
        .await;
    assert!(matches!(empty, Validation::Invalid { .. }), "an empty name");
    let fine = harness
        .tool
        .validate_input(&json!({"script": CLEAN, "max_concurrency": 32}), &ctx)
        .await;
    assert!(matches!(fine, Validation::Ok), "32 is a limit");
}

/// A clean inline script is saved as a draft named after the run, asked about, and started in the background. The
/// result names the run, says it is not to be polled, and names the draft file for the next revision.
#[tokio::test]
async fn a_clean_inline_script_is_drafted_asked_and_started_in_the_background() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    let output = harness.run(inline(CLEAN)).await.expect("the call runs");
    let text = output_text(&output);
    assert!(
        text.starts_with(
            "The workflow script compiled cleanly and the run started in the background with ID: run-1. It is still running"
        ),
        "{text}"
    );
    assert!(
        text.contains("Do not wait for it or poll it with TaskOutput"),
        "{text}"
    );
    assert!(
        text.ends_with(
            "The script is saved at .zcode/workflow-drafts/pr-review.dwf.ts; to revise it later, edit that file and pass `path` to AmendWorkflow."
        ),
        "{text}"
    );
    assert_eq!(output.display["status"], "backgrounded");
    assert_eq!(output.display["backgroundTaskId"], "run-1");
    assert_eq!(output.display["ok"], true);
    let draft = harness.draft("pr-review.dwf.ts");
    assert_eq!(fs::read_to_string(&draft).expect("draft"), CLEAN);
    let submits = submits_of(&harness);
    assert_eq!(submits.len(), 1);
    let request = &submits[0];
    assert_eq!(request.script_text, CLEAN);
    assert_eq!(request.name.as_deref(), Some("pr-review"));
    assert_eq!(request.cwd, harness.cwd.display().to_string());
    assert_eq!(request.args, None, "an inline run has no arguments");
    assert_eq!(request.max_concurrency, None);
    assert_eq!(
        request.script_path.as_deref(),
        Some(draft.display().to_string().as_str())
    );
    assert!(
        request.parent_session_id.is_some(),
        "the parent session is the call's session"
    );
    assert!(
        request.tool_call_id.is_some(),
        "the run links to its tool call"
    );
}

#[tokio::test]
async fn a_second_draft_under_the_same_name_takes_the_next_free_file_name() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    harness.run(inline(CLEAN)).await.expect("first");
    harness.run(inline(CLEAN)).await.expect("second");
    assert!(fs::exists(harness.draft("pr-review.dwf.ts")));
    assert!(fs::exists(harness.draft("pr-review-2.dwf.ts")));
}

/// Node `draftSlug`: whitespace becomes `-`, characters outside letters, digits, `_`, `.`, `-` go, the stem is capped at
/// 64 characters and trimmed of leading and trailing `.`/`-`; nothing usable (or only dots) falls back to `workflow`.
#[test]
fn draft_names_follow_the_node_slug_rule() {
    assert_eq!(draft_slug("PR review #12"), "PR-review-12");
    assert_eq!(draft_slug("a/b:c"), "abc");
    assert_eq!(draft_slug("..  "), "workflow");
    assert_eq!(draft_slug("   "), "workflow");
    assert_eq!(draft_slug("-x-"), "x");
    assert_eq!(draft_slug("评审流程"), "评审流程");
    assert_eq!(draft_slug(&"a".repeat(100)).chars().count(), 64);
}

/// A script that does not check gets its diagnostics, in file lines, and a note that names the draft. Nothing is
/// asked and nothing is submitted, but the draft is still written: the model edits that file and resubmits by `path`.
#[tokio::test]
async fn a_script_that_does_not_check_gets_file_line_diagnostics_and_no_run() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    let script = "const x: number = BROKEN;";
    let input = inline(script);
    assert!(matches!(
        harness.decide(&input).await,
        PermissionDecision::Allow { .. }
    ));
    let output = harness.run(input).await.expect("the call runs");
    let text = output_text(&output);
    assert!(
        text.starts_with("The workflow script has errors:\n"),
        "{text}"
    );
    assert!(
        text.contains(
            ".zcode/workflow-drafts/pr-review.dwf.ts:L1:C7 Type 'string' is not assignable to type 'number'."
        ),
        "{text}"
    );
    assert!(
        text.contains(
            "NOTE: The workflow was NOT executed. The script is saved at .zcode/workflow-drafts/pr-review.dwf.ts. Edit that file in place and resubmit with `path: \".zcode/workflow-drafts/pr-review.dwf.ts\"` — do not paste the script inline again."
        ),
        "{text}"
    );
    assert_eq!(output.display["ok"], false);
    assert_eq!(
        fs::read_to_string(harness.draft("pr-review.dwf.ts")).expect("draft"),
        script
    );
    assert!(
        submits_of(&harness).is_empty(),
        "a script that does not check is never submitted"
    );
}

/// A checker that cannot answer denies the decision, so the call never runs and nothing is submitted.
#[tokio::test]
async fn a_checker_that_cannot_answer_denies_the_decision() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    let input = inline("return 'FAIL';");
    match harness.decide(&input).await {
        PermissionDecision::Deny { message } => {
            assert_eq!(message, "the helper is not running");
        }
        other => panic!("denied: {other:?}"),
    }
    assert!(submits_of(&harness).is_empty());
}

/// Node `launch` without a port: the script is typechecked and the call says it was not executed, rather than
/// pretending a run started. The draft is still written (Node writes it before the port check).
#[tokio::test]
async fn without_a_run_port_a_clean_script_is_only_typechecked() {
    let harness = Harness::new(None);
    let output = harness.run(inline(CLEAN)).await.expect("the call runs");
    assert_eq!(
        output_text(&output),
        "The workflow script compiled cleanly.\n\nNOTE: The workflow was NOT executed — workflow execution is not available in this session, so the script was only typechecked."
    );
    assert!(fs::exists(harness.draft("pr-review.dwf.ts")));
}

/// A refused submit is a tool failure. The call never reports a background run it did not start.
#[tokio::test]
async fn a_failed_submit_fails_the_call_and_reports_no_background_run() {
    let harness = Harness::new(Some(FakeRun::new(None, true)));
    let error = harness
        .run(inline(CLEAN))
        .await
        .expect_err("the submit failed");
    assert!(
        message_of(&error).contains("the journal is unavailable"),
        "{error:?}"
    );
    assert_eq!(submits_of(&harness).len(), 1);
}

/// Node `resolveInput` (saved): the definition's body runs, the arguments are validated and defaulted, and the run
/// works from a copy of the file that keeps its metadata block.
#[tokio::test]
async fn a_saved_workflow_runs_its_body_with_validated_arguments_from_a_working_copy() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    let declared = vec![
        ("n".to_owned(), arg(ArgType::Number, None, Some(json!(3)))),
        ("mode".to_owned(), arg(ArgType::String, Some(true), None)),
    ];
    let store = harness.store();
    store
        .save(
            "nightly",
            &saved_meta(Some(declared)),
            "return n;",
            Scope::Project,
        )
        .expect("save");
    let source = fs::read_to_string(store.path(Scope::Project, "nightly")).expect("source");
    let output = harness
        .run(json!({"saved": {"name": "nightly", "args": {"mode": "fast"}}}))
        .await
        .expect("the call runs");
    let submits = submits_of(&harness);
    let request = &submits[0];
    assert_eq!(request.script_text, "return n;");
    assert_eq!(request.name.as_deref(), Some("nightly"));
    assert_eq!(
        request.args,
        Some(json!({"n": 3, "mode": "fast"}).as_object().unwrap().clone())
    );
    assert_eq!(
        fs::read_to_string(harness.draft("nightly.dwf.ts")).expect("copy"),
        source
    );
    assert!(
        output_text(&output)
            .contains("The script is saved at .zcode/workflow-drafts/nightly.dwf.ts")
    );
}

#[tokio::test]
async fn saved_arguments_are_checked_before_the_ask_and_named_in_the_refusal() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    let declared = vec![
        ("n".to_owned(), arg(ArgType::Number, None, Some(json!(3)))),
        ("mode".to_owned(), arg(ArgType::String, Some(true), None)),
    ];
    harness
        .store()
        .save(
            "nightly",
            &saved_meta(Some(declared)),
            "return n;",
            Scope::Project,
        )
        .expect("save");
    let input = json!({"saved": {"name": "nightly", "args": {"x": 1}}});
    assert!(matches!(
        harness.decide(&input).await,
        PermissionDecision::Allow { .. }
    ));
    let error = harness
        .run(input)
        .await
        .expect_err("the arguments are wrong");
    let message = message_of(&error);
    assert!(
        message.starts_with("The arguments for saved workflow 'nightly' are not valid:"),
        "{message}"
    );
    assert!(
        message.contains("- unknown argument 'x' (declared: n, mode)"),
        "{message}"
    );
    assert!(
        message.contains("- missing required argument 'mode'"),
        "{message}"
    );
    assert!(message.contains("- mode (string, required)"), "{message}");
    assert!(submits_of(&harness).is_empty());
}

#[tokio::test]
async fn an_unknown_saved_name_lists_the_saved_workflows_that_exist() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    harness
        .store()
        .save("nightly", &saved_meta(None), "return 1;", Scope::Project)
        .expect("save");
    let error = harness
        .run(json!({"saved": {"name": "missing"}}))
        .await
        .expect_err("not saved");
    assert_eq!(
        message_of(&error),
        "No saved workflow named 'missing' in this project or globally.\n\nAvailable saved workflows: nightly (project). Use ListSavedWorkflows for their descriptions."
    );
}

/// Node `resolvePathSource`: the file is the working copy (no draft is written), its block is stripped, and its
/// declared arguments are filled in.
#[tokio::test]
async fn a_path_source_strips_its_block_takes_its_arguments_and_writes_no_draft() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    let file = harness.cwd.join("flows/a.dwf.ts");
    fs::write(
        &file,
        "/* zcode-workflow\ndescription: a\nargs:\n  n:\n    type: number\n    default: 2\n*/\nreturn 1;",
    )
    .expect("file");
    let output = harness
        .run(json!({"path": "flows/a.dwf.ts"}))
        .await
        .expect("the call runs");
    let request = &submits_of(&harness)[0];
    assert_eq!(request.script_text, "return 1;");
    assert_eq!(
        request.args,
        Some(json!({"n": 2}).as_object().unwrap().clone())
    );
    assert_eq!(
        request.script_path.as_deref(),
        Some(file.display().to_string().as_str())
    );
    assert!(
        !fs::exists(harness.draft("a.dwf.ts")),
        "a path source writes no draft"
    );
    assert!(output_text(&output).ends_with(
        "The script file is flows/a.dwf.ts; to revise it later, edit that file and pass `path` to AmendWorkflow."
    ));
}

#[tokio::test]
async fn a_path_without_a_block_takes_no_arguments() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    fs::write(harness.cwd.join("plain.ts"), CLEAN).expect("file");
    let error = harness
        .run(json!({"path": "plain.ts", "args": {"n": 1}}))
        .await
        .expect_err("no declaration");
    assert!(
        message_of(&error).contains("declares no arguments"),
        "{error:?}"
    );
}

#[tokio::test]
async fn a_path_outside_the_workspace_is_refused_by_the_call() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    let input = json!({"path": "../elsewhere.ts"});
    assert!(matches!(
        harness.decide(&input).await,
        PermissionDecision::Allow { .. }
    ));
    let error = harness.run(input).await.expect_err("outside");
    assert!(
        message_of(&error).contains("is outside the workspace"),
        "{error:?}"
    );
    assert!(submits_of(&harness).is_empty());
}

/// A diagnostic in a saved copy is reported on the copy's file line: the body line plus the lines of the block.
#[tokio::test]
async fn a_diagnostic_in_a_saved_copy_is_reported_on_its_file_line() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    let store = harness.store();
    store
        .save("broken", &saved_meta(None), "BROKEN;", Scope::Project)
        .expect("save");
    let offset = store
        .resolve("broken", None)
        .expect("the saved copy")
        .body_line_offset;
    assert!(offset > 0, "a saved file carries its block");
    let output = harness
        .run(json!({"saved": {"name": "broken"}}))
        .await
        .expect("the call runs");
    let text = output_text(&output);
    assert!(
        text.contains(&format!(
            ".zcode/workflow-drafts/broken.dwf.ts:L{}:C7",
            1 + offset
        )),
        "{text}"
    );
    assert!(
        text.contains("A working copy of the saved workflow 'broken' (.zcode/workflows/broken.dwf.ts) was written to .zcode/workflow-drafts/broken.dwf.ts."),
        "{text}"
    );
    assert!(submits_of(&harness).is_empty());
}

/// Node `max_concurrency`: the limit reaches the port, and the result says it, marking a limit equal to the default.
#[tokio::test]
async fn the_concurrency_limit_reaches_the_port_and_the_result_marks_the_default() {
    let harness = Harness::new(Some(FakeRun::new(Some(4), false)));
    let equal = harness
        .run(json!({"script": CLEAN, "name": "a", "max_concurrency": 4}))
        .await
        .expect("equal");
    assert!(output_text(&equal).contains(" At most 4 subagents run at once (the default)."));
    let above = harness
        .run(json!({"script": CLEAN, "name": "b", "max_concurrency": 8}))
        .await
        .expect("above");
    assert!(output_text(&above).contains(" At most 8 subagents run at once."));
    assert!(!output_text(&above).contains("(the default)"));
    let submits = submits_of(&harness);
    assert_eq!(submits[0].max_concurrency, Some(4));
    assert_eq!(submits[1].max_concurrency, Some(8));
}

#[tokio::test]
async fn without_a_limit_none_is_submitted_and_none_is_said() {
    let harness = Harness::new(Some(FakeRun::new(Some(4), false)));
    let output = harness.run(inline(CLEAN)).await.expect("the call runs");
    assert!(!output_text(&output).contains("At most"));
    assert_eq!(submits_of(&harness)[0].max_concurrency, None);
}

/// The script that runs is the one that was asked about: a file edited after approval does not change the run.
#[tokio::test]
async fn the_approved_bytes_are_the_bytes_run_even_if_the_file_changes_after_approval() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    let file = harness.cwd.join("flows/a.dwf.ts");
    fs::write(&file, CLEAN).expect("file");
    let input = json!({"path": "flows/a.dwf.ts"});
    let ctx = harness.with_skill();
    assert!(matches!(
        harness.tool.check_permissions(&input, &ctx).await,
        PermissionDecision::Ask { .. }
    ));
    fs::write(&file, "return 'edited';").expect("edit");
    let (tx, _rx) = mpsc::channel(4);
    harness
        .tool
        .call(input, ctx, tx)
        .await
        .expect("the call runs");
    assert_eq!(submits_of(&harness)[0].script_text, CLEAN);
}

/// A clean script reaches the call only through its decision: a call with no approval starts nothing.
#[tokio::test]
async fn a_clean_call_with_no_approval_starts_nothing() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    let error = harness
        .call_without_decision(inline(CLEAN))
        .await
        .expect_err("no confirmation");
    assert!(
        message_of(&error).contains("has no confirmation for this script, so nothing was started"),
        "{error:?}"
    );
    assert!(submits_of(&harness).is_empty());
}

/// Node: a draft that cannot be written is best effort. The run still starts, without a script path.
#[tokio::test]
async fn a_draft_that_cannot_be_written_starts_the_run_without_a_script_path() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    fs::write(harness.cwd.join(".zcode"), "a file, not a directory").expect("blocker");
    let output = harness.run(inline(CLEAN)).await.expect("the call runs");
    assert!(output_text(&output).contains("with ID: run-1"));
    assert_eq!(submits_of(&harness)[0].script_path, None);
}

/// The run label falls back to the saved name; an unnamed inline script has no label at all.
#[tokio::test]
async fn the_run_label_is_the_given_name_or_the_saved_name_and_absent_otherwise() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    harness
        .store()
        .save("nightly", &saved_meta(None), "return 1;", Scope::Project)
        .expect("save");
    harness
        .run(json!({"saved": {"name": "nightly"}}))
        .await
        .expect("saved");
    harness.run(json!({"script": CLEAN})).await.expect("inline");
    let submits = submits_of(&harness);
    assert_eq!(submits[0].name.as_deref(), Some("nightly"));
    assert_eq!(submits[1].name, None);
}

/// Review: a full table evicts its oldest decision, and keeps the others.
#[test]
fn a_full_approval_table_evicts_its_oldest_decision_only() {
    let harness = Harness::new(None);
    let mut ids = Vec::new();
    for index in 0..APPROVAL_CAP {
        let id = ToolUseId::new(format!("tu{index}"));
        harness.tool.remember(id.clone(), prepared("return 1;"));
        ids.push(id);
    }
    harness
        .tool
        .remember(ToolUseId::new("tu-new"), prepared("return 2;"));
    assert!(
        harness.tool.take_approval(&ids[0]).is_none(),
        "the oldest is evicted"
    );
    assert!(
        harness.tool.take_approval(&ids[1]).is_some(),
        "the next oldest is kept"
    );
    assert!(harness.tool.take_approval(&ids[APPROVAL_CAP - 1]).is_some());
    assert!(
        harness
            .tool
            .take_approval(&ToolUseId::new("tu-new"))
            .is_some()
    );
}

fn prepared(script: &str) -> Prepared {
    Prepared {
        resolved: Resolved {
            script: script.to_owned(),
            name: None,
            args: None,
            origin: Origin::Inline,
            body_offset: 0,
        },
        analysis: WorkflowAnalysis {
            ok: true,
            diagnostics: Vec::new(),
        },
    }
}

/// Review: an unparsable `saved.scope` is refused by the call too, not read as "either scope".
#[tokio::test]
async fn a_saved_scope_that_is_neither_project_nor_global_is_refused_by_the_call() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    harness
        .store()
        .save("nightly", &saved_meta(None), "return 1;", Scope::Project)
        .expect("save");
    let error = harness
        .call_without_decision(json!({"saved": {"name": "nightly", "scope": "sideways"}}))
        .await
        .expect_err("a bad scope");
    assert!(message_of(&error).contains("saved.scope"), "{error:?}");
    assert!(submits_of(&harness).is_empty());
}

/// Review: `path` has minLength 1 in the contract, so an empty path is refused by the schema.
#[tokio::test]
async fn an_empty_path_is_refused_by_the_schema() {
    let harness = Harness::new(None);
    let validation = harness
        .tool
        .validate_input(&json!({"path": ""}), &harness.with_skill())
        .await;
    assert!(
        matches!(validation, Validation::Invalid { .. }),
        "{validation:?}"
    );
}

/// Review: a saved copy's messages name the saved workflow, not the run label given for this run.
#[tokio::test]
async fn a_saved_copy_is_named_by_its_saved_name_not_the_run_label() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    harness
        .store()
        .save("broken", &saved_meta(None), "BROKEN;", Scope::Project)
        .expect("save");
    let output = harness
        .run(json!({"saved": {"name": "broken"}, "name": "My label"}))
        .await
        .expect("the call runs");
    let text = output_text(&output);
    assert!(text.starts_with("The saved workflow 'broken' ("), "{text}");
    assert!(
        text.contains("A working copy of the saved workflow 'broken' ("),
        "{text}"
    );
    assert!(!text.contains("My label"), "{text}");
}

/// Review: a type mismatch names the value the way Node does (`typeof`, so an object is "a object").
#[tokio::test]
async fn a_type_mismatch_names_an_object_as_node_does() {
    let harness = Harness::new(Some(FakeRun::new(None, false)));
    let declared = vec![("mode".to_owned(), arg(ArgType::String, Some(true), None))];
    harness
        .store()
        .save(
            "nightly",
            &saved_meta(Some(declared)),
            "return 1;",
            Scope::Project,
        )
        .expect("save");
    let error = harness
        .run(json!({"saved": {"name": "nightly", "args": {"mode": {}}}}))
        .await
        .expect_err("the type is wrong");
    assert!(
        message_of(&error).contains("argument 'mode': expected a string, got a object (value)"),
        "{error:?}"
    );
}

/// Review: a symlink inside the workspace that leads outside is refused before its bytes are read to ask about.
#[cfg(unix)]
#[tokio::test]
async fn a_symlink_that_leads_out_of_the_workspace_is_refused_before_it_is_read() {
    let harness = Harness::new(None);
    let outside = harness
        .cwd
        .parent()
        .expect("the test root")
        .join("outside.ts");
    fs::write(&outside, CLEAN).expect("the file outside");
    fs::write(harness.cwd.join("inside.txt"), "x").expect("the workspace");
    rust_cli_fs::symlink(&outside, &harness.cwd.join("link.ts")).expect("the symlink");
    let input = json!({"path": "link.ts"});
    assert!(
        matches!(
            harness.decide(&input).await,
            PermissionDecision::Allow { .. }
        ),
        "nothing outside the workspace is read to ask about"
    );
    let error = harness.run(input).await.expect_err("refused");
    assert!(
        message_of(&error).contains("is outside the workspace"),
        "{error:?}"
    );
    assert!(submits_of(&harness).is_empty());
}
