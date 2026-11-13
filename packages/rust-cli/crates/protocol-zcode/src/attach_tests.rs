//! The Host attach acknowledgement (specs/fork-rust-credential-cipher.md F1, B1-B3).
use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::provider::{CipherError, CredentialCipher};
use rust_cli_kernel_api::testing::FixedClock;
use rust_cli_protocol_core::connection::{self, Options, Reply, Service};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, duplex};

use super::*;
use crate::{Context, HostCredentialCipher};

struct Nothing;

#[async_trait::async_trait]
impl Service for Nothing {
    async fn request(&self, method: &str, _params: Value) -> Result<Reply, RpcError> {
        Err(RpcError::method_not_found(method))
    }
}

struct Host {
    write: DuplexStream,
    lines: Lines<BufReader<DuplexStream>>,
}

impl Host {
    async fn next_within(&mut self, within: Duration) -> Option<Value> {
        let line = tokio::time::timeout(within, self.lines.next_line())
            .await
            .ok()?
            .unwrap()?;
        Some(serde_json::from_str(&line).unwrap())
    }

    async fn send(&mut self, frame: Value) {
        self.write
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .unwrap();
    }
}

/// The agent's connection with the gate in front of the service, as the app-server wires it.
fn connect(declared: bool) -> (Arc<Context>, Host, TaskScope) {
    let scope = TaskScope::root("test", |_| {});
    let (host_out, agent_in) = duplex(1 << 20);
    let (agent_out, host_in) = duplex(1 << 20);
    let (peer, _writer) = connection::start(agent_out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(1))));
    if declared {
        context.expect_host_attach();
    }
    drop(scope.spawner().spawn(
        "serve",
        serve_attached(
            BufReader::new(agent_in),
            context.clone(),
            Arc::new(Nothing),
            scope.spawner(),
            Options::default(),
        ),
    ));
    let host = Host {
        write: host_out,
        lines: BufReader::new(host_in).lines(),
    };
    (context, host, scope)
}

fn ack(credential_cipher: bool) -> Value {
    json!({"method": HOST_ATTACHED, "params": {"credentialCipher": credential_cipher}})
}

fn ok_reply(request: &Value, value: &str) -> Value {
    json!({"id": request["id"], "result": {
        "requestId": request["params"]["requestId"],
        "result": {"ok": true, "value": value}}})
}

#[tokio::test]
async fn a_declared_agent_holds_the_cipher_request_until_the_ack() {
    let (context, mut host, _scope) = connect(true);
    let cipher = HostCredentialCipher::new(context);
    let call = tokio::spawn(async move { cipher.decrypt("enc:v2:os:x").await });
    assert!(
        host.next_within(Duration::from_millis(200)).await.is_none(),
        "no reverse request before the Host acknowledges"
    );
    host.send(ack(true)).await;
    let request = host
        .next_within(Duration::from_secs(5))
        .await
        .expect("the request follows the ack");
    assert_eq!(request["method"], "interaction/requestCredentialCipher");
    host.send(ok_reply(&request, "plain")).await;
    assert_eq!(call.await.unwrap().unwrap(), "plain");
}

#[tokio::test]
async fn a_host_without_a_cipher_fails_the_call_without_a_request() {
    let (context, mut host, _scope) = connect(true);
    host.send(ack(false)).await;
    let cipher = HostCredentialCipher::new(context);
    let error = cipher.decrypt("enc:v2:os:x").await.unwrap_err();
    assert!(
        matches!(error, CipherError::Unavailable { .. }),
        "{error:?}"
    );
    assert!(host.next_within(Duration::from_millis(200)).await.is_none());
}

#[tokio::test]
async fn an_undeclared_agent_sends_at_once() {
    let (context, mut host, _scope) = connect(false);
    let cipher = HostCredentialCipher::new(context);
    let call = tokio::spawn(async move { cipher.decrypt("enc:v2:os:x").await });
    let request = host
        .next_within(Duration::from_secs(5))
        .await
        .expect("sent without an ack");
    host.send(ok_reply(&request, "plain")).await;
    assert_eq!(call.await.unwrap().unwrap(), "plain");
}

#[tokio::test]
async fn an_invalid_ack_is_ignored() {
    let (context, mut host, _scope) = connect(true);
    host.send(json!({"method": HOST_ATTACHED, "params": {"credentialCipher": "yes"}}))
        .await;
    let cipher = HostCredentialCipher::new(context.clone());
    let call = tokio::spawn(async move { cipher.decrypt("enc:v2:os:x").await });
    assert!(host.next_within(Duration::from_millis(200)).await.is_none());
    host.send(ack(true)).await;
    let request = host.next_within(Duration::from_secs(5)).await.unwrap();
    host.send(ok_reply(&request, "plain")).await;
    assert_eq!(call.await.unwrap().unwrap(), "plain");
}

#[tokio::test]
async fn the_ack_is_not_held_behind_a_service_that_is_not_installed() {
    // The app-server's real service waits in `Deferred` until assembly ends; assembly waits for the ack.
    let scope = TaskScope::root("test", |_| {});
    let (mut host_out, agent_in) = duplex(1 << 20);
    let (agent_out, _host_in) = duplex(1 << 20);
    let (peer, _writer) = connection::start(agent_out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer.clone(), Arc::new(FixedClock(1))));
    context.expect_host_attach();
    let (deferred, _install) = connection::Deferred::new();
    drop(scope.spawner().spawn(
        "serve",
        connection::serve(
            BufReader::new(agent_in),
            peer,
            AttachGate::wrap(context.clone(), deferred),
            scope.spawner(),
            Options::default(),
        ),
    ));
    host_out
        .write_all(format!("{}\n", ack(true)).as_bytes())
        .await
        .unwrap();
    let state = tokio::time::timeout(Duration::from_secs(5), context.host_ready())
        .await
        .expect("the ack arrives while the service is not installed");
    assert_eq!(state, Some(true));
}

/// A Host that closes the connection before it acknowledges: the held cipher call fails at once, not at its bound.
#[tokio::test]
async fn a_host_that_closes_before_the_ack_fails_the_held_call_at_once() {
    let (context, host, _scope) = connect(true);
    let cipher = HostCredentialCipher::new(context);
    let call = tokio::spawn(async move { cipher.decrypt("enc:v2:os:x").await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(host);
    let error = tokio::time::timeout(Duration::from_secs(5), call)
        .await
        .expect("released when the connection ends")
        .unwrap()
        .unwrap_err();
    assert!(
        matches!(error, CipherError::Unavailable { .. }),
        "{error:?}"
    );
}

/// The bound ends while the acknowledgement is still awaited: the error names the missing acknowledgement.
#[tokio::test]
async fn a_missing_ack_is_named_when_the_bound_ends() {
    let (context, mut host, _scope) = connect(true);
    let cipher = HostCredentialCipher::with_limit(context, Duration::from_millis(100));
    let error = cipher.decrypt("enc:v2:os:x").await.unwrap_err();
    assert_eq!(
        error,
        CipherError::Unavailable {
            reason: "the host did not acknowledge the attach in time"
        }
    );
    assert!(host.next_within(Duration::from_millis(100)).await.is_none());
}

/// A reader torn down before the acknowledgement (its task aborted with the scope) also stops holding reverse
/// requests, as when the input ends.
#[tokio::test]
async fn a_torn_down_reader_stops_holding_requests() {
    let scope = TaskScope::root("test", |_| {});
    let (agent_out, _host_in) = duplex(1 << 20);
    let (_host_out, agent_in) = duplex(1 << 20);
    let (peer, _writer) = connection::start(agent_out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(1))));
    context.expect_host_attach();
    let serving = serve_attached(
        BufReader::new(agent_in),
        context.clone(),
        Arc::new(Nothing),
        scope.spawner(),
        Options::default(),
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), serving)
            .await
            .is_err(),
        "the reader is still waiting for input"
    );
    assert!(!context.attach.waiting(), "held requests are released");
    assert_eq!(context.attach.ready().await, None);
}
