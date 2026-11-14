//! Fork: specs/fork-rust-node-helper.md F3, `helper/authorizeAppTool`.

use rust_cli_kernel_api::app_tool::{AppToolError, AppToolRefusal};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::KernelError;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{answer, parse};

#[test]
fn the_request_names_the_session_the_server_the_tool_and_its_prompt_id() {
    let params = json!({
        "requestKey": "helper-1",
        "sessionId": "s1",
        "serverName": "plugin:viewer:view",
        "toolName": "search",
        "input": {"query": "q"},
        "tool": {"inputSchema": {"type": "object"}},
    });
    let call = parse(&params, CancellationToken::new()).unwrap();
    assert_eq!(call.session, SessionId::new("s1"));
    assert_eq!(
        (call.server.as_str(), call.tool.as_str()),
        ("plugin:viewer:view", "search")
    );
    assert_eq!(call.input, json!({"query": "q"}));
    assert_eq!(call.descriptor, json!({"inputSchema": {"type": "object"}}));
    assert_eq!(call.tool_use.as_str(), "helper-1");
    for missing in ["requestKey", "sessionId", "serverName", "toolName"] {
        let mut params = params.clone();
        params.as_object_mut().unwrap().remove(missing);
        let error = parse(&params, CancellationToken::new()).unwrap_err();
        assert_eq!(error.message, format!("{missing} is required"));
    }
}

/// The helper always sends Node's `input: args ?? {}` and the `listTools` descriptor: without them nothing could be
/// validated, so a missing or malformed one is invalid params, never a default.
#[test]
fn the_input_and_the_descriptor_schema_are_required_objects() {
    let params = json!({
        "requestKey": "k", "sessionId": "s1", "serverName": "a", "toolName": "b",
        "input": {}, "tool": {"inputSchema": {"type": "object"}},
    });
    assert!(parse(&params, CancellationToken::new()).is_ok());
    let cases = [
        ("/input", None, "input must be an object"),
        ("/input", Some(json!("q")), "input must be an object"),
        (
            "/tool",
            None,
            "tool must be an object with an object inputSchema",
        ),
        (
            "/tool",
            Some(json!({})),
            "tool must be an object with an object inputSchema",
        ),
        (
            "/tool",
            Some(json!({"inputSchema": true})),
            "tool must be an object with an object inputSchema",
        ),
    ];
    for (pointer, value, message) in cases {
        let mut params = params.clone();
        let key = &pointer[1..];
        match value {
            Some(value) => params[key] = value,
            None => {
                params.as_object_mut().unwrap().remove(key);
            }
        }
        let error = parse(&params, CancellationToken::new()).unwrap_err();
        assert_eq!(
            (error.code, error.message.as_str()),
            (-32602, message),
            "{pointer}"
        );
    }
}

#[test]
fn the_answer_is_the_input_or_a_typed_refusal() {
    assert_eq!(
        answer(Ok(json!({"query": "q"}))).unwrap(),
        json!({"input": {"query": "q"}})
    );
    let denied = answer(Err(AppToolError::Refused(
        AppToolRefusal::PermissionDenied("denied".to_owned()),
    )))
    .unwrap_err();
    assert_eq!(denied.message, "denied");
    assert_eq!(denied.data, Some(json!({"type": "permission_denied"})));
    let invalid = answer(Err(AppToolError::Refused(AppToolRefusal::InvalidInput(
        "bad".to_owned(),
    ))))
    .unwrap_err();
    assert_eq!(invalid.data, Some(json!({"type": "invalid_input"})));
    // Any other failure carries no type: the helper reports it as a failed call, not a denial.
    let missing = answer(Err(AppToolError::Kernel(KernelError::NotFound {
        session: SessionId::new("s1"),
    })))
    .unwrap_err();
    assert_eq!(missing.data, None);
}

/// `helper/session/delta` (F3): a live plugin UI delta reaches the session's subscribers as a deltas frame, in the
/// session's pump order, and never changes the projection; a session without a projection drops it.
#[tokio::test]
async fn a_plugin_ui_delta_reaches_the_sessions_subscribers_but_not_its_snapshot() {
    use tokio::io::AsyncBufReadExt;

    use crate::fork::node_helper::HelperRequests;
    use crate::fork::workspace_trust::tests::{fixture_reading, settled};
    use crate::wire::Purpose;

    let (_scope, server, reader) = fixture_reading(None, false);
    let mut lines = tokio::io::BufReader::new(reader).lines();
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    live.sink.subscribe("sub-1", "conn-1");
    live.sink.start("sub-1", Purpose::Online).await;
    let before = live.sink.snapshot();
    let delta = json!({
        "op": "pluginUi.resourceUpdated",
        "pluginId": "viewer@inline",
        "serverName": "plugin:viewer:view",
        "uri": "ui://viewer/state",
        "subscribers": [],
    });
    server.session_delta("s1", delta.clone());
    server.session_delta("not-open", delta.clone());
    settled(&live).await;
    assert_eq!(live.sink.snapshot(), before);
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let line = lines.next_line().await.unwrap().expect("a line");
            let message: serde_json::Value = serde_json::from_str(&line).unwrap();
            if message.to_string().contains("pluginUi.resourceUpdated") {
                return message;
            }
        }
    })
    .await
    .expect("the delta frame is sent");
    let text = frame.to_string();
    assert!(text.contains("\"subscriptionId\":\"sub-1\""), "{text}");
    assert!(text.contains("\"kind\":\"deltas\""), "{text}");
}

/// A subagent's helper session names its top-level session: its parents are followed while they are subagent
/// sessions, as Node's `rootSessionId ?? parent`. The stored trace is ignored (Node writes a trace id there); an
/// interactive or fork session is its own root (F3 "Session open and close").
#[tokio::test]
async fn a_subagent_session_names_the_session_above_its_subagent_chain() {
    use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
    use rust_cli_kernel_api::ids::{EnvironmentId, TraceId};
    use rust_cli_kernel_api::store::{SessionKind, SessionMeta};
    let meta = |id: &str, kind, parent: Option<&str>| SessionMeta {
        id: SessionId::new(id),
        kind,
        parent: parent.map(SessionId::new),
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/w"),
        },
        title: String::new(),
        trace: TraceId::new("trace-uuid"),
        created_at_ms: 1,
        incognito: None,
    };
    let rows: std::collections::HashMap<String, SessionMeta> = [
        meta("s-root", SessionKind::Interactive, None),
        meta("sub-1", SessionKind::Subagent, Some("s-root")),
        meta("sub-2", SessionKind::Subagent, Some("sub-1")),
        meta("s-fork", SessionKind::Fork, Some("s-root")),
        meta("sub-f", SessionKind::Subagent, Some("s-fork")),
        meta("sub-gone", SessionKind::Subagent, Some("s-unknown")),
    ]
    .into_iter()
    .map(|meta| (meta.id.as_str().to_owned(), meta))
    .collect();
    let root = |session: &'static str| {
        let rows = &rows;
        async move { super::root_by(session, |id| async move { rows.get(&id).cloned() }).await }
    };
    assert_eq!(root("sub-1").await.as_deref(), Some("s-root"));
    assert_eq!(root("sub-2").await.as_deref(), Some("s-root"));
    // A fork session is a top-level session for the agents it spawns.
    assert_eq!(root("sub-f").await.as_deref(), Some("s-fork"));
    assert_eq!(root("sub-gone").await.as_deref(), Some("s-unknown"));
    for own in ["s-root", "s-fork", "missing"] {
        assert_eq!(root(own).await, None, "{own}");
    }
}
