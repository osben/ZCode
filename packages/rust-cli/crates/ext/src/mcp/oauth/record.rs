//! Parsers for the Node-written records (Node `loadPendingAuthorization`, `loadDiscoveryRecord`,
//! `loadCanonicalCredentials`). Unreadable or malformed values are absent, never an error: Node
//! treats them the same way so that a newer or older writer cannot wedge the flow.

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::keys::credential_key;
use super::store::{McpOAuthStore, McpOAuthStoreError};

/// Discovery metadata cache lifetime (Node `MCP_OAUTH_DISCOVERY_TTL_MS`).
pub const DISCOVERY_TTL_MS: i64 = 24 * 60 * 60 * 1000;

const PENDING_KEY: &str = "pending_authorization";
const DISCOVERY_KEY: &str = "discovery_state";
const DISCOVERY_FETCHED_AT_KEY: &str = "discovery_state_fetched_at";
const CANONICAL_KEY: &str = "authorization_credentials";

/// A live authorization attempt (Node `PendingAuthorizationRecord`).
#[derive(Debug, Clone, PartialEq)]
pub struct PendingAuthorization {
    pub attempt_id: String,
    pub authorization_url: String,
    pub baseline_generation: Option<String>,
    pub expires_at: i64,
    pub state: String,
}

/// The fields of the canonical credential record that the read side needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalCredentials {
    /// `generation` as written, or `legacy-<sha256(raw)[..32]>` for records without one.
    pub generation: String,
    pub expires_at: Option<i64>,
    pub obtained_at: Option<i64>,
}

/// Node `loadPendingAuthorization`: absent when missing, malformed, or `expires_at <= now`.
pub async fn load_pending(
    store: &dyn McpOAuthStore,
    key_prefix: &str,
    now: i64,
) -> Result<Option<PendingAuthorization>, McpOAuthStoreError> {
    let Some(raw) = store.load(&credential_key(key_prefix, PENDING_KEY)).await? else {
        return Ok(None);
    };
    let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None);
    };
    let text = |key: &str| parsed.get(key).and_then(Value::as_str).map(str::to_owned);
    let (Some(attempt_id), Some(authorization_url), Some(state), Some(expires_at)) = (
        text("attempt_id"),
        text("authorization_url"),
        text("state"),
        parsed.get("expires_at").and_then(Value::as_f64),
    ) else {
        return Ok(None);
    };
    if expires_at <= now as f64 {
        return Ok(None);
    }
    Ok(Some(PendingAuthorization {
        attempt_id,
        authorization_url,
        baseline_generation: text("baseline_generation"),
        expires_at: expires_at as i64,
        state,
    }))
}

/// Node `loadDiscoveryRecord`: the cached discovery state, or `None` when it is missing, older
/// than [`DISCOVERY_TTL_MS`], lacks its timestamp, or its issuer differs from `expected_issuer`
/// (a trailing `/` is ignored, as in Node).
pub async fn load_discovery(
    store: &dyn McpOAuthStore,
    key_prefix: &str,
    expected_issuer: Option<&str>,
    now: i64,
) -> Result<Option<Value>, McpOAuthStoreError> {
    let Some(raw) = store
        .load(&credential_key(key_prefix, DISCOVERY_KEY))
        .await?
    else {
        return Ok(None);
    };
    let fetched_at = store
        .load(&credential_key(key_prefix, DISCOVERY_FETCHED_AT_KEY))
        .await?
        .and_then(|text| text.parse::<f64>().ok())
        .filter(|value| value.is_finite());
    let Some(fetched_at) = fetched_at else {
        return Ok(None);
    };
    if now as f64 - fetched_at >= DISCOVERY_TTL_MS as f64 {
        return Ok(None);
    }
    let Ok(state @ Value::Object(_)) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None);
    };
    if state
        .get("authorizationServerUrl")
        .and_then(Value::as_str)
        .is_none()
    {
        return Ok(None);
    }
    if let Some(expected) = expected_issuer {
        let cached = state
            .pointer("/authorizationServerMetadata/issuer")
            .and_then(Value::as_str)
            .or_else(|| state.get("authorizationServerUrl").and_then(Value::as_str));
        if cached.map(normalize_issuer) != Some(normalize_issuer(expected)) {
            return Ok(None);
        }
    }
    Ok(Some(state))
}

fn normalize_issuer(value: &str) -> &str {
    value.strip_suffix('/').unwrap_or(value)
}

/// The generation of a canonical record: its `generation` as written, or the legacy hash of its raw text for a record
/// without one (Node `resolveCredentialGeneration`). Refresh coalescing and the follower baseline both read it, so
/// this is the one derivation both use.
pub(super) fn resolve_generation(parsed: &Value, raw: &str) -> String {
    match parsed.get("generation").and_then(Value::as_str) {
        Some(generation) if !generation.is_empty() => generation.to_owned(),
        _ => {
            let digest = Sha256::digest(raw.as_bytes());
            let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            format!("legacy-{}", &hex[..32])
        }
    }
}

/// Node `hasNewerCredentials`: a publication counts only when a canonical record exists (it carries tokens) and its
/// generation differs from the baseline. An absent or unreadable record is not newer.
pub(super) fn has_newer_credentials(
    current: Option<&CanonicalCredentials>,
    baseline: Option<&str>,
) -> bool {
    current.is_some_and(|canonical| baseline != Some(canonical.generation.as_str()))
}

/// Node `loadCanonicalCredentials`: versions 1 and 2 are accepted; a record without `generation`
/// gets the legacy hash of its raw text.
pub async fn load_canonical(
    store: &dyn McpOAuthStore,
    key_prefix: &str,
) -> Result<Option<CanonicalCredentials>, McpOAuthStoreError> {
    let Some(raw) = store
        .load(&credential_key(key_prefix, CANONICAL_KEY))
        .await?
    else {
        return Ok(None);
    };
    let Ok(parsed @ Value::Object(_)) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None);
    };
    let version = parsed.get("version").and_then(Value::as_i64);
    if !matches!(version, Some(1 | 2)) {
        return Ok(None);
    }
    let object_field = |key: &str| parsed.get(key).is_some_and(Value::is_object);
    if !object_field("client_information")
        || !object_field("tokens")
        || parsed.get("published_by").and_then(Value::as_str).is_none()
    {
        return Ok(None);
    }
    Ok(Some(CanonicalCredentials {
        generation: resolve_generation(&parsed, &raw),
        expires_at: parsed.get("expires_at").and_then(Value::as_i64),
        obtained_at: parsed.get("obtained_at").and_then(Value::as_i64),
    }))
}
