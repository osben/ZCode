//! Run events (Node `types.ts` `RunEvent`), the run-lifecycle subset W5a emits.
//!
//! `to_json` builds the object in the same key order Node's object literals use, so the payload text
//! (`JSON.stringify` of the event) is byte-identical. Optional keys are omitted when absent, as Node's
//! conditional spreads do. Asks, holes, artifacts and reports are not here yet (see spec 9.2).
use crate::model::{Caps, RunStatus, StopReason, js_number};
use rust_cli_base::js::json::stringify;
use serde_json::{Map, Value};

/// Host metadata for the run invocation (Node `RunLaunchConfig`, transcribed as `run-launched`).
/// The engine never reads these fields; the lists are kept as the JSON the host gave.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LaunchFields {
    pub input_id: String,
    pub tool_call_id: Option<String>,
    pub parent_session_id: Option<String>,
    pub phase_names: Option<Value>,
    pub subagent_model: Option<String>,
    pub subagent_permission_mode: Option<String>,
    pub model_bindings: Option<Value>,
    pub script_path: Option<String>,
    pub phase_alongside: Option<Value>,
    pub holes: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    RunStarted {
        run_id: String,
        caps: Caps,
    },
    RunLaunched(Box<LaunchFields>),
    RunCapsChanged {
        run_id: String,
        caps: Caps,
        previous: Caps,
    },
    UsageUpdated {
        spent_tokens: f64,
    },
    Log {
        message: String,
    },
    RunSettled {
        status: RunStatus,
        stop_reason: Option<StopReason>,
        superseded_by: Option<String>,
        /// `WorkflowErrorJson`, already in its journal shape.
        error: Option<Value>,
    },
}

impl RunEvent {
    /// The event as a JSON object in Node's key order.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        match self {
            Self::RunStarted { run_id, caps } => {
                put_type(&mut map, "run-started");
                map.insert("runId".into(), Value::String(run_id.clone()));
                map.insert("caps".into(), caps.to_json());
            }
            Self::RunLaunched(launch) => {
                put_type(&mut map, "run-launched");
                map.insert("inputId".into(), Value::String(launch.input_id.clone()));
                put_text(&mut map, "toolCallId", &launch.tool_call_id);
                put_text(&mut map, "parentSessionId", &launch.parent_session_id);
                put_value(&mut map, "phaseNames", &launch.phase_names);
                put_text(&mut map, "subagentModel", &launch.subagent_model);
                put_text(
                    &mut map,
                    "subagentPermissionMode",
                    &launch.subagent_permission_mode,
                );
                put_value(&mut map, "modelBindings", &launch.model_bindings);
                put_text(&mut map, "scriptPath", &launch.script_path);
                put_value(&mut map, "phaseAlongside", &launch.phase_alongside);
                put_value(&mut map, "holes", &launch.holes);
            }
            Self::RunCapsChanged {
                run_id,
                caps,
                previous,
            } => {
                put_type(&mut map, "run-caps-changed");
                map.insert("runId".into(), Value::String(run_id.clone()));
                map.insert("caps".into(), caps.to_json());
                map.insert("previous".into(), previous.to_json());
            }
            Self::UsageUpdated { spent_tokens } => {
                put_type(&mut map, "usage-updated");
                map.insert("spentTokens".into(), js_number(*spent_tokens));
            }
            Self::Log { message } => {
                put_type(&mut map, "log");
                map.insert("message".into(), Value::String(message.clone()));
            }
            Self::RunSettled {
                status,
                stop_reason,
                superseded_by,
                error,
            } => {
                put_type(&mut map, "run-settled");
                map.insert("status".into(), Value::String(status.as_str().into()));
                if let Some(reason) = stop_reason {
                    map.insert("stopReason".into(), Value::String(reason.as_str().into()));
                }
                put_text(&mut map, "supersededBy", superseded_by);
                put_value(&mut map, "error", error);
            }
        }
        Value::Object(map)
    }

    /// The payload text the journal stores: `JSON.stringify` of the event.
    pub fn payload_json(&self) -> String {
        stringify(&self.to_json())
    }
}

fn put_type(map: &mut Map<String, Value>, kind: &str) {
    map.insert("type".into(), Value::String(kind.into()));
}

fn put_text(map: &mut Map<String, Value>, key: &str, value: &Option<String>) {
    if let Some(text) = value {
        map.insert(key.into(), Value::String(text.clone()));
    }
}

fn put_value(map: &mut Map<String, Value>, key: &str, value: &Option<Value>) {
    if let Some(json) = value {
        map.insert(key.into(), json.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn run_started_text_is_key_ordered_like_node() {
        let event = RunEvent::RunStarted {
            run_id: "r1".into(),
            caps: Caps {
                max_concurrency: 4.0,
            },
        };
        assert_eq!(
            event.payload_json(),
            r#"{"type":"run-started","runId":"r1","caps":{"maxConcurrency":4}}"#
        );
    }

    #[test]
    fn run_settled_omits_absent_keys() {
        let event = RunEvent::RunSettled {
            status: RunStatus::Errored,
            stop_reason: None,
            superseded_by: None,
            error: Some(json!({"code": "DriverError", "message": "boom"})),
        };
        assert_eq!(
            event.payload_json(),
            r#"{"type":"run-settled","status":"errored","error":{"code":"DriverError","message":"boom"}}"#
        );
    }
}
