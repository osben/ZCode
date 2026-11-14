//! Fork: helper sessions (specs/fork-rust-node-helper.md F3, "Session open and close").

use std::sync::atomic::{AtomicUsize, Ordering};

use rust_cli_kernel_api::mcp::McpTransportEvent;

use super::*;

const SESSION_METHOD: &str = "mcp/uiCallTool";

/// Where the test sessions live; the agent itself runs in `<home>/.zcode` (the Host's shared local task runtime).
const PROJECT: &str = "/home/ZCodeProject";
/// The execution worktree of the `wt-*` test sessions.
const WORKTREE: &str = "/home/.zcode/worktrees/ZCodeProject/task-1";

fn catalog() -> HelperCatalog {
    HelperCatalog {
        plugin_ids: vec!["viewer@inline".to_owned(), "skills-only@inline".to_owned()],
        helper_plugins: vec!["viewer@inline".to_owned()],
        servers: vec!["plugin:viewer:view".to_owned()],
    }
}

/// Pipes echo as [`mcp_echo`]; `helper/session/open` acts as `open` says; every other request echoes its params.
fn sessions(open: impl Fn(usize) -> Act + Send + Sync + 'static) -> Arc<Behaviour> {
    let pipes = mcp_echo();
    let opens = AtomicUsize::new(0);
    behaviour(move |launch, method, params| match method {
        "helper/session/open" => open(opens.fetch_add(1, Ordering::SeqCst)),
        "helper/mcp/connect" | "helper/mcp/send" | "helper/mcp/close" => {
            pipes(launch, method, params)
        }
        _ => Act::Reply {
            notes: Vec::new(),
            result: params.clone(),
        },
    })
}

fn opened() -> Act {
    Act::Reply {
        notes: Vec::new(),
        result: json!({}),
    }
}

/// The agent's session rows: `id-*` sessions carry a workspace identity, `gone` has no row, every other one lives in
/// [`PROJECT`] with no identity (as Rust's local rows).
struct Rows;

#[async_trait]
impl HelperRequests for Rows {
    async fn authorize_app_tool(
        &self,
        _params: Value,
        _cancel: tokio_util::sync::CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    async fn sample_model(
        &self,
        _params: Value,
        _cancel: tokio_util::sync::CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    fn session_delta(&self, _session: &str, _delta: Value) {}

    async fn session_workspace(&self, session: &str) -> Option<Value> {
        match session {
            "gone" => None,
            identified if identified.starts_with("id-") => {
                Some(json!({"workspacePath": PROJECT, "workspaceIdentity": "remote-1"}))
            }
            _ => Some(json!({"workspacePath": PROJECT})),
        }
    }

    async fn session_execution_directory(&self, session: &str) -> Option<String> {
        session.starts_with("wt-").then(|| WORKTREE.to_owned())
    }

    async fn session_root(&self, session: &str) -> Option<String> {
        session.strip_prefix("sub-").map(|_| "root-1".to_owned())
    }
}

static ROWS: std::sync::LazyLock<Arc<Rows>> = std::sync::LazyLock::new(|| Arc::new(Rows));

fn session_rig(behaviour: Arc<Behaviour>) -> Rig {
    let rig = rig(
        fake(&[SESSION_METHOD, "plugins/referenceCatalog"], behaviour),
        timing(),
    );
    rig.helper.set_catalog(catalog());
    let rows: std::sync::Weak<dyn HelperRequests> = Arc::downgrade(&*ROWS) as _;
    rig.helper.set_requests(rows);
    rig
}

fn methods(fake: &Fake) -> Vec<String> {
    fake.received
        .lock()
        .unwrap()
        .iter()
        .map(|(method, _)| method.clone())
        .collect()
}

fn tool_call(id: u64, session: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": "open_doc", "arguments": {},
        "_meta": {"zcode/toolUseId": "tu", "zcode/helperContext": {"sessionId": session, "turnId": "run_1",
        "runtimeScope": "main"}}}})
}

#[test]
fn session_scoped_methods_are_forwarded() {
    let ui = FORWARDED_METHODS
        .iter()
        .filter(|method| method.starts_with("mcp/ui"))
        .count();
    assert_eq!(ui, 16);
    for method in ["mcp/readResource", "plugins/mentionItems"] {
        assert!(FORWARDED_METHODS.contains(&method));
        assert!(session_of(method, &json!({"sessionId": "s"})).is_some());
    }
    // The reference catalog is session-scoped only with a session id; a draft's catalog stays sessionless (F1).
    assert_eq!(
        session_of("plugins/referenceCatalog", &json!({"sessionId": "s"})),
        Some("s")
    );
    assert_eq!(session_of("plugins/referenceCatalog", &json!({})), None);
    assert_eq!(session_of("plugins/list", &json!({"sessionId": "s"})), None);
}

#[tokio::test]
async fn a_session_call_opens_the_session_once_per_generation() {
    let rig = session_rig(sessions(|_| opened()));
    let params = json!({"sessionId": "s1", "serverName": "plugin:viewer:view"});
    let (first, second) = tokio::join!(
        forward_ok(&rig.helper, SESSION_METHOD, params.clone()),
        forward_ok(&rig.helper, SESSION_METHOD, params.clone()),
    );
    assert_eq!((first, second), (params.clone(), params.clone()));
    forward_ok(&rig.helper, SESSION_METHOD, params.clone()).await;
    assert_eq!(
        received(&rig.fake, "helper/session/open"),
        [json!({
            "sessionId": "s1",
            "openId": 1,
            "workspace": {"workspacePath": PROJECT},
            "pluginIds": ["viewer@inline", "skills-only@inline"],
            "servers": ["plugin:viewer:view"],
        })]
    );
    // The open precedes the first session call.
    assert_eq!(methods(&rig.fake)[0], "helper/session/open");
    // A sessionless catalog opens nothing.
    forward_ok(&rig.helper, "plugins/referenceCatalog", json!({})).await;
    assert_eq!(received(&rig.fake, "helper/session/open").len(), 1);
}

#[tokio::test]
async fn a_refused_open_fails_the_call_and_the_next_call_opens_again() {
    let rig = session_rig(sessions(|attempt| {
        if attempt == 0 {
            Act::Fail(RpcError::invalid_params("second workspace"))
        } else {
            opened()
        }
    }));
    let params = json!({"sessionId": "s1"});
    let error = forward_err(&rig.helper, SESSION_METHOD, params.clone()).await;
    assert_eq!(error.message, "second workspace");
    assert!(
        received(&rig.fake, SESSION_METHOD).is_empty(),
        "no call without an open session"
    );
    forward_ok(&rig.helper, SESSION_METHOD, params).await;
    assert_eq!(received(&rig.fake, "helper/session/open").len(), 2);
}

#[tokio::test]
async fn without_a_catalog_a_session_call_is_unavailable() {
    let rig = rig(fake(&[SESSION_METHOD], sessions(|_| opened())), timing());
    expect_unavailable(&forward_err(&rig.helper, SESSION_METHOD, json!({"sessionId": "s1"})).await);
    assert!(received(&rig.fake, "helper/session/open").is_empty());
}

#[tokio::test(start_paused = true)]
async fn an_open_session_keeps_the_helper_until_rust_closes_it() {
    let rig = session_rig(sessions(|_| opened()));
    forward_ok(&rig.helper, SESSION_METHOD, json!({"sessionId": "s1"})).await;
    tokio::time::sleep(Duration::from_secs(301)).await;
    assert_eq!(
        rig.fake.stopped.load(Ordering::SeqCst),
        0,
        "kept by the session"
    );
    rig.helper.session_closed("s1");
    // A session this generation never opened sends nothing.
    rig.helper.session_closed("s2");
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(
        received(&rig.fake, "helper/session/close"),
        [json!({"sessionId": "s1", "openId": 1})]
    );
    tokio::time::sleep(Duration::from_secs(301)).await;
    assert_eq!(
        rig.fake.stopped.load(Ordering::SeqCst),
        1,
        "reclaimed once idle"
    );
}

#[tokio::test(start_paused = true)]
async fn a_crash_forgets_the_sessions_and_the_next_generation_opens_them_again() {
    let rig = session_rig(sessions(|_| opened()));
    forward_ok(&rig.helper, SESSION_METHOD, json!({"sessionId": "s1"})).await;
    // The fake crashes on a pipe message named `crash`.
    let mut connection = rig
        .helper
        .mcp_connect(&workspace_params(), "plugin:viewer:view")
        .await
        .expect("connected");
    rig.helper
        .mcp_send(&connection.id, json!({"jsonrpc": "2.0", "method": "crash"}))
        .await
        .expect("sent");
    loop {
        if matches!(
            next_event(&mut connection).await,
            McpTransportEvent::Closed { .. }
        ) {
            break;
        }
    }
    forward_ok(&rig.helper, SESSION_METHOD, json!({"sessionId": "s1"})).await;
    assert_eq!(received(&rig.fake, "helper/session/open").len(), 2);
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn a_helper_tool_call_opens_its_session_first_without_holding_its_cancel() {
    let rig = session_rig(sessions(|_| Act::Delay {
        after: Duration::from_secs(2),
        result: json!({}),
    }));
    let connection = rig
        .helper
        .mcp_connect(&workspace_params(), "plugin:viewer:view")
        .await
        .expect("connected");
    let started = tokio::time::Instant::now();
    rig.helper
        .mcp_send(&connection.id, tool_call(1, "s1"))
        .await
        .expect("sent");
    let cancel = json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
        "params": {"requestId": 1, "reason": "User interrupted"}});
    rig.helper
        .mcp_send(&connection.id, cancel.clone())
        .await
        .expect("sent");
    // Rust's MCP client waits on `send` before it watches its cancel token: a send must not wait on the open.
    assert!(started.elapsed() < Duration::from_secs(1));
    tokio::time::sleep(Duration::from_secs(3)).await;
    let sent: Vec<Value> = received(&rig.fake, "helper/mcp/send")
        .into_iter()
        .map(|params| params["message"].clone())
        .collect();
    assert_eq!(sent, [tool_call(1, "s1"), cancel]);
    let order = methods(&rig.fake);
    let open = order
        .iter()
        .position(|method| method == "helper/session/open");
    let call = order.iter().position(|method| method == "helper/mcp/send");
    assert!(
        open < call,
        "the session opens before its first tool call: {order:?}"
    );
    // A second call of the same session does not open it again.
    rig.helper
        .mcp_send(&connection.id, tool_call(2, "s1"))
        .await
        .expect("sent");
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(received(&rig.fake, "helper/session/open").len(), 1);
}

/// One session's pending open holds only that session's traffic on the pipe: another session's call and its cancel pass
/// it, and each session keeps its own order (a cancel follows its call).
#[tokio::test(start_paused = true)]
async fn a_pending_open_holds_only_its_own_sessions_pipe_traffic() {
    // The fake answers in order, so s1's open never answers here (it is left to its timeout).
    let rig = session_rig(sessions(
        |attempt| {
            if attempt == 0 { Act::Hang } else { opened() }
        },
    ));
    let connection = rig
        .helper
        .mcp_connect(&workspace_params(), "plugin:viewer:view")
        .await
        .expect("connected");
    let cancel = |id: u64| {
        json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
            "params": {"requestId": id, "reason": "User interrupted"}})
    };
    let ping = json!({"jsonrpc": "2.0", "id": 9, "method": "ping"});
    for message in [
        tool_call(1, "s1"),
        cancel(1),
        tool_call(2, "s2"),
        cancel(2),
        ping.clone(),
    ] {
        rig.helper
            .mcp_send(&connection.id, message)
            .await
            .expect("sent");
    }
    let sent = || -> Vec<Value> {
        received(&rig.fake, "helper/mcp/send")
            .into_iter()
            .map(|params| params["message"].clone())
            .collect()
    };
    tokio::time::sleep(Duration::from_secs(1)).await;
    // s1's call and its cancel wait for s1's open; s2's traffic and the sessionless ping do not. Only each session's
    // own order is kept: the ping may pass s2's open too.
    let sent = sent();
    let at = |message: &Value| sent.iter().position(|seen| seen == message);
    assert_eq!(sent.len(), 3, "{sent:?}");
    assert!(at(&ping).is_some());
    assert!(at(&tool_call(2, "s2")) < at(&cancel(2)) && at(&cancel(2)).is_some());
}

#[tokio::test]
async fn a_failed_session_open_answers_the_tool_call_with_an_error() {
    let rig = session_rig(sessions(|_| {
        Act::Fail(RpcError::invalid_params("second workspace"))
    }));
    let mut connection = rig
        .helper
        .mcp_connect(&workspace_params(), "plugin:viewer:view")
        .await
        .expect("connected");
    rig.helper
        .mcp_send(&connection.id, tool_call(3, "s1"))
        .await
        .expect("sent");
    match next_event(&mut connection).await {
        McpTransportEvent::Message { message } => {
            assert_eq!(message["id"], json!(3));
            assert_eq!(message["error"]["message"], json!("second workspace"));
        }
        other => panic!("unexpected event: {other:?}"),
    }
    assert!(
        received(&rig.fake, "helper/mcp/send").is_empty(),
        "the call never reaches the helper"
    );
}

#[test]
fn the_catalog_lists_every_admitted_plugin_and_the_helper_hosted_ones() {
    let mut catalog = HelperCatalog::default();
    catalog.admit("skills-only@inline", Vec::new());
    catalog.admit("viewer@inline", vec!["plugin:viewer:view".to_owned()]);
    assert_eq!(
        catalog,
        HelperCatalog {
            plugin_ids: vec!["skills-only@inline".to_owned(), "viewer@inline".to_owned()],
            helper_plugins: vec!["viewer@inline".to_owned()],
            servers: vec!["plugin:viewer:view".to_owned()],
        }
    );
}

/// The scope fields of the panel call params, as the Host sends them (`zcodeMcpUiPluginScopeShape`).
fn ui_scope() -> serde_json::Map<String, Value> {
    json!({
        "workspace": {"workspacePath": "/w", "workspaceKey": "/w"},
        "sessionId": "s1",
        "instance": {"token": "tok-1", "generation": 1},
        "pluginId": "viewer@inline",
        "serverName": "plugin:viewer:view",
    })
    .as_object()
    .cloned()
    .expect("an object")
}

/// Node's own cancel of each panel call (`handlers.ts` `cancelToolCall`, `samplingCalls.ts`): a timed-out call is
/// cancelled in the helper, with exactly the strict schema's fields, so its pending authorization or sampling ends.
#[tokio::test(start_paused = true)]
async fn an_abandoned_panel_call_is_cancelled_in_the_helper_by_its_own_cancel() {
    let pipes = sessions(|_| opened());
    let rig = rig(
        fake(
            &[SESSION_METHOD, "mcp/uiSampling"],
            behaviour(move |launch, method, params| match method {
                SESSION_METHOD | "mcp/uiSampling" => Act::Hang,
                _ => pipes(launch, method, params),
            }),
        ),
        timing(),
    );
    rig.helper.set_catalog(catalog());
    let rows: std::sync::Weak<dyn HelperRequests> = Arc::downgrade(&*ROWS) as _;
    rig.helper.set_requests(rows);
    let mut call = ui_scope();
    call.insert("toolName".into(), json!("search"));
    call.insert("arguments".into(), json!({"query": "q"}));
    call.insert("callId".into(), json!("call-1"));
    let mut sampling = ui_scope();
    sampling.insert("operationId".into(), json!("op-7"));
    sampling.insert("request".into(), json!({"messages": [], "maxTokens": 10}));
    let (call_error, sampling_error) = tokio::join!(
        forward_err(&rig.helper, SESSION_METHOD, Value::Object(call)),
        forward_err(&rig.helper, "mcp/uiSampling", Value::Object(sampling)),
    );
    expect_unavailable(&call_error);
    expect_unavailable(&sampling_error);
    tokio::time::sleep(Duration::from_secs(1)).await;
    let mut cancel_call = ui_scope();
    cancel_call.insert("callId".into(), json!("call-1"));
    let mut cancel_sampling = ui_scope();
    cancel_sampling.insert("operationId".into(), json!("op-7"));
    assert_eq!(
        received(&rig.fake, "mcp/uiCancelCall"),
        [Value::Object(cancel_call)]
    );
    assert_eq!(
        received(&rig.fake, "mcp/uiCancelSampling"),
        [Value::Object(cancel_sampling)]
    );
    // A sampling call's `operationId` is not a plugin operation.
    assert!(received(&rig.fake, "plugins/cancelOperation").is_empty());
}

/// A session Rust closes while its open is in flight is closed in the helper once the open succeeds.
#[tokio::test(start_paused = true)]
async fn a_session_closed_while_opening_is_closed_once_its_open_succeeds() {
    let rig = session_rig(sessions(|_| Act::Delay {
        after: Duration::from_secs(2),
        result: json!({}),
    }));
    let call = forward_ok(&rig.helper, SESSION_METHOD, json!({"sessionId": "s1"}));
    let close = async {
        tokio::time::sleep(Duration::from_secs(1)).await;
        rig.helper.session_closed("s1");
    };
    tokio::join!(call, close);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(
        received(&rig.fake, "helper/session/close"),
        [json!({"sessionId": "s1", "openId": 1})]
    );
    // Nothing keeps the helper afterwards.
    tokio::time::sleep(Duration::from_secs(301)).await;
    assert_eq!(rig.fake.stopped.load(Ordering::SeqCst), 1);
}

/// A late open does not close the session that a newer call opened again after the close.
#[tokio::test(start_paused = true)]
async fn a_late_open_leaves_a_session_reopened_after_its_close() {
    let rig = session_rig(sessions(|attempt| {
        if attempt == 0 {
            Act::Delay {
                after: Duration::from_secs(2),
                result: json!({}),
            }
        } else {
            opened()
        }
    }));
    let first = forward_ok(&rig.helper, SESSION_METHOD, json!({"sessionId": "s1"}));
    let reopen = async {
        tokio::time::sleep(Duration::from_secs(1)).await;
        rig.helper.session_closed("s1");
        forward_ok(&rig.helper, SESSION_METHOD, json!({"sessionId": "s1"})).await
    };
    tokio::join!(first, reopen);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(received(&rig.fake, "helper/session/open").len(), 2);
    assert!(
        received(&rig.fake, "helper/session/close").is_empty(),
        "the reopened session stays open"
    );
    rig.helper.session_closed("s1");
    tokio::time::sleep(Duration::from_secs(1)).await;
    // The close names the reopen, so the helper cannot apply it to another open of the session.
    assert_eq!(
        received(&rig.fake, "helper/session/close"),
        [json!({"sessionId": "s1", "openId": 2})]
    );
}

/// A session opens with its own workspace, as its row holds it, never the agent's cwd: the Host's shared local task
/// runtime runs one agent in `<home>/.zcode` for every local workspace.
#[tokio::test]
async fn a_session_opens_with_its_own_workspace_not_the_agents_cwd() {
    let rig = session_rig(sessions(|_| opened()));
    for session in ["s1", "id-2"] {
        forward_ok(
            &rig.helper,
            SESSION_METHOD,
            json!({"sessionId": session, "serverName": "plugin:viewer:view"}),
        )
        .await;
    }
    let workspaces: Vec<Value> = received(&rig.fake, "helper/session/open")
        .into_iter()
        .map(|open| open["workspace"].clone())
        .collect();
    assert_eq!(
        workspaces,
        [
            json!({"workspacePath": PROJECT}),
            json!({"workspacePath": PROJECT, "workspaceIdentity": "remote-1"}),
        ]
    );
}

/// A session whose row Rust cannot read is not opened with a guessed workspace: the call is unavailable.
#[tokio::test]
async fn a_session_without_a_row_is_not_opened() {
    let rig = session_rig(sessions(|_| opened()));
    let error = rig
        .helper
        .forward(
            SESSION_METHOD,
            &json!({"sessionId": "gone", "serverName": "plugin:viewer:view"}),
        )
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error.data.unwrap()["reasonCode"], NODE_HELPER_UNAVAILABLE);
    assert!(received(&rig.fake, "helper/session/open").is_empty());
}

/// An open Rust gives up on is closed with its own open id: the helper may still finish it, and nothing in Rust owns
/// it (F3 "Session open and close").
#[tokio::test(start_paused = true)]
async fn an_open_that_times_out_is_closed_in_the_helper() {
    let rig = session_rig(sessions(
        |attempt| {
            if attempt == 0 { Act::Hang } else { opened() }
        },
    ));
    expect_unavailable(&forward_err(&rig.helper, SESSION_METHOD, json!({"sessionId": "s1"})).await);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(
        received(&rig.fake, "helper/session/close"),
        [json!({"sessionId": "s1", "openId": 1})]
    );
    // The next call opens it again under a new open id.
    forward_ok(&rig.helper, SESSION_METHOD, json!({"sessionId": "s1"})).await;
    let opens = received(&rig.fake, "helper/session/open");
    assert_eq!(opens.len(), 2);
    assert_eq!(opens[1]["openId"], 2);
}

#[tokio::test(start_paused = true)]
async fn an_open_dropped_by_its_caller_is_closed_in_the_helper() {
    let rig = session_rig(sessions(|_| Act::Delay {
        after: Duration::from_secs(5),
        result: json!({}),
    }));
    let call = forward_ok(&rig.helper, SESSION_METHOD, json!({"sessionId": "s1"}));
    assert!(
        tokio::time::timeout(Duration::from_secs(1), call)
            .await
            .is_err()
    );
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert_eq!(
        received(&rig.fake, "helper/session/close"),
        [json!({"sessionId": "s1", "openId": 1})]
    );
    // The abandoned open keeps nothing: the helper is reclaimed once idle.
    tokio::time::sleep(Duration::from_secs(301)).await;
    assert_eq!(rig.fake.stopped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_refused_open_sends_no_close() {
    let rig = session_rig(sessions(|_| Act::Fail(RpcError::invalid_params("no"))));
    forward_err(&rig.helper, SESSION_METHOD, json!({"sessionId": "s1"})).await;
    tokio::task::yield_now().await;
    assert!(received(&rig.fake, "helper/session/close").is_empty());
}

/// An execution worktree session runs in its worktree under its workspace's key, as Node's app (create-app.ts:200-208,
/// core/src/mcp/index.ts:259-267).
#[tokio::test]
async fn an_execution_worktree_session_opens_with_its_worktree() {
    let rig = session_rig(sessions(|_| opened()));
    for session in ["s1", "wt-1"] {
        forward_ok(&rig.helper, SESSION_METHOD, json!({"sessionId": session})).await;
    }
    let opens = received(&rig.fake, "helper/session/open");
    assert_eq!(opens[0].get("executionDirectory"), None);
    assert_eq!(opens[1]["executionDirectory"], WORKTREE);
    assert_eq!(opens[1]["workspace"], json!({"workspacePath": PROJECT}));
}

/// A subagent's session opens under its root session, so the Office server keeps the subagent's documents in the
/// root's viewer (Node subagent/runner.ts `rootSessionId`, office-runtime `root_session_id ?? session_id`).
#[tokio::test]
async fn a_subagent_session_opens_under_its_root_session() {
    let rig = session_rig(sessions(|_| opened()));
    for session in ["s1", "sub-1"] {
        forward_ok(&rig.helper, SESSION_METHOD, json!({"sessionId": session})).await;
    }
    let opens = received(&rig.fake, "helper/session/open");
    assert_eq!(opens[0].get("rootSessionId"), None);
    assert_eq!(opens[1]["sessionId"], "sub-1");
    assert_eq!(opens[1]["rootSessionId"], "root-1");
}

/// The cancels themselves are never cancelled: an abandoned `mcp/uiCancel*` sends nothing, not a plugin cancel.
#[test]
fn an_abandoned_cancel_sends_no_cancel() {
    for method in ["mcp/uiCancelCall", "mcp/uiCancelSampling"] {
        let params = json!({"sessionId": "s1", "callId": "c", "operationId": "op"});
        assert_eq!(
            super::super::abandoned_cancel(method, &params),
            None,
            "{method}"
        );
    }
}

/// A dropped call leaves the open to a call still waiting on it: that call opens the session, and Rust's close ends it.
#[tokio::test(start_paused = true)]
async fn a_dropped_call_leaves_the_open_to_a_waiting_call() {
    let rig = session_rig(sessions(|_| Act::Delay {
        after: Duration::from_secs(2),
        result: json!({}),
    }));
    let params = json!({"sessionId": "s1"});
    let dropped = tokio::time::timeout(
        Duration::from_secs(1),
        forward_ok(&rig.helper, SESSION_METHOD, params.clone()),
    );
    let waiting = forward_ok(&rig.helper, SESSION_METHOD, params);
    let (dropped, _) = tokio::join!(dropped, waiting);
    assert!(dropped.is_err());
    let ids = |method: &str| -> Vec<Value> {
        received(&rig.fake, method)
            .into_iter()
            .map(|params| params["openId"].clone())
            .collect()
    };
    tokio::time::sleep(Duration::from_secs(1)).await;
    // The waiting call's open stays open until Rust closes the session.
    let open = ids("helper/session/open").last().cloned().unwrap();
    assert!(!ids("helper/session/close").contains(&open));
    rig.helper.session_closed("s1");
    tokio::time::sleep(Duration::from_secs(1)).await;
    // Every open the helper saw is closed exactly once, whichever call made it.
    assert_eq!(ids("helper/session/close"), ids("helper/session/open"));
    tokio::time::sleep(Duration::from_secs(301)).await;
    assert_eq!(rig.fake.stopped.load(Ordering::SeqCst), 1);
}

/// A call waiting on an open that fails opens the session itself, and that session stays open and registered: the
/// failed call must not leave it looking closed (which would close it in the helper and forward the waiting call into
/// a closed session).
#[tokio::test]
async fn a_call_waiting_on_a_failed_open_opens_a_session_that_stays_open() {
    let rig = session_rig(sessions(|attempt| {
        if attempt == 0 {
            Act::Fail(RpcError::invalid_params("busy"))
        } else {
            opened()
        }
    }));
    let params = json!({"sessionId": "s1"});
    let (first, second) = tokio::join!(
        rig.helper.forward(SESSION_METHOD, &params),
        rig.helper.forward(SESSION_METHOD, &params),
    );
    // Either call may make the first open; the other waits on it.
    let mut outcomes = [first.unwrap(), second.unwrap()];
    outcomes.sort_by_key(Result::is_ok);
    assert_eq!(outcomes[0].as_ref().unwrap_err().message, "busy");
    assert_eq!(outcomes[1].as_ref().unwrap(), &params);
    tokio::task::yield_now().await;
    assert!(
        received(&rig.fake, "helper/session/close").is_empty(),
        "the waiting call's session stays open"
    );
    // It is the registered open: the next call reuses it, and Rust's close names it.
    forward_ok(&rig.helper, SESSION_METHOD, params).await;
    assert_eq!(received(&rig.fake, "helper/session/open").len(), 2);
    rig.helper.session_closed("s1");
    for _ in 0..50 {
        if !received(&rig.fake, "helper/session/close").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        received(&rig.fake, "helper/session/close"),
        [json!({"sessionId": "s1", "openId": 2})]
    );
}
