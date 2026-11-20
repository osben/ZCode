//! Fork: Boundary A's host side, the NDJSON transport of one sandbox child (specs/fork-rust-workflow-engine.md, 4.1).
//!
//! Owner: this loop owns the child's stdio for one run. It keeps the child's local handles, the requests in flight and
//! the order of the lines. It does not interpret asks, world reads, reports or artifacts: the [`ChildHandler`] does, and
//! W5 to W6 supply it. A line that does not parse, a handle the host cannot resolve, an engine refusal, a line over the
//! cap, or a child that exits before `complete` ends the run as `stopped(interrupted)`. The cause names the line and the
//! reason, or the stderr tail, never a script value. Blank lines are skipped, as the reference host (`harness.ts`) does.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::stream::{FuturesUnordered, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub use super::workflow_lines::MAX_LINE_BYTES;
use super::workflow_lines::{Line, NdjsonLines};
// The handler and the wire shapes live in kernel-api since W7-5 (specs/fork-rust-workflow-engine.md, 9.18 decision 1).
use super::workflow_wire::{ChildMessage, WireError, response_line};
pub use rust_cli_kernel_api::workflow_child::ChildHandler;

// The stdio ends, the outcome and the stop reason live in kernel-api since W7-5 (specs/fork-rust-workflow-engine.md, 9.22).
pub use rust_cli_kernel_api::workflow_child::{ChildIo, Outcome, StopReason};

/// The stderr kept for a cause: its last bytes, so a long crash log cannot grow a cause.
const STDERR_TAIL_BYTES: usize = 4096;
/// The stderr text a cause carries, in characters.
const STDERR_CAUSE_CHARS: usize = 2000;
/// The whole stderr drain before a stop, however the writer paces its bytes. A grandchild that keeps the pipe open
/// cannot hold the stop, settlement or guard drop up for longer than this.
const STDERR_DRAIN: Duration = Duration::from_millis(500);

type Answer = (String, Result<Value, WireError>);

/// Runs the NDJSON host for one child until its `complete`, or until the stream stops.
pub async fn run<R, W, E>(io: ChildIo<R, W, E>, handler: Arc<dyn ChildHandler>) -> Outcome
where
    R: tokio::io::AsyncBufRead + Unpin + Send,
    W: AsyncWrite + Unpin + Send,
    E: AsyncRead + Unpin + Send,
{
    let ChildIo {
        stdout,
        mut stdin,
        mut stderr,
    } = io;
    let mut lines = NdjsonLines::new(stdout);
    let mut host = Host {
        handler,
        locals: HashMap::new(),
        in_flight: HashSet::new(),
        pending: FuturesUnordered::new(),
    };
    let mut line_no = 0usize;
    let mut stderr_open = true;
    let mut tail = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        tokio::select! {
            Some((id, answer)) = host.pending.next(), if !host.pending.is_empty() => {
                // The answer is written in whatever order the requests finish; the id names it.
                if stdin.write_all(response_line(&id, &answer).as_bytes()).await.is_err()
                    || stdin.flush().await.is_err()
                {
                    return stopped("the child stopped reading its answers", &tail);
                }
                host.in_flight.remove(&id);
            }
            read = lines.next() => {
                match read {
                    Ok(Line::Text(bytes)) => {
                        line_no += 1;
                        if bytes.trim_ascii().is_empty() {
                            continue;
                        }
                        if let Some(outcome) = host.take_line(&bytes, line_no) {
                            return outcome;
                        }
                    }
                    Ok(Line::TooLong) => {
                        return Outcome::Stopped {
                            reason: StopReason::Interrupted,
                            cause: format!(
                                "the child wrote a line over {MAX_LINE_BYTES} bytes at line {}",
                                line_no + 1
                            ),
                        };
                    }
                    Ok(Line::End) => {
                        // The child's stderr may still hold its last words: drain what is left, bounded.
                        if stderr_open {
                            drain_stderr(&mut stderr, &mut tail).await;
                        }
                        return stopped("the child exited before it completed", &tail);
                    }
                    Err(_) => return stopped("the child's stdout could not be read", &tail),
                }
            }
            read = stderr.read(&mut chunk), if stderr_open => {
                match read {
                    Ok(0) | Err(_) => stderr_open = false,
                    Ok(count) => push_tail(&mut tail, &chunk[..count]),
                }
            }
        }
    }
}

/// Keeps the last [`STDERR_TAIL_BYTES`] of stderr.
fn push_tail(tail: &mut Vec<u8>, bytes: &[u8]) {
    tail.extend_from_slice(bytes);
    if tail.len() > STDERR_TAIL_BYTES {
        let excess = tail.len() - STDERR_TAIL_BYTES;
        tail.drain(..excess);
    }
}

/// Reads the child's remaining stderr into the tail until it closes, or until [`STDERR_DRAIN`] has passed in total.
async fn drain_stderr<E: AsyncRead + Unpin>(stderr: &mut E, tail: &mut Vec<u8>) {
    let mut chunk = [0u8; 1024];
    let _ = tokio::time::timeout(STDERR_DRAIN, async {
        loop {
            match stderr.read(&mut chunk).await {
                Ok(count) if count > 0 => push_tail(tail, &chunk[..count]),
                _ => return,
            }
        }
    })
    .await;
}

fn stopped(reason: &str, stderr_tail: &[u8]) -> Outcome {
    let mut cause = reason.to_owned();
    let text = String::from_utf8_lossy(stderr_tail);
    let text = text.trim();
    if !text.is_empty() {
        let skip = text.chars().count().saturating_sub(STDERR_CAUSE_CHARS);
        let bounded: String = text.chars().skip(skip).collect();
        cause.push_str("; stderr: ");
        cause.push_str(&bounded);
    }
    Outcome::Stopped {
        reason: StopReason::Interrupted,
        cause,
    }
}

/// The host's state for one run: the handles it resolved, the request ids in flight, and the requests running.
struct Host {
    handler: Arc<dyn ChildHandler>,
    locals: HashMap<String, String>,
    in_flight: HashSet<String>,
    pending: FuturesUnordered<BoxFuture<'static, Answer>>,
}

impl Host {
    /// Handles one complete line. `None` keeps the run going; `Some` ends it.
    fn take_line(&mut self, bytes: &[u8], line_no: usize) -> Option<Outcome> {
        let text = String::from_utf8_lossy(bytes);
        let text = text.trim_end_matches(['\n', '\r']);
        let message: ChildMessage = match serde_json::from_str(text) {
            Ok(message) => message,
            Err(_) => return Some(malformed(line_no)),
        };
        match message {
            ChildMessage::CreateActor(actor) => {
                if self.locals.contains_key(&actor.local_id) {
                    return Some(malformed(line_no));
                }
                match self.handler.create_actor(&actor) {
                    Ok(engine_id) => {
                        self.locals.insert(actor.local_id, engine_id);
                        None
                    }
                    Err(reason) => Some(Outcome::Stopped {
                        reason: StopReason::Interrupted,
                        cause: format!("the engine refused an actor at line {line_no}: {reason}"),
                    }),
                }
            }
            ChildMessage::Request(request) => {
                let actor_id = match request.actor.as_deref() {
                    None => None,
                    Some(local) => match self.locals.get(local) {
                        Some(engine_id) => Some(engine_id.clone()),
                        None => return Some(malformed(line_no)),
                    },
                };
                if !self.in_flight.insert(request.id.clone()) {
                    return Some(malformed(line_no));
                }
                let id = request.id.clone();
                let running = self.handler.request(request, actor_id);
                self.pending
                    .push(Box::pin(async move { (id, running.await) }));
                None
            }
            ChildMessage::Event(event) => {
                self.handler.event(event);
                None
            }
            ChildMessage::Complete(completion) => Some(Outcome::Completed(completion)),
        }
    }
}

fn malformed(line_no: usize) -> Outcome {
    Outcome::Stopped {
        reason: StopReason::Interrupted,
        cause: format!("the child wrote a malformed message at line {line_no}"),
    }
}

#[cfg(test)]
#[path = "workflow_host_tests.rs"]
mod tests;
