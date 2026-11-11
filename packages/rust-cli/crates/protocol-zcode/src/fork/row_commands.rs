//! Fork: the row action commands `editUserQuery`, `retryTurn` and `forkAssistant` (Node
//! `commands/handlers/fork-edit-retry.ts`; specs/fork-rust-agent-parity.md). A command is accepted only for the row
//! that offers the action now ([`crate::projection::Projection::row_target`]).
//!
//! Edit and retry cut the conversation back to before the turn's typed input (kernel `Rewind{conversation}`) and submit
//! the input again: edit with the new text, retry with the stored content. The rewrite reaches the App as a fresh
//! snapshot ([`crate::live::Live`] rebuilds on `HistoryRewritten`). Fork copies the conversation through the turn into a
//! new session (kernel `ForkFromAssistant`).

use futures_util::StreamExt;
use rust_cli_kernel_api::conversation_quote::{self, Quote};
use rust_cli_kernel_api::hooks::queued_command;
use rust_cli_kernel_api::ids::{MessageId, SessionId};
use rust_cli_kernel_api::input_intent::InputIntent;
use rust_cli_kernel_api::message::{ContentBlock, Message};
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, Command, CommandResult, Delivery, KernelEvent, RewindPreview, RewindScope,
    RewindUnsafeReason,
};
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::commands::{payload, send};
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::projection::{InputMeta, RowAction, TargetMiss};
use crate::server::Server;

const EXECUTION_FAILED: &str = "fault.command.executionFailed";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    row_id: u64,
    entity_id: String,
}

#[derive(Deserialize)]
struct TargetPayload {
    target: Target,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditPayload {
    target: Target,
    new_text: String,
    #[serde(default)]
    attachments: Option<Vec<Value>>,
    #[serde(default)]
    model_selection: Option<Value>,
    /// Fork: `rewind` also restores the files the rewound turns changed (Node's `workspaceMode`).
    #[serde(default)]
    workspace_mode: Option<String>,
    /// Fork: the edited input's quotes; absent keeps the stored ones (Node `canonical-intent-replay.ts`).
    #[serde(default)]
    conversation_quotes: Option<Vec<Quote>>,
}

/// A stored input: its content and the input intent it was admitted with.
struct Stored {
    content: Vec<ContentBlock>,
    intent: Option<InputIntent>,
}

impl Stored {
    /// The content as typed: the first text without the quote block the intent added.
    fn typed(&self) -> Vec<ContentBlock> {
        let mut content = self.content.clone();
        if let Some(intent) = &self.intent
            && let Some(ContentBlock::Text { text }) = content
                .iter_mut()
                .find(|block| matches!(block, ContentBlock::Text { .. }))
        {
            *text = intent.typed(text).to_owned();
        }
        content.retain(|block| !matches!(block, ContentBlock::Text { text } if text.is_empty()));
        content
    }
}

/// Node `inputIntentMetadataFromCanonical` (`canonical-intent-replay.ts`): the intent of an input submitted again
/// from a stored one (specs/fork-agent-runtime-selection.md, Conversation quotes in Rust mode, Edit). `quotes` is the
/// payload's (`None` keeps the stored ones), `attachments` the payload's refs (`None` keeps the stored ones),
/// `(seq, at)` the new admission.
fn replayed_intent(
    (seq, at): (u64, u64),
    envelope: &Envelope,
    stored: Option<&InputIntent>,
    text: &str,
    quotes: Option<&[Quote]>,
    attachments: Option<&[Value]>,
) -> InputIntent {
    let empty = serde_json::Map::new();
    let canonical = stored.map_or(&empty, InputIntent::fields);
    let get = |key: &str| canonical.get(key).filter(|value| !value.is_null());
    let mut fields = serde_json::Map::new();
    if let Some(origin) = envelope
        .input_origin
        .as_deref()
        .filter(|origin| matches!(*origin, "desktop" | "mobile"))
    {
        fields.insert("inputOrigin".into(), json!(origin));
    }
    let quotes = quotes
        .map(|quotes| json!(quotes))
        .or_else(|| get(rust_cli_kernel_api::input_intent::QUOTES).cloned());
    if let Some(quotes) = quotes {
        fields.insert(rust_cli_kernel_api::input_intent::QUOTES.into(), quotes);
    }
    let command = envelope.command_id.as_str();
    fields.insert("sourceCommandId".into(), json!(command));
    fields.insert("queueItemId".into(), json!(format!("queue_{command}")));
    let client = Some(envelope.client_id.as_str())
        .filter(|client| !client.is_empty())
        .or_else(|| {
            get("clientId")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
        });
    fields.insert("clientId".into(), json!(client.unwrap_or("cli")));
    fields.insert(
        "kind".into(),
        get("kind").cloned().unwrap_or_else(|| json!("sendText")),
    );
    fields.insert(rust_cli_kernel_api::input_intent::TEXT.into(), json!(text));
    for key in ["modelSelection", "mode", "planEnabled"] {
        if let Some(value) = get(key) {
            fields.insert(key.into(), value.clone());
        }
    }
    fields.insert("admissionSeq".into(), json!(seq));
    fields.insert("admittedAt".into(), json!(at));
    for key in ["requestedDelivery", "admittedDelivery"] {
        fields.insert(
            key.into(),
            get(key).cloned().unwrap_or_else(|| json!("startNow")),
        );
    }
    let refs = attachments
        .map(|refs| json!(refs))
        .or_else(|| get("attachmentRefs").cloned())
        .filter(|refs| refs.as_array().is_some_and(|refs| !refs.is_empty()));
    if let Some(refs) = refs {
        fields.insert("attachmentRefs".into(), refs);
    }
    let provenance = get("provenance").cloned().or_else(|| {
        let mut original = serde_json::Map::new();
        original.insert("sourceCommandId".into(), get("sourceCommandId")?.clone());
        for key in ["queueItemId", "clientId"] {
            if let Some(value) = get(key) {
                original.insert(key.into(), value.clone());
            }
        }
        Some(Value::Object(original))
    });
    if let Some(provenance) = provenance {
        fields.insert("provenance".into(), provenance);
    }
    InputIntent::from_fields(fields)
}

fn refused(envelope: &Envelope, code: &str, message: impl Into<String>, revision: u64) -> Ack {
    Ack::refused(
        &envelope.command_id,
        Status::Rejected,
        code,
        message,
        revision,
    )
}

/// A row action command whose target missed: stale when the projection no longer holds the row,
/// rejected when the row does not offer the action (Node's `validateRowTarget`).
pub(super) fn target_refused(
    envelope: &Envelope,
    miss: TargetMiss,
    message: impl Into<String>,
    revision: u64,
) -> Ack {
    let status = match miss {
        TargetMiss::Stale => Status::Stale,
        TargetMiss::Unavailable => Status::Rejected,
    };
    Ack::refused(&envelope.command_id, status, miss.code(), message, revision)
}

/// The typed user message `id` as it is stored now, or the prompt of the guided steer `id` (Fork: a guided row is
/// edited like a typed input).
async fn stored_input(live: &Bridged<Live>, id: &str) -> Option<Stored> {
    let view = live.handle.view().await.ok()?;
    view.messages.into_iter().find_map(|message| match message {
        Message::User(user) if user.id.as_str() == id => Some(Stored {
            content: user.content,
            intent: user.intent.map(|intent| *intent),
        }),
        Message::Attachment(attachment) if attachment.id.as_str() == id => {
            queued_command::guided(&attachment).map(|(prompt, _)| Stored {
                content: vec![ContentBlock::Text {
                    text: prompt.to_owned(),
                }],
                intent: queued_command::intent(&attachment),
            })
        }
        _ => None,
    })
}

/// Node preempts a running turn before an edit: interrupt it and wait for its `TurnFinished`.
async fn settle_running_turn(live: &Bridged<Live>, envelope: &Envelope) -> Result<(), String> {
    let view = live
        .handle
        .view()
        .await
        .map_err(|error| error.to_string())?;
    if !view.running {
        return Ok(());
    }
    let mut events = live.handle.subscribe(Some(view.last_seq));
    let stop = format!("{}:stop", envelope.command_id);
    if let KernelAck::Rejected { reason } =
        send(live.handle.as_ref(), &stop, Command::Interrupt).await
    {
        return Err(reason);
    }
    while let Some(event) = events.next().await {
        if matches!(event.event, KernelEvent::TurnFinished { .. }) {
            return Ok(());
        }
    }
    Err("the session ended before the running turn stopped".to_owned())
}

async fn rewind_to(
    live: &Bridged<Live>,
    envelope: &Envelope,
    input: &str,
    scope: RewindScope,
) -> Result<(), String> {
    let command = Command::Rewind {
        target: MessageId::new(input),
        scope,
    };
    let id = format!("{}:rewind", envelope.command_id);
    let mut rebuilds = live.sink.rebuilds();
    rebuilds.mark_unchanged();
    match send(live.handle.as_ref(), &id, command).await {
        // The accepted rewind has appended `HistoryRewritten`; the resubmitted input must reach the kernel only after
        // the projection is rebuilt from the cut history (`Live::rebuilds`).
        KernelAck::Accepted { .. } => rebuilds
            .changed()
            .await
            .map_err(|_| "the session closed before the history was rebuilt".to_owned()),
        KernelAck::Duplicate => Ok(()),
        KernelAck::Rejected { reason } => Err(reason),
    }
}

enum Blocked {
    /// The `editUserQuery` result with `disposition: blocked` (Node returns it as an accepted result).
    Preview(Value),
    Failed(String),
}

/// Node's `fileRewindPreview` result (`v4ConversationFileRewindPreviewResultSchema`). Shell changes are not tracked
/// by this agent's checkpoints, so `ignoredFiles` stays empty.
pub(crate) fn preview_json(preview: &RewindPreview) -> Value {
    let safe: Vec<Value> = preview
        .safe
        .iter()
        .map(|file| {
            json!({
                "action": if file.delete { "delete" } else { "restore" },
                "operationCount": file.operation_count,
                "path": file.path,
                "toolNames": file.tool_names,
            })
        })
        .collect();
    let unsafe_files: Vec<Value> = preview
        .unsafe_files
        .iter()
        .map(|file| {
            let mut value = json!({
                "operationCount": file.operation_count,
                "path": file.path,
                "reason": match file.reason {
                    RewindUnsafeReason::CheckpointMissing => "checkpoint_missing",
                    RewindUnsafeReason::CheckpointUnreadable => "checkpoint_unreadable",
                    RewindUnsafeReason::ExternalModified => "external_modified",
                    RewindUnsafeReason::FileReadFailed => "file_read_failed",
                    RewindUnsafeReason::UnsupportedCheckpoint => "unsupported_checkpoint",
                },
                "toolNames": file.tool_names,
            });
            for (key, field) in [
                ("currentHash", &file.current_hash),
                ("expectedHash", &file.expected_hash),
                ("message", &file.message),
            ] {
                if let Some(text) = field {
                    value[key] = json!(text);
                }
            }
            value
        })
        .collect();
    json!({
        "canApply": !preview.safe.is_empty() && preview.unsafe_files.is_empty(),
        "ignoredFiles": [],
        "safeFiles": safe,
        "unsafeFiles": unsafe_files,
    })
}

/// Node's `editUserQuery` with `workspaceMode: rewind`: the files are checked first; unsafe files, or no file to
/// restore, block the whole edit (fail closed) and return the preview, and nothing changes.
async fn workspace_rewind(live: &Bridged<Live>, input: &str) -> Result<(), Blocked> {
    let preview = live
        .handle
        .rewind_preview(&MessageId::new(input))
        .await
        .map_err(|error| Blocked::Failed(error.to_string()))?;
    let reason = if !preview.unsafe_files.is_empty() {
        "guard.workspaceRewindUnsafeFiles"
    } else if preview.safe.is_empty() {
        "guard.workspaceRewindUnavailable"
    } else {
        return Ok(());
    };
    Err(Blocked::Preview(json!({
        "type": "editUserQuery",
        "disposition": "blocked",
        "sessionId": live.handle.id().as_str(),
        "reasonCode": reason,
        "preview": preview_json(&preview),
    })))
}

/// Submits `content` under the command's id, so the new turn's rows carry it as `sourceCommandId`.
async fn resubmit(
    live: &Bridged<Live>,
    envelope: &Envelope,
    text: &str,
    content: Vec<ContentBlock>,
    intent: InputIntent,
) -> KernelAck {
    live.sink.remember_input(
        &envelope.command_id,
        InputMeta {
            client: envelope.client_id.clone(),
            origin: envelope.input_origin.clone(),
            text: text.to_owned(),
            admitted_at: 0,
            requested: "startNow",
            admitted: "startNow",
            attachments: Vec::new(),
        },
    );
    let only_text = content
        .iter()
        .all(|block| matches!(block, ContentBlock::Text { .. }));
    let submit = Command::SubmitWith {
        kind: rust_cli_kernel_api::session_api::QueuedKind::Text,
        text: text.to_owned(),
        content: if only_text { Vec::new() } else { content },
        delivery: Delivery::Queue,
        execution: None,
        behind_held: false,
        intent: Some(Box::new(intent)),
    };
    send(live.handle.as_ref(), &envelope.command_id, submit).await
}

/// The stored files the edited input keeps: all of them when the App sent no `attachments`, otherwise the ones it
/// still lists. Refs it lists that the stored input does not have are new uploads, read like `sendText` reads them.
async fn edited_content(
    server: &Server,
    session: &SessionId,
    stored: &[ContentBlock],
    text: &str,
    attachments: Option<&[Value]>,
) -> Result<Vec<ContentBlock>, String> {
    let Some(listed) = attachments else {
        let mut content = Vec::new();
        if !text.is_empty() {
            content.push(ContentBlock::Text {
                text: text.to_owned(),
            });
        }
        content.extend(
            stored
                .iter()
                .filter(|block| matches!(block, ContentBlock::File { .. }))
                .cloned(),
        );
        return Ok(content);
    };
    let refs = crate::attachments::parse_refs(listed).map_err(|error| error.message)?;
    let kept_ref = |reference: &str| {
        stored.iter().find(|block| {
            matches!(block, ContentBlock::File { file } if file.reference.as_deref() == Some(reference))
        })
    };
    let (kept, new): (Vec<_>, Vec<_>) = refs
        .into_iter()
        .partition(|attachment| kept_ref(attachment.reference()).is_some());
    let mut content = crate::attachments::content(server, session, text, new)
        .await
        .map_err(|error| error.message)?;
    let files = kept
        .iter()
        .filter_map(|attachment| kept_ref(attachment.reference()).cloned());
    // Kept files go before the new ones, in the order the App lists them.
    let at = usize::from(!text.is_empty());
    content.splice(at..at, files);
    Ok(content)
}

/// Quotes alone are an input (Node `fork-edit-retry.ts`).
fn is_input(content: &[ContentBlock], intent: &InputIntent) -> bool {
    has_input(content) || intent.quotes().is_some_and(|quotes| !quotes.is_empty())
}

fn has_input(content: &[ContentBlock]) -> bool {
    content.iter().any(|block| match block {
        ContentBlock::Text { text } => !text.trim().is_empty(),
        _ => true,
    })
}

pub(super) async fn edit(
    server: &Server,
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: EditPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let target =
        match live
            .sink
            .row_target(body.target.row_id, &body.target.entity_id, RowAction::Edit)
        {
            Ok(target) => target,
            Err(miss) => {
                return target_refused(
                    envelope,
                    miss,
                    format!(
                        "row {} is not the latest editable input",
                        body.target.row_id
                    ),
                    revision,
                );
            }
        };
    let Some(stored) = stored_input(live, &target.user_message).await else {
        return refused(
            envelope,
            EXECUTION_FAILED,
            "the input is no longer stored",
            revision,
        );
    };
    if let Err(reason) =
        conversation_quote::validate(body.conversation_quotes.as_deref().unwrap_or_default())
    {
        return refused(envelope, "proto.invalidPayload", reason, revision);
    }
    let intent = replayed_intent(
        live.sink.admit(),
        envelope,
        stored.intent.as_ref(),
        &body.new_text,
        body.conversation_quotes.as_deref(),
        body.attachments.as_deref(),
    );
    // The session adds the quote block after the edited text (Node `withConversationQuotes`).
    let text = body.new_text.clone();
    let session = live.handle.id().clone();
    let content = match edited_content(
        server,
        &session,
        &stored.content,
        &text,
        body.attachments.as_deref(),
    )
    .await
    {
        Ok(content) => content,
        Err(message) => return refused(envelope, "proto.invalidPayload", message, revision),
    };
    // Checked before the history is cut, like Node: an empty edit changes nothing.
    if !is_input(&content, &intent) {
        return refused(
            envelope,
            "fault.command.inputRejected",
            "the edited input is empty",
            revision,
        );
    }
    if let Err(reason) = settle_running_turn(live, envelope).await {
        return refused(envelope, EXECUTION_FAILED, reason, revision);
    }
    let scope = if body.workspace_mode.as_deref() == Some("rewind") {
        match workspace_rewind(live, &target.user_message).await {
            Ok(()) => RewindScope::Both,
            Err(Blocked::Preview(result)) => {
                return Ack::accepted(&envelope.command_id, revision, Some(result));
            }
            Err(Blocked::Failed(reason)) => {
                return refused(envelope, EXECUTION_FAILED, reason, revision);
            }
        }
    } else {
        RewindScope::Conversation
    };
    if let Some(chosen) = crate::commands::selection(body.model_selection.as_ref())
        && live.sink.current_config().0 != chosen
    {
        let id = format!("{}:model", envelope.command_id);
        send(
            live.handle.as_ref(),
            &id,
            Command::SetModel { selection: chosen },
        )
        .await;
    }
    if let Err(reason) = rewind_to(live, envelope, &target.user_message, scope).await {
        return refused(envelope, EXECUTION_FAILED, reason, revision);
    }
    let result =
        json!({"type": "editUserQuery", "disposition": "rewind", "sessionId": session.as_str()});
    match resubmit(live, envelope, &text, content, intent).await {
        KernelAck::Accepted { .. } | KernelAck::Duplicate => {
            Ack::accepted(&envelope.command_id, revision, Some(result))
        }
        KernelAck::Rejected { reason } => refused(envelope, EXECUTION_FAILED, reason, revision),
    }
}

pub(super) async fn retry(live: &Bridged<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let body: TargetPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let target =
        match live
            .sink
            .row_target(body.target.row_id, &body.target.entity_id, RowAction::Retry)
        {
            Ok(target) => target,
            Err(miss) => {
                return target_refused(
                    envelope,
                    miss,
                    format!(
                        "row {} is not the latest assistant reply",
                        body.target.row_id
                    ),
                    revision,
                );
            }
        };
    // Read before the cut: after it the input is gone.
    let Some(stored) = stored_input(live, &target.user_message).await else {
        return refused(
            envelope,
            EXECUTION_FAILED,
            "the input is no longer stored",
            revision,
        );
    };
    if let Err(reason) = rewind_to(
        live,
        envelope,
        &target.user_message,
        RewindScope::Conversation,
    )
    .await
    {
        return refused(envelope, EXECUTION_FAILED, reason, revision);
    }
    // Retry submits the stored input again, typed text and quotes as they were.
    let content = stored.typed();
    let text = crate::projection::text_of(&content);
    let intent = replayed_intent(
        live.sink.admit(),
        envelope,
        stored.intent.as_ref(),
        &text,
        None,
        None,
    );
    match resubmit(live, envelope, &text, content, intent).await {
        KernelAck::Accepted { .. } | KernelAck::Duplicate => {
            Ack::accepted(&envelope.command_id, revision, None)
        }
        KernelAck::Rejected { reason } => refused(envelope, EXECUTION_FAILED, reason, revision),
    }
}

pub(super) async fn fork(
    server: &Server,
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: TargetPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let assistant = match live
        .sink
        .fork_target(body.target.row_id, &body.target.entity_id)
    {
        Ok(assistant) => assistant,
        Err(miss) => {
            return target_refused(
                envelope,
                miss,
                format!("row {} cannot be forked from", body.target.row_id),
                revision,
            );
        }
    };
    let command = Command::ForkFromAssistant {
        assistant: MessageId::new(&assistant),
    };
    let forked = match send(live.handle.as_ref(), &envelope.command_id, command).await {
        KernelAck::Accepted {
            result: CommandResult::Forked(forked),
        } => forked,
        KernelAck::Accepted { .. } | KernelAck::Duplicate => {
            return refused(
                envelope,
                EXECUTION_FAILED,
                "the fork returned no session",
                revision,
            );
        }
        KernelAck::Rejected { reason } => {
            return refused(envelope, "guard.forkTargetNotStable", reason, revision);
        }
    };
    // The child is opened now, so the sessions index lists it before the App switches to it.
    match server.live(&forked.session).await {
        Ok(child) => crate::subscribe::announce(&child),
        Err(error) => {
            tracing::warn!(event = "protocol.fork.open_failed", error = %error, "opening the forked session failed");
        }
    }
    tracing::info!(
        event = "protocol.fork.completed",
        copied = forked.copied,
        "forkAssistant completed"
    );
    let result = json!({"type": "forkAssistant", "sessionId": forked.session.as_str()});
    Ack::accepted(&envelope.command_id, revision, Some(result))
}

#[cfg(test)]
#[path = "row_commands_tests.rs"]
mod tests;
