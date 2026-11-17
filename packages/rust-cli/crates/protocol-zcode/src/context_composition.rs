//! `v4/conversation/contextComposition` (Node `bootstrap/.../zcode-protocol/context-composition/handler.ts`; wire form
//! in `packages/shared/src/zcode-protocol-v4/context-composition/contract.ts`). Existing-only: a session that is not in
//! memory answers `composition: null`, and nothing is opened or restored. Changes are pushed as
//! `v4/conversation/contextCompositionChanged`, coalesced per batch (`forward`).

use rust_cli_base::Spawner;
use rust_cli_kernel_api::context_composition::{
    CompositionAnswer, CompositionChange, CompositionPhase, WireCategory,
};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::Kernel;
use rust_cli_protocol_core::connection::Peer;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::server::{Server, kernel_error};

/// Node `V4_NOTIFICATIONS.conversationContextCompositionChanged`.
const CHANGED: &str = "v4/conversation/contextCompositionChanged";

/// Node `tracker.ts`: one notification per session per batch, carrying the latest revision, in first-seen order.
pub(crate) fn coalesce(changes: &[CompositionChange]) -> Vec<CompositionChange> {
    let mut out: Vec<CompositionChange> = Vec::new();
    for change in changes {
        match out.iter_mut().find(|found| found.session == change.session) {
            Some(found) => found.revision = found.revision.max(change.revision),
            None => out.push(change.clone()),
        }
    }
    out
}

/// The notification params for one change.
pub(crate) fn changed_params(change: &CompositionChange) -> Value {
    json!({"sessionId": change.session.to_string(), "revision": change.revision})
}

/// Forwards the kernel's composition changes to this connection, one notification per session per batch. A batch is
/// what is already queued after one scheduler turn (no timers). The task ends when the connection's writer is gone, or
/// the kernel publishes no changes.
pub(crate) fn forward(peer: Peer, kernel: &dyn Kernel, spawner: &Spawner) {
    let Some(mut changes) = kernel.context_composition_changes() else {
        return;
    };
    // Resident in the connection's scope: dropping the handle does not stop it.
    drop(
        spawner.spawn_resident("context-composition-changed", async move {
            loop {
                let first = match changes.recv().await {
                    Ok(change) => change,
                    // Skipped changes cannot be named; the App re-reads a session's composition when it asks.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                };
                let mut batch = vec![first];
                tokio::task::yield_now().await;
                while let Ok(change) = changes.try_recv() {
                    batch.push(change);
                }
                for change in coalesce(&batch) {
                    if !peer.notify(CHANGED, &changed_params(&change)).await {
                        return;
                    }
                }
            }
        }),
    );
}

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
