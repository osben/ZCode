//! Fork (specs/fork-rust-node-helper.md, "D2 end-of-turn screenshot"): the end-of-turn browser screenshot's shared
//! pieces. The candidate registry is written by the MCP tool result of a helper-hosted node_repl call and consumed
//! once by the session's turn end; the port captures the active tab through the helper.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::ids::{MessageId, ToolUseId};

/// The `state.input.source` of the end-of-turn screenshot part (Node `BROWSER_TURN_SCREENSHOT_SOURCE`).
pub const TURN_SCREENSHOT_SOURCE: &str = "browser_turn_end";
/// The `_meta` key a node_repl result carries for the candidate (Node `zcode/browserTurnScreenshot`).
pub const TURN_SCREENSHOT_META_KEY: &str = "zcode/browserTurnScreenshot";
/// The fork entry kind that stores one captured screenshot (`session_entry` type `rust-cli/<kind>`). Node reads
/// `session_entry` by type and never selects this one, so Node ignores it; older fork builds ignore it too.
pub const TURN_SCREENSHOT_ENTRY_KIND: &str = "fork_browser_turn_screenshot";
/// Node's display budget for one node_repl image, in base64 bytes (`MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES`).
pub const TURN_SCREENSHOT_MAX_BASE64_BYTES: usize = 200 * 1024;
/// Node's host dimension limit for a node_repl image (`HOST_NODE_REPL_IMAGE_MAX_DIMENSION`).
pub const TURN_SCREENSHOT_MAX_DIMENSION: u32 = 2048;

/// The browser a turn's node_repl calls used (Node `BrowserTurnScreenshotCandidate`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserCandidate {
    pub browser_id: String,
    pub browser_generation: i64,
}

/// Node's guard in `recordBrowserTurnToolResult`: the candidate needs a string `browserId` and an integer
/// `browserGeneration`; anything else records nothing.
pub fn candidate_from_meta(meta: Option<&Value>) -> Option<BrowserCandidate> {
    let candidate = meta?.get(TURN_SCREENSHOT_META_KEY)?;
    let browser_id = candidate.get("browserId")?.as_str()?.to_owned();
    let browser_generation = candidate.get("browserGeneration")?.as_i64()?;
    Some(BrowserCandidate {
        browser_id,
        browser_generation,
    })
}

type Key = (String, String);

/// The candidates of running turns, keyed by (session, turn). One writer (the MCP tool result of a helper-hosted call)
/// and one consumer ([`take`], called once by the session's turn end).
static CANDIDATES: Mutex<BTreeMap<Key, BrowserCandidate>> = Mutex::new(BTreeMap::new());

fn candidates() -> std::sync::MutexGuard<'static, BTreeMap<Key, BrowserCandidate>> {
    CANDIDATES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Records the candidate of a turn's node_repl call (the latest call wins, as Node's `readState(...).candidate =`).
pub fn record(session: &str, turn: &str, candidate: BrowserCandidate) {
    candidates().insert((session.to_owned(), turn.to_owned()), candidate);
}

/// Removes and returns the candidate of a turn. Called once per turn, by its turn end, whatever the outcome.
pub fn take(session: &str, turn: &str) -> Option<BrowserCandidate> {
    candidates().remove(&(session.to_owned(), turn.to_owned()))
}

/// The candidates still held for a session.
pub fn pending(session: &str) -> usize {
    candidates()
        .keys()
        .filter(|(owner, _)| owner == session)
        .count()
}

/// Drops every candidate of a session (its close).
pub fn forget_session(session: &str) {
    candidates().retain(|(owner, _), _| owner != session);
}

/// One stored screenshot: the entry's data (`fork_browser_turn_screenshot`) and its view. `anchor` is the turn's user
/// message, and `display` the `node_repl_images` display.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserScreenshotRecord {
    pub anchor: MessageId,
    pub tool_use: ToolUseId,
    pub display: Value,
}

/// A captured screenshot, already within Node's display budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedScreenshot {
    pub base64: String,
    pub mime_type: String,
}

/// The helper-side capture of a turn's active tab (`helper/browser/turnScreenshot`, D2-H). `None` means Node's
/// skip or swallowed failure: no row, and the turn is unchanged. Implemented by the protocol server, which owns the
/// helper; bound per session by the server that opened it.
#[async_trait]
pub trait TurnScreenshotPort: Send + Sync {
    async fn capture(
        &self,
        session: &str,
        turn: &str,
        candidate: &BrowserCandidate,
        cancel: CancellationToken,
    ) -> Option<CapturedScreenshot>;
}

/// The bound capture ports by session, each with the generation of its binding. A binding is removed only by the
/// generation that made it, so an older owner closing cannot take away a newer owner's port for the same session.
/// A session's binding: its generation and its port.
type PortBinding = (u64, Arc<dyn TurnScreenshotPort>);

static PORTS: Mutex<BTreeMap<String, PortBinding>> = Mutex::new(BTreeMap::new());
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

fn ports() -> std::sync::MutexGuard<'static, BTreeMap<String, PortBinding>> {
    PORTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Binds the capture port of a session (its live projection's server). The returned generation is the one
/// [`unbind`] needs; a newer bind of the same session replaces the port.
pub fn bind(session: &str, port: Arc<dyn TurnScreenshotPort>) -> u64 {
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    ports().insert(session.to_owned(), (generation, port));
    generation
}

/// Unbinds a session's port only if `generation` is still the current binding (compare-and-remove).
pub fn unbind(session: &str, generation: u64) {
    let mut ports = ports();
    if ports
        .get(session)
        .is_some_and(|(current, _)| *current == generation)
    {
        ports.remove(session);
    }
}

/// The capture port of a session, if its server bound one.
pub fn port_for(session: &str) -> Option<Arc<dyn TurnScreenshotPort>> {
    ports().get(session).map(|(_, port)| port.clone())
}

/// The `node_repl_images` display of a screenshot (Node `createBrowserTurnScreenshotDisplay`).
pub fn display(shot: &CapturedScreenshot) -> Value {
    serde_json::json!({
        "kind": "node_repl_images",
        "images": [{"base64": shot.base64, "mimeType": shot.mime_type}],
        "source": TURN_SCREENSHOT_SOURCE,
    })
}

/// Whether an image fits Node's display budget.
pub fn fits_display(base64: &str) -> bool {
    base64.len() <= TURN_SCREENSHOT_MAX_BASE64_BYTES
}

#[cfg(test)]
#[path = "browser_turn_tests.rs"]
mod tests;
