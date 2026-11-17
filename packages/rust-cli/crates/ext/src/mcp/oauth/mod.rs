//! MCP OAuth state shared with Node (`apps/zcode-cli/packages/adapters/src/mcp/oauth*.ts`).
//!
//! The records live in the shared credential file, so the key names, JSON shapes and TTL rules
//! must match Node byte-for-byte (`specs/fork-rust-mcp-oauth.md`). This module is read-side only
//! in PR1: it parses what Node wrote and answers "is an authorization pending for this server".
//! The store is injected through [`McpOAuthStore`]; the platform credential store implements it.

mod keys;
mod record;
mod store;

#[cfg(test)]
mod tests;

pub use keys::{credential_key, credential_key_prefix, lease_path, sanitize_key_prefix};
pub use record::{
    CanonicalCredentials, DISCOVERY_TTL_MS, PendingAuthorization, load_canonical, load_discovery,
    load_pending,
};
pub use store::{McpOAuthStore, McpOAuthStoreError};

/// Whether a connect error is an authorization challenge (Node `classifyInteractiveAuthorizationTrigger`:
/// a 401 that the SDK reports as `unauthorized`). A 403 needs the `WWW-Authenticate` header, which the
/// transport error text does not carry, so it is not classified here.
pub fn is_authorization_challenge(reason: &str) -> bool {
    reason.starts_with("HTTP 401")
}

/// Node `createOAuthAuthorizationStatus`: the `authorization` object of a status row. `started_at` is
/// the time the row is built, as in Node (the pending record does not store it).
pub fn authorization_status(pending: &PendingAuthorization, started_at: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "oauth_authorization_code",
        "authorizationUrl": pending.authorization_url,
        "startedAt": started_at,
    })
}

/// Which row statuses a pending authorization replaces. A connected, disabled or untrusted server keeps its
/// own status: the pending record must not hide them.
pub fn may_show_pending(status: &str) -> bool {
    matches!(status, "connecting" | "failed" | "disconnected")
}

/// The fields Node hashes into the credential key prefix (`createCredentialKeyPrefix`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerOAuthIdentity {
    pub name: String,
    pub url: String,
    pub client_id: Option<String>,
    pub scope: Option<String>,
    pub redirect_path: Option<String>,
}

/// The pending authorization of one server, if a live one exists.
///
/// Lookup order and expiry match Node: the record is absent once `expires_at <= now`, and a
/// malformed record is absent rather than an error.
pub async fn pending_authorization_for(
    store: &dyn McpOAuthStore,
    identity: &ServerOAuthIdentity,
    now: i64,
) -> Result<Option<PendingAuthorization>, McpOAuthStoreError> {
    let prefix = credential_key_prefix(
        &identity.name,
        &identity.url,
        identity.client_id.as_deref(),
        identity.scope.as_deref(),
        identity.redirect_path.as_deref(),
    );
    load_pending(store, &prefix, now).await
}
