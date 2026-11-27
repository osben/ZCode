//! Fork (specs/fork-rust-context-breakdown.md): the per-request facts of `usage.contextWindow` that Node projects from
//! each main-turn `ModelComplete`: `cache` (`recordMainTurnCacheHitUsage`) and `breakdown`
//! (`contextUsageBreakdown`). The owner is the projection; the kernel keeps no copy.

use rust_cli_kernel_api::history;
use rust_cli_kernel_api::message::{Message, Usage};
use rust_cli_kernel_api::metering::{CallStatus, ModelCall};
use rust_cli_kernel_api::model::QuerySource;
use serde_json::{Value, json};

/// Node `mainTurnCacheHitAggregate`: the totals over the session's main-thread requests.
#[derive(Debug, Clone, Copy, Default)]
struct Totals {
    requests: u64,
    input: u64,
    read: u64,
    write: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ContextFacts {
    totals: Totals,
    cache: Option<Value>,
    breakdown: Option<Value>,
}

/// The request's total input as Node counts it (provider-normalized, cache reads and writes included), with its cache
/// read and write. `None` when all three are 0: Node skips such a request.
fn request_counts(usage: &Usage) -> Option<(u64, u64, u64)> {
    let input =
        usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
    let (read, write) = (
        usage.cache_read_input_tokens,
        usage.cache_creation_input_tokens,
    );
    (input > 0 || read > 0 || write > 0).then_some((input, read, write))
}

fn rate(part: u64, whole: u64) -> Value {
    if whole == 0 {
        Value::Null
    } else {
        json!(part as f64 / whole as f64)
    }
}

impl ContextFacts {
    /// Node `mainTurnCacheHitAggregateFromMessages`: the totals continue the active history's assistant requests. Nothing
    /// is published until a request completes, as in Node.
    pub fn seeded(messages: &[Message]) -> Self {
        let mut totals = Totals::default();
        for message in history::active(messages) {
            let Message::Assistant(assistant) = message.as_ref() else {
                continue;
            };
            if let Some((input, read, write)) = assistant.usage.as_ref().and_then(request_counts) {
                totals.requests += 1;
                totals.input += input;
                totals.read += read;
                totals.write += write;
            }
        }
        Self {
            totals,
            ..Self::default()
        }
    }

    /// A completed main-thread request replaces both facts (Node's `ModelComplete` carries them or leaves them out).
    /// Returns whether anything published changed.
    pub fn request_completed(&mut self, call: &ModelCall) -> bool {
        // Node projects a `ModelComplete` of the main turn only, and a failed or cancelled request has none.
        if call.source != QuerySource::MainThread || call.status != CallStatus::Completed {
            return false;
        }
        let counts = call.usage.as_ref().and_then(request_counts);
        let cache = counts.map(|(input, read, write)| {
            self.totals.requests += 1;
            self.totals.input += input;
            self.totals.read += read;
            self.totals.write += write;
            let totals = self.totals;
            json!({
                "inputTokens": input,
                "cacheReadTokens": read,
                "cacheWriteTokens": write,
                "latestHitRate": rate(read, input),
                "hitRate": rate(totals.read, totals.input),
                "hitRateRequestCount": totals.requests,
                "totalInputTokens": totals.input,
                "totalCacheReadTokens": totals.read,
                "totalCacheWriteTokens": totals.write,
            })
        });
        let breakdown = (!call.context_breakdown.is_empty()).then(|| {
            Value::Array(
                call.context_breakdown
                    .iter()
                    .map(|item| json!({"source": item.source, "chars": item.chars}))
                    .collect(),
            )
        });
        let changed = cache != self.cache || breakdown != self.breakdown;
        self.cache = cache;
        self.breakdown = breakdown;
        changed
    }

    /// A compaction rebuilds the window without them (Node `onCompactCompleted`); the totals stay.
    pub fn compacted(&mut self) -> bool {
        let had = self.cache.is_some() || self.breakdown.is_some();
        self.cache = None;
        self.breakdown = None;
        had
    }

    pub fn cache(&self) -> Option<&Value> {
        self.cache.as_ref()
    }

    pub fn breakdown(&self) -> Option<&Value> {
        self.breakdown.as_ref()
    }
}
