//! Fork: `lastError.attribution` of a provider business failure, in Node's shape (`projectErrorAttribution`,
//! `apps/zcode-cli/packages/core/src/errors/error-payload.ts`). The golden is Node's projection of the context the
//! adapters build for the failure (`projection_tests.rs` `a_provider_failure_names_its_code_in_last_error`).

use rust_cli_kernel_api::model::ProviderFailure;
use serde_json::{Value, json};

/// `source`, `exceptionKind`, `providerErrorCode` and `retryable` always; `statusCode` only when the failure had an
/// HTTP status (Node omits it for a stream error). Node's `providerId`, `modelId`, `providerKind`, `transport`,
/// `errorPhase` and `reason` are not carried yet; see the spec's "Known gap" section.
pub(super) fn attribution(provider: &ProviderFailure) -> Value {
    let mut value = json!({
        "source": "provider",
        "exceptionKind": "provider_business",
        "providerErrorCode": provider.code,
        "retryable": provider.retryable,
    });
    if let Some(status) = provider.status {
        value["statusCode"] = json!(status);
    }
    value
}
