//! Fork: the language-server runtime (specs/fork-rust-lsp.md "Runtime"): a port of Node adapters `lsp/*` (JSON-RPC,
//! pool, lifecycle) and core `lsp/*` (document sync, freshness, post-edit diagnostics).

pub(crate) mod rpc;
pub(crate) mod uri;

use std::time::Duration;

/// Node `LSP_DEFAULT_IDLE_SHUTDOWN_MS`.
pub(crate) const IDLE_SHUTDOWN: Duration = Duration::from_millis(600_000);
/// Node `LSP_DEFAULT_MAX_RUNNING_SERVERS`.
pub(crate) const MAX_RUNNING_SERVERS: usize = 4;
/// Node `LSP_DEFAULT_NOT_INSTALLED_RETRY_MS`.
pub(crate) const NOT_INSTALLED_RETRY: Duration = Duration::from_millis(30_000);
/// Node `LSP_DEFAULT_UNAVAILABLE_RETRY_MS`.
pub(crate) const UNAVAILABLE_RETRY: Duration = Duration::from_millis(30_000);
/// Node `LSP_STDERR_TAIL_MAX_CHARS`.
pub(crate) const STDERR_TAIL_MAX_CHARS: usize = 2_048;
/// Node `LSP_MAX_OPEN_DOCUMENTS`.
pub(crate) const MAX_OPEN_DOCUMENTS: usize = 50;
/// Node `LSP_EDIT_DIAGNOSTICS_MAX`.
pub(crate) const EDIT_DIAGNOSTICS_MAX: usize = 20;
/// Node `LSP_EDIT_DIAGNOSTICS_WAIT_MS`.
pub(crate) const EDIT_DIAGNOSTICS_WAIT: Duration = Duration::from_millis(2_000);
/// Node `LSP_EDIT_DIAGNOSTICS_MAX_CARRY_ROUNDS`.
pub(crate) const EDIT_DIAGNOSTICS_MAX_CARRY_ROUNDS: u32 = 3;

/// A failure with Node's stable `LspErrorCode` (`lsp_server_crashed`, `lsp_request_timeout`, ...).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LspError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl LspError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for LspError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}
