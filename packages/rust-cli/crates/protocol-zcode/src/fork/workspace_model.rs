//! Fork: workspace-scoped model calls (Node `runtime/methods/workspace-generate-text.ts`, bootstrap
//! `withWorkspaceGenerateTextSignal` / `cancelWorkspaceGenerateText`; specs/fork-rust-agent-parity.md "Workspace model
//! calls"): the Git commit message generator's `workspace/generateText`, its cancel, and the model settings
//! connectivity probe `provider/testModelConnectivity`. Each call is one side request through the entry's model port;
//! no session, row or usage fact is written.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::{SessionId, ToolUseId};
use rust_cli_kernel_api::message::{ContentBlock, StopReason, ToolResultContent, Usage};
use rust_cli_kernel_api::model::{
    ApiContent, ApiMessage, ApiRole, BlockDelta, ModelError, ModelEvent, ModelRequest,
    ModelSelection, SystemBlock, ToolDefinition,
};
use rust_cli_kernel_api::provider::CatalogModel;
use rust_cli_kernel_api::side_request::{Requester, SideSource};
use rust_cli_protocol_core::rpc::{RpcError, codes};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::context::Context;
use crate::server::Server;

/// Node `WORKSPACE_GENERATE_TEXT_TIMEOUT_MS`: the bound when the caller gave no cancellable operation.
const TIMEOUT: Duration = Duration::from_secs(60);
const PROBE_SYSTEM: &str = "You are ZCode connectivity probe.";
const PROBE_USER: &str = "hi";
/// Node `CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS`.
const PROBE_MAX_OUTPUT: u64 = 512;
/// Node `auxiliaryModelOptions`: the output budget of auxiliary calls.
const AUXILIARY_MAX_OUTPUT: u64 = 5_000;
/// The output limit of a model whose configuration declares none.
const UNKNOWN_MAX_OUTPUT: u32 = rust_cli_prompts::models::UNKNOWN_MAX_OUTPUT_TOKENS;
/// Node `validateOptions` (`adapters/src/model/model.ts`): a caller budget above the model limit is rejected.
const BUDGET_OUT_OF_RANGE: &str = "maxOutputTokens is outside the model option range";
const PROBE_UNFINISHED: &str = "模型连通性测试流在 finish 事件前结束";
/// The params refine of `zcodeWorkspaceGenerateTextParamsSchema` (not expressible in the generated JSON schema).
const NEEDS_INPUT: &str = "prompt 或 messages 至少需要提供一个";
const GIT_COMMIT_MESSAGE: &str = "git_commit_message";
const INPUT_PREDICTION: &str = "input_prediction";

/// The running `workspace/generateText` calls by `operationId` (Node `workspaceGenerateTextOperations`). Each entry
/// carries a generation so a finished call never removes a newer call that reused its id.
#[derive(Default)]
pub(crate) struct Operations {
    generation: AtomicU64,
    active: Mutex<HashMap<String, (u64, CancellationToken)>>,
}

impl Operations {
    fn start(&self, id: &str) -> Result<Operation<'_>, RpcError> {
        let mut active = self.active.lock_unpoisoned();
        if active.contains_key(id) {
            return Err(RpcError::new(
                codes::INVALID_REQUEST,
                format!("Workspace generate operation is already active: {id}"),
            ));
        }
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        let token = CancellationToken::new();
        active.insert(id.to_owned(), (generation, token.clone()));
        Ok(Operation {
            operations: self,
            id: id.to_owned(),
            generation,
            token,
        })
    }

    /// Cancels and forgets the operation; false when no call runs under the id.
    fn cancel(&self, id: &str) -> bool {
        let entry = self.active.lock_unpoisoned().remove(id);
        entry.is_some_and(|(_, token)| {
            token.cancel();
            true
        })
    }
}

/// A registered operation; dropping it forgets the entry when it is still this call's.
struct Operation<'a> {
    operations: &'a Operations,
    id: String,
    generation: u64,
    token: CancellationToken,
}

impl Drop for Operation<'_> {
    fn drop(&mut self) {
        let mut active = self.operations.active.lock_unpoisoned();
        if active
            .get(&self.id)
            .is_some_and(|(generation, _)| *generation == self.generation)
        {
            active.remove(&self.id);
        }
    }
}

/// The call's requester session, registered with its workspace while the request runs: the Host's per-request account
/// credentials are asked for with the requesting session's workspace.
struct Registered<'a> {
    context: &'a Context,
    session: SessionId,
}

impl<'a> Registered<'a> {
    fn new(context: &'a Context, workspace: &str) -> Self {
        let session = SessionId::new(context.fresh("workspace-model"));
        context.register(session.as_str(), workspace);
        Self { context, session }
    }
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.context.unregister(self.session.as_str());
    }
}

/// `-32603` with Node `toProtocolError`'s `data` for a `ModelProtocolError` (the stack is not sent).
fn protocol_error(code: &str, message: impl Into<String>) -> RpcError {
    RpcError::new(codes::INTERNAL_ERROR, message)
        .with_data(json!({"name": "ModelProtocolError", "code": code}))
}

/// Node `classifyModelFailure` for each model port failure: the classified message and its stable code.
fn model_failure(error: &ModelError) -> RpcError {
    let (code, message) = match error {
        ModelError::Cancelled => ("model_request_cancelled", "Model request was cancelled."),
        ModelError::Authentication { .. } => {
            ("provider_not_configured", "Provider authentication failed.")
        }
        ModelError::RateLimited { .. } | ModelError::QuotaExhausted { .. } => (
            "model_rate_limited",
            "Provider rate limited the model request.",
        ),
        ModelError::Overloaded { .. } => ("model_request_failed", "Provider is overloaded."),
        ModelError::Server { .. } => ("model_request_failed", "Provider returned a server error."),
        ModelError::Network { .. } => (
            "model_request_failed",
            "Network connection failed for the provider request.",
        ),
        ModelError::PromptTooLong { .. } => (
            "model_context_exceeded",
            "Model request exceeded the provider context window.",
        ),
        ModelError::InvalidRequest { .. }
        | ModelError::RequestTooLarge { .. }
        | ModelError::CurrentAttachmentsTooLarge => (
            "invalid_model_request",
            "Provider rejected the model request.",
        ),
        // Node keeps an invalid response's own message.
        ModelError::Protocol { .. } => {
            return protocol_error("invalid_model_response", error.to_string());
        }
        ModelError::StreamIdle { .. } => {
            return protocol_error("model_request_timeout", error.to_string());
        }
        ModelError::ContentBlocked { .. }
        | ModelError::Unsupported { .. }
        | ModelError::FallbackTriggered { .. } => ("model_request_failed", "Model request failed."),
    };
    protocol_error(code, message)
}

fn timed_out() -> RpcError {
    protocol_error("model_request_timeout", "Model request timed out.")
}

/// A zod `z.string().trim().min(1)` field: trimmed, and invalid params when blank.
fn trimmed<'a>(value: &'a Value, field: &str) -> Result<Option<&'a str>, RpcError> {
    match value.get(field).and_then(Value::as_str) {
        None => Ok(None),
        Some(text) => {
            let text = text.trim();
            if text.is_empty() {
                Err(RpcError::invalid_params(format!(
                    "{field} must not be empty"
                )))
            } else {
                Ok(Some(text))
            }
        }
    }
}

fn required<'a>(value: &'a Value, field: &str) -> Result<&'a str, RpcError> {
    trimmed(value, field)?.ok_or_else(|| RpcError::invalid_params(format!("{field} is required")))
}

/// The App's `modelSelectionSchema`, trimmed.
struct Wanted {
    provider: String,
    model: String,
    reasoning: Option<String>,
}

impl Wanted {
    fn parse(params: &Value) -> Result<Self, RpcError> {
        let selection = &params["selection"];
        Ok(Self {
            provider: required(selection, "providerId")?.to_owned(),
            model: required(selection, "modelId")?.to_owned(),
            reasoning: trimmed(&selection["options"], "reasoningLevel")?.map(str::to_owned),
        })
    }

    /// The result's `selection` (Node echoes the request: `options` only when given).
    fn echo(&self) -> Value {
        let mut selection = json!({"providerId": self.provider, "modelId": self.model});
        if let Some(level) = &self.reasoning {
            selection["options"] = json!({"reasoningLevel": level});
        }
        selection
    }
}

/// The directory entry of the selection (Node `validateSelection`'s first two checks).
async fn entry(context: &Context, wanted: &Wanted) -> Result<CatalogModel, RpcError> {
    let catalog = context.catalog().await;
    if !catalog
        .iter()
        .any(|model| model.provider == wanted.provider)
    {
        return Err(protocol_error(
            "provider_not_found",
            format!("Provider Registry 中不存在 Provider: {}", wanted.provider),
        ));
    }
    catalog
        .iter()
        .find(|model| model.provider == wanted.provider && model.model == wanted.model)
        .cloned()
        .ok_or_else(|| {
            protocol_error(
                "model_not_found",
                format!(
                    "Provider Registry 中不存在 Model: {}/{}",
                    wanted.provider, wanted.model
                ),
            )
        })
}

fn selection(entry: &CatalogModel, reasoning: Option<String>) -> ModelSelection {
    ModelSelection {
        provider: entry.provider.clone(),
        model: entry.model.clone(),
        reasoning,
        connection: entry
            .connection
            .as_ref()
            .map(|connection| Box::new(connection.id.clone())),
    }
}

/// The model's output limit; the catalog reports 0 when the configuration declares no
/// `optionSpecs.maxOutputTokens.max`, which is unknown, not zero.
fn limit(entry: &CatalogModel) -> Option<u64> {
    (entry.max_output_tokens > 0).then_some(entry.max_output_tokens)
}

/// A fixed budget (probe, auxiliary) capped by the model's known limit (Node `Math.min(budget, spec.max)`).
fn capped(entry: &CatalogModel, budget: u64) -> u64 {
    limit(entry).map_or(budget, |max| budget.min(max))
}

/// A caller budget is sent as is within the model's known limit and rejected above it, never clamped.
fn within(entry: &CatalogModel, budget: u64) -> Result<u64, RpcError> {
    match limit(entry) {
        Some(max) if budget > max => {
            Err(protocol_error("invalid_model_request", BUDGET_OUT_OF_RANGE))
        }
        _ => Ok(budget),
    }
}

/// `max_tokens` is a `u32` on the wire.
fn tokens(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// A side request whose output budget the provider patch also uses (Node binds `maxOutputTokens` on the model).
fn budgeted(mut request: ModelRequest, budget: Option<u64>) -> ModelRequest {
    if let Some(budget) = budget {
        request.max_tokens = tokens(budget);
        request.options.provider_max_output_tokens = Some(tokens(budget));
    }
    request
}

/// What one streamed reply left: text and tool calls in block order, the last usage, the stop reason, and whether the
/// stream reached `message_stop` (the AI SDK `finish` event).
#[derive(Default)]
struct Collected {
    blocks: BTreeMap<usize, Block>,
    usage: Usage,
    stop: Option<StopReason>,
    finished: bool,
}

enum Block {
    Text(String),
    Tool {
        id: ToolUseId,
        name: String,
        input: Value,
        json: String,
    },
    Other,
}

impl Collected {
    fn push(&mut self, event: ModelEvent) {
        match event {
            ModelEvent::MessageStart { usage, .. } => self.usage = usage,
            ModelEvent::BlockStart { index, block } => {
                let block = match block {
                    ContentBlock::Text { text } => Block::Text(text),
                    ContentBlock::ToolUse { id, name, input } => Block::Tool {
                        id,
                        name,
                        input,
                        json: String::new(),
                    },
                    _ => Block::Other,
                };
                self.blocks.insert(index, block);
            }
            ModelEvent::BlockDelta { index, delta } => match (self.blocks.get_mut(&index), delta) {
                (Some(Block::Text(text)), BlockDelta::Text(more)) => text.push_str(&more),
                (Some(Block::Tool { json, .. }), BlockDelta::InputJson(more)) => {
                    json.push_str(&more);
                }
                _ => {}
            },
            ModelEvent::MessageDelta { stop_reason, usage } => {
                self.stop = stop_reason.or(self.stop);
                self.usage = usage;
            }
            ModelEvent::MessageStop => self.finished = true,
            ModelEvent::BlockStop { .. } => {}
        }
    }

    fn text(&self) -> String {
        self.blocks
            .values()
            .filter_map(|block| match block {
                Block::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn tool_calls(&self) -> Vec<Value> {
        self.blocks
            .values()
            .filter_map(|block| match block {
                Block::Tool {
                    id,
                    name,
                    input,
                    json,
                } => {
                    let input = if json.trim().is_empty() {
                        input.clone()
                    } else {
                        serde_json::from_str(json).unwrap_or_else(|_| Value::String(json.clone()))
                    };
                    Some(json!({"id": id.as_str(), "name": name, "input": input}))
                }
                _ => None,
            })
            .collect()
    }

    /// The AI SDK `finishReason` (same mapping as the stored assistant rows): no stop reason is `unknown`.
    fn finish_reason(&self) -> &'static str {
        match self.stop {
            Some(StopReason::EndTurn | StopReason::StopSequence | StopReason::PauseTurn) => "stop",
            Some(StopReason::MaxTokens | StopReason::ModelContextWindowExceeded) => "length",
            Some(StopReason::ToolUse) => "tool-calls",
            Some(StopReason::Refusal) => "content-filter",
            Some(StopReason::Unknown) => "other",
            None => "unknown",
        }
    }

    /// Node `normalizeUsage` of the AI SDK usage: input counts the cached tokens too.
    fn usage(&self) -> Value {
        let usage = self.usage;
        let input =
            usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
        json!({
            "inputTokens": input,
            "outputTokens": usage.output_tokens,
            "totalTokens": input + usage.output_tokens,
            "cacheReadTokens": usage.cache_read_input_tokens,
            "cacheWriteTokens": usage.cache_creation_input_tokens,
        })
    }
}

/// Streams the request to the end. `operation` is the caller's cancellable operation; without one the call is bounded
/// by [`TIMEOUT`].
async fn run(
    server: &Server,
    request: ModelRequest,
    operation: Option<&Operation<'_>>,
) -> Result<Collected, RpcError> {
    let port = server
        .context
        .model_port()
        .ok_or_else(|| protocol_error("model_request_failed", "Model request failed."))?;
    let token = operation.map_or_else(CancellationToken::new, |operation| operation.token.clone());
    if token.is_cancelled() {
        return Err(model_failure(&ModelError::Cancelled));
    }
    let mut stream = port.stream(request, token.clone());
    let collect = async {
        let mut collected = Collected::default();
        while let Some(event) = stream.next().await {
            if token.is_cancelled() {
                return Err(model_failure(&ModelError::Cancelled));
            }
            collected.push(event.map_err(|error| model_failure(&error))?);
        }
        if token.is_cancelled() {
            return Err(model_failure(&ModelError::Cancelled));
        }
        Ok(collected)
    };
    if operation.is_some() {
        return collect.await;
    }
    match tokio::time::timeout(TIMEOUT, collect).await {
        Ok(result) => result,
        Err(_) => {
            token.cancel();
            Err(timed_out())
        }
    }
}

fn workspace_path(params: &Value) -> Result<&str, RpcError> {
    required(&params["workspace"], "workspacePath")
}

/// `provider/testModelConnectivity` (Node `testModelConnectivity`).
pub(super) async fn test_connectivity(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let wanted = Wanted::parse(params)?;
    let workspace = workspace_path(params)?;
    let entry = entry(&server.context, &wanted).await?;
    // Node `completeAuxiliaryRegistryModelSelection`: the lowest listed level, whatever the selection asked for.
    let selection = selection(&entry, entry.reasoning_levels.first().cloned());
    let registered = Registered::new(&server.context, workspace);
    let request = ModelRequest::side(
        selection,
        SideSource::ConnectivityProbe,
        vec![SystemBlock {
            text: PROBE_SYSTEM.to_owned(),
            cache_control: None,
        }],
        vec![ApiMessage::user_text(PROBE_USER.to_owned())],
        0,
        Requester {
            session: registered.session.clone(),
            run: None,
            agent: None,
        },
    );
    let request = budgeted(request, Some(capped(&entry, PROBE_MAX_OUTPUT)));
    let collected = run(server, request, None).await?;
    if !collected.finished {
        return Err(RpcError::new(codes::INTERNAL_ERROR, PROBE_UNFINISHED)
            .with_data(json!({"name": "Error"})));
    }
    Ok(json!({"success": true}))
}

/// `workspace/generateText` (Node `generateWorkspaceText`).
pub(super) async fn generate_text(server: &Server, params: &Value) -> Result<Value, RpcError> {
    if params.get("prompt").is_none_or(Value::is_null)
        && params.get("messages").is_none_or(Value::is_null)
    {
        return Err(RpcError::invalid_params(format!(
            "Invalid params for workspace/generateText: {NEEDS_INPUT}"
        )));
    }
    let prompt = trimmed(params, "prompt")?;
    let query_source = required(params, "querySource")?;
    let operation_id = trimmed(params, "operationId")?;
    let wanted = Wanted::parse(params)?;
    let workspace = workspace_path(params)?;
    // Node registers the operation before any await, so a cancel sent right after the call is never missed.
    let operation = operation_id
        .map(|id| server.workspace_operations.start(id))
        .transpose()?;
    // Node prefers `messages` when both are given.
    let (system, messages) = match (params["messages"].as_array(), prompt) {
        (Some(items), _) => conversation(items),
        (None, Some(prompt)) => (Vec::new(), vec![ApiMessage::user_text(prompt.to_owned())]),
        (None, None) => (Vec::new(), Vec::new()),
    };
    let tools = tools(&params["tools"]);

    let entry = entry(&server.context, &wanted).await?;
    // Node normalizes an unlisted level away, then its strict factory requires one.
    let level = wanted
        .reasoning
        .clone()
        .filter(|level| entry.reasoning_levels.contains(level));
    if level.is_none() && !entry.reasoning_levels.is_empty() {
        return Err(protocol_error(
            "invalid_model_request",
            format!(
                "Reasoning level is required for {}/{}",
                wanted.provider, wanted.model
            ),
        ));
    }
    let auxiliary = query_source == GIT_COMMIT_MESSAGE || query_source == INPUT_PREDICTION;
    let (level, budget) = if auxiliary {
        // Node `auxiliaryModelOptions`; the Git call ignores a caller budget.
        // Request options override the bound ones, so a non-Git caller budget replaces 5000 and is validated.
        let budget = match params["maxOutputTokens"].as_u64() {
            Some(caller) if query_source != GIT_COMMIT_MESSAGE => within(&entry, caller)?,
            _ => capped(&entry, AUXILIARY_MAX_OUTPUT),
        };
        (entry.reasoning_levels.first().cloned(), Some(budget))
    } else {
        let budget = params["maxOutputTokens"].as_u64();
        (
            level,
            budget.map(|budget| within(&entry, budget)).transpose()?,
        )
    };
    let source = if query_source == GIT_COMMIT_MESSAGE {
        SideSource::GitCommitMessage
    } else {
        SideSource::WorkspaceText
    };

    let registered = Registered::new(&server.context, workspace);
    let mut request = ModelRequest::side(
        selection(&entry, level),
        source,
        system,
        messages,
        limit(&entry).map_or(UNKNOWN_MAX_OUTPUT, tokens),
        Requester {
            session: registered.session.clone(),
            run: None,
            agent: None,
        },
    );
    request.tools = tools;
    let request = budgeted(request, budget);
    let collected = run(server, request, operation.as_ref()).await?;
    // A stream that ended without `message_stop` and without an error is a truncated reply, not a result.
    if !collected.finished {
        return Err(protocol_error(
            "invalid_model_response",
            "Model returned an invalid response.",
        ));
    }

    let mut result = json!({
        "text": collected.text(),
        "selection": wanted.echo(),
        "finishReason": collected.finish_reason(),
        "usage": collected.usage(),
    });
    let calls = collected.tool_calls();
    if !calls.is_empty() {
        result["toolCalls"] = Value::Array(calls);
    }
    Ok(result)
}

/// `workspace/cancelGenerateText` (Node `cancelWorkspaceGenerateText`).
pub(super) fn cancel(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let id = required(params, "operationId")?;
    let cancelled = server.workspace_operations.cancel(id);
    Ok(json!({"operationId": id, "cancelled": cancelled}))
}

fn text_content(text: &str) -> ApiContent {
    ApiContent {
        block: ContentBlock::Text {
            text: text.to_owned(),
        },
        cache_control: None,
        meta: false,
    }
}

fn message(role: ApiRole, content: Vec<ApiContent>) -> ApiMessage {
    ApiMessage {
        role,
        content,
        output_config: None,
    }
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().unwrap_or_default()
}

/// The App's model messages as the model port's conversation: leading system messages become the system prompt, a later
/// one a mid-conversation system message; an assistant message carries its text and tool calls; consecutive tool
/// results share one user message.
fn conversation(items: &[Value]) -> (Vec<SystemBlock>, Vec<ApiMessage>) {
    let mut system = Vec::new();
    let mut messages: Vec<ApiMessage> = Vec::new();
    let mut previous_tool = false;
    for item in items {
        let content = str_field(item, "content");
        let role = str_field(item, "role");
        let tool = role == "tool";
        match role {
            "system" if messages.is_empty() => system.push(SystemBlock {
                text: content.to_owned(),
                cache_control: None,
            }),
            "system" => messages.push(message(ApiRole::System, vec![text_content(content)])),
            "assistant" => {
                let mut blocks = Vec::new();
                if !content.is_empty() {
                    blocks.push(text_content(content));
                }
                for call in item["toolCalls"].as_array().into_iter().flatten() {
                    blocks.push(ApiContent {
                        block: ContentBlock::ToolUse {
                            id: ToolUseId::new(str_field(call, "id").trim()),
                            name: str_field(call, "name").trim().to_owned(),
                            input: call.get("input").cloned().unwrap_or(Value::Null),
                        },
                        cache_control: None,
                        meta: false,
                    });
                }
                messages.push(message(ApiRole::Assistant, blocks));
            }
            "tool" => {
                let result = ApiContent {
                    block: ContentBlock::ToolResult {
                        tool_use_id: ToolUseId::new(str_field(item, "toolCallId").trim()),
                        content: vec![ToolResultContent::Text {
                            text: content.to_owned(),
                        }],
                        is_error: item["isError"].as_bool().unwrap_or(false),
                    },
                    cache_control: None,
                    meta: false,
                };
                match messages.last_mut() {
                    Some(last) if previous_tool => last.content.push(result),
                    _ => messages.push(message(ApiRole::User, vec![result])),
                }
            }
            _ => messages.push(message(ApiRole::User, vec![text_content(content)])),
        }
        previous_tool = tool;
    }
    (system, messages)
}

fn tools(value: &Value) -> Vec<ToolDefinition> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|tool| ToolDefinition {
            name: str_field(tool, "name").trim().to_owned(),
            description: str_field(tool, "description").to_owned(),
            input_schema: tool
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| json!({})),
            cache_control: None,
        })
        .collect()
}

#[cfg(test)]
#[path = "workspace_model_tests.rs"]
mod tests;
