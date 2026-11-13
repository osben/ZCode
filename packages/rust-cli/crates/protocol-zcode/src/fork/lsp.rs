//! Fork: `lsp/preferences/get`, `lsp/preferences/set` and `lsp/status` (specs/fork-rust-agent-parity.md, "Language
//! servers" row). zcode-rs runs no language servers, so it answers like a Node runtime started without an LSP host
//! (bootstrap `zcode-protocol/lsp.ts` `requireLspHost`). The strict params check runs before, in
//! [`crate::inbound::Inbound::method`], as Node's `parseParams` does.

use rust_cli_protocol_core::rpc::RpcError;
use serde_json::Value;

/// Node `LSP_HOST_UNAVAILABLE_CODE`.
const LSP_HOST_UNAVAILABLE: i64 = -32000;

/// `None` for a method outside the `lsp/*` family this module answers.
pub(super) fn dispatch(method: &str) -> Option<Result<Value, RpcError>> {
    match method {
        "lsp/preferences/get" | "lsp/preferences/set" | "lsp/status" => Some(Err(RpcError::new(
            LSP_HOST_UNAVAILABLE,
            "Language server support is not available in this runtime",
        ))),
        _ => None,
    }
}

#[cfg(test)]
#[path = "lsp_tests.rs"]
mod tests;
