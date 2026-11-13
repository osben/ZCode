//! 经 Host 取账号凭据（G8）：反向请求的参数、回复的换算与取消。
use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::TaskScope;
use rust_cli_base::models::GLM_5_3_ACCOUNT;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::testing::FixedClock;
use rust_cli_protocol_core::connection::{self, Options, Reply, Service};
use rust_cli_protocol_core::rpc::RpcError;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, duplex};

use super::*;

struct Nothing;

#[async_trait]
impl Service for Nothing {
    async fn request(&self, method: &str, _params: Value) -> Result<Reply, RpcError> {
        Err(RpcError::method_not_found(method))
    }
}

fn request(session: Option<&str>) -> HeaderRequest {
    HeaderRequest {
        selection: ModelSelection::new("account:zai-individual-coding-plan", GLM_5_3_ACCOUNT),
        account_type: "zai".into(),
        mode: "individual-coding-plan".into(),
        session: session.map(SessionId::new),
        rejected_fingerprint: Some("a".repeat(64)),
    }
}

#[tokio::test]
async fn account_credentials_come_from_the_host_through_a_reverse_request() {
    let scope = TaskScope::root("test", |_| {});
    let (mut host_out, agent_in) = duplex(1 << 16);
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
    let source = HostHeaders::new(context.clone());
    // 会话不在这个进程里：不问 Host。
    assert!(
        source
            .request_auth(request(Some("session_x")))
            .await
            .is_err()
    );
    assert!(source.request_auth(request(None)).await.is_err());
    context.register("session_1", "/w");
    let asking = tokio::spawn(async move { source.request_auth(request(Some("session_1"))).await });
    let mut lines = BufReader::new(host_in).lines();
    let line = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let asked: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(asked["method"], REQUEST);
    let params = &asked["params"];
    assert_eq!(params["sessionId"], "session_1");
    assert_eq!(
        params["workspace"],
        json!({"workspacePath": "/w", "workspaceKey": "/w"})
    );
    assert_eq!(params["providerId"], "account:zai-individual-coding-plan");
    assert_eq!(params["accountAccess"]["mode"], "individual-coding-plan");
    assert_eq!(params["reason"], "model-request");
    assert_eq!(params["rejectedProjectTokenFingerprint"], "a".repeat(64));
    let reply = json!({"id": asked["id"], "result": {"headersApplied": true,
        "requestAuth": {"apiKey": "sk-host", "headers": {"x-sign": "s"}}}});
    host_out
        .write_all(format!("{reply}\n").as_bytes())
        .await
        .unwrap();
    let auth = asking.await.unwrap().unwrap();
    assert_eq!(auth.api_key.unwrap().expose(), "sk-host");
    assert_eq!(auth.headers[0].0, "x-sign");
}

/// F1: the bound ends while the Host's attach acknowledgement is still awaited. No request went out, so no
/// cancellation either, and the error names the missing acknowledgement.
#[tokio::test]
async fn a_missing_ack_sends_neither_a_request_nor_a_cancellation() {
    let scope = TaskScope::root("test", |_| {});
    let (_host_out, agent_in) = duplex(1 << 16);
    let (agent_out, host_in) = duplex(1 << 16);
    let (peer, _writer) = connection::start(agent_out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer.clone(), Arc::new(FixedClock(1))));
    context.expect_host_attach();
    drop(scope.spawner().spawn(
        "serve",
        crate::attach::serve_attached(
            BufReader::new(agent_in),
            context.clone(),
            Arc::new(Nothing),
            scope.spawner(),
            Options::default(),
        ),
    ));
    context.register("session_1", "/w");
    let source = HostHeaders::with_limit(context, Duration::from_millis(100));
    let error = source
        .request_auth(request(Some("session_1")))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("did not acknowledge the attach"),
        "{error}"
    );
    let mut lines = BufReader::new(host_in).lines();
    assert!(
        tokio::time::timeout(Duration::from_millis(200), lines.next_line())
            .await
            .is_err(),
        "nothing reached the Host"
    );
}
