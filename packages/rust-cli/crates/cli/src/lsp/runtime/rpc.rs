//! Fork: JSON-RPC over one language server's stdio (specs/fork-rust-lsp.md "JSON-RPC"), Node adapters
//! `lsp/json-rpc.ts` and `lsp/json-rpc-connection.ts`. It owns request ids, timeouts, cancellation and dispatch; it
//! knows nothing about lifecycle (the pool decides what a closed connection means).

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rust_cli_base::sync::LockUnpoisoned;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::LspError;

/// Node `LSP_FRAME_HEADER_MAX_BYTES`.
const HEADER_MAX_BYTES: usize = 8_192;
const HEADER_SEPARATOR: &[u8] = b"\r\n\r\n";
const METHOD_NOT_FOUND: i64 = -32_601;
const REQUEST_CANCELLED: i64 = -32_800;
pub(crate) const CANCEL_REQUEST: &str = "$/cancelRequest";

/// The peer's bytes are not Content-Length framed JSON-RPC; the stream is unusable (Node `JsonRpcFramingError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FramingError(pub(crate) String);

/// Node `encodeJsonRpcFrame`.
pub(crate) fn encode(message: &Value) -> Vec<u8> {
    let body = message.to_string();
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(body.as_bytes());
    frame
}

/// Node `JsonRpcFrameDecoder`: chunks may split headers or bodies anywhere, one chunk may hold several messages, and
/// lengths are byte counts.
#[derive(Default)]
pub(crate) struct Decoder {
    pending: Vec<u8>,
}

impl Decoder {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<Map<String, Value>>, FramingError> {
        self.pending.extend_from_slice(chunk);
        let mut messages = Vec::new();
        loop {
            let Some(header_end) = find(&self.pending, HEADER_SEPARATOR) else {
                if self.pending.len() > HEADER_MAX_BYTES {
                    return Err(FramingError(format!(
                        "LSP header exceeds {HEADER_MAX_BYTES} bytes without a terminator"
                    )));
                }
                break;
            };
            let length =
                content_length(&String::from_utf8_lossy(&self.pending[..header_end]))?;
            let body_start = header_end + HEADER_SEPARATOR.len();
            let frame_end = body_start.saturating_add(length);
            if self.pending.len() < frame_end {
                break;
            }
            let message = body(&self.pending[body_start..frame_end])?;
            self.pending.drain(..frame_end);
            messages.push(message);
        }
        Ok(messages)
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Node `parseContentLength`.
fn content_length(header: &str) -> Result<usize, FramingError> {
    let mut length = None;
    for line in header.split("\r\n") {
        let separator = line.find(':').filter(|&at| at > 0).ok_or_else(|| {
            let shown: String = line.chars().take(80).collect();
            FramingError(format!(
                "malformed LSP header line: {}",
                Value::String(shown)
            ))
        })?;
        if !line[..separator].trim().eq_ignore_ascii_case("content-length") {
            continue;
        }
        let value = line[separator + 1..].trim();
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(FramingError(
                "Content-Length header is not a non-negative integer".to_owned(),
            ));
        }
        // Node `Number.isSafeInteger`: anything that does not fit is unusable.
        length = Some(value.parse::<usize>().map_err(|_| no_length())?);
    }
    length.ok_or_else(no_length)
}

fn no_length() -> FramingError {
    FramingError("LSP header block has no usable Content-Length".to_owned())
}

fn body(bytes: &[u8]) -> Result<Map<String, Value>, FramingError> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err(FramingError(
            "LSP message body is not a JSON object".to_owned(),
        )),
        Err(_) => Err(FramingError(
            "LSP message body is not valid JSON".to_owned(),
        )),
    }
}

/// Answers a server-to-client request: a result, or a JSON-RPC error code and message.
pub(crate) type ServerRequests =
    Arc<dyn Fn(&str, &Value) -> Result<Value, (i64, String)> + Send + Sync>;
pub(crate) type NotificationHandler = Arc<dyn Fn(&Value) + Send + Sync>;

/// One request's local bounds (Node `LspRpcRequestOptions`).
#[derive(Clone, Copy)]
pub(crate) struct RequestOptions<'a> {
    /// `None` means no local timeout.
    pub(crate) timeout: Option<Duration>,
    /// `lsp_request_timeout` or `lsp_startup_timeout`.
    pub(crate) timeout_code: &'static str,
    pub(crate) cancel: Option<&'a CancellationToken>,
}

impl RequestOptions<'_> {
    pub(crate) fn timeout(timeout: Duration) -> Self {
        Self {
            timeout: Some(timeout),
            timeout_code: "lsp_request_timeout",
            cancel: None,
        }
    }
}

/// Why the read half stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReadEnd {
    /// stdout ended or failed; the process exit decides what it means.
    Eof,
    /// The stream stopped being valid LSP; the owner treats the server as crashed.
    Invalid(FramingError),
}

struct Pending {
    method: String,
    answer: oneshot::Sender<Result<Value, LspError>>,
}

#[derive(Default)]
struct State {
    pending: HashMap<i64, Pending>,
    closed: Option<LspError>,
    subscribers: Vec<(u64, String, NotificationHandler)>,
}

struct Inner {
    server_id: String,
    next_id: AtomicI64,
    next_subscription: AtomicU64,
    outbox: mpsc::UnboundedSender<Vec<u8>>,
    state: Mutex<State>,
    requests: ServerRequests,
}

/// JSON-RPC over one child process's stdio (Node `LspJsonRpcConnection`). Cheap to clone.
#[derive(Clone)]
pub(crate) struct Connection(Arc<Inner>);

/// The frames waiting for the write half; handed to [`pump`] once the pipes exist.
pub(crate) struct Outbox(mpsc::UnboundedReceiver<Vec<u8>>);

impl Connection {
    /// A connection whose writes queue until [`pump`] runs with the returned outbox.
    pub(crate) fn new(server_id: &str, requests: ServerRequests) -> (Self, Outbox) {
        let (outbox, receiver) = mpsc::unbounded_channel();
        let inner = Inner {
            server_id: server_id.to_owned(),
            next_id: AtomicI64::new(1),
            next_subscription: AtomicU64::new(1),
            outbox,
            state: Mutex::default(),
            requests,
        };
        (Self(Arc::new(inner)), Outbox(receiver))
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.0.state.lock_unpoisoned().closed.is_some()
    }

    pub(crate) fn in_flight(&self) -> usize {
        self.0.state.lock_unpoisoned().pending.len()
    }

    /// Node `sendRequest`. Dropping the future before the answer cancels the request like an abort.
    pub(crate) async fn request(
        &self,
        method: &str,
        params: Option<Value>,
        options: RequestOptions<'_>,
    ) -> Result<Value, LspError> {
        if options.cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(LspError::new(
                "lsp_cancelled",
                format!("{method} was cancelled before sending"),
            ));
        }
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        let (answer, answered) = oneshot::channel();
        {
            let mut state = self.0.state.lock_unpoisoned();
            if let Some(error) = &state.closed {
                return Err(error.clone());
            }
            state.pending.insert(
                id,
                Pending {
                    method: method.to_owned(),
                    answer,
                },
            );
        }
        let mut message = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write(&message);
        let mut guard = CancelOnDrop {
            connection: self,
            id,
            method,
            armed: true,
        };
        let timeout = async {
            match options.timeout {
                Some(timeout) => tokio::time::sleep(timeout).await,
                None => std::future::pending().await,
            }
        };
        let cancelled = async {
            match options.cancel {
                Some(token) => token.cancelled().await,
                None => std::future::pending().await,
            }
        };
        let outcome = tokio::select! {
            answer = answered => answer.unwrap_or_else(|_| Err(LspError::new("lsp_server_crashed", format!("{method} lost its connection")))),
            () = timeout => {
                let millis = options.timeout.map_or(0, |timeout| timeout.as_millis());
                self.cancel_pending(id, &LspError::new(options.timeout_code, format!("{method} timed out after {millis} ms")), true)
            }
            () = cancelled => self.cancel_pending(id, &LspError::new("lsp_cancelled", format!("{method} was cancelled")), true),
        };
        guard.armed = false;
        outcome
    }

    /// Node `notify`: nothing is sent after `close`.
    pub(crate) fn notify(&self, method: &str, params: Option<Value>) {
        if self.is_closed() {
            return;
        }
        let mut message = json!({"jsonrpc": "2.0", "method": method});
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write(&message);
    }

    /// Calls `handler` for every notification named `method` until [`Connection::unsubscribe`].
    pub(crate) fn subscribe(&self, method: &str, handler: NotificationHandler) -> u64 {
        let id = self.0.next_subscription.fetch_add(1, Ordering::Relaxed);
        self.0
            .state
            .lock_unpoisoned()
            .subscribers
            .push((id, method.to_owned(), handler));
        id
    }

    pub(crate) fn unsubscribe(&self, subscription: u64) {
        self.0
            .state
            .lock_unpoisoned()
            .subscribers
            .retain(|(id, _, _)| *id != subscription);
    }

    /// Node `close`: fails every in-flight request with `error`; later requests fail with it too. Idempotent.
    pub(crate) fn close(&self, error: &LspError) {
        let pending = {
            let mut state = self.0.state.lock_unpoisoned();
            if state.closed.is_some() {
                return;
            }
            state.closed = Some(error.clone());
            std::mem::take(&mut state.pending)
        };
        for (_, request) in pending {
            let _ = request.answer.send(Err(error.clone()));
        }
    }

    /// Node `cancelPending`: the request fails with `error`, and the server hears `$/cancelRequest` when asked.
    fn cancel_pending(
        &self,
        id: i64,
        error: &LspError,
        notify_server: bool,
    ) -> Result<Value, LspError> {
        let removed = self.0.state.lock_unpoisoned().pending.remove(&id);
        if removed.is_some() && notify_server {
            self.notify(CANCEL_REQUEST, Some(json!({"id": id})));
        }
        Err(error.clone())
    }

    fn write(&self, message: &Value) {
        if let Some(envelope) = message.as_object() {
            log_envelope(&self.0.server_id, "out", envelope);
        }
        // The write half is gone only when the pipes are; the exit owns that consequence.
        let _ = self.0.outbox.send(encode(message));
    }

    fn handle(&self, message: &Map<String, Value>) {
        log_envelope(&self.0.server_id, "in", message);
        let id = message.get("id").filter(|id| !id.is_null());
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            let params = message.get("params").unwrap_or(&Value::Null);
            match id {
                Some(id) => self.answer(id.clone(), method, params),
                None => self.dispatch(method, params),
            }
            return;
        }
        let Some(id) = id.and_then(Value::as_i64) else {
            return;
        };
        let Some(request) = self.0.state.lock_unpoisoned().pending.remove(&id) else {
            tracing::debug!(event = "adapters.lsp.unknown_response", server_id = %self.0.server_id, "LSP response for unknown request id");
            return;
        };
        let outcome = match message.get("error") {
            Some(error) => Err(self.response_error(&request.method, error)),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = request.answer.send(outcome);
    }

    fn answer(&self, id: Value, method: &str, params: &Value) {
        let response = match (self.0.requests)(method, params) {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err((code, message)) => {
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
            }
        };
        if !self.is_closed() {
            self.write(&response);
        }
    }

    fn dispatch(&self, method: &str, params: &Value) {
        let handlers: Vec<NotificationHandler> = self
            .0
            .state
            .lock_unpoisoned()
            .subscribers
            .iter()
            .filter(|(_, name, _)| name == method)
            .map(|(_, _, handler)| Arc::clone(handler))
            .collect();
        for handler in handlers {
            handler(params);
        }
    }

    /// Node `toResponseError`.
    fn response_error(&self, method: &str, error: &Value) -> LspError {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
        let message = error.get("message").and_then(Value::as_str).unwrap_or("");
        if code == REQUEST_CANCELLED {
            return LspError::new(
                "lsp_cancelled",
                format!("{method} was cancelled by the server"),
            );
        }
        let server = &self.0.server_id;
        if code == METHOD_NOT_FOUND {
            return LspError::new(
                "lsp_operation_unsupported",
                format!("{server} does not support {method} (code {code}): {message}"),
            );
        }
        LspError::new(
            "lsp_request_failed",
            format!("{server} rejected {method} (code {code}): {message}"),
        )
    }
}

/// Cancels the request when its future is dropped before an answer (Node's abort signal).
struct CancelOnDrop<'a> {
    connection: &'a Connection,
    id: i64,
    method: &'a str,
    armed: bool,
}

impl Drop for CancelOnDrop<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let error = LspError::new("lsp_cancelled", format!("{} was cancelled", self.method));
        let _ = self.connection.cancel_pending(self.id, &error, true);
    }
}

/// Only the envelope is logged: params and results carry whole file contents.
fn log_envelope(server_id: &str, direction: &str, message: &Map<String, Value>) {
    // Computed outside the macro: `tracing` brings its own `Value` trait into scope there.
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").map(Value::to_string);
    let error_code = message
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(Value::as_i64);
    tracing::debug!(
        event = "adapters.lsp.jsonrpc",
        server_id,
        direction,
        method,
        id,
        error_code,
        "LSP JSON-RPC message"
    );
}

/// Runs both halves of the stdio: frames from `outbox` go to `stdin`, frames from `stdout` are dispatched. Returns when
/// the read half stops; a failed write is left to the process exit.
pub(crate) async fn pump(
    connection: Connection,
    outbox: Outbox,
    mut stdin: impl AsyncWrite + Unpin,
    mut stdout: impl AsyncRead + Unpin,
) -> ReadEnd {
    let Outbox(mut frames) = outbox;
    let server_id = connection.0.server_id.clone();
    let write = async move {
        while let Some(frame) = frames.recv().await {
            if let Err(error) = stdin.write_all(&frame).await {
                tracing::debug!(event = "adapters.lsp.stdin_error", server_id, kind = ?error.kind(), "LSP stdin write failed");
                break;
            }
            let _ = stdin.flush().await;
        }
        std::future::pending::<()>().await;
    };
    let read = async {
        let mut decoder = Decoder::default();
        let mut buffer = vec![0_u8; 16 * 1024];
        loop {
            let read = match stdout.read(&mut buffer).await {
                Ok(0) | Err(_) => return ReadEnd::Eof,
                Ok(read) => read,
            };
            match decoder.push(&buffer[..read]) {
                Ok(messages) => {
                    for message in &messages {
                        connection.handle(message);
                    }
                }
                Err(error) => return ReadEnd::Invalid(error),
            }
        }
    };
    tokio::select! {
        end = read => end,
        () = write => ReadEnd::Eof,
    }
}

#[cfg(test)]
#[path = "rpc_tests.rs"]
mod tests;
