//! Fork: the language-server port behind `lsp/preferences/get`, `lsp/preferences/set` and `lsp/status`
//! (specs/fork-rust-lsp.md). The protocol layer answers through it and holds no LSP state.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

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

/// What a tool did to a file (Node `FileMutatedEvent.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileMutationKind {
    Created,
    Changed,
    Deleted,
}

/// Lines a mutation touched, 1-based and inclusive (Node `changedRange`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChangedRange {
    pub start_line: u32,
    pub end_line: u32,
}

/// A successful Write or Edit (Node `FileMutatedEvent`). `content` is the text written.
#[derive(Debug, Clone, PartialEq)]
pub struct FileMutation {
    pub path: String,
    pub kind: FileMutationKind,
    pub content: Option<String>,
    pub changed_range: Option<ChangedRange>,
}

/// Fork: the language-server runtime as the session sees it (specs/fork-rust-lsp.md "Runtime"): Read prewarms, Write
/// and Edit publish mutations, and the context builder asks for the post-edit report. Only the main thread calls it.
#[async_trait]
pub trait CodeIntelligence: Send + Sync {
    /// Starts the server for the file's type in the background (acquire only, never waits for the start).
    async fn prewarm(
        &self,
        session: &crate::ids::SessionId,
        workspace: &crate::env::WorkspaceRef,
        path: &str,
    );
    /// Records the mutation before it returns (so the next request sees it), then syncs it in the background.
    async fn file_mutated(
        &self,
        session: &crate::ids::SessionId,
        workspace: &crate::env::WorkspaceRef,
        mutation: FileMutation,
    );
    /// The post-edit diagnostics body for the next model request, or None. Returns at once when nothing was mutated
    /// since the previous request; otherwise waits at most until 2 s after the last mutation. Dropping the future
    /// before it returns leaves the pending edits for the next request.
    async fn edit_diagnostics(&self, session: &crate::ids::SessionId) -> Option<String>;
    /// The session closed: its pending edits and its `LSP` tool fact are dropped.
    fn session_closed(&self, session: &crate::ids::SessionId);
    /// Settles whether the session is offered the `LSP` tool (Node `isAvailable`): code intelligence is enabled and a
    /// declared server of the workspace is installed. The first call for a session's workspace computes and stores it
    /// (Node builds the runtime); later calls for the same workspace keep it, since only a preference write recomputes
    /// it. The main thread's runner awaits it before a run.
    async fn settle_tool(
        &self,
        session: &crate::ids::SessionId,
        workspace: &crate::env::WorkspaceRef,
    );
    /// The stored fact, read synchronously by the tool registry: false while code intelligence is off.
    fn tool_offered(&self, session: &crate::ids::SessionId) -> bool;
    /// One `LSP` tool operation (Node `LspService.query`); `query.file_path` is absolute.
    async fn query(
        &self,
        session: &crate::ids::SessionId,
        workspace: &crate::env::WorkspaceRef,
        query: LspQuery,
        cancel: &CancellationToken,
    ) -> Result<LspOutput, LspQueryError>;
}

/// Node `LspOperation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LspOperation {
    GoToDefinition,
    FindReferences,
    Hover,
    DocumentSymbol,
    WorkspaceSymbol,
    GoToImplementation,
    Diagnostics,
}

impl LspOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GoToDefinition => "goToDefinition",
            Self::FindReferences => "findReferences",
            Self::Hover => "hover",
            Self::DocumentSymbol => "documentSymbol",
            Self::WorkspaceSymbol => "workspaceSymbol",
            Self::GoToImplementation => "goToImplementation",
            Self::Diagnostics => "diagnostics",
        }
    }

    /// Node `isPositionalOperation`: the input needs a line plus a character or a symbol.
    pub fn positional(self) -> bool {
        matches!(
            self,
            Self::GoToDefinition | Self::GoToImplementation | Self::FindReferences | Self::Hover
        )
    }
}

/// The `LSP` tool's input after its rules (Node `LspInput`); numbers stay JS numbers until the position resolves.
#[derive(Debug, Clone, PartialEq)]
pub struct LspQuery {
    pub operation: LspOperation,
    pub file_path: String,
    pub line: Option<f64>,
    pub character: Option<f64>,
    pub symbol: Option<String>,
    pub query: Option<String>,
    pub include_declaration: Option<bool>,
}

/// Node `LspError`: a stable code (`lsp_server_starting`, ...) and the text the model sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LspQueryError {
    pub code: String,
    pub message: String,
}

/// Node `LspOutput.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LspResultStatus {
    Ok,
    Pending,
}

/// Node `LspLocation`: 1-based line, 1-based code-point columns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLocation {
    pub path: String,
    pub line: i64,
    pub character: i64,
    pub end_line: i64,
    pub end_character: i64,
    pub preview: String,
}

/// Node `LspSymbol`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSymbol {
    pub name: String,
    pub kind: String,
    pub path: String,
    pub line: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspHover {
    pub contents: String,
}

/// Node `LspOutput.diagnostics[]` (no end position).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticItem {
    pub path: String,
    pub line: u32,
    pub character: u32,
    pub severity: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Node `LspOutput`: the tool's `display`; [`LspOutput::model_text`] is what the model reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspOutput {
    pub operation: LspOperation,
    pub server: String,
    pub status: LspResultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locations: Option<Vec<LspLocation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbols: Option<Vec<LspSymbol>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hover: Option<LspHover>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Vec<LspDiagnosticItem>>,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
}

const NO_RESULTS_TEXT: &str = "No results";
const NO_DIAGNOSTICS_TEXT: &str = "No diagnostics reported";
const PENDING_DIAGNOSTICS_TEXT: &str = "Diagnostics pending: the language server has not reported fresh results for this file yet. This is not the same as no errors.";
const PENDING_TEXT: &str = "Result pending: the language server has not answered yet. Retry shortly, or use Grep meanwhile.";
const TRUNCATION_NOTE: &str = "(Results are truncated. Narrow the query to see the rest.)";

impl LspOutput {
    /// Node `formatLspModelContent`.
    pub fn model_text(&self) -> String {
        let mut lines: Vec<String> = Vec::new();
        for location in self.locations.iter().flatten() {
            lines.push(
                format!(
                    "{}:{}:{}  {}",
                    location.path, location.line, location.character, location.preview
                )
                .trim_end()
                .to_owned(),
            );
        }
        for symbol in self.symbols.iter().flatten() {
            let container = symbol
                .container_name
                .as_ref()
                .map_or_else(String::new, |name| format!(" in {name}"));
            lines.push(format!(
                "{} {}{container}  {}:{}",
                symbol.kind, symbol.name, symbol.path, symbol.line
            ));
        }
        if let Some(hover) = &self.hover {
            lines.push(hover.contents.clone());
        }
        for item in self.diagnostics.iter().flatten() {
            let tags: Vec<&str> = [item.source.as_deref(), item.code.as_deref()]
                .into_iter()
                .flatten()
                .collect();
            let tail = if tags.is_empty() {
                String::new()
            } else {
                format!(" [{}]", tags.join(" "))
            };
            lines.push(format!(
                "{}:{}:{} {} {}{tail}",
                item.path, item.line, item.character, item.severity, item.message
            ));
        }
        let diagnostics = self.operation == LspOperation::Diagnostics;
        if self.status == LspResultStatus::Pending {
            lines.push(
                if diagnostics {
                    PENDING_DIAGNOSTICS_TEXT
                } else {
                    PENDING_TEXT
                }
                .to_owned(),
            );
        }
        if lines.is_empty() {
            return if diagnostics {
                NO_DIAGNOSTICS_TEXT
            } else {
                NO_RESULTS_TEXT
            }
            .to_owned();
        }
        if self.truncated {
            lines.push(TRUNCATION_NOTE.to_owned());
        }
        lines.join("\n")
    }
}

/// The attachment source of the post-edit report (Node `LSP_DIAGNOSTICS_ATTACHMENT_SOURCE`).
pub const DIAGNOSTICS_SOURCE: &str = "diagnostics";
