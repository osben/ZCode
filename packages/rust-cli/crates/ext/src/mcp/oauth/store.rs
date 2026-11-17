//! The read seam over the shared credential file. The platform crate implements it on top of
//! `credentials.json` (with the `enc:v2` cipher); this crate never touches the file itself.

/// The credential store could not be read (unreadable file, corrupt JSON, or the cipher is unavailable).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("MCP OAuth credential store unavailable: {0}")]
pub struct McpOAuthStoreError(pub String);

#[async_trait::async_trait]
pub trait McpOAuthStore: Send + Sync {
    /// The decrypted value of `key`, or `None` when absent.
    async fn load(&self, key: &str) -> Result<Option<String>, McpOAuthStoreError>;
}
