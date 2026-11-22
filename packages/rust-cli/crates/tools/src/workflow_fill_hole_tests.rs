//! Tests of the FillWorkflowHole tool (specs/fork-rust-workflow-engine.md, 9.45, W7-12): the input rules and the skill gate
//! (`validate_input`), the no-port refusal and the port's answers (`call`), and the texts of the refusals.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::testing::OpsOverride;
use rust_cli_kernel_api::tool::{Tool, ToolError, Validation};
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, DynamicWorkflowRunPort, DynamicWorkflowRunSessions, FillHoleOutcome,
    FillHoleRequest, FillRefusalReason,
};
use serde_json::json;

use super::*;
use crate::test_more::{Ctx, output_text};

/// A conversation with the dynamic-workflows skill loaded, so the skill gate passes.
struct SkillLoaded;

#[async_trait]
impl OpsOverride for SkillLoaded {
    async fn conversation(&self) -> Option<Vec<Message>> {
        Some(vec![
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
        ])
    }
}

/// A conversation with no skill: the gate refuses a fill.
struct NoSkill;

#[async_trait]
impl OpsOverride for NoSkill {
    async fn conversation(&self) -> Option<Vec<Message>> {
        Some(Vec::new())
    }
}

/// A run port whose fill answers `outcome`; the other members are the port's defaults.
struct Answers(FillHoleOutcome);

#[async_trait]
impl DynamicWorkflowRunPort for Answers {
    async fn fill_hole(
        &self,
        _request: FillHoleRequest,
    ) -> Result<FillHoleOutcome, DynamicWorkflowRunError> {
        Ok(self.0.clone())
    }
}

struct OneSession(Arc<dyn DynamicWorkflowRunPort>);

impl DynamicWorkflowRunSessions for OneSession {
    fn for_session(&self, _session: &SessionId) -> Arc<dyn DynamicWorkflowRunPort> {
        self.0.clone()
    }
}

fn tool_with(runs: Option<Arc<dyn DynamicWorkflowRunSessions>>) -> FillWorkflowHoleTool {
    FillWorkflowHoleTool::new(runs)
}

fn context(ops: Arc<dyn OpsOverride>) -> rust_cli_kernel_api::tool::ToolUseContext {
    Ctx::with_ops(Arc::new(OverrideOps(ops))).build()
}

/// Adapts an `OpsOverride` to the session operations the context takes.
struct OverrideOps(Arc<dyn OpsOverride>);

#[async_trait]
impl OpsOverride for OverrideOps {
    async fn conversation(&self) -> Option<Vec<Message>> {
        self.0.conversation().await
    }
}

fn invalid_message(validation: Validation) -> String {
    match validation {
        Validation::Invalid { message, .. } => message,
        Validation::Ok => panic!("the input is valid"),
    }
}

#[tokio::test]
async fn an_empty_run_or_hole_id_is_refused_by_name() {
    let tool = tool_with(None);
    let ctx = context(Arc::new(SkillLoaded));
    let run = tool
        .validate_input(
            &json!({"run_id": "", "hole_id": "hole#1", "script": "return 1;"}),
            &ctx,
        )
        .await;
    assert!(invalid_message(run).starts_with("run_id:"));
    let hole = tool
        .validate_input(
            &json!({"run_id": "run-1", "hole_id": "", "script": "return 1;"}),
            &ctx,
        )
        .await;
    assert!(invalid_message(hole).starts_with("hole_id:"));
}

#[tokio::test]
async fn an_empty_script_or_path_is_refused_by_name() {
    let tool = tool_with(None);
    let ctx = context(Arc::new(SkillLoaded));
    let script = tool
        .validate_input(
            &json!({"run_id": "run-1", "hole_id": "hole#1", "script": ""}),
            &ctx,
        )
        .await;
    assert!(invalid_message(script).starts_with("script:"));
    let path = tool
        .validate_input(
            &json!({"run_id": "run-1", "hole_id": "hole#1", "path": ""}),
            &ctx,
        )
        .await;
    assert!(invalid_message(path).starts_with("path:"));
}

#[tokio::test]
async fn exactly_one_body_source_is_required() {
    let tool = tool_with(None);
    let ctx = context(Arc::new(SkillLoaded));
    let both = tool
        .validate_input(
            &json!({"run_id": "run-1", "hole_id": "hole#1", "script": "return 1;", "path": "fill.ts"}),
            &ctx,
        )
        .await;
    assert_eq!(invalid_message(both), SOURCE_ERROR);
    let neither = tool
        .validate_input(&json!({"run_id": "run-1", "hole_id": "hole#1"}), &ctx)
        .await;
    assert_eq!(invalid_message(neither), SOURCE_ERROR);
}

#[tokio::test]
async fn a_fill_without_a_loaded_skill_is_refused_with_428() {
    let tool = tool_with(None);
    let ctx = context(Arc::new(NoSkill));
    let validation = tool
        .validate_input(
            &json!({"run_id": "run-1", "hole_id": "hole#1", "script": "return 1;"}),
            &ctx,
        )
        .await;
    assert!(matches!(
        validation,
        Validation::Invalid {
            error_code: Some(428),
            ..
        }
    ));
}

#[tokio::test]
async fn a_well_formed_fill_with_the_skill_loaded_is_valid() {
    let tool = tool_with(None);
    let ctx = context(Arc::new(SkillLoaded));
    let validation = tool
        .validate_input(
            &json!({"run_id": "run-1", "hole_id": "hole#1", "script": "return 1;"}),
            &ctx,
        )
        .await;
    assert!(matches!(validation, Validation::Ok));
}

#[tokio::test]
async fn a_session_without_a_run_port_is_told_fills_are_unavailable() {
    let tool = tool_with(None);
    let ctx = context(Arc::new(SkillLoaded));
    let input = json!({"run_id": "run-1", "hole_id": "hole#1", "script": "return 1;"});
    let error = tool.call(input, ctx, tokio::sync::mpsc::channel(1).0).await;
    assert!(
        matches!(&error, Err(ToolError::Failed { message }) if message == FILL_UNAVAILABLE),
        "the no-port call says the capability is unavailable: {error:?}"
    );
}

#[tokio::test]
async fn a_filled_hole_reports_the_phases_it_added() {
    let port: Arc<dyn DynamicWorkflowRunPort> = Arc::new(Answers(FillHoleOutcome::Filled {
        phases_added: vec!["review".to_owned()],
        script_text: "return 1;".to_owned(),
    }));
    let tool = tool_with(Some(Arc::new(OneSession(port))));
    let ctx = context(Arc::new(SkillLoaded));
    let output = tool
        .call(
            json!({"run_id": "run-1", "hole_id": "hole#1", "script": "return 1;"}),
            ctx,
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("the fill is applied");
    let text = output_text(&output);
    assert!(text.contains("It added the phases review."), "{text}");
    assert!(text.contains("the run keeps going"), "{text}");
    // The fill row is the shared `create_workflow` card (Node `createCreateWorkflowDisplay`).
    assert_eq!(output.display["kind"], "create_workflow");
    assert_eq!(output.display["ok"], true);
    // Node `fillBlock`: with no hole entry to read, the row is named by the hole id.
    assert_eq!(
        output.display["fill"],
        json!({"siteId": "hole#1", "name": "hole#1"})
    );
}

/// A run port whose fill answers `outcome` and whose detail is `detail`.
struct FillWithDetail(FillHoleOutcome, serde_json::Value);

#[async_trait]
impl DynamicWorkflowRunPort for FillWithDetail {
    async fn fill_hole(
        &self,
        _request: FillHoleRequest,
    ) -> Result<FillHoleOutcome, DynamicWorkflowRunError> {
        Ok(self.0.clone())
    }
    async fn get_run_detail(
        &self,
        _run_id: &rust_cli_kernel_api::ids::WorkflowRunId,
    ) -> Result<Option<serde_json::Value>, DynamicWorkflowRunError> {
        Ok(Some(self.1.clone()))
    }
}

/// Node `fillBlock` (ocr #619): the fill row is named by the hole's own name, from the run's hole entry, so the desktop's
/// fill row does not show the raw site id.
#[tokio::test]
async fn a_filled_hole_names_the_fill_row_by_the_holes_name() {
    let port: Arc<dyn DynamicWorkflowRunPort> = Arc::new(FillWithDetail(
        FillHoleOutcome::Filled {
            phases_added: Vec::new(),
            script_text: "return 1;".to_owned(),
        },
        json!({"status": "running", "holes": [{"siteId": "hole#1", "name": "决定分组", "state": "waiting"}]}),
    ));
    let tool = tool_with(Some(Arc::new(OneSession(port))));
    let output = tool
        .call(
            json!({"run_id": "run-1", "hole_id": "hole#1", "script": "return 1;"}),
            context(Arc::new(SkillLoaded)),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("the fill is applied");
    assert_eq!(
        output.display["fill"],
        json!({"siteId": "hole#1", "name": "决定分组"})
    );
}

#[tokio::test]
async fn a_compile_refusal_lists_its_diagnostics_one_per_line() {
    let port: Arc<dyn DynamicWorkflowRunPort> = Arc::new(Answers(FillHoleOutcome::Refused {
        reason: FillRefusalReason::CompileFailed,
        message: "does not compile".to_owned(),
        diagnostics: Some(json!([{"line": 3, "column": 5, "message": "bad", "code": 9001}])),
    }));
    let tool = tool_with(Some(Arc::new(OneSession(port))));
    let ctx = context(Arc::new(SkillLoaded));
    // Node: a body that does not compile answers with the card (`ok: false`, its diagnostics, the fill block), not a
    // failure, so the desktop draws the fill row for it too (ocr #619).
    let output = tool
        .call(
            json!({"run_id": "run-1", "hole_id": "hole#1", "script": "return 1;"}),
            ctx,
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("a compile refusal answers with its card");
    assert_eq!(
        output_text(&output),
        "workflow_fill_refused: does not compile\nL3:C5 bad"
    );
    assert_eq!(output.display["ok"], false);
    assert_eq!(output.display["errorCount"], 1);
    assert_eq!(output.display["diagnostics"][0]["code"], 9001);
    assert_eq!(
        output.display["fill"],
        json!({"siteId": "hole#1", "name": "hole#1"})
    );
}

#[test]
fn the_refusal_texts_name_their_reason() {
    assert!(
        refusal_text(FillRefusalReason::RunNotFound, "run-9", "gone")
            .starts_with("run_not_found: no workflow run with ID run-9 exists")
    );
    assert_eq!(
        refusal_text(FillRefusalReason::HoleNotWaiting, "run-1", "not waiting"),
        "hole_not_waiting: not waiting"
    );
    assert!(
        refusal_text(FillRefusalReason::FillIdsUnstable, "run-1", "renumbered")
            .starts_with("fill_ids_unstable: renumbered")
    );
    assert_eq!(
        refusal_text(FillRefusalReason::CompileFailed, "run-1", "bad body"),
        "workflow_fill_refused: bad body"
    );
}

#[test]
fn diagnostics_render_one_line_each_and_none_when_absent() {
    assert_eq!(diagnostic_lines(None), "");
    assert_eq!(diagnostic_lines(Some(&json!("not a list"))), "");
    assert_eq!(
        diagnostic_lines(Some(&json!([
            {"line": 2, "column": 1, "message": "a"},
            {"line": 4, "column": 9, "message": "b"}
        ]))),
        "\nL2:C1 a\nL4:C9 b"
    );
}

#[test]
fn the_tool_keeps_the_model_budget_of_its_siblings() {
    let tool = tool_with(None);
    assert_eq!(
        tool.result_budget_truncate_bytes(),
        Some(CREATE_MODEL_BYTES)
    );
}

/// A run port whose run detail is `detail`.
struct Detail(serde_json::Value);

#[async_trait]
impl DynamicWorkflowRunPort for Detail {
    async fn get_run_detail(
        &self,
        _run_id: &rust_cli_kernel_api::ids::WorkflowRunId,
    ) -> Result<Option<serde_json::Value>, DynamicWorkflowRunError> {
        Ok(Some(self.0.clone()))
    }
}

#[tokio::test]
async fn a_hole_of_this_sessions_own_run_fills_without_a_window_and_others_ask() {
    use rust_cli_kernel_api::permission::PermissionDecision;
    let cases = [
        (
            json!({"runId": "run-1", "ownedByThisSession": true, "status": "running"}),
            true,
        ),
        (
            json!({"runId": "run-1", "ownedByThisSession": false, "status": "running"}),
            false,
        ),
        (
            json!({"runId": "run-1", "ownedByThisSession": true, "status": "stopped", "stopReason": "user"}),
            false,
        ),
    ];
    for (detail, allowed) in cases {
        let runs: Arc<dyn DynamicWorkflowRunSessions> =
            Arc::new(OneSession(Arc::new(Detail(detail.clone()))));
        let tool = tool_with(Some(runs));
        let ctx = context(Arc::new(SkillLoaded));
        let input = json!({"run_id": "run-1", "hole_id": "h1", "script": "return 1;"});
        let decision = tool.check_permissions(&input, &ctx).await;
        assert_eq!(
            matches!(decision, PermissionDecision::Allow { .. }),
            allowed,
            "{detail}: {decision:?}"
        );
    }
}

#[tokio::test]
async fn a_hole_of_another_sessions_live_run_is_refused_before_any_window() {
    // Node `findWaitingHole` with `liveInThisProcess === false`: only the starting session reaches the engine.
    let live = json!({"runId": "run-1", "ownedByThisSession": false, "status": "running"});
    let runs: Arc<dyn DynamicWorkflowRunSessions> = Arc::new(OneSession(Arc::new(Detail(live))));
    let tool = tool_with(Some(runs));
    let ctx = context(Arc::new(SkillLoaded));
    let input = json!({"run_id": "run-1", "hole_id": "h1", "script": "return 1;"});
    let message = invalid_message(tool.validate_input(&input, &ctx).await);
    assert_eq!(
        message,
        "hole_not_waiting: run run-1 is not running in this session's process, so this session cannot reach its engine. Only the session that started it can fill h1: ask the user to do it there. If that session has exited, the run is interrupted; ResumeWorkflowRun brings the hole back. Nothing was filled."
    );
    let own = json!({"runId": "run-1", "ownedByThisSession": true, "status": "running"});
    let runs: Arc<dyn DynamicWorkflowRunSessions> = Arc::new(OneSession(Arc::new(Detail(own))));
    let tool = tool_with(Some(runs));
    assert!(matches!(
        tool.validate_input(&input, &ctx).await,
        Validation::Ok
    ));
}

/// An analyzer that draws a one-step graph naming the script it was given.
struct Draws;

#[async_trait]
impl rust_cli_kernel_api::workflow_analysis::WorkflowAnalyzer for Draws {
    async fn analyze(
        &self,
        script: &str,
    ) -> Result<
        rust_cli_kernel_api::workflow_analysis::WorkflowAnalysis,
        rust_cli_kernel_api::workflow_analysis::WorkflowAnalysisError,
    > {
        Ok(rust_cli_kernel_api::workflow_analysis::WorkflowAnalysis {
            model_references: Vec::new(),
            display: Some(json!({"kind": "create_workflow", "ok": true,
                "causalityGraph": {"steps": [{"id": script}], "phases": [{"id": "p1", "fill": "hole#1"}]}})),
            ok: true,
            diagnostics: Vec::new(),
        })
    }
}

/// 9.62 (DWH-03, narrows 514): a fill that joined the run answers with the effective script's causality graph (Node
/// `boundGraphOfAnalysis(analyzeScript(result.scriptText))`) and the `fill` block that names the hole, so the run card
/// swaps in the filled graph and draws the fill's head.
#[tokio::test]
async fn a_joined_fill_carries_the_effective_scripts_graph_and_its_fill_block() {
    let port: Arc<dyn DynamicWorkflowRunPort> = Arc::new(Answers(FillHoleOutcome::Filled {
        phases_added: vec!["collect".to_owned()],
        script_text: "EFFECTIVE".to_owned(),
    }));
    let tool = tool_with(Some(Arc::new(OneSession(port)))).with_analyzer(Arc::new(Draws));
    let output = tool
        .call(
            json!({"run_id": "run-1", "hole_id": "hole#1", "script": "return 1;"}),
            context(Arc::new(SkillLoaded)),
            tokio::sync::mpsc::channel(1).0,
        )
        .await
        .expect("the fill is applied");
    assert_eq!(output.display["kind"], "create_workflow");
    assert_eq!(
        output.display["causalityGraph"]["steps"][0]["id"],
        "EFFECTIVE"
    );
    assert_eq!(
        output.display["fill"],
        json!({"siteId": "hole#1", "name": "hole#1"})
    );
}
