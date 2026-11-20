//! Fork: the v4 run controls `startSavedWorkflow` and `amendWorkflowRunSettings` (specs/fork-rust-workflow-engine.md, 9.53,
//! W9a; Node `interaction-background.ts` and `zcode-protocol-v4/commands`).
//!
//! The session gate comes first: a session whose dynamic workflows are off, or whose run sessions are not installed, answers
//! `fault.command.capabilityUnsupported`, as Node answers a missing capability. Business refusals are `failed` acks with
//! Node's reason code and message, and the run service decides them (9.50, 9.53). The parent's side is [`ParentTurns`]: it
//! activates the workflow tools and records the launch and settings turns as control-only records through the session's
//! command path (`Command::RecordWorkflowTurn`).

use std::sync::Arc;

use rust_cli_kernel_api::ids::{SessionId, WorkflowRunId};
use rust_cli_kernel_api::session_api::Command;
use rust_cli_kernel_api::workflow_run::{
    LaunchTurn, SettingsOutcome, SettingsRefusal, SettingsRequest, SettingsTurn, StartRefusal,
    StartSavedOutcome, StartSavedRequest, WorkflowTurnSink,
};
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::commands::send;
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::projection::state::Phase;
use crate::server::Server;

/// Node `CAPABILITY_UNSUPPORTED` (`V4CapabilityUnsupportedError`).
const CAPABILITY_UNSUPPORTED: &str = "fault.command.capabilityUnsupported";
/// Node `SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX`.
const START_REJECTED: &str = "fault.command.savedWorkflowStartRejected.";
/// Node `WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX`.
const SETTINGS_REJECTED: &str = "fault.command.workflowRunSettingsRejected.";

/// The parent's side of a run's turns: activation, and the control-only records (9.53). It holds the session's handle, so
/// each record is a command to the session the run belongs to.
pub(crate) struct ParentTurns {
    handle: Arc<dyn rust_cli_kernel_api::session_api::SessionHandle>,
    live: Arc<Bridged<Live>>,
    gates: Arc<rust_cli_kernel_api::dynamic_workflow::SessionGates>,
}

impl ParentTurns {
    fn record(&self, text: String, source: &str) {
        let handle = self.handle.clone();
        let source = source.to_owned();
        let id = format!("workflow-turn-{}", rust_cli_platform::ids::uuid_v4());
        self.live.run(Box::pin(async move {
            let _ = send(
                handle.as_ref(),
                &id,
                Command::RecordWorkflowTurn { text, source },
            )
            .await;
        }));
    }
}

impl WorkflowTurnSink for ParentTurns {
    fn activate(&self, parent: &SessionId) {
        let _ = self.gates.activate(parent);
    }

    fn settings_turn(&self, _parent: &SessionId, turn: SettingsTurn) {
        self.record(turn.text, "workflow_settings");
    }

    fn launch_turn(&self, _parent: &SessionId, turn: LaunchTurn) {
        self.record(turn.text, "workflow_launch");
    }
}

/// The reason a session cannot run a control now, as the session's own state says (Node `hasActiveOrQueuedTurnWork`).
fn busy(live: &Bridged<Live>) -> bool {
    let (phase, _) = live.sink.status();
    phase == Phase::Running || live.sink.has_queue()
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

fn parent_turns(live: &Arc<Bridged<Live>>, server: &Server) -> ParentTurns {
    ParentTurns {
        handle: live.handle.clone(),
        live: live.clone(),
        gates: server.context.dynamic_workflow_gates().clone(),
    }
}

/// The `startSavedWorkflow` payload (Node `startSavedWorkflow` schema, strict on the names the command knows).
#[derive(Deserialize)]
struct StartPayload {
    name: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    args: Option<Map<String, Value>>,
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
    let payload: StartPayload =
        match serde_json::from_value::<StartPayload>(envelope.payload.clone()) {
            Ok(payload) if !payload.name.is_empty() => payload,
            _ => {
                return Ack::refused(
                    &envelope.command_id,
                    Status::Rejected,
                    "proto.invalidPayload",
                    "Invalid startSavedWorkflow payload",
                    revision,
                );
            }
        };
    if busy(live) {
        return refused_start(
            envelope,
            revision,
            "session_busy",
            "the session has work in flight",
        );
    }
    let port = runs.for_session(&session);
    let request = StartSavedRequest {
        cwd: live.sink.cwd(),
        name: payload.name,
        scope: payload.scope,
        args: payload.args,
    };
    let sink = Arc::new(parent_turns(live, server));
    match port.start_saved(request, sink).await {
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

/// The `amendWorkflowRunSettings` payload: `workId` is the run id; the two settings are three-state.
pub(crate) fn settings_request(payload: &Value) -> Option<SettingsRequest> {
    let object = payload.as_object()?;
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
    let sink = Arc::new(parent_turns(live, server));
    match port.amend_settings(request, sink).await {
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
