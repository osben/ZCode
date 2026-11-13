//! Workspace model calls (specs/fork-rust-agent-parity.md "Workspace model calls"): the request each call sends to the
//! model port, the result and error shapes, and the operation table behind `workspace/cancelGenerateText`.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::message::{ContentBlock, StopReason, ToolResultContent, Usage};
use rust_cli_kernel_api::model::{
    ApiRole, BlockDelta, ModelError, ModelEvent, ModelRequest, QuerySource,
};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::provider::{
    CatalogConnection, CatalogModel, ModelCapabilities, ModelCatalog, ModelDirectory, WireProtocol,
};
use rust_cli_kernel_api::session_api::{CreateSession, Kernel, KernelError, SessionHandle};
use rust_cli_kernel_api::side_request::SideSource;
use rust_cli_kernel_api::store::{SessionFilter, SessionSummary, StoreQueries};
use rust_cli_kernel_api::testing::{FixedClock, MemoryStore, ScriptedModel, selection};
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::*;
use crate::context::Context;
use crate::server::{Defaults, Server};

struct NoKernel {
    store: Arc<MemoryStore>,
}

#[async_trait]
impl Kernel for NoKernel {
    fn queries(&self) -> Arc<dyn StoreQueries> {
        self.store.clone()
    }

    async fn create_session(&self, _request: CreateSession) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "create".to_owned(),
        })
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Err(KernelError::Unsupported {
            what: "open".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }

    async fn delete_session(&self, _session: &SessionId) -> Result<(), KernelError> {
        Ok(())
    }
}

struct Directory(Vec<CatalogModel>);

#[async_trait]
impl ModelDirectory for Directory {
    async fn catalog(&self) -> ModelCatalog {
        ModelCatalog {
            revision: 1,
            models: self.0.clone(),
            default: None,
        }
    }
}

/// A directory whose catalog waits for one permit of its gate.
struct GatedDirectory(Arc<Notify>);

#[async_trait]
impl ModelDirectory for GatedDirectory {
    async fn catalog(&self) -> ModelCatalog {
        self.0.notified().await;
        Directory(catalog()).catalog().await
    }
}

fn entry(provider: &str, model: &str, levels: &[&str], max_output: u64) -> CatalogModel {
    CatalogModel {
        provider: provider.to_owned(),
        provider_name: provider.to_owned(),
        model: model.to_owned(),
        protocol: WireProtocol::OpenAiChatCompletions,
        reasoning_levels: levels.iter().map(|level| (*level).to_owned()).collect(),
        context_window: 200_000,
        max_output_tokens: max_output,
        capabilities: ModelCapabilities::default(),
        connection: None,
        host: None,
    }
}

fn catalog() -> Vec<CatalogModel> {
    vec![
        entry("p", "small", &[], 256),
        entry("p", "big", &["low", "medium", "high"], 128_000),
        // No `optionSpecs.maxOutputTokens.max`: the catalog reports 0, an unknown limit.
        entry("p", "nolimit", &[], 0),
    ]
}

fn server_with(
    model: Option<Arc<ScriptedModel>>,
    models: Vec<CatalogModel>,
) -> (TaskScope, Arc<Server>) {
    server_on(model, Arc::new(Directory(models)))
}

fn server_on(
    model: Option<Arc<ScriptedModel>>,
    directory: Arc<dyn ModelDirectory>,
) -> (TaskScope, Arc<Server>) {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    context.set_models(directory);
    if let Some(model) = model {
        context.set_model_port(model);
    }
    let kernel = Arc::new(NoKernel {
        store: Arc::new(MemoryStore::default()),
    });
    let server = Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    (scope, server)
}

fn server(model: Arc<ScriptedModel>) -> (TaskScope, Arc<Server>) {
    server_with(Some(model), catalog())
}

fn usage(input: u64, output: u64) -> Usage {
    Usage {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    }
}

/// A streamed reply: the given blocks (text, or a tool call whose input arrives as a JSON delta), then the stop.
fn reply(
    blocks: &[ContentBlock],
    stop: StopReason,
    usage: Usage,
) -> Vec<Result<ModelEvent, ModelError>> {
    let mut events = vec![Ok(ModelEvent::MessageStart {
        id: "msg_1".to_owned(),
        model: "big".to_owned(),
        usage: Usage {
            output_tokens: 0,
            ..usage
        },
    })];
    for (index, block) in blocks.iter().enumerate() {
        match block {
            ContentBlock::Text { text } => {
                events.push(Ok(ModelEvent::BlockStart {
                    index,
                    block: ContentBlock::Text {
                        text: String::new(),
                    },
                }));
                events.push(Ok(ModelEvent::BlockDelta {
                    index,
                    delta: BlockDelta::Text(text.clone()),
                }));
            }
            ContentBlock::ToolUse { id, name, input } => {
                events.push(Ok(ModelEvent::BlockStart {
                    index,
                    block: ContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: json!({}),
                    },
                }));
                events.push(Ok(ModelEvent::BlockDelta {
                    index,
                    delta: BlockDelta::InputJson(input.to_string()),
                }));
            }
            other => events.push(Ok(ModelEvent::BlockStart {
                index,
                block: other.clone(),
            })),
        }
        events.push(Ok(ModelEvent::BlockStop { index }));
    }
    events.push(Ok(ModelEvent::MessageDelta {
        stop_reason: Some(stop),
        usage,
    }));
    events.push(Ok(ModelEvent::MessageStop));
    events
}

fn text(value: &str) -> ContentBlock {
    ContentBlock::Text {
        text: value.to_owned(),
    }
}

fn workspace() -> Value {
    json!({"workspacePath": "/w", "workspaceKey": "/w"})
}

fn texts(request: &ModelRequest) -> Vec<(ApiRole, String)> {
    request
        .messages
        .iter()
        .map(|message| {
            let text = message
                .content
                .iter()
                .filter_map(|content| match &content.block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>();
            (message.role, text)
        })
        .collect()
}

/// The probe is Node's fixed request: system and `hi`, no tools, the lowest listed level and `min(512, max)`; a
/// `length` stop with no text is a success.
#[tokio::test]
async fn the_probe_sends_nodes_request_and_succeeds_on_any_finished_stream() {
    let model = Arc::new(ScriptedModel::new(vec![
        reply(&[], StopReason::MaxTokens, usage(10, 1)),
        reply(&[text("ok")], StopReason::EndTurn, usage(10, 1)),
    ]));
    let (_scope, server) = server(model.clone());

    let small =
        json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "small"}});
    assert_eq!(
        test_connectivity(&server, &small).await.unwrap(),
        json!({"success": true})
    );
    let big = json!({"workspace": workspace(),
        "selection": {"providerId": "p", "modelId": "big", "options": {"reasoningLevel": "high"}}});
    assert_eq!(
        test_connectivity(&server, &big).await.unwrap(),
        json!({"success": true})
    );

    let requests = model.requests();
    assert_eq!(requests.len(), 2);
    for request in &requests {
        assert_eq!(
            request.source,
            QuerySource::Side(SideSource::ConnectivityProbe)
        );
        assert_eq!(request.system.len(), 1);
        assert_eq!(request.system[0].text, "You are ZCode connectivity probe.");
        assert_eq!(texts(request), [(ApiRole::User, "hi".to_owned())]);
        assert!(request.tools.is_empty());
        assert!(request.options.session_id.is_some());
    }
    assert_eq!(requests[0].max_tokens, 256);
    assert_eq!(requests[0].options.provider_max_output_tokens, Some(256));
    assert_eq!(requests[0].selection.reasoning, None);
    assert_eq!(requests[1].max_tokens, 512);
    assert_eq!(requests[1].options.provider_max_output_tokens, Some(512));
    // The lowest listed level, not the selection's own.
    assert_eq!(requests[1].selection.reasoning.as_deref(), Some("low"));
}

/// A provider failure answers `-32603` with Node's classified message and the stable code in `data`; a stream that ends
/// before `message_stop` answers Node's probe message.
#[tokio::test]
async fn probe_failures_answer_nodes_messages() {
    let model = Arc::new(ScriptedModel::new(vec![
        vec![Err(ModelError::InvalidRequest {
            message: "E2E_C91_REJECTED".to_owned(),
        })],
        vec![Ok(ModelEvent::MessageStart {
            id: "m".to_owned(),
            model: "small".to_owned(),
            usage: Usage::default(),
        })],
    ]));
    let (_scope, server) = server(model);
    let params =
        json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "small"}});

    let error = test_connectivity(&server, &params).await.unwrap_err();
    assert_eq!(error.code, -32603);
    assert_eq!(error.message, "Provider rejected the model request.");
    assert_eq!(
        error.data,
        Some(json!({"name": "ModelProtocolError", "code": "invalid_model_request"}))
    );

    let error = test_connectivity(&server, &params).await.unwrap_err();
    assert_eq!(error.code, -32603);
    assert_eq!(error.message, "模型连通性测试流在 finish 事件前结束");
}

/// Every model failure class maps to Node's classified message and code.
#[test]
fn model_failures_map_to_nodes_classification() {
    let cases = [
        (
            ModelError::Cancelled,
            "Model request was cancelled.",
            "model_request_cancelled",
        ),
        (
            ModelError::Authentication {
                message: "bad key".to_owned(),
            },
            "Provider authentication failed.",
            "provider_not_configured",
        ),
        (
            ModelError::RateLimited {
                message: "slow".to_owned(),
                retry_after_ms: None,
            },
            "Provider rate limited the model request.",
            "model_rate_limited",
        ),
        (
            ModelError::Overloaded {
                message: "busy".to_owned(),
            },
            "Provider is overloaded.",
            "model_request_failed",
        ),
        (
            ModelError::Server {
                status: 502,
                message: "bad gateway".to_owned(),
            },
            "Provider returned a server error.",
            "model_request_failed",
        ),
        (
            ModelError::Network {
                message: "refused".to_owned(),
            },
            "Network connection failed for the provider request.",
            "model_request_failed",
        ),
        (
            ModelError::PromptTooLong {
                message: "long".to_owned(),
            },
            "Model request exceeded the provider context window.",
            "model_context_exceeded",
        ),
        (
            ModelError::Protocol {
                message: "stream ended before message_stop".to_owned(),
            },
            "protocol error: stream ended before message_stop",
            "invalid_model_response",
        ),
        (
            ModelError::StreamIdle { idle_ms: 1 },
            "Stream idle timeout - no chunks received",
            "model_request_timeout",
        ),
    ];
    for (error, message, code) in cases {
        let failure = model_failure(&error);
        assert_eq!(failure.code, -32603, "{error:?}");
        assert_eq!(failure.message, message, "{error:?}");
        assert_eq!(
            failure.data,
            Some(json!({"name": "ModelProtocolError", "code": code})),
            "{error:?}"
        );
    }
}

/// Unknown provider, unknown model and an unlisted level answer Node's registry errors without a model request.
#[tokio::test]
async fn unknown_selections_answer_nodes_registry_errors() {
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let (_scope, server) = server(model.clone());
    let probe = |selection: Value| json!({"workspace": workspace(), "selection": selection});

    let error = test_connectivity(
        &server,
        &probe(json!({"providerId": "q", "modelId": "small"})),
    )
    .await
    .unwrap_err();
    assert_eq!(error.message, "Provider Registry 中不存在 Provider: q");
    assert_eq!(error.data.unwrap()["code"], "provider_not_found");

    let error = test_connectivity(
        &server,
        &probe(json!({"providerId": "p", "modelId": "nope"})),
    )
    .await
    .unwrap_err();
    assert_eq!(error.message, "Provider Registry 中不存在 Model: p/nope");
    assert_eq!(error.data.unwrap()["code"], "model_not_found");

    // Node normalizes an unlisted level away before the strict factory, so an unlisted and a missing level both
    // answer "required".
    // The auxiliary sources too: Node's strict factory checks the level before the auxiliary options are bound.
    for (options, source) in [
        (json!({"reasoningLevel": "max"}), "x"),
        (json!({}), "x"),
        (json!({}), "git_commit_message"),
    ] {
        let generate = json!({"workspace": workspace(), "querySource": source, "prompt": "hi",
            "selection": {"providerId": "p", "modelId": "big", "options": options}});
        let error = generate_text(&server, &generate).await.unwrap_err();
        assert_eq!(error.message, "Reasoning level is required for p/big");
        assert_eq!(error.data.unwrap()["code"], "invalid_model_request");
    }
    assert!(model.requests().is_empty());
}

/// A Team Plan entry's account connection is carried into the request selection.
#[tokio::test]
async fn the_catalog_connection_is_carried() {
    let model = Arc::new(ScriptedModel::new(vec![reply(
        &[text("ok")],
        StopReason::EndTurn,
        usage(1, 1),
    )]));
    let mut team = entry("p", "small", &[], 256);
    let id = rust_cli_kernel_api::model::ModelConnection {
        product_id: "prod".to_owned(),
        organization_id: "org".to_owned(),
        project_id: "proj".to_owned(),
    };
    team.connection = Some(CatalogConnection {
        id: id.clone(),
        vendor: "Z.AI".to_owned(),
        name: "Team".to_owned(),
    });
    let (_scope, server) = server_with(Some(model.clone()), vec![team]);
    let params =
        json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "small"}});
    test_connectivity(&server, &params).await.unwrap();
    assert_eq!(
        model.requests()[0].selection.connection.as_deref(),
        Some(&id)
    );
}

/// A prompt is one trimmed user message; the result is the text, the AI SDK finish reason, Node's normalized usage and
/// the echoed selection. `git_commit_message` uses the auxiliary options and ignores a caller budget.
#[tokio::test]
async fn generate_text_with_a_prompt() {
    let model = Arc::new(ScriptedModel::new(vec![
        reply(
            &[text("feat: add"), text(" things")],
            StopReason::EndTurn,
            Usage {
                input_tokens: 10,
                output_tokens: 4,
                cache_creation_input_tokens: 2,
                cache_read_input_tokens: 3,
            },
        ),
        reply(&[text("x")], StopReason::MaxTokens, usage(1, 1)),
        reply(&[text("y")], StopReason::EndTurn, usage(1, 1)),
    ]));
    let (_scope, server) = server(model.clone());
    let selection =
        json!({"providerId": "p", "modelId": "big", "options": {"reasoningLevel": "high"}});

    let result = generate_text(
        &server,
        &json!({"workspace": workspace(), "selection": selection, "prompt": "  write it  ",
            "querySource": "git_commit_message", "maxOutputTokens": 64}),
    )
    .await
    .unwrap();
    assert_eq!(
        result,
        json!({
            "text": "feat: add things",
            "selection": selection,
            "finishReason": "stop",
            "usage": {"inputTokens": 15, "outputTokens": 4, "totalTokens": 19,
                "cacheReadTokens": 3, "cacheWriteTokens": 2},
        })
    );

    let other = generate_text(
        &server,
        &json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "small"},
            "prompt": "p", "querySource": "custom_source", "maxOutputTokens": 64}),
    )
    .await
    .unwrap();
    assert_eq!(other["finishReason"], "length");
    assert_eq!(
        other["selection"],
        json!({"providerId": "p", "modelId": "small"})
    );
    generate_text(
        &server,
        &json!({"workspace": workspace(), "selection": selection, "prompt": "p",
            "querySource": " workspace_generate_text "}),
    )
    .await
    .unwrap();

    let requests = model.requests();
    assert_eq!(
        requests[0].source,
        QuerySource::Side(SideSource::GitCommitMessage)
    );
    assert_eq!(
        texts(&requests[0]),
        [(ApiRole::User, "write it".to_owned())]
    );
    assert!(requests[0].system.is_empty());
    // Auxiliary: the lowest level and min(5000, max); the caller's 64 is ignored.
    assert_eq!(requests[0].selection.reasoning.as_deref(), Some("low"));
    assert_eq!(requests[0].max_tokens, 5_000);
    assert_eq!(requests[0].options.provider_max_output_tokens, Some(5_000));

    assert_eq!(
        requests[1].source,
        QuerySource::Side(SideSource::WorkspaceText)
    );
    assert_eq!(requests[1].selection.reasoning, None);
    assert_eq!(requests[1].max_tokens, 64);
    assert_eq!(requests[1].options.provider_max_output_tokens, Some(64));

    // No budget given: the model's maxOutputTokens, and the provider patch keeps its configured limit.
    assert_eq!(
        requests[2].source,
        QuerySource::Side(SideSource::WorkspaceText)
    );
    assert_eq!(requests[2].selection.reasoning.as_deref(), Some("high"));
    assert_eq!(requests[2].max_tokens, 128_000);
    assert_eq!(requests[2].options.provider_max_output_tokens, None);
}

/// Messages map in order (leading system → system blocks, assistant tool calls → `tool_use`, consecutive tool results
/// → one user message), tools are sent as given, and the reply's tool calls come back as `toolCalls`.
#[tokio::test]
async fn generate_text_with_messages_and_tools() {
    let call = ContentBlock::ToolUse {
        id: rust_cli_kernel_api::ids::ToolUseId::new("call_2"),
        name: "lookup".to_owned(),
        input: json!({"q": "x"}),
    };
    let model = Arc::new(ScriptedModel::new(vec![reply(
        &[text("checking"), call],
        StopReason::ToolUse,
        usage(5, 2),
    )]));
    let (_scope, server) = server(model.clone());
    let params = json!({
        "workspace": workspace(),
        "selection": {"providerId": "p", "modelId": "big", "options": {"reasoningLevel": "medium"}},
        "querySource": "agent_step",
        "messages": [
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": "find x"},
            {"role": "assistant", "content": "", "toolCalls": [
                {"id": "call_1", "name": "lookup", "input": {"q": "a"}},
                {"id": "call_0", "name": "lookup", "input": {"q": "b"}}]},
            {"role": "tool", "content": "A", "toolCallId": "call_1", "toolName": "lookup"},
            {"role": "tool", "content": "boom", "toolCallId": "call_0", "toolName": "lookup", "isError": true},
            {"role": "system", "content": "later note"},
        ],
        "tools": [{"name": "lookup", "inputSchema": {"type": "object"}},
            {"name": "other", "description": "d", "inputSchema": {"type": "object"}}],
    });

    let result = generate_text(&server, &params).await.unwrap();
    assert_eq!(result["text"], "checking");
    assert_eq!(result["finishReason"], "tool-calls");
    assert_eq!(
        result["toolCalls"],
        json!([{"id": "call_2", "name": "lookup", "input": {"q": "x"}}])
    );

    let request = &model.requests()[0];
    assert_eq!(request.system.len(), 1);
    assert_eq!(request.system[0].text, "be brief");
    let roles: Vec<ApiRole> = request
        .messages
        .iter()
        .map(|message| message.role)
        .collect();
    assert_eq!(
        roles,
        [
            ApiRole::User,
            ApiRole::Assistant,
            ApiRole::User,
            ApiRole::System
        ]
    );
    let assistant: Vec<&ContentBlock> = request.messages[1]
        .content
        .iter()
        .map(|content| &content.block)
        .collect();
    assert_eq!(assistant.len(), 2, "an empty assistant text is not sent");
    assert!(
        matches!(assistant[0], ContentBlock::ToolUse { id, input, .. } if id.as_str() == "call_1" && input == &json!({"q": "a"}))
    );
    let results: Vec<(String, String, bool)> = request.messages[2]
        .content
        .iter()
        .map(|content| match &content.block {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let text = match content.as_slice() {
                    [ToolResultContent::Text { text }] => text.clone(),
                    other => panic!("unexpected tool result content {other:?}"),
                };
                (tool_use_id.as_str().to_owned(), text, *is_error)
            }
            other => panic!("unexpected block {other:?}"),
        })
        .collect();
    assert_eq!(
        results,
        [
            ("call_1".to_owned(), "A".to_owned(), false),
            ("call_0".to_owned(), "boom".to_owned(), true)
        ]
    );
    assert_eq!(
        texts(request)[3],
        (ApiRole::System, "later note".to_owned())
    );
    assert_eq!(request.tools.len(), 2);
    assert_eq!(request.tools[0].name, "lookup");
    assert_eq!(request.tools[0].description, "");
    assert_eq!(request.tools[1].description, "d");
    assert_eq!(request.tools[0].input_schema, json!({"type": "object"}));
}

/// Neither `prompt` nor `messages` answers Node's refine message; zod trims before `min(1)`, so a blank prompt, query
/// source or operation id is invalid params too.
#[tokio::test]
async fn generate_text_needs_input() {
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let (_scope, server) = server(model.clone());
    let base = json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "big"},
        "querySource": "x"});
    let error = generate_text(&server, &base).await.unwrap_err();
    assert_eq!(error.code, -32602);
    assert!(
        error
            .message
            .contains("prompt 或 messages 至少需要提供一个"),
        "{}",
        error.message
    );

    for (field, value) in [
        ("prompt", "   "),
        ("querySource", " "),
        ("operationId", "\t"),
    ] {
        let mut blank = base.clone();
        blank["prompt"] = json!("p");
        blank[field] = json!(value);
        let error = generate_text(&server, &blank).await.unwrap_err();
        assert_eq!(error.code, -32602, "{field}");
    }
    assert!(model.requests().is_empty());
}

/// The call's requester session is registered with its workspace while the request runs (the Host's account
/// credentials need it) and forgotten afterwards.
#[tokio::test]
async fn the_requester_session_is_registered_for_the_call() {
    let gate = Arc::new(Notify::new());
    let model = Arc::new(
        ScriptedModel::new(vec![reply(&[text("ok")], StopReason::EndTurn, usage(1, 1))])
            .gated(gate.clone()),
    );
    let (_scope, server) = server(model.clone());
    let params =
        json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "small"}});
    let running = tokio::spawn({
        let server = server.clone();
        async move { test_connectivity(&server, &params).await }
    });
    let session = loop {
        if let Some(request) = model.requests().first() {
            break request.options.session_id.clone().unwrap();
        }
        tokio::task::yield_now().await;
    };
    assert_eq!(
        server.context.workspace_of(session.as_str()).as_deref(),
        Some("/w")
    );
    gate.notify_one();
    running.await.unwrap().unwrap();
    assert_eq!(server.context.workspace_of(session.as_str()), None);
}

/// A cancel of a running operation answers `cancelled: true` and the call fails as cancelled; an unknown id answers
/// `false`; a duplicate active id answers `-32600` and leaves the first running; a finished id can be reused.
#[tokio::test]
async fn cancel_generate_text_by_operation_id() {
    let gate = Arc::new(Notify::new());
    let model = Arc::new(
        ScriptedModel::new(vec![
            reply(&[text("never")], StopReason::EndTurn, usage(1, 1)),
            reply(&[text("again")], StopReason::EndTurn, usage(1, 1)),
        ])
        .gated(gate.clone()),
    );
    let (_scope, server) = server(model.clone());
    let params = json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "small"},
        "prompt": "p", "querySource": "x", "operationId": "op-1"});

    assert_eq!(
        cancel(&server, &json!({"operationId": "op-1"})).unwrap(),
        json!({"operationId": "op-1", "cancelled": false})
    );
    let running = tokio::spawn({
        let server = server.clone();
        let params = params.clone();
        async move { generate_text(&server, &params).await }
    });
    while model.requests().is_empty() {
        tokio::task::yield_now().await;
    }
    let duplicate = generate_text(&server, &params).await.unwrap_err();
    assert_eq!(duplicate.code, -32600);
    assert_eq!(
        duplicate.message,
        "Workspace generate operation is already active: op-1"
    );
    assert_eq!(
        cancel(&server, &json!({"operationId": "op-1"})).unwrap(),
        json!({"operationId": "op-1", "cancelled": true})
    );
    let error = running.await.unwrap().unwrap_err();
    assert_eq!(error.message, "Model request was cancelled.");
    assert_eq!(error.data.unwrap()["code"], "model_request_cancelled");
    assert_eq!(
        cancel(&server, &json!({"operationId": "op-1"})).unwrap(),
        json!({"operationId": "op-1", "cancelled": false})
    );

    // The id is free again once the call ended.
    let again = tokio::spawn({
        let server = server.clone();
        async move { generate_text(&server, &params).await }
    });
    while model.requests().len() < 2 {
        tokio::task::yield_now().await;
    }
    gate.notify_one();
    assert_eq!(again.await.unwrap().unwrap()["text"], "again");
}

/// Without a model port (an entry that did not wire one) the methods stay unported (`-32601`).
#[tokio::test]
async fn without_a_model_port_the_methods_are_not_served() {
    let (_scope, server) = server_with(None, catalog());
    for method in [
        "workspace/generateText",
        "workspace/cancelGenerateText",
        "provider/testModelConnectivity",
    ] {
        assert!(
            crate::fork::methods::dispatch(&server, method, json!({}))
                .await
                .is_none(),
            "{method}"
        );
    }
}

/// The operation is registered before the catalog is read (Node registers it before any await): a cancel that arrives
/// meanwhile answers `cancelled: true` and no model request is sent.
#[tokio::test]
async fn a_cancel_before_the_model_request_is_not_missed() {
    let gate = Arc::new(Notify::new());
    let model = Arc::new(ScriptedModel::new(vec![reply(
        &[text("late")],
        StopReason::EndTurn,
        usage(1, 1),
    )]));
    let (_scope, server) = server_on(Some(model.clone()), Arc::new(GatedDirectory(gate.clone())));
    let params = json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "small"},
        "prompt": "p", "querySource": "x", "operationId": "op-early"});
    let running = tokio::spawn({
        let server = server.clone();
        async move { generate_text(&server, &params).await }
    });
    loop {
        let answer = cancel(&server, &json!({"operationId": "op-early"})).unwrap();
        if answer["cancelled"] == json!(true) {
            break;
        }
        tokio::task::yield_now().await;
    }
    gate.notify_one();
    let error = running.await.unwrap().unwrap_err();
    assert_eq!(error.data.unwrap()["code"], "model_request_cancelled");
    assert!(model.requests().is_empty());
}

/// Node uses `messages` when both `prompt` and `messages` are given.
#[tokio::test]
async fn messages_win_over_a_prompt() {
    let model = Arc::new(ScriptedModel::new(vec![reply(
        &[text("ok")],
        StopReason::EndTurn,
        usage(1, 1),
    )]));
    let (_scope, server) = server(model.clone());
    let params = json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "small"},
        "querySource": "x", "prompt": "from prompt",
        "messages": [{"role": "user", "content": "from messages"}]});
    generate_text(&server, &params).await.unwrap();
    assert_eq!(
        texts(&model.requests()[0]),
        [(ApiRole::User, "from messages".to_owned())]
    );
}

/// Without an operation id the call is bounded by Node's 60 s and answers its timeout, cancelling the model request.
#[tokio::test(start_paused = true)]
async fn a_call_without_an_operation_times_out_after_sixty_seconds() {
    let model = Arc::new(
        ScriptedModel::new(vec![reply(
            &[text("never")],
            StopReason::EndTurn,
            usage(1, 1),
        )])
        .gated(Arc::new(Notify::new())),
    );
    let (_scope, server) = server(model.clone());
    let params =
        json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "small"}});
    let started = tokio::time::Instant::now();
    let error = test_connectivity(&server, &params).await.unwrap_err();
    assert_eq!(error.message, "Model request timed out.");
    assert_eq!(error.data.unwrap()["code"], "model_request_timeout");
    assert_eq!(started.elapsed(), std::time::Duration::from_secs(60));
}

/// A model without a declared output limit (catalog 0) keeps the fixed budgets and falls back to the unknown-model
/// limit; a caller budget above a known limit is rejected like Node's `validateOptions`, never clamped.
#[tokio::test]
async fn output_budgets_respect_known_and_unknown_limits() {
    let ok = || reply(&[text("ok")], StopReason::EndTurn, usage(1, 1));
    let model = Arc::new(ScriptedModel::new(vec![ok(), ok(), ok(), ok(), ok()]));
    let (_scope, server) = server(model.clone());
    let nolimit = json!({"providerId": "p", "modelId": "nolimit"});
    test_connectivity(
        &server,
        &json!({"workspace": workspace(), "selection": nolimit}),
    )
    .await
    .unwrap();
    for source in ["git_commit_message", "x"] {
        generate_text(
            &server,
            &json!({"workspace": workspace(), "selection": nolimit, "prompt": "p", "querySource": source}),
        )
        .await
        .unwrap();
    }
    // Within the known limit the caller budget is sent as is.
    generate_text(
        &server,
        &json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "small"},
            "prompt": "p", "querySource": "x", "maxOutputTokens": 256}),
    )
    .await
    .unwrap();
    for budget in [257_u64, 10_000_000_000] {
        let error = generate_text(
            &server,
            &json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "small"},
                "prompt": "p", "querySource": "x", "maxOutputTokens": budget}),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, -32603);
        assert_eq!(
            error.message,
            "maxOutputTokens is outside the model option range"
        );
        assert_eq!(error.data.unwrap()["code"], "invalid_model_request");
    }
    // An unknown limit cannot reject a caller budget: it is sent as is.
    generate_text(
        &server,
        &json!({"workspace": workspace(), "selection": nolimit, "prompt": "p", "querySource": "x",
            "maxOutputTokens": 100_000}),
    )
    .await
    .unwrap();

    let requests = model.requests();
    assert_eq!(requests.len(), 5, "a rejected budget sends no request");
    assert_eq!(requests[4].max_tokens, 100_000);
    assert_eq!(
        requests[4].options.provider_max_output_tokens,
        Some(100_000)
    );
    assert_eq!(requests[0].max_tokens, 512);
    assert_eq!(requests[0].options.provider_max_output_tokens, Some(512));
    assert_eq!(requests[1].max_tokens, 5_000);
    assert_eq!(requests[1].options.provider_max_output_tokens, Some(5_000));
    assert_eq!(requests[2].max_tokens, 32_000);
    assert_eq!(requests[2].options.provider_max_output_tokens, None);
    assert_eq!(requests[3].max_tokens, 256);
    assert_eq!(requests[3].options.provider_max_output_tokens, Some(256));
}

/// Input prediction binds the auxiliary budget (5000 capped by the model limit), a caller budget overrides it within
/// the limit, and a caller budget above the limit is rejected (Node merges request options over the bound ones and
/// validates the result).
#[tokio::test]
async fn input_prediction_budget_follows_the_model_limit() {
    let ok = || reply(&[text("ok")], StopReason::EndTurn, usage(1, 1));
    let model = Arc::new(ScriptedModel::new(vec![ok(), ok()]));
    let (_scope, server) = server(model.clone());
    let small = json!({"providerId": "p", "modelId": "small"});
    generate_text(
        &server,
        &json!({"workspace": workspace(), "selection": small, "prompt": "p", "querySource": "input_prediction"}),
    )
    .await
    .unwrap();
    generate_text(
        &server,
        &json!({"workspace": workspace(), "selection": small, "prompt": "p", "querySource": "input_prediction",
            "maxOutputTokens": 100}),
    )
    .await
    .unwrap();
    let error = generate_text(
        &server,
        &json!({"workspace": workspace(), "selection": small, "prompt": "p", "querySource": "input_prediction",
            "maxOutputTokens": 257}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.message,
        "maxOutputTokens is outside the model option range"
    );
    assert_eq!(error.data.unwrap()["code"], "invalid_model_request");

    let requests = model.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].max_tokens, 256);
    assert_eq!(requests[1].max_tokens, 100);
    assert_eq!(requests[1].options.provider_max_output_tokens, Some(100));
}

/// A reply without a stop reason reads `unknown` (the stored rows' and the AI SDK's name), `StopReason::Unknown`
/// reads `other`; a stream that ends before `message_stop` is an invalid response, not a truncated success.
#[tokio::test]
async fn finish_reasons_and_unfinished_streams() {
    let mut no_stop = reply(&[text("a")], StopReason::EndTurn, usage(1, 1));
    no_stop.retain(|event| !matches!(event, Ok(ModelEvent::MessageDelta { .. })));
    let unfinished = vec![
        Ok(ModelEvent::MessageStart {
            id: "m".to_owned(),
            model: "small".to_owned(),
            usage: Usage::default(),
        }),
        Ok(ModelEvent::BlockStart {
            index: 0,
            block: text("partial"),
        }),
    ];
    let model = Arc::new(ScriptedModel::new(vec![
        no_stop,
        reply(&[text("b")], StopReason::Unknown, usage(1, 1)),
        unfinished,
    ]));
    let (_scope, server) = server(model);
    let params = json!({"workspace": workspace(), "selection": {"providerId": "p", "modelId": "small"},
        "prompt": "p", "querySource": "x"});
    assert_eq!(
        generate_text(&server, &params).await.unwrap()["finishReason"],
        "unknown"
    );
    assert_eq!(
        generate_text(&server, &params).await.unwrap()["finishReason"],
        "other"
    );
    let error = generate_text(&server, &params).await.unwrap_err();
    assert_eq!(error.code, -32603);
    assert_eq!(error.data.unwrap()["code"], "invalid_model_response");
}
