//! Lead/follower authorization flow (Node `oauth-interactive.ts`, SDK `auth()` steps 2 to 8).
//!
//! One caller wins the authorization lease and runs the transaction: discovery, a fresh DCR (the
//! loopback port changes per flow, so the redirect URI must be registered per flow), PKCE, the
//! pending record, the callback wait and the code exchange. Every other caller is a follower and only
//! reports the pending URL. The lease is released and the pending record removed (attempt-owned) on
//! every outcome. Credentials are written only after a successful exchange.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::callback::{CallbackError, CallbackParams, parse_callback_target};
use super::keys::{credential_key, credential_key_prefix};
use super::lease::{delete_pending_if_owned, publish_pending};
use super::pkce::{code_challenge, verifier_from_bytes};
use super::protocol::{
    as_metadata_urls, prm_urls, registration_body, token_form_authorization_code,
};
use super::record::{PendingAuthorization, load_canonical, load_pending};
use super::store::{
    LoopbackConnection, LoopbackListener, McpOAuthRuntime, McpOAuthStore, McpOAuthStoreError,
    McpOAuthWrite, OAuthHttpError, OAuthHttpRequest, OAuthHttpResponse,
};

/// Same value as the Rust MCP client (`PROTOCOL_VERSION`), sent on discovery requests like the SDK.
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const DEFAULT_CALLBACK_PATH: &str = "/callback";

/// What the flow needs from the server row. The identity fields hash into the credential key prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowInput {
    pub server_name: String,
    pub server_url: String,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub client_name: String,
    pub scope: Option<String>,
    pub redirect_path: Option<String>,
    /// Lifetime of the transaction: the pending record and the callback wait (Node: 5 minutes).
    pub transaction_ttl_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlowOutcome {
    /// This call completed the exchange and published canonical credentials.
    Authorized,
    /// Another caller holds the lease; `authorization_url` is the pending URL when one is published.
    Pending { authorization_url: Option<String> },
    /// The transaction failed. The message never contains a token, code, verifier or secret.
    Failed { message: String },
}

/// Run the flow as lead, or as follower when the lease is held. Never panics on server answers.
pub async fn run_lead(
    store: &dyn McpOAuthStore,
    runtime: &dyn McpOAuthRuntime,
    input: &FlowInput,
    cancel: &CancellationToken,
) -> FlowOutcome {
    let key_prefix = key_prefix_of(input);
    let lease = match store.try_acquire_lease(&key_prefix).await {
        Ok(Some(lease)) => lease,
        Ok(None) => return follower(store, runtime, &key_prefix).await,
        Err(error) => return failed(error),
    };
    let attempt_id = match random_hex(runtime, 16) {
        Ok(id) => id,
        Err(message) => return FlowOutcome::Failed { message },
    };
    let outcome = lead(store, runtime, input, &key_prefix, &attempt_id, cancel).await;
    // Remove only this attempt's pending record, then release the lease (Node `finally`).
    let _ = delete_pending_if_owned(store, &key_prefix, &attempt_id).await;
    lease.release().await;
    outcome
}

fn key_prefix_of(input: &FlowInput) -> String {
    credential_key_prefix(
        &input.server_name,
        &input.server_url,
        input.client_id.as_deref(),
        input.scope.as_deref(),
        input.redirect_path.as_deref(),
    )
}

async fn follower(
    store: &dyn McpOAuthStore,
    runtime: &dyn McpOAuthRuntime,
    key_prefix: &str,
) -> FlowOutcome {
    match load_pending(store, key_prefix, runtime.now_ms()).await {
        Ok(pending) => FlowOutcome::Pending {
            authorization_url: pending.map(|p| p.authorization_url),
        },
        Err(error) => failed(error),
    }
}

async fn lead(
    store: &dyn McpOAuthStore,
    runtime: &dyn McpOAuthRuntime,
    input: &FlowInput,
    key_prefix: &str,
    attempt_id: &str,
    cancel: &CancellationToken,
) -> FlowOutcome {
    match run_transaction(store, runtime, input, key_prefix, attempt_id, cancel).await {
        Ok(()) => FlowOutcome::Authorized,
        Err(message) => FlowOutcome::Failed { message },
    }
}

async fn run_transaction(
    store: &dyn McpOAuthStore,
    runtime: &dyn McpOAuthRuntime,
    input: &FlowInput,
    key_prefix: &str,
    attempt_id: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let baseline = load_canonical(store, key_prefix)
        .await
        .map_err(stage("read credentials"))?
        .map(|c| c.generation);
    let listener = runtime
        .bind_loopback()
        .await
        .map_err(stage("start the callback listener"))?;
    let callback_path = input
        .redirect_path
        .clone()
        .unwrap_or_else(|| DEFAULT_CALLBACK_PATH.to_owned());
    let redirect_uri = format!(
        "http://127.0.0.1:{}{callback_path}",
        listener.local_addr().port()
    );

    let (authorization_server, metadata) = discover(runtime, &input.server_url).await?;
    let client = match &input.client_id {
        Some(client_id) => json!({ "client_id": client_id }),
        None => register(runtime, &metadata, input, &redirect_uri).await?,
    };
    let client_id = client["client_id"]
        .as_str()
        .ok_or("client registration returned no client_id")?
        .to_owned();

    let verifier = verifier_from_bytes(&random(runtime, 32)?);
    let state = URL_SAFE_NO_PAD.encode(random(runtime, 24)?);
    let authorization_url = authorization_url(
        &metadata,
        &client_id,
        &code_challenge(&verifier),
        &redirect_uri,
        &state,
        input.scope.as_deref(),
    )?;
    let now = runtime.now_ms();
    publish_pending(
        store,
        key_prefix,
        &PendingAuthorization {
            attempt_id: attempt_id.to_owned(),
            authorization_url,
            baseline_generation: baseline,
            expires_at: now + input.transaction_ttl_ms,
            state: state.clone(),
        },
    )
    .await
    .map_err(stage("publish the pending authorization"))?;
    save_discovery(store, key_prefix, &authorization_server, &metadata, now).await?;

    let ttl = Duration::from_millis(input.transaction_ttl_ms.max(0) as u64);
    let waited = tokio::select! {
        result = tokio::time::timeout(ttl, wait_for_callback(listener, &callback_path, &state)) => result
            .map_err(|_| "the authorization was not completed before it expired".to_owned())?,
        () = cancel.cancelled() => return Err("the authorization was cancelled".to_owned()),
    };
    let params = waited?;

    let tokens = exchange_code(
        runtime,
        &metadata,
        &client,
        input,
        &params.code,
        &verifier,
        &redirect_uri,
    )
    .await?;
    publish_canonical(
        store,
        runtime,
        key_prefix,
        &client,
        &tokens,
        &authorization_server,
        attempt_id,
    )
    .await
}

/// Prefix a store or transport error with what the flow was doing. The error text is never a token.
fn stage<E: std::fmt::Display>(what: &'static str) -> impl Fn(E) -> String {
    move |error| format!("could not {what}: {error}")
}

fn failed(error: McpOAuthStoreError) -> FlowOutcome {
    FlowOutcome::Failed {
        message: error.to_string(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn random(runtime: &dyn McpOAuthRuntime, len: usize) -> Result<Vec<u8>, String> {
    runtime
        .random_bytes(len)
        .map_err(|OAuthHttpError(message)| format!("could not draw random bytes: {message}"))
}

fn random_hex(runtime: &dyn McpOAuthRuntime, len: usize) -> Result<String, String> {
    random(runtime, len).map(|bytes| hex(&bytes))
}

/// `(authorization server URL, AS metadata)`: protected-resource metadata first, then the origin.
pub(super) async fn discover(
    runtime: &dyn McpOAuthRuntime,
    server_url: &str,
) -> Result<(String, Value), String> {
    // SDK order: a 2xx answers; a 4xx (or 502) moves to the next URL; any other failure ends the PRM
    // lookup, and the SDK then uses the server origin. A broken PRM document is treated the same way.
    let mut authorization_server = None;
    for url in prm_urls(server_url)? {
        let response = get(runtime, &url).await?;
        if (200..300).contains(&response.status) {
            authorization_server = parse_json(&response.body, "protected resource metadata")
                .ok()
                .and_then(|prm: Value| prm["authorization_servers"][0].as_str().map(str::to_owned));
            break;
        }
        if response.status >= 500 && response.status != 502 {
            break;
        }
    }
    let authorization_server = match authorization_server {
        Some(server) => server,
        None => {
            let origin = Url::parse(server_url).map_err(|e| e.to_string())?;
            format!("{}/", origin.origin().ascii_serialization())
        }
    };
    let metadata = as_metadata(runtime, &authorization_server).await?;
    Ok((authorization_server, metadata))
}

/// RFC 8414 / OIDC metadata, first document that answers 2xx. A 4xx (except 502) skips to the next URL.
async fn as_metadata(
    runtime: &dyn McpOAuthRuntime,
    authorization_server: &str,
) -> Result<Value, String> {
    let expected = authorization_server
        .strip_suffix('/')
        .unwrap_or(authorization_server);
    for url in as_metadata_urls(authorization_server)? {
        let response = get(runtime, &url).await?;
        if response.status >= 400 {
            if response.status < 500 || response.status == 502 {
                continue;
            }
            return Err(format!(
                "HTTP {} loading authorization server metadata",
                response.status
            ));
        }
        let metadata: Value = parse_json(&response.body, "authorization server metadata")?;
        let issuer = metadata["issuer"].as_str().unwrap_or_default();
        if issuer.strip_suffix('/').unwrap_or(issuer) != expected {
            return Err(
                "authorization server metadata issuer does not match the server".to_owned(),
            );
        }
        return Ok(metadata);
    }
    Err("no authorization server metadata was found".to_owned())
}

async fn register(
    runtime: &dyn McpOAuthRuntime,
    metadata: &Value,
    input: &FlowInput,
    redirect_uri: &str,
) -> Result<Value, String> {
    let endpoint = metadata["registration_endpoint"]
        .as_str()
        .ok_or("the authorization server does not support dynamic client registration")?;
    let mut body = registration_body(redirect_uri, &input.client_name, input.scope.as_deref());
    if input.client_secret.is_some() {
        body["token_endpoint_auth_method"] = json!("client_secret_basic");
    }
    let response = send(
        runtime,
        OAuthHttpRequest {
            method: "POST",
            url: endpoint.to_owned(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: Some(body.to_string()),
        },
    )
    .await?;
    if response.status >= 400 {
        return Err(format!("HTTP {} registering the client", response.status));
    }
    let mut client: Value = parse_json(&response.body, "client registration")?;
    if let Some(secret) = &input.client_secret {
        client["client_secret"] = json!(secret);
    }
    Ok(client)
}

fn authorization_url(
    metadata: &Value,
    client_id: &str,
    challenge: &str,
    redirect_uri: &str,
    state: &str,
    scope: Option<&str>,
) -> Result<String, String> {
    let endpoint = metadata["authorization_endpoint"]
        .as_str()
        .ok_or("the authorization server has no authorization endpoint")?;
    let mut url = Url::parse(endpoint).map_err(|e| e.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("state", state);
        if let Some(scope) = scope {
            query.append_pair("scope", scope);
        }
    }
    Ok(url.to_string())
}

async fn save_discovery(
    store: &dyn McpOAuthStore,
    key_prefix: &str,
    authorization_server: &str,
    metadata: &Value,
    now: i64,
) -> Result<(), String> {
    let state = json!({
        "authorizationServerUrl": authorization_server,
        "authorizationServerMetadata": metadata,
    });
    store
        .apply(&[
            McpOAuthWrite::Put {
                key: credential_key(key_prefix, "discovery_state"),
                value: state.to_string(),
            },
            McpOAuthWrite::Put {
                key: credential_key(key_prefix, "discovery_state_fetched_at"),
                value: now.to_string(),
            },
        ])
        .await
        .map_err(stage("save discovery"))
}

/// Wait until the browser delivers the authorization response. A request for another path or with a
/// wrong `state` gets an error page and the wait continues; a denial or a missing code ends the flow.
async fn wait_for_callback(
    mut listener: Box<dyn LoopbackListener>,
    callback_path: &str,
    state: &str,
) -> Result<CallbackParams, String> {
    loop {
        let mut connection = listener
            .accept()
            .await
            .map_err(|error| format!("callback listener failed: {error}"))?;
        let target = connection
            .request_target()
            .await
            .map_err(|error| format!("callback request failed: {error}"))?;
        match parse_callback_target(&target, callback_path, state) {
            Ok(params) => {
                respond(
                    &mut connection,
                    200,
                    "Authorization complete. You can close this window.",
                )
                .await;
                return Ok(params);
            }
            Err(CallbackError::NotCallbackPath | CallbackError::StateMismatch) => {
                respond(&mut connection, 404, "Not found").await;
            }
            Err(CallbackError::Denied(error)) => {
                respond(&mut connection, 400, "Authorization was not granted.").await;
                return Err(format!(
                    "the authorization server returned an error: {error}"
                ));
            }
            Err(CallbackError::MissingCode) => {
                respond(&mut connection, 400, "Missing authorization code.").await;
                return Err("the authorization response had no code".to_owned());
            }
        }
    }
}

async fn respond(connection: &mut Box<dyn LoopbackConnection>, status: u16, body: &str) {
    let _ = connection.respond(status, body).await;
}

async fn exchange_code(
    runtime: &dyn McpOAuthRuntime,
    metadata: &Value,
    client: &Value,
    input: &FlowInput,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<Value, String> {
    let endpoint = metadata["token_endpoint"]
        .as_str()
        .ok_or("the authorization server has no token endpoint")?;
    let client_id = client["client_id"].as_str().unwrap_or_default();
    let mut form = token_form_authorization_code(code, verifier, redirect_uri);
    let mut headers = vec![
        (
            "Content-Type".into(),
            "application/x-www-form-urlencoded".into(),
        ),
        ("Accept".into(), "application/json".into()),
    ];
    match &input.client_secret {
        Some(secret) => {
            let basic = STANDARD.encode(format!("{client_id}:{secret}"));
            headers.push(("Authorization".into(), format!("Basic {basic}")));
        }
        None => {
            let mut serializer = url::form_urlencoded::Serializer::new(form);
            serializer.append_pair("client_id", client_id);
            form = serializer.finish();
        }
    }
    let response = send(
        runtime,
        OAuthHttpRequest {
            method: "POST",
            url: endpoint.to_owned(),
            headers,
            body: Some(form),
        },
    )
    .await?;
    if response.status >= 400 {
        // The body is not included: a token endpoint error page could echo credentials.
        return Err(format!(
            "HTTP {} exchanging the authorization code",
            response.status
        ));
    }
    let tokens: Value = parse_json(&response.body, "token response")?;
    if tokens["access_token"].as_str().is_none() {
        return Err("the token response has no access token".to_owned());
    }
    Ok(tokens)
}

/// Node `publishCanonicalCredentials`: canonical v2 record and the legacy `client_information` and
/// `tokens` keys, written in one batch so no reader sees one without the other.
async fn publish_canonical(
    store: &dyn McpOAuthStore,
    runtime: &dyn McpOAuthRuntime,
    key_prefix: &str,
    client: &Value,
    tokens: &Value,
    issuer: &str,
    attempt_id: &str,
) -> Result<(), String> {
    let now = runtime.now_ms();
    let generation = format!("gen-{}", random_hex(runtime, 16)?);
    let mut canonical = json!({
        "client_information": client,
        "tokens": tokens,
        "generation": generation,
        "obtained_at": now,
        "issuer": issuer,
        "published_by": attempt_id,
        "version": 2,
    });
    if let Some(expires_in) = tokens["expires_in"].as_i64() {
        canonical["expires_at"] = json!(now + expires_in * 1000);
    }
    store
        .apply(&[
            McpOAuthWrite::Put {
                key: credential_key(key_prefix, "authorization_credentials"),
                value: canonical.to_string(),
            },
            McpOAuthWrite::Put {
                key: credential_key(key_prefix, "client_information"),
                value: client.to_string(),
            },
            McpOAuthWrite::Put {
                key: credential_key(key_prefix, "tokens"),
                value: tokens.to_string(),
            },
        ])
        .await
        .map_err(stage("publish credentials"))
}

async fn get(runtime: &dyn McpOAuthRuntime, url: &str) -> Result<OAuthHttpResponse, String> {
    send(
        runtime,
        OAuthHttpRequest {
            method: "GET",
            url: url.to_owned(),
            headers: vec![
                ("MCP-Protocol-Version".into(), MCP_PROTOCOL_VERSION.into()),
                ("Accept".into(), "application/json".into()),
            ],
            body: None,
        },
    )
    .await
}

async fn send(
    runtime: &dyn McpOAuthRuntime,
    request: OAuthHttpRequest,
) -> Result<OAuthHttpResponse, String> {
    runtime
        .http(request)
        .await
        .map_err(|OAuthHttpError(message)| format!("request failed: {message}"))
}

fn parse_json(body: &str, what: &str) -> Result<Value, String> {
    serde_json::from_str(body).map_err(|_| format!("the {what} is not valid JSON"))
}
