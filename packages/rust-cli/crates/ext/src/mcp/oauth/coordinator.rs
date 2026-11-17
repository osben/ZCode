//! Owner of the authorization flow tasks and of the connection-side OAuth helpers
//! (`specs/fork-rust-mcp-oauth.md`, PR2 owners and event order).
//!
//! One flow task per server row. The task runs [`run_lead`], which owns the lease and the pending record;
//! the coordinator only starts, cancels and reconnects. `client_credentials` tokens are kept in memory,
//! as Node's `ClientCredentialsProvider` keeps them, and are never written to the credential file.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rust_cli_base::sync::LockUnpoisoned;
use serde_json::Value;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::flow::{FlowInput, FlowOutcome, discover, run_lead};
use super::keys::credential_key;
use super::protocol::{basic_auth, token_form_client_credentials};
use super::{
    McpOAuthConfig, McpOAuthRuntime, McpOAuthStore, McpOAuthStoreError, OAuthHttpError,
    OAuthHttpRequest,
};

/// Called with the server name after a flow completes successfully (the manager reconnects that server).
pub type ReconnectFn = Arc<dyn Fn(&str) + Send + Sync>;

/// Node `MCP_OAUTH_EXPIRY_SKEW_MS`: a token this close to expiry is not sent.
const EXPIRY_SKEW_MS: i64 = 30_000;
const CANONICAL_KEY: &str = "authorization_credentials";

struct FlowTask {
    cancel: CancellationToken,
    handle: JoinHandle<()>,
}

struct ClientToken {
    bearer: String,
    expires_at: Option<i64>,
}

pub struct McpOAuthCoordinator {
    store: Arc<dyn McpOAuthStore>,
    runtime: Arc<dyn McpOAuthRuntime>,
    reconnect: ReconnectFn,
    flows: Mutex<HashMap<String, FlowTask>>,
    client_tokens: Mutex<HashMap<String, ClientToken>>,
}

impl McpOAuthCoordinator {
    pub fn new(
        store: Arc<dyn McpOAuthStore>,
        runtime: Arc<dyn McpOAuthRuntime>,
        reconnect: ReconnectFn,
    ) -> Self {
        Self {
            store,
            runtime,
            reconnect,
            flows: Mutex::new(HashMap::new()),
            client_tokens: Mutex::new(HashMap::new()),
        }
    }

    pub fn now_ms(&self) -> i64 {
        self.runtime.now_ms()
    }

    /// `Bearer <access token>` from the canonical credentials, or `None` when absent or within the expiry
    /// skew. Refresh is PR3; until then an expired token gives no bearer and the server answers 401.
    pub async fn bearer_for(
        &self,
        key_prefix: &str,
        now: i64,
    ) -> Result<Option<String>, McpOAuthStoreError> {
        let Some(raw) = self
            .store
            .load(&credential_key(key_prefix, CANONICAL_KEY))
            .await?
        else {
            return Ok(None);
        };
        let Ok(canonical) = serde_json::from_str::<Value>(&raw) else {
            return Ok(None);
        };
        let Some(token) = canonical["tokens"]["access_token"].as_str() else {
            return Ok(None);
        };
        if canonical["expires_at"]
            .as_i64()
            .is_some_and(|expires_at| now + EXPIRY_SKEW_MS >= expires_at)
        {
            return Ok(None);
        }
        Ok(Some(format!("Bearer {token}")))
    }

    /// Start the authorization flow for `server_name` unless one is still running. Returns whether it started.
    pub fn start(self: &Arc<Self>, server_name: String, input: FlowInput) -> bool {
        let mut flows = self.flows.lock_unpoisoned();
        if flows
            .get(&server_name)
            .is_some_and(|task| !task.handle.is_finished())
        {
            return false;
        }
        let cancel = CancellationToken::new();
        let this = self.clone();
        let task_cancel = cancel.clone();
        let name = server_name.clone();
        let handle = tokio::spawn(async move {
            let outcome = run_lead(&*this.store, &*this.runtime, &input, &task_cancel).await;
            if outcome == FlowOutcome::Authorized {
                (this.reconnect)(&name);
            }
        });
        flows.insert(server_name, FlowTask { cancel, handle });
        true
    }

    /// Cancel the running flow for `server_name`. Its wait ends, its own pending record is removed and its
    /// lease is released by `run_lead`.
    pub fn cancel(&self, server_name: &str) {
        if let Some(task) = self.flows.lock_unpoisoned().get(server_name) {
            task.cancel.cancel();
        }
    }

    /// Wait until every started flow has finished (tests and shutdown).
    pub async fn wait_idle(&self) {
        let tasks: Vec<FlowTask> = self
            .flows
            .lock_unpoisoned()
            .drain()
            .map(|(_, task)| task)
            .collect();
        for task in tasks {
            let _ = task.handle.await;
        }
    }

    /// The `client_credentials` bearer: discovery, then the token request with `client_secret_basic`.
    /// Cached in memory until 30 s before `expires_in`; never written to the credential file.
    pub async fn client_credentials_bearer(
        &self,
        server_name: &str,
        server_url: &str,
        config: &McpOAuthConfig,
    ) -> Result<String, String> {
        let McpOAuthConfig::ClientCredentials {
            client_id,
            client_secret,
            scope,
            ..
        } = config
        else {
            return Err("not a client_credentials configuration".to_owned());
        };
        let now = self.now_ms();
        if let Some(token) = self.client_tokens.lock_unpoisoned().get(server_name)
            && token
                .expires_at
                .is_none_or(|expires_at| now + EXPIRY_SKEW_MS < expires_at)
        {
            return Ok(token.bearer.clone());
        }

        let (_, metadata) = discover(&*self.runtime, server_url).await?;
        let endpoint = metadata["token_endpoint"]
            .as_str()
            .ok_or("the authorization server has no token endpoint")?;
        let response = self
            .runtime
            .http(OAuthHttpRequest {
                method: "POST",
                url: endpoint.to_owned(),
                headers: vec![
                    (
                        "Content-Type".into(),
                        "application/x-www-form-urlencoded".into(),
                    ),
                    ("Accept".into(), "application/json".into()),
                    ("Authorization".into(), basic_auth(client_id, client_secret)),
                ],
                body: Some(token_form_client_credentials(scope.as_deref())),
            })
            .await
            .map_err(|OAuthHttpError(message)| message)?;
        if response.status >= 400 {
            return Err(format!(
                "HTTP {} requesting the client credentials token",
                response.status
            ));
        }
        let tokens: Value = serde_json::from_str(&response.body)
            .map_err(|_| "the token response is not valid JSON".to_owned())?;
        let access = tokens["access_token"]
            .as_str()
            .ok_or("the token response has no access token")?;
        let token = ClientToken {
            bearer: format!("Bearer {access}"),
            expires_at: tokens["expires_in"]
                .as_i64()
                .map(|seconds| now + seconds * 1000),
        };
        let bearer = token.bearer.clone();
        self.client_tokens
            .lock_unpoisoned()
            .insert(server_name.to_owned(), token);
        Ok(bearer)
    }
}
