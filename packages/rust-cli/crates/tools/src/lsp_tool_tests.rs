//! specs/fork-rust-lsp.md "Tool (D2)": contract, call order and the visibility layer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::ids::{AgentId, SessionId};
use rust_cli_kernel_api::lsp::{
    CodeIntelligence, FileMutation, LspLocation, LspOperation, LspOutput, LspQuery, LspQueryError,
    LspResultStatus,
};
use rust_cli_kernel_api::orchestration::ToolRegistry;
use rust_cli_kernel_api::permission::{
    FileAccess, PermissionDecision, PermissionMode, PermissionSubject,
};
use rust_cli_kernel_api::testing::{ListTools, ScriptedInteractions};
use rust_cli_kernel_api::tool::{PromptContext, Tool, ToolError, ToolUseContext};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{LspTool, LspTools};
use crate::test_more::{Ctx, output_text};
use crate::{GlobTool, ToolCatalog, ToolSearchTool};

/// A runtime that records the queries it gets and answers with `answer`; None never answers.
#[derive(Default)]
struct FakeCode {
    offered: AtomicBool,
    queries: Mutex<Vec<LspQuery>>,
    answer: Mutex<Option<Result<LspOutput, LspQueryError>>>,
}

impl FakeCode {
    fn answering(answer: Result<LspOutput, LspQueryError>) -> Arc<Self> {
        let code = Self::default();
        *code.answer.lock().unwrap() = Some(answer);
        Arc::new(code)
    }

    fn queries(&self) -> Vec<LspQuery> {
        self.queries.lock().unwrap().clone()
    }
}

#[async_trait]
impl CodeIntelligence for FakeCode {
    async fn prewarm(&self, _session: &SessionId, _workspace: &WorkspaceRef, _path: &str) {}

    async fn file_mutated(
        &self,
        _session: &SessionId,
        _workspace: &WorkspaceRef,
        _mutation: FileMutation,
    ) {
    }

    async fn edit_diagnostics(&self, _session: &SessionId) -> Option<String> {
        None
    }

    fn session_closed(&self, _session: &SessionId) {}

    async fn refresh_tool(&self, _session: &SessionId, _workspace: &WorkspaceRef) {}

    fn tool_offered(&self, _session: &SessionId) -> bool {
        self.offered.load(Ordering::Relaxed)
    }

    async fn query(
        &self,
        _session: &SessionId,
        _workspace: &WorkspaceRef,
        query: LspQuery,
        _cancel: &CancellationToken,
    ) -> Result<LspOutput, LspQueryError> {
        self.queries.lock().unwrap().push(query);
        let answer = self.answer.lock().unwrap().clone();
        match answer {
            Some(answer) => answer,
            None => std::future::pending().await,
        }
    }
}

fn definition_output() -> LspOutput {
    LspOutput {
        operation: LspOperation::GoToDefinition,
        server: "p/ts".to_owned(),
        status: LspResultStatus::Ok,
        locations: Some(vec![LspLocation {
            path: "src/b.ts".to_owned(),
            line: 1,
            character: 17,
            end_line: 1,
            end_character: 20,
            preview: "export function use() {".to_owned(),
        }]),
        symbols: None,
        hover: None,
        diagnostics: None,
        truncated: false,
        total: Some(1),
    }
}

fn context() -> ToolUseContext {
    Ctx::new(Arc::new(ScriptedInteractions::default())).build()
}

async fn call(tool: &LspTool, input: Value, context: ToolUseContext) -> Result<String, String> {
    let (progress, _) = mpsc::channel(1);
    match tool.call(input, context, progress).await {
        Ok(output) => Ok(output_text(&output)),
        Err(ToolError::Failed { message }) => Err(message),
        Err(other) => panic!("unexpected error kind: {other:?}"),
    }
}

#[tokio::test]
async fn the_contract_matches_node() {
    let tool = LspTool::new(Arc::new(FakeCode::default()));
    assert_eq!(tool.name(), "LSP");
    assert_eq!(
        tool.description(&PromptContext {
            tool_names: Vec::new(),
            mode: PermissionMode::Default,
        }),
        "Code intelligence from language servers: definition, references, implementations, hover, document and \
         workspace symbols, and diagnostics for a file. Use it for symbols and types. Use Grep for plain text and \
         configuration. Give line (1-based, as shown by Read) plus symbol (the identifier on that line, preferred) or \
         character (1-based column). A status of pending means the server has not answered yet; it does not mean \
         there are no errors."
    );
    let schema = tool.input_schema();
    assert_eq!(schema["required"], json!(["operation", "filePath"]));
    assert_eq!(
        schema["properties"]["operation"]["enum"],
        json!([
            "goToDefinition",
            "findReferences",
            "hover",
            "documentSymbol",
            "workspaceSymbol",
            "goToImplementation",
            "diagnostics"
        ])
    );
    assert!(tool.strips_unknown_keys());
    assert!(tool.should_defer());
    assert!(tool.search_hint().is_none());
    assert!(tool.is_read_only(&json!({})));
    assert!(tool.is_concurrency_safe(&json!({})));
    assert!(!tool.is_destructive(&json!({})));
    assert_eq!(tool.max_result_size_chars(), Some(100_000));
    assert_eq!(
        tool.permission_subject(&json!({"operation": "hover", "filePath": "src/a.ts"})),
        Some(PermissionSubject::Path {
            access: FileAccess::Read,
            path: Some("src/a.ts".to_owned()),
        })
    );
    assert!(matches!(
        tool.check_permissions(&json!({}), &context()).await,
        PermissionDecision::Passthrough
    ));
}

#[tokio::test]
async fn input_rules_fail_before_the_runtime_is_asked() {
    let code = Arc::new(FakeCode::default());
    let tool = LspTool::new(code.clone());
    let cases = [
        (
            json!({"operation": "workspaceSymbol", "filePath": "a.ts"}),
            "workspaceSymbol requires query",
        ),
        (
            json!({"operation": "workspaceSymbol", "filePath": "a.ts", "query": ""}),
            "workspaceSymbol requires query",
        ),
        (
            json!({"operation": "hover", "filePath": "a.ts", "symbol": "x"}),
            "hover requires line",
        ),
        (
            json!({"operation": "goToDefinition", "filePath": "a.ts", "line": 1}),
            "goToDefinition requires exactly one of character or symbol",
        ),
        (
            json!({"operation": "findReferences", "filePath": "a.ts", "line": 1, "character": 2, "symbol": "x"}),
            "findReferences requires exactly one of character or symbol",
        ),
        (
            json!({"operation": "goToImplementation", "filePath": "a.ts", "line": 1, "symbol": ""}),
            "",
        ),
    ];
    for (input, expected) in cases {
        let mut agent_context = context();
        // The rules come first: a subagent with a bad input still sees the rule's text.
        agent_context.agent = Some(AgentId::new("agent_1"));
        let result = call(&tool, input.clone(), agent_context).await;
        if expected.is_empty() {
            assert_eq!(
                result.unwrap_err(),
                "LSP service is not configured for the LSP tool",
                "an empty symbol counts as given: {input}"
            );
        } else {
            assert_eq!(result.unwrap_err(), expected, "{input}");
        }
    }
    assert!(code.queries().is_empty());
}

#[tokio::test]
async fn non_positional_operations_need_no_position() {
    let code = FakeCode::answering(Ok(definition_output()));
    let tool = LspTool::new(code.clone());
    for operation in ["documentSymbol", "diagnostics"] {
        call(
            &tool,
            json!({"operation": operation, "filePath": "/w/a.ts"}),
            context(),
        )
        .await
        .unwrap();
    }
    assert_eq!(code.queries().len(), 2);
}

#[tokio::test]
async fn a_subagent_has_no_runtime() {
    let code = FakeCode::answering(Ok(definition_output()));
    let tool = LspTool::new(code.clone());
    let mut context = context();
    context.agent = Some(AgentId::new("agent_1"));
    let error = call(
        &tool,
        json!({"operation": "diagnostics", "filePath": "/w/a.ts"}),
        context,
    )
    .await
    .unwrap_err();
    assert_eq!(error, "LSP service is not configured for the LSP tool");
    assert!(code.queries().is_empty());
}

#[tokio::test]
async fn the_path_resolves_against_the_current_directory() {
    let code = FakeCode::answering(Ok(definition_output()));
    let tool = LspTool::new(code.clone());
    let error = call(
        &tool,
        json!({"operation": "diagnostics", "filePath": ""}),
        context(),
    )
    .await
    .unwrap_err();
    assert_eq!(error, "Tool path must not be empty");
    for raw in ["src/a.ts", "/Users/dev/other/../work/x.ts", "~/x.ts"] {
        call(
            &tool,
            json!({"operation": "diagnostics", "filePath": raw}),
            context(),
        )
        .await
        .unwrap();
    }
    let paths: Vec<String> = code
        .queries()
        .into_iter()
        .map(|query| query.file_path)
        .collect();
    // The context's current directory is the workspace root; `~` is not expanded (Node `path.resolve`).
    assert_eq!(
        paths,
        [
            "/Users/dev/work/src/a.ts",
            "/Users/dev/work/x.ts",
            "/Users/dev/work/~/x.ts"
        ]
    );
}

#[tokio::test]
async fn the_query_carries_the_input_and_the_answer_is_formatted() {
    let code = FakeCode::answering(Ok(definition_output()));
    let tool = LspTool::new(code.clone());
    let (progress, _) = mpsc::channel(1);
    let output = tool
        .call(
            json!({"operation": "goToDefinition", "filePath": "src/a.ts", "line": 2, "symbol": "use",
                   "includeDeclaration": true, "extra": 1}),
            context(),
            progress,
        )
        .await
        .unwrap();
    assert_eq!(
        code.queries(),
        [LspQuery {
            operation: LspOperation::GoToDefinition,
            file_path: "/Users/dev/work/src/a.ts".to_owned(),
            line: Some(2.0),
            character: None,
            symbol: Some("use".to_owned()),
            query: None,
            include_declaration: Some(true),
        }]
    );
    assert!(!output.is_error);
    assert_eq!(
        output_text(&output),
        "src/b.ts:1:17  export function use() {"
    );
    assert_eq!(
        output.display,
        json!({
            "operation": "goToDefinition",
            "server": "p/ts",
            "status": "ok",
            "locations": [{"path": "src/b.ts", "line": 1, "character": 17, "endLine": 1, "endCharacter": 20,
                           "preview": "export function use() {"}],
            "truncated": false,
            "total": 1,
        })
    );
}

#[tokio::test]
async fn a_runtime_failure_is_the_tool_error_text() {
    let code = FakeCode::answering(Err(LspQueryError {
        code: "lsp_server_starting".to_owned(),
        message: "Language server p/ts is starting; retry shortly; use Grep meanwhile".to_owned(),
    }));
    let tool = LspTool::new(code);
    let error = call(
        &tool,
        json!({"operation": "diagnostics", "filePath": "/w/a.ts"}),
        context(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error,
        "Language server p/ts is starting; retry shortly; use Grep meanwhile"
    );
}

#[tokio::test(start_paused = true)]
async fn the_call_times_out_after_65_seconds() {
    let tool = LspTool::new(Arc::new(FakeCode::default()));
    let error = call(
        &tool,
        json!({"operation": "diagnostics", "filePath": "/w/a.ts"}),
        context(),
    )
    .await
    .unwrap_err();
    assert_eq!(error, "Tool execution timed out after 65000ms");
}

fn layered(code: &Arc<FakeCode>) -> Arc<dyn ToolRegistry> {
    let inner: Arc<dyn ToolRegistry> = Arc::new(ListTools(vec![Arc::new(GlobTool::new())]));
    Arc::new(LspTools::new(inner, code.clone()))
}

fn snapshot_names(registry: &Arc<dyn ToolRegistry>, session: &SessionId) -> Vec<String> {
    registry
        .snapshot(session)
        .tools
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect()
}

#[test]
fn the_layer_shows_the_tool_only_while_offered_and_only_per_session() {
    let code = Arc::new(FakeCode::default());
    let registry = layered(&code);
    let session = SessionId::new("sess_1");
    assert_eq!(snapshot_names(&registry, &session), ["Glob"]);
    assert!(registry.find_for(&session, "LSP").is_none(), "hidden");

    code.offered.store(true, Ordering::Relaxed);
    assert_eq!(snapshot_names(&registry, &session), ["Glob", "LSP"]);
    assert_eq!(registry.find_for(&session, "LSP").unwrap().name(), "LSP");
    assert_eq!(
        registry.find_for(&session, "Glob").unwrap().name(),
        "Glob",
        "other names pass through"
    );
    // Lookups without a session never see it, and nothing may restore it as a withheld tool.
    assert!(registry.tools().iter().all(|tool| tool.name() != "LSP"));
    assert!(registry.find("LSP").is_none());
    assert!(registry.withheld("LSP").is_none());

    code.offered.store(false, Ordering::Relaxed);
    assert_eq!(snapshot_names(&registry, &session), ["Glob"]);
    assert!(registry.find_for(&session, "LSP").is_none());
}

async fn search(catalog: &Arc<ToolCatalog>, query: &str) -> String {
    let tool = ToolSearchTool::new(catalog.clone());
    let (progress, _) = mpsc::channel(1);
    let output = tool
        .call(json!({"query": query}), context(), progress)
        .await
        .unwrap();
    output_text(&output)
}

#[tokio::test]
async fn tool_search_loads_the_tool_only_while_offered() {
    let code = Arc::new(FakeCode::default());
    let catalog = Arc::new(ToolCatalog::default());
    let registry = layered(&code);
    catalog.bind(&registry);
    assert_eq!(
        search(&catalog, "select:LSP").await,
        crate::texts_more::NO_DEFERRED_MATCH
    );
    assert_eq!(
        search(&catalog, "language servers definition references").await,
        crate::texts_more::NO_DEFERRED_MATCH
    );
    code.offered.store(true, Ordering::Relaxed);
    assert_eq!(search(&catalog, "select:LSP").await, "<ref:LSP>");
}

/// The layer sits under the deny filter: a whole-tool `LSP` deny rule hides an offered tool from every session lookup.
#[test]
fn a_deny_rule_hides_the_offered_tool() {
    use rust_cli_kernel_api::permission::syntax::parse_rule;
    use rust_cli_kernel_api::permission::{PermissionRules, RuleBehavior, RuleSource, SourcedRule};
    let code = Arc::new(FakeCode::default());
    code.offered.store(true, Ordering::Relaxed);
    let filtered = |denied: &[&str]| -> Arc<dyn ToolRegistry> {
        let rules = PermissionRules {
            rules: denied
                .iter()
                .map(|text| SourcedRule {
                    source: RuleSource::CliArg,
                    behavior: RuleBehavior::Deny,
                    rule: parse_rule(text),
                })
                .collect(),
            ..PermissionRules::default()
        };
        Arc::new(crate::PolicyFiltered::new(
            layered(&code),
            Arc::new(rust_cli_policy::PolicyGate::new(rules)),
        ))
    };
    let session = SessionId::new("sess_1");
    let open = filtered(&[]);
    assert_eq!(snapshot_names(&open, &session), ["Glob", "LSP"]);
    assert!(open.find_for(&session, "LSP").is_some());
    let denied = filtered(&["LSP"]);
    assert_eq!(snapshot_names(&denied, &session), ["Glob"]);
    assert!(denied.find_for(&session, "LSP").is_none());
}
