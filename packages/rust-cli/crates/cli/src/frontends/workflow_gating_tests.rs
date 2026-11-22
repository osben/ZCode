//! W7-7a (specs/fork-rust-workflow-engine.md 9.36): the tools the app server wires behind the gate.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::dynamic_workflow::{DynamicWorkflowGate, SessionGates};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::tool::Tool;
use rust_cli_kernel_api::workflow_analysis::{
    WorkflowAnalysis, WorkflowAnalysisError, WorkflowAnalyzer,
};
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, DynamicWorkflowRunSessions, LateRunSessions, SubmitRequest,
};
use rust_cli_kernel_api::workflow_snippet::{
    SnippetCheck, SnippetOutcome, SnippetRequest, WorkflowSnippetError, WorkflowSnippetPort,
};
use rust_cli_runtime::wired_workflow_tools;

use super::gating;

struct NoAnalyzer;

#[async_trait]
impl WorkflowAnalyzer for NoAnalyzer {
    async fn analyze(&self, _script: &str) -> Result<WorkflowAnalysis, WorkflowAnalysisError> {
        Err(WorkflowAnalysisError {
            message: "the checker is not called in these tests".to_owned(),
        })
    }
}

/// The id source of the Refine follow-up: the session's `NodeIds` over a fixed clock (9.67, divergence 932).
fn ids() -> Arc<dyn rust_cli_kernel_api::clock::Ids> {
    Arc::new(rust_cli_node_store::NodeIds::new(Arc::new(
        rust_cli_kernel_api::testing::FixedClock(1_700_000_000_123),
    )))
}

fn no_runs() -> Arc<dyn DynamicWorkflowRunSessions> {
    Arc::new(LateRunSessions::default())
}

fn names(tools: &[Arc<dyn Tool>]) -> Vec<String> {
    tools.iter().map(|tool| tool.name().to_owned()).collect()
}

#[test]
fn without_an_analyzer_the_run_tools_and_list_saved_are_wired() {
    let tools = wired_workflow_tools(
        None,
        &PathBuf::from("/home"),
        no_runs(),
        None,
        Arc::default(),
        ids(),
    );
    assert_eq!(
        names(&tools),
        [
            "ListWorkflowRuns",
            "GetWorkflowRun",
            "ResumeWorkflowRun",
            "ResolveWorkflowQuestion",
            "ListSavedWorkflows"
        ]
    );
}

#[test]
fn with_an_analyzer_create_amend_and_save_are_wired_before_the_run_tools_and_list_saved() {
    let analyzer: Arc<dyn WorkflowAnalyzer> = Arc::new(NoAnalyzer);
    let tools = wired_workflow_tools(
        Some(analyzer),
        &PathBuf::from("/home"),
        no_runs(),
        None,
        Arc::default(),
        ids(),
    );
    assert_eq!(
        names(&tools),
        [
            "CreateWorkflow",
            "AmendWorkflow",
            "FillWorkflowHole",
            "SaveWorkflow",
            "ListWorkflowRuns",
            "GetWorkflowRun",
            "ResumeWorkflowRun",
            "ResolveWorkflowQuestion",
            "ListSavedWorkflows"
        ]
    );
}

#[tokio::test]
async fn a_submit_before_the_late_slot_is_set_is_unsupported_and_a_second_set_is_refused() {
    // The slot is set once the run service exists. A submit that races the composition gets the typed unsupported error,
    // not a panic, and a second set is refused (the first stays), as the composition's warn expects.
    let late = LateRunSessions::default();
    let port = late.for_session(&SessionId::new("ses_a"));
    let error = port
        .submit(SubmitRequest {
            script_text: "return 1".to_owned(),
            cwd: "project".to_owned(),
            name: None,
            args: None,
            parent_session_id: Some(SessionId::new("ses_a")),
            tool_call_id: None,
            max_concurrency: None,
            script_path: None,
            phase_names: None,
            phase_alongside: None,
            subagent_model: None,
            model_bindings: None,
        })
        .await
        .expect_err("no run service is set yet");
    assert_eq!(error, DynamicWorkflowRunError::unsupported("submit"));
    assert!(late.set(no_runs()), "the first set is kept");
    assert!(!late.set(no_runs()), "a second set is refused");
}

#[test]
fn the_gate_source_reads_the_shared_table_the_server_records_into() {
    let table = Arc::new(SessionGates::default());
    let source = gating(
        table.clone(),
        None,
        &PathBuf::from("/home"),
        no_runs(),
        None,
        Arc::default(),
        ids(),
    );
    let open = DynamicWorkflowGate {
        enabled: true,
        tools_on_demand: false,
    };
    table.record(&SessionId::new("ses_a"), open);
    assert_eq!(source.gates.gate(&SessionId::new("ses_a")), Some(open));
    assert_eq!(source.gates.gate(&SessionId::new("ses_b")), None);
    assert_eq!(
        names(&source.tools),
        [
            "ListWorkflowRuns",
            "GetWorkflowRun",
            "ResumeWorkflowRun",
            "ResolveWorkflowQuestion",
            "ListSavedWorkflows"
        ]
    );
}

/// The snippet port these tests wire: the tools only hold it, so its answers are never asked for here.
struct NoSnippets;

#[async_trait]
impl WorkflowSnippetPort for NoSnippets {
    async fn check(&self, _code: &str) -> Result<SnippetCheck, WorkflowSnippetError> {
        Err(WorkflowSnippetError {
            message: "the snippet is not run in these tests".to_owned(),
        })
    }

    async fn eval(&self, _request: SnippetRequest) -> Result<SnippetOutcome, WorkflowSnippetError> {
        Err(WorkflowSnippetError {
            message: "the snippet is not run in these tests".to_owned(),
        })
    }
}

#[test]
fn with_a_snippet_port_eval_is_wired_between_save_and_the_run_tools() {
    // Node's index order: create, amend, save, eval, list runs, get run, resume, resolve, fill, list saved. Rust registers
    // FillWorkflowHole after AmendWorkflow, which is the deliberate divergence of spec 9.45, so the assertions below list
    // it there.
    let analyzer: Arc<dyn WorkflowAnalyzer> = Arc::new(NoAnalyzer);
    let snippets: Arc<dyn WorkflowSnippetPort> = Arc::new(NoSnippets);
    let tools = wired_workflow_tools(
        Some(analyzer),
        &PathBuf::from("/home"),
        no_runs(),
        Some(snippets),
        Arc::default(),
        ids(),
    );
    assert_eq!(
        names(&tools),
        [
            "CreateWorkflow",
            "AmendWorkflow",
            "FillWorkflowHole",
            "SaveWorkflow",
            "EvalWorkflowSnippet",
            "ListWorkflowRuns",
            "GetWorkflowRun",
            "ResumeWorkflowRun",
            "ResolveWorkflowQuestion",
            "ListSavedWorkflows"
        ]
    );
}

/// 9.67 (closes 932): the wired CreateWorkflow and AmendWorkflow mint the Refine follow-up's id from the composition's id
/// source, so it is Node's `msg_<base36 ms>_<uuid>` and the store's reader decodes the clock's time from it. A tool built
/// without the source would fall back to an id that dates the row 1970.
#[test]
fn the_wired_refine_follow_up_has_a_node_message_id_the_store_dates() {
    let analyzer: Arc<dyn WorkflowAnalyzer> = Arc::new(NoAnalyzer);
    let tools = wired_workflow_tools(
        Some(analyzer),
        &PathBuf::from("/home"),
        no_runs(),
        None,
        Arc::default(),
        ids(),
    );
    for name in ["CreateWorkflow", "AmendWorkflow"] {
        let tool = tools
            .iter()
            .find(|tool| tool.name() == name)
            .unwrap_or_else(|| panic!("{name} is wired"));
        let refused = tool
            .refined(
                &rust_cli_kernel_api::ids::ToolUseId::new("tu-1"),
                "revise it",
            )
            .unwrap_or_else(|| panic!("{name} takes Refine"));
        let [rust_cli_kernel_api::message::Message::Attachment(steer)] =
            refused.new_messages.as_slice()
        else {
            panic!("{name}: one follow-up message");
        };
        assert!(steer.id.as_str().starts_with("msg_"), "{:?}", steer.id);
        assert_eq!(
            // The reader node-store's `message_time` and `created_at` delegate to.
            rust_cli_kernel_api::ids::message_created_ms(steer.id.as_str()),
            Some(1_700_000_000_123),
            "{name}: {:?}",
            steer.id
        );
    }
}

#[test]
fn the_gate_source_wires_eval_only_when_it_is_given_a_snippet_port() {
    let table = Arc::new(SessionGates::default());
    let snippets: Arc<dyn WorkflowSnippetPort> = Arc::new(NoSnippets);
    let source = gating(
        table,
        None,
        &PathBuf::from("/home"),
        no_runs(),
        Some(snippets),
        Arc::default(),
        ids(),
    );
    assert!(names(&source.tools).contains(&"EvalWorkflowSnippet".to_owned()));
}
