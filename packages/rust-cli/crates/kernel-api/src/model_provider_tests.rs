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
fn with_model_leaves_a_plain_error_alone() {
    let plain = ModelError::Network {
        message: "x".into(),
    };
    assert_eq!(plain.clone().with_model("p", "m"), plain);
}
