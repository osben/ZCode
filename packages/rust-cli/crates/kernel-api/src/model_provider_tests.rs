//! Fork: the provider context a turn adds to a provider business failure (Node `providerId` and `modelId` of the
//! error context, filled from the request's selection).

use super::{ModelError, ProviderFailure};

fn failure() -> ModelError {
    ModelError::Provider {
        provider: Box::new(ProviderFailure {
            code: "1113".into(),
            status: Some(429),
            retryable: false,
            reason: "unknown".into(),
            error_phase: "prepare".into(),
            transport: "sse".into(),
            provider_kind: "anthropic".into(),
            provider_id: None,
            model_id: None,
        }),
        error: Box::new(ModelError::QuotaExhausted {
            message: "quota".into(),
        }),
    }
}

#[test]
fn with_model_names_the_provider_and_model_of_the_selection() {
    let filled = failure().with_model("account:zai-individual-coding-plan", "glm-5");
    let provider = filled.provider().expect("still a provider failure");
    assert_eq!(
        provider.provider_id.as_deref(),
        Some("account:zai-individual-coding-plan")
    );
    assert_eq!(provider.model_id.as_deref(), Some("glm-5"));
    assert_eq!(provider.code, "1113");
    assert!(matches!(filled.peel(), ModelError::QuotaExhausted { .. }));
}

#[test]
fn the_accessors_see_through_the_wrapper() {
    let wrapped = ModelError::Provider {
        provider: Box::new(ProviderFailure::new(
            "1261",
            Some(400),
            false,
            "context_exceeded",
            "anthropic",
        )),
        error: Box::new(ModelError::PromptTooLong {
            message: "too long".into(),
        }),
    };
    // Reactive compaction reads the prompt-too-long text through the wrapper (a zhipu 1261 arrives this way).
    assert_eq!(wrapped.prompt_too_long_message(), Some("too long"));
    assert!(matches!(wrapped.peel(), ModelError::PromptTooLong { .. }));
    assert_eq!(
        wrapped.provider().map(|provider| provider.code.as_str()),
        Some("1261")
    );
    // A wrapped attachment-budget error keeps its Node code (`code()` delegates through the wrapper).
    let budget = ModelError::Provider {
        provider: Box::new(ProviderFailure::new(
            "1113",
            Some(429),
            false,
            "unknown",
            "anthropic",
        )),
        error: Box::new(ModelError::CurrentAttachmentsTooLarge),
    };
    assert_eq!(
        budget.code(),
        Some(super::MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE)
    );
}

#[test]
fn a_plain_error_has_no_provider_and_no_wrapper_to_peel() {
    let plain = ModelError::Network {
        message: "x".into(),
    };
    assert!(plain.provider().is_none());
    assert_eq!(plain.peel(), &plain);
    assert_eq!(plain.prompt_too_long_message(), None);
}

#[test]
fn a_response_status_sets_prepare_and_a_stream_error_sets_stream() {
    assert_eq!(
        ProviderFailure::new("1113", Some(429), false, "unknown", "anthropic").error_phase,
        "prepare"
    );
    assert_eq!(
        ProviderFailure::new("1113", None, false, "unknown", "anthropic").error_phase,
        "stream"
    );
}

#[test]
fn with_model_leaves_a_plain_error_alone() {
    let plain = ModelError::Network {
        message: "x".into(),
    };
    assert_eq!(plain.clone().with_model("p", "m"), plain);
}
