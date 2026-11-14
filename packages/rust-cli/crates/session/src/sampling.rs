//! Fork: an MCP App panel's model sampling (specs/fork-rust-node-helper.md F3, `helper/sampleModel`; Node
//! `sampleModel`). The actor only hands out the session's model selection and stores the call's usage row; the call
//! runs in the caller's task, outside any turn, and writes no message or event.

use futures_util::StreamExt;
use rust_cli_kernel_api::message::{ContentBlock, ImageSource, StopReason, Usage};
use rust_cli_kernel_api::metering::{CallStatus, ModelCall};
use rust_cli_kernel_api::model::{
    ApiContent, ApiMessage, ApiRole, ModelError, ModelNotice, ModelRequest, ModelStreamItem,
    QuerySource, SystemBlock,
};
use rust_cli_kernel_api::provider::ModelCapabilities;
use rust_cli_kernel_api::sampling::{
    NO_IMAGE_INPUT, SamplingBlock, SamplingError, SamplingReply, SamplingRequest,
    UNSUPPORTED_COMPLETION,
};
use rust_cli_kernel_api::side_request::{Requester, SideReply, SideSource};
use rust_cli_kernel_api::store::Fact;
use tokio_util::sync::CancellationToken;

use crate::Session;
use crate::actor::{Actor, Request};

const SOURCE: SideSource = SideSource::McpSampling;

impl Session {
    /// One sampling call on the session's current model (Node fixes the selection before its first await; a panel's
    /// model hints never pick another). The usage row is written for a call that reached the model, whether it
    /// completed, failed or was cancelled; an input the model cannot take fails before that, with no row.
    pub async fn sample_model(
        &self,
        request: SamplingRequest,
        cancel: CancellationToken,
    ) -> Result<SamplingReply, SamplingError> {
        if cancel.is_cancelled() {
            return Err(SamplingError::Cancelled);
        }
        let selection = self
            .ask(|reply| Request::SamplingSelection { reply })
            .await?;
        let model = self.deps.side_model.clone();
        let capabilities = model.capabilities(&selection).await;
        let messages = messages(&request, capabilities.as_ref())?;
        // Node `min(params.maxTokens, model.optionSpecs.maxOutputTokens.max)`.
        let max_tokens = capabilities
            .and_then(|found| found.max_output_tokens)
            .map_or(request.max_tokens, |max| request.max_tokens.min(max));
        let max_tokens = u32::try_from(max_tokens).unwrap_or(u32::MAX);
        let system = request
            .system_prompt
            .iter()
            .map(|text| SystemBlock {
                text: text.clone(),
                cache_control: None,
            })
            .collect();
        let mut call = ModelRequest::side(
            selection.clone(),
            SOURCE,
            system,
            messages,
            max_tokens,
            Requester {
                session: self.id.clone(),
                run: None,
                agent: None,
            },
        );
        // The catalog's provider patch rewrites `max_tokens` from its own cap; it takes this call's cap instead (F97).
        call.options.provider_max_output_tokens = Some(max_tokens);
        let started = self.deps.clock.now_ms();
        let mut reply = SideReply::default();
        let mut retries = 0;
        let collect = async {
            let mut stream = model.stream_with_notices(call, cancel.clone());
            while let Some(item) = stream.next().await {
                match item? {
                    ModelStreamItem::Notice(ModelNotice::Retrying { .. }) => retries += 1,
                    ModelStreamItem::Notice(_) => {}
                    ModelStreamItem::Event(event) => reply.push(event),
                }
            }
            Ok::<(), ModelError>(())
        };
        let outcome = tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            outcome = collect => Some(outcome),
        };
        let completed = self.deps.clock.now_ms();
        let tool_calls = reply.tool_calls();
        let answer = match &outcome {
            _ if cancel.is_cancelled() => Err(SamplingError::Cancelled),
            None => Err(SamplingError::Cancelled),
            Some(Err(error)) => Err(SamplingError::Failed(error.to_string())),
            Some(Ok(())) => match stop_reason(reply.stop_reason) {
                Some(stop_reason) if tool_calls == 0 => Ok(SamplingReply {
                    model: selection.model.clone(),
                    text: reply.text(),
                    stop_reason: stop_reason.to_owned(),
                }),
                _ => Err(SamplingError::Failed(UNSUPPORTED_COMPLETION.to_owned())),
            },
        };
        // Node's order: an aborted signal is `cancelled` whatever else happened.
        let status = match &answer {
            Err(SamplingError::Cancelled) => CallStatus::Cancelled,
            Err(_) => CallStatus::Error,
            Ok(_) => CallStatus::Completed,
        };
        let error = match outcome {
            Some(Err(error)) if status == CallStatus::Error => Some(error),
            _ => None,
        };
        let row = ModelCall {
            stop_reason: reply.stop_reason,
            tool_calls,
            usage: Some(reply.usage).filter(|usage| *usage != Usage::default()),
            retries,
            error,
            ..ModelCall::new(
                self.deps.ids.message(),
                QuerySource::Side(SOURCE),
                selection,
                started,
                completed,
                status,
            )
        };
        match self
            .ask(|reply| Request::RecordModelCall {
                call: Box::new(row),
                reply,
            })
            .await
        {
            Ok(Ok(())) => {}
            Ok(Err(reason)) => tracing::warn!(%reason, "the MCP App sampling usage was not stored"),
            Err(error) => tracing::warn!(%error, "the MCP App sampling usage was not stored"),
        }
        answer
    }
}

/// Node maps the AI SDK finish reason: `length` is `maxTokens`, `stop` is `endTurn`, anything else is passed through;
/// a missing, `error`, `unknown` or `tool-calls` reason is no supported completion (None). The names are the AI SDK's
/// mapping of the Anthropic reasons.
fn stop_reason(reason: Option<StopReason>) -> Option<&'static str> {
    match reason? {
        StopReason::EndTurn | StopReason::StopSequence | StopReason::PauseTurn => Some("endTurn"),
        StopReason::MaxTokens | StopReason::ModelContextWindowExceeded => Some("maxTokens"),
        StopReason::Refusal => Some("content-filter"),
        StopReason::ToolUse | StopReason::Unknown => None,
    }
}

/// The panel's messages as model messages. A model known to take no images refuses an image block (Node checks
/// `inputFormat.supportsImage`); unknown capabilities leave it to the model adapter.
fn messages(
    request: &SamplingRequest,
    capabilities: Option<&ModelCapabilities>,
) -> Result<Vec<ApiMessage>, SamplingError> {
    let takes_images = capabilities.is_none_or(|found| found.supports_image);
    request
        .messages
        .iter()
        .map(|message| {
            let content = message
                .content
                .iter()
                .map(|block| {
                    let block = match block {
                        SamplingBlock::Text(text) => ContentBlock::Text { text: text.clone() },
                        SamplingBlock::Image { .. } if !takes_images => {
                            return Err(SamplingError::Failed(NO_IMAGE_INPUT.to_owned()));
                        }
                        SamplingBlock::Image { mime_type, data } => ContentBlock::Image {
                            source: ImageSource::Base64 {
                                media_type: mime_type.clone(),
                                data: data.clone(),
                            },
                            name: None,
                        },
                    };
                    Ok(ApiContent {
                        block,
                        cache_control: None,
                        meta: false,
                    })
                })
                .collect::<Result<_, _>>()?;
            Ok(ApiMessage {
                role: if message.assistant {
                    ApiRole::Assistant
                } else {
                    ApiRole::User
                },
                content,
                output_config: None,
            })
        })
        .collect()
}

impl Actor {
    /// The usage row of a sampling call: its own batch, anchored to no turn. A draft session is stored by it.
    pub(crate) async fn record_model_call(&self, call: ModelCall) -> Result<(), String> {
        self.commit_in_turn(None, vec![Fact::ModelCalled { call }])
            .await
            .map_err(|reason| reason.to_string())
    }
}

#[cfg(test)]
#[path = "sampling_tests.rs"]
mod tests;
