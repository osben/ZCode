//! Fork: the sampling ledger of a Rust-run server's MCP App panels (specs/fork-rust-node-helper.md, "MCP Apps on
//! Rust-hosted servers (F7)", PR 2). Port of Node `zcode-protocol/mcp-ui/samplingCalls.ts` (the operation ledger and
//! its caps) and of the request limits of `mcpAppsSamplingParamsSchema` (`packages/shared/src/mcp-apps/sampling.ts`).
//!
//! Owner: [`Sampling`] owns the terminal states and the concurrency quota. A lease's ledger lives while the lease's
//! cancel token is live: when the lease ends (close, revoke, session close), its operations are cancelled through the
//! token tree, and its ledger is dropped by the next sweep (or by [`Sampling::forget`]).

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

/// Node `MCP_APPS_SAMPLING_TIMEOUT_MS`: the ledger's absolute deadline per operation. The 65 s transport timeout
/// (`MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS`) belongs to the helper's forwarding, which a Rust-run server has no part in.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(60);
/// Node `MCP_APPS_SAMPLING_MAX_PER_SESSION`.
pub(crate) const MAX_PER_SESSION: usize = 4;
/// Node `MCP_APPS_SAMPLING_MAX_PER_AGENT`.
pub(crate) const MAX_PER_AGENT: usize = 8;
/// Node `MCP_APPS_SAMPLING_MAX_OPERATIONS`: operations (terminal ones included) per lease.
pub(crate) const MAX_OPERATIONS: usize = 4096;

/// Node `MCP_APPS_SAMPLING_MAX_BYTES` and `MCP_APPS_SAMPLING_MAX_BLOCKS`.
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_BLOCKS: usize = 64;
/// JavaScript's `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Node `MCP_APPS_IMAGE_MAX_BYTES` and `MCP_APPS_IMAGE_MIME_TYPES`.
const IMAGE_MAX_BYTES: usize = 4 * 1024 * 1024;
const IMAGE_MIME_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp"];
/// The keys each object of `mcpAppsSamplingParamsSchema` accepts (zod `.strict()`).
const REQUEST_KEYS: &[&str] = &[
    "messages",
    "systemPrompt",
    "maxTokens",
    "includeContext",
    "modelPreferences",
    "metadata",
    "_meta",
];
const MESSAGE_KEYS: &[&str] = &["role", "content"];
const TEXT_KEYS: &[&str] = &["type", "text", "annotations", "_meta"];
const IMAGE_KEYS: &[&str] = &["type", "mimeType", "data", "annotations", "_meta"];

/// The lease a sampling call names: its token, its session, and the cancel token of its lease (Node `scope.signal`).
pub(crate) struct Scope<'a> {
    pub lease: &'a str,
    pub session: &'a str,
    pub cancel: &'a CancellationToken,
}

#[derive(Default)]
struct State {
    /// lease token -> its ledger (Node `instances`).
    ledgers: BTreeMap<String, Ledger>,
    /// session -> operations in flight (Node `sessions`).
    sessions: BTreeMap<String, usize>,
    /// operations in flight of this owner (Node `active`).
    active: usize,
}

struct Ledger {
    /// The lease's cancel: once it fires, the ledger is swept.
    scope: CancellationToken,
    /// operation id -> its cancel while in flight; `None` is a terminal state (Node `null`).
    calls: BTreeMap<String, Option<CancellationToken>>,
}

/// The ledger and its quota (Node `McpUiSamplingCalls`). One per Rust-run server owner, so one per agent process.
#[derive(Default)]
pub(crate) struct Sampling {
    state: Arc<Mutex<State>>,
}

/// One admitted operation. Dropping it releases its quota and keeps its terminal state (Node `finally`).
pub(crate) struct Admission {
    state: Arc<Mutex<State>>,
    lease: String,
    session: String,
    operation: String,
    cancel: CancellationToken,
}

fn cancelled() -> RpcError {
    RpcError::new(-32000, "Sampling cancelled")
}

fn timed_out() -> RpcError {
    RpcError::new(-32000, "Sampling timed out")
}

fn limit_reached() -> RpcError {
    RpcError::new(-32000, "Sampling operation limit reached; reopen the App")
}

/// Node's sweep: a lease that ended (its cancel fired) takes its ledger with it.
fn sweep(ledgers: &mut BTreeMap<String, Ledger>) {
    ledgers.retain(|_, ledger| !ledger.scope.is_cancelled());
}

impl Sampling {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Node `execute`'s admission, synchronous: the scope is live, the operation id is new, the lease has room, and
    /// the session and the agent are under their caps. Admitted operations stay in flight until the admission ends.
    pub(crate) fn admit(&self, scope: &Scope<'_>, operation: &str) -> Result<Admission, RpcError> {
        let mut guard = self.state.lock_unpoisoned();
        let State {
            ledgers,
            sessions,
            active,
        } = &mut *guard;
        sweep(ledgers);
        if scope.cancel.is_cancelled() {
            return Err(cancelled());
        }
        let ledger = ledgers
            .entry(scope.lease.to_owned())
            .or_insert_with(|| Ledger {
                scope: scope.cancel.clone(),
                calls: BTreeMap::new(),
            });
        if ledger.calls.contains_key(operation) {
            return Err(RpcError::invalid_params("Duplicate sampling operationId"));
        }
        if ledger.calls.len() >= MAX_OPERATIONS {
            return Err(limit_reached());
        }
        let session_count = sessions.get(scope.session).copied().unwrap_or(0);
        if *active >= MAX_PER_AGENT
            || session_count >= MAX_PER_SESSION
            || ledger.calls.values().any(Option::is_some)
        {
            return Err(RpcError::new(-32000, "Sampling busy"));
        }
        let cancel = scope.cancel.child_token();
        ledger
            .calls
            .insert(operation.to_owned(), Some(cancel.clone()));
        *active += 1;
        *sessions.entry(scope.session.to_owned()).or_insert(0) += 1;
        Ok(Admission {
            state: Arc::clone(&self.state),
            lease: scope.lease.to_owned(),
            session: scope.session.to_owned(),
            operation: operation.to_owned(),
            cancel,
        })
    }

    /// Node `cancel`: records a terminal state for the operation id and cancels it when it is in flight. Returns
    /// whether an operation was in flight. A cancel that arrives before the operation keeps the id terminal.
    pub(crate) fn cancel(&self, scope: &Scope<'_>, operation: &str) -> Result<bool, RpcError> {
        let in_flight = {
            let mut guard = self.state.lock_unpoisoned();
            let State { ledgers, .. } = &mut *guard;
            sweep(ledgers);
            if scope.cancel.is_cancelled() {
                return Err(cancelled());
            }
            let ledger = ledgers
                .entry(scope.lease.to_owned())
                .or_insert_with(|| Ledger {
                    scope: scope.cancel.clone(),
                    calls: BTreeMap::new(),
                });
            let known = ledger.calls.get(operation).cloned();
            if known.is_none() && ledger.calls.len() >= MAX_OPERATIONS {
                return Err(limit_reached());
            }
            ledger.calls.insert(operation.to_owned(), None);
            known.flatten()
        };
        // The token is cancelled outside the lock: its waiters run on their own tasks.
        match in_flight {
            Some(token) => {
                token.cancel();
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Drops the ledger of a lease that ended (its in-flight operations are cancelled through its cancel token).
    pub(crate) fn forget(&self, lease: &str) {
        self.state.lock_unpoisoned().ledgers.remove(lease);
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        let mut guard = self.state.lock_unpoisoned();
        let State {
            ledgers,
            sessions,
            active,
        } = &mut *guard;
        *active = active.saturating_sub(1);
        if let Some(count) = sessions.get_mut(&self.session) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                sessions.remove(&self.session);
            }
        }
        // Node: the terminal state is kept only while the lease's ledger is still current.
        if let Some(ledger) = ledgers.get_mut(&self.lease)
            && let Some(slot) = ledger.calls.get_mut(&self.operation)
        {
            *slot = None;
        }
    }
}

impl Admission {
    /// Node `execute`'s run: the first of the operation's cancel, its deadline and `run` decides it. `run` gets the
    /// operation's cancel token; a result that lands after the cancel is dropped, not returned.
    pub(crate) async fn run<T, F, Fut>(self, run: F) -> Result<T, RpcError>
    where
        F: FnOnce(CancellationToken) -> Fut,
        Fut: Future<Output = Result<T, RpcError>>,
    {
        let cancel = self.cancel.clone();
        let outcome = tokio::select! {
            biased;
            () = cancel.cancelled() => Err(cancelled()),
            () = tokio::time::sleep(TIMEOUT) => {
                cancel.cancel();
                Err(timed_out())
            }
            result = run(cancel.clone()) => result,
        };
        match outcome {
            Ok(_) if cancel.is_cancelled() => Err(cancelled()),
            other => other,
        }
    }
}

/// Node `mcpAppsSamplingResultSchema`: the kernel's reply names a model and a stop reason, and its text fits the
/// result limit (`z.string().max`, which counts UTF-16 units). A reply that fails it is refused as Node's parse
/// failure is: an internal error.
pub(crate) fn check_reply(
    reply: &rust_cli_kernel_api::sampling::SamplingReply,
) -> Result<(), RpcError> {
    if reply.model.is_empty() || reply.stop_reason.is_empty() || utf16_len(&reply.text) > MAX_BYTES
    {
        return Err(RpcError::internal("Sampling result is invalid"));
    }
    Ok(())
}

/// Node `z.number().int().positive().safe()` for `maxTokens`: a whole, positive number no larger than
/// `Number.MAX_SAFE_INTEGER`. A whole number written with a point counts, as it does in JavaScript.
pub(crate) fn max_tokens(value: &Value) -> Option<u64> {
    let whole = value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= MAX_SAFE_INTEGER as f64)
            .map(|n| n as u64)
    })?;
    (1..=MAX_SAFE_INTEGER).contains(&whole).then_some(whole)
}

/// Node `mcpAppsSamplingParamsSchema` (and its `superRefine` budget) for the `request` of `mcp/uiSampling`, checked
/// before the operation is admitted. The message texts are Rust's own; zod's issue texts are not reproduced.
pub(crate) fn check_request(request: &Value) -> Result<(), RpcError> {
    let object = request
        .as_object()
        .ok_or_else(|| RpcError::invalid_params("request must be an object"))?;
    strict(object, REQUEST_KEYS)?;
    if let Some(context) = object.get("includeContext")
        && context.as_str() != Some("none")
    {
        return Err(RpcError::invalid_params(
            "request.includeContext must be \"none\"",
        ));
    }
    if object.get("maxTokens").and_then(max_tokens).is_none() {
        return Err(RpcError::invalid_params(
            "request.maxTokens must be a positive integer",
        ));
    }
    let mut bytes = 0;
    if let Some(system) = object.get("systemPrompt") {
        let text = system
            .as_str()
            .ok_or_else(|| RpcError::invalid_params("request.systemPrompt must be a string"))?;
        check_text(text)?;
        bytes += text.len();
    }
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .filter(|messages| (1..=MAX_BLOCKS).contains(&messages.len()))
        .ok_or_else(|| RpcError::invalid_params("request.messages holds 1 to 64 messages"))?;
    let mut blocks: Vec<&Map<String, Value>> = Vec::new();
    for message in messages {
        let message = message
            .as_object()
            .ok_or_else(|| RpcError::invalid_params("a message is an object"))?;
        strict(message, MESSAGE_KEYS)?;
        match message.get("role").and_then(Value::as_str) {
            Some("user" | "assistant") => {}
            _ => {
                return Err(RpcError::invalid_params(
                    "a message role is user or assistant",
                ));
            }
        }
        let content: Vec<&Value> = match message.get("content") {
            Some(Value::Array(items)) if (1..=MAX_BLOCKS).contains(&items.len()) => {
                items.iter().collect()
            }
            Some(Value::Array(_)) => {
                return Err(RpcError::invalid_params(
                    "a message content holds 1 to 64 blocks",
                ));
            }
            Some(single @ Value::Object(_)) => vec![single],
            _ => return Err(RpcError::invalid_params("a message has content")),
        };
        for block in content {
            let object = block
                .as_object()
                .ok_or_else(|| RpcError::invalid_params("a block is an object"))?;
            bytes += block_bytes(object)?;
            blocks.push(object);
        }
    }
    if blocks.len() > MAX_BLOCKS {
        return Err(over_limits());
    }
    // Node counts the metadata toward the budget too, serialised as JSON.stringify does (absent keys are left out).
    let metadata = metadata_json(object, &blocks);
    bytes += serde_json::to_string(&metadata).map_or(0, |text| text.len());
    if bytes > MAX_BYTES {
        return Err(over_limits());
    }
    Ok(())
}

fn over_limits() -> RpcError {
    RpcError::invalid_params("Sampling content exceeds host limits")
}

/// The bytes a block counts toward the budget: UTF-8 bytes of text, decoded bytes of an image.
fn block_bytes(block: &Map<String, Value>) -> Result<usize, RpcError> {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => {
            strict(block, TEXT_KEYS)?;
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::invalid_params("a text block has text"))?;
            check_text(text)?;
            Ok(text.len())
        }
        Some("image") => {
            strict(block, IMAGE_KEYS)?;
            let mime = block.get("mimeType").and_then(Value::as_str);
            if !mime.is_some_and(|mime| IMAGE_MIME_TYPES.contains(&mime)) {
                return Err(RpcError::invalid_params(
                    "an image block is a png, jpeg or webp image",
                ));
            }
            let data = block
                .get("data")
                .and_then(Value::as_str)
                .filter(|data| !data.is_empty())
                .ok_or_else(|| RpcError::invalid_params("an image block has data"))?;
            // The schema's length bound, then a flat character check (linear, unlike a repeated group regex).
            let max_units = IMAGE_MAX_BYTES.div_ceil(3) * 4;
            if utf16_len(data) > max_units || data.len() % 4 != 0 || !is_base64(data) {
                return Err(RpcError::invalid_params("an image block has base64 data"));
            }
            let decoded = decoded_len(data);
            if decoded > IMAGE_MAX_BYTES {
                return Err(RpcError::invalid_params(
                    "an image block exceeds the image size limit",
                ));
            }
            Ok(decoded)
        }
        _ => Err(RpcError::invalid_params("a block is text or image")),
    }
}

fn check_text(text: &str) -> Result<(), RpcError> {
    if utf16_len(text) > MAX_BYTES {
        return Err(RpcError::invalid_params(
            "a sampling text exceeds the size limit",
        ));
    }
    Ok(())
}

/// Node `z.string().max()` counts UTF-16 code units.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Node `^[A-Za-z0-9+/]*={0,2}$`.
fn is_base64(data: &str) -> bool {
    let body = data.trim_end_matches('=');
    data.len() - body.len() <= 2
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

/// Node `decodedBytes`.
fn decoded_len(data: &str) -> usize {
    let padding = if data.ends_with("==") {
        2
    } else if data.ends_with('=') {
        1
    } else {
        0
    };
    (data.len() * 3 / 4).saturating_sub(padding)
}

/// Node's budget metadata: `{metadata, _meta, blockMetadata: [{_meta, annotations}]}`, absent members left out.
fn metadata_json(request: &Map<String, Value>, blocks: &[&Map<String, Value>]) -> Value {
    let mut out = Map::new();
    for key in ["metadata", "_meta"] {
        if let Some(value) = request.get(key) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    let block_meta = blocks
        .iter()
        .map(|block| {
            let mut entry = Map::new();
            for key in ["_meta", "annotations"] {
                if let Some(value) = block.get(key) {
                    entry.insert(key.to_owned(), value.clone());
                }
            }
            Value::Object(entry)
        })
        .collect();
    out.insert("blockMetadata".to_owned(), Value::Array(block_meta));
    Value::Object(out)
}

/// zod `.strict()`: a key outside the schema is refused.
fn strict(object: &Map<String, Value>, allowed: &[&str]) -> Result<(), RpcError> {
    match object.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(key) => Err(RpcError::invalid_params(format!(
            "unrecognized field {key} in a sampling request"
        ))),
        None => Ok(()),
    }
}

#[cfg(test)]
#[path = "mcp_ui_sampling_tests.rs"]
mod tests;
