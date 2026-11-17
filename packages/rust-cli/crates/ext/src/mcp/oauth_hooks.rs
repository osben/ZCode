//! Connection-side OAuth hooks of the MCP manager (`specs/fork-rust-mcp-oauth.md`, PR2).
//!
//! The manager calls three things from here: [`Inner::with_oauth_bearer`] before each connect attempt,
//! [`Inner::start_oauth_on_challenge`] when a connect fails with HTTP 401, and [`McpManager::enable_oauth`]
//! once at wiring time. Keeping them here leaves `manager.rs` with call sites only.

use std::collections::BTreeMap;
use std::sync::{Arc, Weak};

use rust_cli_kernel_api::mcp::McpTransportConfig;

use super::config::{McpScope, McpServer};
use super::connection::ConnectFailure;
use super::manager::{Inner, McpManager};
use super::oauth::{
    McpOAuthConfig, McpOAuthCoordinator, McpOAuthRuntime, McpOAuthStore, ReconnectFn, RefreshError,
    RefreshInput, is_authorization_challenge, parse_www_authenticate,
};
use super::rpc::Client;

/// What a 401 on connect leads to (see [`Inner::refresh_on_challenge`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ChallengeRefresh {
    /// The token was refreshed: retry the connect once with the new bearer.
    Retry,
    /// The grant is invalid or absent: start the authorization flow.
    Reauthorize,
    /// The refresh failed temporarily or the static client was rejected: keep the credentials, report the failure.
    Failed,
}

#[cfg(test)]
#[path = "oauth_hooks_tests.rs"]
mod tests;

/// The OAuth config a server acts on. Node treats a remote server with no `oauth` block as
/// `authorization_code` (`resolveAuthorizationCodeOAuthConfig`), unless its headers already carry an
/// `Authorization` header. User and plugin servers do so here, as they do in Node.
fn effective_oauth(config: &McpServer) -> Option<McpOAuthConfig> {
    if let Some(oauth) = &config.oauth {
        return Some(oauth.clone());
    }
    let (_, headers) = remote_parts(config)?;
    let has_authorization = headers
        .keys()
        .any(|name| name.eq_ignore_ascii_case("authorization"));
    (!has_authorization && matches!(config.scope, McpScope::User | McpScope::Plugin)).then_some(
        McpOAuthConfig::AuthorizationCode {
            client_id: None,
            client_secret: None,
            client_name: None,
            redirect_path: None,
            scope: None,
        },
    )
}

/// The URL and headers of a remote (HTTP or SSE) transport.
fn remote_parts(config: &McpServer) -> Option<(&str, &BTreeMap<String, String>)> {
    match &config.transport {
        McpTransportConfig::Http { url, headers } | McpTransportConfig::Sse { url, headers } => {
            Some((url.as_str(), headers))
        }
        _ => None,
    }
}

impl McpManager {
    /// The coordinator, for tests that wait for or cancel the flows.
    #[cfg(test)]
    pub(crate) fn oauth_coordinator_for_test(&self) -> Option<Arc<McpOAuthCoordinator>> {
        self.0.oauth.get().cloned()
    }

    /// Wire the OAuth coordinator: the flow's store and runtime, and a reconnect of the server after success.
    pub fn enable_oauth(&self, store: Arc<dyn McpOAuthStore>, runtime: Arc<dyn McpOAuthRuntime>) {
        self.0.enable_oauth(Arc::downgrade(&self.0), store, runtime);
    }
}

impl Inner {
    fn enable_oauth(
        &self,
        weak: Weak<Inner>,
        store: Arc<dyn McpOAuthStore>,
        runtime: Arc<dyn McpOAuthRuntime>,
    ) {
        let reconnect: ReconnectFn = Arc::new(move |name: &str| {
            let Some(inner) = weak.upgrade() else {
                return;
            };
            let name = name.to_owned();
            tokio::spawn(async move { McpManager::from_inner(inner).restart(&name).await });
        });
        let _ = self.oauth.set(Arc::new(McpOAuthCoordinator::new(
            store, runtime, reconnect,
        )));
    }

    /// The config of one connect attempt. A fresh bearer (canonical access token, or a client-credentials token)
    /// is added as `Authorization` unless the server sets its own. Without credentials the config is unchanged.
    pub(super) async fn with_oauth_bearer(&self, config: &McpServer) -> McpServer {
        let unchanged = config.clone();
        let (Some(coordinator), Some(oauth), Some((url, headers))) = (
            self.oauth.get(),
            effective_oauth(config),
            remote_parts(config),
        ) else {
            return unchanged;
        };
        if headers
            .keys()
            .any(|name| name.eq_ignore_ascii_case("authorization"))
        {
            return unchanged;
        }
        let bearer = match &oauth {
            McpOAuthConfig::AuthorizationCode {
                client_id,
                client_secret,
                ..
            } => {
                let Some(key_prefix) = oauth.key_prefix(&config.name, url) else {
                    return unchanged;
                };
                let refresh = RefreshInput {
                    server_name: config.name.clone(),
                    server_url: url.to_owned(),
                    key_prefix,
                    static_client_id: client_id.clone(),
                    client_secret: client_secret.clone(),
                    reactive: false,
                };
                match coordinator.fresh_bearer(&refresh).await {
                    Ok(bearer) => bearer,
                    Err(error) => {
                        tracing::warn!(server = config.name.as_str(), %error, "MCP OAuth credentials unreadable");
                        None
                    }
                }
            }
            McpOAuthConfig::ClientCredentials { .. } => {
                match coordinator
                    .client_credentials_bearer(&config.name, url, &oauth)
                    .await
                {
                    Ok(bearer) => Some(bearer),
                    Err(error) => {
                        tracing::warn!(
                            server = config.name.as_str(),
                            error = error.as_str(),
                            "MCP client credentials unavailable"
                        );
                        None
                    }
                }
            }
        };
        let Some(bearer) = bearer else {
            return unchanged;
        };
        let mut headers = headers.clone();
        headers.insert("Authorization".to_owned(), bearer);
        let transport = match &config.transport {
            McpTransportConfig::Http { url, .. } => McpTransportConfig::http(url.clone(), headers),
            McpTransportConfig::Sse { url, .. } => McpTransportConfig::sse(url.clone(), headers),
            _ => return unchanged,
        };
        McpServer {
            transport,
            ..config.clone()
        }
    }

    /// A connect failed with HTTP 401: refresh the canonical token under the lock (reactive) and say what the
    /// connect should do next. `None` when the server has no authorization_code OAuth or the failure is not a 401.
    pub(super) async fn refresh_on_challenge(
        &self,
        config: &McpServer,
        failure: &ConnectFailure,
    ) -> Option<ChallengeRefresh> {
        if !is_authorization_challenge(&failure.reason) {
            return None;
        }
        let coordinator = self.oauth.get()?;
        let oauth = effective_oauth(config)?;
        let (url, _) = remote_parts(config)?;
        let McpOAuthConfig::AuthorizationCode {
            client_id,
            client_secret,
            ..
        } = &oauth
        else {
            return None;
        };
        let input = RefreshInput {
            server_name: config.name.clone(),
            server_url: url.to_owned(),
            key_prefix: oauth.key_prefix(&config.name, url)?,
            static_client_id: client_id.clone(),
            client_secret: client_secret.clone(),
            reactive: true,
        };
        Some(match coordinator.refresh(&input).await {
            Ok(_) => ChallengeRefresh::Retry,
            // The refresh token was rejected, or none is stored: the authorization flow starts.
            Err(RefreshError::InteractiveRequired { .. }) => ChallengeRefresh::Reauthorize,
            // A static client that the server rejects, or a temporary failure: the credentials stay.
            Err(RefreshError::Configuration(_) | RefreshError::Temporary(_)) => {
                ChallengeRefresh::Failed
            }
        })
    }

    /// A connect that fails with HTTP 401 starts the authorization flow for this server (Node: the SDK asks for
    /// authorization on 401). The row then reports `connecting` through the pending record. Deduplicated per server.
    pub(super) fn start_oauth_on_challenge(&self, config: &McpServer, failure: &ConnectFailure) {
        let (Some(coordinator), Some(oauth), Some((url, _))) = (
            self.oauth.get(),
            effective_oauth(config),
            remote_parts(config),
        ) else {
            return;
        };
        if is_authorization_challenge(&failure.reason) {
            if let Some(input) = oauth.flow_input(&config.name, url) {
                coordinator.start(config.name.clone(), input);
            }
            return;
        }
        // 403 `insufficient_scope` (RFC 6750 section 3.1): authorize again for the scope the server names, and
        // discover from its `resource_metadata` (RFC 9728). The authorization is always a new one (no refresh
        // can add scopes, RFC 6749 section 6), as Node's `forceReauthorization`.
        if !failure.reason.starts_with("HTTP 403") {
            return;
        }
        let Some(challenge) = failure
            .www_authenticate
            .as_deref()
            .and_then(parse_www_authenticate)
        else {
            return;
        };
        if challenge.error.as_deref() != Some("insufficient_scope") {
            return;
        }
        let Some(mut input) = oauth.flow_input(&config.name, url) else {
            return;
        };
        // The union with the stored token's scope is computed by the flow task (`flow::requested_scope`).
        input.challenge_scope = challenge.scope;
        input.resource_metadata = challenge.resource_metadata;
        coordinator.start(config.name.clone(), input);
    }
}

impl McpManager {
    /// A tool call failed with an HTTP challenge on a live connection (Node `recoverToolCallAuthorization`): a 401
    /// refreshes the token once and reconnects; a rejected refresh or a 403 starts the authorization flow. Returns
    /// whether the server reconnected, so that the caller retries its call once. The caller returns the original
    /// error otherwise, as Node rethrows the original error when recovery does not connect.
    pub(crate) async fn recover_call_challenge(
        &self,
        server: &str,
        client: &Arc<Client>,
        failure: &ConnectFailure,
    ) -> bool {
        let Some(config) = self.0.config_of(server) else {
            return false;
        };
        match self.0.refresh_on_challenge(&config, failure).await {
            Some(ChallengeRefresh::Retry) => {
                self.restart(server).await;
                self.0.wait_reconnected(server, client).await;
                self.0.client(server).is_some()
            }
            Some(ChallengeRefresh::Failed) => false,
            Some(ChallengeRefresh::Reauthorize) | None => {
                self.0.start_oauth_on_challenge(&config, failure);
                false
            }
        }
    }
}
