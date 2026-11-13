//! 命令的处理（[`crate::inbox`] 的裁决与转交）：P1 的五个命令。

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::{CommandId, InteractionId, SessionId, ToolUseId};
use rust_cli_kernel_api::incognito::IncognitoProfile;
use rust_cli_kernel_api::interaction::PermissionAnswer;
use rust_cli_kernel_api::message::ContentBlock;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::permission::{ExecutionState, PermissionMode};
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, Command, CommandEnvelope, CommandResult, CreateSession, Delivery,
    InputExecution, QueuedKind, SessionHandle,
};
use rust_cli_kernel_api::turn_limits::TurnLimits;
use rust_cli_protocol_core::rpc::RpcError;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::inbound::Inbound;
use crate::inbox::{self, Ack, Envelope, Status};
use crate::projection::InputMeta;
use crate::projection::state::{Followup, Phase};
use crate::server::{Server, kernel_error};

/// App 的模型选择（`modelSelectionSchema`）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSelection {
    provider_id: String,
    model_id: String,
    #[serde(default)]
    options: AppSelectionOptions,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSelectionOptions {
    reasoning_level: Option<String>,
}

/// App 的模型选择 → 内核的选择。原样留着 JSON（排队项照原样带回去），用时再解。
pub(crate) fn selection(value: Option<&Value>) -> Option<ModelSelection> {
    let chosen: AppSelection = serde_json::from_value(value?.clone()).ok()?;
    Some(ModelSelection {
        reasoning: chosen.options.reasoning_level,
        ..ModelSelection::new(chosen.provider_id, chosen.model_id)
    })
}

pub(crate) use rust_cli_kernel_api::permission::resolve_execution;

/// 一次输入（sendText 的 payload、createSession 的 firstInput；只取用到的字段）。
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    text: Option<String>,
    model_selection: Option<Value>,
    mode: Option<String>,
    plan_enabled: Option<bool>,
    input_origin: Option<String>,
    requested_delivery: Option<Requested>,
    /// Fork: App attachment refs (`attachmentRefSchema`), expanded in [`crate::attachments::content`].
    #[serde(default)]
    attachments: Vec<Value>,
    /// Fork: the client's answer to a paused queue (`inputRouting.mode = choice`), see [`held_queue_choice`].
    held_queue_disposition: Option<HeldDisposition>,
    /// Fork: the queue the client confirmed, as `queueItemId`s; a changed queue makes the confirmation stale.
    expected_held_queue_item_ids: Option<Vec<String>>,
    /// Fork: selections quoted from the conversation, as sent (absent, `[]` or quotes); they travel in the input
    /// intent ([`input_intent`]).
    conversation_quotes: Option<Vec<rust_cli_kernel_api::conversation_quote::Quote>>,
    /// B4: the input's structured source (`conversationInputSourceSchema`, e.g. `{kind: "extension", pluginId}`). The
    /// inbound schema checks its shape before this is read; it is copied onto the intent as it is ([`input_intent`]).
    source: Option<Value>,
    /// Fork: the scheduled automation that dispatched this input (specs/fork-rust-automations.md, slice 1). With
    /// `toolDisallowlist` it limits the turn the input opens ([`TurnLimits`]), never the session.
    automation_id: Option<String>,
    #[serde(default)]
    tool_disallowlist: Vec<String>,
}

/// Fork: `heldQueueDisposition` (`command.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum HeldDisposition {
    ClearQueueAndSend,
    KeepQueueAndSend,
}

/// sendText 要的投递（`requestedDelivery`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Requested {
    StartNow,
    Queue,
    Guide,
}

impl Requested {
    fn as_str(self) -> &'static str {
        match self {
            Self::StartNow => "startNow",
            Self::Queue => "queue",
            Self::Guide => "guide",
        }
    }
}

/// createSession 的 payload。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionPayload {
    session_id: Option<String>,
    workspace_id: Option<String>,
    first_input: Option<Input>,
    /// Fork: durable first submission (crate::preparation).
    submission_preparation: Option<SubmissionPreparation>,
    prepared_session_id: Option<String>,
    expected_submission_id: Option<String>,
    expected_first_input_command_id: Option<String>,
    #[serde(default)]
    config: SessionConfig,
    /// Fork: the incognito profile (strict; parsed by [`incognito_of`]). An explicit `null` is kept as present, so it
    /// is refused like Node's `incognitoProfileSchema.optional()` instead of creating a normal session.
    #[serde(default, deserialize_with = "present")]
    incognito: Option<Value>,
    /// Fork: execution worktree (crate::worktree). An incognito profile cannot ride on its preparation.
    worktree_preparation: Option<crate::worktree::Request>,
    expected_attempt_id: Option<String>,
    execution_worktree: Option<crate::worktree::Requested>,
}

/// Fork: a field that is present, `null` included, reads as `Some` (a missing field takes the serde default).
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// Fork: the requested incognito profile. An invalid profile refuses the command before any row exists, so it never
/// runs as a normal session (specs/fork-rust-agent-parity.md, "Incognito sessions").
fn incognito_of(
    envelope: &Envelope,
    payload: &CreateSessionPayload,
) -> Result<Option<IncognitoProfile>, Box<Ack>> {
    let invalid = |message: String| {
        Box::new(Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            message,
            0,
        ))
    };
    let Some(value) = &payload.incognito else {
        return Ok(None);
    };
    // Node: the reserved worktree row has no profile, so the profile must ride on the activation instead.
    if payload.worktree_preparation.is_some() {
        return Err(invalid(
            "worktree preparation cannot include an incognito profile; send it on the activation createSession"
                .to_owned(),
        ));
    }
    IncognitoProfile::from_wire(value)
        .map(Some)
        .map_err(invalid)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmissionPreparation {
    submission_id: String,
}

/// createSession 的 `config`。
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionConfig {
    model_selection: Option<Value>,
    mode: Option<String>,
    plan_enabled: Option<bool>,
    followup_mode: Option<Followup>,
}

/// resolveInteraction 的 payload。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvePayload {
    interaction_id: String,
    answer: AnswerPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnswerPayload {
    option_id: Option<String>,
    free_text: Option<String>,
    /// Fork: the elicitation dialog's answer to a question or plan approval (projection/elicitation.rs).
    action: Option<String>,
    content: Option<serde_json::Map<String, Value>>,
}

/// setFollowupMode 的 payload。
#[derive(Deserialize)]
struct FollowupPayload {
    mode: Followup,
}

/// 解 payload（已经过 schema，失败只会是 schema 与这里的结构不一致）：解不出时按 payload 不合规拒绝。
pub(crate) fn payload<P: DeserializeOwned>(envelope: &Envelope) -> Result<P, Box<Ack>> {
    serde_json::from_value(envelope.payload.clone()).map_err(|error| {
        Box::new(Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            format!("Invalid {} payload: {error}", envelope.kind),
            0,
        ))
    })
}

/// 内核的回执 → 命令的 ACK：接受是 `accepted`，重复是同一个标成 duplicate，拒绝按 `refused` 给出。
pub(crate) fn ack_of(kernel: KernelAck, accepted: Ack, refused: impl FnOnce(String) -> Ack) -> Ack {
    match kernel {
        KernelAck::Accepted { .. } => accepted,
        KernelAck::Duplicate => inbox::duplicate(&accepted),
        KernelAck::Rejected { reason } => refused(reason),
    }
}

pub(crate) async fn send(handle: &dyn SessionHandle, id: &str, command: Command) -> KernelAck {
    handle
        .send(CommandEnvelope {
            id: CommandId::new(id),
            command,
        })
        .await
}

pub(crate) fn unsupported(envelope: &Envelope, revision: u64) -> Ack {
    tracing::info!(event = "protocol.command.unsupported", kind = %envelope.kind, "command is not supported by this agent");
    Ack::refused(
        &envelope.command_id,
        Status::Rejected,
        "proto.unsupportedCommand",
        format!("{} is not supported by this agent yet", envelope.kind),
        revision,
    )
}

pub async fn command(server: &Server, params: Value) -> Result<Value, RpcError> {
    let envelope: Envelope = serde_json::from_value(params.clone())
        .map_err(|error| RpcError::invalid_params(format!("Invalid command envelope: {error}")))?;
    let key = inbox::key(envelope.session_id.as_deref(), &envelope.command_id);
    let known = server.remembered.lock_unpoisoned().get(&key).cloned();
    if let Some(known) = known {
        return Ok(inbox::duplicate(&known).to_value());
    }
    let ack = match Inbound::get().command(&params) {
        Err(message) => Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            message,
            0,
        ),
        Ok(()) => decide(server, &envelope).await,
    };
    // Like Node (`remember: false`), a stale ack is not remembered: a resend of the same command
    // after the client caught up is decided again instead of replaying the stale verdict.
    if !matches!(ack.status, Status::Duplicate | Status::Stale) {
        server.remembered.lock_unpoisoned().put(key, ack.clone());
    }
    // 命令事实（G2）：会话命令照 Node 的格式落库；写失败只记日志，ACK 照常回。
    // Fork: a deleted session has no record store left for its delete fact.
    if let Some(session) = &envelope.session_id
        && ack.is_fact()
        && envelope.kind != "deleteSession"
        && let Err(error) = server
            .kernel
            .queries()
            .put_record(&SessionId::new(session), &inbox::fact(&ack))
            .await
    {
        tracing::warn!(event = "protocol.command_fact.failed", error = %error, "writing the command fact failed");
    }
    Ok(ack.to_value())
}

pub(crate) async fn decide(server: &Server, envelope: &Envelope) -> Ack {
    if envelope.kind == "createSession" {
        return create_session(server, envelope).await;
    }
    let Some(session) = envelope.session_id.as_deref() else {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.sessionRequired",
            "this command needs a sessionId",
            0,
        );
    };
    if let Some(ack) = crate::worktree::refuse_before_activation(server, envelope, session).await {
        return ack;
    }
    let live = match server.live(&SessionId::new(session)).await {
        Ok(live) => live,
        Err(error) => {
            return Ack::refused(
                &envelope.command_id,
                Status::Rejected,
                "proto.sessionNotFound",
                kernel_error(&error).message,
                0,
            );
        }
    };
    let (phase, revision) = live.sink.status();
    let handle = live.handle.as_ref();
    match envelope.kind.as_str() {
        "sendText" | "sendGoalCommand" => {
            let kind = if envelope.kind == "sendGoalCommand" {
                QueuedKind::Goal
            } else {
                QueuedKind::Text
            };
            // Node `forceStartNow`: every explicit `startNow` text takes the foreground lease, whatever the projected
            // phase (an idle projection may lag behind a promotion that holds the lease).
            let ack = if kind == QueuedKind::Text && requests_start_now(envelope) {
                send_text_now(server, &live, envelope, phase, revision).await
            } else {
                send_text(server, &live, envelope, kind, phase, revision, None).await
            };
            if ack.status == Status::Accepted {
                complete_first_submission(server, &live, envelope).await;
            }
            ack
        }
        "stop" => stop(handle, &live.sink, envelope, phase, revision).await,
        "resolveInteraction" => resolve(server, handle, &live.sink, envelope, revision).await,
        "setFollowupMode" => set_followup(server, handle, &live, envelope).await,
        // Fork: command kinds ported for desktop parity (specs/fork-rust-agent-parity.md).
        _ => match crate::fork::commands::decide(server, &live, envelope, phase, revision).await {
            Some(ack) => ack,
            None => unsupported(envelope, revision),
        },
    }
}

pub(crate) async fn create_session(server: &Server, envelope: &Envelope) -> Ack {
    let payload: CreateSessionPayload = match payload(envelope) {
        Ok(payload) => payload,
        Err(ack) => return *ack,
    };
    let incognito = match incognito_of(envelope, &payload) {
        Ok(incognito) => incognito,
        Err(ack) => return *ack,
    };
    if let Some(preparation) = &payload.submission_preparation {
        return reserve_submission(
            server,
            envelope,
            (&payload, incognito),
            &preparation.submission_id,
        )
        .await;
    }
    if let Some(request) = &payload.worktree_preparation {
        return prepare_worktree(server, envelope, &payload, request).await;
    }
    if let (Some(prepared), Some(expected)) = (
        payload.prepared_session_id.as_deref(),
        payload.expected_submission_id.as_deref(),
    ) {
        return activate_submission(server, envelope, (&payload, incognito), prepared, expected)
            .await;
    }
    if let Some(prepared) = payload.prepared_session_id.as_deref() {
        let config = &payload.config;
        let empty = Input::default();
        let first = payload.first_input.as_ref().unwrap_or(&empty);
        // Refused before anything moves, so a malformed attachment leaves the prepared session as it was.
        let refs = match crate::attachments::parse_refs(&first.attachments) {
            Ok(refs) => refs,
            Err(error) => {
                return Ack::refused(
                    &envelope.command_id,
                    Status::Rejected,
                    "proto.invalidPayload",
                    error.message,
                    0,
                );
            }
        };
        // Resolved before the session moves: text material that cannot be written refuses the command first.
        let content =
            match first_content(server, envelope, &SessionId::new(prepared), first, refs).await {
                Ok(content) => content,
                Err(ack) => return *ack,
            };
        // Node `runActivation`: SessionStart (Node runs it in the first turn) sees the draft's config, and the first
        // input follows the move into the worktree.
        let request = crate::worktree::ActivationRequest {
            prepared,
            expected_attempt: payload.expected_attempt_id.as_deref(),
            workspace: payload.workspace_id.as_deref(),
            requested: payload.execution_worktree.as_ref(),
            incognito,
        };
        return crate::worktree::activate(
            server,
            envelope,
            request,
            async |live| apply_draft_config(server, live, envelope, config, first).await,
            async |live| {
                // The reservation persisted the prepared session, so its admission has no draft to persist.
                submit_first(server, live, envelope, first, content)
                    .await
                    .ok()
                    .flatten()
            },
        )
        .await;
    }
    // Fork: the direct route refuses a dead worktree before the session exists.
    if let Some(requested) = &payload.execution_worktree
        && let Err(ack) = crate::worktree::check_directory(server, envelope, requested).await
    {
        return *ack;
    }
    let config = &payload.config;
    let first = payload.first_input.unwrap_or_default();
    // Refused before the session exists, so a malformed attachment leaves no session behind.
    let refs = match crate::attachments::parse_refs(&first.attachments) {
        Ok(refs) => refs,
        Err(error) => {
            return Ack::refused(
                &envelope.command_id,
                Status::Rejected,
                "proto.invalidPayload",
                error.message,
                0,
            );
        }
    };
    let chosen = selection(config.model_selection.as_ref())
        .or_else(|| selection(first.model_selection.as_ref()))
        .unwrap_or_else(|| server.defaults.selection.clone());
    let defaults = ExecutionState {
        mode: server.defaults.mode,
        plan: false,
    };
    let ExecutionState {
        mode: permission,
        plan,
    } = resolve_execution(config.mode.as_deref(), config.plan_enabled, defaults)
        .unwrap_or(defaults);
    let id = payload
        .session_id
        .as_deref()
        .map_or_else(inbox::new_session_id, SessionId::new);
    // The first input's attachments are resolved before the session exists: text material that cannot be written
    // refuses the command and leaves no session behind.
    let content = match first_content(server, envelope, &id, &first, refs).await {
        Ok(content) => content,
        Err(ack) => return *ack,
    };
    // Fork: the existence check and the create run under the reservation gate, so a concurrent reservation or create
    // of the same id cannot slip between them.
    let gate = match server.reservations.acquire().await {
        Ok(permit) => permit,
        Err(reason) => {
            return Ack::refused(
                &envelope.command_id,
                Status::Failed,
                "fault.command.createSessionFailed",
                reason.to_owned(),
                0,
            );
        }
    };
    let failed = |reason: &str| {
        Ack::refused(
            &envelope.command_id,
            Status::Failed,
            "fault.command.createSessionFailed",
            reason.to_owned(),
            0,
        )
    };
    let existing =
        match crate::preparation::absent_if_not_found(server.kernel.session_snapshot(&id).await) {
            Ok(view) => view,
            // No error text: a storage error can name the storage path.
            Err(_) => return failed("reading the session failed"),
        };
    // Fork: a soft-deleted id is not free (Node refuses it before any write).
    if existing.is_none() {
        match crate::preparation::deleted(server, &id).await {
            Ok(false) => {}
            Ok(true) => {
                return Ack::refused(
                    &envelope.command_id,
                    Status::Rejected,
                    "proto.invalidPayload",
                    "sessionId already exists".to_owned(),
                    0,
                );
            }
            Err(reason) => return failed(reason),
        }
    }
    if let Some(view) = &existing {
        let marker = match crate::preparation::load(server, &id).await {
            Ok(marker) => marker,
            Err(reason) => return failed(reason),
        };
        let workspace_matches = payload
            .workspace_id
            .as_deref()
            .is_none_or(|workspace| view.meta.workspace.root == server.workspace(workspace).root);
        if let Err(reason) = crate::preparation::recreate_existing(
            marker.as_ref(),
            workspace_matches,
            crate::preparation::has_conversation(view),
            crate::preparation::ReserveIncognito {
                stored: view.meta.incognito,
                requested: incognito,
            },
        ) {
            tracing::warn!(
                event = "session.create_refused",
                reason,
                "createSession refused an existing session"
            );
            return Ack::refused(
                &envelope.command_id,
                Status::Rejected,
                "proto.invalidPayload",
                "sessionId already exists".to_owned(),
                0,
            );
        }
    }
    if let Some(followup) = config.followup_mode {
        server
            .followups
            .lock_unpoisoned()
            .insert(id.clone(), followup);
    }
    let workspace = payload.workspace_id.as_deref().unwrap_or_default();
    let request = CreateSession {
        id: Some(id.clone()),
        workspace: server.workspace(workspace),
        selection: chosen,
        mode: permission,
        plan,
        incognito,
    };
    // Fork: the direct route starts the session in its worktree (SessionStart included); the row keeps the
    // parent workspace, and opening it below picks up the stored worktree facts.
    let created = match &payload.execution_worktree {
        Some(requested) => {
            server
                .kernel
                .create_session_in_worktree(
                    request,
                    rust_cli_kernel_api::env::EnvPath::new(&requested.path),
                    requested.branch_name.clone(),
                )
                .await
        }
        None => server.kernel.create_session(request).await,
    };
    drop(gate);
    let refused = |message: String| {
        Ack::refused(
            &envelope.command_id,
            Status::Failed,
            "fault.command.createSessionFailed",
            message,
            0,
        )
    };
    let id = match created {
        Ok(id) => id,
        Err(error) => return refused(error.to_string()),
    };
    let live = match server.live(&id).await {
        Ok(live) => live,
        Err(error) => return refused(error.to_string()),
    };
    crate::subscribe::announce(&live);
    let mut result = json!({"type": "createSession", "sessionId": id.as_str()});
    match submit_first(server, &live, envelope, &first, content).await {
        Ok(Some(input)) => result["input"] = input,
        Ok(None) => {}
        Err(ack) => return *ack,
    }
    Ack::accepted(&envelope.command_id, 0, Some(result))
}

/// The content of a first input with attachments, resolved before any side effect of the command (the session's
/// creation or activation): text material that cannot be written refuses the command. `None` without text or refs.
async fn first_content(
    server: &Server,
    envelope: &Envelope,
    id: &SessionId,
    first: &Input,
    refs: Vec<crate::attachments::AttachmentRef>,
) -> Result<Option<Vec<ContentBlock>>, Box<Ack>> {
    match first.text.as_deref() {
        Some(text) if !refs.is_empty() => crate::attachments::content(server, id, text, refs)
            .await
            .map(Some)
            .map_err(|error| {
                Box::new(Ack::refused(
                    &envelope.command_id,
                    Status::Failed,
                    &error.message,
                    error.message.clone(),
                    0,
                ))
            }),
        _ => Ok(None),
    }
}

/// The first input of a new or activated session (createSession `firstInput`), queued behind SessionStart under the
/// createSession command id, with its attachments already resolved ([`first_content`]). The `input` field of the
/// result; `None` without text or when the session refused it; `Err` when the draft could not be persisted for it
/// ([`admit_input`]).
async fn submit_first(
    server: &Server,
    live: &rust_cli_protocol_core::sessions::Bridged<crate::live::Live>,
    envelope: &Envelope,
    first: &Input,
    content: Option<Vec<ContentBlock>>,
) -> Result<Option<Value>, Box<Ack>> {
    let Some(text) = first.text.clone() else {
        return Ok(None);
    };
    admit_input(server, live.handle.as_ref(), &text, &envelope.command_id, 0).await?;
    live.sink.remember_input(
        &envelope.command_id,
        input_meta(envelope, first, "startNow", "startNow"),
    );
    // The input's own mode, plan switch and model (Node `resolveSubmittedExecutionState`) apply when its turn starts,
    // as for `sendText`; missing parts are the session's current state.
    let view = live.handle.view().await.ok();
    let execution = input_execution(first, view.as_ref());
    let content = content.unwrap_or_default();
    // `firstInput` has no quotes.
    let intent = input_intent(
        envelope,
        first,
        QueuedKind::Text,
        None,
        ("startNow", "startNow"),
        live.sink.admit(),
    );
    let submit = Command::SubmitWith {
        intent: Some(Box::new(intent)),
        kind: QueuedKind::Text,
        text,
        content,
        delivery: Delivery::Queue,
        execution,
        behind_held: false,
        lease: None,
    };
    Ok(
        match send(live.handle.as_ref(), &envelope.command_id, submit).await {
            KernelAck::Accepted { .. } => {
                Some(json!({"delivery": "startNow", "inputId": envelope.command_id}))
            }
            _ => None,
        },
    )
}

/// Fork: Node `admitInputCommand` persists a deferred session with the input's title before it accepts an input, so
/// the accepted input can no longer be dropped with its draft and a hook that blocks it does not leave "New session".
/// A deferred close that dropped the draft first refuses the input; any other failure fails the command like Node's
/// admission error (`fault.command.executionFailed`), before the input is remembered or sent. The text names no
/// storage detail. The title the admission wrote reaches the session actor before the input does, so the live views
/// show the stored title even when a `UserPromptSubmit` hook blocks the input (Node emits `SessionTitleUpdated` at the
/// persistence).
async fn admit_input(
    server: &Server,
    handle: &dyn SessionHandle,
    text: &str,
    command: &str,
    revision: u64,
) -> Result<(), Box<Ack>> {
    let session = handle.id();
    match server
        .kernel
        .queries()
        .persist_for_input(session, text)
        .await
    {
        Ok(admission) => {
            if let Some(title) = admission.title {
                send(
                    handle,
                    &format!("{command}#title"),
                    Command::AdoptTitle { title },
                )
                .await;
            }
            Ok(())
        }
        Err(error @ rust_cli_kernel_api::store::StoreError::NotFound { .. }) => {
            Err(Box::new(Ack::refused(
                command,
                Status::Rejected,
                "proto.sessionNotFound",
                error.to_string(),
                revision,
            )))
        }
        Err(error) => {
            tracing::warn!(event = "protocol.draft.persist_failed", session = %session.as_str(), error = %error, "persisting the draft for its input failed");
            Err(Box::new(Ack::refused(
                command,
                Status::Failed,
                "fault.command.executionFailed",
                "persisting the session for its input failed".to_owned(),
                revision,
            )))
        }
    }
}

/// Fork: reservation. Creates the session with the draft's selection and stores a preparing marker; a repeat with
/// the same submission returns the same session, anything else that already owns the id is refused.
async fn reserve_submission(
    server: &Server,
    envelope: &Envelope,
    (payload, incognito): (&CreateSessionPayload, Option<IncognitoProfile>),
    submission: &str,
) -> Ack {
    let refused = |code: &str, message: String| {
        Ack::refused(&envelope.command_id, Status::Rejected, code, message, 0)
    };
    let id = SessionId::new(payload.session_id.as_deref().unwrap_or(submission));
    let accepted = |id: &SessionId| {
        Ack::accepted(
            &envelope.command_id,
            0,
            Some(json!({"type": "createSession", "sessionId": id.as_str()})),
        )
    };
    // Held from the existence check to the marker save (see ReservationGate); released before the session is opened.
    let reservation = match server.reservations.acquire().await {
        Ok(permit) => permit,
        Err(reason) => {
            return Ack::refused(
                &envelope.command_id,
                Status::Failed,
                "fault.command.createSessionFailed",
                reason.to_owned(),
                0,
            );
        }
    };
    // Only "no such session" leaves the id free; any other snapshot error stops the reservation.
    let existing =
        match crate::preparation::absent_if_not_found(server.kernel.session_snapshot(&id).await) {
            Ok(view) => view,
            Err(_) => {
                // No error text: a storage error can name the storage path.
                return Ack::refused(
                    &envelope.command_id,
                    Status::Failed,
                    "fault.command.createSessionFailed",
                    "reading the session failed".to_owned(),
                    0,
                );
            }
        };
    // Fork: a soft-deleted id is not free (Node refuses it before any write).
    if existing.is_none() {
        match crate::preparation::deleted(server, &id).await {
            Ok(false) => {}
            Ok(true) => {
                return refused(
                    "proto.invalidPayload",
                    format!("session {} cannot be reserved: it was deleted", id.as_str()),
                );
            }
            Err(reason) => {
                return Ack::refused(
                    &envelope.command_id,
                    Status::Failed,
                    "fault.command.createSessionFailed",
                    reason.to_owned(),
                    0,
                );
            }
        }
    }
    if let Some(view) = &existing {
        let marker = match crate::preparation::load(server, &id).await {
            Ok(marker) => marker,
            Err(reason) => {
                return Ack::refused(
                    &envelope.command_id,
                    Status::Failed,
                    "fault.command.createSessionFailed",
                    reason.to_owned(),
                    0,
                );
            }
        };
        let workspace_matches = payload
            .workspace_id
            .as_deref()
            .is_none_or(|workspace| view.meta.workspace.root == server.workspace(workspace).root);
        match crate::preparation::reserve_existing(
            marker.as_ref(),
            submission,
            workspace_matches,
            crate::preparation::has_conversation(view),
            crate::preparation::ReserveIncognito {
                stored: view.meta.incognito,
                requested: incognito,
            },
        ) {
            crate::preparation::Reserve::Repeat => return accepted(&id),
            crate::preparation::Reserve::Adopt => {}
            crate::preparation::Reserve::Refuse(reason) => {
                tracing::warn!(
                    event = "session.reserve_refused",
                    reason,
                    "a submission could not reserve an existing session"
                );
                return refused(
                    "proto.invalidPayload",
                    format!("session {} cannot be reserved: {reason}", id.as_str()),
                );
            }
        }
    }
    let workspace = payload.workspace_id.as_deref().unwrap_or_default();
    let created = if existing.is_some() {
        Ok(id.clone())
    } else {
        server
            .kernel
            .create_session(CreateSession {
                id: Some(id.clone()),
                workspace: server.workspace(workspace),
                selection: selection(payload.config.model_selection.as_ref())
                    .unwrap_or_else(|| server.defaults.selection.clone()),
                mode: server.defaults.mode,
                plan: false,
                incognito,
            })
            .await
    };
    let id = match created {
        Ok(id) => id,
        Err(error) => {
            return Ack::refused(
                &envelope.command_id,
                Status::Failed,
                "fault.command.createSessionFailed",
                error.to_string(),
                0,
            );
        }
    };
    let marker = crate::preparation::Marker::preparing(submission, server.context.now());
    // No error text: a storage error can name the storage path.
    if crate::preparation::save(server, &id, &marker)
        .await
        .is_err()
    {
        return Ack::refused(
            &envelope.command_id,
            Status::Failed,
            "fault.command.createSessionFailed",
            "storing the submission reservation failed".to_owned(),
            0,
        );
    }
    drop(reservation);
    match server.live(&id).await {
        Ok(live) => {
            live.sink.set_preparation(marker.exposed());
            crate::subscribe::announce(&live);
        }
        Err(error) => {
            tracing::warn!(event = "protocol.preparation.open_failed", error = %error, "opening the reserved session failed");
        }
    }
    accepted(&id)
}

/// Fork: activation. Reports how far an earlier attempt got so the client neither re-sends an admitted first
/// input nor skips one that never arrived. The marker stays preparing until the first sendText is admitted.
async fn activate_submission(
    server: &Server,
    envelope: &Envelope,
    (payload, incognito): (&CreateSessionPayload, Option<IncognitoProfile>),
    prepared: &str,
    expected: &str,
) -> Ack {
    // Node `v4-bridge.ts`: a submission activation names no worktree; a worktree is never silently dropped.
    if payload.execution_worktree.is_some() || payload.expected_attempt_id.is_some() {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            "Prepared submission does not match the requested workspace or submission",
            0,
        );
    }
    let id = SessionId::new(prepared);
    // Node compares the reservation's workspace with `workspaceId`: an activation from another workspace is refused.
    let listed = crate::worktree::listed_key(server, &id).await;
    let workspace_matches = payload.workspace_id.is_some() && payload.workspace_id == listed;
    if !workspace_matches {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            "Prepared submission does not match the requested workspace or submission",
            0,
        );
    }
    let marker = match crate::preparation::load(server, &id).await {
        Ok(Some(marker)) if marker.submission_id == expected => marker,
        _ => {
            return Ack::refused(
                &envelope.command_id,
                Status::Rejected,
                "proto.invalidPayload",
                format!("session {prepared} has no reservation for submission {expected}"),
                0,
            );
        }
    };
    let live = match server.live(&id).await {
        Ok(live) => live,
        Err(error) => {
            return Ack::refused(
                &envelope.command_id,
                Status::Failed,
                "fault.command.createSessionFailed",
                kernel_error(&error).message,
                0,
            );
        }
    };
    // Fork: the reservation froze the profile on the row; the activation must ask for the same one (absent is not
    // equal to present), as Node's bridge checks `incognitoProfilesEqual`.
    if live.sink.incognito() != incognito {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            "Prepared submission does not match the frozen incognito profile".to_owned(),
            0,
        );
    }
    let admitted = match payload.expected_first_input_command_id.as_deref() {
        Some(first) => server
            .kernel
            .queries()
            .records(&id, inbox::COMMAND_FACT)
            .await
            .ok()
            .and_then(|records| inbox::find_fact(&records, first))
            .is_some_and(|ack| ack.status == Status::Accepted),
        None => false,
    };
    let outcome = if admitted {
        "input-admitted"
    } else if marker.active {
        "already-active"
    } else {
        // The draft's choices: the first sendText carries them too, this keeps a config-only activation right.
        // A refused guarded mode fails the activation (Node rethrows it); the reservation stays for a retry.
        if let Err(message) =
            apply_draft_config(server, &live, envelope, &payload.config, &Input::default()).await
        {
            return Ack::refused(
                &envelope.command_id,
                Status::Failed,
                "fault.command.executionFailed",
                message,
                0,
            );
        }
        "input-pending"
    };
    Ack::accepted(
        &envelope.command_id,
        0,
        Some(
            json!({"type": "createSession", "sessionId": id.as_str(), "preparedActivation": outcome}),
        ),
    )
}

/// Fork: a prepared session takes the draft's model, mode, plan switch and follow-up mode (Node
/// `applyRequestedSessionConfig`). Without a model in the config the first input's model is the session's, as an
/// ordinary createSession chooses it, so SessionStart and later turns run on it (in Node the first turn's model
/// becomes the session's when it starts, and SessionStart runs in that turn).
///
/// A refused step is logged and the session keeps its settings, except when the config or the first input asks for
/// `guarded`: Node rethrows that failure (`session-mgmt.ts` `runActivation`), since running with the previous, possibly
/// broader, permission mode is not an option. The `Err` carries the refusal.
async fn apply_draft_config(
    server: &Server,
    live: &rust_cli_protocol_core::sessions::Bridged<crate::live::Live>,
    envelope: &Envelope,
    config: &SessionConfig,
    first: &Input,
) -> Result<(), String> {
    let handle = live.handle.as_ref();
    let mut refusals = Vec::new();
    if let Some(chosen) = selection(config.model_selection.as_ref())
        .or_else(|| selection(first.model_selection.as_ref()))
    {
        refusals.push(
            send(
                handle,
                &format!("{}:model", envelope.command_id),
                Command::SetModel { selection: chosen },
            )
            .await,
        );
    }
    let current = handle
        .view()
        .await
        .ok()
        .map_or_else(ExecutionState::default, |view| ExecutionState {
            mode: view.mode,
            plan: view.plan,
        });
    if let Some(ExecutionState {
        mode: permission,
        plan,
    }) = resolve_execution(config.mode.as_deref(), config.plan_enabled, current)
    {
        refusals.push(
            send(
                handle,
                &format!("{}:mode", envelope.command_id),
                Command::SetMode { mode: permission },
            )
            .await,
        );
        refusals.push(
            send(
                handle,
                &format!("{}:plan", envelope.command_id),
                Command::SetPlan { enabled: plan },
            )
            .await,
        );
    }
    let refused = refusals.into_iter().find_map(|ack| match ack {
        KernelAck::Rejected { reason } => Some(reason),
        KernelAck::Accepted { .. } | KernelAck::Duplicate => None,
    });
    if let Some(reason) = refused {
        let guarded = [config.mode.as_deref(), first.mode.as_deref()].contains(&Some("guarded"));
        if guarded {
            return Err(reason);
        }
        tracing::warn!(
            event = "protocol.create.config_failed",
            "the draft config was refused; the session keeps its settings"
        );
    }
    // Node writes only a non-default follow-up mode; the open session's projection and a later cold open both take it.
    if let Some(followup) = config.followup_mode.filter(|mode| *mode != Followup::Queue) {
        server
            .followups
            .lock_unpoisoned()
            .insert(handle.id().clone(), followup);
        let sink = live.sink.clone();
        live.run(Box::pin(async move { sink.set_followup(followup).await }));
    }
    Ok(())
}

/// Fork: worktree preparation (Node `createSession` with `worktreePreparation`): only the workspace and the
/// worktree request; runtime settings and input belong to the activation.
async fn prepare_worktree(
    server: &Server,
    envelope: &Envelope,
    payload: &CreateSessionPayload,
    request: &crate::worktree::Request,
) -> Ack {
    let refused = |message: &str| {
        Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            message,
            0,
        )
    };
    let raw = &envelope.payload;
    if payload.prepared_session_id.is_some()
        || payload.first_input.is_some()
        || payload.execution_worktree.is_some()
        || !raw["config"].is_null()
        || !raw["permissionScope"].is_null()
    {
        return refused("worktree preparation cannot include runtime or input settings");
    }
    if !raw["incognito"].is_null() {
        return refused(
            "worktree preparation cannot include an incognito profile; send it on the activation createSession",
        );
    }
    let workspace = payload.workspace_id.as_deref().unwrap_or_default();
    crate::worktree::prepare(
        server,
        envelope,
        workspace,
        request,
        server.defaults.selection.clone(),
    )
    .await
}

/// Fork: the first input of a reserved session was admitted: persist the marker as active, then drop
/// `submissionPreparation` from the snapshot and the sessions-index row (after the events already received).
async fn complete_first_submission(
    server: &Server,
    live: &std::sync::Arc<rust_cli_protocol_core::sessions::Bridged<crate::live::Live>>,
    envelope: &Envelope,
) {
    let Some(session) = envelope.session_id.as_deref() else {
        return;
    };
    let id = SessionId::new(session);
    let Ok(Some(marker)) = crate::preparation::load(server, &id).await else {
        return;
    };
    if marker.active {
        return;
    }
    // An older renderer omits firstSubmissionId: complete any still-preparing reservation, as Node does.
    if let Some(submission) = envelope.payload["firstSubmissionId"].as_str()
        && submission != marker.submission_id
    {
        return;
    }
    if crate::preparation::save(server, &id, &marker.activated(server.context.now()))
        .await
        .is_err()
    {
        // No error text: a storage error can name the storage path.
        tracing::warn!(
            event = "protocol.preparation.complete_failed",
            "storing the active submission marker failed"
        );
    }
    let sink = live.sink.clone();
    live.run(Box::pin(async move { sink.complete_preparation().await }));
}

fn input_meta(
    envelope: &Envelope,
    input: &Input,
    requested: &'static str,
    admitted: &'static str,
) -> InputMeta {
    InputMeta {
        client: envelope.client_id.clone(),
        origin: envelope
            .input_origin
            .clone()
            .or_else(|| input.input_origin.clone()),
        text: input.text.clone().unwrap_or_default(),
        admitted_at: 0,
        requested,
        admitted,
        attachments: input.attachments.clone(),
    }
}

/// Fork: Node `inputIntentMetadata` (`bootstrap/src/zcode-protocol-v4/commands/input-intent.ts`): the admitted
/// facts of one App input, in Node's key order (specs/fork-agent-runtime-selection.md, Conversation quotes in Rust
/// mode). `admission` is the input's `admissionSeq` and `admittedAt`.
fn input_intent(
    envelope: &Envelope,
    input: &Input,
    kind: QueuedKind,
    quotes: Option<&[rust_cli_kernel_api::conversation_quote::Quote]>,
    (requested, admitted): (&str, &str),
    (seq, at): (u64, u64),
) -> rust_cli_kernel_api::input_intent::InputIntent {
    let mut fields = serde_json::Map::new();
    let origin = envelope
        .input_origin
        .as_deref()
        .or(input.input_origin.as_deref())
        .filter(|origin| matches!(*origin, "desktop" | "mobile"));
    if let Some(origin) = origin {
        fields.insert("inputOrigin".into(), json!(origin));
    }
    if let Some(quotes) = quotes {
        fields.insert(
            rust_cli_kernel_api::input_intent::QUOTES.into(),
            json!(quotes),
        );
    }
    let command = envelope.command_id.as_str();
    fields.insert("sourceCommandId".into(), json!(command));
    fields.insert("queueItemId".into(), json!(format!("queue_{command}")));
    let client = Some(envelope.client_id.as_str()).filter(|client| !client.is_empty());
    fields.insert("clientId".into(), json!(client.unwrap_or("cli")));
    let kind = if kind == QueuedKind::Goal {
        "sendGoalCommand"
    } else {
        "sendText"
    };
    fields.insert("kind".into(), json!(kind));
    fields.insert(
        rust_cli_kernel_api::input_intent::TEXT.into(),
        json!(input.text.as_deref().unwrap_or_default()),
    );
    if let Some(selection) = input.model_selection.as_ref().filter(|v| !v.is_null()) {
        fields.insert("modelSelection".into(), selection.clone());
    }
    if let Some(mode) = input.mode.as_deref().filter(|mode| !mode.is_empty()) {
        fields.insert("mode".into(), json!(mode));
    }
    if let Some(plan) = input.plan_enabled {
        fields.insert("planEnabled".into(), json!(plan));
    }
    fields.insert("admissionSeq".into(), json!(seq));
    fields.insert("admittedAt".into(), json!(at));
    fields.insert("requestedDelivery".into(), json!(requested));
    fields.insert("admittedDelivery".into(), json!(admitted));
    if !input.attachments.is_empty() {
        fields.insert("attachmentRefs".into(), json!(input.attachments));
    }
    // B4: Node `inputIntentMetadata` puts `source` last and only when the command carries one; zod rebuilds it in
    // the schema's key order, so the stored object does too.
    if let Some(source) = input.source.as_ref().filter(|source| !source.is_null()) {
        fields.insert(
            rust_cli_kernel_api::input_intent::SOURCE.into(),
            source_in_schema_order(source),
        );
    }
    rust_cli_kernel_api::input_intent::InputIntent::from_fields(fields)
}

/// B4: the source's keys in `conversationInputSourceSchema` order (`input-intent.ts`). The inbound schema has already
/// refused unknown keys, so only the schema's own fields are copied, in its order. An unknown kind is returned as is.
fn source_in_schema_order(source: &Value) -> Value {
    let fields: &[&str] = match source.get("kind").and_then(Value::as_str) {
        Some("pluginUi") => &["kind", "pluginId", "toolCallId"],
        Some("session") => &["kind", "sessionId", "title"],
        Some("genUi") => &["kind", "path", "title"],
        Some("extension") => &["kind", "pluginId"],
        _ => return source.clone(),
    };
    let mut ordered = serde_json::Map::new();
    for key in fields {
        if let Some(value) = source.get(*key) {
            ordered.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(ordered)
}

/// Fork: Node's `applyHeldQueueDisposition`. After a finished turn a paused queue (`autoDrain` off, items
/// waiting) routes input as `choice`: without a disposition the input is refused
/// (`heldQueueDispositionRequired`), a queue that changed since the client's confirmation is stale
/// (`guard.heldQueueConfirmationStale`), `clearQueueAndSend` drops the waiting items and releases the hold, and
/// `keepQueueAndSend` leaves them. The input itself then starts at once: an idle submit is not held.
async fn held_queue_choice(
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
    input: &Input,
    view: Option<&rust_cli_kernel_api::session_api::SessionView>,
    phase: Phase,
    revision: u64,
) -> Result<(), Box<Ack>> {
    let command = envelope.command_id.as_str();
    let queue = view.map(|view| view.queue.as_slice()).unwrap_or_default();
    let completed = matches!(phase, Phase::CompletedSuccess | Phase::CompletedInterrupted);
    if !(completed && !queue.is_empty() && !live.auto_drain()) {
        return Ok(());
    }
    let refused = |code: &str, message: &str| {
        Box::new(Ack::refused(
            command,
            Status::Rejected,
            code,
            message.to_owned(),
            revision,
        ))
    };
    let Some(disposition) = input.held_queue_disposition else {
        return Err(refused(
            "heldQueueDispositionRequired",
            "held queue requires heldQueueDisposition (clearQueueAndSend | keepQueueAndSend)",
        ));
    };
    if let Some(expected) = &input.expected_held_queue_item_ids {
        let current: std::collections::HashSet<String> = queue
            .iter()
            .map(|item| format!("queue_{}", item.command.as_str()))
            .collect();
        let confirmed: std::collections::HashSet<&String> = expected.iter().collect();
        let same = confirmed.len() == expected.len()
            && current.len() == expected.len()
            && expected.iter().all(|id| current.contains(id));
        if !same {
            return Err(refused(
                "guard.heldQueueConfirmationStale",
                "paused queue changed after send confirmation opened",
            ));
        }
    }
    if disposition == HeldDisposition::ClearQueueAndSend {
        for item in queue {
            send(
                handle,
                &format!("{command}:clear:{}", item.command.as_str()),
                Command::ClearQueued {
                    command: item.command.clone(),
                },
            )
            .await;
        }
        // The Stop's hold protected the cleared items only (Node ISSUE-063): release it after the clear.
        let release = send(
            handle,
            &format!("{command}:release"),
            Command::HoldQueue { held: false },
        )
        .await;
        if matches!(release, KernelAck::Accepted { .. }) {
            live.set_auto_drain(true).await;
        }
    }
    Ok(())
}

/// Fork: the execution state an input was submitted with (Node's Submission), frozen on the kernel's
/// queued item when it waits; missing parts are the session's current state.
fn input_execution(
    input: &Input,
    view: Option<&rust_cli_kernel_api::session_api::SessionView>,
) -> Option<InputExecution> {
    let chosen = selection(input.model_selection.as_ref());
    let current = view.map_or_else(ExecutionState::default, |view| ExecutionState {
        mode: view.mode,
        plan: view.plan,
    });
    // Each field overrides the session's own (Node `resolveExecutionState(payload, current)`): a plan switch without a
    // mode keeps the session's mode, and the legacy `mode: "plan"` keeps it too.
    let resolved = resolve_execution(input.mode.as_deref(), input.plan_enabled, current);
    let limits = TurnLimits::new(
        input.automation_id.as_deref(),
        input.tool_disallowlist.clone(),
    );
    if chosen.is_none() && resolved.is_none() && limits.is_empty() {
        return None;
    }
    let state = resolved.unwrap_or(current);
    Some(InputExecution {
        state,
        selection: chosen,
        limits,
    })
}

/// How a `sendText` input is admitted. Running, it is steered into the turn (`guide`) or queued; idle, it starts now.
/// Fork: content blocks (attachments) are never steered into a running turn; they wait for it to end. Node steers
/// only into an active turn (`prompt-admission.ts` `canSteer`): while the session runs a job without one (the goal
/// completion verifier), a guide is a future queue item, shown in the queue rather than as a pending guide row.
fn admission(
    requested: Option<Requested>,
    followup: Followup,
    phase: Phase,
    turn_running: bool,
    with_attachments: bool,
) -> (Delivery, &'static str) {
    let running = phase == Phase::Running;
    let steerable = running && turn_running && !with_attachments;
    match (requested, running) {
        (Some(Requested::Guide), true) if steerable => (Delivery::Steer, "guide"),
        (None, true) if steerable && followup == Followup::Guide => (Delivery::Steer, "guide"),
        (_, true) => (Delivery::Queue, "queue"),
        (_, false) => (Delivery::Queue, "startNow"),
    }
}

/// Fork: the `sendText` ACK's `delivery` from the kernel's real admission (Node `session-flow.ts` answers from
/// `started.admission.kind`): a started input is `startNow`, a queued one `queue`, a queued guide stays `guide` (it
/// steers into the running turn). The projection's prediction loses in both races (a turn that ended before the
/// submit, a turn or lease that appeared). A refusal or duplicate keeps the prediction.
fn acked_delivery(
    predicted: &'static str,
    kernel: &rust_cli_kernel_api::session_api::Ack,
) -> &'static str {
    use rust_cli_kernel_api::session_api::{Ack as KernelAck, CommandResult};
    match kernel {
        KernelAck::Accepted {
            result: CommandResult::Queued,
        } if predicted == "startNow" => "queue",
        KernelAck::Accepted {
            result: CommandResult::Queued,
        } => predicted,
        KernelAck::Accepted { .. } => "startNow",
        KernelAck::Rejected { .. } | KernelAck::Duplicate => predicted,
    }
}

/// Fork: `sendText` with `requestedDelivery: "startNow"` (the composer's modifier-key send in queue mode).
fn requests_start_now(envelope: &Envelope) -> bool {
    envelope
        .payload
        .get("requestedDelivery")
        .and_then(Value::as_str)
        == Some("startNow")
}

/// Fork: Node `session-flow.ts` `forceStartNow`: a `startNow` input while a turn (or the goal verifier) runs preempts
/// it and starts at once instead of being queued. Same steps as `sendQueuedNow`: reserve the foreground (the promotion
/// lease, so the drain after the stopped turn cannot start a queued item or a background notice first), interrupt and
/// wait for the turn to finish, submit the input to the idle session, then release the reservation.
async fn send_text_now(
    server: &Server,
    live: &rust_cli_protocol_core::sessions::Bridged<crate::live::Live>,
    envelope: &Envelope,
    phase: Phase,
    revision: u64,
) -> Ack {
    let handle = live.handle.as_ref();
    let part = |suffix: &str| format!("{}:{suffix}", envelope.command_id);
    // Node `send-now:<commandId>`: the lease's owner. Another promotion owning the foreground refuses the input as
    // Node does (`send now foreground promotion is busy`), and that lease is left alone. Node throws
    // `V4InputAdmissionRejectedError` and the gateway answers a thrown command error with `status: "failed"`.
    let lease = format!("send-now:{}", envelope.command_id);
    if let rust_cli_kernel_api::session_api::Ack::Rejected { .. } = send(
        handle,
        &part("reserve"),
        Command::ReserveForeground {
            reserved: true,
            lease: lease.clone(),
        },
    )
    .await
    {
        return Ack::refused(
            &envelope.command_id,
            Status::Failed,
            "fault.command.inputRejected",
            "send now foreground promotion is busy",
            revision,
        );
    }
    let ack = match crate::fork::settle_running_turn(live, envelope).await {
        Ok(()) => {
            send_text(
                server,
                live,
                envelope,
                QueuedKind::Text,
                phase,
                revision,
                Some(&lease),
            )
            .await
        }
        // A failed preemption is a thrown error in Node too (`preemptActiveTurnAndWait`): `failed`.
        Err(reason) => Ack::refused(
            &envelope.command_id,
            Status::Failed,
            "fault.command.inputRejected",
            reason,
            revision,
        ),
    };
    send(
        handle,
        &part("release"),
        Command::ReserveForeground {
            reserved: false,
            lease: format!("send-now:{}", envelope.command_id),
        },
    )
    .await;
    ack
}

/// B4: Node's `sendGoalCommand` schema has no `source` (zod strips it); only `sendText` and `firstInput` carry one.
/// The goal's intent therefore never has a source, and its card shows no extension origin.
fn without_goal_source(kind: QueuedKind, mut input: Input) -> Input {
    if kind == QueuedKind::Goal {
        input.source = None;
    }
    input
}

/// `sendText` and (fork) `sendGoalCommand`: one admission path; the kernel decides between starting
/// now and queueing, and applies the input's execution state only when its turn starts
/// (`Command::SubmitWith`), so a queued input never changes the running turn's mode or model.
#[allow(
    clippy::too_many_arguments,
    reason = "the sendText admission inputs plus the promotion lease"
)]
async fn send_text(
    server: &Server,
    bridged: &rust_cli_protocol_core::sessions::Bridged<crate::live::Live>,
    envelope: &Envelope,
    kind: QueuedKind,
    phase: Phase,
    revision: u64,
    promotion: Option<&str>,
) -> Ack {
    let handle = bridged.handle.as_ref();
    let live = bridged.sink.as_ref();
    let input: Input = match payload(envelope) {
        Ok(input) => without_goal_source(kind, input),
        Err(ack) => return *ack,
    };
    let command = envelope.command_id.as_str();
    // Fork: Node's `guard.planGoalMutuallyExclusive` (plan cannot create a goal).
    if kind == QueuedKind::Goal && input.plan_enabled == Some(true) {
        return Ack::refused(
            command,
            Status::Rejected,
            "guard.planGoalMutuallyExclusive",
            "plan mode cannot set a goal",
            revision,
        );
    }
    if let Err(reason) = rust_cli_kernel_api::conversation_quote::validate(
        input.conversation_quotes.as_deref().unwrap_or_default(),
    ) {
        return Ack::refused(
            command,
            Status::Rejected,
            "proto.invalidPayload",
            reason,
            revision,
        );
    }
    // Attachments, slash expansion and the prompt hook see the typed text; the session adds the quote block from the
    // input intent (Node composes `expandedInput`).
    let typed = input.text.clone().unwrap_or_default();
    // Checked before any side effect (model or mode change), so a refused input changes nothing.
    let refs = match crate::attachments::parse_refs(&input.attachments) {
        Ok(refs) => refs,
        Err(error) => {
            return Ack::refused(
                command,
                Status::Rejected,
                "proto.invalidPayload",
                error.message,
                revision,
            );
        }
    };
    // Resolved before any side effect (held queue, remembered input): text material that cannot be written refuses the
    // input and changes nothing.
    let content = if refs.is_empty() {
        Vec::new()
    } else {
        match crate::attachments::content(server, handle.id(), &typed, refs).await {
            Ok(content) => content,
            Err(error) => {
                return Ack::refused(
                    command,
                    Status::Failed,
                    &error.message,
                    error.message.clone(),
                    revision,
                );
            }
        }
    };
    let view = handle.view().await.ok();
    // Fork: checked before the model or mode change, like Node's admission.
    if let Err(ack) = held_queue_choice(
        handle,
        live,
        envelope,
        &input,
        view.as_ref(),
        phase,
        revision,
    )
    .await
    {
        return *ack;
    }
    let execution = input_execution(&input, view.as_ref());
    let requested = input.requested_delivery;
    // A preempted turn has settled: the input starts now even though the snapshot still said running.
    let admission_phase = if promotion.is_some() {
        Phase::CompletedInterrupted
    } else {
        phase
    };
    let (delivery, admitted) = admission(
        requested,
        live.followup(),
        admission_phase,
        view.as_ref().is_none_or(|view| view.running),
        !content.is_empty(),
    );
    let text = input.text.clone().unwrap_or_default();
    if let Err(ack) = admit_input(server, handle, &text, command, revision).await {
        return *ack;
    }
    let requested = requested.unwrap_or(Requested::StartNow).as_str();
    live.remember_input(command, input_meta(envelope, &input, requested, admitted));
    let intent = input_intent(
        envelope,
        &input,
        kind,
        input.conversation_quotes.as_deref(),
        (requested, admitted),
        live.admit(),
    );
    // A goal is the kernel's `/goal <objective>` input (the snapshot shows the objective).
    let text = if kind == QueuedKind::Goal {
        format!("/goal {}", input.text.as_deref().unwrap_or_default().trim())
    } else {
        typed
    };
    let submit = Command::SubmitWith {
        intent: Some(Box::new(intent)),
        kind,
        text,
        content,
        delivery,
        execution,
        behind_held: false,
        // The start-now input is the promotion's own: it starts while its lease holds the foreground.
        lease: promotion.map(str::to_owned),
    };
    let kernel = send(handle, command, submit).await;
    let predicted = admitted;
    let admitted = acked_delivery(predicted, &kernel);
    if admitted != predicted {
        // The remembered admission follows the kernel's. Corrected and published in the session's pump, after the
        // events already received, so its frame cannot overtake or be overtaken by the pump's frames.
        let sink = bridged.sink.clone();
        let command = command.to_owned();
        bridged.run(Box::pin(
            async move { sink.readmit(&command, admitted).await },
        ));
    }
    let result = json!({"type": "inputAccepted", "delivery": admitted, "inputId": command});
    ack_of(
        kernel,
        Ack::accepted(command, revision, Some(result)),
        |reason| {
            Ack::refused(
                command,
                Status::Rejected,
                "guard.inputRejected",
                reason,
                revision,
            )
        },
    )
}

async fn resolve(
    server: &Server,
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let resolved: ResolvePayload = match payload(envelope) {
        Ok(resolved) => resolved,
        Err(ack) => return *ack,
    };
    let interaction = resolved.interaction_id.as_str();
    let option = resolved.answer.option_id.as_deref();
    // Fork (B3): a mode switch is one kernel step that checks the ask itself (Node `permissionGrantMode`).
    if let Some(mode) = option.and_then(grant_mode) {
        let others = || {
            server
                .bridge
                .sessions()
                .into_iter()
                .map(|bridged| bridged.handle.clone())
                .filter(|other| other.id() != handle.id())
                .collect()
        };
        return grant(handle, others, envelope, revision, interaction, mode).await;
    }
    let pending = handle.view().await.ok().and_then(|view| {
        view.pending
            .into_iter()
            .find(|(id, _)| id.as_str() == interaction)
            .map(|(_, request)| request)
    });
    let Some(request) = pending else {
        return Ack::refused(
            &envelope.command_id,
            Status::Noop,
            "proto.alreadyResolved",
            "the interaction is no longer pending",
            revision,
        );
    };
    let Some((offered, tool)) = Offered::of(&request) else {
        return resolve_elicitation(handle, live, envelope, revision, &resolved, &request).await;
    };
    let answer = permission_answer(option, offered, resolved.answer.free_text.as_deref());
    if let PermissionAnswer::Deny { .. } = &answer {
        live.deny(&tool);
    }
    let command = Command::ResolveInteraction {
        interaction: InteractionId::new(interaction),
        answer: answer.into(),
    };
    // 与 Node 相同：ACK 不带 result（答案已经进了会话，投影随事件更新）。
    ack_of(
        send(handle, &envelope.command_id, command).await,
        Ack::accepted(&envelope.command_id, revision, None),
        |reason| {
            Ack::refused(
                &envelope.command_id,
                Status::Noop,
                "proto.alreadyResolved",
                reason,
                revision,
            )
        },
    )
}

/// Node `interaction-registry.ts` `resolvePermissionMode`: the grant's refusal for an ask it cannot grant.
const NOT_SUPPORTED: &str = "Full access is not supported for this interaction";

/// Fork (B3): the permission mode an answer's option grants (Node `permissionGrantMode`): `fullAccess` is yolo
/// (`BypassPermissions`), `allowAndSwitchGuarded` is guarded.
fn grant_mode(option: &str) -> Option<PermissionMode> {
    match option {
        "fullAccess" => Some(PermissionMode::BypassPermissions),
        "allowAndSwitchGuarded" => Some(PermissionMode::Guarded),
        _ => None,
    }
}

/// Fork (B3): answers a permission ask with a mode switch (Node `resolveInteraction` with `resolvePermissionMode`).
/// The session actor checks the ask, grants the mode and allows the call once in one step. A real grant answers
/// `resolvedBy` (the App writes its recent permission preference only from it). An ask pending in another session fails
/// like Node's registry (`Full access is not supported for this interaction`); an ask pending nowhere is a late answer,
/// accepted without a result (Node `interaction-background.ts`: a miss is an idempotent success). A refusal leaves the
/// ask pending and fails the command with the reason.
async fn grant(
    handle: &dyn SessionHandle,
    others: impl FnOnce() -> Vec<std::sync::Arc<dyn SessionHandle>>,
    envelope: &Envelope,
    revision: u64,
    interaction: &str,
    mode: PermissionMode,
) -> Ack {
    let command = Command::GrantPermissionMode {
        interaction: interaction.to_owned(),
        mode,
    };
    let option = envelope.payload["answer"]["optionId"].clone();
    let result = json!({
        "type": "resolveInteraction",
        "resolvedBy": {"clientId": envelope.client_id, "optionId": option},
    });
    let granted = Ack::accepted(&envelope.command_id, revision, Some(result));
    match send(handle, &envelope.command_id, command).await {
        KernelAck::Accepted {
            result: CommandResult::NotPending,
        } => {
            for other in others() {
                let pending = other.view().await.is_ok_and(|view| {
                    view.pending
                        .iter()
                        .any(|(id, _)| id.as_str() == interaction)
                });
                if pending {
                    tracing::warn!(
                        event = "protocol.permission_grant.refused",
                        mode = mode.node_name(),
                        "permission mode grant for another session's ask"
                    );
                    return Ack::refused(
                        &envelope.command_id,
                        Status::Failed,
                        "fault.command.executionFailed",
                        NOT_SUPPORTED,
                        revision,
                    );
                }
            }
            tracing::info!(
                event = "zcode_protocol.v4.interaction_already_resolved",
                "permission mode grant for an ask no longer pending (idempotent)"
            );
            Ack::accepted(&envelope.command_id, revision, None)
        }
        KernelAck::Accepted { .. } => granted,
        KernelAck::Duplicate => inbox::duplicate(&granted),
        KernelAck::Rejected { reason } => {
            tracing::warn!(
                event = "protocol.permission_grant.refused",
                mode = mode.node_name(),
                "permission mode grant refused"
            );
            Ack::refused(
                &envelope.command_id,
                Status::Failed,
                "fault.command.executionFailed",
                reason,
                revision,
            )
        }
    }
}

/// Fork: answers a question or plan approval (Node's interaction broker mapping, projection/elicitation.rs).
/// What a pending permission ask offers: its always-allow suggestions, and whether it offers always-allow at all
/// (not for a `once` or an `independent` ask; the projection shows allow once and deny only).
struct Offered {
    suggestions: Vec<rust_cli_kernel_api::permission::PermissionRule>,
    always: bool,
}

impl Offered {
    /// A permission ask's offer and its tool use; `None` for any other ask.
    fn of(request: &InteractionRequest) -> Option<(Self, ToolUseId)> {
        let InteractionRequest::Permission {
            suggestions,
            tool_use,
            once,
            independent,
            ..
        } = request
        else {
            return None;
        };
        let offered = Self {
            suggestions: suggestions.clone(),
            always: !once && !independent,
        };
        Some((offered, tool_use.clone()))
    }
}

/// The answer to a permission ask for an option that is not a mode switch. `allowAlways` on an ask that does not offer
/// it is a deny, like any option the ask did not offer (Node `interaction-broker.ts`).
fn permission_answer(
    option: Option<&str>,
    offered: Offered,
    free_text: Option<&str>,
) -> PermissionAnswer {
    match option {
        Some("allowOnce") => PermissionAnswer::Allow {
            remember: Vec::new(),
        },
        Some("allowAlways") if offered.always => PermissionAnswer::Allow {
            remember: offered.suggestions,
        },
        _ => PermissionAnswer::Deny {
            feedback: free_text
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned),
        },
    }
}

async fn resolve_elicitation(
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
    revision: u64,
    resolved: &ResolvePayload,
    request: &InteractionRequest,
) -> Ack {
    use crate::projection::elicitation;
    let action = resolved.answer.action.as_deref();
    let content = resolved.answer.content.as_ref();
    let answer: rust_cli_kernel_api::orchestration::Answer = match request {
        // The caller answers permission asks itself; one reaching here is answered as a question would be.
        InteractionRequest::Question { questions, .. } => {
            elicitation::question_answer(questions, action, content).into()
        }
        InteractionRequest::Permission { .. } => {
            elicitation::question_answer(&Value::Null, action, content).into()
        }
        InteractionRequest::PlanApproval { .. } => elicitation::plan_answer(
            action,
            content,
            resolved.answer.free_text.as_deref(),
            live.current_config().1,
        )
        .into(),
    };
    let command = Command::ResolveInteraction {
        interaction: InteractionId::new(&resolved.interaction_id),
        answer,
    };
    ack_of(
        send(handle, &envelope.command_id, command).await,
        Ack::accepted(&envelope.command_id, revision, None),
        |reason| {
            Ack::refused(
                &envelope.command_id,
                Status::Noop,
                "proto.alreadyResolved",
                reason,
                revision,
            )
        },
    )
}

/// setFollowupMode（CAS）：跟进方式是协议保存的配置；裁决用会话 actor 的当前 revision（G1）。
async fn set_followup(
    server: &Server,
    handle: &dyn SessionHandle,
    live: &std::sync::Arc<rust_cli_protocol_core::sessions::Bridged<crate::live::Live>>,
    envelope: &Envelope,
) -> Ack {
    let command = envelope.command_id.as_str();
    let revision = match handle.view().await {
        Ok(view) => view.revision,
        Err(error) => {
            return Ack::refused(
                command,
                Status::Failed,
                "fault.command.sessionUnavailable",
                error.to_string(),
                0,
            );
        }
    };
    let wanted = match payload::<FollowupPayload>(envelope) {
        Ok(chosen) => chosen.mode,
        Err(_) => {
            return Ack::refused(
                command,
                Status::Rejected,
                "proto.invalidPayload",
                "unknown followup mode",
                revision,
            );
        }
    };
    if live.sink.followup() == wanted {
        return Ack::refused(
            command,
            Status::Noop,
            "proto.unchanged",
            "the followup mode is already set",
            revision,
        );
    }
    if envelope.base_revision != Some(revision) {
        return Ack::refused(
            command,
            Status::Stale,
            "proto.staleRevision",
            "the session changed",
            revision,
        );
    }
    if let Some(session) = &envelope.session_id {
        server
            .followups
            .lock_unpoisoned()
            .insert(SessionId::new(session), wanted);
    }
    // 增量在会话的泵任务里发（与内核事件的帧同一个顺序）。
    let sink = live.sink.clone();
    live.run(Box::pin(async move { sink.set_followup(wanted).await }));
    Ack::accepted(command, revision, None)
}

/// `v4/commands/query`：内存表，然后命令事实（G2）；都没有时 unknown。时钟探测带 `clock`。
pub async fn query(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let received = server.context.now();
    let mut results = Vec::new();
    for key in params["commands"].as_array().into_iter().flatten() {
        let session = key["sessionId"].as_str();
        let command = key["commandId"].as_str().unwrap_or_default();
        let known = server
            .remembered
            .lock_unpoisoned()
            .get(&inbox::key(session, command))
            .cloned();
        let known = match (known, session) {
            (Some(ack), _) => Some(ack),
            (None, Some(session)) => stored_ack(server, &SessionId::new(session), command).await,
            (None, None) => None,
        };
        results.push(json!({
            "key": {"sessionId": session, "commandId": command},
            "result": known.map_or(json!("unknown"), |ack| ack.to_value()),
        }));
    }
    let mut reply = json!({"results": results});
    if params["clock"] == true {
        reply["clock"] = json!({
            "instanceId": server.instance,
            "receivedAt": received,
            "sentAt": server.context.now(),
        });
    }
    Ok(reply)
}

/// The stored verdict of a command the in-memory table no longer has. A queued input settled in the
/// `session_input` ledger answers first: the Rust agent also stores an `accepted` fact when it queues an input, which
/// Node does not (specs/fork-rust-agent-parity.md, Input ledger).
async fn stored_ack(server: &Server, session: &SessionId, command: &str) -> Option<Ack> {
    let queries = server.kernel.queries();
    match queries
        .settled_input(session, &CommandId::new(command))
        .await
    {
        Ok(Some(row)) => return Some(inbox::settled_input_ack(command, &row)),
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(event = "protocol.command_query.ledger_failed", error = %error, "reading the input ledger failed");
        }
    }
    queries
        .records(session, inbox::COMMAND_FACT)
        .await
        .ok()
        .and_then(|records| inbox::find_fact(&records, command))
}

/// Fork: Node's stop holds the following queue (specs/stop-queue-hold.md rules 1-4): a stop that will cancel a turn
/// while inputs are queued and the queue still drains pauses the drain first, so the turn end cannot promote the head
/// the user just stopped. The hold is written to the kernel before the interrupt (the session actor applies commands in
/// order), and released again when there was nothing to stop.
async fn stop(
    handle: &dyn SessionHandle,
    sink: &crate::live::Live,
    envelope: &Envelope,
    phase: Phase,
    revision: u64,
) -> Ack {
    let id = &envelope.command_id;
    let held = phase == Phase::Running
        && sink.has_queue()
        && sink.auto_drain()
        && matches!(
            send(
                handle,
                &format!("{id}:hold"),
                Command::HoldQueue { held: true }
            )
            .await,
            KernelAck::Accepted { .. }
        );
    let interrupted = send(handle, id, Command::Interrupt).await;
    if matches!(interrupted, KernelAck::Accepted { .. }) {
        if held {
            sink.hold_for_stop().await;
        }
    } else if held
        && let KernelAck::Rejected { reason } = send(
            handle,
            &format!("{id}:release"),
            Command::HoldQueue { held: false },
        )
        .await
    {
        tracing::warn!(event = "protocol.stop.release_failed", reason = %reason,
            "releasing the stop's queue hold failed");
    }
    ack_of(interrupted, Ack::accepted(id, revision, None), |reason| {
        Ack::refused(id, Status::Noop, "proto.nothingToStop", reason, revision)
    })
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;
