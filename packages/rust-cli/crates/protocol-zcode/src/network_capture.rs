//! Fork: the Resource Manager's Network panel (specs/fork-rust-network-capture.md). Node:
//! `createNodeNetworkCapture("cli", …)` in `packages/shared/src/node/networkCapture.ts`, wired in
//! `bootstrap/src/zcode-protocol/server.ts` and `transport.ts`.
//!
//! The Host turns capture on and off with the notification `process/networkCapture {captureId}`; while it is on, the
//! egress reports each request through [`NetworkCapture::record`] and the capture sends sanitized batches as
//! `process/networkRequests`. One capture per app-server process; it exists before the kernel is assembled because the
//! Host sends the control right after spawning the agent.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::Spawner;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::clock::Clock;
use rust_cli_protocol_core::connection::{Peer, Reply, Service};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

/// The Host's start/stop notification (`zcodeProtocolMethods.processNetworkCapture`).
pub const CONTROL: &str = "process/networkCapture";
/// The batch notification (`zcodeProtocolNotifications.processNetworkRequests`).
pub const REQUESTS: &str = "process/networkRequests";

/// Node: at most 100 records per batch (`networkCaptureBatchSchema`), the rest only counted.
const BATCH_LIMIT: usize = 100;
/// Node: the batch is sent 250 ms after its first record.
pub(crate) const FLUSH_DELAY: Duration = Duration::from_millis(250);
/// `networkRequestRecordSchema.url` and `sanitizeNetworkCaptureUrl`: 2048 characters.
pub(crate) const URL_LIMIT: usize = 2_048;
/// `networkRequestRecordSchema.method`: 32 characters.
const METHOD_LIMIT: usize = 32;
/// `networkCaptureControlSchema.captureId`: 1–100 characters (UTF-16 code units, zod's `length`).
const CAPTURE_ID_LIMIT: usize = 100;

#[derive(Default)]
struct State {
    capture: Option<String>,
    records: Vec<Value>,
    dropped: u64,
    /// Bumped on every capture change; a flush armed under an older generation does nothing.
    generation: u64,
    armed: bool,
}

pub struct NetworkCapture {
    peer: Peer,
    clock: Arc<dyn Clock>,
    spawner: Spawner,
    pid: u32,
    delay: Duration,
    state: Arc<Mutex<State>>,
}

impl NetworkCapture {
    /// `pid` is this process's id (the Host replaces it with its own spawn registration anyway).
    pub fn new(peer: Peer, clock: Arc<dyn Clock>, spawner: Spawner, pid: u32) -> Self {
        Self::with_delay(peer, clock, spawner, pid, FLUSH_DELAY)
    }

    pub(crate) fn with_delay(
        peer: Peer,
        clock: Arc<dyn Clock>,
        spawner: Spawner,
        pid: u32,
        delay: Duration,
    ) -> Self {
        Self {
            peer,
            clock,
            spawner,
            pid,
            delay,
            state: Arc::new(Mutex::new(State::default())),
        }
    }

    /// The Host's control: an invalid one is ignored, like Node (`networkCaptureControlSchema.safeParse`). Always true:
    /// the notification is handled here and goes no further.
    pub fn control(&self, params: &Value) -> bool {
        if let Some(capture) = Self::parse(params) {
            self.set(capture);
        }
        true
    }

    /// `{captureId: string(1..=100) | null}`, strict. `None` for an invalid control; `Some(None)` stops the capture.
    pub(crate) fn parse(params: &Value) -> Option<Option<String>> {
        let fields = params.as_object()?;
        if fields.len() != 1 {
            return None;
        }
        match fields.get("captureId")? {
            Value::Null => Some(None),
            Value::String(id) => {
                let length = id.encode_utf16().count();
                (1..=CAPTURE_ID_LIMIT)
                    .contains(&length)
                    .then(|| Some(id.clone()))
            }
            _ => None,
        }
    }

    /// Node `setCaptureId`: the same id changes nothing; another id (or none) drops the buffer and the pending flush.
    pub fn set(&self, capture: Option<String>) {
        let mut state = self.state.lock_unpoisoned();
        if state.capture == capture {
            return;
        }
        let generation = state.generation.wrapping_add(1);
        *state = State {
            capture,
            generation,
            ..State::default()
        };
    }

    #[cfg(test)]
    pub(crate) fn current(&self) -> Option<String> {
        self.state.lock_unpoisoned().capture.clone()
    }

    /// One outbound request as it starts (Node's `record`). Never blocks and never fails the request.
    pub fn record(&self, method: &str, url: &str) {
        let mut state = self.state.lock_unpoisoned();
        if state.capture.is_none() || method == "CONNECT" {
            return;
        }
        if state.records.len() >= BATCH_LIMIT {
            state.dropped += 1;
            return;
        }
        let Some(url) = sanitize_url(url) else {
            return;
        };
        state.records.push(json!({
            "timestamp": self.clock.now_ms(),
            "processType": "cli",
            "pid": self.pid,
            "method": method_name(method),
            "url": url,
        }));
        if state.armed {
            return;
        }
        state.armed = true;
        let generation = state.generation;
        drop(state);
        let (shared, peer, delay) = (self.state.clone(), self.peer.clone(), self.delay);
        drop(self.spawner.spawn("network-capture-flush", async move {
            tokio::time::sleep(delay).await;
            let batch = {
                let mut state = shared.lock_unpoisoned();
                if state.generation != generation {
                    return;
                }
                state.armed = false;
                let Some(capture) = state.capture.clone() else {
                    return;
                };
                json!({
                    "captureId": capture,
                    "records": std::mem::take(&mut state.records),
                    "dropped": std::mem::take(&mut state.dropped),
                })
            };
            // A closed connection drops the observation only.
            let _ = peer.notify(REQUESTS, &batch).await;
        }));
    }
}

/// Node `method.slice(0, 32)`.
pub(crate) fn method_name(method: &str) -> String {
    method.chars().take(METHOD_LIMIT).collect()
}

/// Node `sanitizeNetworkCaptureUrl`: only `http:`, `https:`, `ws:`, `wss:`; credentials and fragment removed; every
/// distinct query key kept once (first-appearance order) with the value `[redacted]`, form-serialized like
/// `URLSearchParams.set`; cut to 2048 characters. `None` when the URL is not recorded.
pub(crate) fn sanitize_url(value: &str) -> Option<String> {
    let mut url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https" | "ws" | "wss") {
        return None;
    }
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    url.set_fragment(None);
    let mut keys: Vec<String> = Vec::new();
    for (key, _) in url.query_pairs() {
        if !keys.iter().any(|seen| *seen == key) {
            keys.push(key.into_owned());
        }
    }
    if !keys.is_empty() {
        let mut pairs = url.query_pairs_mut();
        pairs.clear();
        for key in &keys {
            pairs.append_pair(key, "[redacted]");
        }
    }
    // The serialized URL is ASCII, so characters and UTF-16 units agree.
    Some(url.as_str().chars().take(URL_LIMIT).collect())
}

/// The protocol service with the capture control handled inline, in arrival order, before the kernel is ready (Node
/// handles it in the reader, outside the command inbox). Everything else goes to `inner`.
pub fn with_network_capture(
    inner: Arc<dyn Service>,
    capture: Arc<NetworkCapture>,
) -> Arc<dyn Service> {
    Arc::new(Controlled { inner, capture })
}

struct Controlled {
    inner: Arc<dyn Service>,
    capture: Arc<NetworkCapture>,
}

#[async_trait]
impl Service for Controlled {
    async fn request(&self, method: &str, params: Value) -> Result<Reply, RpcError> {
        self.inner.request(method, params).await
    }

    async fn notification(&self, method: &str, params: Value) {
        self.inner.notification(method, params).await;
    }

    fn control(&self, method: &str, params: &Value) -> bool {
        if method == CONTROL {
            return self.capture.control(params);
        }
        self.inner.control(method, params)
    }
}

#[cfg(test)]
#[path = "network_capture_tests.rs"]
mod tests;
