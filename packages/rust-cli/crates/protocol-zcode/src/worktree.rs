//! Fork: execution worktree (the desktop's prepared worktree and `executionWorktree` sessions; Node `v4-bridge.ts`,
//! specs/fork-rust-agent-parity.md "Execution worktree").
//!
//! - The prepared worktree is a marker in Node's record (`session_entry`, type `v4/worktree_preparation`, data
//!   `{attemptId?, branchName, targetPath, baseBranch?, status, failureMessage?}`), owned here. While it is not
//!   active the snapshot meta and the sessions-index row carry `worktreePreparation`.
//! - The execution worktree is the Node `session` row's `execution_directory` / `execution_branch`, written once
//!   through `StoreQueries::set_execution_worktree`: by the activation here, or by `Kernel::create_session_in_worktree`
//!   on the direct route. The session actor owns the cwd: the root it starts with (direct route, cold open) or
//!   `Command::SetExecutionRoot` (activation); a cold open runs in the stored worktree (node-store), listed under the
//!   row's `directory`.

use std::sync::Arc;

use rust_cli_base::sync::LockUnpoisoned;

use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::incognito::IncognitoProfile;
use rust_cli_kernel_api::session_api::{Ack as KernelAck, Command};
use rust_cli_kernel_api::store::{ExecutionWorktree, FrontendRecord};
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::server::Server;

pub const KIND: &str = "v4/worktree_preparation";

/// Node's text for a prepared session that cannot be activated or updated.
pub const UNAVAILABLE: &str = "Prepared worktree session is unavailable";
pub const MISMATCH: &str = "Prepared worktree session does not match the requested workspace";
/// Node's text for an activation whose incognito profile differs from the one the first activation froze.
pub const INCOGNITO_MISMATCH: &str =
    "Prepared worktree session does not match the requested incognito profile";
const STALE: &str = "guard.worktreePreparationStale";
const CANCELLED: &str = "guard.worktreePreparationCancelled";
/// Node answers a failed handler `failed` with this reason and the error text as the message.
const EXECUTION_FAILED: &str = "fault.command.executionFailed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrepStatus {
    Preparing,
    Failed,
    Cancelled,
    Active,
}

impl PrepStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Active => "active",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "preparing" => Self::Preparing,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "active" => Self::Active,
            _ => return None,
        })
    }
}

/// `createSession.worktreePreparation` and `updateWorktreePreparation.worktreePreparation`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub branch_name: String,
    pub target_path: String,
    pub base_branch: Option<String>,
    pub attempt_id: Option<String>,
}

/// `updateWorktreePreparation`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub status: PrepStatus,
    pub failure_message: Option<String>,
    pub expected_attempt_id: Option<String>,
    pub worktree_preparation: Option<Request>,
}

/// `createSession.executionWorktree` (`zcodeExecutionWorktreeSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Requested {
    pub path: String,
    pub branch_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Marker {
    pub attempt_id: Option<String>,
    pub branch_name: String,
    pub target_path: String,
    pub base_branch: Option<String>,
    pub status: PrepStatus,
    pub failure_message: Option<String>,
    /// Fork: the incognito choice the first activation froze (Node's `prepared.incognito` stamp): `None` not chosen
    /// yet, `Some(None)` a normal session, `Some(Some(profile))` an incognito one. Stored as the marker's `incognito`
    /// key (absent, `null`, the profile); Node's parser ignores the key and the row's `fork_incognito` stays the
    /// durable fact Node reads.
    pub incognito: Option<Option<IncognitoProfile>>,
}

impl Marker {
    pub fn preparing(request: &Request) -> Self {
        Self {
            attempt_id: request.attempt_id.clone(),
            branch_name: request.branch_name.clone(),
            target_path: request.target_path.clone(),
            base_branch: request.base_branch.clone(),
            status: PrepStatus::Preparing,
            failure_message: None,
            incognito: None,
        }
    }

    /// Node `persistPreparedWorktreeStatus`: the new status and failure text; a replacing request takes over the
    /// attempt (when it names one), the branch, the path and the base branch.
    pub fn with_status(
        &self,
        status: PrepStatus,
        failure_message: Option<&str>,
        replacing: Option<&Request>,
    ) -> Self {
        let mut next = self.clone();
        if let Some(request) = replacing {
            if request.attempt_id.is_some() {
                next.attempt_id.clone_from(&request.attempt_id);
            }
            next.branch_name.clone_from(&request.branch_name);
            next.target_path.clone_from(&request.target_path);
            next.base_branch.clone_from(&request.base_branch);
        }
        next.status = status;
        next.failure_message = failure_message
            .filter(|text| !text.is_empty())
            .map(str::to_owned);
        next
    }

    fn data(&self) -> Value {
        let mut data = json!({
            "branchName": self.branch_name,
            "targetPath": self.target_path,
            "status": self.status.as_str(),
        });
        if let Some(attempt) = &self.attempt_id {
            data["attemptId"] = json!(attempt);
        }
        if let Some(base) = &self.base_branch {
            data["baseBranch"] = json!(base);
        }
        if let Some(failure) = &self.failure_message {
            data["failureMessage"] = json!(failure);
        }
        if let Some(choice) = &self.incognito {
            data["incognito"] = json!(choice);
        }
        data
    }

    pub fn record(&self, session: &str) -> FrontendRecord {
        FrontendRecord {
            kind: KIND.to_owned(),
            key: format!("{KIND}:{session}"),
            data: self.data(),
        }
    }

    /// The latest marker among the session's records (Node `parsePreparedWorktreeEntry` of the last entry).
    pub fn latest(records: &[FrontendRecord]) -> Option<Self> {
        let data = &records.last()?.data;
        let text = |key: &str| data[key].as_str().map(str::to_owned);
        Some(Self {
            attempt_id: text("attemptId"),
            branch_name: text("branchName")?,
            target_path: text("targetPath")?,
            base_branch: text("baseBranch"),
            status: PrepStatus::parse(data["status"].as_str()?)?,
            failure_message: text("failureMessage"),
            // A stamp this build cannot parse reads as lockdown, like the row (fail closed).
            incognito: data.get("incognito").map(|choice| {
                (!choice.is_null()).then(|| {
                    IncognitoProfile::from_wire(choice).unwrap_or(IncognitoProfile::LOCKDOWN)
                })
            }),
        })
    }

    /// `worktreePreparation` (`worktreePreparationStateSchema`): only while not active.
    pub fn exposed(&self) -> Option<Value> {
        (self.status != PrepStatus::Active).then(|| self.data())
    }
}

/// Node `updateWorktreePreparation`: the unavailable check, then `assertWorktreePreparationMutation`.
pub fn check_update(current: Option<&Marker>, update: &Update) -> Result<(), &'static str> {
    let Some(current) = current else {
        return Err(UNAVAILABLE);
    };
    let attempt_differs = current
        .attempt_id
        .as_ref()
        .is_some_and(|attempt| update.expected_attempt_id.as_ref() != Some(attempt));
    if current.status == PrepStatus::Active || attempt_differs {
        return Err(UNAVAILABLE);
    }
    if update.status == PrepStatus::Active {
        return Err(STALE);
    }
    if current.status == PrepStatus::Cancelled {
        let new_attempt = update.status == PrepStatus::Preparing
            && update
                .worktree_preparation
                .as_ref()
                .and_then(|request| request.attempt_id.as_ref())
                .is_some_and(|attempt| current.attempt_id.as_ref() != Some(attempt));
        if !new_attempt {
            return Err(CANCELLED);
        }
    }
    Ok(())
}

/// What an activation does with a prepared session.
#[derive(Debug, PartialEq, Eq)]
pub enum Activation {
    /// The durable active marker is the receipt of a completed activation.
    AlreadyActive,
    Materialize,
}

/// Node `createSessionRecord` with `preparedSessionId` and no `expectedSubmissionId`.
pub fn check_activation(
    current: Option<&Marker>,
    expected_attempt: Option<&str>,
    workspace_matches: bool,
    requested: Option<&Requested>,
) -> Result<Activation, &'static str> {
    let Some(current) = current else {
        return Err(UNAVAILABLE);
    };
    let attempt_differs = current
        .attempt_id
        .as_deref()
        .is_some_and(|attempt| expected_attempt != Some(attempt));
    if !matches!(current.status, PrepStatus::Preparing | PrepStatus::Active) || attempt_differs {
        return Err(UNAVAILABLE);
    }
    let Some(requested) = requested else {
        return Err(MISMATCH);
    };
    let branch_differs = requested
        .branch_name
        .as_ref()
        .is_some_and(|branch| !branch.is_empty() && *branch != current.branch_name);
    if !workspace_matches || requested.path != current.target_path || branch_differs {
        return Err(MISMATCH);
    }
    Ok(if current.status == PrepStatus::Active {
        Activation::AlreadyActive
    } else {
        Activation::Materialize
    })
}

/// The worktree facts the snapshot meta and the sessions-index row carry (owned by [`Live`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    /// The prepared worktree while it is not active.
    pub preparing: Option<Marker>,
    pub execution: Option<Execution>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Execution {
    pub path: String,
    pub branch: Option<String>,
    /// The worktree directory is gone (Node `executionWorktreeMissing`).
    pub missing: bool,
}

impl Facts {
    pub fn decorate_meta(&self, meta: &mut Value) {
        if let Some(exposed) = self.preparing.as_ref().and_then(Marker::exposed) {
            meta["worktreePreparation"] = exposed;
        }
    }

    /// Node `sessions-index-projection`: a preparing row is a draft titled `Worktree <branch>` until it has a title;
    /// a worktree session carries the strict `executionWorktree {path, branchName?}` and the missing flag.
    pub fn decorate_row(&self, row: &mut Value) {
        if let Some(marker) = &self.preparing
            && let Some(exposed) = marker.exposed()
        {
            row["worktreePreparation"] = exposed;
            row["phase"] = json!("draft");
            row["sessionEnded"] = json!(false);
            row.as_object_mut()
                .map(|fields| fields.remove("lastOutcome"));
            if row["title"].as_str().is_none_or(str::is_empty) {
                row["title"] = json!(format!("Worktree {}", marker.branch_name));
            }
        }
        if let Some(execution) = &self.execution {
            let mut worktree = json!({"path": execution.path});
            if let Some(branch) = execution
                .branch
                .as_ref()
                .filter(|branch| !branch.is_empty())
            {
                worktree["branchName"] = json!(branch);
            }
            row["executionWorktree"] = worktree;
            if execution.missing {
                row["executionWorktreeMissing"] = json!(true);
            }
        }
    }
}

/// The session's marker. A failed read is an error, not "no marker". The text names no storage detail.
pub async fn load(server: &Server, session: &SessionId) -> Result<Option<Marker>, &'static str> {
    let records = server
        .kernel
        .queries()
        .records(session, KIND)
        .await
        .map_err(|_| "reading the worktree preparation failed")?;
    Ok(Marker::latest(&records))
}

async fn save(server: &Server, session: &SessionId, marker: &Marker) -> Result<(), &'static str> {
    server
        .kernel
        .queries()
        .put_record(session, &marker.record(session.as_str()))
        .await
        // No error text: a storage error can name the storage path.
        .map_err(|_| "storing the worktree preparation failed")
}

/// The stored execution worktree; a read failure is logged and reads as none (the session then lists and runs
/// where the store's load put it).
pub async fn stored_execution(server: &Server, session: &SessionId) -> Option<ExecutionWorktree> {
    match server.kernel.queries().execution_worktree(session).await {
        Ok(worktree) => worktree,
        Err(error) => {
            tracing::warn!(event = "protocol.worktree.read_failed", error = %error, "reading the execution worktree failed");
            None
        }
    }
}

/// Node checks the directory on its own machine; zcode-rs checks a local workspace only.
async fn missing(server: &Server, path: &str) -> bool {
    server.defaults.environment.as_str() == "local"
        && !rust_cli_fs::is_dir(std::path::Path::new(path)).await
}

/// The facts of a session being opened: its marker and its stored execution worktree. A marker that cannot be read
/// fails the open (fail closed): read as "no marker", a prepared session would open like an ordinary one and run
/// SessionStart in the parent checkout.
pub async fn facts(
    server: &Server,
    session: &SessionId,
    execution: Option<&ExecutionWorktree>,
) -> Result<Facts, &'static str> {
    let preparing = load(server, session)
        .await?
        .filter(|marker| marker.status != PrepStatus::Active);
    Ok(Facts {
        preparing,
        execution: execution_facts(server, execution).await,
    })
}

async fn execution_facts(
    server: &Server,
    execution: Option<&ExecutionWorktree>,
) -> Option<Execution> {
    match execution {
        Some(worktree) => Some(Execution {
            path: worktree.path.as_str().to_owned(),
            branch: worktree.branch.clone(),
            missing: missing(server, worktree.path.as_str()).await,
        }),
        None => None,
    }
}

/// The sessions-index fields of a stored session that is not open (Node's cold summary). Only a display: a marker
/// that cannot be read lists no preparation, and opening the session refuses it ([`facts`]).
pub async fn decorate_cold_row(server: &Server, session: &SessionId, row: &mut Value) {
    let execution = stored_execution(server, session).await;
    let preparing = load(server, session)
        .await
        .ok()
        .flatten()
        .filter(|marker| marker.status != PrepStatus::Active);
    Facts {
        preparing,
        execution: execution_facts(server, execution.as_ref()).await,
    }
    .decorate_row(row);
}

fn failed(envelope: &Envelope, message: &str, revision: u64) -> Ack {
    Ack::refused(
        &envelope.command_id,
        Status::Failed,
        EXECUTION_FAILED,
        message,
        revision,
    )
}

/// The command kinds whose Node handler starts with `requireRecord` (`zcode-protocol-v4/commands/record-access.ts`):
/// a prepared session has no runtime record before its activation, so Node refuses them with
/// `V4SessionNotFoundError`. `deleteSession` (Node lets a prepared session through `hasPreparedSession`),
/// `updateWorktreePreparation`, `createSession`, `resolveInteraction`, `snoozeInteractionAutoResolution`,
/// `discardSharedContext`, reads and subscriptions pass.
const REQUIRES_RECORD: &[&str] = &[
    // session-flow.ts
    "sendText",
    "stop",
    // queue.ts
    "deleteQueueItem",
    "editQueueItem",
    "reorderQueueItem",
    "setAutoDrain",
    "setFollowupMode",
    "sendQueuedNow",
    // session-mgmt.ts
    "renameSession",
    // selection-side-session.ts
    "createSelectionSideSession",
    // goal-compact.ts
    "compact",
    "pauseGoal",
    "resumeGoal",
    "sendGoalCommand",
    // model-config.ts
    "switchModelConfig",
    "switchCollaborationMode",
    // interaction-background.ts
    "respondWorkspaceHookReview",
    "toggleWorkspaceHookReviewItem",
    "revokeWorkspaceHookTrust",
    "requestWorkspaceHookReview",
    "cancelBackgroundWork",
    "resumeWorkflowRun",
    "startSavedWorkflow",
    "amendWorkflowRunSettings",
    // fork-edit-retry.ts
    "forkAssistant",
    "editUserQuery",
    "retryTurn",
    // file-rewind.ts, assistant-feedback.ts, row-pin.ts, highspeed-metrics.ts, external-agent-config.ts
    "applyFileRewind",
    "setAssistantFeedback",
    "setRowPinned",
    "setHighspeedMetrics",
    "setExternalAgentConfigOption",
];

/// Fork: fail closed like Node before a prepared worktree's activation. While its marker is not `active` the actor
/// waits at the parent checkout with SessionStart held, so a command that needs Node's runtime record (input, a
/// turn, a setting) is refused with Node's ack (`failed`, `fault.command.executionFailed`,
/// `v4 command session not found: <id>`) instead of running a turn in the parent. The durable marker is read, not
/// the projection, which an activation updates asynchronously.
pub async fn refuse_before_activation(
    server: &Server,
    envelope: &Envelope,
    session: &str,
) -> Option<Ack> {
    if !REQUIRES_RECORD.contains(&envelope.kind.as_str()) {
        return None;
    }
    let id = SessionId::new(session);
    match load(server, &id).await {
        // Materialized in this process while its active receipt failed to store: Node has the runtime record, so
        // the command passes; the marker is healed here.
        Ok(Some(marker))
            if marker.status != PrepStatus::Active
                && server.unreceipted.lock_unpoisoned().contains(&id) =>
        {
            let active = marker.with_status(PrepStatus::Active, None, None);
            if save(server, &id, &active).await.is_ok() {
                server.unreceipted.lock_unpoisoned().remove(&id);
            }
            None
        }
        Ok(Some(marker)) if marker.status != PrepStatus::Active => Some(failed(
            envelope,
            &format!("v4 command session not found: {session}"),
            0,
        )),
        Ok(_) => None,
        Err(reason) => Some(failed(envelope, reason, 0)),
    }
}

/// Fork: `createSession` with `worktreePreparation` (Node `prepareWorktreeSession`): a new session listed under
/// the parent workspace, its marker preparing; no runtime settings and no input.
pub async fn prepare(
    server: &Server,
    envelope: &Envelope,
    workspace: &str,
    request: &Request,
    selection: rust_cli_kernel_api::model::ModelSelection,
) -> Ack {
    let id = crate::inbox::new_session_id();
    // SessionStart waits for the activation, so the hook runs in the worktree (Node has no runtime before it).
    let created = server
        .kernel
        .create_prepared_session(rust_cli_kernel_api::session_api::CreateSession {
            id: Some(id.clone()),
            workspace: server.workspace(workspace),
            selection,
            mode: server.defaults.mode,
            plan: false,
            // Fork: the reserved row has no profile, like Node; the profile rides on the activation.
            incognito: None,
        })
        .await;
    let id = match created {
        Ok(id) => id,
        Err(error) => return failed(envelope, &error.to_string(), 0),
    };
    let marker = Marker::preparing(request);
    if let Err(reason) = save(server, &id, &marker).await {
        // Like Node, a reservation whose marker cannot be stored leaves no empty session behind.
        if let Err(error) = server.kernel.delete_session(&id).await {
            tracing::warn!(event = "protocol.worktree.cleanup_failed", error = %error, "removing the empty worktree session failed");
        }
        return failed(envelope, reason, 0);
    }
    match server.live(&id).await {
        // The open restores the marker stored above (crate::server::Server::live).
        Ok(live) => crate::subscribe::announce(&live),
        Err(error) => {
            tracing::warn!(event = "protocol.worktree.open_failed", error = %error, "opening the prepared worktree session failed");
        }
    }
    Ack::accepted(
        &envelope.command_id,
        0,
        Some(json!({"type": "createSession", "sessionId": id.as_str()})),
    )
}

/// Fork: `updateWorktreePreparation` (Node `updateWorktreePreparation`): compare-and-set on the attempt, then the
/// marker, the snapshot and the sessions-index row.
pub async fn update(
    server: &Server,
    live: &Arc<Bridged<Live>>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let update: Update = match crate::commands::payload(envelope) {
        Ok(update) => update,
        Err(ack) => return *ack,
    };
    let Some(session) = envelope.session_id.as_deref() else {
        return failed(envelope, UNAVAILABLE, revision);
    };
    let id = SessionId::new(session);
    // One mutation at a time: the check and the save of an update or an activation are not interleaved.
    let Ok(_gate) = server.reservations.acquire().await else {
        return failed(envelope, UNAVAILABLE, revision);
    };
    let current = match load(server, &id).await {
        Ok(current) => current,
        Err(reason) => return failed(envelope, reason, revision),
    };
    if let Err(reason) = check_update(current.as_ref(), &update) {
        return failed(envelope, reason, revision);
    }
    let Some(current) = current else {
        return failed(envelope, UNAVAILABLE, revision);
    };
    let next = current.with_status(
        update.status,
        update.failure_message.as_deref(),
        update.worktree_preparation.as_ref(),
    );
    if let Err(reason) = save(server, &id, &next).await {
        return failed(envelope, reason, revision);
    }
    let facts = Facts {
        preparing: Some(next),
        ..live.sink.worktree()
    };
    let sink = live.sink.clone();
    live.run(Box::pin(async move { sink.set_worktree(facts).await }));
    Ack::accepted(
        &envelope.command_id,
        revision,
        Some(json!({"type": "worktreePreparationUpdated", "status": update.status.as_str()})),
    )
}

/// Moves the session into `target`, then stores the fact. The move comes first: a refused move stores nothing, so a
/// retry may name another worktree. The fact is set once, so the caller passes the stored worktree as the target
/// when there is one, and the actor and the store never disagree. A store that fails after the move fails the
/// activation; the marker stays preparing and a retry moves and stores again.
async fn enter(
    server: &Server,
    live: &Bridged<Live>,
    envelope: &Envelope,
    id: &SessionId,
    target: &Requested,
) -> Result<(), String> {
    let path = EnvPath::new(&target.path);
    let command = Command::SetExecutionRoot { root: path.clone() };
    if let KernelAck::Rejected { reason } = crate::commands::send(
        live.handle.as_ref(),
        &format!("{}:worktree", envelope.command_id),
        command,
    )
    .await
    {
        return Err(reason);
    }
    server
        .kernel
        .queries()
        .set_execution_worktree(id, &path, target.branch_name.as_deref())
        .await
        .map_err(|error| error.to_string())
}

/// Fork: the incognito choice of an activation. A choice the row (Node writes it at the first send) or the marker's
/// stamp already holds wins, and a request that differs from it is refused with Node's text; otherwise the request is
/// the choice.
async fn frozen_incognito(
    server: &Server,
    id: &SessionId,
    current: Option<&Marker>,
    requested: Option<IncognitoProfile>,
) -> Result<Option<IncognitoProfile>, &'static str> {
    // A read-only view: it never opens the held session.
    let stored = server
        .kernel
        .session_snapshot(id)
        .await
        .ok()
        .and_then(|view| view.meta.incognito);
    let frozen = stored
        .map(Some)
        .or_else(|| current.and_then(|marker| marker.incognito));
    match frozen {
        Some(choice) if choice != requested => Err(INCOGNITO_MISMATCH),
        Some(choice) => Ok(choice),
        None => Ok(requested),
    }
}

/// Fork: freezes the activation's incognito choice before anything of the session runs: the marker's stamp (a normal
/// session too), then for a profile the row and the kernel's in-memory profile (`Kernel::freeze_incognito`), the
/// actor's meta (`Command::SetIncognito`) and the projection's flag. Every step is idempotent, so a retry repeats them.
/// Returns the stamped marker, which the active marker keeps.
async fn freeze_incognito(
    server: &Server,
    live: &Bridged<Live>,
    envelope: &Envelope,
    id: &SessionId,
    current: Marker,
    choice: Option<IncognitoProfile>,
) -> Result<Marker, String> {
    let current = if current.incognito.is_none() {
        let stamped = Marker {
            incognito: Some(choice),
            ..current
        };
        save(server, id, &stamped).await.map_err(str::to_owned)?;
        stamped
    } else {
        current
    };
    let Some(profile) = choice else {
        return Ok(current);
    };
    server
        .kernel
        .freeze_incognito(id, profile)
        .await
        .map_err(|error| error.to_string())?;
    if let KernelAck::Rejected { reason } = crate::commands::send(
        live.handle.as_ref(),
        &format!("{}:incognito", envelope.command_id),
        Command::SetIncognito { profile },
    )
    .await
    {
        return Err(reason);
    }
    live.sink.freeze_incognito(profile);
    Ok(current)
}

/// Typed input reached the session: a committed or queued input that a client sent. SessionStart's own messages and
/// its `initial_user_message` are no evidence (Node checks the durable admission of the client's input).
fn input_admitted(view: &rust_cli_kernel_api::session_api::SessionView) -> bool {
    let typed = |command: &rust_cli_kernel_api::ids::CommandId| {
        !command
            .as_str()
            .starts_with(rust_cli_kernel_api::session_api::SESSION_START_INPUT)
    };
    view.commands.values().any(typed) || view.queue.iter().any(|queued| typed(&queued.command))
}

/// Refuses a worktree path that is not a directory (Node's exact text).
pub async fn check_directory(
    server: &Server,
    envelope: &Envelope,
    requested: &Requested,
) -> Result<(), Box<Ack>> {
    if missing(server, &requested.path).await {
        return Err(Box::new(Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            format!(
                "Execution worktree path does not exist or is not a directory: {}",
                requested.path
            ),
            0,
        )));
    }
    Ok(())
}

/// The workspace key a prepared session is listed under (Node `prepared.workspace.workspaceKey`, from
/// `workspaceID ?? directory`). Activations compare it as is with the client's `workspaceId`, which is already the
/// key (`workspaceIdentity?.trim() || workspacePath`). The row's key, never the actor's root: after a move whose
/// column write failed, the actor already runs in the worktree while the session stays listed under the parent.
pub(crate) async fn listed_key(server: &Server, id: &SessionId) -> Option<String> {
    server
        .kernel
        .queries()
        .session_workspace_key(id)
        .await
        .ok()
        .flatten()
}

/// What an activation names: the prepared session, the attempt, the parent workspace and the worktree.
pub struct ActivationRequest<'a> {
    pub prepared: &'a str,
    pub expected_attempt: Option<&'a str>,
    pub workspace: Option<&'a str>,
    pub requested: Option<&'a Requested>,
    /// Fork: the activation's incognito profile (`createSession.incognito`; Node sends it here, never on the
    /// preparation).
    pub incognito: Option<IncognitoProfile>,
}

/// Fork: activation of a prepared worktree (`createSession` with `preparedSessionId`, no `expectedSubmissionId`;
/// Node `runActivation`). `configure` applies the draft's config before the move, since the move releases the held
/// SessionStart and the hook must see the configured model (Node runs it in the first turn, after the config). A
/// refused config (`Err`, a guarded mode the session did not take) fails the activation before the move: SessionStart
/// stays held, nothing is admitted and the preparation stays retryable. After the move `materialize` admits
/// `firstInput` and returns the result's `input`. The marker turns active within the activation, as Node completes it.
pub async fn activate(
    server: &Server,
    envelope: &Envelope,
    request: ActivationRequest<'_>,
    configure: impl AsyncFnOnce(&Bridged<Live>) -> Result<(), String>,
    materialize: impl AsyncFnOnce(&Bridged<Live>) -> Option<Value>,
) -> Ack {
    let ActivationRequest {
        prepared,
        expected_attempt,
        workspace,
        requested,
        incognito,
    } = request;
    let id = SessionId::new(prepared);
    let Ok(_gate) = server.reservations.acquire().await else {
        return failed(envelope, UNAVAILABLE, 0);
    };
    let current = match load(server, &id).await {
        Ok(current) => current,
        Err(reason) => return failed(envelope, reason, 0),
    };
    let stored = stored_execution(server, &id).await;
    let listed = listed_key(server, &id).await;
    let workspace_matches = match (workspace, listed.as_deref()) {
        (Some(workspace), Some(listed)) => workspace == listed,
        (None, Some(_)) => true,
        (_, None) => false,
    };
    let activation = match check_activation(
        current.as_ref(),
        expected_attempt,
        workspace_matches,
        requested,
    ) {
        Ok(activation) => activation,
        Err(reason) => return failed(envelope, reason, 0),
    };
    // Fork (Node `createSessionRecord`): the first activation freezes the incognito choice; the row's profile, else
    // the marker's stamp, is that choice, and only an exact match may reuse the prepared session (absent is not equal
    // to present), an active one included.
    let incognito = match frozen_incognito(server, &id, current.as_ref(), incognito).await {
        Ok(choice) => choice,
        Err(reason) => return failed(envelope, reason, 0),
    };
    let accepted = |outcome: &str, input: Option<Value>| {
        let mut result = json!({"type": "createSession", "sessionId": id.as_str(), "preparedActivation": outcome});
        if let Some(input) = input {
            result["input"] = input;
        }
        Ack::accepted(&envelope.command_id, 0, Some(result))
    };
    if activation == Activation::AlreadyActive {
        return accepted("already-active", None);
    }
    let (Some(current), Some(requested)) = (current, requested) else {
        return failed(envelope, UNAVAILABLE, 0);
    };
    // The stored fact is set once: a worktree an earlier attempt entered and stored wins over this request.
    let target = match &stored {
        Some(worktree) => Requested {
            path: worktree.path.as_str().to_owned(),
            branch_name: worktree.branch.clone(),
        },
        None => requested.clone(),
    };
    if let Err(ack) = check_directory(server, envelope, &target).await {
        return *ack;
    }
    let live = match server.live(&id).await {
        Ok(live) => live,
        Err(error) => return failed(envelope, &error.to_string(), 0),
    };
    // An earlier attempt whose completion did not persist may already have admitted the first input: never send it
    // again under a new command id.
    let admitted = live
        .handle
        .view()
        .await
        .is_ok_and(|view| input_admitted(&view));
    // Fork: the profile is frozen before the config, the move (which releases SessionStart) and the first input, so
    // no hook and no request of the session runs without it. A failure leaves the session held and the preparation
    // retryable, like a refused config.
    let current = match freeze_incognito(server, &live, envelope, &id, current, incognito).await {
        Ok(current) => current,
        Err(message) => return failed(envelope, &message, 0),
    };
    if !admitted && let Err(message) = configure(&live).await {
        return failed(envelope, &message, 0);
    }
    // The move also releases the held SessionStart, so it runs on every attempt: after a restart between the
    // admission and the active marker, the session is already in the stored worktree and only the start is left.
    if let Err(message) = enter(server, &live, envelope, &id, &target).await {
        return failed(envelope, &message, 0);
    }
    let input = if admitted {
        None
    } else {
        materialize(&live).await
    };
    let active = current.with_status(PrepStatus::Active, None, None);
    if save(server, &id, &active).await.is_err() {
        // Best effort like Node `completePreparedActivation`: the session is materialized (Node has its runtime
        // record), only the receipt is missing. The gate lets its commands through and heals the marker; the next
        // activation heals it too.
        tracing::warn!(
            event = "protocol.worktree.complete_failed",
            "storing the active worktree marker failed"
        );
        server.unreceipted.lock_unpoisoned().insert(id.clone());
    } else {
        server.unreceipted.lock_unpoisoned().remove(&id);
    }
    let execution = Execution {
        path: target.path,
        branch: target.branch_name,
        missing: false,
    };
    let facts = Facts {
        preparing: None,
        execution: Some(execution),
    };
    let sink = live.sink.clone();
    live.run(Box::pin(async move { sink.set_worktree(facts).await }));
    let outcome = if admitted {
        "input-admitted"
    } else {
        "materialized"
    };
    accepted(outcome, input)
}

#[cfg(test)]
#[path = "worktree_tests.rs"]
mod tests;
