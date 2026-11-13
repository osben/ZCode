//! One ACP turn (Node `acp-external-agent-host.ts` `runTurn` and core `external-agent-turn.ts`): read the agent
//! record, acquire the session's runtime, prompt it with the newest human input, stream its message and thought
//! chunks, and commit them as assistant messages. Stop is a bounded `session/cancel`.

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use futures_util::stream::{FuturesUnordered, StreamExt as _};
use rust_cli_acp::registry::{display_name, is_auth_failure, login_command};
use rust_cli_acp::{
    AcpError, AcpErrorCode, AcpLaunch, PermissionAnswer, PermissionAsk, PromptResponse,
    RuntimeEvent,
};
use rust_cli_kernel_api::abort::{Abort, AbortReason};
use rust_cli_kernel_api::ids::ToolUseId;
use rust_cli_kernel_api::interaction::{Answer, PermissionAnswer as UserAnswer};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, ImageSource, Message, StopReason, Usage, UserMessage,
    UserOrigin,
};
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::orchestration::{
    InteractionRequest, QueryError, QueryEvent, QueryRequest, QueryStop, RunSink,
};
use rust_cli_kernel_api::user_input::INTERRUPT_TEXTS;
use serde_json::{Value, json};

use super::AcpHost;

pub(super) async fn run(
    host: &Arc<AcpHost>,
    agent_id: String,
    request: QueryRequest,
    sink: Arc<dyn RunSink>,
    abort: Abort,
) -> Result<QueryStop, QueryError> {
    // The prompt hook messages are committed first, as in the query loop.
    if !request.prompt_hook_messages.is_empty() {
        sink.commit_messages(request.prompt_hook_messages.clone())
            .await?;
    }
    let mut turn = Turn {
        host,
        sink,
        model: request.selection.model.clone(),
        response: 0,
        segment: Vec::new(),
        tools: HashMap::new(),
        halt: abort.token().child_token(),
        failed: None,
    };
    let launch = match read_launch(host, &agent_id, &request).await {
        Ok(launch) => launch,
        Err(message) => return Ok(QueryStop::ApiError { message }),
    };
    if abort.is_aborted() {
        return turn.aborted(&abort).await;
    }
    // Node: "Stop can arrive at any await of the spawn".
    let acquiring = host.acquire(request.session.clone(), launch);
    let acquired = tokio::select! {
        biased;
        () = abort.token().cancelled() => return turn.aborted(&abort).await,
        acquired = AcpHost::acquired(acquiring) => acquired,
    };
    let runtime = match acquired {
        Ok(runtime) => runtime,
        Err(_) if abort.is_aborted() => return turn.aborted(&abort).await,
        Err(error) => {
            tracing::warn!(event = "acp.start_failed", agent = %agent_id, error = %error.message, "ACP agent could not be started");
            return Ok(QueryStop::ApiError {
                message: start_failure(&agent_id, &error),
            });
        }
    };
    // The session start is read once; the context-reset divider follows with the session events (S5).
    let _ = runtime.take_session_start();
    if abort.is_aborted() {
        return turn.aborted(&abort).await;
    }
    let (mut events, guard) = runtime.bind();
    let prompt = runtime.prompt(prompt_blocks(&request.messages));
    tokio::pin!(prompt);
    // Stop, or a lost segment commit, is a bounded `session/cancel`; the prompt then settles. This future never
    // completes.
    let halt = turn.halt.clone();
    let canceller = runtime.clone();
    let cancelling = {
        let halt = halt.clone();
        async move {
            halt.cancelled().await;
            canceller.cancel().await;
            std::future::pending::<()>().await;
        }
    };
    tokio::pin!(cancelling);
    // Permission asks wait for the user beside the event stream; a stop drops them (the agent hears `cancelled`).
    let mut asks: FuturesUnordered<BoxFuture<'static, ()>> = FuturesUnordered::new();
    let mut halted = false;
    let outcome = loop {
        tokio::select! {
            biased;
            // The halt branches come first so a flood of agent updates cannot starve Stop. After the first fire the
            // withdraw branch is armed only by an ask the agent sends after Stop, withdrawn before its dialog opens.
            () = halt.cancelled(), if !halted || !asks.is_empty() => {
                halted = true;
                turn.withdraw_asks(&mut asks).await;
            }
            () = &mut cancelling => {}
            Some(event) = events.recv() => {
                if let Some(ask) = turn.on_event(event).await {
                    asks.push(ask);
                }
            }
            Some(()) = asks.next(), if !asks.is_empty() => {}
            outcome = &mut prompt => break outcome,
        }
    };
    // Updates the agent sent before its answer are already queued; later ones belong to no turn.
    for _ in 0..events.len() {
        let Ok(event) = events.try_recv() else { break };
        if let Some(ask) = turn.on_event(event).await {
            asks.push(ask);
        }
    }
    turn.withdraw_asks(&mut asks).await;
    drop(guard);
    // A lost segment fails the turn like a failed commit in the query loop.
    if let Some(error) = turn.failed.take() {
        return Err(error);
    }
    match outcome {
        // Node `external-agent-turn.ts`: after Stop the turn ends interrupted whatever the agent answered.
        _ if abort.is_aborted() => {
            turn.close_segment(outcome.as_ref().ok().and_then(usage_of))
                .await?;
            turn.aborted(&abort).await
        }
        Ok(response) => {
            turn.close_segment(usage_of(&response)).await?;
            Ok(QueryStop::Completed)
        }
        Err(error) => {
            turn.close_segment(None).await?;
            tracing::warn!(event = "acp.prompt_failed", agent = %agent_id, error = %error.message, "ACP agent turn failed");
            Ok(QueryStop::ApiError {
                message: prompt_failure(&agent_id, &error),
            })
        }
    }
}

/// Node `readEnabledLaunch`.
async fn read_launch(
    host: &AcpHost,
    agent_id: &str,
    request: &QueryRequest,
) -> Result<AcpLaunch, String> {
    let label = display_name(agent_id);
    let Some(record) = host.records.find(agent_id).await else {
        return Err(format!(
            "{label} is no longer configured. Enable it again in Settings > Model Providers."
        ));
    };
    if !record.enabled {
        return Err(format!(
            "{label} is turned off. Enable it in Settings > Model Providers to continue."
        ));
    }
    Ok(AcpLaunch {
        agent_id: agent_id.to_owned(),
        command: record.command,
        args: record.args,
        env: record.env,
        cwd: request.workspace.root.as_str().to_owned(),
    })
}

/// Node `toStartFailure`.
fn start_failure(agent_id: &str, error: &AcpError) -> String {
    if is_auth_failure(&error.message) {
        return auth_required(agent_id);
    }
    format!(
        "{} could not be started. Check that it is installed and that its launch settings are correct.",
        display_name(agent_id)
    )
}

/// Node `toPromptFailure`.
fn prompt_failure(agent_id: &str, error: &AcpError) -> String {
    if is_auth_failure(&error.message) {
        return auth_required(agent_id);
    }
    if matches!(
        error.code,
        AcpErrorCode::AgentDied | AcpErrorCode::StreamClosed
    ) {
        return format!(
            "{} stopped during the turn. Send the message again to restart it.",
            display_name(agent_id)
        );
    }
    format!(
        "{} could not complete the turn: {}",
        display_name(agent_id),
        error.message
    )
}

fn auth_required(agent_id: &str) -> String {
    format!(
        "{} requires sign-in. Run \"{}\" in a terminal, then send your message again.",
        display_name(agent_id),
        login_command(agent_id)
    )
}

/// Node `buildExternalAgentPrompt`: the newest human input's text and its images, as ACP content blocks.
fn prompt_blocks(messages: &[Message]) -> Vec<Value> {
    let input = messages.iter().rev().find_map(|message| match message {
        Message::User(user) if user.origin == UserOrigin::Human && !is_interrupt(user) => {
            Some(user)
        }
        _ => None,
    });
    let Some(input) = input else {
        return vec![json!({"type": "text", "text": ""})];
    };
    let text = input
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut blocks = vec![json!({"type": "text", "text": text})];
    blocks.extend(input.content.iter().filter_map(|block| match block {
        ContentBlock::Image {
            source: ImageSource::Base64 { media_type, data },
            ..
        } => Some(json!({"type": "image", "mimeType": media_type, "data": data})),
        _ => None,
    }));
    blocks
}

fn is_interrupt(user: &UserMessage) -> bool {
    matches!(user.content.as_slice(), [ContentBlock::Text { text }] if INTERRUPT_TEXTS.contains(&text.as_str()))
}

/// Node `toModelUsage`, folded into the stored usage (reasoning and totals have no field there).
fn usage_of(response: &PromptResponse) -> Option<Usage> {
    let usage = response.usage.as_ref()?.as_object()?;
    let count = |key: &str| usage.get(key).and_then(Value::as_u64);
    let keys = [
        "inputTokens",
        "outputTokens",
        "cachedReadTokens",
        "cachedWriteTokens",
    ];
    if keys.iter().all(|key| count(key).is_none()) {
        return None;
    }
    Some(Usage {
        input_tokens: count("inputTokens").unwrap_or_default(),
        output_tokens: count("outputTokens").unwrap_or_default(),
        cache_creation_input_tokens: count("cachedWriteTokens").unwrap_or_default(),
        cache_read_input_tokens: count("cachedReadTokens").unwrap_or_default(),
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Thinking,
}

/// The turn's open segment and the response counter of the live rows.
struct Turn<'a> {
    host: &'a AcpHost,
    sink: Arc<dyn RunSink>,
    model: String,
    /// The live rows of the open segment are keyed by this response number (the projection settles them by it).
    response: usize,
    /// Text and reasoning since the last tool or plan event, one block per kind in order of first appearance.
    segment: Vec<(Kind, String)>,
    /// ACP `toolCallId` → its row id and kind, minted on first sight (rows and asks share it).
    tools: HashMap<String, (ToolUseId, Option<String>)>,
    /// Stop or a lost segment: cancels the prompt and withdraws the asks.
    halt: tokio_util::sync::CancellationToken,
    /// The first segment commit that failed mid-turn; later segments are not written after it.
    failed: Option<QueryError>,
}

impl Turn<'_> {
    /// Applies one agent event; a permission ask comes back as the future that waits for the user.
    async fn on_event(&mut self, event: RuntimeEvent) -> Option<BoxFuture<'static, ()>> {
        match event {
            RuntimeEvent::MessageChunk(text) => self.chunk(Kind::Text, text).await,
            RuntimeEvent::ThoughtChunk(text) => self.chunk(Kind::Thinking, text).await,
            RuntimeEvent::ToolCall(info) | RuntimeEvent::ToolCallUpdate(info) => {
                if let Some(kind) = info.kind.clone() {
                    self.tool(&info.tool_call_id).1 = Some(kind);
                }
                self.close_segment_logged().await;
            }
            RuntimeEvent::Plan(_) => self.close_segment_logged().await,
            RuntimeEvent::Permission { ask, reply } => return Some(self.permission(ask, reply)),
            RuntimeEvent::AvailableCommands(count) => {
                tracing::debug!(
                    event = "acp.commands",
                    count,
                    "ACP agent advertised commands"
                );
            }
            RuntimeEvent::Stalled { silent_ms } => {
                tracing::warn!(
                    event = "acp.stalled",
                    silent_ms,
                    "ACP agent produced no output for a while"
                );
            }
            RuntimeEvent::SessionTitle(_)
            | RuntimeEvent::ConfigOptions(_)
            | RuntimeEvent::Resumed => {}
        }
        None
    }

    /// A tool or plan event closes the open text segment (rows follow in S3). A failed commit halts the turn, which
    /// then fails with that error.
    async fn close_segment_logged(&mut self) {
        if self.failed.is_some() {
            self.segment.clear();
            return;
        }
        if let Err(error) = self.close_segment(None).await {
            tracing::warn!(event = "acp.segment_commit_failed", %error, "ACP text segment could not be committed");
            self.failed = Some(error);
            self.halt.cancel();
        }
    }

    fn tool(&mut self, tool_call_id: &str) -> &mut (ToolUseId, Option<String>) {
        let ids = &self.host.ids;
        self.tools
            .entry(tool_call_id.to_owned())
            .or_insert_with(|| (ToolUseId::new(format!("acp_{}", ids.execution())), None))
    }

    /// Node `answerExternalAgentPermission`: a user-once ask (no mode or rule answers it). Allow selects the agent's
    /// `allow_once` option and deny its `reject_once`; an ask nobody answers is `cancelled`.
    fn permission(
        &mut self,
        ask: PermissionAsk,
        reply: tokio::sync::oneshot::Sender<PermissionAnswer>,
    ) -> BoxFuture<'static, ()> {
        let (tool_use, kind) = self.tool(&ask.tool_call_id).clone();
        let tool = format!("acp:{}", kind.as_deref().unwrap_or("other"));
        let message = if ask.title.trim().is_empty() {
            format!("{tool} needs your approval")
        } else {
            ask.title.clone()
        };
        let mut input = json!({"title": ask.title});
        if let Some(detail) = &ask.detail {
            input["detail"] = json!(detail);
        }
        let request = InteractionRequest::Permission {
            tool_use,
            tool,
            input,
            message,
            suggestions: Vec::new(),
            rule_seed: None,
            asked_by: None,
            machine: Default::default(),
            once: true,
            independent: false,
            origin: None,
        };
        let sink = self.sink.clone();
        Box::pin(async move {
            let answer = match sink.ask(request).await {
                Ok(answer) => match answer.answer {
                    Answer::Permission(UserAnswer::Allow { .. }) => PermissionAnswer::Selected {
                        kind: "allow_once".to_owned(),
                    },
                    Answer::Permission(UserAnswer::Deny { .. }) => PermissionAnswer::Selected {
                        kind: "reject_once".to_owned(),
                    },
                    _ => PermissionAnswer::Cancelled,
                },
                Err(_) => PermissionAnswer::Cancelled,
            };
            let _ = reply.send(answer);
        })
    }

    /// Drops the asks still waiting (their agent requests answer `cancelled`) and closes their dialogs.
    async fn withdraw_asks(&mut self, asks: &mut FuturesUnordered<BoxFuture<'static, ()>>) {
        if asks.is_empty() {
            return;
        }
        asks.clear();
        for (tool_use, _) in self.tools.values() {
            self.sink.cancel_ask(tool_use).await;
        }
    }

    async fn chunk(&mut self, kind: Kind, text: String) {
        if text.is_empty() {
            return;
        }
        let index = match self.segment.iter().position(|(open, _)| *open == kind) {
            Some(index) => index,
            None => {
                self.segment.push((kind, String::new()));
                self.segment.len() - 1
            }
        };
        self.segment[index].1.push_str(&text);
        let delta = match kind {
            Kind::Text => BlockDelta::Text(text),
            Kind::Thinking => BlockDelta::Thinking(text),
        };
        let _ = self
            .sink
            .emit(QueryEvent::Delta {
                message: self.response,
                index,
                delta,
            })
            .await;
    }

    /// Commits the open segment as one assistant message; the next segment streams under a new response number.
    async fn close_segment(&mut self, usage: Option<Usage>) -> Result<(), QueryError> {
        if self.segment.is_empty() {
            return Ok(());
        }
        let content = std::mem::take(&mut self.segment)
            .into_iter()
            .map(|(kind, text)| match kind {
                Kind::Text => ContentBlock::Text { text },
                Kind::Thinking => ContentBlock::Thinking {
                    thinking: text,
                    signature: None,
                },
            })
            .collect();
        let message = Message::Assistant(AssistantMessage {
            id: self.host.ids.message(),
            content,
            model: self.model.clone(),
            stop_reason: Some(StopReason::EndTurn),
            usage,
        });
        self.sink.commit_message(message).await?;
        self.response += 1;
        Ok(())
    }

    /// The interrupt marker the query loop writes on a user stop (not for a submit or shutdown).
    async fn aborted(&mut self, abort: &Abort) -> Result<QueryStop, QueryError> {
        if !matches!(
            abort.reason(),
            Some(AbortReason::Submit | AbortReason::Shutdown)
        ) {
            let marker = Message::User(UserMessage {
                stall_execution: None,
                intent: None,
                id: self.host.ids.message(),
                content: vec![ContentBlock::Text {
                    text: INTERRUPT_TEXTS[0].to_owned(),
                }],
                origin: UserOrigin::Human,
            });
            self.sink.commit_message(marker).await?;
        }
        Ok(QueryStop::Aborted)
    }
}

#[cfg(test)]
#[path = "turn_tests.rs"]
mod tests;
