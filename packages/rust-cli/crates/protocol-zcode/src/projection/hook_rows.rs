//! Fork: `hookInvocation` rows and the blocked-prompt banner, like Node's `onHookRunLifecycle` and
//! `hookBlockErrorDelta` (bootstrap `zcode-protocol-v4/product-projection.ts`; specs/fork-rust-agent-parity.md
//! HK-UP-01). One row per dispatch in the running turn; a UserPromptSubmit block sets `lastError`.

use rust_cli_kernel_api::hooks::HookInvocation;

use super::state::LastError;

/// Node `hookBlockErrorDelta` for the last blocked UserPromptSubmit run (each `HookRunBlocked` replaces the error).
#[cfg_attr(not(test), expect(dead_code, reason = "the HK-UP-01 fix wires it"))]
pub(super) fn block_error(_invocation: &HookInvocation, _now: u64) -> Option<LastError> {
    None
}
