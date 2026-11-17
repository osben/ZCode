//! The MCP OAuth read seam (`rust_cli_ext::mcp::oauth::McpOAuthStore`) over `credentials.json`.
//! Values are the sealed ones Node writes; [`CredentialStore`] decrypts them with the credential
//! cipher (`enc:v2`, see `system_cipher.rs`), so this module adds no cipher or file of its own.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_ext::mcp::oauth::{McpOAuthStore, McpOAuthStoreError};

use crate::credentials::{CredentialError, CredentialStore};

#[derive(Clone)]
pub(crate) struct CredentialsMcpOAuthStore {
    store: CredentialStore,
}

impl CredentialsMcpOAuthStore {
    pub(crate) fn new(store: CredentialStore) -> Self {
        Self { store }
    }

    pub(crate) fn into_dyn(self) -> Arc<dyn McpOAuthStore> {
        Arc::new(self)
    }
}

#[async_trait]
impl McpOAuthStore for CredentialsMcpOAuthStore {
    async fn load(&self, key: &str) -> Result<Option<String>, McpOAuthStoreError> {
        let credentials = self.store.read().await.map_err(store_error)?;
        let value = credentials.get(key).await.map_err(store_error)?;
        Ok(value.map(|secret| secret.expose().to_owned()))
    }
}

/// Only the static reason reaches the caller: a value or a key never appears in the message.
fn store_error(error: CredentialError) -> McpOAuthStoreError {
    McpOAuthStoreError(error.to_string())
}

#[cfg(test)]
#[path = "mcp_oauth_tests.rs"]
mod tests;
