//! The credential pair as Node reads it (`apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts`,
//! `loadCredentialPair` and `deriveCredentialPair`; `specs/fork-rust-mcp-oauth.md`, PR4 (c)).
//!
//! During the compatibility window a record may be canonical (v1 or v2), legacy (`client_information` and
//! `tokens` keys only, written by an older build), or canonical with a legacy mirror. The branches below are
//! Node's, in Node's order; the refresh, the bearer and the 403 scope read all use this one derivation.

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::keys::credential_key;
use super::store::{McpOAuthStore, McpOAuthStoreError};

const CANONICAL_KEY: &str = "authorization_credentials";
const LEGACY_CLIENT_KEY: &str = "client_information";
const LEGACY_TOKENS_KEY: &str = "tokens";

/// Node `CredentialPairSnapshot`. Legacy-derived pairs have no `generation` and no `raw`: a refresh of such a pair
/// cannot prove it is unchanged, so its invalidation is not compare-and-swap (Node skips it when `raw` is absent).
#[derive(Debug, Clone, PartialEq)]
pub struct CredentialPair {
    pub client: Option<Value>,
    pub tokens: Option<Value>,
    pub issuer: Option<String>,
    /// Canonical `expires_at` (epoch ms). Legacy pairs have none, so they count as near expiry (Node).
    pub expires_at: Option<i64>,
    pub generation: Option<String>,
    pub raw: Option<String>,
}

impl CredentialPair {
    fn legacy(client: Option<Value>, tokens: Option<Value>) -> Self {
        Self {
            client,
            tokens,
            issuer: None,
            expires_at: None,
            generation: None,
            raw: None,
        }
    }

    pub fn access_token(&self) -> Option<String> {
        self.tokens.as_ref()?["access_token"]
            .as_str()
            .map(str::to_owned)
    }

    pub fn refresh_token(&self) -> Option<String> {
        self.tokens.as_ref()?["refresh_token"]
            .as_str()
            .map(str::to_owned)
    }

    /// The scope the stored token was granted with (`tokens.scope`), if any.
    pub fn token_scope(&self) -> Option<String> {
        self.tokens.as_ref()?["scope"].as_str().map(str::to_owned)
    }
}

/// Read the three keys and derive the pair (Node `loadCredentialPair`). `None` when nothing usable is stored.
pub async fn load_pair(
    store: &dyn McpOAuthStore,
    key_prefix: &str,
) -> Result<Option<CredentialPair>, McpOAuthStoreError> {
    let canonical = store
        .load(&credential_key(key_prefix, CANONICAL_KEY))
        .await?;
    let client = store
        .load(&credential_key(key_prefix, LEGACY_CLIENT_KEY))
        .await?;
    let tokens = store
        .load(&credential_key(key_prefix, LEGACY_TOKENS_KEY))
        .await?;
    Ok(derive_pair(
        canonical.as_deref(),
        client.as_deref(),
        tokens.as_deref(),
    ))
}

/// Node `deriveCredentialPair`: a pure function of the three raw values.
pub fn derive_pair(
    canonical_raw: Option<&str>,
    legacy_client_raw: Option<&str>,
    legacy_tokens_raw: Option<&str>,
) -> Option<CredentialPair> {
    let legacy_client = parse(legacy_client_raw);
    let legacy_tokens = parse(legacy_tokens_raw);
    let canonical = canonical_raw.and_then(|raw| {
        parse(Some(raw))
            .filter(is_canonical)
            .map(|value| (raw, value))
    });

    let Some((raw, canonical)) = canonical else {
        if legacy_client.is_none() && legacy_tokens.is_none() {
            return None;
        }
        return Some(CredentialPair::legacy(legacy_client, legacy_tokens));
    };

    let canonical_client = canonical["client_information"].clone();
    let canonical_tokens = canonical["tokens"].clone();
    let snapshot = CredentialPair {
        client: Some(canonical_client.clone()),
        tokens: Some(canonical_tokens.clone()),
        issuer: canonical["issuer"].as_str().map(str::to_owned),
        expires_at: canonical["expires_at"].as_i64(),
        generation: Some(generation_of(&canonical, raw)),
        raw: Some(raw.to_owned()),
    };

    if canonical["version"].as_i64() == Some(1) {
        // A v1 writer removes the legacy mirror, so its absence is the normal steady state. A legacy token is
        // adopted only when the legacy client (if any) is the canonical client.
        let can_adopt = legacy_tokens.is_some()
            && legacy_client
                .as_ref()
                .is_none_or(|client| *client == canonical_client);
        if can_adopt {
            return Some(CredentialPair::legacy(
                Some(legacy_client.unwrap_or(canonical_client)),
                legacy_tokens,
            ));
        }
        return Some(snapshot);
    }

    let Some(legacy_tokens) = legacy_tokens else {
        // After an old provider invalidates the tokens, they stay invalid: no revival from canonical storage.
        return Some(CredentialPair::legacy(legacy_client, None));
    };
    if legacy_tokens == canonical_tokens {
        return Some(match legacy_client {
            Some(_) => snapshot,
            None => CredentialPair::legacy(None, Some(legacy_tokens)),
        });
    }
    if legacy_client
        .as_ref()
        .is_some_and(|client| *client == canonical_client)
    {
        // The client did not change, so the legacy token is the old provider's refresh of this identity.
        return Some(CredentialPair::legacy(legacy_client, Some(legacy_tokens)));
    }
    // Client and token both changed without a generation: never combine them. Keep the client to re-authorize.
    Some(CredentialPair::legacy(legacy_client, None))
}

/// Node `isCanonicalCredentials`: supported version, a publisher, a client with `client_id`, and tokens with an
/// access token and a token type.
fn is_canonical(value: &Value) -> bool {
    matches!(value["version"].as_i64(), Some(1 | 2))
        && value["published_by"]
            .as_str()
            .is_some_and(|by| !by.is_empty())
        && value["client_information"].is_object()
        && value["client_information"]["client_id"].is_string()
        && value["tokens"].is_object()
        && value["tokens"]["access_token"].is_string()
        && value["tokens"]["token_type"].is_string()
}

/// Node `resolveCredentialGeneration`: the stored generation, else a legacy hash of the raw text.
fn generation_of(canonical: &Value, raw: &str) -> String {
    match canonical["generation"].as_str() {
        Some(generation) if !generation.is_empty() => generation.to_owned(),
        _ => {
            let digest = Sha256::digest(raw.as_bytes());
            let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            format!("legacy-{}", &hex[..32])
        }
    }
}

fn parse(raw: Option<&str>) -> Option<Value> {
    serde_json::from_str::<Value>(raw?).ok()
}
