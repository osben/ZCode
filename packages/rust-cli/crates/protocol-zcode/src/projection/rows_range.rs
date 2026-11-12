//! Fork: `v4/conversation/rowsRange`, like Node's `ConversationTopicPublisher.getRowsRange` (bootstrap
//! `zcode-protocol-v4/conversation-topic-publisher.ts`; specs/fork-rust-agent-parity.md). The snapshot only carries
//! the last [`super::WINDOW_ROWS`] rows; the App pages older history through this cursor read. The projection keeps
//! every row, so a page is a slice of the same rows the topic streams.

use serde_json::{Map, Value, json};

use super::Projection;

/// Node's `PROTOCOL_V4_LIMITS.rowsRangeMaxLimit`.
pub const MAX_LIMIT: usize = 200;

impl Projection {
    /// The last `limit` rows with `rowId < before` (all rows when `before` is absent), ascending, and whether older
    /// rows remain.
    pub fn rows_range(&self, before: Option<u64>, limit: usize) -> (Vec<Value>, bool) {
        let limit = limit.clamp(1, MAX_LIMIT);
        let eligible: Vec<&Map<String, Value>> = self
            .rows
            .iter()
            .filter(|row| {
                before.is_none_or(|before| row["rowId"].as_u64().is_some_and(|id| id < before))
            })
            .collect();
        let start = eligible.len().saturating_sub(limit);
        let rows = eligible[start..]
            .iter()
            .map(|row| Value::Object((*row).clone()))
            .collect();
        (rows, start > 0)
    }
}

/// The wire result: rows plus the topic position they were read at.
pub fn result(rows: Vec<Value>, has_more: bool, seq: u64, revision: u64, epoch: &str) -> Value {
    json!({
        "rows": rows,
        "atSeq": seq,
        "atRevision": revision,
        "atLogEpoch": epoch,
        "hasMore": has_more,
    })
}

#[cfg(test)]
#[path = "rows_range_tests.rs"]
mod tests;
