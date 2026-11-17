//! Wire form of `v4/conversation/contextComposition` (Node `context-composition/contract.ts`, `handler.ts`).

use rust_cli_kernel_api::context_composition::{
    CompositionAnswer, CompositionChange, CompositionPhase, CompositionRecord, ProviderUsage,
    WireCategory, WireItem,
};
use rust_cli_kernel_api::ids::SessionId;
use serde_json::json;

use super::{changed_params, coalesce, wire};

fn answer(
    phase: CompositionPhase,
    usage: Option<ProviderUsage>,
    context_window: Option<u64>,
) -> CompositionAnswer {
    CompositionAnswer {
        revision: 3,
        phase,
        record: CompositionRecord {
            provider_id: "provider".to_owned(),
            model_id: "model".to_owned(),
            measured_at_ms: 42,
            estimated_tokens: 100,
            categories: vec![WireCategory {
                id: "messages",
                tokens: 100,
                chars: 300,
                items: Some(vec![WireItem {
                    name: "user".to_owned(),
                    tokens: 100,
                }]),
            }],
            provider_usage: usage,
        },
        context_window,
    }
}

/// A measured request carries the provider's input and context tokens, and the free space of the window.
#[test]
fn a_request_phase_carries_the_provider_tokens_and_the_free_space() {
    let usage = ProviderUsage {
        input_tokens: 120,
        context_tokens: 150,
    };
    let value = wire(
        "sess_1",
        Some(&answer(CompositionPhase::Request, Some(usage), Some(1000))),
    );
    let composition = &value["composition"];
    assert_eq!(composition["sessionId"], "sess_1");
    assert_eq!(composition["revision"], 3);
    assert_eq!(composition["phase"], "request");
    assert_eq!(composition["measuredAt"], 42);
    assert_eq!(
        composition["model"],
        json!({"providerId": "provider", "modelId": "model", "contextWindow": 1000})
    );
    assert_eq!(composition["tokenMethod"], "estimated");
    assert_eq!(composition["estimatedTokens"], 100);
    assert_eq!(composition["freeTokens"], 900);
    assert_eq!(composition["providerInputTokens"], 120);
    assert_eq!(composition["providerContextTokens"], 150);
    assert_eq!(
        composition["categories"],
        json!([{"id": "messages", "tokens": 100, "chars": 300, "items": [{"name": "user", "tokens": 100}]}])
    );
}

/// A draft preview has no provider tokens; an unknown window answers `freeTokens: null` and `contextWindow: null`.
#[test]
fn a_draft_preview_has_no_provider_tokens_and_no_known_window() {
    let value = wire(
        "sess_1",
        Some(&answer(CompositionPhase::DraftPreview, None, None)),
    );
    let composition = &value["composition"];
    assert_eq!(composition["phase"], "draft-preview");
    assert_eq!(composition["model"]["contextWindow"], json!(null));
    assert_eq!(composition["freeTokens"], json!(null));
    assert!(composition.get("providerInputTokens").is_none());
    assert!(composition.get("providerContextTokens").is_none());
}

/// Free space never goes negative, and a category without items has no `items` key.
#[test]
fn free_space_is_floored_at_zero_and_empty_items_are_absent() {
    let mut measured = answer(CompositionPhase::DraftPreview, None, Some(50));
    measured.record.categories[0].items = None;
    let value = wire("sess_1", Some(&measured));
    assert_eq!(value["composition"]["freeTokens"], 0);
    assert!(value["composition"]["categories"][0].get("items").is_none());
}

/// An unknown session answers `composition: null` (existing-only: nothing is opened or restored).
#[test]
fn an_unknown_session_answers_null() {
    assert_eq!(wire("sess_1", None), json!({"composition": null}));
}

fn change(session: &str, revision: u64) -> CompositionChange {
    CompositionChange {
        session: SessionId::new(session),
        revision,
    }
}

/// Node `tracker.ts`: one notification per session per batch, carrying the latest revision, in first-seen order.
#[test]
fn a_batch_coalesces_to_one_change_per_session_with_the_latest_revision() {
    let batch = [
        change("a", 1),
        change("a", 2),
        change("b", 1),
        change("a", 3),
    ];
    assert_eq!(coalesce(&batch), vec![change("a", 3), change("b", 1)]);
    assert_eq!(coalesce(&[]), Vec::new());
}

/// The notification body is `{sessionId, revision}` (the App re-reads the composition for that revision).
#[test]
fn the_changed_notification_carries_the_session_and_revision() {
    assert_eq!(
        changed_params(&change("a", 4)),
        json!({"sessionId": "a", "revision": 4})
    );
}
