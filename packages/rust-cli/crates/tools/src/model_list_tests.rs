//! Node's `list-models-tool.test.ts` and `list-models.test.ts` (contracts), ported (debt round 2026-11-27).

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::provider::{
    CatalogModel, LateModelDirectory, ModelCatalog, ModelDirectory, WireProtocol,
};
use rust_cli_kernel_api::tool::{Tool, ToolError, ToolUseContext, Validation};
use serde_json::json;
use tokio::sync::mpsc;

use super::*;
use crate::test_more::{Ctx, output_text};

const DASH: &str = "\u{2014}";

fn model(provider: &str, label: &str, model: &str, levels: &[&str]) -> CatalogModel {
    CatalogModel {
        provider: provider.to_owned(),
        provider_name: label.to_owned(),
        model: model.to_owned(),
        protocol: WireProtocol::AnthropicMessages,
        reasoning_levels: levels.iter().map(|level| (*level).to_owned()).collect(),
        default_reasoning_level: None,
        context_window: 200_000,
        max_output_tokens: 1,
        capabilities: Default::default(),
        connection: None,
        host: None,
    }
}

struct Directory(Mutex<ModelCatalog>);

impl Directory {
    fn new(models: Vec<CatalogModel>) -> Arc<Self> {
        Arc::new(Self(Mutex::new(ModelCatalog {
            revision: 1,
            models,
            default: None,
        })))
    }

    fn replace(&self, models: Vec<CatalogModel>) {
        self.0.lock().expect("catalog").models = models;
    }
}

#[async_trait]
impl ModelDirectory for Directory {
    async fn catalog(&self) -> ModelCatalog {
        self.0.lock().expect("catalog").clone()
    }
}

/// The session's own model, as the session actor reports it.
struct Session(ModelSelection);

#[async_trait]
impl rust_cli_kernel_api::testing::OpsOverride for Session {
    async fn view(&self) -> Option<rust_cli_kernel_api::orchestration::RunView> {
        let workspace = rust_cli_kernel_api::env::WorkspaceRef {
            environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
            root: rust_cli_kernel_api::env::EnvPath::new("/work"),
        };
        Some(rust_cli_kernel_api::orchestration::RunView {
            selection: Some(self.0.clone()),
            ..rust_cli_kernel_api::orchestration::RunView::new(
                rust_cli_kernel_api::permission::PermissionMode::Default,
                workspace,
            )
        })
    }
}

fn tool_over(directory: Option<Arc<Directory>>) -> ListModelsTool {
    let late = Arc::new(LateModelDirectory::default());
    if let Some(directory) = directory {
        assert!(late.set(directory));
    }
    ListModelsTool::new(late)
}

fn plain_context() -> ToolUseContext {
    Ctx::new(Arc::new(rust_cli_kernel_api::testing::NoOneToAsk)).build()
}

fn context_on(provider: &str, model: &str) -> ToolUseContext {
    Ctx::with_ops(Arc::new(Session(ModelSelection::new(
        provider.to_owned(),
        model.to_owned(),
    ))))
    .build()
}

async fn call(
    tool: &ListModelsTool,
    context: ToolUseContext,
) -> Result<rust_cli_kernel_api::tool::ToolOutput, ToolError> {
    let (progress, _rx) = mpsc::channel(1);
    tool.call(json!({}), context, progress).await
}

#[test]
fn the_contract_is_nodes() {
    let tool = tool_over(None);
    assert_eq!(tool.name(), "ListModels");
    assert!(tool.should_defer());
    assert!(tool.is_read_only(&json!({})));
    assert!(!tool.is_destructive(&json!({})));
    assert!(tool.is_concurrency_safe(&json!({})));
    assert_eq!(tool.result_budget_truncate_bytes(), Some(24_000));
    let schema = tool.input_schema();
    assert_eq!(schema["type"], "object");
    assert_eq!(schema["additionalProperties"], json!(false));
    let description = tool.description(&rust_cli_kernel_api::tool::PromptContext {
        tool_names: Vec::new(),
        mode: rust_cli_kernel_api::permission::PermissionMode::Default,
    });
    assert!(description.starts_with("Lists the models this host has configured, so another tool can be pointed at one.\n\n- Each row's `id`"));
    assert!(description.contains("This tool does NOT change the model you are running on"));
}

#[tokio::test]
async fn it_asks_for_no_permission_and_takes_no_input() {
    let tool = tool_over(None);
    let context = plain_context();
    assert!(matches!(
        tool.check_permissions(&json!({}), &context).await,
        PermissionDecision::Allow { .. }
    ));
    assert_eq!(
        tool.validate_input(&json!({}), &context).await,
        Validation::Ok
    );
    assert!(matches!(
        tool.validate_input(&json!({"filter": "glm"}), &context)
            .await,
        Validation::Invalid { .. }
    ));
}

#[tokio::test]
async fn it_lists_one_line_per_model_and_marks_the_session_s_model() {
    let mut glm = model(
        "bigmodel",
        "BigModel",
        "glm-4.6",
        &["low", "medium", "high"],
    );
    glm.default_reasoning_level = Some("high".to_owned());
    let directory = Directory::new(vec![glm, model("openai", "OpenAI", "gpt-5", &[])]);
    let tool = tool_over(Some(directory));
    let output = call(&tool, context_on("bigmodel", "glm-4.6"))
        .await
        .expect("answers");
    assert!(!output.is_error);
    assert_eq!(
        output_text(&output),
        format!(
            "<models count=\"2\">\nbigmodel/glm-4.6 {DASH} BigModel; levels: low,medium,high (default high) [current]\nopenai/gpt-5 {DASH} OpenAI\n</models>"
        )
    );
}

/// Node `reasoning.default ?? reasoning.values.at(-1)`: a model without a configured default shows its last level.
#[tokio::test]
async fn a_model_without_a_configured_default_shows_its_last_level() {
    let directory = Directory::new(vec![model("p", "", "m", &["low", "high"])]);
    let output = call(&tool_over(Some(directory)), plain_context())
        .await
        .expect("answers");
    assert_eq!(
        output_text(&output),
        "<models count=\"1\">\np/m; levels: low,high (default high)\n</models>"
    );
}

#[tokio::test]
async fn a_blank_provider_name_omits_the_label_and_the_name_is_trimmed() {
    let directory = Directory::new(vec![
        model("a", "   ", "m1", &[]),
        model("b", "  Bee  ", "m2", &[]),
    ]);
    let output = call(&tool_over(Some(directory)), plain_context())
        .await
        .expect("answers");
    assert_eq!(
        output_text(&output),
        format!("<models count=\"2\">\na/m1\nb/m2 {DASH} Bee\n</models>")
    );
}

#[tokio::test]
async fn nothing_is_current_when_the_session_model_is_not_in_the_catalog() {
    let directory = Directory::new(vec![model("a", "A", "m", &[])]);
    let tool = tool_over(Some(directory));
    let output = call(&tool, context_on("gone", "model")).await.expect("ok");
    assert!(!output_text(&output).contains("[current]"));
    assert!(output.display.get("current").is_none());
}

#[tokio::test]
async fn an_empty_catalog_says_so_instead_of_returning_an_empty_block() {
    let tool = tool_over(Some(Directory::new(Vec::new())));
    let output = call(&tool, plain_context()).await.expect("answers");
    assert_eq!(
        output_text(&output),
        "<models count=\"0\">\nNo models are configured on this host. Omit `subagent_model`: the workflow's subagents run on the session model.\n</models>"
    );
}

/// No directory is a capability gap, never an empty list (Node `modelCatalogUnavailableFailure`, code 31).
#[tokio::test]
async fn a_host_without_a_catalog_fails_with_node_s_message_and_code() {
    let error = call(&tool_over(None), plain_context())
        .await
        .expect_err("a failure");
    assert_eq!(
        error,
        ToolError::FailedWithCode {
            message: "model_catalog_unavailable: this session cannot list models \u{2014} the host did not provide a model catalog. This is a capability gap, not an empty configuration. Omit `subagent_model` on CreateWorkflow and AmendWorkflow; the workflow's subagents will run on the session model.".to_owned(),
            code: 31,
        }
    );
}

/// The catalog is read at each call, never frozen at construction (the port's contract).
#[tokio::test]
async fn each_call_reads_the_live_catalog() {
    let directory = Directory::new(vec![model("a", "A", "one", &[])]);
    let tool = tool_over(Some(directory.clone()));
    let first = call(&tool, plain_context()).await.expect("first");
    assert!(output_text(&first).contains("a/one"));
    directory.replace(vec![model("a", "A", "two", &[])]);
    let second = call(&tool, plain_context()).await.expect("second");
    assert!(output_text(&second).contains("a/two"));
    assert!(!output_text(&second).contains("a/one"));
}

#[tokio::test]
async fn the_card_carries_the_catalog_in_node_s_shape() {
    let mut glm = model("bigmodel", "BigModel", "glm-4.6", &["low", "high"]);
    glm.default_reasoning_level = Some("high".to_owned());
    let directory = Directory::new(vec![glm, model("openai", "", "gpt-5", &[])]);
    let output = call(
        &tool_over(Some(directory)),
        context_on("bigmodel", "glm-4.6"),
    )
    .await
    .expect("answers");
    assert_eq!(
        output.display,
        json!({
            "kind": "list_models",
            "current": "bigmodel/glm-4.6",
            "models": [
                {
                    "id": "bigmodel/glm-4.6",
                    "providerId": "bigmodel",
                    "modelId": "glm-4.6",
                    "providerLabel": "BigModel",
                    "reasoningLevels": ["low", "high"],
                    "defaultReasoningLevel": "high",
                    "contextWindow": 200_000
                },
                {
                    "id": "openai/gpt-5",
                    "providerId": "openai",
                    "modelId": "gpt-5",
                    "reasoningLevels": [],
                    "contextWindow": 200_000
                }
            ]
        })
    );
}

/// Node `createListModelsDisplay`: at most 100 rows, and a cut says "not all shown" with `truncated`.
#[tokio::test]
async fn the_card_keeps_at_most_a_hundred_rows() {
    let models: Vec<CatalogModel> = (0..101)
        .map(|index| model("p", "P", &format!("m{index}"), &[]))
        .collect();
    let output = call(&tool_over(Some(Directory::new(models))), plain_context())
        .await
        .expect("answers");
    assert_eq!(output.display["models"].as_array().map(Vec::len), Some(100));
    assert_eq!(output.display["truncated"], json!(true));
    // The model text still lists all of them.
    assert!(output_text(&output).starts_with("<models count=\"101\">"));
}

#[tokio::test]
async fn a_long_provider_label_is_bounded_on_the_card_only() {
    let label = "L".repeat(3000);
    let output = call(
        &tool_over(Some(Directory::new(vec![model("p", &label, "m", &[])]))),
        plain_context(),
    )
    .await
    .expect("answers");
    let shown = output.display["models"][0]["providerLabel"]
        .as_str()
        .expect("label");
    assert_eq!(shown.len(), 2048);
    assert!(shown.ends_with("\n...[truncated]"));
    assert_eq!(output.display["truncated"], json!(true));
    assert!(output_text(&output).contains(&label));
}
