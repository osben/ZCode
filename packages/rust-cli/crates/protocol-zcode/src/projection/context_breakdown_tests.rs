//! Fork (specs/fork-rust-context-breakdown.md): `usage.contextWindow.cache`, `.breakdown` and
//! `.microcompactThresholdTokens`.

use rust_cli_kernel_api::message::Usage;
use rust_cli_kernel_api::metering::{CallStatus, ContextBreakdownItem, ModelCall};
use rust_cli_kernel_api::model::QuerySource;

use super::*;

fn event(seq: u64, event: KernelEvent) -> SequencedEvent {
    SequencedEvent {
        seq,
        event,
        revision: seq,
    }
}

fn usage(input: u64, output: u64, cache_write: u64, cache_read: u64) -> Usage {
    Usage {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cache_write,
        cache_read_input_tokens: cache_read,
    }
}

fn call(source: QuerySource, usage: Option<Usage>, breakdown: &[(&str, u64)]) -> ModelCall {
    ModelCall {
        usage,
        context_breakdown: breakdown
            .iter()
            .map(|(source, chars)| ContextBreakdownItem {
                source: (*source).to_owned(),
                chars: *chars,
            })
            .collect(),
        ..ModelCall::new(
            MessageId::new("m"),
            source,
            selection(),
            1,
            2,
            CallStatus::Completed,
        )
    }
}

fn completed(call: ModelCall) -> KernelEvent {
    KernelEvent::ModelRequestCompleted {
        call: Box::new(call),
    }
}

fn context_usage() -> KernelEvent {
    KernelEvent::ContextUsage {
        used_tokens: 5,
        max_tokens: 10,
        compact_at: Some(8),
        window_tokens: Some(12),
    }
}

fn projection() -> Projection {
    let mut projection = Projection::from_view(&view(Vec::new()), Followup::Queue, Vec::new());
    projection.apply(&event(1, context_usage()), 0);
    projection
}

fn window(projection: &Projection) -> Value {
    projection.snapshot(9, "e")["usage"]["contextWindow"].clone()
}

#[test]
fn microcompact_is_null_because_rust_does_not_microcompact() {
    let mut projection = Projection::from_view(&view(Vec::new()), Followup::Queue, Vec::new());
    let deltas = projection.apply(&event(1, context_usage()), 0);
    let patched = &deltas[0]["patch"]["usage"]["contextWindow"];
    // Present and null: the UI reads an absent field as unknown and estimates a warning tone.
    assert!(patched.get("microcompactThresholdTokens").is_some());
    assert!(patched["microcompactThresholdTokens"].is_null());
    assert!(window(&projection)["microcompactThresholdTokens"].is_null());
    // No threshold (auto-compact off) is the same.
    projection.apply(
        &event(
            2,
            KernelEvent::ContextUsage {
                used_tokens: 5,
                max_tokens: 10,
                compact_at: None,
                window_tokens: Some(12),
            },
        ),
        0,
    );
    assert!(
        window(&projection)
            .get("microcompactThresholdTokens")
            .is_some()
    );
}

#[test]
fn a_main_request_publishes_cache_and_breakdown() {
    let mut projection = projection();
    let deltas = projection.apply(
        &event(
            2,
            completed(call(
                QuerySource::MainThread,
                Some(usage(100, 10, 20, 30)),
                &[("system_prompt", 40), ("messages", 60)],
            )),
        ),
        0,
    );
    let patched = &deltas[0]["patch"]["usage"]["contextWindow"];
    assert_eq!(
        patched["cache"],
        json!({
            "inputTokens": 150,
            "cacheReadTokens": 30,
            "cacheWriteTokens": 20,
            "latestHitRate": 0.2,
            "hitRate": 0.2,
            "hitRateRequestCount": 1,
            "totalInputTokens": 150,
            "totalCacheReadTokens": 30,
            "totalCacheWriteTokens": 20,
        })
    );
    assert_eq!(
        patched["breakdown"],
        json!([
            {"source": "system_prompt", "chars": 40},
            {"source": "messages", "chars": 60},
        ])
    );
    // The snapshot carries the same values.
    assert_eq!(patched["cache"], window(&projection)["cache"]);
}

#[test]
fn the_totals_add_up_across_requests() {
    let mut projection = projection();
    projection.apply(
        &event(
            2,
            completed(call(
                QuerySource::MainThread,
                Some(usage(100, 0, 0, 50)),
                &[],
            )),
        ),
        0,
    );
    projection.apply(
        &event(
            3,
            completed(call(QuerySource::MainThread, Some(usage(50, 0, 0, 0)), &[])),
        ),
        0,
    );
    let cache = &window(&projection)["cache"];
    assert_eq!(cache["inputTokens"], 50);
    assert_eq!(cache["latestHitRate"], 0.0);
    assert_eq!(cache["totalInputTokens"], 200);
    assert_eq!(cache["totalCacheReadTokens"], 50);
    assert_eq!(cache["hitRate"], 0.25);
    assert_eq!(cache["hitRateRequestCount"], 2);
}

#[test]
fn only_a_completed_main_request_counts() {
    let mut projection = projection();
    let mut failed = call(
        QuerySource::MainThread,
        Some(usage(10, 1, 0, 0)),
        &[("messages", 5)],
    );
    failed.status = CallStatus::Error;
    for (seq, call) in [
        call(
            QuerySource::Subagent("a".into()),
            Some(usage(10, 1, 0, 0)),
            &[("messages", 5)],
        ),
        call(QuerySource::Compact, Some(usage(10, 1, 0, 0)), &[]),
        failed,
    ]
    .into_iter()
    .enumerate()
    {
        let deltas = projection.apply(&event(2 + seq as u64, completed(call)), 0);
        assert!(
            deltas
                .iter()
                .all(|delta| delta["patch"].get("usage").is_none())
        );
    }
    let found = window(&projection);
    assert!(found.get("cache").is_none());
    assert!(found.get("breakdown").is_none());
}

/// Node leaves `cache` out of a main completion with no counted usage, so it replaces the earlier one.
#[test]
fn a_main_request_without_counted_usage_drops_the_cache() {
    let mut projection = projection();
    projection.apply(
        &event(
            2,
            completed(call(QuerySource::MainThread, Some(usage(10, 1, 0, 0)), &[])),
        ),
        0,
    );
    assert!(window(&projection).get("cache").is_some());
    for (seq, usage) in [None, Some(usage(0, 7, 0, 0))].into_iter().enumerate() {
        projection.apply(
            &event(
                3 + seq as u64,
                completed(call(QuerySource::MainThread, usage, &[])),
            ),
            0,
        );
        assert!(window(&projection).get("cache").is_none());
    }
}

#[test]
fn an_empty_breakdown_is_not_published_and_a_later_request_replaces_it() {
    let mut projection = projection();
    projection.apply(
        &event(
            2,
            completed(call(
                QuerySource::MainThread,
                Some(usage(10, 1, 0, 0)),
                &[("messages", 5)],
            )),
        ),
        0,
    );
    assert_eq!(
        window(&projection)["breakdown"],
        json!([{"source": "messages", "chars": 5}])
    );
    projection.apply(
        &event(
            3,
            completed(call(QuerySource::MainThread, Some(usage(10, 1, 0, 0)), &[])),
        ),
        0,
    );
    assert!(window(&projection).get("breakdown").is_none());
}

#[test]
fn a_context_usage_update_keeps_them_and_a_compaction_drops_them() {
    let mut projection = projection();
    projection.apply(
        &event(
            2,
            completed(call(
                QuerySource::MainThread,
                Some(usage(10, 1, 0, 0)),
                &[("messages", 5)],
            )),
        ),
        0,
    );
    projection.apply(&event(3, context_usage()), 0);
    assert!(window(&projection).get("cache").is_some());
    let deltas = projection.apply(
        &event(
            4,
            KernelEvent::CompactDone {
                boundary: MessageId::new("b"),
            },
        ),
        0,
    );
    assert!(
        deltas
            .iter()
            .any(|delta| delta["patch"].get("usage").is_some())
    );
    let found = window(&projection);
    assert!(found.get("cache").is_none());
    assert!(found.get("breakdown").is_none());
    projection.apply(&event(5, context_usage()), 0);
    assert!(window(&projection).get("cache").is_none());
    // The totals survive: the next request continues them.
    projection.apply(
        &event(
            6,
            completed(call(QuerySource::MainThread, Some(usage(10, 1, 0, 0)), &[])),
        ),
        0,
    );
    assert_eq!(window(&projection)["cache"]["hitRateRequestCount"], 2);
}

#[test]
fn no_context_window_means_no_cache_or_breakdown() {
    let mut projection = Projection::from_view(&view(Vec::new()), Followup::Queue, Vec::new());
    projection.apply(
        &event(
            1,
            completed(call(
                QuerySource::MainThread,
                Some(usage(10, 1, 0, 0)),
                &[("messages", 5)],
            )),
        ),
        0,
    );
    assert!(projection.snapshot(2, "e")["usage"]["contextWindow"].is_null());
}

fn assistant_with(id: &str, usage: Option<Usage>) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: Vec::new(),
        model: "m".into(),
        stop_reason: None,
        usage,
    })
}

/// Rule 6: a rebuilt projection continues the history's totals.
#[test]
fn a_rebuilt_projection_seeds_its_totals_from_the_history() {
    let history = vec![
        user("u1", "hi"),
        assistant_with("a1", Some(usage(100, 5, 0, 50))),
        assistant_with("a2", Some(usage(0, 5, 0, 0))),
        assistant_with("a3", None),
    ];
    let mut view = view(history);
    view.context_usage = Some(rust_cli_kernel_api::compaction::ContextOccupancy {
        used_tokens: 5,
        max_tokens: 10,
        compact_at: Some(8),
        window_tokens: Some(12),
    });
    let mut projection = Projection::from_view(&view, Followup::Queue, Vec::new());
    // The seed alone publishes nothing.
    assert!(window(&projection).get("cache").is_none());
    projection.apply(
        &event(
            1,
            completed(call(QuerySource::MainThread, Some(usage(50, 0, 0, 0)), &[])),
        ),
        0,
    );
    let cache = &window(&projection)["cache"];
    assert_eq!(cache["hitRateRequestCount"], 2);
    assert_eq!(cache["totalInputTokens"], 200);
    assert_eq!(cache["totalCacheReadTokens"], 50);
}

fn boundary(id: &str, head: &str, anchor: &str, tail: &str) -> Message {
    use rust_cli_kernel_api::message::{
        CompactBoundary, CompactTrigger, PreservedSegment, SystemMessage,
    };
    Message::System(SystemMessage::CompactBoundary(CompactBoundary {
        id: MessageId::new(id),
        trigger: CompactTrigger::Manual,
        pre_tokens: 100,
        summary: MessageId::new("s"),
        preserved: Some(PreservedSegment {
            head: MessageId::new(head),
            anchor: MessageId::new(anchor),
            tail: MessageId::new(tail),
        }),
        discovered_tools: Vec::new(),
    }))
}

/// The next request after a seed: the published request count and input total.
fn seeded_totals(view: &rust_cli_kernel_api::session_api::SessionView) -> (Value, Value) {
    let mut view = view.clone();
    view.context_usage = Some(rust_cli_kernel_api::compaction::ContextOccupancy {
        used_tokens: 5,
        max_tokens: 10,
        compact_at: Some(8),
        window_tokens: Some(12),
    });
    let mut projection = Projection::from_view(&view, Followup::Queue, Vec::new());
    projection.apply(
        &event(
            1,
            completed(call(QuerySource::MainThread, Some(usage(50, 0, 0, 0)), &[])),
        ),
        0,
    );
    let cache = window(&projection)["cache"].clone();
    (
        cache["hitRateRequestCount"].clone(),
        cache["totalInputTokens"].clone(),
    )
}

/// Rule 6 (Node `mainTurnCacheHitAggregateFromMessages`): a preserved request counts with its original usage, which
/// the active view of a live session cleared.
#[test]
fn a_live_seed_counts_a_preserved_request_with_its_original_usage() {
    let history = vec![
        user("u1", "hi"),
        assistant_with("a1", Some(usage(100, 5, 0, 50))),
        boundary("b", "u1", "s", "a1"),
        user("s", "summary"),
        user("u2", "next"),
    ];
    assert_eq!(seeded_totals(&view(history)), (json!(2), json!(200)));
}

/// Rule 6: after a cold open the preserved copy carries no usage; the store hands the original separately.
#[test]
fn a_cold_seed_reads_the_preserved_usage_from_the_store() {
    let history = vec![
        boundary("b", "u1", "s", "a1"),
        user("s", "summary"),
        user("u1", "hi"),
        assistant_with("a1", Some(usage(0, 0, 0, 0))),
        user("u2", "next"),
    ];
    let mut view = view(history);
    view.preserved_usage = vec![(MessageId::new("a1"), usage(100, 5, 0, 50))];
    assert_eq!(seeded_totals(&view), (json!(2), json!(200)));
}
