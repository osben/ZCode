//! Fork: the v4 run controls `startSavedWorkflow` and `amendWorkflowRunSettings` (specs/fork-rust-workflow-engine.md, 9.53,
//! W9a; Node `interaction-background.ts` and `zcode-protocol-v4/commands`).
//!
//! The session gate comes first: a session whose dynamic workflows are off, or whose run sessions are not installed, answers
//! `fault.command.capabilityUnsupported`, as Node answers a missing capability. Business refusals are `failed` acks with
//! Node's reason code and message, and the run service decides them (9.50, 9.53). The parent's side is [`ParentTurns`]: it
//! activates the workflow tools and records the launch and settings turns as control-only records through the session's
//! command path (`Command::RecordWorkflowTurn`). The records are delivered before the ack goes out, so a user input sent
//! after the ack queues behind them.

use std::sync::{Arc, Mutex};

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::{SessionId, WorkflowRunId};
use rust_cli_kernel_api::session_api::{Ack as KernelAck, Command, SessionHandle};
use rust_cli_kernel_api::workflow_run::{
    LaunchTurn, SettingsOutcome, SettingsRefusal, SettingsRequest, SettingsTurn, StartRefusal,
    StartSavedOutcome, StartSavedRequest, WorkflowRecordSource, WorkflowTurnSink,
};
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::commands::send;
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::server::Server;

/// Node `CAPABILITY_UNSUPPORTED` (`V4CapabilityUnsupportedError`).
const CAPABILITY_UNSUPPORTED: &str = "fault.command.capabilityUnsupported";
/// Node `SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX`.
const START_REJECTED: &str = "fault.command.savedWorkflowStartRejected.";
/// Node `WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX`.
const SETTINGS_REJECTED: &str = "fault.command.workflowRunSettingsRejected.";

/// The parent's side of a run's turns for one session: its activation, and the control-only records the run asked for.
///
/// Drain-once contract: the records wait in arrival order until [`ParentTurns::deliver`] takes them, once, after the run's
/// answer. A record the sink receives after that take is not sent: it is logged and dropped, so it is never silent. The
/// run service pushes every record before it answers, so the contract holds for it.
pub(crate) struct ParentTurns {
    gates: Arc<rust_cli_kernel_api::dynamic_workflow::SessionGates>,
    session: SessionId,
    state: Mutex<Pending>,
}

#[derive(Default)]
struct Pending {
    /// (source, text, `workflowLaunch` metadata) in the order the run asked for them.
    records: Vec<(WorkflowRecordSource, String, Option<serde_json::Value>)>,
    /// Set by the first `deliver`: records after it are dropped (and logged).
    delivered: bool,
}

impl ParentTurns {
    /// A sink over no gates and a fixed session, for the delivery tests (the run's own sink is built by `new`).
    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        Self {
            gates: Arc::default(),
            session: SessionId::new("ses_test"),
            state: Mutex::new(Pending::default()),
        }
    }

    fn new(server: &Server, session: SessionId) -> Self {
        Self {
            gates: server.context.dynamic_workflow_gates().clone(),
            session,
            state: Mutex::new(Pending::default()),
        }
    }

    fn push(&self, source: WorkflowRecordSource, text: String, meta: Option<serde_json::Value>) {
        let mut state = self.state.lock_unpoisoned();
        if state.delivered {
            tracing::warn!(
                event = "workflow.run.turn.after_delivery",
                source = source.as_str(),
                "a workflow control record arrived after the answer; it is not sent to the session"
            );
            return;
        }
        state.records.push((source, text, meta));
    }

    /// Sends the records to the session in order, each as a `RecordWorkflowTurn` command, and waits for each answer. Takes
    /// the records once (see the contract on the type). A record the session does not accept is logged.
    pub(crate) async fn deliver(&self, handle: &dyn SessionHandle) {
        self.deliver_with(|id, command| async move { send(handle, &id, command).await })
            .await;
    }

    /// [`ParentTurns::deliver`] over any command sender, so the order, the sources and the refusal are testable without a
    /// session.
    pub(crate) async fn deliver_with<F, Fut>(&self, mut send_command: F)
    where
        F: FnMut(String, Command) -> Fut,
        Fut: std::future::Future<Output = KernelAck>,
    {
        let records = {
            let mut state = self.state.lock_unpoisoned();
            state.delivered = true;
            std::mem::take(&mut state.records)
        };
        for (source, text, meta) in records {
            let id = format!("workflow-turn-{}", rust_cli_platform::ids::uuid_v4());
            match send_command(id, Command::RecordWorkflowTurn { text, source, meta }).await {
                KernelAck::Accepted { .. } | KernelAck::Duplicate => {}
                KernelAck::Rejected { reason } => tracing::warn!(
                    event = "workflow.run.turn.rejected",
                    source = source.as_str(),
                    %reason,
                    "the session did not accept a workflow control record"
                ),
            }
        }
    }
}

impl WorkflowTurnSink for ParentTurns {
    fn activate(&self) -> bool {
        self.gates.activate(&self.session)
    }

    /// Fork (9.63): the settings turn carries its `workflowLaunch` metadata, so its rows draw the settings row.
    fn settings_turn(&self, turn: SettingsTurn) {
        let meta = turn.workflow_launch_meta();
        self.push(WorkflowRecordSource::Settings, turn.text, Some(meta));
    }

    /// A hub launch's record carries no metadata yet (divergence 916).
    fn launch_turn(&self, turn: LaunchTurn) {
        self.push(WorkflowRecordSource::Launch, turn.text, None);
    }
}

/// The `session_busy` message. It holds when the session is busy and when its busy state is unknown (the actor gave no
/// answer), since both refuse the start with the same reason code (divergence 803, 9.54).
const BUSY_MESSAGE: &str = "the session has work in flight or its busy state is unknown";

/// Node `hasActiveOrQueuedTurnWork` at the point of start (divergence 765, 9.54): the session actor answers, because the
/// protocol projection is updated only when the pump applies events and can lag an input the actor already accepted. The
/// actor's answer counts its jobs too (goal verification, a rewind), as Node's does through `activeForegroundExecution`.
/// A first submission still preparing is busy. An answer the actor cannot give is busy, and is logged: the start fails closed.
///
/// Read once, before the run service is asked. Node checks once too, and its awaits between the check and the submit
/// are the same window here (divergence 802, shared with Node).
async fn busy(live: &Bridged<Live>) -> bool {
    let answer = match live.handle.busy().await {
        Ok(busy) => Some(busy),
        Err(error) => {
            tracing::warn!(
                event = "workflow.run.start.busy_unknown",
                session = %live.handle.id().as_str(),
                error = %error,
                "the session did not answer its busy state; the start is refused as busy"
            );
            None
        }
    };
    busy_from(answer, live.sink.preparing())
}

/// The decision of [`busy`]: the actor's answer, or busy when it gave none, and busy while a first submission is preparing.
pub(crate) fn busy_from(actor_busy: Option<bool>, preparing: bool) -> bool {
    preparing || actor_busy.unwrap_or(true)
}

/// Node's `fault.command.capabilityUnsupported` ack, for a session without the capability.
fn unsupported(envelope: &Envelope, revision: u64, capability: &str, session: &str) -> Ack {
    Ack::refused(
        &envelope.command_id,
        Status::Failed,
        CAPABILITY_UNSUPPORTED,
        format!(
            "capability not supported by this session runtime: {capability} (session {session})"
        ),
        revision,
    )
}

/// The gate and the run sessions a control needs. `None` is the capability-unsupported answer.
fn sessions(
    server: &Server,
    session: &SessionId,
) -> Option<Arc<dyn rust_cli_kernel_api::workflow_run::DynamicWorkflowRunSessions>> {
    let gate = server.dynamic_workflow_gate(session)?;
    if !gate.enabled {
        return None;
    }
    server.context.dynamic_workflow_runs().cloned()
}

/// Node `startSavedWorkflowRun`'s payload (zod `startSavedWorkflowPayloadSchema`, strict): `name` is a non-empty string,
/// `scope` is `project` or `global` when present (`null` is not a scope), `args` is an object when present, and no other
/// key is allowed.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartPayload {
    name: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    args: Option<Map<String, Value>>,
}

fn start_payload(value: &Value) -> Option<StartPayload> {
    let object = value.as_object()?;
    if object
        .get("scope")
        .is_some_and(|scope| !matches!(scope.as_str(), Some("project" | "global")))
    {
        return None;
    }
    if object.get("args").is_some_and(|args| !args.is_object()) {
        return None;
    }
    serde_json::from_value::<StartPayload>(value.clone())
        .ok()
        .filter(|payload| !payload.name.is_empty())
}

/// Node's `startSavedWorkflowRejected` reason and message for a refused start.
pub(crate) fn start_refusal_code(refusal: &StartRefusal) -> (&'static str, String) {
    match refusal {
        StartRefusal::InvalidName { message } => ("invalid_name", message.clone()),
        StartRefusal::NotFound { message } => ("not_found", message.clone()),
        StartRefusal::InvalidArgs { message } => ("invalid_args", message.clone()),
        StartRefusal::CompileFailed { message } => ("compile_failed", message.clone()),
        StartRefusal::StartFailed { message } => ("start_failed", message.clone()),
    }
}

/// Node `startSavedWorkflow` (`interaction-background.ts`): the hub's direct start. Success returns `{type, runId,
/// toolCallId}` in the ack's result; a refusal is a `failed` ack with the reason code.
pub(crate) async fn start_saved(
    server: &Server,
    live: &Arc<Bridged<Live>>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let session = live.handle.id().clone();
    let Some(runs) = sessions(server, &session) else {
        return unsupported(envelope, revision, "startSavedWorkflow", session.as_str());
    };
    let Some(payload) = start_payload(&envelope.payload) else {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            "Invalid startSavedWorkflow payload",
            revision,
        );
    };
    if busy(live).await {
        return refused_start(envelope, revision, "session_busy", BUSY_MESSAGE);
    }
    let port = runs.for_session(&session);
    let request = StartSavedRequest {
        cwd: live.sink.cwd(),
        name: payload.name,
        scope: payload.scope,
        args: payload.args,
    };
    let parent = Arc::new(ParentTurns::new(server, session.clone()));
    let answer = port.start_saved(request, parent.clone()).await;
    parent.deliver(live.handle.as_ref()).await;
    match answer {
        Ok(StartSavedOutcome::Started {
            run_id,
            tool_call_id,
        }) => Ack::accepted(
            &envelope.command_id,
            revision,
            Some(json!({
                "type": "startSavedWorkflow",
                "runId": run_id.as_str(),
                "toolCallId": tool_call_id,
            })),
        ),
        Ok(StartSavedOutcome::Refused(refusal)) => {
            let (reason, message) = start_refusal_code(&refusal);
            refused_start(envelope, revision, reason, &message)
        }
        Err(error) if error.is_unsupported() => {
            unsupported(envelope, revision, "startSavedWorkflow", session.as_str())
        }
        Err(error) => refused_start(envelope, revision, "start_failed", &error.message),
    }
}

fn refused_start(envelope: &Envelope, revision: u64, reason: &str, message: &str) -> Ack {
    Ack::refused(
        &envelope.command_id,
        Status::Failed,
        &format!("{START_REJECTED}{reason}"),
        message,
        revision,
    )
}

/// The three keys the `amendWorkflowRunSettings` payload may carry (Node's strict schema).
const SETTINGS_KEYS: [&str; 3] = ["workId", "subagentModel", "maxConcurrency"];

/// One of the two three-state settings (Node's `maxConcurrency` and `subagentModel`): absent keeps the run's, `null` is the
/// default, a value sets it. A value of the wrong type is an invalid payload.
fn three_state<T>(
    object: &Map<String, Value>,
    key: &str,
    read: impl FnOnce(&Value) -> Option<T>,
) -> Result<Option<Option<T>>, ()> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(value) => read(value).map(|value| Some(Some(value))).ok_or(()),
    }
}

/// The `amendWorkflowRunSettings` payload: `workId` is the run id; the two settings are three-state. A key outside the three
/// is refused, so a misspelt setting is not dropped into a no-change request.
pub(crate) fn settings_request(payload: &Value) -> Option<SettingsRequest> {
    let object = payload.as_object()?;
    if object
        .keys()
        .any(|key| !SETTINGS_KEYS.contains(&key.as_str()))
    {
        return None;
    }
    let work_id = object.get("workId")?.as_str()?;
    if work_id.is_empty() {
        return None;
    }
    let subagent_model = three_state(object, "subagentModel", |value| {
        value
            .as_str()
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    })
    .ok()?;
    // Node's schema has no upper bound on the limit (the shared `maxConcurrency` is `int().min(1)`), so none is applied here.
    let max_concurrency = three_state(object, "maxConcurrency", |value| {
        value
            .as_f64()
            .filter(|number| number.fract() == 0.0 && *number >= 1.0)
    })
    .ok()?;
    Some(SettingsRequest {
        run_id: WorkflowRunId::new(work_id),
        subagent_model,
        max_concurrency,
    })
}

/// Node's `workflowRunSettingsRejected` reason and message for a refused change (9.50, divergence 674).
pub(crate) fn settings_refusal_code(refusal: &SettingsRefusal) -> (&'static str, String) {
    match refusal {
        SettingsRefusal::NotFound => ("not_found", "the workflow run was not found".to_owned()),
        SettingsRefusal::NotConfigurable => (
            "not_configurable",
            "the workflow run cannot be configured in its current state".to_owned(),
        ),
        SettingsRefusal::Unchanged => (
            "unchanged",
            "the workflow run already has these settings".to_owned(),
        ),
        SettingsRefusal::ScriptMissing => (
            "script_missing",
            "the workflow run has no script to start again".to_owned(),
        ),
        SettingsRefusal::ModelUnavailable { message } => ("model_unavailable", message.clone()),
        SettingsRefusal::MissingBoundaries => (
            "missing_boundaries",
            "the workflow run cannot be started again: its completed work is incomplete".to_owned(),
        ),
        SettingsRefusal::StartFailed { message } => ("start_failed", message.clone()),
    }
}

/// Node `amendWorkflowRunSettings` (`interaction-background.ts`): the GUI "Configure". Success returns `{type, runId,
/// toolCallId, supersededRunId?}`; a refusal is a `failed` ack with the reason code and the message.
///
/// Unlike the start, this route has no busy refusal: Node's `amendWorkflowRunSettings` does not check
/// `hasActiveOrQueuedTurnWork` (checked against `dynamic-workflow-run-settings.ts`), so none is made here (divergence 765).
pub(crate) async fn amend_settings(
    server: &Server,
    live: &Arc<Bridged<Live>>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let session = live.handle.id().clone();
    let Some(runs) = sessions(server, &session) else {
        return unsupported(
            envelope,
            revision,
            "amendWorkflowRunSettings",
            session.as_str(),
        );
    };
    let Some(request) = settings_request(&envelope.payload) else {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            "Invalid amendWorkflowRunSettings payload",
            revision,
        );
    };
    let port = runs.for_session(&session);
    let parent = Arc::new(ParentTurns::new(server, session.clone()));
    let answer = port.amend_settings(request, parent.clone()).await;
    parent.deliver(live.handle.as_ref()).await;
    match answer {
        Ok(SettingsOutcome::Retuned {
            run_id,
            tool_call_id,
        }) => Ack::accepted(
            &envelope.command_id,
            revision,
            Some(json!({
                "type": "amendWorkflowRunSettings",
                "runId": run_id.as_str(),
                "toolCallId": tool_call_id,
            })),
        ),
        Ok(SettingsOutcome::Amended {
            run_id,
            tool_call_id,
            superseded_run_id,
        }) => {
            let mut result = json!({
                "type": "amendWorkflowRunSettings",
                "runId": run_id.as_str(),
                "toolCallId": tool_call_id,
            });
            if let Some(superseded) = superseded_run_id {
                result["supersededRunId"] = json!(superseded.as_str());
            }
            Ack::accepted(&envelope.command_id, revision, Some(result))
        }
        Ok(SettingsOutcome::Refused(refusal)) => {
            let (reason, message) = settings_refusal_code(&refusal);
            refused_settings(envelope, revision, reason, &message)
        }
        Err(error) if error.is_unsupported() => unsupported(
            envelope,
            revision,
            "amendWorkflowRunSettings",
            session.as_str(),
        ),
        Err(error) => refused_settings(envelope, revision, "start_failed", &error.message),
    }
}

fn refused_settings(envelope: &Envelope, revision: u64, reason: &str, message: &str) -> Ack {
    Ack::refused(
        &envelope.command_id,
        Status::Failed,
        &format!("{SETTINGS_REJECTED}{reason}"),
        message,
        revision,
    )
}

#[cfg(test)]
#[path = "workflow_run_commands_tests.rs"]
mod tests;
