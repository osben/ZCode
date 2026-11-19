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

    /// The connection moves on without its listeners running: a validate that names the new connection meets a lease
    /// bound to the old one.
    fn silent_change(&self) {
        let next = connection(self.generation() + 1);
        *self.current.lock().unwrap() = Some(next);
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

    // The server reconnects: the lease is revoked and the page is told so, on its session. The call's activity
    // deltas (its pin, F7 PR 3) are not closed notices.
    assert!(
        answers
            .deltas
            .lock()
            .unwrap()
            .iter()
            .all(|(_, delta)| delta.get("activity").is_some())
    );
    host.reconnect();
    let deltas: Vec<(String, Value)> = answers
        .deltas
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, delta)| delta.get("activity").is_none())
        .cloned()
        .collect();
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
async fn a_validate_that_finds_another_connection_closes_the_panel_and_sends_the_closed_notice() {
    // Node's validate closes a lease whose source differs, and the close notice (the abort listener) follows it.
    let (_scope, server, _kernel) = server();
    call(&server, "session/create", automation_create("run_s1"))
        .await
        .expect("the session exists");
    let host = Arc::new(FakeHost::new());
    server.context.set_mcp_app_host(host.clone());
    let answers = Arc::new(RecordingAnswers::default());
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    server.context.set_mcp_ui(RustMcpUi::new(weak));
    let lease = dispatch(&server, "mcp/uiOpenInstance", open_params())
        .await
        .expect("the panel opens");
    let token = lease["token"].as_str().expect("a token").to_owned();

    host.silent_change();
    assert!(
        dispatch(&server, "mcp/uiValidateInstance", scoped(&lease, json!({})))
            .await
            .is_err()
    );
    let deltas = answers.deltas.lock().unwrap().clone();
    assert_eq!(deltas.len(), 1, "one closed notice: {deltas:?}");
    assert_eq!(deltas[0].1["op"], "pluginUi.instanceClosed");
    assert_eq!(deltas[0].1["subscribers"][0]["scopeId"], token);
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
    // Resource subscriptions are PR 4: they stay refused, and no helper answers them for a Rust-run server either.
    for method in ["mcp/uiSubscribeResource", "mcp/uiUnsubscribeResource"] {
        let refused = dispatch(
            &server,
            method,
            json!({"sessionId": "run_s1", "serverName": "files", "pluginId": "p", "workspace": {"workspacePath": "/w"}}),
        )
        .await;
        assert!(refused.is_err(), "{method} stays refused");
    }
}

// ---- F7 PR 3: the app-provided tools of a panel (the mailbox) ----

use rust_cli_kernel_api::app_tool::AppToolHost;
use std::time::Duration;

use super::super::mcp_ui_app_tools::Timing;

fn short_timing(claim_ms: u64, call_ms: u64) -> Timing {
    Timing {
        claim: Duration::from_millis(claim_ms),
        call: Duration::from_millis(call_ms),
    }
}

/// A session with one open panel of `files`; the owner runs with `timing`.
async fn panel(server: &Arc<Server>, timing: Timing) -> (Arc<RecordingAnswers>, Value) {
    call(server, "session/create", automation_create("run_s1"))
        .await
        .expect("the session exists");
    server.context.set_mcp_app_host(Arc::new(FakeHost::new()));
    let answers = Arc::new(RecordingAnswers::default());
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    server
        .context
        .set_mcp_ui(RustMcpUi::with_timing(weak, timing));
    let lease = dispatch(server, "mcp/uiOpenInstance", open_params())
        .await
        .expect("the panel opens");
    (answers, lease)
}

/// A panel request: the scope and generation of its lease, plus `extra`.
fn panel_call(lease: &Value, extra: Value) -> Value {
    let mut params = scoped(
        lease,
        json!({"scopeId": lease["token"], "generation": lease["generation"]}),
    );
    if let (Some(base), Some(more)) = (params.as_object_mut(), extra.as_object()) {
        for (key, value) in more {
            base.insert(key.clone(), value.clone());
        }
    }
    params
}

fn register_params(lease: &Value) -> Value {
    panel_call(
        lease,
        json!({"tools": [
            {"name": "read", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": true}},
            {"name": "write", "inputSchema": {"type": "object"}},
        ]}),
    )
}

fn owner(server: &Arc<Server>) -> Arc<RustMcpUi> {
    server
        .context
        .mcp_ui()
        .expect("the owner is installed")
        .clone()
}

/// Waits for the next model call the mailbox publishes (a `pluginUi.appToolCall` with neither `activity` nor
/// `cancelled`).
async fn next_call_id(answers: &RecordingAnswers) -> String {
    for _ in 0..400 {
        let found = answers
            .deltas
            .lock()
            .unwrap()
            .iter()
            .find(|(_, delta)| {
                delta["op"] == "pluginUi.appToolCall"
                    && delta.get("activity").is_none()
                    && delta.get("cancelled").is_none()
            })
            .map(|(_, delta)| delta["callId"].as_str().unwrap().to_owned());
        if let Some(call_id) = found {
            return call_id;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("no model call was published");
}

fn count_deltas(answers: &RecordingAnswers, pick: impl Fn(&Value) -> bool) -> usize {
    answers
        .deltas
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, delta)| pick(delta))
        .count()
}

fn is_cancel(delta: &Value) -> bool {
    delta["op"] == "pluginUi.appToolCall" && delta.get("cancelled") == Some(&json!(true))
}

#[tokio::test]
async fn a_registered_panel_exposes_its_tools_to_the_session_and_unregister_drops_them() {
    let (_scope, server, _kernel) = server();
    let (_answers, lease) = panel(&server, short_timing(5_000, 30_000)).await;
    let registered = dispatch(&server, "mcp/uiRegisterAppTools", register_params(&lease))
        .await
        .expect("the tools register");
    assert_eq!(
        registered,
        json!({"tools": [
            {"name": "read", "modelName": "app__files__read"},
            {"name": "write", "modelName": "app__files__write"},
        ]})
    );
    let session = SessionId::new("run_s1");
    let names: Vec<String> = owner(&server)
        .app_tools(&session)
        .into_iter()
        .map(|spec| spec.model_name)
        .collect();
    assert_eq!(names, vec!["app__files__read", "app__files__write"]);
    let removed = dispatch(
        &server,
        "mcp/uiUnregisterAppTools",
        panel_call(&lease, json!({})),
    )
    .await
    .expect("the tools unregister");
    assert_eq!(removed, json!({"removed": 2}));
    assert!(owner(&server).app_tools(&session).is_empty());
}

#[tokio::test]
async fn a_model_call_is_claimed_and_resolved_by_its_panel_and_pins_the_lease_meanwhile() {
    let (_scope, server, _kernel) = server();
    let (answers, lease) = panel(&server, short_timing(5_000, 30_000)).await;
    dispatch(&server, "mcp/uiRegisterAppTools", register_params(&lease))
        .await
        .expect("the tools register");
    let ui = owner(&server);
    let session = SessionId::new("run_s1");
    let task = tokio::spawn(async move {
        ui.call(
            &session,
            "turn1",
            "tool-use-1",
            "app__files__read",
            json!({"path": "a"}),
        )
        .await
    });

    let call_id = next_call_id(&answers).await;
    assert_eq!(
        count_deltas(&answers, |d| d.get("activity") == Some(&json!(true))),
        1
    );
    // Busy while the call runs: an idle close keeps the panel open.
    let kept = dispatch(
        &server,
        "mcp/uiCloseInstance",
        panel_call(&lease, json!({"onlyIfIdle": true})),
    )
    .await
    .expect("close answers");
    assert_eq!(kept, json!({"closed": false}));
    let claimed = dispatch(
        &server,
        "mcp/uiClaimAppToolCall",
        panel_call(&lease, json!({"callId": call_id})),
    )
    .await
    .expect("the claim answers");
    assert_eq!(claimed, json!({"accepted": true}));
    // A repeated claim by the same instance is accepted again.
    let repeat = dispatch(
        &server,
        "mcp/uiClaimAppToolCall",
        panel_call(&lease, json!({"callId": call_id})),
    )
    .await
    .expect("the repeat claim answers");
    assert_eq!(repeat, json!({"accepted": true}));
    let resolved = dispatch(
        &server,
        "mcp/uiResolveAppToolCall",
        panel_call(
            &lease,
            json!({"callId": call_id, "result": {"content": [{"type": "text", "text": "done"}]}}),
        ),
    )
    .await
    .expect("the resolve answers");
    assert_eq!(resolved, json!({"accepted": true}));
    assert_eq!(
        task.await
            .expect("the call ends")
            .expect("the call succeeds"),
        json!({"content": [{"type": "text", "text": "done"}]})
    );
    // The pin ends with the call: the activity ends, and an idle close now closes the panel.
    assert_eq!(
        count_deltas(&answers, |d| d.get("activity") == Some(&json!(false))),
        1
    );
    let closed = dispatch(
        &server,
        "mcp/uiCloseInstance",
        panel_call(&lease, json!({"onlyIfIdle": true})),
    )
    .await
    .expect("close answers");
    assert_eq!(closed, json!({"closed": true}));
}

#[tokio::test]
async fn a_resolve_before_the_claim_or_twice_is_refused_and_a_failure_is_cancelled_once() {
    let (_scope, server, _kernel) = server();
    let (answers, lease) = panel(&server, short_timing(5_000, 30_000)).await;
    dispatch(&server, "mcp/uiRegisterAppTools", register_params(&lease))
        .await
        .expect("the tools register");
    let ui = owner(&server);
    let session = SessionId::new("run_s1");
    let task = tokio::spawn(async move {
        ui.call(
            &session,
            "turn1",
            "tool-use-2",
            "app__files__write",
            json!({}),
        )
        .await
    });
    let call_id = next_call_id(&answers).await;

    let early = dispatch(
        &server,
        "mcp/uiResolveAppToolCall",
        panel_call(
            &lease,
            json!({"callId": call_id, "result": {"content": []}}),
        ),
    )
    .await
    .expect("the resolve answers");
    assert_eq!(early, json!({"accepted": false}), "not claimed yet");

    dispatch(
        &server,
        "mcp/uiClaimAppToolCall",
        panel_call(&lease, json!({"callId": call_id})),
    )
    .await
    .expect("the claim answers");
    let failed = dispatch(
        &server,
        "mcp/uiResolveAppToolCall",
        panel_call(
            &lease,
            json!({"callId": call_id, "error": {"message": "page failed"}}),
        ),
    )
    .await
    .expect("the resolve answers");
    assert_eq!(failed, json!({"accepted": true}));
    assert_eq!(task.await.unwrap().unwrap_err(), "page failed");
    let again = dispatch(
        &server,
        "mcp/uiResolveAppToolCall",
        panel_call(
            &lease,
            json!({"callId": call_id, "result": {"content": []}}),
        ),
    )
    .await
    .expect("the resolve answers");
    assert_eq!(again, json!({"accepted": false}), "a call resolves once");
    assert_eq!(count_deltas(&answers, is_cancel), 1);
}

#[tokio::test]
async fn a_claim_from_another_generation_of_the_scope_is_refused_as_a_bad_binding() {
    let (_scope, server, _kernel) = server();
    let (answers, lease) = panel(&server, short_timing(5_000, 30_000)).await;
    dispatch(&server, "mcp/uiRegisterAppTools", register_params(&lease))
        .await
        .expect("the tools register");
    let ui = owner(&server);
    let session = SessionId::new("run_s1");
    let task = tokio::spawn(async move {
        ui.call(
            &session,
            "turn1",
            "tool-use-7",
            "app__files__read",
            json!({}),
        )
        .await
    });
    let call_id = next_call_id(&answers).await;
    let mut stranger = panel_call(&lease, json!({"callId": call_id}));
    stranger["generation"] = json!(99);
    let refused = dispatch(&server, "mcp/uiClaimAppToolCall", stranger).await;
    assert!(refused.is_err(), "the binding names another generation");
    task.abort();
}

#[tokio::test]
async fn a_page_that_never_claims_is_not_running_and_its_tools_are_dropped() {
    let (_scope, server, _kernel) = server();
    let (answers, lease) = panel(&server, short_timing(40, 30_000)).await;
    dispatch(&server, "mcp/uiRegisterAppTools", register_params(&lease))
        .await
        .expect("the tools register");
    let ui = owner(&server);
    let session = SessionId::new("run_s1");
    let error = ui
        .call(
            &session,
            "turn1",
            "tool-use-3",
            "app__files__read",
            json!({}),
        )
        .await
        .unwrap_err();
    assert_eq!(error, "The files app page is not running");
    assert!(ui.app_tools(&session).is_empty(), "the instance is dropped");
    assert_eq!(count_deltas(&answers, is_cancel), 1);
}

#[tokio::test]
async fn a_claimed_call_that_never_resolves_times_out_and_is_cancelled_once() {
    let (_scope, server, _kernel) = server();
    let (answers, lease) = panel(&server, short_timing(5_000, 40)).await;
    dispatch(&server, "mcp/uiRegisterAppTools", register_params(&lease))
        .await
        .expect("the tools register");
    let ui = owner(&server);
    let session = SessionId::new("run_s1");
    let task = tokio::spawn(async move {
        ui.call(
            &session,
            "turn1",
            "tool-use-4",
            "app__files__read",
            json!({}),
        )
        .await
    });
    let call_id = next_call_id(&answers).await;
    dispatch(
        &server,
        "mcp/uiClaimAppToolCall",
        panel_call(&lease, json!({"callId": call_id})),
    )
    .await
    .expect("the claim answers");
    assert_eq!(
        task.await.unwrap().unwrap_err(),
        "App tool read timed out after 40 ms"
    );
    assert_eq!(count_deltas(&answers, is_cancel), 1);
}

#[tokio::test]
async fn cancelling_a_call_publishes_one_cancelled_message_whether_or_not_it_was_claimed() {
    for claimed in [false, true] {
        let (_scope, server, _kernel) = server();
        let (answers, lease) = panel(&server, short_timing(5_000, 30_000)).await;
        dispatch(&server, "mcp/uiRegisterAppTools", register_params(&lease))
            .await
            .expect("the tools register");
        let ui = owner(&server);
        let session = SessionId::new("run_s1");
        let task = tokio::spawn({
            let ui = ui.clone();
            let session = session.clone();
            async move {
                ui.call(
                    &session,
                    "turn1",
                    "tool-use-5",
                    "app__files__read",
                    json!({}),
                )
                .await
            }
        });
        let call_id = next_call_id(&answers).await;
        if claimed {
            dispatch(
                &server,
                "mcp/uiClaimAppToolCall",
                panel_call(&lease, json!({"callId": call_id})),
            )
            .await
            .expect("the claim answers");
        }
        // The turn is cancelled: the kernel drops the call, then cancels it on the registry.
        task.abort();
        let _ = task.await;
        ui.cancel(&session, "tool-use-5").await;
        assert_eq!(count_deltas(&answers, is_cancel), 1, "claimed {claimed}");
        let late = dispatch(
            &server,
            "mcp/uiResolveAppToolCall",
            panel_call(
                &lease,
                json!({"callId": call_id, "result": {"content": []}}),
            ),
        )
        .await
        .expect("the resolve answers");
        assert_eq!(late, json!({"accepted": false}), "claimed {claimed}");
        let claim = dispatch(
            &server,
            "mcp/uiClaimAppToolCall",
            panel_call(&lease, json!({"callId": call_id})),
        )
        .await
        .expect("the claim answers");
        assert_eq!(claim, json!({"accepted": false}), "claimed {claimed}");
    }
}

#[tokio::test]
async fn closing_the_panel_or_the_session_clears_its_tools_and_ends_its_calls() {
    let (_scope, server, _kernel) = server();
    let (answers, lease) = panel(&server, short_timing(5_000, 30_000)).await;
    dispatch(&server, "mcp/uiRegisterAppTools", register_params(&lease))
        .await
        .expect("the tools register");
    let ui = owner(&server);
    let session = SessionId::new("run_s1");
    let task = tokio::spawn({
        let ui = ui.clone();
        let session = session.clone();
        async move {
            ui.call(
                &session,
                "turn1",
                "tool-use-6",
                "app__files__read",
                json!({}),
            )
            .await
        }
    });
    let _call_id = next_call_id(&answers).await;

    let closed = dispatch(
        &server,
        "mcp/uiCloseInstance",
        panel_call(&lease, json!({})),
    )
    .await
    .expect("close answers");
    assert_eq!(closed, json!({"closed": true}));
    assert!(task.await.unwrap().is_err());
    assert!(ui.app_tools(&session).is_empty());
    assert_eq!(
        count_deltas(&answers, |d| d["op"] == "pluginUi.instanceClosed"),
        1
    );

    // A panel registers again, then the session closes: nothing of the session is left.
    let reopened = dispatch(&server, "mcp/uiOpenInstance", open_params())
        .await
        .expect("the panel reopens");
    dispatch(
        &server,
        "mcp/uiRegisterAppTools",
        register_params(&reopened),
    )
    .await
    .expect("the tools register");
    assert_eq!(ui.app_tools(&session).len(), 2);
    ui.session_closed("run_s1");
    assert!(ui.app_tools(&session).is_empty());
}

#[tokio::test]
async fn a_closed_lease_is_refused_and_an_unregister_of_a_session_that_is_gone_removes_nothing() {
    let (_scope, server, _kernel) = server();
    let (_answers, lease) = panel(&server, short_timing(5_000, 30_000)).await;
    dispatch(
        &server,
        "mcp/uiCloseInstance",
        panel_call(&lease, json!({})),
    )
    .await
    .expect("close answers");
    let claim = dispatch(
        &server,
        "mcp/uiClaimAppToolCall",
        panel_call(&lease, json!({"callId": "c"})),
    )
    .await;
    assert!(claim.is_err(), "a closed lease is refused");
    let gone = dispatch(
        &server,
        "mcp/uiUnregisterAppTools",
        json!({
            "workspace": {"workspacePath": "/w", "workspaceKey": "/w"},
            "sessionId": "never_opened",
            "pluginId": "p",
            "serverName": "files",
            "instance": lease,
            "scopeId": lease["token"],
            "generation": lease["generation"],
        }),
    )
    .await
    .expect("the unregister answers");
    assert_eq!(gone, json!({"removed": 0}));
}

/// The `pluginUi.appToolCall` activity deltas of a session, in order (Node `onActivity`).
fn activity_of(answers: &RecordingAnswers) -> Vec<Value> {
    answers
        .deltas
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, delta)| {
            delta["op"] == "pluginUi.appToolCall" && delta.get("activity").is_some()
        })
        .map(|(_, delta)| delta.clone())
        .collect()
}

#[tokio::test]
async fn a_ui_call_publishes_its_pin_as_activity_for_as_long_as_it_runs() {
    let (_scope, server, _kernel) = server();
    call(&server, "session/create", automation_create("run_s1"))
        .await
        .expect("the session exists");
    server.context.set_mcp_app_host(Arc::new(FakeHost::new()));
    let answers = Arc::new(RecordingAnswers::default());
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    server.context.set_mcp_ui(RustMcpUi::new(weak));
    let lease = dispatch(&server, "mcp/uiOpenInstance", open_params())
        .await
        .expect("the panel opens");
    dispatch(
        &server,
        "mcp/uiCallTool",
        scoped(
            &lease,
            json!({"callId": "c1", "toolName": "read", "arguments": {}}),
        ),
    )
    .await
    .expect("the visible tool is called");

    // Node: the call's pin starts as `ui-call:<id>` and ends with the call; both carry the lease as the instance.
    let activity = activity_of(&answers);
    assert_eq!(activity.len(), 2, "start and end: {activity:?}");
    assert_eq!(activity[0]["activity"], json!(true));
    assert_eq!(activity[1]["activity"], json!(false));
    let pin = activity[0]["callId"].as_str().expect("a pin").to_owned();
    assert!(pin.starts_with("ui-call:"), "the pin names the call: {pin}");
    assert_eq!(activity[1]["callId"], json!(pin));
    assert_eq!(activity[0]["toolName"], json!(""));
    assert_eq!(activity[0]["arguments"], json!({}));
    assert_eq!(activity[0]["subscribers"][0]["scopeId"], lease["token"]);
    assert_eq!(activity[0]["subscribers"][0]["instance"], lease);
}

#[tokio::test]
async fn a_panel_sample_publishes_its_operation_as_activity_while_the_model_runs() {
    let (_scope, server, kernel) = server();
    call(&server, "session/create", automation_create("run_s1"))
        .await
        .expect("the session exists");
    kernel.set_sampling(TestSampling::Reply("the model answer".to_owned()));
    server.context.set_mcp_app_host(Arc::new(FakeHost::new()));
    let answers = Arc::new(RecordingAnswers::default());
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    server.context.set_mcp_ui(RustMcpUi::new(weak));
    let lease = dispatch(&server, "mcp/uiOpenInstance", open_params())
        .await
        .expect("the panel opens");
    dispatch(
        &server,
        "mcp/uiSampling",
        scoped(&lease, sampling("op-act")),
    )
    .await
    .expect("the model answers");

    // Node: retain(token, operationId) pins `op-act:<id>` while the sample runs, and releases it when it ends.
    let activity = activity_of(&answers);
    assert_eq!(activity.len(), 2, "start and end: {activity:?}");
    assert_eq!(activity[0]["activity"], json!(true));
    assert_eq!(activity[1]["activity"], json!(false));
    let pin = activity[0]["callId"].as_str().expect("a pin").to_owned();
    assert!(
        pin.starts_with("op-act:"),
        "the pin names the operation: {pin}"
    );
    assert_eq!(activity[1]["callId"], json!(pin));
    assert_eq!(activity[0]["subscribers"][0]["instance"], lease);
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
