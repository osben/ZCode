//! Fork: the language-server port behind `lsp/preferences/get`, `lsp/preferences/set` and `lsp/status`
//! (specs/fork-rust-lsp.md). The protocol layer answers through it and holds no LSP state.

use async_trait::async_trait;
use serde_json::{Map, Value};

/// The user preferences (Node `LspPreferences` without the storage-only `version`).
#[derive(Debug, Clone, PartialEq)]
pub struct LspPreferences {
    pub enabled: bool,
    /// Server id → diagnostics after edit, in the sidecar's key order.
    pub diagnostics_after_edit: Map<String, Value>,
}

impl Default for LspPreferences {
    /// Node `DEFAULT_LSP_PREFERENCES`.
    fn default() -> Self {
        Self {
            enabled: true,
            diagnostics_after_edit: Map::new(),
        }
    }
}

/// `lsp/preferences/set`'s `patch`; a `None` override removes it (the manifest default applies again).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LspPreferencesPatch {
    pub enabled: Option<bool>,
    pub diagnostics_after_edit: Vec<(String, Option<bool>)>,
}

/// The workspace a status request names. The identity is the pool key of the runtime (stage 2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LspWorkspace {
    pub path: String,
    pub identity: Option<String>,
}

/// One entry of `lsp/status` (`zcodeLspServerStatusSchema`).
#[derive(Debug, Clone, PartialEq)]
pub struct LspServerStatus {
    pub server_id: String,
    pub plugin_id: String,
    pub server_name: String,
    pub command: String,
    pub extensions: Vec<String>,
    pub installed: bool,
    /// `stopped`, `starting`, `ready`, `crashed`, `unavailable` or `not_installed`.
    pub state: &'static str,
    /// `pull`, `versioned`, `attributed` or `unknown` (stage 1 reports `unknown`).
    pub diagnostics_mode: &'static str,
    pub diagnostics_after_edit: bool,
    pub restarts: u32,
    pub last_error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LspStatus {
    pub enabled: bool,
    pub servers: Vec<LspServerStatus>,
}

/// Node `LspProtocolHost`. Errors are the message the protocol answers with.
#[async_trait]
pub trait LanguageServers: Send + Sync {
    /// Re-reads the sidecar; bad content reads as the defaults.
    async fn preferences(&self) -> Result<LspPreferences, String>;
    /// Merges the patch onto the sidecar on disk, writes it, then applies it to the runtime.
    async fn set_preferences(&self, patch: LspPreferencesPatch) -> Result<LspPreferences, String>;
    /// The declared servers of the workspace with their state. Starts nothing.
    async fn status(&self, workspace: &LspWorkspace) -> Result<LspStatus, String>;
}
