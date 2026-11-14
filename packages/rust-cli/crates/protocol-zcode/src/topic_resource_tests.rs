//! Acceptance case 9 (specs/fork-rust-topic-resource.md): the read's params, the strict reply check, and the cancel
//! request after a dropped read.
use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::testing::FixedClock;
use rust_cli_protocol_core::connection::{self, Options, Reply, Service};
use rust_cli_protocol_core::rpc::RpcError;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, duplex};

use super::*;

struct Nothing;

#[async_trait]
impl Service for Nothing {
    async fn request(&self, method: &str, _params: Value) -> Result<Reply, RpcError> {
        Err(RpcError::method_not_found(method))
    }
}

struct Host {
    _scope: TaskScope,
    resources: Arc<HostTopicResources>,
    lines: Lines<BufReader<DuplexStream>>,
    out: DuplexStream,
}

impl Host {
    fn new() -> Self {
        let scope = TaskScope::root("test", |_| {});
        let (out, agent_in) = duplex(1 << 16);
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
        let resources = Arc::new(HostTopicResources::new(context, scope.spawner()));
        Self {
            _scope: scope,
            resources,
            lines: BufReader::new(host_in).lines(),
            out,
        }
    }

    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::from_str(&line).unwrap()
    }

    async fn answer(&mut self, id: &Value, body: Value) {
        let mut message = json!({"jsonrpc": "2.0", "id": id});
        for (key, value) in body.as_object().unwrap() {
            message[key] = value.clone();
        }
        self.out
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap();
    }

    fn read(&self) -> tokio::task::JoinHandle<Result<TopicResource, String>> {
        let resources = self.resources.clone();
        tokio::spawn(async move {
            resources
                .read(TopicResourceRequest {
                    task: "sess_1".to_owned(),
                    input: "c1".to_owned(),
                    authorization: "a1".to_owned(),
                    message: "om_1".to_owned(),
                    index: 2,
                })
                .await
        })
    }
}

#[tokio::test]
async fn a_read_asks_the_host_and_checks_the_reply() {
    let mut host = Host::new();
    let reading = host.read();
    let asked = host.next().await;
    assert_eq!(asked["method"], READ);
    let request_id = asked["params"]["requestId"].as_str().unwrap().to_owned();
    assert!(!request_id.is_empty());
    assert_eq!(
        asked["params"],
        json!({"taskId": "sess_1", "inputId": "c1", "authorizationId": "a1", "messageId": "om_1",
            "resourceIndex": 2, "requestId": request_id})
    );
    let reply = json!({"ref": "zcode-artifact://sess_1/a1", "fileName": "a.txt", "mime": "text/plain", "bytes": 3});
    host.answer(&asked["id"], json!({"result": reply})).await;
    assert_eq!(
        reading.await.unwrap().unwrap(),
        TopicResource {
            reference: "zcode-artifact://sess_1/a1".to_owned(),
            file_name: "a.txt".to_owned(),
            mime: "text/plain".to_owned(),
            bytes: 3,
        }
    );

    // The reply schema is strict, and bounded like Node's.
    for bad in [
        json!({"ref": "r", "fileName": "a", "mime": "m", "bytes": 1, "extra": 1}),
        json!({"ref": "r", "fileName": "a", "mime": "m", "bytes": 20 * 1024 * 1024 + 1}),
        json!({"ref": "", "fileName": "a", "mime": "m", "bytes": 1}),
    ] {
        let reading = host.read();
        let asked = host.next().await;
        host.answer(&asked["id"], json!({"result": bad})).await;
        let error = reading.await.unwrap().unwrap_err();
        assert!(
            error.starts_with("invalid topic/resource/read reply"),
            "{error}"
        );
    }

    // The Host's error reaches the tool as its message.
    let reading = host.read();
    let asked = host.next().await;
    host.answer(
        &asked["id"],
        json!({"error": {"code": -32000, "message": "Topic resource is unavailable"}}),
    )
    .await;
    assert_eq!(
        reading.await.unwrap().unwrap_err(),
        "Topic resource is unavailable"
    );
}

#[tokio::test]
async fn a_dropped_read_sends_the_cancel_request() {
    let mut host = Host::new();
    let reading = host.read();
    let asked = host.next().await;
    let request_id = asked["params"]["requestId"].clone();
    reading.abort();
    let cancel = host.next().await;
    assert_eq!(cancel["method"], CANCEL);
    assert_eq!(
        cancel["params"],
        json!({"requestId": request_id, "taskId": "sess_1"})
    );
    assert!(
        cancel["id"].is_string(),
        "the cancel is a request: {cancel}"
    );
    host.answer(&cancel["id"], json!({"result": {"cancelled": true}}))
        .await;
}

#[tokio::test(start_paused = true)]
async fn a_read_past_the_limit_times_out_without_a_cancel() {
    let mut host = Host::new();
    let reading = host.read();
    host.next().await;
    let error = reading.await.unwrap().unwrap_err();
    assert_eq!(error, "topic/resource/read timed out after 120 seconds");
    let more = tokio::time::timeout(Duration::from_secs(1), host.lines.next_line()).await;
    assert!(more.is_err(), "no cancel after a timeout: {more:?}");
}
