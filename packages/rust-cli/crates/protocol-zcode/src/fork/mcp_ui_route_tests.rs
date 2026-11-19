//! Fork (F7 PR 1): the panel methods of a Rust-run server through the protocol server's router, with a fake
//! [`McpAppHost`]: open, call, a reconnect (generation bump), then the revoke notice and the refusals that follow.

use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp_app::{
    McpAppConnection, McpAppError, McpAppHost, McpAppOwner, McpAppSubscription,
};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::super::legacy_session::tests::{TestSampling, automation_create, call, server};
use super::super::node_helper::HelperRequests;
use super::RustMcpUi;
use crate::server::Server;

/// A server the protocol test owns: `files` is Rust-run, `helper` is not in the table.
struct FakeHost {
    current: Mutex<Option<McpAppConnection>>,
    listeners: Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
}

impl FakeHost {
    fn new() -> Self {
        Self {
            current: Mutex::new(Some(connection(1))),
            listeners: Mutex::new(Vec::new()),
        }
    }

    /// A reconnect: the generation moves on and the connection listeners run (as the extension layer does).
    fn reconnect(&self) {
        let next = connection(self.generation() + 1);
        *self.current.lock().unwrap() = Some(next);
        let listeners = self.listeners.lock().unwrap().clone();
        for listener in listeners {
            listener();
        }
    }

    fn generation(&self) -> u64 {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .map_or(0, |connection| connection.generation)
    }
}

fn connection(generation: u64) -> McpAppConnection {
    McpAppConnection {
        identity: "id-files".to_owned(),
        generation,
    }
}

#[async_trait]
impl McpAppHost for FakeHost {
    fn owner(&self, _session: &SessionId, server: &str) -> Option<McpAppOwner> {
        (server == "files").then_some(McpAppOwner::Rust)
    }

    fn connection(&self, _session: &SessionId, _server: &str) -> Option<McpAppConnection> {
        self.current.lock().unwrap().clone()
    }

    async fn wait_connection(
        &self,
        session: &SessionId,
        server: &str,
        _cancel: &CancellationToken,
    ) -> Option<McpAppConnection> {
        self.connection(session, server)
    }

    fn on_connection_changed(
        &self,
        _session: &SessionId,
        _server: &str,
        callback: Arc<dyn Fn() + Send + Sync>,
    ) -> Option<McpAppSubscription> {
        self.listeners.lock().unwrap().push(callback);
        Some(Box::new(()))
    }

    fn tool_visibility(
        &self,
        _session: &SessionId,
        _server: &str,
        tool: &str,
    ) -> Option<Vec<String>> {
        match tool {
            "read" => Some(vec!["app".to_owned()]),
            "model-only" => Some(vec!["model".to_owned()]),
            _ => None,
        }
    }

    async fn request(
        &self,
        _session: &SessionId,
        _server: &str,
        expected: &McpAppConnection,
        method: &str,
        _params: Value,
        _cancel: &CancellationToken,
    ) -> Result<Value, McpAppError> {
        if self.current.lock().unwrap().as_ref() != Some(expected) {
            return Err(McpAppError::Changed);
        }
        Ok(match method {
            "resources/read" => {
                json!({"contents": [{"uri": "ui://a", "mimeType": "text/html", "text": "<p>"}]})
            }
            _ => json!({"content": []}),
        })
    }
}

/// Records the `pluginUi.*` deltas the owner sends to a session.
#[derive(Default)]
struct RecordingAnswers {
    deltas: Mutex<Vec<(String, Value)>>,
}

#[async_trait]
impl HelperRequests for RecordingAnswers {
    async fn authorize_app_tool(
        &self,
        _params: Value,
        _cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    async fn sample_model(
        &self,
        _params: Value,
        _cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    async fn session_workspace(&self, _session: &str) -> Option<Value> {
        None
    }

    fn session_delta(&self, session: &str, delta: Value) {
        self.deltas
            .lock()
            .unwrap()
            .push((session.to_owned(), delta));
    }
}

fn open_params() -> Value {
    json!({
        "workspace": {"workspacePath": "/w", "workspaceKey": "/w"},
        "sessionId": "run_s1",
        "pluginId": "p",
        "serverName": "files",
        "scopeId": "scope1",
        "resourceUri": "ui://a",
        "ownerWebContentsId": 7,
    })
}

/// The shared fields of a request on the open panel.
fn scoped(lease: &Value, extra: Value) -> Value {
    let mut params = json!({
        "workspace": {"workspacePath": "/w", "workspaceKey": "/w"},
        "sessionId": "run_s1",
        "pluginId": "p",
        "serverName": "files",
        "instance": lease,
    });
    if let (Some(base), Some(more)) = (params.as_object_mut(), extra.as_object()) {
        for (key, value) in more {
            base.insert(key.clone(), value.clone());
        }
    }
    params
}

async fn dispatch(server: &Server, method: &str, params: Value) -> Result<Value, RpcError> {
    server
        .dispatch(method, params)
        .await
        .map(|reply| reply.result)
}

#[tokio::test]
async fn a_panel_of_a_rust_run_server_opens_calls_and_is_revoked_by_a_reconnect() {
    let (_scope, server, _kernel) = server();
    call(&server, "session/create", automation_create("run_s1"))
        .await
        .expect("the session exists");
    let host = Arc::new(FakeHost::new());
    server.context.set_mcp_app_host(host.clone());
    let answers = Arc::new(RecordingAnswers::default());
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    server.context.set_mcp_ui(RustMcpUi::new(weak));

    // open: the lease is bound to the server's current connection.
    let lease = dispatch(&server, "mcp/uiOpenInstance", open_params())
        .await
        .expect("the panel opens");
    let token = lease["token"].as_str().expect("a token").to_owned();
    assert!(lease["generation"].as_u64().is_some());

    // validate and a visible tool call both pass on the current connection.
    dispatch(&server, "mcp/uiValidateInstance", scoped(&lease, json!({})))
        .await
        .expect("the lease is valid");
    let answer = dispatch(
        &server,
        "mcp/uiCallTool",
        scoped(
            &lease,
            json!({"callId": "c1", "toolName": "read", "arguments": {}}),
        ),
    )
    .await
    .expect("the visible tool is called");
    assert_eq!(answer, json!({"content": []}));
    // A tool the page may not call is refused before anything is sent.
    let refused = dispatch(
        &server,
        "mcp/uiCallTool",
        scoped(
            &lease,
            json!({"callId": "c2", "toolName": "model-only", "arguments": {}}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(
        refused.data.as_ref().unwrap()["reason"],
        "tool_not_app_visible"
    );

    // The server reconnects: the lease is revoked and the page is told so, on its session.
    assert!(answers.deltas.lock().unwrap().is_empty());
    host.reconnect();
    let deltas = answers.deltas.lock().unwrap().clone();
    assert_eq!(deltas.len(), 1, "one closed notice: {deltas:?}");
    assert_eq!(deltas[0].0, "run_s1");
    assert_eq!(deltas[0].1["op"], "pluginUi.instanceClosed");
    assert_eq!(deltas[0].1["subscribers"][0]["scopeId"], token);

    // Everything the old lease names is refused from now on.
    assert!(
        dispatch(&server, "mcp/uiValidateInstance", scoped(&lease, json!({})))
            .await
            .is_err()
    );
    assert!(
        dispatch(
            &server,
            "mcp/uiCallTool",
            scoped(
                &lease,
                json!({"callId": "c3", "toolName": "read", "arguments": {}})
            ),
        )
        .await
        .is_err()
    );
    // A fresh open on the new connection works again.
    let fresh = dispatch(&server, "mcp/uiOpenInstance", open_params())
        .await
        .expect("a new panel opens on the new connection");
    assert_ne!(fresh["token"], lease["token"]);
}

#[tokio::test]
async fn panel_methods_outside_the_owned_set_stay_refused_for_a_rust_run_server() {
    let (_scope, server, _kernel) = server();
    call(&server, "session/create", automation_create("run_s1"))
        .await
        .expect("the session exists");
    let host = Arc::new(FakeHost::new());
    server.context.set_mcp_app_host(host);
    let answers = Arc::new(RecordingAnswers::default());
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    server.context.set_mcp_ui(RustMcpUi::new(weak));
    // App tools and resource subscriptions are PR 3 and PR 4: they are not routed, so no helper answers them either.
    for method in ["mcp/uiRegisterAppTools", "mcp/uiSubscribeResource"] {
        let refused = dispatch(
            &server,
            method,
            json!({"sessionId": "run_s1", "serverName": "files", "pluginId": "p", "workspace": {"workspacePath": "/w"}}),
        )
        .await;
        assert!(refused.is_err(), "{method} stays refused");
    }
}

fn sampling(operation: &str) -> Value {
    json!({
        "operationId": operation,
        "request": {
            "messages": [{"role": "user", "content": {"type": "text", "text": "describe"}}],
            "maxTokens": 64,
        },
    })
}

#[tokio::test]
async fn a_panel_samples_on_the_session_model_and_an_operation_id_is_single_use() {
    let (_scope, server, kernel) = server();
    call(&server, "session/create", automation_create("run_s1"))
        .await
        .expect("the session exists");
    kernel.set_sampling(TestSampling::Reply("the model answer".to_owned()));
    let host = Arc::new(FakeHost::new());
    server.context.set_mcp_app_host(host);
    let answers = Arc::new(RecordingAnswers::default());
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    server.context.set_mcp_ui(RustMcpUi::new(weak));
    let lease = dispatch(&server, "mcp/uiOpenInstance", open_params())
        .await
        .expect("the panel opens");

    let reply = dispatch(&server, "mcp/uiSampling", scoped(&lease, sampling("op-1")))
        .await
        .expect("the model answers");
    assert_eq!(reply["role"], "assistant");
    assert_eq!(reply["content"]["text"], "the model answer");
    assert_eq!(reply["stopReason"], "endTurn");

    let again = dispatch(&server, "mcp/uiSampling", scoped(&lease, sampling("op-1")))
        .await
        .expect_err("a finished operation id is refused");
    assert!(again.message.contains("Duplicate"));
    // A cancel of an id that never ran records it as terminal, and reports that nothing was in flight.
    let cancelled = dispatch(
        &server,
        "mcp/uiCancelSampling",
        scoped(&lease, json!({"operationId": "op-2"})),
    )
    .await
    .expect("the cancel is recorded");
    assert_eq!(cancelled, json!({"cancelled": false}));
}

#[tokio::test]
async fn a_reconnect_cancels_the_panels_sampling_in_flight() {
    let (_scope, server, kernel) = server();
    call(&server, "session/create", automation_create("run_s1"))
        .await
        .expect("the session exists");
    kernel.set_sampling(TestSampling::Hold);
    let host = Arc::new(FakeHost::new());
    server.context.set_mcp_app_host(host.clone());
    let answers = Arc::new(RecordingAnswers::default());
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    server.context.set_mcp_ui(RustMcpUi::new(weak));
    let lease = dispatch(&server, "mcp/uiOpenInstance", open_params())
        .await
        .expect("the panel opens");

    let in_flight = {
        let server = Arc::clone(&server);
        let lease = lease.clone();
        tokio::spawn(async move {
            dispatch(&server, "mcp/uiSampling", scoped(&lease, sampling("op-1"))).await
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), kernel.sampling_started())
        .await
        .expect("the model call starts");

    // The generation moves on: the lease ends, and its operation is cancelled before the panel hears of the close.
    host.reconnect();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), in_flight)
        .await
        .expect("the call ends after the cancel")
        .expect("the call joins");
    let error = outcome.expect_err("the in-flight sampling is cancelled");
    assert!(error.message.contains("cancelled"), "{}", error.message);
    assert!(
        answers
            .deltas
            .lock()
            .unwrap()
            .iter()
            .any(|(_, delta)| delta["op"] == "pluginUi.instanceClosed")
    );
    // The lease is gone: a later sampling on it is refused.
    let late = dispatch(&server, "mcp/uiSampling", scoped(&lease, sampling("op-2")))
        .await
        .expect_err("a revoked lease cannot sample");
    assert!(late.message.contains("no longer authorized"));
}

#[tokio::test]
async fn an_operation_id_counts_utf16_units_as_node_does() {
    let (_scope, server, kernel) = server();
    call(&server, "session/create", automation_create("run_s1"))
        .await
        .expect("the session exists");
    kernel.set_sampling(TestSampling::Reply("ok".to_owned()));
    let host = Arc::new(FakeHost::new());
    server.context.set_mcp_app_host(host);
    let answers = Arc::new(RecordingAnswers::default());
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    server.context.set_mcp_ui(RustMcpUi::new(weak));
    let lease = dispatch(&server, "mcp/uiOpenInstance", open_params())
        .await
        .expect("the panel opens");

    // 64 astral characters are 128 UTF-16 units: the longest id Node's `.max(128)` accepts.
    let longest = "\u{1F600}".repeat(64);
    dispatch(
        &server,
        "mcp/uiSampling",
        scoped(&lease, sampling(&longest)),
    )
    .await
    .expect("128 units are accepted");
    // 65 are 130 units (65 characters): refused before the operation is admitted.
    let too_long = "\u{1F600}".repeat(65);
    let error = dispatch(
        &server,
        "mcp/uiSampling",
        scoped(&lease, sampling(&too_long)),
    )
    .await
    .expect_err("130 units are refused");
    assert_eq!(error.code, -32602);
    assert!(error.message.contains("128"), "{}", error.message);
}

#[tokio::test]
async fn a_kernel_reply_that_does_not_fit_the_result_schema_is_refused() {
    let (_scope, server, kernel) = server();
    call(&server, "session/create", automation_create("run_s1"))
        .await
        .expect("the session exists");
    kernel.set_sampling(TestSampling::Raw(
        rust_cli_kernel_api::sampling::SamplingReply {
            model: String::new(),
            text: "ok".to_owned(),
            stop_reason: "endTurn".to_owned(),
        },
    ));
    let host = Arc::new(FakeHost::new());
    server.context.set_mcp_app_host(host);
    let answers = Arc::new(RecordingAnswers::default());
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    server.context.set_mcp_ui(RustMcpUi::new(weak));
    let lease = dispatch(&server, "mcp/uiOpenInstance", open_params())
        .await
        .expect("the panel opens");

    let error = dispatch(&server, "mcp/uiSampling", scoped(&lease, sampling("op-1")))
        .await
        .expect_err("an empty model is refused");
    assert_eq!(error.code, -32603);
    assert!(
        error.message.contains("Sampling result is invalid"),
        "{}",
        error.message
    );
}
