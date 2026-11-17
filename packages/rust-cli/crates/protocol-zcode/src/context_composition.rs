//! `v4/conversation/contextComposition` (Node `bootstrap/.../zcode-protocol/context-composition/handler.ts`; wire form
//! in `packages/shared/src/zcode-protocol-v4/context-composition/contract.ts`). Existing-only: a session that is not in
//! memory answers `composition: null`, and nothing is opened or restored. The notification
//! (`v4/conversation/contextCompositionChanged`) is not wired yet.

use rust_cli_kernel_api::context_composition::{CompositionAnswer, CompositionPhase, WireCategory};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::server::{Server, kernel_error};

/// The method's result for `answer`: `{composition: null}` when there is no answer.
pub(crate) fn wire(session_id: &str, answer: Option<&CompositionAnswer>) -> Value {
    let Some(answer) = answer else {
        return json!({"composition": null});
    };
    let record = &answer.record;
    // Node: `freeTokens` is `max(0, contextWindow - estimatedTokens)`, and null when the window is unknown.
    let window = answer.context_window.filter(|window| *window > 0);
    let free = window.map(|window| window.saturating_sub(record.estimated_tokens));
    let request = answer.phase == CompositionPhase::Request;
    let mut composition = json!({
        "sessionId": session_id,
        "revision": answer.revision,
        "phase": if request { "request" } else { "draft-preview" },
        "measuredAt": record.measured_at_ms,
        "model": {
            "providerId": record.provider_id,
            "modelId": record.model_id,
            "contextWindow": window,
        },
        "tokenMethod": "estimated",
        "estimatedTokens": record.estimated_tokens,
        "freeTokens": free,
        "categories": record.categories.iter().map(category).collect::<Vec<_>>(),
    });
    // Provider tokens are reported for a measured request only, once its usage has arrived.
    if let (true, Some(usage)) = (request, record.provider_usage) {
        composition["providerInputTokens"] = json!(usage.input_tokens);
        composition["providerContextTokens"] = json!(usage.context_tokens);
    }
    json!({"composition": composition})
}

fn category(category: &WireCategory) -> Value {
    let mut value = json!({
        "id": category.id,
        "tokens": category.tokens,
        "chars": category.chars,
    });
    if let Some(items) = &category.items {
        value["items"] = items
            .iter()
            .map(|item| json!({"name": item.name, "tokens": item.tokens}))
            .collect::<Vec<_>>()
            .into();
    }
    value
}

/// `v4/conversation/contextComposition` params: `sessionId` required, `modelSelection` optional (the session's model
/// when absent or null).
pub(crate) async fn read(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let Some(id) = params["sessionId"].as_str().filter(|id| !id.is_empty()) else {
        return Err(RpcError::invalid_params("sessionId is required"));
    };
    let selection = match params.get("modelSelection") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            crate::commands::selection(Some(value))
                .ok_or_else(|| RpcError::invalid_params("modelSelection is invalid"))?,
        ),
    };
    let answer = server
        .kernel
        .context_composition(&SessionId::new(id), selection)
        .await
        .map_err(|error| kernel_error(&error))?;
    Ok(wire(id, answer.as_ref()))
}

#[cfg(test)]
#[path = "context_composition_tests.rs"]
mod tests;
