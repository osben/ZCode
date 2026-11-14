//! Fork: helper sessions (specs/fork-rust-node-helper.md F3, "Session open and close").

use std::sync::atomic::{AtomicUsize, Ordering};

use rust_cli_kernel_api::mcp::McpTransportEvent;

use super::*;

const SESSION_METHOD: &str = "mcp/uiCallTool";

fn catalog() -> HelperCatalog {
    HelperCatalog {
        workspace: json!({"workspacePath": "/w"}),
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

fn session_rig(behaviour: Arc<Behaviour>) -> Rig {
    let rig = rig(
        fake(&[SESSION_METHOD, "plugins/referenceCatalog"], behaviour),
        timing(),
    );
    rig.helper.set_catalog(catalog());
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
    let ui: Vec<&&str> = FORWARDED_METHODS
        .iter()
        .filter(|method| method.starts_with("mcp/ui"))
        .collect();
    assert_eq!(ui.len(), 16);
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
            "workspace": {"workspacePath": "/w"},
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
        [json!({"sessionId": "s1"})]
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
    use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
    use rust_cli_kernel_api::ids::EnvironmentId;
    let mut catalog = HelperCatalog::new(&WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/w"),
    });
    catalog.admit("skills-only@inline", Vec::new());
    catalog.admit("viewer@inline", vec!["plugin:viewer:view".to_owned()]);
    assert_eq!(
        catalog,
        HelperCatalog {
            workspace: json!({"workspacePath": "/w"}),
            plugin_ids: vec!["skills-only@inline".to_owned(), "viewer@inline".to_owned()],
            helper_plugins: vec!["viewer@inline".to_owned()],
            servers: vec!["plugin:viewer:view".to_owned()],
        }
    );
}
