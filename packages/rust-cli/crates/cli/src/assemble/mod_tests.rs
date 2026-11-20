//! 组装规格的测试：桌面 app-server 的规格（`Controller::app`）与 Node 桌面端发的请求体一致。

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::automation::{AutomationError, AutomationPort};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelError;
use rust_cli_kernel_api::provider::{
    CipherError, CredentialCipher, HeaderRequest, HeaderSource, SuppliedAuth,
};
use rust_cli_kernel_api::subagent_config::{SubagentConfigSource, SubagentSnapshot};
use rust_cli_kernel_api::topic_resource::{TopicResource, TopicResourceRequest, TopicResources};
use rust_cli_net::RequestObserver;
use serde_json::Value;

use super::Controller;

/// 只为组装规格用的端口：组装时不会被调用。
struct Unused;

#[async_trait]
impl HeaderSource for Unused {
    async fn request_auth(&self, _request: HeaderRequest) -> Result<SuppliedAuth, ModelError> {
        unreachable!("the spec does not call the header source")
    }
}

#[async_trait]
impl CredentialCipher for Unused {
    async fn encrypt(&self, _plaintext: &str) -> Result<String, CipherError> {
        unreachable!("the spec does not call the cipher")
    }
    async fn decrypt(&self, _value: &str) -> Result<String, CipherError> {
        unreachable!("the spec does not call the cipher")
    }
}

#[async_trait]
impl AutomationPort for Unused {
    async fn request(
        &self,
        _session: &SessionId,
        _method: &str,
        _params: Value,
    ) -> Result<Value, AutomationError> {
        unreachable!("the spec does not call the automation port")
    }
}

impl RequestObserver for Unused {
    fn request(&self, _method: &str, _url: &str) {}
}

#[async_trait]
impl TopicResources for Unused {
    async fn read(&self, _request: TopicResourceRequest) -> Result<TopicResource, String> {
        unreachable!("the spec does not call topic resources")
    }
}

#[async_trait]
impl SubagentConfigSource for Unused {
    async fn read(&self, _session: &SessionId) -> Result<Option<SubagentSnapshot>, String> {
        Ok(None)
    }
}

/// Node's desktop agent sends the `<total_tokens>` budget: the system prompt's "Token budget" section and the
/// per-step `total_tokens_reminder` (`apps/zcode-cli/packages/core/src/context/builder.ts`, `runtime/methods/turn-loop.ts`).
/// The app-server composition must therefore keep the budget on.
#[test]
fn the_desktop_composition_keeps_the_total_tokens_budget() {
    let port = Arc::new(Unused);
    let spec = Controller::app(
        port.clone(),
        port.clone(),
        port.clone(),
        port.clone(),
        port.clone(),
        port,
        true,
    );
    assert!(spec.token_budget);
}
