//! Refresh of the canonical access token under the refresh lock (Node `oauth-refresh.ts`,
//! `refreshMcpOAuthTokensUnderLock`; `specs/fork-rust-mcp-oauth.md`, PR3 and PR4).
//!
//! Two callers may hold the same refresh token. The second one must not spend it again: it waits for the
//! lock, re-reads the credentials, and reuses the first caller's token when the generation has advanced.
//! Credentials are dropped only on a deterministic rejection (`invalid_grant`, `invalid_client`); a
//! network failure, a 5xx or a timeout keeps them.

use serde_json::Value;
use url::Url;

use super::flow::{Discovered, discover, publish_canonical, save_discovery};
use super::keys::credential_key;
use super::pair::{CredentialPair, load_pair};
use super::protocol::basic_auth;
use super::record::load_discovery;
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

/// Refresh the access token and return a usable one (Node `refreshMcpOAuthTokensUnderLock`).
///
/// Order: read the observed generation, take the refresh lock, re-read under the lock, coalesce on a
/// generation change, then one token request. The lock is released on every path.
pub async fn refresh_under_lock(
    store: &dyn McpOAuthStore,
    runtime: &dyn McpOAuthRuntime,
    input: &RefreshInput,
) -> Result<String, RefreshError> {
    let observed = load_pair(store, &input.key_prefix)
        .await
        .map_err(store_failure)?
        .and_then(|pair| pair.generation);

    let Some(lease) = store
        .try_acquire_refresh_lock(&input.key_prefix)
        .await
        .map_err(store_failure)?
    else {
        // The wait ran out. The winner may have published a token meanwhile: reuse it when the generation
        // has moved, otherwise report a temporary failure (Node: re-read after a lock timeout).
        let current = load_pair(store, &input.key_prefix)
            .await
            .map_err(store_failure)?;
        return match current.and_then(|pair| {
            (pair.generation != observed)
                .then(|| pair.access_token())
                .flatten()
        }) {
            Some(access) => Ok(access),
            None => Err(RefreshError::Temporary(
                "the refresh lock was not released in time".to_owned(),
            )),
        };
    };

    let result = refresh_locked(store, runtime, input, observed).await;
    lease.release().await;
    result
}

async fn refresh_locked(
    store: &dyn McpOAuthStore,
    runtime: &dyn McpOAuthRuntime,
    input: &RefreshInput,
    observed_generation: Option<String>,
) -> Result<String, RefreshError> {
    let current = load_pair(store, &input.key_prefix)
        .await
        .map_err(store_failure)?;
    // Coalesce: another caller refreshed while this one waited. Its token is used without a second request,
    // which would otherwise trigger the authorization server's refresh-token reuse detection.
    if let Some(current) = &current
        && current.generation != observed_generation
        && let Some(access) = current.access_token()
    {
        return Ok(access);
    }
    let Some(current) = current.filter(|pair| pair.tokens.is_some()) else {
        return Err(RefreshError::InteractiveRequired {
            reason: "no_credentials",
        });
    };
    let (Some(refresh_token), Some(client)) = (current.refresh_token(), current.client.clone())
    else {
        return Err(RefreshError::InteractiveRequired {
            reason: "no_refresh_token",
        });
    };
    let client_id = client["client_id"].as_str().unwrap_or_default().to_owned();

    // A discovery failure is never an invalid grant: it is handled like a network failure.
    let resolved = match resolve_authorization_server(store, runtime, input, &current).await {
        Ok(resolved) => resolved,
        // A credential-store failure is a temporary error (the credentials were kept), not a discovery failure.
        Err(ResolveFailure::Store(message)) => return Err(RefreshError::Temporary(message)),
        Err(ResolveFailure::Discovery(message)) => return fail_soft(input, &current, message),
    };
    let Some(endpoint) = resolved.metadata["token_endpoint"].as_str() else {
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
    // Same rule as the code exchange (`flow::exchange_code`): the registered client's secret authenticates when the
    // configuration has none.
    let secret = input
        .client_secret
        .clone()
        .or_else(|| client["client_secret"].as_str().map(str::to_owned));
    match secret {
        Some(secret) => headers.push(("Authorization".to_owned(), basic_auth(&client_id, &secret))),
        None => pairs.push(("client_id", client_id.as_str())),
    }
    // RFC 8707: the SDK sends `resource` with the refresh when the metadata names one (Node `refreshAuthorization`).
    if let Some(resource) = resolved.resource.as_deref() {
        pairs.push(("resource", resource));
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
    publish_canonical(
        store,
        runtime,
        &input.key_prefix,
        &client,
        &tokens,
        current.issuer.as_deref(),
        &format!("refresh:{}", input.key_prefix),
    )
    .await
    .map_err(RefreshError::Temporary)?;
    Ok(access)
}

/// The authorization server metadata and the RFC 8707 resource for a refresh (Node `resolveAsMetadata`).
struct Resolved {
    metadata: Value,
    resource: Option<String>,
}

/// The cached discovery record when it is fresh and matches the stored issuer (Node `loadDiscoveryRecord`).
/// Otherwise discover and save the record, so the next refresh within 24 h makes no discovery request.
/// Why the authorization server could not be resolved. A store failure keeps the credentials and is a temporary error;
/// a discovery or resource failure is handled like a network failure.
enum ResolveFailure {
    Store(String),
    Discovery(String),
}

async fn resolve_authorization_server(
    store: &dyn McpOAuthStore,
    runtime: &dyn McpOAuthRuntime,
    input: &RefreshInput,
    current: &CredentialPair,
) -> Result<Resolved, ResolveFailure> {
    let now = runtime.now_ms();
    let cached = load_discovery(store, &input.key_prefix, current.issuer.as_deref(), now)
        .await
        .map_err(|error| ResolveFailure::Store(error.to_string()))?;
    let found = match cached.filter(|state| state["authorizationServerMetadata"].is_object()) {
        Some(state) => Discovered {
            authorization_server: state["authorizationServerUrl"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            metadata: state["authorizationServerMetadata"].clone(),
            resource_metadata: state
                .get("resourceMetadata")
                .filter(|value| value.is_object())
                .cloned(),
        },
        None => {
            let found = discover(runtime, &input.server_url, None)
                .await
                .map_err(ResolveFailure::Discovery)?;
            save_discovery(
                store,
                &input.key_prefix,
                &found.authorization_server,
                &found.metadata,
                found.resource_metadata.as_ref(),
                now,
            )
            .await
            .map_err(ResolveFailure::Store)?;
            found
        }
    };
    let resource = select_resource(&input.server_url, found.resource_metadata.as_ref())
        .map_err(ResolveFailure::Discovery)?;
    Ok(Resolved {
        metadata: found.metadata,
        resource,
    })
}

/// The SDK's `selectResourceURL` with an empty provider: the protected-resource metadata's `resource`, provided
/// it covers the server URL (`checkResourceAllowed`: same origin, and the path prefix with a trailing slash).
/// Without metadata there is no `resource`. A metadata `resource` that does not cover the server is an error.
fn select_resource(
    server_url: &str,
    resource_metadata: Option<&Value>,
) -> Result<Option<String>, String> {
    let Some(metadata) = resource_metadata else {
        return Ok(None);
    };
    let configured = metadata["resource"]
        .as_str()
        .ok_or("the protected resource metadata has no resource")?;
    let mut requested = Url::parse(server_url).map_err(|error| error.to_string())?;
    requested.set_fragment(None);
    let configured = Url::parse(configured).map_err(|error| error.to_string())?;
    let with_slash = |path: &str| {
        if path.ends_with('/') {
            path.to_owned()
        } else {
            format!("{path}/")
        }
    };
    let covers = requested.origin() == configured.origin()
        && requested.path().len() >= configured.path().len()
        && with_slash(requested.path()).starts_with(&with_slash(configured.path()));
    if !covers {
        return Err(format!(
            "protected resource {configured} does not match {requested}"
        ));
    }
    Ok(Some(configured.to_string()))
}

fn store_failure(error: McpOAuthStoreError) -> RefreshError {
    RefreshError::Temporary(error.0)
}

/// Drop the tokens (and the client when `include_client`) only if the canonical record is still the one that
/// was observed (Node `invalidateCanonicalCredentials`). A newer publication survives. A legacy-derived pair has
/// no canonical record to compare, so nothing is dropped (Node: `if (current.raw)`).
async fn invalidate(
    store: &dyn McpOAuthStore,
    key_prefix: &str,
    current: &CredentialPair,
    include_client: bool,
) -> Result<(), RefreshError> {
    let Some(raw) = &current.raw else {
        return Ok(());
    };
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
            expected: raw.clone(),
            keys,
        }])
        .await
        .map_err(store_failure)
}

/// A failure that keeps the credentials. Reactive refresh must not return the token the server just rejected;
/// proactive refresh may return the current token and let the request decide (Node `failSoft`).
fn fail_soft(
    input: &RefreshInput,
    current: &CredentialPair,
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
