//! Fork: ReadTopicResource (specs/fork-rust-topic-resource.md), Node `tool/handlers/read-topic-resource.ts` and
//! `tool/topic-resource/reader.ts`. Downloads one file or image of a bot-group topic's history into a session artifact.
//!
//! The authorization comes from the session's stored user inputs, never from the model; the bytes come from the Host
//! through [`TopicResources`] and are checked before they are written.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_kernel_api::message::{Message, UserOrigin};
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::prompt_attachment::parse_artifact_uri;
use rust_cli_kernel_api::store::{ArtifactPurpose, SessionStore};
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, failed, text,
};
use rust_cli_kernel_api::tool_names;
use rust_cli_kernel_api::topic_resource::{TopicResource, TopicResourceRequest, TopicResources};
use rust_cli_prompts::Definition;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::base64;

pub const NAME: &str = tool_names::READ_TOPIC_RESOURCE;

/// Node `timeoutMs`: the whole call, port and artifact IO included.
const TIMEOUT: Duration = Duration::from_secs(300);
/// Node `maxResultSizeBytes`.
const MAX_RESULT_CHARS: usize = 4096;
/// Node `PROTOCOL_V4_LIMITS.attachmentMaxBytes` (20 MiB).
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;
/// Node `contract.ts` string bounds for `inputId` and `messageId`.
const MAX_ID_CHARS: usize = 256;

const NO_AUTHORIZATION: &str = "No admitted topic authorization is available for this input";
const NOT_INDEXED: &str = "Resource is not indexed in the selected history snapshot";
const UNAVAILABLE: &str = "Topic attachment retrieval is unavailable on this runtime";
const BAD_SIZE: &str = "Invalid topic attachment size";
const BAD_ARTIFACT: &str = "Invalid topic attachment artifact";
const MISMATCH: &str = "Topic attachment size or encoding mismatch";
const NOT_MATERIALIZED: &str = "Topic attachment could not be materialized";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    #[serde(default)]
    input_id: Option<String>,
    message_id: String,
    #[serde(default)]
    index: Option<u64>,
}

/// The admitting input of a read: its `sourceCommandId` and `botGroupSource`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Identity {
    pub(crate) input: String,
    pub(crate) authorization: String,
    source: Value,
}

pub struct ReadTopicResourceTool {
    definition: Definition,
    store: Arc<dyn SessionStore>,
    resources: Arc<dyn TopicResources>,
}

impl ReadTopicResourceTool {
    pub fn new(store: Arc<dyn SessionStore>, resources: Arc<dyn TopicResources>) -> Self {
        Self {
            definition: rust_cli_prompts::definition(NAME).clone(),
            store,
            resources,
        }
    }

    async fn read(&self, input: Input, context: &ToolUseContext) -> Result<Value, ToolError> {
        let loaded = self
            .store
            .load(&context.session)
            .await
            .map_err(|error| failed(error.to_string()))?;
        let messages: Vec<&Message> = loaded.earlier.iter().chain(&loaded.messages).collect();
        let identity = authorize(&messages, input.input_id.as_deref())
            .ok_or_else(|| failed(NO_AUTHORIZATION.to_owned()))?;
        let index = input.index.unwrap_or(0);
        if input.input_id.is_some() && !indexed(&identity.source, &input.message_id, index) {
            return Err(failed(NOT_INDEXED.to_owned()));
        }
        let resource = self
            .resources
            .read(TopicResourceRequest {
                task: context.session.as_str().to_owned(),
                input: identity.input,
                authorization: identity.authorization,
                message: input.message_id.clone(),
                index,
            })
            .await
            .map_err(failed)?;
        let bytes = checked_bytes(&resource, context).await?;
        let artifact = context
            .artifacts
            .put(
                &context.session,
                ArtifactPurpose::ToolOutput,
                resource.mime.clone(),
                bytes,
            )
            .await
            .map_err(|error| failed(error.to_string()))?;
        let path = context
            .artifacts
            .local_path(&artifact)
            .ok_or_else(|| failed(NOT_MATERIALIZED.to_owned()))?;
        Ok(json!({
            "status": "success",
            "path": path.to_string_lossy(),
            "fileName": resource.file_name,
            "mime": resource.mime,
            "bytes": resource.bytes,
            "messageId": input.message_id,
            "index": index,
        }))
    }
}

/// Node `readTopicResourceFromSession`'s search: human inputs, newest first. An intent with a valid identity is used
/// (unless `input` names another one); an intent with a malformed `botGroupSource` ends the search.
pub(crate) fn authorize(messages: &[&Message], input: Option<&str>) -> Option<Identity> {
    for message in messages.iter().rev() {
        let Message::User(user) = message else {
            continue;
        };
        if !matches!(user.origin, UserOrigin::Human) {
            continue;
        }
        let Some(intent) = user.intent.as_deref() else {
            continue;
        };
        match identity(intent.fields()) {
            Some(found) if input.is_some_and(|input| input != found.input) => continue,
            Some(found) => return Some(found),
            None if intent.fields().contains_key("botGroupSource") => return None,
            None => continue,
        }
    }
    None
}

/// Node `identitySchema` (a non-strict zod object).
fn identity(intent: &serde_json::Map<String, Value>) -> Option<Identity> {
    let nonempty = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let input = nonempty(intent.get("sourceCommandId"))?;
    let source = intent.get("botGroupSource")?.as_object()?;
    for key in ["botId", "chatId", "threadId"] {
        nonempty(source.get(key))?;
    }
    let authorization = nonempty(source.get("authorizationId"))?;
    if let Some(history) = source.get("topicHistory") {
        let records = history.get("resourceMessages")?.as_array()?;
        for record in records {
            record.get("messageId")?.as_str()?;
            record.get("count")?.as_u64().filter(|count| *count > 0)?;
        }
    }
    if let Some(context) = source.get("topicContext") {
        for record in context.get("messages")?.as_array()? {
            record.get("id")?.as_str()?;
            if let Some(attachments) = record.get("attachments") {
                attachments.as_array()?;
            }
        }
    }
    Some(Identity {
        input,
        authorization,
        source: Value::Object(source.clone()),
    })
}

/// Node's snapshot check for an explicit `inputId`: `topicHistory` bounds the index; without it the `topicContext`
/// message must have a truthy attachment at that index.
fn indexed(source: &Value, message: &str, index: u64) -> bool {
    if let Some(history) = source.get("topicHistory") {
        return history
            .get("resourceMessages")
            .and_then(Value::as_array)
            .is_some_and(|records| {
                records.iter().any(|record| {
                    record.get("messageId").and_then(Value::as_str) == Some(message)
                        && record
                            .get("count")
                            .and_then(Value::as_u64)
                            .is_some_and(|count| index < count)
                })
            });
    }
    source
        .pointer("/topicContext/messages")
        .and_then(Value::as_array)
        .and_then(|records| {
            records
                .iter()
                .find(|record| record.get("id").and_then(Value::as_str) == Some(message))
        })
        .and_then(|record| record.get("attachments")?.as_array()?.get(index as usize))
        .is_some_and(truthy)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Reads the Host's uploaded artifact and checks it the way Node does (size bound, data URL with the reply's mime,
/// payload bound, decoded length and canonical encoding). The ref must name this session.
async fn checked_bytes(
    resource: &TopicResource,
    context: &ToolUseContext,
) -> Result<Vec<u8>, ToolError> {
    if resource.bytes > MAX_BYTES {
        return Err(failed(BAD_SIZE.to_owned()));
    }
    let missing = || failed(format!("Artifact not found: {}", resource.reference));
    let (session, id) = parse_artifact_uri(&resource.reference)
        .filter(|(session, _)| *session == context.session)
        .ok_or_else(missing)?;
    let artifact = match context.artifacts.find(&session, &id).await {
        Ok(Some(artifact)) => artifact,
        Ok(None) => return Err(missing()),
        Err(_) => return Err(failed(UNAVAILABLE.to_owned())),
    };
    let stored = context
        .artifacts
        .get(&artifact)
        .await
        .map_err(|error| failed(error.to_string()))?;
    let content = String::from_utf8(stored).map_err(|_| failed(BAD_ARTIFACT.to_owned()))?;
    let payload = data_url_payload(&content, &resource.mime)
        .ok_or_else(|| failed(BAD_ARTIFACT.to_owned()))?;
    let bytes = base64::decode(payload).ok_or_else(|| failed(BAD_ARTIFACT.to_owned()))?;
    if bytes.len() as u64 != resource.bytes || base64::encode(&bytes) != payload {
        return Err(failed(MISMATCH.to_owned()));
    }
    Ok(bytes)
}

/// Node `^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$` with the reply's mime and the payload length bound.
fn data_url_payload<'a>(content: &'a str, mime: &str) -> Option<&'a str> {
    let rest = content.strip_prefix("data:")?;
    let (found, payload) = rest.split_once(";base64,")?;
    if found.is_empty() || found.contains([';', ',']) || found != mime {
        return None;
    }
    let body = payload.trim_end_matches('=');
    let padding = payload.len() - body.len();
    let alphabet = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/';
    let limit = MAX_BYTES.div_ceil(3) * 4;
    (padding <= 2 && body.bytes().all(alphabet) && payload.len() as u64 <= limit).then_some(payload)
}

fn parse_input(input: Value) -> Result<Input, ToolError> {
    let input: Input =
        serde_json::from_value(input).map_err(|error| failed(format!("Invalid input: {error}")))?;
    let bounded = |id: &str| (1..=MAX_ID_CHARS).contains(&id.chars().count());
    if !bounded(&input.message_id) || input.input_id.as_deref().is_some_and(|id| !bounded(id)) {
        return Err(failed(
            "Invalid input: inputId and messageId must be 1 to 256 characters".to_owned(),
        ));
    }
    Ok(input)
}

#[async_trait]
impl Tool for ReadTopicResourceTool {
    fn name(&self) -> &str {
        NAME
    }

    fn input_schema(&self) -> Value {
        self.definition.schema.clone()
    }

    fn description(&self, _context: &PromptContext) -> String {
        self.definition.description.clone()
    }

    fn should_defer(&self) -> bool {
        true
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        Some(MAX_RESULT_CHARS)
    }

    /// Node `permission: session.topic_resource.read` needs no approval: the Host authorizes the read.
    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        PermissionDecision::Allow {
            updated_input: None,
        }
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let input = parse_input(input)?;
        let cancel = context.cancel.clone();
        let result = tokio::select! {
            () = cancel.cancelled() => return Err(ToolError::Cancelled),
            result = tokio::time::timeout(TIMEOUT, self.read(input, &context)) => result,
        };
        let value = result.map_err(|_| failed(format!("{NAME} timed out after 300 seconds")))??;
        Ok(text(value.to_string()))
    }
}

#[cfg(test)]
#[path = "read_topic_resource_tests.rs"]
mod tests;
