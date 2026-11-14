//! Workspace MCP trust records `workspace-mcp-trust-v1.json` (specs/fork-rust-agent-parity.md, "Workspace MCP
//! trust"), shared with the Node CLI and App: the same file beside the hook trust store, the same strict schema
//! (`apps/zcode-cli/packages/bootstrap/src/workspace-mcp-trust/index.ts`), the same directory lock and private
//! atomic write. A record grants one declaration digest of one server in one workspace identity.

use std::path::PathBuf;

use rust_cli_base::js::json::stringify;
use rust_cli_fs::{FileMode, LockOptions, ParentDir, TempName, WriteOptions};
use rust_cli_paths::StoragePath;
use serde_json::{Map, Value, json};

use super::hook_trust::{datetime, sha256_hex};

/// Node `STORE_NAME`, next to `workspace-hook-trust-v1.json`.
pub const MCP_TRUST_STORE: &str = "workspace-mcp-trust-v1.json";

/// Node `atomicWritePrivateTextFile`: 0600, hidden temporary name. The `security/` directory is created 0700 before
/// the lock, like the hook trust store.
const PRIVATE_WRITE: WriteOptions = WriteOptions {
    mode: FileMode::Private,
    temp_name: TempName::Hidden,
    parent: ParentDir::Existing,
    rename_retry: rust_cli_fs::NODE_RENAME_RETRY,
};

const RECORD_KEYS: [&str; 4] = [
    "workspaceIdentity",
    "serverName",
    "declarationDigest",
    "grantedAt",
];

/// One record (Node `recordSchema`, strict).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpTrustRecord {
    pub workspace_identity: String,
    pub server_name: String,
    pub declaration_digest: String,
    pub granted_at: String,
}

impl McpTrustRecord {
    fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if object.len() != RECORD_KEYS.len() || !RECORD_KEYS.iter().all(|k| object.contains_key(*k))
        {
            return None;
        }
        let text = |key: &str| object.get(key)?.as_str().map(str::to_owned);
        let record = Self {
            workspace_identity: text("workspaceIdentity").filter(|t| !t.is_empty())?,
            server_name: text("serverName").filter(|t| !t.is_empty())?,
            declaration_digest: text("declarationDigest").filter(|t| sha256_hex(t))?,
            granted_at: text("grantedAt").filter(|t| datetime(t))?,
        };
        Some(record)
    }

    fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("workspaceIdentity".into(), json!(self.workspace_identity));
        object.insert("serverName".into(), json!(self.server_name));
        object.insert("declarationDigest".into(), json!(self.declaration_digest));
        object.insert("grantedAt".into(), json!(self.granted_at));
        Value::Object(object)
    }

    /// Node `matches`.
    pub fn matches(&self, identity: &str, name: &str, digest: &str) -> bool {
        self.workspace_identity == identity
            && self.server_name == name
            && self.declaration_digest == digest
    }
}

/// Node `storeSchema`; anything invalid is None (the store is then corrupt).
fn parse_store(bytes: &[u8]) -> Option<Vec<McpTrustRecord>> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let object = value.as_object()?;
    // Node `z.literal(1)` compares JS numbers, so `1.0` and `1e0` are the literal too.
    let version = object.get("schemaVersion").and_then(Value::as_f64);
    if object.len() != 2 || version != Some(1.0) {
        return None;
    }
    object
        .get("records")?
        .as_array()?
        .iter()
        .map(McpTrustRecord::parse)
        .collect()
}

/// The store as read: a corrupt store shows every declaration untrusted (Node `inspect`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpTrustLoad {
    Missing,
    Records(Vec<McpTrustRecord>),
    Corrupt,
}

impl McpTrustLoad {
    pub fn records(&self) -> &[McpTrustRecord] {
        match self {
            Self::Records(records) => records,
            Self::Missing | Self::Corrupt => &[],
        }
    }

    /// Node `trusted.some(matches)`.
    pub fn trusts(&self, identity: &str, name: &str, digest: &str) -> bool {
        self.records()
            .iter()
            .any(|record| record.matches(identity, name, digest))
    }
}

/// What the workspace declares now, re-read under the lock (Node `decide` rediscovers there).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StillDeclared {
    /// The declaration is there with the decided digest.
    Yes,
    /// The declaration is gone or its digest differs.
    Changed,
    /// The workspace config could not be read (Node's `discover` throws).
    Unavailable,
}

/// The display is the reason code the App gets.
#[derive(Debug, thiserror::Error)]
pub enum McpTrustError {
    /// The declaration is gone or its digest differs.
    #[error("workspace_mcp_declaration_changed")]
    Changed,
    /// The workspace config could not be read.
    #[error("workspace_mcp_trust_unavailable")]
    Unavailable,
    /// A record that would not parse back; written, it would make the whole store corrupt.
    #[error("workspace_mcp_trust_unavailable")]
    Invalid,
    /// The store could not be parsed; nothing is written over it.
    #[error("workspace_mcp_trust_unavailable")]
    Corrupt,
    #[error("workspace_mcp_trust_unavailable")]
    Io(#[from] std::io::Error),
}

/// The record file.
#[derive(Debug, Clone)]
pub struct McpTrustStore {
    file: PathBuf,
}

impl McpTrustStore {
    /// The file beside the hook trust store (Node `join(dirname(hookStorePath), STORE_NAME)`).
    pub fn beside(hook_store: &StoragePath) -> Self {
        let hook = hook_store.as_path();
        let dir = hook.parent().unwrap_or(hook);
        Self {
            file: dir.join(MCP_TRUST_STORE),
        }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.file
    }

    /// Reads without the lock: writes are atomic renames.
    pub async fn load(&self) -> McpTrustLoad {
        match rust_cli_fs::read_optional(&self.file).await {
            Ok(None) => McpTrustLoad::Missing,
            Ok(Some(bytes)) => {
                parse_store(&bytes).map_or(McpTrustLoad::Corrupt, McpTrustLoad::Records)
            }
            Err(_) => McpTrustLoad::Corrupt,
        }
    }

    /// Node `decide`: under the directory lock, `still_declared` re-reads the workspace (a missing or changed
    /// declaration refuses, an unreadable workspace too), then the matching record is dropped and, when `trusted`,
    /// appended again with `granted_at`. The file is written compact with no trailing newline, like Node's
    /// `JSON.stringify`.
    pub async fn decide(
        &self,
        still_declared: impl AsyncFnOnce() -> StillDeclared,
        record: McpTrustRecord,
        trusted: bool,
    ) -> Result<(), McpTrustError> {
        // Node builds the record itself; one that would not parse back must never reach the shared file.
        if McpTrustRecord::parse(&record.to_value()).as_ref() != Some(&record) {
            return Err(McpTrustError::Invalid);
        }
        let file = self.file.as_path();
        if let Some(parent) = file.parent() {
            rust_cli_fs::create_private_dir_all(parent).await?;
        }
        rust_cli_fs::with_file_lock(file, &LockOptions::default(), async || {
            match still_declared().await {
                StillDeclared::Yes => {}
                StillDeclared::Changed => return Err(McpTrustError::Changed),
                StillDeclared::Unavailable => return Err(McpTrustError::Unavailable),
            }
            let current = match rust_cli_fs::read_optional(file).await? {
                None => Vec::new(),
                Some(bytes) => parse_store(&bytes).ok_or(McpTrustError::Corrupt)?,
            };
            let mut next: Vec<McpTrustRecord> = current
                .into_iter()
                .filter(|known| {
                    !known.matches(
                        &record.workspace_identity,
                        &record.server_name,
                        &record.declaration_digest,
                    )
                })
                .collect();
            if trusted {
                next.push(record);
            }
            let records: Vec<Value> = next.iter().map(McpTrustRecord::to_value).collect();
            let text = stringify(&json!({"schemaVersion": 1, "records": records}));
            rust_cli_fs::atomic_write(file, text.as_bytes(), PRIVATE_WRITE).await?;
            Ok(())
        })
        .await
    }
}

#[cfg(test)]
#[path = "mcp_trust_tests.rs"]
mod tests;
