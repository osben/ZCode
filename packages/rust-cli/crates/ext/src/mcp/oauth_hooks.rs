//! Connection-side OAuth hooks of the MCP manager (`specs/fork-rust-mcp-oauth.md`, PR2).
//!
//! The manager calls three things from here: [`Inner::with_oauth_bearer`] before each connect attempt,
//! [`Inner::start_oauth_on_challenge`] when a connect fails with HTTP 401, and [`McpManager::enable_oauth`]
//! once at wiring time. Keeping them here leaves `manager.rs` with call sites only.

use std::collections::BTreeMap;
use std::sync::{Arc, Weak};

use rust_cli_kernel_api::mcp::McpTransportConfig;

use super::config::{McpScope, McpServer};
use super::manager::{Inner, McpManager};
use super::oauth::{
    McpOAuthConfig, McpOAuthCoordinator, McpOAuthRuntime, McpOAuthStore, ReconnectFn,
    is_authorization_challenge,
};

/// The OAuth config a server acts on. Node treats a remote server with no `oauth` block as
/// `authorization_code` (`resolveOAuthConfig`), so user-scope remote servers do too. Plugin rows are not
/// covered until #501 carries their config.
fn effective_oauth(config: &McpServer) -> Option<McpOAuthConfig> {
    if let Some(oauth) = &config.oauth {
        return Some(oauth.clone());
    }
    (remote_parts(config).is_some() && matches!(config.scope, McpScope::User)).then_some(
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
            McpOAuthConfig::AuthorizationCode { .. } => {
                let Some(prefix) = oauth.key_prefix(&config.name, url) else {
                    return unchanged;
                };
                match coordinator.bearer_for(&prefix, coordinator.now_ms()).await {
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

    /// A connect that fails with HTTP 401 starts the authorization flow for this server (Node: the SDK asks for
    /// authorization on 401). The row then reports `connecting` through the pending record. Deduplicated per server.
    pub(super) fn start_oauth_on_challenge(&self, config: &McpServer, reason: &str) {
        if !is_authorization_challenge(reason) {
            return;
        }
        let (Some(coordinator), Some(oauth), Some((url, _))) = (
            self.oauth.get(),
            effective_oauth(config),
            remote_parts(config),
        ) else {
            return;
        };
        if let Some(input) = oauth.flow_input(&config.name, url) {
            coordinator.start(config.name.clone(), input);
        }
    }
}
