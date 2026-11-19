//! MCP 的 JSON-RPC 客户端（docs/specs/rust-cli/ext.md §3.3）：经传输端口发收消息，请求按 ID 配对，
//! 服务器发来的请求在这里回答，通知交给连接任务。
//!
//! 读者任务是这条连接上事件的唯一消费者；它结束（连接关闭）时让全部等待中的请求失败。

use rust_cli_base::sync::LockUnpoisoned;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use rust_cli_base::Spawner;
use rust_cli_kernel_api::env_files::PathStyle;
use rust_cli_kernel_api::ids::ToolUseId;
use rust_cli_kernel_api::mcp::{McpConnectionId, McpError, McpTransport, McpTransportEvent};
use rust_cli_kernel_api::orchestration::{InteractionRequest, Interactions, McpElicitationAnswer};

use super::notices::{self, NoticeReceiver, NoticeSender};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// JSON-RPC 的“方法不存在”错误码。
pub(super) const METHOD_NOT_FOUND: i64 = -32_601;
/// DEL：文件 URL 里要百分号编码（它与更大的字节）。
const DEL: u8 = 0x7f;

/// 一次请求的失败。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum RpcError {
    /// 服务器回了 JSON-RPC 错误。
    #[error("MCP error {code}: {message}")]
    Server { code: i64, message: String },
    #[error("{0}")]
    Closed(String),
    #[error("timed out")]
    TimedOut,
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Send(String),
    /// The HTTP transport answered a non-success status. Kept typed so the OAuth hooks can read the challenge.
    #[error("{message}")]
    Http {
        message: String,
        www_authenticate: Option<String>,
    },
}

/// A transport send failure: an HTTP status keeps its challenge header, everything else is text.
fn send_failure(error: McpError) -> RpcError {
    match error {
        McpError::Http {
            message,
            www_authenticate,
            ..
        } => RpcError::Http {
            message,
            www_authenticate,
        },
        other => RpcError::Send(other.to_string()),
    }
}

/// 交给连接任务的事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Notice {
    /// `notifications/<kind>/list_changed`：`tools`、`resources`、`prompts`。
    ListChanged(String),
    Closed {
        reason: Option<String>,
        session_expired: bool,
    },
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>;

/// Fork (F3b(c)): a tool call in flight on this connection, which an elicitation the server sends during it attaches
/// to (Node `activeCallTraces`). `cancel` is the call's own token (the turn or the caller cancelled it).
pub(crate) struct ElicitationCall {
    pub(crate) tool_use: ToolUseId,
    /// The MCP server's name, as the question names it.
    pub(crate) server: String,
    /// The session's interactions: the question is asked of the session the call runs in.
    pub(crate) interactions: Arc<dyn Interactions>,
    pub(crate) cancel: CancellationToken,
}

/// A registered call: its fields, and `ended`, which its guard cancels when the call ends.
#[derive(Clone)]
struct Registered {
    id: u64,
    tool_use: ToolUseId,
    server: String,
    interactions: Arc<dyn Interactions>,
    cancel: CancellationToken,
    ended: CancellationToken,
}

/// Keeps a call registered on its connection. Dropping it ends the call, which withdraws any question the call still
/// has open (its answer is `cancel`). It cancels only its own token, never the caller's.
#[must_use = "dropping the guard ends the call at once"]
pub(crate) struct CallGuard {
    calls: Arc<Mutex<Vec<Registered>>>,
    id: u64,
    ended: CancellationToken,
}

impl Drop for CallGuard {
    fn drop(&mut self) {
        self.calls
            .lock_unpoisoned()
            .retain(|call| call.id != self.id);
        self.ended.cancel();
    }
}

pub(crate) struct Client {
    transport: Arc<dyn McpTransport>,
    connection: McpConnectionId,
    next: AtomicU64,
    pending: Arc<Mutex<Pending>>,
    closed: CancellationToken,
    /// Fork (F3b(c)): the tool calls in flight on this connection, oldest first.
    calls: Arc<Mutex<Vec<Registered>>>,
    next_call: AtomicU64,
}

/// 服务器发来的请求的回答：`ping`、`roots/list`；其余回 Method not found。
fn answer(method: &str, roots: &[String]) -> Result<Value, (i64, String)> {
    match method {
        "ping" => Ok(json!({})),
        "roots/list" => {
            // 按 href 去重，保留先后（F57）。
            let mut seen = std::collections::HashSet::new();
            let roots: Vec<Value> = roots
                .iter()
                .map(|root| file_uri(root))
                .filter(|uri| seen.insert(uri.clone()))
                .map(|uri| json!({"uri": uri}))
                .collect();
            Ok(json!({ "roots": roots }))
        }
        other => Err((METHOD_NOT_FOUND, format!("Method not found: {other}"))),
    }
}

/// 工作区根的 `file://` URI，同 `url.pathToFileURL(root).href`（docs/specs/rust-cli/ext.md §3.2）。风格按根的
/// 写法推断；Windows 的 `\\?\` 前缀去掉，UNC 的服务器名是主机（转小写）。
///
/// 缺陷修复（工作线 F57）：以前不做百分号编码（`/a b` 写成 `file:///a b`，含 `#`、`?`、`%` 的路径服务器解析不回来），
/// UNC 写成 `file:////server/share`。
fn file_uri(path: &str) -> String {
    if PathStyle::infer(path) == PathStyle::Posix {
        return file_url(&encode_file_path(path));
    }
    let unc = path.strip_prefix(r"\\?\UNC\").or_else(|| {
        path.strip_prefix(r"\\")
            .filter(|rest| !rest.starts_with(r"?\"))
    });
    if let Some(unc) = unc {
        let (host, rest) = unc.split_at(unc.find(['\\', '/']).unwrap_or(unc.len()));
        let rest = encode_file_path(&rest.replace('\\', "/"));
        return format!("file://{}{rest}", host.to_ascii_lowercase());
    }
    let local = path.strip_prefix(r"\\?\").unwrap_or(path);
    file_url(&encode_file_path(&local.replace('\\', "/")))
}

/// 编码后的路径接在 `file://` 后面：不以 `/` 开头时（Windows 的 `C:/…`）补一个。
fn file_url(encoded: &str) -> String {
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

/// `pathToFileURL` 的百分号编码（Bun 1.3 与 Node 24 实测）：C0 控制字符、空格、`"`、`#`、`%`、`<`、`>`、`?`、`[`、`\`、
/// `]`、`^`、`` ` ``、`{`、`|`、`}`、`~`、DEL 与非 ASCII 的 UTF-8 字节写成大写的 `%XX`。
fn encode_file_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        let escape = byte <= b' ' || byte >= DEL || b"\"#%<>?[\\]^`{|}~".contains(&byte);
        if escape {
            out.push_str(&format!("%{byte:02X}"));
        } else {
            out.push(char::from(byte));
        }
    }
    out
}

impl Client {
    /// 开始读这条连接的事件；`roots` 是 `roots/list` 的回答（工作区根）。
    pub(crate) fn start(
        transport: Arc<dyn McpTransport>,
        connection: McpConnectionId,
        spawner: &Spawner,
        roots: Vec<String>,
    ) -> (Arc<Self>, NoticeReceiver) {
        let client = Arc::new(Self {
            transport,
            connection,
            next: AtomicU64::new(0),
            pending: Arc::default(),
            closed: CancellationToken::new(),
            calls: Arc::default(),
            next_call: AtomicU64::new(0),
        });
        let (notices, receiver) = notices::channel();
        let reader = Reader {
            transport: client.transport.clone(),
            connection: client.connection.clone(),
            pending: client.pending.clone(),
            closed: client.closed.clone(),
            notices,
            roots,
            calls: client.calls.clone(),
            spawner: spawner.clone(),
        };
        spawner.spawn_resident("mcp-reader", reader.run());
        (client, receiver)
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
    }

    /// Fork (F3b(c)): registers a tool call while its `tools/call` is in flight. The returned guard ends the call when
    /// dropped; an elicitation the server sends in between attaches to the newest registered call.
    pub(crate) fn enter_call(&self, call: ElicitationCall) -> CallGuard {
        let id = self.next_call.fetch_add(1, Ordering::Relaxed);
        let ended = CancellationToken::new();
        self.calls.lock_unpoisoned().push(Registered {
            id,
            tool_use: call.tool_use,
            server: call.server,
            interactions: call.interactions,
            cancel: call.cancel,
            ended: ended.clone(),
        });
        CallGuard {
            calls: self.calls.clone(),
            id,
            ended,
        }
    }

    pub(crate) async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), RpcError> {
        let mut message = json!({"jsonrpc": "2.0", "method": method});
        if let Some(params) = params {
            message["params"] = params;
        }
        self.transport
            .send(&self.connection, message)
            .await
            .map_err(send_failure)
    }

    /// 发一个请求并等它的结果；超时或取消时发 `notifications/cancelled`。
    pub(crate) async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Value, RpcError> {
        if self.is_closed() {
            return Err(RpcError::Closed("connection closed".to_owned()));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock_unpoisoned().insert(id, sender);
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(error) = self.transport.send(&self.connection, message).await {
            self.pending.lock_unpoisoned().remove(&id);
            return Err(send_failure(error));
        }
        let outcome = tokio::select! {
            answered = receiver => answered.unwrap_or_else(|_| Err(RpcError::Closed("connection closed".to_owned()))),
            () = tokio::time::sleep(timeout) => Err(RpcError::TimedOut),
            () = cancel.cancelled() => Err(RpcError::Cancelled),
        };
        if matches!(outcome, Err(RpcError::TimedOut | RpcError::Cancelled)) {
            self.pending.lock_unpoisoned().remove(&id);
            let reason = if matches!(outcome, Err(RpcError::Cancelled)) {
                "User interrupted"
            } else {
                "Request timed out"
            };
            let params = json!({"requestId": id, "reason": reason});
            if let Err(error) = self.notify("notifications/cancelled", Some(params)).await {
                tracing::debug!(%error, "could not send notifications/cancelled");
            }
        }
        outcome
    }

    pub(crate) async fn close(&self) {
        if let Err(error) = self.transport.close(&self.connection).await {
            tracing::debug!(%error, "closing an MCP connection failed");
        }
    }
}

struct Reader {
    transport: Arc<dyn McpTransport>,
    connection: McpConnectionId,
    pending: Arc<Mutex<Pending>>,
    closed: CancellationToken,
    notices: NoticeSender,
    roots: Vec<String>,
    calls: Arc<Mutex<Vec<Registered>>>,
    spawner: Spawner,
}

impl Reader {
    async fn run(self) {
        let mut events = self.transport.events(&self.connection);
        let mut closing = Notice::Closed {
            reason: Some("event stream ended".to_owned()),
            session_expired: false,
        };
        while let Some(event) = events.next().await {
            match event {
                McpTransportEvent::Message { message } => self.message(message).await,
                McpTransportEvent::Closed {
                    reason,
                    session_expired,
                } => {
                    closing = Notice::Closed {
                        reason,
                        session_expired,
                    };
                    break;
                }
            }
        }
        // 先标记关闭，再让等待方失败：之后的请求立即失败，不再登记。
        self.closed.cancel();
        let waiting: Vec<_> = self.pending.lock_unpoisoned().drain().collect();
        for (_, sender) in waiting {
            let _ = sender.send(Err(RpcError::Closed("connection closed".to_owned())));
        }
        self.notices.send(closing);
    }

    async fn message(&self, message: Value) {
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned().filter(|id| !id.is_null());
        match (method, id) {
            (None, Some(id)) => self.response(&id, &message),
            (Some("elicitation/create"), Some(id)) => {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                self.elicit(id, params);
            }
            (Some(method), Some(id)) => self.server_request(method, id).await,
            (Some(method), None) => self.notification(method),
            (None, None) => tracing::debug!("ignored an MCP message without method or id"),
        }
    }

    fn response(&self, id: &Value, message: &Value) {
        let Some(sender) = id
            .as_u64()
            .and_then(|id| self.pending.lock_unpoisoned().remove(&id))
        else {
            tracing::debug!(%id, "MCP response for an unknown request");
            return;
        };
        let result = match message.get("error") {
            Some(error) => Err(RpcError::Server {
                code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown error")
                    .to_owned(),
            }),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = sender.send(result);
    }

    async fn server_request(&self, method: &str, id: Value) {
        let reply = match answer(method, &self.roots) {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err((code, message)) => {
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
            }
        };
        if let Err(error) = self.transport.send(&self.connection, reply).await {
            tracing::debug!(%error, method, "could not answer an MCP server request");
        }
    }

    /// Fork (F3b(c)): answers `elicitation/create` in its own task. The answer waits for the user, and the reader keeps
    /// serving the connection meanwhile (the tool call's response included).
    fn elicit(&self, id: Value, params: Value) {
        let call = self.calls.lock_unpoisoned().last().cloned();
        let transport = self.transport.clone();
        let connection = self.connection.clone();
        // Dropping the task handle detaches it; the task ends by answering.
        drop(self.spawner.spawn("mcp-elicitation", async move {
            let result = elicitation_answer(call, &params).await;
            let reply = json!({"jsonrpc": "2.0", "id": id, "result": result});
            if let Err(error) = transport.send(&connection, reply).await {
                tracing::debug!(%error, "could not answer an MCP elicitation");
            }
        }));
    }

    fn notification(&self, method: &str) {
        let kind = method
            .strip_prefix("notifications/")
            .and_then(|rest| rest.strip_suffix("/list_changed"));
        match kind {
            Some(kind) => self.notices.send(Notice::ListChanged(kind.to_owned())),
            None => tracing::debug!(method, "MCP notification"),
        }
    }
}

/// Fork (F3b(c)): the answer to `elicitation/create` (Node `installElicitationHandler`). Only form mode is asked; with no
/// call in flight the question cannot be attributed to a session, so it is declined without a question. A question
/// still open when its call ends is withdrawn and answered `cancel`. Failures decline.
async fn elicitation_answer(call: Option<Registered>, params: &Value) -> Value {
    let decline = json!({"action": "decline"});
    if !supported_mode(params.get("mode")) {
        return decline;
    }
    let Some(call) = call else {
        return decline;
    };
    let message = params
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let request = InteractionRequest::McpElicitation {
        tool_use: call.tool_use.clone(),
        server: call.server.clone(),
        message,
        requested_schema: params
            .get("requestedSchema")
            .cloned()
            .unwrap_or(Value::Null),
        origin: None,
    };
    let withdrawn = async {
        tokio::select! {
            () = call.ended.cancelled() => {}
            () = call.cancel.cancelled() => {}
        }
    };
    tokio::select! {
        asked = call.interactions.ask(request) => {
            let answer = asked
                .ok()
                .and_then(|answer| McpElicitationAnswer::try_from(answer.answer).ok());
            match answer {
                Some(McpElicitationAnswer::Accept { content }) => {
                    json!({"action": "accept", "content": content})
                }
                Some(McpElicitationAnswer::Cancel) => json!({"action": "cancel"}),
                Some(McpElicitationAnswer::Decline) | None => decline,
            }
        }
        () = withdrawn => {
            call.interactions.cancel_ask(&call.tool_use).await;
            json!({"action": "cancel"})
        }
    }
}

/// Fork (F3b(c) PR 2): the answer to a helper-hosted server's question, relayed by the helper (`helper/elicitation`).
/// The question belongs to `tool_use`'s call on `server` and is asked of `interactions`, the session the call runs in.
/// `withdrawn` is the helper's abandon of the request (its call ended, or the turn was cancelled): it withdraws a
/// question still open, which is answered `cancel`. The same answers and failures as the connection's own question.
pub async fn helper_elicitation_answer(
    interactions: Arc<dyn Interactions>,
    tool_use: ToolUseId,
    server: String,
    params: &Value,
    withdrawn: CancellationToken,
) -> Value {
    let call = Registered {
        id: 0,
        tool_use,
        server,
        interactions,
        cancel: withdrawn.clone(),
        ended: withdrawn,
    };
    elicitation_answer(Some(call), params).await
}

/// Node's `isSupportedElicitationMode`: an absent mode is form; the form names are the form mode, others decline.
fn supported_mode(mode: Option<&Value>) -> bool {
    match mode {
        None => true,
        Some(Value::String(mode)) => matches!(mode.as_str(), "form" | "openai/form" | "openaiForm"),
        Some(_) => false,
    }
}

#[cfg(test)]
#[path = "rpc_tests.rs"]
mod tests;
