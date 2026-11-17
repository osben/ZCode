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

use super::flow::{FlowInput, FlowOutcome, discover, key_prefix_of, run_lead};
use super::pair::load_pair;
use super::protocol::{basic_auth, token_form_client_credentials};
use super::record::load_canonical;
use super::refresh::{RefreshError, RefreshInput, refresh_under_lock};
use super::{
    McpOAuthConfig, McpOAuthRuntime, McpOAuthStore, McpOAuthStoreError, OAuthHttpError,
    OAuthHttpRequest,
};

/// Called with the server name after a flow completes successfully (the manager reconnects that server).
pub type ReconnectFn = Arc<dyn Fn(&str) + Send + Sync>;

/// Node `MCP_OAUTH_EXPIRY_SKEW_MS`: a token this close to expiry is not sent.
const EXPIRY_SKEW_MS: i64 = 30_000;
/// Node `FOLLOWER_POLL_INTERVAL_MS`: how often a follower re-reads the canonical credentials.
const FOLLOWER_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

/// The generation of the canonical record, `None` when there is none or it is unusable (Node
/// `loadCanonicalCredentials`). A store failure reads as absent: the follower keeps waiting.
async fn canonical_generation(store: &dyn McpOAuthStore, key_prefix: &str) -> Option<String> {
    load_canonical(store, key_prefix)
        .await
        .ok()
        .flatten()
        .map(|canonical| canonical.generation)
}

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

    /// Refresh the canonical token under the lock after a 401 (reactive). See [`refresh_under_lock`].
    pub async fn refresh(&self, input: &RefreshInput) -> Result<String, RefreshError> {
        refresh_under_lock(&*self.store, &*self.runtime, input).await
    }

    /// The bearer of one connect attempt (Node `token()`). A canonical token outside the 30 s skew is used as it is.
    /// Near expiry it is refreshed under the lock first when a refresh token exists; without one the current token
    /// is sent, as Node does, and the server's 401 decides. A rejected grant gives no bearer: the 401 path then
    /// starts the flow. Store failures are returned.
    pub async fn fresh_bearer(
        &self,
        input: &RefreshInput,
    ) -> Result<Option<String>, McpOAuthStoreError> {
        // Node `token()` reads the pair through `loadCredentialPair`, so legacy records are used too.
        let Some(pair) = load_pair(&*self.store, &input.key_prefix).await? else {
            return Ok(None);
        };
        let Some(access) = pair.access_token() else {
            return Ok(None);
        };
        let now = self.now_ms();
        // Node `isCanonicalTokenNearExpiry`: a record without `expires_at` counts as near expiry.
        let near_expiry = pair
            .expires_at
            .is_none_or(|expires_at| now + EXPIRY_SKEW_MS >= expires_at);
        if !near_expiry || pair.refresh_token().is_none() {
            return Ok(Some(format!("Bearer {access}")));
        }
        let proactive = RefreshInput {
            reactive: false,
            ..input.clone()
        };
        match refresh_under_lock(&*self.store, &*self.runtime, &proactive).await {
            Ok(token) => Ok(Some(format!("Bearer {token}"))),
            // Interactive authorization is needed, or the static client was rejected: no bearer.
            Err(RefreshError::InteractiveRequired { .. } | RefreshError::Configuration(_)) => {
                Ok(None)
            }
            Err(RefreshError::Temporary(_)) => Ok(None),
        }
    }

    /// Start the authorization flow for `server_name` unless one is still running. Returns whether it started.
    ///
    /// The follower's baseline (the canonical generation Node's `followAuthorization` compares against) is read
    /// here, before the flow task exists. Read inside the task, it could come after the lead's publish, and the
    /// follower would then wait for a change that already happened.
    pub async fn start(self: &Arc<Self>, server_name: String, input: FlowInput) -> bool {
        let key_prefix = key_prefix_of(&input);
        let baseline = canonical_generation(&*self.store, &key_prefix).await;
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
            let outcome = run_lead(
                &*this.store,
                &*this.runtime,
                &input,
                baseline.clone(),
                &task_cancel,
            )
            .await;
            let authorized = match outcome {
                FlowOutcome::Authorized => true,
                // Node `followAuthorization`: the follower's client reconnects when another caller's
                // credentials arrive, not when its own flow ends.
                FlowOutcome::Pending { .. } => {
                    this.follow(
                        &key_prefix,
                        baseline,
                        input.transaction_ttl_ms,
                        &task_cancel,
                    )
                    .await
                }
                FlowOutcome::Failed { .. } => false,
            };
            if authorized {
                (this.reconnect)(&name);
            }
        });
        flows.insert(server_name, FlowTask { cancel, handle });
        true
    }

    /// Follower wait (Node `followAuthorization`): poll the canonical generation until it moves from `baseline`,
    /// the transaction TTL passes, or the flow is cancelled. Returns whether newer credentials arrived.
    async fn follow(
        &self,
        key_prefix: &str,
        baseline: Option<String>,
        ttl_ms: i64,
        cancel: &CancellationToken,
    ) -> bool {
        let deadline = self.now_ms() + ttl_ms;
        while self.now_ms() < deadline && !cancel.is_cancelled() {
            if canonical_generation(&*self.store, key_prefix).await != baseline {
                return canonical_generation(&*self.store, key_prefix)
                    .await
                    .is_some();
            }
            tokio::select! {
                () = tokio::time::sleep(FOLLOWER_POLL_INTERVAL) => {}
                () = cancel.cancelled() => return false,
            }
        }
        false
    }

    /// Whether a flow for `server_name` is registered and still running. `start` registers the flow only after it has
    /// read the follower baseline, so a registered flow is the observable point where a publish is safe to make.
    pub fn flow_running(&self, server_name: &str) -> bool {
        self.flows
            .lock_unpoisoned()
            .get(server_name)
            .is_some_and(|task| !task.handle.is_finished())
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

        let metadata = discover(&*self.runtime, server_url, None).await?.metadata;
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
