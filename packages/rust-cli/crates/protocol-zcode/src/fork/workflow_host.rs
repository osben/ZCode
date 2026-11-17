//! Fork: Boundary A's host side, the NDJSON transport of one sandbox child (specs/fork-rust-workflow-engine.md, 4.1).
//!
//! Owner: this loop owns the child's stdio for one run. It keeps the child's local handles, the requests in flight and
//! the order of the lines. It does not interpret asks, world reads, reports or artifacts: the [`ChildHandler`] does, and
//! W5 to W6 supply it. A line that does not parse, a handle the host cannot resolve, or a child that exits before
//! `complete` ends the run as `stopped(interrupted)`. The cause names the line or the stderr tail, never a script value.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use futures_util::future::BoxFuture;
use futures_util::stream::{FuturesUnordered, StreamExt};
use serde_json::Value;
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt,
};

use super::workflow_wire::{
    ChildEvent, ChildMessage, ChildRequest, Completion, CreateActor, WireError, response_line,
};

/// The engine side of Boundary A. Methods are synchronous except the request's future, which runs while the host
/// keeps reading lines, so asks in flight do not hold up the child's next message.
pub trait ChildHandler: Send + Sync {
    /// Creates the actor in the engine and returns its engine id. An `Err` refuses the actor, which ends the run.
    fn create_actor(&self, actor: &CreateActor) -> Result<String, String>;

    /// Starts one request. `actor_id` is the engine id of the request's actor, resolved by the host.
    fn request(
        &self,
        request: ChildRequest,
        actor_id: Option<String>,
    ) -> BoxFuture<'static, Result<Value, WireError>>;

    /// Handles one event, in the order the child wrote it.
    fn event(&self, event: ChildEvent);
}

/// The child's three stdio ends, as the launcher hands them over.
pub struct ChildIo<R, W, E> {
    pub stdout: R,
    pub stdin: W,
    pub stderr: E,
}

/// How a run's stream ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// The child sent `complete`.
    Completed(Completion),
    /// The stream stopped before `complete`.
    Stopped { reason: StopReason, cause: String },
}

/// The only stop reason the transport produces; the engine maps the others (`user`, `model`, ...) itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Interrupted,
}

/// The stderr kept for a cause: its last bytes, so a long crash log cannot grow a cause.
const STDERR_TAIL_BYTES: usize = 4096;
/// The stderr text a cause carries, in characters.
const STDERR_CAUSE_CHARS: usize = 2000;

type Answer = (String, Result<Value, WireError>);

/// Runs the NDJSON host for one child until its `complete`, or until the stream stops.
pub async fn run<R, W, E>(io: ChildIo<R, W, E>, handler: Arc<dyn ChildHandler>) -> Outcome
where
    R: AsyncBufRead + Unpin + Send,
    W: AsyncWrite + Unpin + Send,
    E: AsyncRead + Unpin + Send,
{
    let ChildIo {
        mut stdout,
        mut stdin,
        mut stderr,
    } = io;
    let mut host = Host {
        handler,
        locals: HashMap::new(),
        in_flight: HashSet::new(),
        pending: FuturesUnordered::new(),
    };
    let mut line = Vec::new();
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
            read = stdout.read_until(b'\n', &mut line) => {
                match read {
                    Ok(0) => {
                        // EOF. A last line without its newline is still a line, as readline emits it on close.
                        if !line.is_empty() {
                            line_no += 1;
                            if let Some(outcome) = host.take_line(&line, line_no) {
                                return outcome;
                            }
                        }
                        // The child's stderr may still hold its last words: drain what is left, bounded, so the cause
                        // carries them even when stdout closed first.
                        if stderr_open {
                            drain_stderr(&mut stderr, &mut tail).await;
                        }
                        return stopped("the child exited before it completed", &tail);
                    }
                    Ok(_) => {
                        if !line.ends_with(b"\n") {
                            // Only the EOF case above sees an unterminated line; keep reading for its newline.
                            continue;
                        }
                        line_no += 1;
                        let text = std::mem::take(&mut line);
                        if let Some(outcome) = host.take_line(&text, line_no) {
                            return outcome;
                        }
                    }
                    Err(_) => return stopped("the child's stdout could not be read", &tail),
                }
            }
            read = stderr.read(&mut chunk), if stderr_open => {
                match read {
                    Ok(0) | Err(_) => stderr_open = false,
                    Ok(count) => {
                        tail.extend_from_slice(&chunk[..count]);
                        if tail.len() > STDERR_TAIL_BYTES {
                            let excess = tail.len() - STDERR_TAIL_BYTES;
                            tail.drain(..excess);
                        }
                    }
                }
            }
        }
    }
}

/// Reads the child's remaining stderr into the tail until it closes, or until a read stalls. A grandchild that keeps the
/// pipe open cannot hold the stop up for longer than one short read window.
async fn drain_stderr<E: AsyncRead + Unpin>(stderr: &mut E, tail: &mut Vec<u8>) {
    let mut chunk = [0u8; 1024];
    loop {
        match tokio::time::timeout(
            std::time::Duration::from_millis(100),
            stderr.read(&mut chunk),
        )
        .await
        {
            Ok(Ok(count)) if count > 0 => {
                tail.extend_from_slice(&chunk[..count]);
                if tail.len() > STDERR_TAIL_BYTES {
                    let excess = tail.len() - STDERR_TAIL_BYTES;
                    tail.drain(..excess);
                }
            }
            _ => return,
        }
    }
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
                    Err(_) => Some(malformed(line_no)),
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
        cause: format!("the child wrote a malformed or refused message at line {line_no}"),
    }
}

#[cfg(test)]
#[path = "workflow_host_tests.rs"]
mod tests;
