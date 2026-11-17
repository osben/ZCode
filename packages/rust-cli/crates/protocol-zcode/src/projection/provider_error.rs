//! Fork: `lastError.attribution` of a provider business failure, in Node's shape (`projectErrorAttribution`,
//! `apps/zcode-cli/packages/core/src/errors/error-payload.ts`). The golden is Node's projection of the context that
//! `toAdapterError` builds for the failure (`projection_tests.rs` `a_provider_failure_names_its_code_in_last_error`).

use rust_cli_kernel_api::model::ProviderFailure;
use serde_json::{Value, json};

/// Node's keys of a provider business failure: `source` and `exceptionKind` always, `providerErrorCode`, `retryable`,
/// `reason`, `errorPhase`, `transport` and `providerKind`; `statusCode` only with an HTTP status (Node omits it for a
/// stream error); `providerId` and `modelId` when the request's selection is known.
pub(super) fn attribution(provider: &ProviderFailure) -> Value {
    let mut value = json!({
        "source": "provider",
        "exceptionKind": "provider_business",
        "providerErrorCode": provider.code,
        "retryable": provider.retryable,
        "reason": provider.reason,
        "errorPhase": provider.error_phase,
        "transport": provider.transport,
        "providerKind": provider.provider_kind,
    });
    if let Some(status) = provider.status {
        value["statusCode"] = json!(status);
    }
    if let Some(provider_id) = &provider.provider_id {
        value["providerId"] = json!(provider_id);
    }
    if let Some(model_id) = &provider.model_id {
        value["modelId"] = json!(model_id);
    }
    value
}
