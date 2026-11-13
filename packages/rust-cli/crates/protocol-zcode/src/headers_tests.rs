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

/// Fork: ChatGPT Plan through the Host (specs/fork-rust-chatgpt-plan.md R6-R8).
mod chatgpt {
    use super::*;
    use tokio::io::{DuplexStream, Lines};

    const PROVIDER: &str = "account:chatgpt-plan:0123456789abcdef";

    fn plan(rejected: Option<&str>) -> HeaderRequest {
        HeaderRequest {
            selection: ModelSelection::new(PROVIDER, "gpt-6.1-sol"),
            account_type: String::new(),
            mode: String::new(),
            session: Some(SessionId::new("session_1")),
            rejected_fingerprint: rejected
                .map(|key| rust_cli_base::hash::sha256_hex(key.as_bytes())),
        }
    }

    struct Host {
        out: DuplexStream,
        lines: Lines<BufReader<DuplexStream>>,
        _scope: TaskScope,
    }

    impl Host {
        /// The next reverse request's params; answers it with `result`.
        async fn answer(&mut self, result: Value) -> Value {
            let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let asked: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(asked["method"], REQUEST);
            let reply = json!({"id": asked["id"], "result": result});
            self.out
                .write_all(format!("{reply}\n").as_bytes())
                .await
                .unwrap();
            asked["params"].clone()
        }
    }

    fn start() -> (Arc<HostHeaders>, Host) {
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
        context.register("session_1", "/w");
        let host = Host {
            out: host_out,
            lines: BufReader::new(host_in).lines(),
            _scope: scope,
        };
        (Arc::new(HostHeaders::new(context)), host)
    }

    fn granted(key: &str, scope: char) -> Value {
        json!({"headersApplied": true, "requestAuth": {"apiKey": key, "accountScope": scope.to_string().repeat(64)}})
    }

    /// R6 and R7: no zhipu access on the wire; a renewal names the rejected token and its remembered scope.
    #[tokio::test]
    async fn renewals_name_the_scope_of_the_rejected_token() {
        let (source, mut host) = start();
        let asking = {
            let source = source.clone();
            tokio::spawn(async move { source.request_auth(plan(None)).await })
        };
        let params = host.answer(granted("tok-1", 'b')).await;
        assert_eq!(params["providerId"], PROVIDER);
        assert_eq!(params["modelSelection"]["providerId"], PROVIDER);
        for absent in [
            "accountAccess",
            "expectedAccountScope",
            "rejectedProjectTokenFingerprint",
        ] {
            assert!(params.get(absent).is_none(), "{absent} in {params}");
        }
        assert_eq!(
            asking.await.unwrap().unwrap().api_key.unwrap().expose(),
            "tok-1"
        );

        let asking = {
            let source = source.clone();
            tokio::spawn(async move { source.request_auth(plan(Some("tok-1"))).await })
        };
        let params = host.answer(granted("tok-2", 'b')).await;
        assert_eq!(params["expectedAccountScope"], "b".repeat(64));
        assert_eq!(
            params["rejectedProjectTokenFingerprint"],
            rust_cli_base::hash::sha256_hex(b"tok-1")
        );
        assert_eq!(
            asking.await.unwrap().unwrap().api_key.unwrap().expose(),
            "tok-2"
        );
    }

    /// R8: another scope after the renewal, or no remembered scope, is `siwc_account_scope_invalidated`.
    #[tokio::test]
    async fn a_changed_or_unknown_scope_is_not_recovered() {
        let (source, mut host) = start();
        let asking = {
            let source = source.clone();
            tokio::spawn(async move { source.request_auth(plan(None)).await })
        };
        host.answer(granted("tok-1", 'b')).await;
        asking.await.unwrap().unwrap();
        let asking = {
            let source = source.clone();
            tokio::spawn(async move { source.request_auth(plan(Some("tok-1"))).await })
        };
        host.answer(granted("tok-2", 'c')).await;
        let invalidated = ModelError::Authentication {
            message: "siwc_account_scope_invalidated".to_owned(),
        };
        assert_eq!(asking.await.unwrap().unwrap_err(), invalidated);
        // A token whose scope was never seen: the Host is not asked at all.
        assert_eq!(
            source
                .request_auth(plan(Some("unknown")))
                .await
                .unwrap_err(),
            invalidated
        );
        // A grant without a scope is not remembered either.
        let asking = {
            let source = source.clone();
            tokio::spawn(async move { source.request_auth(plan(None)).await })
        };
        host.answer(json!({"headersApplied": true, "requestAuth": {"apiKey": "tok-3"}}))
            .await;
        asking.await.unwrap().unwrap();
        assert_eq!(
            source.request_auth(plan(Some("tok-3"))).await.unwrap_err(),
            invalidated
        );
    }
}
