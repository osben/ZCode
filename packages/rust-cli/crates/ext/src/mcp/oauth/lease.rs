//! Authorization lease and pending record (Node `oauth-lease.ts`).
//!
//! The lease itself (the `<sanitized prefix>.authz` lock) is taken by the store implementation
//! ([`McpOAuthStore::try_acquire_lease`]), because the lock directory lives next to the credential
//! file. This module owns the record bytes and the attempt-based compare-and-delete, which Node
//! performs in `deletePendingAuthorizationIfOwned`.

use serde::Serialize;

use super::keys::credential_key;
use super::record::PendingAuthorization;
use super::store::{McpOAuthStore, McpOAuthStoreError, McpOAuthWrite};

const PENDING_KEY: &str = "pending_authorization";

/// Field order is Node's `StoredPendingAuthorization` literal: `attempt_id`, `authorization_url`,
/// `baseline_generation` (omitted when undefined), `expires_at`, `state`. Node's `JSON.stringify`
/// keeps that order, and the bytes are compared in tests, so the struct keeps it too.
#[derive(Serialize)]
struct StoredPending<'a> {
    attempt_id: &'a str,
    authorization_url: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    baseline_generation: Option<&'a str>,
    expires_at: i64,
    state: &'a str,
}

/// Node `publishPendingAuthorization` bytes for `record`.
pub fn pending_record_json(record: &PendingAuthorization) -> String {
    let stored = StoredPending {
        attempt_id: &record.attempt_id,
        authorization_url: &record.authorization_url,
        baseline_generation: record.baseline_generation.as_deref(),
        expires_at: record.expires_at,
        state: &record.state,
    };
    // Serializing strings, an optional string and an integer cannot fail; an empty string would read back as
    // absent, so a failure could never produce a record that a reader mistakes for a live one.
    serde_json::to_string(&stored).unwrap_or_default()
}

/// Write the pending record of this attempt (Node `publishPendingAuthorization`).
pub async fn publish_pending(
    store: &dyn McpOAuthStore,
    key_prefix: &str,
    record: &PendingAuthorization,
) -> Result<(), McpOAuthStoreError> {
    store
        .apply(&[McpOAuthWrite::Put {
            key: credential_key(key_prefix, PENDING_KEY),
            value: pending_record_json(record),
        }])
        .await
}

/// Delete the pending record only if it was published by `attempt_id` (Node
/// `deletePendingAuthorizationIfOwned`). An unparseable record is removed, as in Node, so that a
/// corrupt value cannot block the next flow. Returns whether a record was removed.
pub async fn delete_pending_if_owned(
    store: &dyn McpOAuthStore,
    key_prefix: &str,
    attempt_id: &str,
) -> Result<bool, McpOAuthStoreError> {
    let key = credential_key(key_prefix, PENDING_KEY);
    let Some(raw) = store.load(&key).await? else {
        return Ok(false);
    };
    let owned = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(parsed) => parsed.get("attempt_id").and_then(|id| id.as_str()) == Some(attempt_id),
        Err(_) => true,
    };
    if !owned {
        return Ok(false);
    }
    store
        .apply(&[McpOAuthWrite::DeleteIfValue {
            key: key.clone(),
            expected: raw.clone(),
        }])
        .await?;
    // `apply` does not report whether the compare-and-delete hit, so confirm by reading back.
    Ok(store.load(&key).await?.as_deref() != Some(raw.as_str()))
}
