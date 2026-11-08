//! 命令的处理（[`crate::inbox`] 的裁决与转交）：P1 的五个命令。

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::{CommandId, InteractionId, SessionId};
use rust_cli_kernel_api::interaction::PermissionAnswer;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, Command, CommandEnvelope, CreateSession, Delivery, SessionHandle,
};
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

/// App 的模式与 plan 开关 → 内核的权限模式与 plan（README §5 的映射；`plan` 是旧写法，读成 plan 开、build）。
fn mode(name: Option<&str>, plan: Option<bool>) -> Option<(PermissionMode, bool)> {
    let name = name?;
    if name == "plan" {
        return Some((PermissionMode::Default, true));
    }
    Some((PermissionMode::from_node_name(name)?, plan.unwrap_or(false)))
}

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
    if ack.status != Status::Duplicate {
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

async fn decide(server: &Server, envelope: &Envelope) -> Ack {
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
        "sendText" => {
            let ack = send_text(server, handle, &live.sink, envelope, phase, revision).await;
            if ack.status == Status::Accepted {
                complete_first_submission(server, &live, envelope).await;
            }
            ack
        }
        "stop" => stop(handle, &live.sink, envelope, phase, revision).await,
        "resolveInteraction" => resolve(handle, &live.sink, envelope, revision).await,
        "setFollowupMode" => set_followup(server, handle, &live, envelope).await,
        // Fork: command kinds ported for desktop parity (specs/fork-rust-agent-parity.md).
        _ => match crate::fork::commands::decide(server, &live, envelope, phase, revision).await {
            Some(ack) => ack,
            None => unsupported(envelope, revision),
        },
    }
}

async fn create_session(server: &Server, envelope: &Envelope) -> Ack {
    let payload: CreateSessionPayload = match payload(envelope) {
        Ok(payload) => payload,
        Err(ack) => return *ack,
    };
    if let Some(preparation) = &payload.submission_preparation {
        return reserve_submission(server, envelope, &payload, &preparation.submission_id).await;
    }
    if let (Some(prepared), Some(expected)) = (
        payload.prepared_session_id.as_deref(),
        payload.expected_submission_id.as_deref(),
    ) {
        return activate_submission(server, envelope, &payload, prepared, expected).await;
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
    let (permission, plan) =
        mode(config.mode.as_deref(), config.plan_enabled).unwrap_or((server.defaults.mode, false));
    let id = payload
        .session_id
        .as_deref()
        .map_or_else(inbox::new_session_id, SessionId::new);
    if let Some(followup) = config.followup_mode {
        server
            .followups
            .lock_unpoisoned()
            .insert(id.clone(), followup);
    }
    let workspace = payload.workspace_id.as_deref().unwrap_or_default();
    let created = server
        .kernel
        .create_session(CreateSession {
            id: Some(id.clone()),
            workspace: server.workspace(workspace),
            selection: chosen,
            mode: permission,
            plan,
        })
        .await;
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
    if let Some(text) = first.text.clone() {
        live.sink.remember_input(
            &envelope.command_id,
            input_meta(envelope, &first, "startNow", "startNow"),
        );
        let submit = if refs.is_empty() {
            Command::Submit {
                text,
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            }
        } else {
            Command::SubmitContent {
                content: crate::attachments::content(server, &id, &text, refs).await,
                delivery: Delivery::Queue,
            }
        };
        if let KernelAck::Accepted { .. } =
            send(live.handle.as_ref(), &envelope.command_id, submit).await
        {
            result["input"] = json!({"delivery": "startNow", "inputId": envelope.command_id});
        }
    }
    Ack::accepted(&envelope.command_id, 0, Some(result))
}

/// Fork: reservation. Creates the session with the draft's selection and stores a preparing marker; a repeat with
/// the same submission returns the same session, anything else that already owns the id is refused.
async fn reserve_submission(
    server: &Server,
    envelope: &Envelope,
    payload: &CreateSessionPayload,
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
        let conversation = !view.messages.is_empty() || !view.queue.is_empty() || view.running;
        match crate::preparation::reserve_existing(
            marker.as_ref(),
            submission,
            workspace_matches,
            conversation,
        ) {
            crate::preparation::Reserve::Repeat => return accepted(&id),
            crate::preparation::Reserve::Adopt => {}
            crate::preparation::Reserve::Refuse(reason) => {
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
    payload: &CreateSessionPayload,
    prepared: &str,
    expected: &str,
) -> Ack {
    let id = SessionId::new(prepared);
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
        let handle = live.handle.as_ref();
        if let Some(chosen) = selection(payload.config.model_selection.as_ref()) {
            send(
                handle,
                &format!("{}:model", envelope.command_id),
                Command::SetModel { selection: chosen },
            )
            .await;
        }
        if let Some((permission, plan)) =
            mode(payload.config.mode.as_deref(), payload.config.plan_enabled)
        {
            send(
                handle,
                &format!("{}:mode", envelope.command_id),
                Command::SetMode { mode: permission },
            )
            .await;
            send(
                handle,
                &format!("{}:plan", envelope.command_id),
                Command::SetPlan { enabled: plan },
            )
            .await;
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
        selection: input.model_selection.clone(),
        mode: input.mode.clone(),
        plan: input.plan_enabled,
        admitted_at: 0,
        requested,
        admitted,
        attachments: input.attachments.clone(),
    }
}

async fn send_text(
    server: &Server,
    handle: &dyn SessionHandle,
    live: &crate::live::Live,
    envelope: &Envelope,
    phase: Phase,
    revision: u64,
) -> Ack {
    let input: Input = match payload(envelope) {
        Ok(input) => input,
        Err(ack) => return *ack,
    };
    let command = envelope.command_id.as_str();
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
    // 这次提交带的模型与模式先作用到会话（同 Node：Submission 带完整的选择）。
    let view = handle.view().await.ok();
    if let Some(chosen) = selection(input.model_selection.as_ref())
        && view.as_ref().is_none_or(|view| view.selection != chosen)
    {
        send(
            handle,
            &format!("{command}:model"),
            Command::SetModel { selection: chosen },
        )
        .await;
    }
    if let Some((permission, plan)) = mode(input.mode.as_deref(), input.plan_enabled) {
        if view.as_ref().is_none_or(|view| view.mode != permission) {
            send(
                handle,
                &format!("{command}:mode"),
                Command::SetMode { mode: permission },
            )
            .await;
        }
        if view.as_ref().is_none_or(|view| view.plan != plan) {
            send(
                handle,
                &format!("{command}:plan"),
                Command::SetPlan { enabled: plan },
            )
            .await;
        }
    }
    let running = phase == Phase::Running;
    let requested = input.requested_delivery;
    let followup = live.followup();
    // Fork: content blocks (attachments) are never steered into a running turn; they wait for it to end.
    let with_attachments = !refs.is_empty();
    let (delivery, admitted) = match (requested, running) {
        (_, true) if with_attachments => (Delivery::Queue, "queue"),
        (Some(Requested::Guide), true) => (Delivery::Steer, "guide"),
        (None, true) if followup == Followup::Guide => (Delivery::Steer, "guide"),
        (_, true) => (Delivery::Queue, "queue"),
        (_, false) => (Delivery::Queue, "startNow"),
    };
    let requested = requested.unwrap_or(Requested::StartNow).as_str();
    live.remember_input(command, input_meta(envelope, &input, requested, admitted));
    let text = input.text.unwrap_or_default();
    let submit = if with_attachments {
        Command::SubmitContent {
            content: crate::attachments::content(server, handle.id(), &text, refs).await,
            delivery,
        }
    } else {
        Command::Submit {
            text,
            attachments: Vec::new(),
            delivery,
        }
    };
    let result = json!({"type": "inputAccepted", "delivery": admitted, "inputId": command});
    ack_of(
        send(handle, command, submit).await,
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
    let pending = handle.view().await.ok().and_then(|view| {
        view.pending
            .into_iter()
            .find(|(id, _)| id.as_str() == interaction)
            .map(|(_, request)| request)
    });
    let (suggestions, tool) = match pending {
        Some(InteractionRequest::Permission {
            suggestions,
            tool_use,
            ..
        }) => (suggestions, tool_use),
        Some(request) => {
            return resolve_elicitation(handle, live, envelope, revision, &resolved, &request)
                .await;
        }
        None => {
            return Ack::refused(
                &envelope.command_id,
                Status::Noop,
                "proto.alreadyResolved",
                "the interaction is no longer pending",
                revision,
            );
        }
    };
    // “完全访问”：先把会话切到 yolo（之后不再询问），再放行这一次。
    if option == Some("fullAccess") {
        send(
            handle,
            &format!("{}:mode", envelope.command_id),
            Command::SetMode {
                mode: PermissionMode::BypassPermissions,
            },
        )
        .await;
    }
    let answer = match option {
        Some("allowOnce" | "fullAccess") => PermissionAnswer::Allow {
            remember: Vec::new(),
        },
        Some("allowAlways") => PermissionAnswer::Allow {
            remember: suggestions,
        },
        _ => PermissionAnswer::Deny {
            feedback: resolved
                .answer
                .free_text
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned),
        },
    };
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

/// Fork: answers a question or plan approval (Node's interaction broker mapping, projection/elicitation.rs).
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
            (None, Some(session)) => server
                .kernel
                .queries()
                .records(&SessionId::new(session), inbox::COMMAND_FACT)
                .await
                .ok()
                .and_then(|records| inbox::find_fact(&records, command)),
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
            send(handle, &format!("{id}:hold"), Command::HoldQueue { held: true }).await,
            KernelAck::Accepted { .. }
        );
    let interrupted = send(handle, id, Command::Interrupt).await;
    if matches!(interrupted, KernelAck::Accepted { .. }) {
        if held {
            sink.hold_for_stop().await;
        }
    } else if held
        && let KernelAck::Rejected { reason } =
            send(handle, &format!("{id}:release"), Command::HoldQueue { held: false }).await
    {
        tracing::warn!(event = "protocol.stop.release_failed", reason = %reason,
            "releasing the stop's queue hold failed");
    }
    ack_of(
        interrupted,
        Ack::accepted(id, revision, None),
        |reason| Ack::refused(id, Status::Noop, "proto.nothingToStop", reason, revision),
    )
}
