//! Cold replay: `dwf_event` rows → the progress envelopes the live path would have produced, and the
//! `workflowRuns` state they fold into (Node's `dynamic-workflow-run-replay.ts` and the derived fields
//! of `dynamic-workflow-run-progress-payload.ts`'s `toProgressPayload`).
//!
//! What is minted here, and only what the reducer reads: the bounded payload
//! (`boundDynamicWorkflowRunEventPayload`), `resumable` on a resumable `run-settled`, `resumedFrom`,
//! `subagentModel` and `concurrencyCeiling` on `run-started`, `concurrencyCeiling` on
//! `run-caps-changed`, the persona `model` and `actorModel` through `modelBindings`, `reachedAt` on
//! `hole-reached`, and the envelope's `actorSessionId` and `toolCallId`.
//!
//! Not minted (the reducer does not read them): `launchInputId`. Not minted and read by the reducer:
//! `type` on `hole-reached`, which needs the compiled script (`holeTypeOf`, lands with the W4 helper).

use serde_json::{Value, json};

use super::js::{Obj, plain};
use super::{Envelope, Limits, State, reduce};
use crate::repo::dwf::codecs::stop_reason_name;
use crate::repo::dwf::{RunRecord, RunStatus, StopReason, StoredEvent};

/// `DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS`.
const MAX_STRING_LENGTH: usize = 2048;
const MAX_ARRAY_ITEMS: usize = 32;
const MAX_KEYS: usize = 32;
const MAX_DEPTH: usize = 6;

/// `boundDynamicWorkflowRunEventPayload` over a JSON object. Strings are cut at 2048 UTF-16 units
/// (never inside a surrogate pair), arrays and objects at 32 items, depth at 6. Returns the bounded
/// object; `truncated` is only informational here (the envelope does not carry it).
pub fn bound_payload(payload: &Obj) -> Obj {
    match bound_value(&Value::Object(payload.clone()), 0) {
        Some(Value::Object(map)) => map,
        _ => Obj::new(),
    }
}

fn bound_value(value: &Value, depth: usize) -> Option<Value> {
    match value {
        Value::Null | Value::Bool(_) => Some(value.clone()),
        Value::Number(number) => Some(Value::Number(number.clone())),
        Value::String(text) => {
            if super::js::utf16_len(text) <= MAX_STRING_LENGTH {
                Some(value.clone())
            } else {
                Some(Value::String(super::js::utf16_prefix(
                    text,
                    MAX_STRING_LENGTH,
                )))
            }
        }
        Value::Array(items) => {
            if depth >= MAX_DEPTH {
                return None;
            }
            let out = items
                .iter()
                .take(MAX_ARRAY_ITEMS)
                .map(|item| bound_value(item, depth + 1).unwrap_or(Value::Null))
                .collect();
            Some(Value::Array(out))
        }
        Value::Object(map) => {
            if depth >= MAX_DEPTH {
                return None;
            }
            let mut out = Obj::new();
            for (key, item) in map.iter().take(MAX_KEYS) {
                if let Some(bounded) = bound_value(item, depth + 1) {
                    out.insert(key.clone(), bounded);
                }
            }
            Some(Value::Object(out))
        }
    }
}

fn run_status_name(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Pending => "pending",
        RunStatus::Running => "running",
        RunStatus::Completed => "completed",
        RunStatus::Errored => "errored",
        RunStatus::Stopped => "stopped",
    }
}

fn is_terminal(status: RunStatus) -> bool {
    matches!(
        status,
        RunStatus::Completed | RunStatus::Errored | RunStatus::Stopped
    )
}

/// `isResumableSettlement`: stopped and not superseded.
fn is_resumable(status: RunStatus, reason: Option<StopReason>) -> bool {
    status == RunStatus::Stopped && reason != Some(StopReason::Superseded)
}

/// `mintActorSessionId` for `(runId, actorRef)`: `createSessionId(dwf-<san(runId)>-<san(site@ordinal)>)`,
/// which Node prefixes with `sess_` (contracts `createSessionId`). The drift test pins this in workflow-driver.test.ts.
pub fn mint_actor_session_id(run_id: &str, site_id: &str, ordinal: f64) -> String {
    format!(
        "sess_dwf-{}-{}",
        sanitize_id_segment(run_id),
        sanitize_id_segment(&format!("{site_id}@{}", super::js::number_key(ordinal)))
    )
}

/// `sanitizeIdSegment`: `_` escapes to `__` first, then every char outside `[A-Za-z0-9.-]` maps to `_`.
/// Node's replace runs over UTF-16 code units, so an astral character (two units) becomes two `_`, not one.
/// The output is always ASCII, which the driver relies on when it slices the id for question fragments.
pub fn sanitize_id_segment(value: &str) -> String {
    let escaped = value.replace('_', "__");
    escaped
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-' => {
                char::from(byte)
            }
            _ => '_',
        })
        .collect()
}

/// The actor a node or actor event names, for the session id (`actorSessionRefOf`).
fn actor_session_ref(event_type: &str, event: &Value) -> Option<(String, f64)> {
    let actor = match event_type {
        "actor-created" | "node-dispatched" => event.get("actor"),
        "node-settled" if event.get("cached") == Some(&Value::Bool(true)) => event.get("actor"),
        _ => None,
    }?;
    let site = actor.get("siteId")?.as_str()?.to_string();
    let ordinal = super::js::js_number(actor.get("ordinal"))?;
    Some((site, ordinal))
}

/// Replays one run's journal into envelopes, in journal order, with the terminal settlement taken
/// from the row. `default_concurrency` is the host default (`resolveWorkflowDefaultConcurrency`).
pub fn replay_envelopes(
    run: &RunRecord,
    events: &[StoredEvent],
    default_concurrency: f64,
) -> Vec<Envelope> {
    let launched = events
        .iter()
        .find(|stored| stored.event.get("type").and_then(Value::as_str) == Some("run-launched"));
    let launched_event = launched.map(|stored| &stored.event);
    let subagent_model = launched_event
        .and_then(|event| event.get("subagentModel"))
        .cloned();
    let model_bindings = launched_event
        .and_then(|event| plain(event.get("modelBindings")))
        .cloned();
    let terminal = is_terminal(run.status);
    let last = events.last();
    let trailing_settle = match (terminal, last) {
        (true, Some(stored))
            if stored.event.get("type").and_then(Value::as_str) == Some("run-settled") =>
        {
            Some(stored)
        }
        _ => None,
    };
    let replayable: &[StoredEvent] = if trailing_settle.is_some() {
        &events[..events.len() - 1]
    } else {
        events
    };

    let mut envelopes: Vec<Envelope> = replayable
        .iter()
        .map(|stored| {
            let event_type = stored
                .event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let payload = minted_payload(
                run,
                &event_type,
                &stored.event,
                stored.time_created,
                &subagent_model,
                &model_bindings,
                default_concurrency,
            );
            envelope_for(
                run,
                stored.sequence as f64,
                &event_type,
                &stored.event,
                payload,
            )
        })
        .collect();

    if terminal {
        let mut settled = Obj::new();
        settled.insert("status".into(), json!(run_status_name(run.status)));
        if run.status == RunStatus::Stopped {
            let reason = run.stop_reason.unwrap_or(StopReason::User);
            settled.insert("stopReason".into(), json!(stop_reason_name(reason)));
            if let Some(by) = &run.superseded_by {
                settled.insert("supersededBy".into(), json!(by));
            }
        }
        if let Some(failure) = &run.failure {
            settled.insert("error".into(), failure.clone());
        }
        let event = Value::Object(settled.clone());
        let mut payload = bound_payload(&settled);
        if is_resumable(run.status, run.stop_reason) && run.status == RunStatus::Stopped {
            payload.insert("resumable".into(), Value::Bool(true));
        }
        let sequence = match trailing_settle {
            Some(stored) => stored.sequence as f64,
            None => last
                .map(|stored| stored.sequence as f64 + 1.0)
                .unwrap_or(1.0),
        };
        envelopes.push(envelope_for(run, sequence, "run-settled", &event, payload));
    }
    envelopes
}

/// `toProgressPayload` for one stored event: bounded payload plus the derived fields the reducer reads.
fn minted_payload(
    run: &RunRecord,
    event_type: &str,
    event: &Value,
    time_created: i64,
    subagent_model: &Option<Value>,
    model_bindings: &Option<Obj>,
    default_concurrency: f64,
) -> Obj {
    let raw = plain(Some(event)).cloned().unwrap_or_default();
    let mut rest = raw;
    rest.shift_remove("type");
    let mut payload = bound_payload(&rest);
    match event_type {
        "run-settled" => {
            let status = event
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let reason = event
                .get("stopReason")
                .and_then(Value::as_str)
                .and_then(stop_reason_from_str);
            if status == "stopped" && reason != Some(StopReason::Superseded) {
                payload.insert("resumable".into(), Value::Bool(true));
            }
        }
        "run-started" => {
            if let Some(resumed) = &run.resumed_from {
                payload.insert("resumedFrom".into(), json!(resumed));
            }
            payload.insert(
                "concurrencyCeiling".into(),
                super::js::number_value(default_concurrency),
            );
            if let Some(model) = subagent_model {
                payload.insert("subagentModel".into(), model.clone());
            }
        }
        "run-caps-changed" => {
            payload.insert(
                "concurrencyCeiling".into(),
                super::js::number_value(default_concurrency),
            );
        }
        "actor-created" => {
            let persona = event
                .get("persona")
                .and_then(|p| p.get("model"))
                .and_then(Value::as_str);
            if let Some(model) = with_actor_model(persona, model_bindings) {
                payload.insert("model".into(), json!(model));
            }
        }
        "node-dispatched" => {
            let persona = event.get("actorPersonaModel").and_then(Value::as_str);
            if let Some(model) = with_actor_model(persona, model_bindings) {
                payload.insert("actorModel".into(), json!(model));
            }
        }
        "hole-reached" => {
            // `type` needs the compiled script (holeTypeOf); not minted in W3.
            payload.insert("reachedAt".into(), json!(time_created));
        }
        _ => {}
    }
    payload
}

fn with_actor_model(persona: Option<&str>, bindings: &Option<Obj>) -> Option<String> {
    let name = persona?;
    bindings.as_ref()?.get(name)?.as_str().map(str::to_string)
}

fn stop_reason_from_str(text: &str) -> Option<StopReason> {
    match text {
        "user" => Some(StopReason::User),
        "model" => Some(StopReason::Model),
        "provider" => Some(StopReason::Provider),
        "interrupted" => Some(StopReason::Interrupted),
        "superseded" => Some(StopReason::Superseded),
        _ => None,
    }
}

fn envelope_for(
    run: &RunRecord,
    sequence: f64,
    event_type: &str,
    event: &Value,
    payload: Obj,
) -> Envelope {
    let actor_session_id = actor_session_ref(event_type, event)
        .map(|(site, ordinal)| mint_actor_session_id(&run.run_id, &site, ordinal));
    Envelope {
        run_id: Some(run.run_id.clone()),
        tool_call_id: run.tool_call_id.clone(),
        sequence: Some(sequence),
        event_type: Some(event_type.to_string()),
        payload: Some(payload),
        actor_session_id,
    }
}

/// Replays a run and folds it into the `workflowRuns` state (the cold-start projection).
pub fn replay_state(
    run: &RunRecord,
    events: &[StoredEvent],
    default_concurrency: f64,
    limits: &Limits,
) -> Option<State> {
    let mut state = State::default();
    let mut changed = false;
    for envelope in replay_envelopes(run, events, default_concurrency) {
        changed |= reduce(&mut state, &envelope, limits).is_some();
    }
    changed.then_some(state)
}
