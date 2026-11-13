//! NDJSON JSON-RPC 2.0 over the agent's stdio (Node: `@agentclientprotocol/sdk` `ndJsonStream` plus `transport.ts`).
//!
//! One pump task per agent process owns the process and its pipes: it writes outgoing lines, reads frames (at
//! most 2 MiB each), resolves responses, hands notifications and agent requests to the runtime, keeps a stderr
//! tail, and tears the process down. The runtime only talks to the [`Peer`] (requests, notifications) and the
//! shutdown token; there is no lock shared with the pump besides the peer's table of pending requests.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_proc::ledger::Tracked;
use rust_cli_proc::tree::Shutdown;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::error::{AcpError, AcpErrorCode};

/// `DEFAULT_MAX_FRAME_BYTES`.
pub(crate) const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
/// `DEFAULT_STDERR_TAIL_CHARS` (bytes here; the tail is only for diagnostics).
const STDERR_TAIL_BYTES: usize = 64 * 1024;
/// JSON-RPC "method not found".
const METHOD_NOT_FOUND: i64 = -32601;

type Pending = HashMap<u64, oneshot::Sender<Result<Value, AcpError>>>;

/// The runtime's side of the connection. Closed once: every pending and later request then fails.
pub(crate) struct Peer {
    outbox: mpsc::UnboundedSender<String>,
    pending: Mutex<Option<Pending>>,
    next_id: AtomicU64,
}

impl Peer {
    pub(crate) fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<String>) {
        let (outbox, inbox) = mpsc::unbounded_channel();
        let peer = Self {
            outbox,
            pending: Mutex::new(Some(HashMap::new())),
            next_id: AtomicU64::new(0),
        };
        (Arc::new(peer), inbox)
    }

    fn send(&self, message: &Value) {
        let mut line = message.to_string();
        line.push('\n');
        // A closed outbox means the pump is gone; the pending request then fails through `close`.
        let _ = self.outbox.send(line);
    }

    /// Sends a request and waits for its answer. `timeout` fails it with Node's `"<method> timed out after <ms>ms"`.
    pub(crate) async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, AcpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        match self.pending.lock_unpoisoned().as_mut() {
            Some(pending) => {
                pending.insert(id, sender);
            }
            None => return Err(AcpError::stream_closed()),
        }
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let outcome = match timeout {
            None => receiver.await,
            Some(limit) => match tokio::time::timeout(limit, receiver).await {
                Ok(outcome) => outcome,
                Err(_) => {
                    if let Some(pending) = self.pending.lock_unpoisoned().as_mut() {
                        pending.remove(&id);
                    }
                    return Err(AcpError::new(
                        AcpErrorCode::Timeout,
                        format!("{method} timed out after {}ms", limit.as_millis()),
                    ));
                }
            },
        };
        outcome.unwrap_or_else(|_| Err(AcpError::stream_closed()))
    }

    pub(crate) fn notify(&self, method: &str, params: Value) {
        self.send(&json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    fn respond(&self, id: Value, result: Value) {
        self.send(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    fn respond_error(&self, id: Value, code: i64, message: &str) {
        self.send(
            &json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
        );
    }

    fn resolve(&self, id: u64, outcome: Result<Value, AcpError>) {
        let sender = self
            .pending
            .lock_unpoisoned()
            .as_mut()
            .and_then(|pending| pending.remove(&id));
        if let Some(sender) = sender {
            let _ = sender.send(outcome);
        }
    }

    /// Fails every pending request with `error`; later requests fail with a closed stream.
    pub(crate) fn close(&self, error: &AcpError) {
        let pending = self.pending.lock_unpoisoned().take();
        for (_, sender) in pending.into_iter().flatten() {
            let _ = sender.send(Err(error.clone()));
        }
    }
}

/// An answer the runtime computes for an agent request (a permission ask).
pub(crate) type Answer = Pin<Box<dyn Future<Output = Value> + Send>>;

/// What the pump reports to the runtime. Every call carries the process generation implicitly (one sink per
/// process), so a late report of an old process is told apart by the runtime.
pub(crate) trait Inbound: Send + Sync {
    /// Bytes arrived on stdout (re-arms the stall watch).
    fn activity(&self);
    fn notification(&self, method: &str, params: Value);
    /// An agent request: `Some` answers it, `None` answers "method not found".
    fn request(&self, method: &str, params: Value) -> Option<Answer>;
    /// The process exited (`code`, signal name).
    fn exited(&self, code: Option<i32>, signal: Option<String>);
    /// The stream failed and the process did not exit within the death grace (or the frame was too large).
    fn stream_failed(&self, error: AcpError);
}

/// Grace and timing of the pump.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PumpTimings {
    /// After stdout ends, how long to wait for the exit before treating it as a stream failure (`DEATH_GRACE_MS`).
    pub death_grace: Duration,
    /// After stdin is closed on shutdown, how long the agent may take to exit by itself (`stopGraceMs`).
    pub stop_grace: Duration,
}

/// The process side of one agent: pipes, process, outbox and the sink.
pub(crate) struct Pump {
    pub tracked: Tracked,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
    pub peer: Arc<Peer>,
    pub inbox: mpsc::UnboundedReceiver<String>,
    pub inbound: Arc<dyn Inbound>,
    pub shutdown: CancellationToken,
    pub timings: PumpTimings,
    pub stderr_tail: Arc<Mutex<String>>,
}

/// The runtime's handle on a pump: shut it down and wait until the process is gone.
pub(crate) struct PumpHandle {
    pub shutdown: CancellationToken,
    pub done: watch::Receiver<bool>,
    _task: rust_cli_base::OwnedTask<()>,
}

impl PumpHandle {
    pub(crate) async fn stop(&self) {
        self.shutdown.cancel();
        let mut done = self.done.clone();
        let _ = done.wait_for(|finished| *finished).await;
    }
}

pub(crate) fn start(pump: Pump) -> PumpHandle {
    let shutdown = pump.shutdown.clone();
    let (finished, done) = watch::channel(false);
    let task = rust_cli_base::owned(async move {
        pump.run().await;
        let _ = finished.send(true);
    });
    PumpHandle {
        shutdown,
        done,
        _task: task,
    }
}

enum Frame {
    Line,
    End,
    TooLarge,
}

/// Reads one `\n`-terminated frame into `buffer` (cancel-safe: bytes already read stay in `buffer`).
async fn read_frame(
    reader: &mut BufReader<ChildStdout>,
    buffer: &mut Vec<u8>,
    activity: &(dyn Fn() + Sync),
) -> Frame {
    loop {
        let available = match reader.fill_buf().await {
            Ok(available) => available,
            Err(_) => return Frame::End,
        };
        if available.is_empty() {
            return if buffer.is_empty() {
                Frame::End
            } else {
                Frame::Line
            };
        }
        activity();
        if let Some(position) = available.iter().position(|byte| *byte == b'\n') {
            buffer.extend_from_slice(&available[..position]);
            reader.consume(position + 1);
            return Frame::Line;
        }
        let length = available.len();
        buffer.extend_from_slice(available);
        reader.consume(length);
        if buffer.len() > MAX_FRAME_BYTES {
            return Frame::TooLarge;
        }
    }
}

#[cfg(unix)]
fn signal_name(status: ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| {
        match signal {
            1 => "SIGHUP",
            2 => "SIGINT",
            3 => "SIGQUIT",
            6 => "SIGABRT",
            9 => "SIGKILL",
            11 => "SIGSEGV",
            13 => "SIGPIPE",
            15 => "SIGTERM",
            _ => return format!("SIG{signal}"),
        }
        .to_owned()
    })
}

#[cfg(not(unix))]
fn signal_name(_status: ExitStatus) -> Option<String> {
    None
}

fn dispatch(
    peer: &Peer,
    inbound: &dyn Inbound,
    line: &[u8],
    answers: &mut JoinSet<(Value, Value)>,
) {
    let Ok(message) = serde_json::from_slice::<Value>(line) else {
        if !line.iter().all(u8::is_ascii_whitespace) {
            tracing::debug!(
                event = "acp.frame_ignored",
                "ignored a non-JSON line from an ACP agent"
            );
        }
        return;
    };
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").filter(|id| !id.is_null()).cloned();
    match (method, id) {
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else { return };
            let outcome = match message.get("error") {
                Some(error) => Err(AcpError::new(
                    AcpErrorCode::Rpc,
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("ACP agent request failed")
                        .to_owned(),
                )),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            peer.resolve(id, outcome);
        }
        (Some(method), Some(id)) => {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            match inbound.request(method, params) {
                Some(answer) => {
                    answers.spawn(async move { (id, answer.await) });
                }
                None => peer.respond_error(id, METHOD_NOT_FOUND, "Method not found"),
            }
        }
        (Some(method), None) => {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            inbound.notification(method, params);
        }
        (None, None) => {}
    }
}

fn keep_stderr(tail: &Mutex<String>, line: &str) {
    tracing::debug!(event = "acp.stderr", line, "ACP agent stderr");
    let mut tail = tail.lock_unpoisoned();
    tail.push_str(line);
    tail.push('\n');
    if tail.len() > STDERR_TAIL_BYTES {
        let mut cut = tail.len() - STDERR_TAIL_BYTES;
        while !tail.is_char_boundary(cut) {
            cut += 1;
        }
        tail.drain(..cut);
    }
}

/// Why the pump left its loop.
enum Ended {
    /// The runtime asked for the shutdown.
    Shutdown,
    /// The process exited by itself.
    Exited,
    /// The stream failed and the process did not exit in time.
    StreamFailed,
}

impl Pump {
    async fn run(self) {
        let Pump {
            mut tracked,
            stdin,
            stdout,
            stderr,
            peer,
            mut inbox,
            inbound,
            shutdown,
            timings,
            stderr_tail,
        } = self;
        let mut stdin = Some(stdin);
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        let mut errors = BufReader::new(stderr).lines();
        let mut reading = true;
        let mut errors_open = true;
        let mut answers: JoinSet<(Value, Value)> = JoinSet::new();
        let mut death: Option<Pin<Box<tokio::time::Sleep>>> = None;
        let activity = {
            let inbound = inbound.clone();
            move || inbound.activity()
        };
        let ended = loop {
            tokio::select! {
                biased;
                () = shutdown.cancelled() => break Ended::Shutdown,
                status = tracked.child().wait() => {
                    let (code, signal) = match &status {
                        Ok(status) => (status.code(), signal_name(*status)),
                        Err(_) => (None, None),
                    };
                    peer.close(&AcpError::died(format!(
                        "Agent process exited (code={}, signal={})",
                        code.map_or_else(|| "null".to_owned(), |code| code.to_string()),
                        signal.as_deref().unwrap_or("null"),
                    )));
                    inbound.exited(code, signal);
                    break Ended::Exited;
                }
                frame = read_frame(&mut reader, &mut buffer, &activity), if reading => match frame {
                    Frame::Line => {
                        dispatch(&peer, inbound.as_ref(), &buffer, &mut answers);
                        buffer.clear();
                    }
                    Frame::End => {
                        reading = false;
                        peer.close(&AcpError::stream_closed());
                        death = Some(Box::pin(tokio::time::sleep(timings.death_grace)));
                    }
                    Frame::TooLarge => {
                        let error = AcpError::new(
                            AcpErrorCode::StreamClosed,
                            format!("ACP agent frame exceeds {MAX_FRAME_BYTES} bytes"),
                        );
                        peer.close(&error);
                        inbound.stream_failed(error);
                        break Ended::StreamFailed;
                    }
                },
                line = errors.next_line(), if errors_open => match line {
                    Ok(Some(line)) => keep_stderr(&stderr_tail, &line),
                    Ok(None) | Err(_) => errors_open = false,
                },
                message = inbox.recv(), if stdin.is_some() => match (message, stdin.as_mut()) {
                    (Some(line), Some(pipe)) => {
                        let written = async {
                            pipe.write_all(line.as_bytes()).await?;
                            pipe.flush().await
                        };
                        if written.await.is_err() {
                            stdin = None;
                        }
                    }
                    _ => stdin = None,
                },
                Some(answered) = answers.join_next(), if !answers.is_empty() => {
                    if let Ok((id, result)) = answered {
                        peer.respond(id, result);
                    }
                    // Flush the answer right away (the outbox branch writes it on the next turn).
                }
                () = async { if let Some(sleep) = death.as_mut() { sleep.await } }, if death.is_some() => {
                    inbound.stream_failed(AcpError::stream_closed());
                    break Ended::StreamFailed;
                }
            }
        };
        answers.abort_all();
        peer.close(&AcpError::stream_closed());
        // Teardown (`planAcpProcessTeardown` / `runAcpProcessTeardown`): EOF on stdin first, so an agent that
        // exits on EOF ends by itself; then TERM, a grace, KILL for the whole process group.
        drop(stdin);
        let shutdown_mode = match ended {
            Ended::Exited => Shutdown::Immediate,
            Ended::Shutdown | Ended::StreamFailed => {
                let exited = tokio::time::timeout(timings.stop_grace, tracked.child().wait())
                    .await
                    .is_ok();
                if exited {
                    Shutdown::Immediate
                } else {
                    Shutdown::Graceful
                }
            }
        };
        if let Err(error) = tracked.terminate(shutdown_mode).await {
            tracing::warn!(event = "acp.cleanup_failed", %error, "ACP agent process cleanup failed");
        }
    }
}
