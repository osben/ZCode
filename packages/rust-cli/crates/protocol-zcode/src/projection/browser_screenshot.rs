//! Fork (D2, specs/fork-rust-node-helper.md "D2 end-of-turn screenshot"): the end-of-turn browser screenshot as one
//! completed tool row. Live, the row comes from `KernelEvent::BrowserTurnScreenshot` before the turn's `TurnFinished`.
//! Cold, it comes from the stored entries (`SessionView::browser_screenshots`), placed at the end of the turn their
//! anchor (the turn's user message) opens, as the live order. The display stays on the row's `display` channel, as
//! Node's `toProtocolToolCallDisplay` keeps `node_repl_images` there.
use rust_cli_kernel_api::browser_turn::BrowserScreenshotRecord;
use serde_json::{Value, json};

use super::kinds::{RowKind, ToolStatus};
use super::{Projection, tool_key};

/// The tool name of the row (Node's `mcp__node_repl__js` tool part).
const TOOL_NAME: &str = "mcp__node_repl__js";

impl Projection {
    /// Live: one completed row for the turn's screenshot, appended in the event order.
    pub(super) fn browser_turn_screenshot(
        &mut self,
        turn: &str,
        tool_use: &str,
        display: &Value,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let key = tool_key(tool_use);
        if self.index.contains_key(&key) {
            return;
        }
        let mut row = self.base(turn, tool_use, RowKind::ToolCall, now, seq);
        self.screenshot_row(&mut row, tool_use, display, now);
        self.append(key, row, out);
    }

    /// Cold: the stored screenshots anchored to `anchor` (the user message of the turn being projected), in stored
    /// order. A row already present (a live turn replayed) is not added twice.
    pub(super) fn cold_browser_screenshots(
        &mut self,
        anchor: &str,
        records: &[BrowserScreenshotRecord],
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let Some(turn) = self.turn.as_ref().map(|turn| turn.id.clone()) else {
            return;
        };
        for record in records
            .iter()
            .filter(|record| record.anchor.as_str() == anchor)
        {
            let tool_use = record.tool_use.as_str();
            let key = tool_key(tool_use);
            if self.index.contains_key(&key) {
                continue;
            }
            let mut row = self.base(&turn, tool_use, RowKind::ToolCall, now, seq);
            self.screenshot_row(&mut row, tool_use, &record.display, now);
            self.append(key, row, out);
        }
    }

    fn screenshot_row(
        &self,
        row: &mut serde_json::Map<String, Value>,
        tool_use: &str,
        display: &Value,
        now: u64,
    ) {
        row.insert("toolCallId".into(), json!(tool_use));
        row.insert("toolName".into(), json!(TOOL_NAME));
        row.insert("status".into(), json!(ToolStatus::Success.as_str()));
        row.insert("output".into(), json!({"text": ""}));
        row.insert("display".into(), display.clone());
        row.insert("endedAt".into(), json!(now));
    }
}

#[cfg(test)]
#[path = "browser_screenshot_tests.rs"]
mod tests;
