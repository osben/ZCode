//! Run events (Node `types.ts` `RunEvent`): the lifecycle, asks and phase markers W5a emits. Holes,
//! artifacts and reports are not here yet (spec 9.3).
//!
//! `to_json` builds each object in the key order Node's object literals use, so the payload text
//! (`JSON.stringify` of the event) is byte-identical. Optional keys are omitted when absent, as Node's
//! conditional spreads do. The birth-phase fields (`phase`, `actor_phase`) are set by the engine's
//! stamping step, which Node appends after the literal keys, so they are written last.
use crate::model::{Caps, NodeKind, Ref, RunStatus, StopReason, Violation, js_number};
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

/// Outcome of a settled node (Node `NodeOutcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeOutcome {
    Ok,
    Failed,
    Cancelled,
}

impl NodeOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// The birth facts a cached ask settlement repeats (Node `CachedAskFacts`): `kind` is always `ask`.
/// `source_session_id` is set when the answer was read from a predecessor transcript (Node `sourceSessionId`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskFacts {
    pub actor: Ref,
    pub actor_seq: u64,
    pub instructions_head: Option<String>,
    pub source_session_id: Option<String>,
}

/// Why the amend import cache closed (Node `ImportCloseCause`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportCloseCause {
    /// A subagent in an active ask is about to run a mutating tool.
    MutatingTool,
    /// A `world.run` is about to execute live.
    WorldRun,
}

impl ImportCloseCause {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MutatingTool => "mutating-tool",
            Self::WorldRun => "world-run",
        }
    }
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
    /// Node `actor-created`. `name` is the argument as given, `persona` the normalized spec.
    ActorCreated {
        actor: Ref,
        name: Option<String>,
        persona: Value,
        phase: Option<String>,
    },
    /// Node `node-queued` for an ask.
    NodeQueued {
        instance: Ref,
        actor: Ref,
        actor_seq: u64,
        instructions_head: Option<String>,
        phase: Option<String>,
    },
    /// Node `node-queued` for a world node (`world-read` or `world-run`): no actor, so the birth phase is
    /// the only extra fact.
    WorldQueued {
        instance: Ref,
        kind: NodeKind,
        phase: Option<String>,
    },
    /// Node `node-dispatched` for a world node.
    WorldDispatched {
        instance: Ref,
    },
    /// Node `import-cache-closed`: the first write of an amended run. Only an amended run emits it.
    ImportCacheClosed {
        instance: Ref,
        cause: ImportCloseCause,
        actor_name: Option<String>,
    },
    /// Node `node-dispatched` for an ask: repeats the birth facts (see types.ts).
    NodeDispatched {
        instance: Ref,
        actor: Ref,
        actor_name: Option<String>,
        actor_persona_model: Option<String>,
        instructions_head: Option<String>,
        phase: Option<String>,
        actor_phase: Option<String>,
    },
    NodeRepairing {
        instance: Ref,
        attempt: u64,
        violations: Vec<Violation>,
    },
    NodeNudged {
        instance: Ref,
    },
    /// Node `node-settled`. A cached settlement sets `cached` and repeats the facts; a live one does not.
    NodeSettled {
        instance: Ref,
        outcome: NodeOutcome,
        cached: bool,
        /// `WorkflowErrorJson` in its journal shape.
        error: Option<Value>,
        facts: Option<AskFacts>,
        phase: Option<String>,
    },
    /// Node `phase-entered`: the nth entry into a phase name.
    PhaseEntered {
        name: String,
        ordinal: u64,
    },
    /// Node `hole-reached`: the script parked at a hole. `phase` is the birth phase, stamped by the engine.
    HoleReached {
        instance: Ref,
        name: String,
        prompt: Option<String>,
        phase: Option<String>,
    },
    /// Node `hole-filled`: the effective script is written and the parked branches resumed.
    HoleFilled {
        site_id: String,
        filled_at: f64,
        filled_by: Option<String>,
        phase_names: Vec<String>,
        holes: Option<Vec<u64>>,
        script_path: Option<String>,
    },
    /// Node `report`: one published intermediate result. `artifact_id` is the preset it also feeds.
    Report {
        instance: Ref,
        item: Value,
        artifact_id: Option<String>,
    },
    /// Node `artifact-published`: a content version, or a persisted preset declaration. The record is kept in
    /// the shape the driver (or the declaration) gave it, so its key order is the one Node stores.
    ArtifactPublished {
        instance: Ref,
        artifact: Value,
    },
    /// Node `artifact-failed`: a content publication failed. Artifact sites are not graph nodes, so this is not
    /// a `node-settled`.
    ArtifactFailed {
        instance: Ref,
        id: String,
        op: String,
        error: Value,
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
            Self::ActorCreated {
                actor,
                name,
                persona,
                phase,
            } => {
                put_type(&mut map, "actor-created");
                map.insert("actor".into(), actor.to_json());
                put_text(&mut map, "name", name);
                map.insert("persona".into(), persona.clone());
                put_text(&mut map, "phaseName", phase);
            }
            Self::NodeQueued {
                instance,
                actor,
                actor_seq,
                instructions_head,
                phase,
            } => {
                put_type(&mut map, "node-queued");
                map.insert("instance".into(), instance.to_json());
                map.insert("kind".into(), Value::String("ask".into()));
                map.insert("actor".into(), actor.to_json());
                map.insert("actorSeq".into(), Value::from(*actor_seq));
                put_text(&mut map, "instructionsHead", instructions_head);
                put_text(&mut map, "phaseName", phase);
            }
            Self::NodeDispatched {
                instance,
                actor,
                actor_name,
                actor_persona_model,
                instructions_head,
                phase,
                actor_phase,
            } => {
                put_type(&mut map, "node-dispatched");
                map.insert("instance".into(), instance.to_json());
                map.insert("kind".into(), Value::String("ask".into()));
                map.insert("actor".into(), actor.to_json());
                put_text(&mut map, "actorName", actor_name);
                put_text(&mut map, "actorPersonaModel", actor_persona_model);
                put_text(&mut map, "instructionsHead", instructions_head);
                put_text(&mut map, "phaseName", phase);
                put_text(&mut map, "actorPhaseName", actor_phase);
            }
            Self::WorldQueued {
                instance,
                kind,
                phase,
            } => {
                put_type(&mut map, "node-queued");
                map.insert("instance".into(), instance.to_json());
                map.insert("kind".into(), Value::String(kind.as_str().into()));
                put_text(&mut map, "phaseName", phase);
            }
            Self::WorldDispatched { instance } => {
                put_type(&mut map, "node-dispatched");
                map.insert("instance".into(), instance.to_json());
            }
            Self::ImportCacheClosed {
                instance,
                cause,
                actor_name,
            } => {
                put_type(&mut map, "import-cache-closed");
                map.insert("instance".into(), instance.to_json());
                map.insert("cause".into(), Value::String(cause.as_str().into()));
                put_text(&mut map, "actorName", actor_name);
            }
            Self::NodeRepairing {
                instance,
                attempt,
                violations,
            } => {
                put_type(&mut map, "node-repairing");
                map.insert("instance".into(), instance.to_json());
                map.insert("attempt".into(), Value::from(*attempt));
                map.insert(
                    "violations".into(),
                    Value::Array(violations.iter().map(Violation::to_json).collect()),
                );
            }
            Self::NodeNudged { instance } => {
                put_type(&mut map, "node-nudged");
                map.insert("instance".into(), instance.to_json());
            }
            Self::NodeSettled {
                instance,
                outcome,
                cached,
                error,
                facts,
                phase,
            } => {
                put_type(&mut map, "node-settled");
                map.insert("instance".into(), instance.to_json());
                map.insert("outcome".into(), Value::String(outcome.as_str().into()));
                if *cached {
                    map.insert("cached".into(), Value::Bool(true));
                }
                put_value(&mut map, "error", error);
                if let Some(facts) = facts {
                    map.insert("kind".into(), Value::String("ask".into()));
                    map.insert("actor".into(), facts.actor.to_json());
                    map.insert("actorSeq".into(), Value::from(facts.actor_seq));
                    put_text(&mut map, "instructionsHead", &facts.instructions_head);
                    put_text(&mut map, "sourceSessionId", &facts.source_session_id);
                }
                put_text(&mut map, "phaseName", phase);
            }
            Self::PhaseEntered { name, ordinal } => {
                put_type(&mut map, "phase-entered");
                map.insert("name".into(), Value::String(name.clone()));
                map.insert("ordinal".into(), Value::from(*ordinal));
            }
            Self::HoleReached {
                instance,
                name,
                prompt,
                phase,
            } => {
                put_type(&mut map, "hole-reached");
                map.insert("instance".into(), instance.to_json());
                map.insert("name".into(), Value::String(name.clone()));
                put_text(&mut map, "prompt", prompt);
                put_text(&mut map, "phaseName", phase);
            }
            Self::HoleFilled {
                site_id,
                filled_at,
                filled_by,
                phase_names,
                holes,
                script_path,
            } => {
                put_type(&mut map, "hole-filled");
                map.insert("siteId".into(), Value::String(site_id.clone()));
                map.insert("filledAt".into(), js_number(*filled_at));
                put_text(&mut map, "filledBy", filled_by);
                map.insert(
                    "phaseNames".into(),
                    Value::Array(phase_names.iter().cloned().map(Value::String).collect()),
                );
                if let Some(holes) = holes {
                    map.insert(
                        "holes".into(),
                        Value::Array(holes.iter().map(|index| Value::from(*index)).collect()),
                    );
                }
                put_text(&mut map, "scriptPath", script_path);
            }
            Self::Report {
                instance,
                item,
                artifact_id,
            } => {
                put_type(&mut map, "report");
                map.insert("instance".into(), instance.to_json());
                map.insert("item".into(), item.clone());
                put_text(&mut map, "artifactId", artifact_id);
            }
            Self::ArtifactPublished { instance, artifact } => {
                put_type(&mut map, "artifact-published");
                map.insert("instance".into(), instance.to_json());
                map.insert("artifact".into(), artifact.clone());
            }
            Self::ArtifactFailed {
                instance,
                id,
                op,
                error,
            } => {
                put_type(&mut map, "artifact-failed");
                map.insert("instance".into(), instance.to_json());
                map.insert("id".into(), Value::String(id.clone()));
                map.insert("op".into(), Value::String(op.clone()));
                map.insert("error".into(), error.clone());
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

    #[test]
    fn cached_settlement_repeats_the_facts_and_takes_the_phase_last() {
        let event = RunEvent::NodeSettled {
            instance: Ref::new("ask#1", 2),
            outcome: NodeOutcome::Failed,
            cached: true,
            error: Some(json!({"code": "ResultNotSubmitted", "message": "m"})),
            facts: Some(AskFacts {
                actor: Ref::new("actor#1", 1),
                actor_seq: 3,
                instructions_head: Some("go".into()),
                source_session_id: None,
            }),
            phase: Some("plan".into()),
        };
        assert_eq!(
            event.payload_json(),
            r#"{"type":"node-settled","instance":{"siteId":"ask#1","ordinal":2},"outcome":"failed","cached":true,"error":{"code":"ResultNotSubmitted","message":"m"},"kind":"ask","actor":{"siteId":"actor#1","ordinal":1},"actorSeq":3,"instructionsHead":"go","phaseName":"plan"}"#
        );
    }

    #[test]
    fn a_live_settlement_has_no_cached_key() {
        let event = RunEvent::NodeSettled {
            instance: Ref::new("ask#1", 1),
            outcome: NodeOutcome::Ok,
            cached: false,
            error: None,
            facts: None,
            phase: None,
        };
        assert_eq!(
            event.payload_json(),
            r#"{"type":"node-settled","instance":{"siteId":"ask#1","ordinal":1},"outcome":"ok"}"#
        );
    }
}
