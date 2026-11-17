//! Port of Node's `workflowRuns` reducer (`packages/shared/src/zcode-protocol-v4/workflow-runs-*.ts`).
//!
//! One dwf progress event goes in; the next `workflowRuns` state (or `None` for a semantic no-op)
//! comes out. The module is pure: no clock, no randomness, no I/O. Its output is compared byte for
//! byte with Node's by the goldens in `fixtures/workflow-runs/goldens.json` (see the spec, section
//! 9.2). Nothing calls it yet: the gate stays off (W3).

pub mod caps;
pub mod delta;
pub mod eviction;
pub mod js;
pub mod projection;
pub mod replay;
pub mod tables;

#[cfg(test)]
mod tests;

use serde_json::{Value, json};

use self::js::{Obj, canonical, instance_ref, non_empty, number_value, plain};

/// Top-level run keys in schema declaration order (`workflowRunSchema`). `canonical` reorders by it.
pub const RUN_KEY_ORDER: &[&str] = &[
    "runId",
    "toolCallId",
    "status",
    "stopReason",
    "resumedFrom",
    "supersededBy",
    "usage",
    "error",
    "resumable",
    "resultPreview",
    "actors",
    "nodes",
    "reports",
    "pendingQuestions",
    "concurrency",
    "concurrencyCeiling",
    "subagentModel",
    "artifacts",
    "phases",
    "currentPhase",
    "phaseNames",
    "phaseAlongside",
    "phaseHoles",
    "holes",
    "unlistedByPhase",
    "truncated",
    "lastEventSequence",
];

/// The limits of `WORKFLOW_RUNS_LIMITS` (production values) that the reducer reads. The three entry
/// limits are the injection point for tests (`WorkflowRunEntryLimits`); everything else is fixed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limits {
    pub max_runs: usize,
    pub max_actors: usize,
    pub max_nodes: usize,
    pub max_total_entries: usize,
    pub max_reports: usize,
    pub max_report_preview_length: usize,
    pub max_error_length: usize,
    pub max_pending_questions: usize,
    pub max_question_length: usize,
    pub max_concurrency_key_length: usize,
    pub max_subagent_model_length: usize,
    pub max_session_id_length: usize,
    pub max_concurrency_ceiling: f64,
    pub max_actor_name_length: usize,
    pub max_artifacts: usize,
    pub max_phases: usize,
    pub max_phase_name_length: usize,
    pub max_holes: usize,
    pub max_hole_type_length: usize,
    pub max_hole_prompt_length: usize,
    pub max_instructions_head_length: usize,
    pub max_last_tool_name_length: usize,
    pub max_last_tool_target_length: usize,
    pub max_artifact_id_length: usize,
    pub max_artifact_title_length: usize,
    pub max_artifact_versions: u64,
}

/// Production limits (`WORKFLOW_RUNS_LIMITS`, `WORKFLOW_ARTIFACT_LIMITS`).
pub const PRODUCTION: Limits = Limits {
    max_runs: 8,
    max_actors: 1024,
    max_nodes: 1024,
    max_total_entries: 6144,
    max_reports: 64,
    max_report_preview_length: 2048,
    max_error_length: 2048,
    max_pending_questions: 32,
    max_question_length: 2048,
    max_concurrency_key_length: 256,
    max_subagent_model_length: 256,
    max_session_id_length: 256,
    max_concurrency_ceiling: 1024.0,
    max_actor_name_length: 128,
    max_artifacts: 32,
    max_phases: 32,
    max_phase_name_length: 128,
    max_holes: 32,
    max_hole_type_length: 128,
    max_hole_prompt_length: 500,
    max_instructions_head_length: 240,
    max_last_tool_name_length: 64,
    max_last_tool_target_length: 120,
    max_artifact_id_length: 64,
    max_artifact_title_length: 120,
    max_artifact_versions: 16,
};

impl Limits {
    /// Production limits with the three entry limits replaced (the test injection point).
    pub fn with_entry_limits(
        self,
        max_actors: usize,
        max_nodes: usize,
        max_phases: usize,
    ) -> Limits {
        Limits {
            max_actors,
            max_nodes,
            max_phases,
            ..self
        }
    }
}

/// `{revision, runs}`: the `workflowRuns` state key.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct State {
    pub revision: u64,
    pub runs: Vec<Obj>,
}

impl State {
    pub fn to_value(&self) -> Value {
        json!({
            "revision": self.revision,
            "runs": self.runs.iter().map(|run| Value::Object(run.clone())).collect::<Vec<_>>(),
        })
    }

    pub fn from_value(value: &Value) -> Option<State> {
        let record = plain(Some(value))?;
        let revision = record.get("revision")?.as_u64()?;
        let runs = record
            .get("runs")?
            .as_array()?
            .iter()
            .map(|run| plain(Some(run)).cloned())
            .collect::<Option<Vec<_>>>()?;
        Some(State { revision, runs })
    }
}

/// One progress envelope, `WorkflowRunProgressEnvelope` (shared). `actor_session_id` and `tool_call_id`
/// are the derived fields the run service adds outside the payload.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Envelope {
    pub run_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub sequence: Option<f64>,
    pub event_type: Option<String>,
    pub payload: Option<Obj>,
    pub actor_session_id: Option<String>,
}

impl Envelope {
    /// Reads an envelope from its JSON form (the golden fixture and the wire use the same keys).
    pub fn from_value(value: &Value) -> Envelope {
        let record = plain(Some(value)).cloned().unwrap_or_default();
        Envelope {
            run_id: record
                .get("runId")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_call_id: record
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string),
            sequence: js::js_number(record.get("sequence")),
            event_type: record
                .get("eventType")
                .and_then(Value::as_str)
                .map(str::to_string),
            payload: plain(record.get("payload")).cloned(),
            actor_session_id: record
                .get("actorSessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }
}

/// Derived facts passed to one event's reduction (`applyWorkflowRunEvent`'s `derived`).
pub(crate) struct Derived<'a> {
    pub actor_session_id: Option<&'a str>,
    pub tool_call_id: Option<&'a str>,
    pub sequence: f64,
    pub advances_water_mark: bool,
    pub limits: &'a Limits,
}

/// Reduce one progress event. `None` means no semantic change (an invalid event, or a replay whose
/// content is identical). Otherwise the result is the next state with `revision + 1`.
pub fn reduce(prior: Option<&State>, envelope: &Envelope, limits: &Limits) -> Option<State> {
    let run_id = non_empty(
        envelope
            .run_id
            .as_ref()
            .map(|id| Value::String(id.clone()))
            .as_ref(),
    )?;
    let event_type = envelope.event_type.clone()?;
    let sequence = envelope.sequence.unwrap_or(0.0);
    let payload = envelope.payload.clone().unwrap_or_default();

    let prior = prior.cloned().unwrap_or_default();
    let existing_index = prior
        .runs
        .iter()
        .position(|run| run_id_of(run) == Some(run_id.as_str()));
    let base: Obj = match existing_index {
        Some(index) => prior.runs[index].clone(),
        None => {
            let mut fresh = Obj::new();
            fresh.insert("runId".into(), Value::String(run_id.clone()));
            if let Some(tool_call_id) = non_empty(
                envelope
                    .tool_call_id
                    .as_ref()
                    .map(|s| Value::String(s.clone()))
                    .as_ref(),
            ) {
                fresh.insert("toolCallId".into(), Value::String(tool_call_id));
            }
            fresh.insert("status".into(), Value::String("pending".into()));
            fresh.insert("usage".into(), json!({"spentTokens": 0, "nodesUsed": 0}));
            fresh.insert("actors".into(), json!([]));
            fresh.insert("nodes".into(), json!([]));
            fresh.insert("lastEventSequence".into(), number_value(sequence));
            fresh
        }
    };

    let base_sequence = js::js_number(base.get("lastEventSequence")).unwrap_or(0.0);
    let tool_call = envelope.tool_call_id.clone();
    let derived = Derived {
        actor_session_id: envelope.actor_session_id.as_deref(),
        tool_call_id: tool_call.as_deref(),
        // Monotonic: late or replayed events cannot move the high-water mark backward.
        sequence: base_sequence.max(sequence),
        // Counters for rejected instances count only events that advance the mark (caps.rs).
        advances_water_mark: sequence > base_sequence,
        limits,
    };
    let applied = apply_event(base, &event_type, &payload, &derived);
    let next = canonical(applied);

    if let Some(index) = existing_index
        && js::json_equal(
            &Value::Object(prior.runs[index].clone()),
            &Value::Object(next.clone()),
        )
    {
        return None;
    }

    let mut runs = prior.runs.clone();
    match existing_index {
        Some(index) => runs[index] = next,
        None => runs.push(next),
    }
    // Keep the most recent runs (the run-count cut is fixed, not injected).
    if runs.len() > PRODUCTION.max_runs {
        runs.drain(..runs.len() - PRODUCTION.max_runs);
    }
    // Entry budget after the run-count cut, as in Node.
    let runs = eviction::evict_for_entry_budget(runs, &run_id, limits);
    Some(State {
        revision: prior.revision + 1,
        runs,
    })
}

fn run_id_of(run: &Obj) -> Option<&str> {
    run.get("runId")?.as_str()
}

/// `applyWorkflowRunEvent`: per-event dispatch. The `default` arm leaves the run unchanged except for
/// the high-water mark, as Node's `default: return run` does.
fn apply_event(base: Obj, event_type: &str, payload: &Obj, derived: &Derived<'_>) -> Obj {
    let mut run = base;
    if let Some(tool_call_id) = derived.tool_call_id
        && !tool_call_id.is_empty()
        && non_empty(run.get("toolCallId")).is_none()
    {
        run.insert("toolCallId".into(), Value::String(tool_call_id.to_string()));
    }
    run.insert("lastEventSequence".into(), number_value(derived.sequence));

    match event_type {
        "run-started" => tables::reduce_run_started(run, payload, derived),
        "actor-created" => tables::reduce_actor_created(run, payload, derived),
        "node-queued" | "node-dispatched" | "node-executing" | "node-waiting"
        | "node-repairing" | "node-nudged" | "node-settled" => {
            tables::reduce_node_event(run, event_type, payload, derived)
        }
        "node-progress" => match instance_ref(payload.get("instance")) {
            Some(reference) => tables::reduce_node_progress(run, &reference, payload),
            None => run,
        },
        "report" => tables::reduce_report(run, payload, derived),
        "artifact-published" => tables::reduce_artifact_published(run, payload, derived),
        // A failed publication claims no ID, kind or version: explicit no-op.
        "artifact-failed" => run,
        "usage-updated" => match js::js_number(payload.get("spentTokens")) {
            Some(_) => {
                let usage = run
                    .get("usage")
                    .and_then(|u| plain(Some(u)).cloned())
                    .unwrap_or_default();
                let spent = payload.get("spentTokens").cloned().unwrap_or(Value::Null);
                let next_usage = js::spread_set(usage, "spentTokens", spent);
                run.insert("usage".into(), Value::Object(next_usage));
                run
            }
            None => run,
        },
        "escalation-raised" => tables::reduce_escalation_raised(run, payload, derived),
        "escalation-resolved" => match non_empty(payload.get("qid")) {
            Some(qid) => tables::without_pending_questions(run, |pending| {
                pending.get("qid").and_then(Value::as_str) != Some(qid.as_str())
            }),
            None => run,
        },
        "concurrency-changed" => tables::reduce_concurrency_changed(run, payload),
        "run-caps-changed" => tables::reduce_run_caps_changed(run, payload),
        "phase-entered" => tables::reduce_phase_entered(run, payload, derived),
        "run-launched" => tables::reduce_run_launched(run, payload),
        "hole-reached" => tables::reduce_hole_reached(run, payload),
        "hole-filled" => tables::reduce_hole_filled(run, payload),
        "run-settled" => tables::reduce_run_settled(run, payload),
        _ => run,
    }
}

/// `js::canonical` needs the schema order; re-exported for the tests that check it.
pub fn canonical_run(run: Obj) -> Obj {
    canonical(run)
}

/// Used by the replay and the projection, which need the status vocabulary of the run.
pub fn is_terminal(status: Option<&str>) -> bool {
    matches!(
        status,
        Some("completed") | Some("errored") | Some("stopped")
    )
}

/// `non_empty` for a plain string; the JS `typeof x === "string" && x.length > 0` check.
pub(crate) fn str_value(text: &str) -> Value {
    Value::String(text.to_string())
}
