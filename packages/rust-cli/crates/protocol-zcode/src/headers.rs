//! 账号模型的每请求鉴权（缺口 G8）：kernel-api 的 [`HeaderSource`]（入口注入平台层）由这里实现，照 Node 的
//! `provider-runtime-headers.ts`，经反向请求 `interaction/requestProviderRuntimeHeaders` 问 Host 要这次请求的凭据；
//! 调用方放弃（模型请求被取消）或超过 180 s 时发 `interaction/providerRuntimeHeadersCancelled`，Host 释放它的队列。

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::secret::RedactedString;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_base::{account, hash};
use rust_cli_kernel_api::model::ModelError;
use rust_cli_kernel_api::provider::{HeaderRequest, HeaderSource, SuppliedAuth};
use serde_json::{Value, json};

use crate::context::Context;
use crate::inbound::Inbound;

pub const REQUEST: &str = "interaction/requestProviderRuntimeHeaders";
pub const CANCELLED: &str = "interaction/providerRuntimeHeadersCancelled";
/// 端口的总时限（Node `PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS`）：同时覆盖 Host 的排队与凭据解析。
const LIMIT: Duration = Duration::from_secs(180);

/// Fork: how many ChatGPT Plan token scopes are remembered (oldest dropped first).
const SCOPES_KEPT: usize = 32;
/// Fork: Node `siwc_account_scope_invalidated` (the account behind the token changed, or no scope to check).
const SCOPE_INVALIDATED: &str = "siwc_account_scope_invalidated";

/// 经 Host 取账号凭据。
pub struct HostHeaders {
    context: Arc<Context>,
    /// Fork (specs/fork-rust-chatgpt-plan.md rules 8-9): `sha256(apiKey)` → the Host's `accountScope` for ChatGPT
    /// Plan tokens, so a renewal after a 401 can send the scope the rejected token belonged to.
    scopes: Mutex<VecDeque<(String, String)>>,
}

impl HostHeaders {
    pub fn new(context: Arc<Context>) -> Self {
        Self {
            context,
            scopes: Mutex::new(VecDeque::new()),
        }
    }

    fn scope_of(&self, fingerprint: &str) -> Option<String> {
        self.scopes
            .lock_unpoisoned()
            .iter()
            .find(|(known, _)| known == fingerprint)
            .map(|(_, scope)| scope.clone())
    }

    fn remember(&self, fingerprint: String, scope: String) {
        let mut scopes = self.scopes.lock_unpoisoned();
        scopes.retain(|(known, _)| *known != fingerprint);
        if scopes.len() == SCOPES_KEPT {
            scopes.pop_front();
        }
        scopes.push_back((fingerprint, scope));
    }
}

/// 请求还没得到回复就被丢弃时，告诉 Host 取消。
struct Pending {
    context: Arc<Context>,
    params: Option<Value>,
}

impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(params) = self.params.take() {
            self.context.peer.try_notify(CANCELLED, &params);
        }
    }
}

fn failed(message: impl Into<String>) -> ModelError {
    ModelError::Authentication {
        message: message.into(),
    }
}

#[async_trait]
impl HeaderSource for HostHeaders {
    async fn request_auth(&self, request: HeaderRequest) -> Result<SuppliedAuth, ModelError> {
        let session = request
            .session
            .as_ref()
            .ok_or_else(|| failed("account credentials need the requesting session"))?;
        let workspace = self
            .context
            .workspace_of(session.as_str())
            .ok_or_else(|| failed("the requesting session is not open in this agent"))?;
        let request_id = format!(
            "{}:provider-runtime-headers:{}",
            session.as_str(),
            self.context.fresh("auth")
        );
        let workspace = json!({"workspacePath": workspace, "workspaceKey": workspace});
        // Fork: ChatGPT Plan is routed by provider id and carries no zhipu-shaped access (rule 7). After a 401 it
        // names the scope of the rejected token; without one Node cannot recover the token either (rule 9).
        let chatgpt = account::chatgpt_plan_account(&request.selection.provider).is_some();
        let expected = match (chatgpt, &request.rejected_fingerprint) {
            (true, Some(fingerprint)) => Some(
                self.scope_of(fingerprint)
                    .ok_or_else(|| failed(SCOPE_INVALIDATED))?,
            ),
            _ => None,
        };
        let mut params = json!({
            "requestId": request_id,
            "sessionId": session.as_str(),
            "workspace": workspace,
            "modelSelection": {"providerId": request.selection.provider, "modelId": request.selection.model},
            "providerId": request.selection.provider,
            "reason": "model-request",
        });
        if !chatgpt {
            params["accountAccess"] = json!({"type": "zhipu-account",
                "accountType": request.account_type, "mode": request.mode, "entitled": true});
        }
        if let Some(scope) = &expected {
            params["expectedAccountScope"] = json!(scope);
        }
        if let Some(fingerprint) = &request.rejected_fingerprint {
            params["rejectedProjectTokenFingerprint"] = json!(fingerprint);
        }
        let mut pending = Pending {
            context: self.context.clone(),
            params: Some(
                json!({"requestId": request_id, "sessionId": session.as_str(),
                "workspace": workspace}),
            ),
        };
        let answer = tokio::time::timeout(LIMIT, self.context.peer.request(REQUEST, &params)).await;
        let result = match answer {
            // 超时：Pending 的 Drop 发取消。
            Err(_) => return Err(failed("Requesting the account credentials timed out")),
            Ok(result) => {
                pending.params = None;
                result.map_err(|error| failed(error.message))?
            }
        };
        Inbound::get()
            .reply(REQUEST, &result)
            .map_err(|error| failed(format!("invalid account credentials reply: {error}")))?;
        if result["headersApplied"] != true {
            return Err(failed(result["errorMessage"].as_str().unwrap_or(
                "Provider runtime headers were not applied before model request attempt.",
            )));
        }
        let auth = &result["requestAuth"];
        let headers = auth["headers"]
            .as_object()
            .map(|headers| {
                headers
                    .iter()
                    .filter_map(|(name, value)| {
                        Some((name.clone(), RedactedString::new(value.as_str()?)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let api_key = auth["apiKey"].as_str().map(RedactedString::new);
        if chatgpt {
            let scope = auth["accountScope"].as_str();
            if expected.is_some() && scope != expected.as_deref() {
                return Err(failed(SCOPE_INVALIDATED));
            }
            if let (Some(key), Some(scope)) = (&api_key, scope) {
                self.remember(hash::sha256_hex(key.expose().as_bytes()), scope.to_owned());
            }
        }
        Ok(SuppliedAuth { api_key, headers })
    }
}

#[cfg(test)]
#[path = "headers_tests.rs"]
mod tests;
