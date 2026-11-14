//! Fork: the helper's live plugin UI deltas and the panels a crash closes (specs/fork-rust-node-helper.md F3,
//! `helper/session/delta` and "Crash").

use tokio_util::sync::CancellationToken;

use super::*;
use crate::fork::node_helper::HelperRequests;

/// Records the session deltas it is handed.
#[derive(Default)]
struct Deltas(StdMutex<Vec<(String, Value)>>);

impl Deltas {
    fn taken(&self) -> Vec<(String, Value)> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

#[async_trait]
impl HelperRequests for Deltas {
    async fn authorize_app_tool(
        &self,
        _params: Value,
        _cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    fn session_delta(&self, session: &str, delta: Value) {
        self.0.lock().unwrap().push((session.to_owned(), delta));
    }
}

const OPEN: &str = "mcp/uiOpenInstance";
const CLOSE: &str = "mcp/uiCloseInstance";
const CALL: &str = "mcp/uiCallTool";

fn instance(token: &str) -> Value {
    json!({"token": token, "generation": 3, "sessionId": "s1", "pluginId": "viewer@inline", "serverName": "plugin:viewer:view"})
}

fn delta(op: &str, token: &str) -> Value {
    json!({"op": op, "pluginId": "viewer@inline", "serverName": "plugin:viewer:view",
        "subscribers": [{"scopeId": token, "generation": 3, "instance": instance(token)}]})
}

/// Opens answer [`instance`] of the `token` param; a call whose `toolName` is `crash` crashes; another call sends the
/// `notes` param's deltas before it answers.
fn panels() -> Arc<Behaviour> {
    behaviour(|_, method, params| match method {
        OPEN => Act::Reply {
            notes: Vec::new(),
            result: instance(params["token"].as_str().unwrap_or_default()),
        },
        CALL if params["toolName"] == "crash" => Act::Crash,
        CALL => Act::Reply {
            notes: params["notes"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|delta| {
                    (
                        "helper/session/delta",
                        json!({"sessionId": "s1", "delta": delta}),
                    )
                })
                .collect(),
            result: json!({}),
        },
        _ => Act::Reply {
            notes: Vec::new(),
            result: json!({}),
        },
    })
}

fn panels_rig() -> (Rig, Arc<Deltas>) {
    let rig = rig(fake(&[OPEN, CLOSE, CALL], panels()), timing());
    rig.helper.set_catalog(HelperCatalog {
        workspace: json!({"workspacePath": "/w"}),
        plugin_ids: vec!["viewer@inline".to_owned()],
        helper_plugins: vec!["viewer@inline".to_owned()],
        servers: vec!["plugin:viewer:view".to_owned()],
    });
    let deltas = Arc::new(Deltas::default());
    let weak: std::sync::Weak<dyn HelperRequests> = Arc::downgrade(&deltas) as _;
    rig.helper.set_requests(weak);
    (rig, deltas)
}

fn open_params(token: &str) -> Value {
    json!({"sessionId": "s1", "pluginId": "viewer@inline", "serverName": "plugin:viewer:view", "token": token})
}

async fn crash(rig: &Rig) {
    let error = forward_err(
        &rig.helper,
        CALL,
        json!({"sessionId": "s1", "toolName": "crash"}),
    )
    .await;
    expect_unavailable(&error);
}

async fn deltas_after(deltas: &Deltas, count: usize) -> Vec<(String, Value)> {
    let mut seen = Vec::new();
    for _ in 0..200 {
        seen.extend(deltas.taken());
        if seen.len() >= count {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    seen
}

#[tokio::test]
async fn plugin_ui_deltas_reach_the_session_in_order_and_other_ops_are_dropped() {
    let (rig, deltas) = panels_rig();
    let notes = json!([
        delta("pluginUi.resourceUpdated", "t1"),
        {"op": "row.appended", "row": {}},
        delta("pluginUi.resourceListChanged", "t1"),
        delta("pluginUi.appToolCall", "t1"),
    ]);
    forward_ok(
        &rig.helper,
        CALL,
        json!({"sessionId": "s1", "notes": notes}),
    )
    .await;
    // Handled in the read loop, before the answer that follows them.
    let ops: Vec<(String, Value)> = deltas
        .taken()
        .into_iter()
        .map(|(session, delta)| (session, delta["op"].clone()))
        .collect();
    assert_eq!(
        ops,
        [
            ("s1".to_owned(), json!("pluginUi.resourceUpdated")),
            ("s1".to_owned(), json!("pluginUi.resourceListChanged")),
            ("s1".to_owned(), json!("pluginUi.appToolCall")),
        ]
    );
}

#[tokio::test]
async fn a_crash_closes_the_panels_its_generation_opened_and_not_closed() {
    let (rig, deltas) = panels_rig();
    forward_ok(&rig.helper, OPEN, open_params("t1")).await;
    forward_ok(&rig.helper, OPEN, open_params("t2")).await;
    forward_ok(&rig.helper, OPEN, open_params("t3")).await;
    // Closed by the UI, and closed by the helper itself: neither is closed again.
    forward_ok(
        &rig.helper,
        CLOSE,
        json!({"sessionId": "s1", "instance": instance("t2")}),
    )
    .await;
    forward_ok(
        &rig.helper,
        CALL,
        json!({"sessionId": "s1", "notes": [delta("pluginUi.instanceClosed", "t3")]}),
    )
    .await;
    assert_eq!(deltas.taken().len(), 1, "the helper's own close is relayed");

    crash(&rig).await;
    let closed = deltas_after(&deltas, 1).await;
    assert_eq!(
        closed,
        [("s1".to_owned(), delta("pluginUi.instanceClosed", "t1"))]
    );

    // The next generation starts with no panels: its crash closes nothing.
    forward_ok(&rig.helper, CALL, json!({"sessionId": "s1"})).await;
    crash(&rig).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(deltas.taken().is_empty());
}

#[tokio::test]
async fn a_failed_open_is_not_tracked() {
    let (rig, deltas) = panels_rig();
    // No token in the answer: nothing to close later.
    forward_ok(
        &rig.helper,
        OPEN,
        json!({"sessionId": "s1", "pluginId": "viewer@inline", "serverName": "plugin:viewer:view"}),
    )
    .await;
    crash(&rig).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(deltas.taken().is_empty());
}
