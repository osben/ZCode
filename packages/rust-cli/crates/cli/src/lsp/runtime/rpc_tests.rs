use std::sync::{Arc, Mutex};
use std::time::Duration;

use rust_cli_base::sync::LockUnpoisoned;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio_util::sync::CancellationToken;

use super::{Connection, Decoder, ReadEnd, RequestOptions, ServerRequests, encode, pump};

fn frame(body: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
}

#[test]
fn frames_split_anywhere_and_several_per_chunk_decode() {
    let mut bytes = frame(r#"{"jsonrpc":"2.0","method":"a","params":"héllo ✓"}"#);
    bytes.extend(frame(r#"{"jsonrpc":"2.0","id":1,"result":null}"#));
    // One byte at a time: headers and the multi-byte body are split everywhere.
    let mut decoder = Decoder::default();
    let mut messages = Vec::new();
    for byte in &bytes {
        messages.extend(decoder.push(std::slice::from_ref(byte)).unwrap());
    }
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["params"], "héllo ✓");
    // Both frames in one chunk.
    let mut decoder = Decoder::default();
    assert_eq!(decoder.push(&bytes).unwrap().len(), 2);
}

#[test]
fn encode_round_trips_through_the_decoder() {
    let message = json!({"jsonrpc": "2.0", "id": 7, "method": "x", "params": {"text": "ü"}});
    let mut decoder = Decoder::default();
    let decoded = decoder.push(&encode(&message)).unwrap();
    assert_eq!(Value::Object(decoded[0].clone()), message);
}

#[test]
fn invalid_streams_fail() {
    let cases: [(&[u8], &str); 5] = [
        (&[b'x'; 8_193], "LSP header exceeds 8192 bytes without a terminator"),
        (b"Content-Length 3\r\n\r\n{}", "malformed LSP header line: \"Content-Length 3\""),
        (b"Content-Length: 3x\r\n\r\n", "Content-Length header is not a non-negative integer"),
        (b"Content-Type: x\r\n\r\n", "LSP header block has no usable Content-Length"),
        (b"Content-Length: 2\r\n\r\n[]", "LSP message body is not a JSON object"),
    ];
    for (bytes, message) in cases {
        let error = Decoder::default().push(bytes).unwrap_err();
        assert_eq!(error.0, message);
    }
    let error = Decoder::default()
        .push(b"Content-Length: 1\r\n\r\n{")
        .unwrap_err();
    assert_eq!(error.0, "LSP message body is not valid JSON");
}

/// The server end of a duplex: reads frames and writes raw replies.
struct Peer {
    stream: DuplexStream,
    decoder: Decoder,
    queued: Vec<Map<String, Value>>,
}

impl Peer {
    async fn next(&mut self) -> Map<String, Value> {
        loop {
            if !self.queued.is_empty() {
                return self.queued.remove(0);
            }
            let mut buffer = [0_u8; 4096];
            let read = self.stream.read(&mut buffer).await.unwrap();
            assert!(read > 0, "client closed");
            self.queued = self.decoder.push(&buffer[..read]).unwrap();
        }
    }

    async fn send(&mut self, message: Value) {
        self.stream.write_all(&encode(&message)).await.unwrap();
    }
}

fn connect(requests: ServerRequests) -> (Connection, Peer, tokio::task::JoinHandle<ReadEnd>) {
    let (client, server) = tokio::io::duplex(1 << 16);
    let (connection, outbox) = Connection::new("p/s", requests);
    let (read, write) = tokio::io::split(client);
    let task = tokio::spawn(pump(connection.clone(), outbox, write, read));
    let peer = Peer {
        stream: server,
        decoder: Decoder::default(),
        queued: Vec::new(),
    };
    (connection, peer, task)
}

fn no_requests() -> ServerRequests {
    Arc::new(|method, _| Err((-32_601, format!("client does not implement {method}"))))
}

#[tokio::test]
async fn a_request_gets_its_answer_and_errors_map_to_codes() {
    let (connection, mut peer, _task) = connect(no_requests());
    let options = RequestOptions::timeout(Duration::from_secs(5));
    let answers = [
        (json!({"result": {"ok": true}}), Ok(json!({"ok": true}))),
        (
            json!({"error": {"code": -32_800, "message": "x"}}),
            Err(("lsp_cancelled", "m was cancelled by the server")),
        ),
        (
            json!({"error": {"code": -32_601, "message": "nope"}}),
            Err(("lsp_operation_unsupported", "p/s does not support m (code -32601): nope")),
        ),
        (
            json!({"error": {"code": -1, "message": "bad"}}),
            Err(("lsp_request_failed", "p/s rejected m (code -1): bad")),
        ),
    ];
    for (reply, expected) in answers {
        let request = connection.request("m", Some(json!({"a": 1})), options);
        let serve = async {
            let sent = peer.next().await;
            assert_eq!(sent["method"], "m");
            assert_eq!(sent["params"], json!({"a": 1}));
            let mut reply = reply.clone();
            reply["jsonrpc"] = json!("2.0");
            reply["id"] = sent["id"].clone();
            peer.send(reply).await;
        };
        let (outcome, ()) = tokio::join!(request, serve);
        match expected {
            Ok(value) => assert_eq!(outcome.unwrap(), value),
            Err((code, message)) => {
                let error = outcome.unwrap_err();
                assert_eq!((error.code, error.message.as_str()), (code, message));
            }
        }
    }
    assert_eq!(connection.in_flight(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_timeout_sends_cancel_request() {
    let (connection, mut peer, _task) = connect(no_requests());
    let options = RequestOptions {
        timeout: Some(Duration::from_millis(1_500)),
        timeout_code: "lsp_startup_timeout",
        cancel: None,
    };
    let error = connection.request("initialize", None, options).await.unwrap_err();
    assert_eq!(error.code, "lsp_startup_timeout");
    assert_eq!(error.message, "initialize timed out after 1500 ms");
    let sent = peer.next().await;
    assert!(sent.get("params").is_none());
    let cancel = peer.next().await;
    assert_eq!(cancel["method"], "$/cancelRequest");
    assert_eq!(cancel["params"], json!({"id": sent["id"]}));
    assert_eq!(connection.in_flight(), 0);
}

#[tokio::test]
async fn cancellation_sends_cancel_request() {
    let (connection, mut peer, _task) = connect(no_requests());
    let token = CancellationToken::new();
    let options = RequestOptions {
        timeout: None,
        timeout_code: "lsp_request_timeout",
        cancel: Some(&token),
    };
    let request = connection.request("textDocument/hover", None, options);
    let serve = async {
        let sent = peer.next().await;
        token.cancel();
        let cancel = peer.next().await;
        assert_eq!(cancel["method"], "$/cancelRequest");
        assert_eq!(cancel["params"]["id"], sent["id"]);
    };
    let (outcome, ()) = tokio::join!(request, serve);
    assert_eq!(outcome.unwrap_err().code, "lsp_cancelled");
    // An already cancelled token sends nothing.
    let error = connection.request("x", None, options).await.unwrap_err();
    assert_eq!(error.message, "x was cancelled before sending");
}

#[tokio::test]
async fn server_requests_and_notifications_are_dispatched() {
    let requests: ServerRequests = Arc::new(|method, params| match method {
        "workspace/configuration" => Ok(json!([params["items"][0]["section"]])),
        _ => Err((-32_601, format!("client does not implement {method}"))),
    });
    let (connection, mut peer, _task) = connect(requests);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let subscription = connection.subscribe(
        "textDocument/publishDiagnostics",
        Arc::new(move |params| sink.lock_unpoisoned().push(params.clone())),
    );
    peer.send(json!({"jsonrpc": "2.0", "id": "a", "method": "workspace/configuration", "params": {"items": [{"section": "ts"}]}}))
        .await;
    assert_eq!(
        Value::Object(peer.next().await),
        json!({"jsonrpc": "2.0", "id": "a", "result": ["ts"]})
    );
    peer.send(json!({"jsonrpc": "2.0", "id": 9, "method": "window/showDocument"}))
        .await;
    assert_eq!(
        Value::Object(peer.next().await),
        json!({"jsonrpc": "2.0", "id": 9, "error": {"code": -32_601, "message": "client does not implement window/showDocument"}})
    );
    peer.send(json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {"uri": "u"}}))
        .await;
    // A request round-trip orders the check after the notification.
    peer.send(json!({"jsonrpc": "2.0", "id": 10, "method": "window/x"}))
        .await;
    let _ = peer.next().await;
    assert_eq!(*seen.lock_unpoisoned(), vec![json!({"uri": "u"})]);
    connection.unsubscribe(subscription);
}

#[tokio::test]
async fn close_fails_pending_and_later_requests() {
    let (connection, mut peer, _task) = connect(no_requests());
    let request = connection.request("m", None, RequestOptions::timeout(Duration::from_secs(60)));
    let close = async {
        let _ = peer.next().await;
        connection.close(&super::LspError::new("lsp_server_crashed", "gone"));
    };
    let (outcome, ()) = tokio::join!(request, close);
    assert_eq!(outcome.unwrap_err().code, "lsp_server_crashed");
    let later = connection
        .request("m", None, RequestOptions::timeout(Duration::from_secs(1)))
        .await;
    assert_eq!(later.unwrap_err().message, "gone");
    assert!(connection.is_closed());
}

#[tokio::test]
async fn an_invalid_frame_ends_the_pump() {
    let (_connection, mut peer, task) = connect(no_requests());
    peer.stream
        .write_all(b"Content-Length: 2\r\n\r\n[]")
        .await
        .unwrap();
    let end = task.await.unwrap();
    assert!(matches!(end, ReadEnd::Invalid(error) if error.0 == "LSP message body is not a JSON object"));
}
