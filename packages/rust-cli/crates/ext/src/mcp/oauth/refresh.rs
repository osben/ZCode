//! Refresh of the canonical access token under the refresh lock (Node `oauth-refresh.ts`,
//! `refreshMcpOAuthTokensUnderLock`; `specs/fork-rust-mcp-oauth.md`, PR3).
//!
//! Two callers may hold the same refresh token. The second one must not spend it again: it waits for the
//! lock, re-reads the credentials, and reuses the first caller's token when the generation has advanced.
//! Credentials are dropped only on a deterministic rejection (`invalid_grant`, `invalid_client`); a
//! network failure, a 5xx or a timeout keeps them.

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::flow::{discover, publish_canonical};
use super::keys::credential_key;
use super::protocol::basic_auth;
use super::store::{
    McpOAuthRuntime, McpOAuthStore, McpOAuthStoreError, McpOAuthWrite, OAuthHttpError,
    OAuthHttpRequest,
};

const CANONICAL_KEY: &str = "authorization_credentials";
const LEGACY_CLIENT_KEY: &str = "client_information";
const LEGACY_TOKENS_KEY: &str = "tokens";

/// Why a refresh did not produce a token. The message of each variant never contains a token or secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshError {
    /// The grant is missing or was rejected; interactive authorization is required (Node
    /// `createInteractiveAuthorizationRequiredError`, `reason`).
    InteractiveRequired { reason: &'static str },
    /// A statically configured client was rejected. Nothing was deleted: re-authorizing with the same
    /// client would loop, so the configuration must be fixed.
    Configuration(String),
    /// A network, 5xx or store failure. The credentials were kept.
    Temporary(String),
}

/// What one refresh needs from the server row. Strings are owned: the refresh may outlive the caller's borrow.
#[derive(Debug, Clone)]
pub struct RefreshInput {
    pub server_name: String,
    pub server_url: String,
    pub key_prefix: String,
    /// The `client_id` of a statically configured client (Node `staticClientId`).
    pub static_client_id: Option<String>,
    pub client_secret: Option<String>,
    /// `true` after a 401 (Node `reactive`): a failed refresh cannot fall back to the rejected token.
    pub reactive: bool,
}

/// The canonical record as read under the lock: the raw text for compare-and-swap, the parsed pieces, and
/// the generation (the stored one, or the legacy hash of the raw text for records without one).
struct Snapshot {
    raw: String,
    generation: String,
    client: Value,
    tokens: Value,
    issuer: Option<String>,
}

impl Snapshot {
    fn access_token(&self) -> Option<String> {
        self.tokens["access_token"].as_str().map(str::to_owned)
    }
}

/// Node `loadCanonicalCredentials` (versions 1 and 2 only). An unreadable record is absent.
async fn load_snapshot(
    store: &dyn McpOAuthStore,
    key_prefix: &str,
) -> Result<Option<Snapshot>, McpOAuthStoreError> {
    let Some(raw) = store
        .load(&credential_key(key_prefix, CANONICAL_KEY))
        .await?
    else {
        return Ok(None);
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None);
    };
    let version_ok = matches!(parsed["version"].as_i64(), Some(1 | 2));
    let usable = version_ok
        && parsed["client_information"].is_object()
        && parsed["tokens"].is_object()
        && parsed["published_by"]
            .as_str()
            .is_some_and(|by| !by.is_empty());
    if !usable {
        return Ok(None);
    }
    let generation = match parsed["generation"].as_str() {
        Some(generation) if !generation.is_empty() => generation.to_owned(),
        _ => {
            let digest = Sha256::digest(raw.as_bytes());
            let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            format!("legacy-{}", &hex[..32])
        }
    };
    Ok(Some(Snapshot {
        generation,
        client: parsed["client_information"].clone(),
        tokens: parsed["tokens"].clone(),
        issuer: parsed["issuer"].as_str().map(str::to_owned),
        raw,
    }))
}

fn store_failure(error: McpOAuthStoreError) -> RefreshError {
    RefreshError::Temporary(error.0)
}

/// Refresh the access token and return a usable one (Node `refreshMcpOAuthTokensUnderLock`).
///
/// Order: read the observed generation, take the refresh lock, re-read under the lock, coalesce on a
/// generation change, then one token request. The lock is released on every path.
pub async fn refresh_under_lock(
    store: &dyn McpOAuthStore,
    runtime: &dyn McpOAuthRuntime,
    input: &RefreshInput,
) -> Result<String, RefreshError> {
    let observed = load_snapshot(store, &input.key_prefix)
        .await
        .map_err(store_failure)?;
    let observed_generation = observed
        .as_ref()
        .map(|snapshot| snapshot.generation.clone());

    let Some(lease) = store
        .try_acquire_refresh_lock(&input.key_prefix)
        .await
        .map_err(store_failure)?
    else {
        // The wait ran out. The winner may have published a token meanwhile: reuse it when the generation
        // has moved, otherwise report a temporary failure (Node: re-read after a lock timeout).
        let current = load_snapshot(store, &input.key_prefix)
            .await
            .map_err(store_failure)?;
        return match current {
            Some(current)
                if Some(&current.generation) != observed_generation.as_ref()
                    && current.access_token().is_some() =>
            {
                Ok(current.access_token().unwrap_or_default())
            }
            _ => Err(RefreshError::Temporary(
                "the refresh lock was not released in time".to_owned(),
            )),
        };
    };

    let result = refresh_locked(store, runtime, input, observed_generation).await;
    lease.release().await;
    result
}

async fn refresh_locked(
    store: &dyn McpOAuthStore,
    runtime: &dyn McpOAuthRuntime,
    input: &RefreshInput,
    observed_generation: Option<String>,
) -> Result<String, RefreshError> {
    let current = load_snapshot(store, &input.key_prefix)
        .await
        .map_err(store_failure)?;
    // Coalesce: another caller refreshed while this one waited. Its token is used without a second request,
    // which would otherwise trigger the authorization server's refresh-token reuse detection.
    if let Some(current) = &current
        && observed_generation.as_deref() != Some(current.generation.as_str())
        && let Some(access) = current.access_token()
    {
        return Ok(access);
    }
    let Some(current) = current else {
        return Err(RefreshError::InteractiveRequired {
            reason: "no_credentials",
        });
    };
    let Some(refresh_token) = current.tokens["refresh_token"].as_str().map(str::to_owned) else {
        return Err(RefreshError::InteractiveRequired {
            reason: "no_refresh_token",
        });
    };
    let client_id = current.client["client_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();

    // A discovery failure is never an invalid grant: it is handled like a network failure.
    let (authorization_server, metadata) = match discover(runtime, &input.server_url).await {
        Ok(found) => found,
        Err(message) => return fail_soft(input, &current, message),
    };
    let Some(endpoint) = metadata["token_endpoint"].as_str() else {
        return fail_soft(
            input,
            &current,
            "the authorization server has no token endpoint".to_owned(),
        );
    };

    // Built as plain pairs: a form serializer kept alive across the await would make the future non-Send.
    let mut pairs = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
    ];
    let mut headers = vec![
        (
            "Content-Type".to_owned(),
            "application/x-www-form-urlencoded".to_owned(),
        ),
        ("Accept".to_owned(), "application/json".to_owned()),
    ];
    match &input.client_secret {
        Some(secret) => headers.push(("Authorization".to_owned(), basic_auth(&client_id, secret))),
        None => pairs.push(("client_id", client_id.as_str())),
    }
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish();
    let response = match runtime
        .http(OAuthHttpRequest {
            method: "POST",
            url: endpoint.to_owned(),
            headers,
            body: Some(body),
        })
        .await
    {
        Ok(response) => response,
        Err(OAuthHttpError(message)) => {
            return fail_soft(input, &current, format!("request failed: {message}"));
        }
    };

    if response.status >= 400 && response.status < 500 {
        match error_code(&response.body).as_deref() {
            Some("invalid_grant") => {
                // Deterministic: the refresh token is revoked or expired. The client stays as the seed for re-authorization.
                invalidate(store, &input.key_prefix, &current, false).await?;
                return Err(RefreshError::InteractiveRequired {
                    reason: "invalid_grant",
                });
            }
            Some("invalid_client" | "unauthorized_client") => {
                if input.static_client_id.is_some() {
                    return Err(RefreshError::Configuration(format!(
                        "MCP server {} OAuth client was rejected by the authorization server (invalid_client); fix the configured clientId",
                        input.server_name
                    )));
                }
                invalidate(store, &input.key_prefix, &current, true).await?;
                return Err(RefreshError::InteractiveRequired {
                    reason: "invalid_client",
                });
            }
            _ => {}
        }
    }
    if response.status >= 400 {
        return fail_soft(
            input,
            &current,
            format!("HTTP {} refreshing the token", response.status),
        );
    }

    let Ok(mut tokens) = serde_json::from_str::<Value>(&response.body) else {
        return fail_soft(
            input,
            &current,
            "the token response is not valid JSON".to_owned(),
        );
    };
    let Some(access) = tokens["access_token"].as_str().map(str::to_owned) else {
        return fail_soft(
            input,
            &current,
            "the token response has no access token".to_owned(),
        );
    };
    // A response may omit the refresh token (RFC 6749 section 6): keep the one that was spent.
    if tokens["refresh_token"].is_null() {
        tokens["refresh_token"] = Value::String(refresh_token);
    }
    let issuer = current
        .issuer
        .clone()
        .unwrap_or_else(|| authorization_server.clone());
    publish_canonical(
        store,
        runtime,
        &input.key_prefix,
        &current.client,
        &tokens,
        &issuer,
        &format!("refresh:{}", input.key_prefix),
    )
    .await
    .map_err(RefreshError::Temporary)?;
    Ok(access)
}

/// Drop the tokens (and the client when `include_client`) only if the canonical record is still the one that
/// was observed (Node `invalidateCanonicalCredentials`). A newer publication survives.
async fn invalidate(
    store: &dyn McpOAuthStore,
    key_prefix: &str,
    current: &Snapshot,
    include_client: bool,
) -> Result<(), RefreshError> {
    let canonical = credential_key(key_prefix, CANONICAL_KEY);
    let mut keys = vec![
        canonical.clone(),
        credential_key(key_prefix, LEGACY_TOKENS_KEY),
    ];
    if include_client {
        keys.push(credential_key(key_prefix, LEGACY_CLIENT_KEY));
    }
    store
        .apply(&[McpOAuthWrite::DeleteGuarded {
            guard_key: canonical,
            expected: current.raw.clone(),
            keys,
        }])
        .await
        .map_err(store_failure)
}

/// A failure that keeps the credentials. Reactive refresh must not return the token the server just rejected;
/// proactive refresh may return the current token and let the request decide (Node `failSoft`).
fn fail_soft(
    input: &RefreshInput,
    current: &Snapshot,
    message: String,
) -> Result<String, RefreshError> {
    match current.access_token() {
        Some(access) if !input.reactive => Ok(access),
        _ => Err(RefreshError::Temporary(message)),
    }
}

fn error_code(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("error")?
        .as_str()
        .map(str::to_owned)
}
