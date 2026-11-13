//! Fork: the Host side of [`TopicResources`] (specs/fork-rust-topic-resource.md), Node
//! `bootstrap/src/zcode-protocol/topic-resource-port.ts`. A read is the reverse request `topic/resource/read`; when the
//! caller drops it before the reply (the tool call was cancelled), a best-effort `topic/resource/cancel` request follows.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::Spawner;
use rust_cli_kernel_api::topic_resource::{TopicResource, TopicResourceRequest, TopicResources};
use serde_json::{Value, json};

use crate::context::Context;
use crate::inbound::Inbound;

pub const READ: &str = "topic/resource/read";
pub const CANCEL: &str = "topic/resource/cancel";
/// Node `RESOURCE_TIMEOUT_MS`, for the read and for the cancel.
const LIMIT: Duration = Duration::from_secs(120);

pub struct HostTopicResources {
    context: Arc<Context>,
    spawner: Spawner,
}

impl HostTopicResources {
    pub fn new(context: Arc<Context>, spawner: Spawner) -> Self {
        Self { context, spawner }
    }
}

/// Armed while the read waits for the Host; dropped armed (the caller gave up), it sends the cancel request. Node sends
/// it only on abort, not on its own timeout, so the timeout disarms it too.
struct Pending {
    context: Arc<Context>,
    spawner: Spawner,
    params: Option<Value>,
}

impl Drop for Pending {
    fn drop(&mut self) {
        let Some(params) = self.params.take() else {
            return;
        };
        let context = self.context.clone();
        drop(self.spawner.spawn("topic-resource-cancel", async move {
            // Best effort: a failed or late cancel changes nothing for the read, which already ended.
            let _ = tokio::time::timeout(LIMIT, context.peer.request(CANCEL, &params)).await;
        }));
    }
}

#[async_trait]
impl TopicResources for HostTopicResources {
    async fn read(&self, request: TopicResourceRequest) -> Result<TopicResource, String> {
        let request_id = self.context.fresh("topic-resource");
        let params = json!({
            "taskId": request.task,
            "inputId": request.input,
            "authorizationId": request.authorization,
            "messageId": request.message,
            "resourceIndex": request.index,
            "requestId": request_id,
        });
        let mut pending = Pending {
            context: self.context.clone(),
            spawner: self.spawner.clone(),
            params: Some(json!({"requestId": request_id, "taskId": request.task})),
        };
        let answer = tokio::time::timeout(LIMIT, self.context.peer.request(READ, &params)).await;
        pending.params = None;
        let result = answer
            .map_err(|_| format!("{READ} timed out after 120 seconds"))?
            .map_err(|error| error.message)?;
        Inbound::get()
            .reply(READ, &result)
            .map_err(|error| format!("invalid {READ} reply: {error}"))?;
        let text = |key: &str| result[key].as_str().unwrap_or_default().to_owned();
        Ok(TopicResource {
            reference: text("ref"),
            file_name: text("fileName"),
            mime: text("mime"),
            bytes: result["bytes"].as_u64().unwrap_or_default(),
        })
    }
}

#[cfg(test)]
#[path = "topic_resource_tests.rs"]
mod tests;
