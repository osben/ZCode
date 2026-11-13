//! The automation requests: the owner session's workspace ref, the Host's error code and the reply check.
use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::TaskScope;
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
    let port = Arc::new(HostAutomations::new(context.clone()));
    // A session that is not open here has no workspace: nothing is sent.
    let unknown = port
        .request(&SessionId::new("other"), "automation/list", json!({}))
        .await;
    assert_eq!(
        unknown.err().map(|error| error.message),
        Some("Session workspace is unavailable".to_owned())
    );
    context.register("sess_1", "/w");

    let asking = {
        let port = port.clone();
        tokio::spawn(async move {
            port.request(
                &SessionId::new("sess_1"),
                "automation/checkTaskBinding",
                json!({"targetTaskId": "sess_1"}),
            )
            .await
        })
    };
    let asked = next(&mut lines).await;
    assert_eq!(asked["method"], "automation/checkTaskBinding");
    assert_eq!(
        asked["params"],
        json!({"targetTaskId": "sess_1", "workspace": {"workspacePath": "/w", "workspaceKey": "/w"}})
    );
    answer(
        &mut host_out,
        json!({"jsonrpc": "2.0", "id": asked["id"], "result": {"bound": false}}),
    )
    .await;
    let bound = asking.await.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(bound.ok(), Some(json!({"bound": false})));

    // The Host's error keeps its code (only -32601 lets CronCreate fall back to the list).
    let asking = {
        let port = port.clone();
        tokio::spawn(async move {
            port.request(
                &SessionId::new("sess_1"),
                "automation/checkTaskBinding",
                json!({"targetTaskId": "sess_1"}),
            )
            .await
        })
    };
    let asked = next(&mut lines).await;
    answer(
        &mut host_out,
        json!({"jsonrpc": "2.0", "id": asked["id"], "error": {"code": -32601, "message": "Method not found"}}),
    )
    .await;
    let failed = asking.await.unwrap_or_else(|e| panic!("{e}"));
    assert!(failed.is_err_and(|error| error.is_method_not_found()));

    // A reply outside the method's schema is refused (`bound` must be a boolean).
    let asking = tokio::spawn(async move {
        port.request(
            &SessionId::new("sess_1"),
            "automation/checkTaskBinding",
            json!({"targetTaskId": "sess_1"}),
        )
        .await
    });
    let asked = next(&mut lines).await;
    answer(
        &mut host_out,
        json!({"jsonrpc": "2.0", "id": asked["id"], "result": {"bound": "no"}}),
    )
    .await;
    let invalid = asking.await.unwrap_or_else(|e| panic!("{e}"));
    let message = invalid.err().map(|error| error.message).unwrap_or_default();
    assert!(
        message.starts_with("invalid automation/checkTaskBinding reply"),
        "{message}"
    );
}
