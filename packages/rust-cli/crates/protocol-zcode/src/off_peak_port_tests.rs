//! The off-peak requests: the owner session's workspace ref, the Host's error code and the reply check.
use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::off_peak::OffPeakPort;
use rust_cli_kernel_api::testing::FixedClock;
use rust_cli_protocol_core::connection::{self, Options, Reply, Service};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, duplex};

use super::*;

struct Nothing;

#[async_trait]
impl Service for Nothing {
    async fn request(&self, method: &str, _params: Value) -> Result<Reply, RpcError> {
        Err(RpcError::method_not_found(method))
    }
}

/// The agent end of a connection whose Host end the test drives line by line.
fn connected() -> (
    TaskScope,
    Arc<Context>,
    tokio::io::Lines<BufReader<tokio::io::DuplexStream>>,
    tokio::io::DuplexStream,
) {
    let scope = TaskScope::root("test", |_| {});
    let (host_out, agent_in) = duplex(1 << 16);
    let (agent_out, host_in) = duplex(1 << 16);
    let (peer, _writer) = connection::start(agent_out, &scope.spawner(), Options::default());
    drop(scope.spawner().spawn(
        "serve",
        connection::serve(
            BufReader::new(agent_in),
            peer.clone(),
            Arc::new(Nothing),
            scope.spawner(),
            Options::default(),
        ),
    ));
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(1))));
    (scope, context, BufReader::new(host_in).lines(), host_out)
}

async fn next(lines: &mut tokio::io::Lines<BufReader<tokio::io::DuplexStream>>) -> Value {
    let line = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .unwrap_or_else(|_| panic!("no request"))
        .unwrap_or_else(|e| panic!("{e}"))
        .unwrap_or_else(|| panic!("closed"));
    serde_json::from_str(&line).unwrap_or_else(|e| panic!("{e}"))
}

async fn answer(host_out: &mut tokio::io::DuplexStream, reply: Value) {
    let mut line = reply.to_string();
    line.push('\n');
    host_out
        .write_all(line.as_bytes())
        .await
        .unwrap_or_else(|e| panic!("{e}"));
}

#[tokio::test]
async fn a_request_carries_the_owner_session_s_workspace_and_checks_the_reply() {
    let (_scope, context, mut lines, mut host_out) = connected();
    let port = Arc::new(HostOffPeak::new(context.clone()));
    // A session that is not open here has no workspace: nothing is sent.
    context.off_peak.set_session_enabled("other", true);
    let unknown = port
        .request(&SessionId::new("other"), "offPeak/list", json!({}))
        .await;
    assert_eq!(
        unknown.err().map(|error| error.message),
        Some("Session workspace is unavailable".to_owned())
    );
    context.register("sess_1", "/w");
    context.off_peak.set_session_enabled("sess_1", true);

    let asking = {
        let port = port.clone();
        tokio::spawn(async move {
            port.request(&SessionId::new("sess_1"), "offPeak/list", json!({}))
                .await
        })
    };
    let asked = next(&mut lines).await;
    assert_eq!(asked["method"], "offPeak/list");
    assert_eq!(
        asked["params"],
        json!({"workspace": {"workspacePath": "/w", "workspaceKey": "/w"}})
    );
    answer(
        &mut host_out,
        json!({"jsonrpc": "2.0", "id": asked["id"], "result": {"tasks": []}}),
    )
    .await;
    let listed = asking.await.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(listed.ok(), Some(json!({"tasks": []})));

    // The Host's error keeps its code.
    let asking = {
        let port = port.clone();
        tokio::spawn(async move {
            port.request(&SessionId::new("sess_1"), "offPeak/list", json!({}))
                .await
        })
    };
    let asked = next(&mut lines).await;
    answer(
        &mut host_out,
        json!({"jsonrpc": "2.0", "id": asked["id"], "error": {"code": -32603, "message": "store is locked"}}),
    )
    .await;
    let failed = asking.await.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(failed.err().and_then(|error| error.code), Some(-32603));

    // A reply outside the method's schema is refused (`tasks` must be an array).
    let asking = {
        let port = port.clone();
        tokio::spawn(async move {
            port.request(&SessionId::new("sess_1"), "offPeak/list", json!({}))
                .await
        })
    };
    let asked = next(&mut lines).await;
    answer(
        &mut host_out,
        json!({"jsonrpc": "2.0", "id": asked["id"], "result": {"tasks": "none"}}),
    )
    .await;
    let refused = asking.await.unwrap_or_else(|e| panic!("{e}"));
    assert!(refused.is_err_and(|error| error.code.is_none()));
}

#[tokio::test]
async fn a_business_failure_of_create_is_a_reply_not_an_error() {
    let (_scope, context, mut lines, mut host_out) = connected();
    let port = Arc::new(HostOffPeak::new(context.clone()));
    context.register("sess_1", "/w");
    context.off_peak.set_session_enabled("sess_1", true);
    let asking = {
        let port = port.clone();
        tokio::spawn(async move {
            port.request(
                &SessionId::new("sess_1"),
                "offPeak/create",
                json!({"title": "t", "prompt": "p", "boundSessionId": "sess_1"}),
            )
            .await
        })
    };
    let asked = next(&mut lines).await;
    assert_eq!(asked["method"], "offPeak/create");
    assert_eq!(asked["params"]["boundSessionId"], "sess_1");
    answer(
        &mut host_out,
        json!({"jsonrpc": "2.0", "id": asked["id"], "result": {
            "ok": false, "failureStage": "ticket_request", "errorCategory": "quota_3103", "errorCode": "3103",
        }}),
    )
    .await;
    let reply = asking.await.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        reply.ok().map(|reply| reply["errorCategory"].clone()),
        Some(json!("quota_3103"))
    );
}

#[tokio::test]
async fn only_the_off_peak_methods_with_a_reply_schema_are_sent() {
    let (_scope, context, _lines, _host_out) = connected();
    let port = HostOffPeak::new(context.clone());
    context.register("sess_1", "/w");
    context.off_peak.set_session_enabled("sess_1", true);
    let refused = port
        .request(&SessionId::new("sess_1"), "session/create", json!({}))
        .await;
    assert!(refused.is_err_and(|error| error.message.contains("is not an off-peak method")));
}

#[tokio::test]
async fn a_session_without_the_tools_enabled_sends_nothing() {
    let (_scope, context, mut lines, _host_out) = connected();
    let port = HostOffPeak::new(context.clone());
    context.register("sess_1", "/w");
    let refused = port
        .request(&SessionId::new("sess_1"), "offPeak/list", json!({}))
        .await;
    assert!(refused.is_err_and(|error| error.message.contains("not enabled")));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), lines.next_line())
            .await
            .is_err(),
        "nothing reaches the Host"
    );
}
