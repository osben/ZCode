//! Per-event handlers (Node's `workflow-runs-reducer.ts` cases and the helper files they call:
//! `-started`, `-phases`, `-concurrency`, `-holes`, `-node-progress`, `-artifacts`, `-actor-session`,
//! `-actor-status`, `-entries`, `-tables`, `-lineage`).
//!
//! Each handler takes the run object by value and returns the next one, mirroring Node's
//! `{...run, key: v}` spreads: an existing key keeps its position, a new key is appended.

use serde_json::{Value, json};

use super::caps::{count_unlisted_instance, discount_unlisted_instance};
use super::eviction::{
    Seat, absorb_refused_actor, absorb_refused_settled_node, admits_new_entry, seat_workflow_node,
    with_room_for_actor,
};
use super::js::{
    InstanceRef, Obj, bounded, ellipsized, entry_ref, instance_ref, is_integer, js_number,
    json_equal, non_empty, number_value, plain, utf16_len,
};
use super::{Derived, Limits, PRODUCTION};

const ARTIFACT_KINDS: &[&str] = &["file", "markdown", "chart", "table", "metrics", "board"];
const STOP_REASONS: &[&str] = &["user", "model", "provider", "interrupted", "superseded"];

fn str_field(payload: &Obj, key: &str) -> Option<String> {
    non_empty(payload.get(key))
}

fn ordinal_value(reference: &InstanceRef) -> Value {
    number_value(reference.ordinal)
}

fn list(run: &Obj, key: &str) -> Vec<Obj> {
    run.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_object().cloned())
                .collect()
        })
        .unwrap_or_default()
}

fn put_list(run: &mut Obj, key: &str, items: Vec<Obj>) {
    run.insert(
        key.to_string(),
        Value::Array(items.into_iter().map(Value::Object).collect()),
    );
}

fn truncated_flag(run: &Obj) -> bool {
    run.get("truncated") == Some(&Value::Bool(true))
}

/// `boundedActorName` and `boundedPhaseName`: a prefix cut with no ellipsis (a correlation key).
fn bounded_name(value: Option<String>, limit: usize) -> Option<String> {
    value.map(|text| bounded(&text, limit))
}

fn positive_integer(value: Option<&Value>) -> Option<f64> {
    js_number(value).filter(|n| is_integer(*n) && *n > 0.0)
}

fn non_negative_integer(value: Option<&Value>) -> Option<f64> {
    js_number(value).filter(|n| is_integer(*n) && *n >= 0.0)
}

/// `String(value)` for the unrecognised-status message.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "undefined".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => {
            let n = number.as_f64().unwrap_or(f64::NAN);
            super::js::number_key(n)
        }
        Some(other) => other.to_string(),
    }
}

/// `workflowActorEntry`: birth fields in the order Node writes them; `status` is a placeholder.
pub fn workflow_actor_entry(
    reference: &InstanceRef,
    name: Option<&Value>,
    phase_name: Option<String>,
    session_id: Option<&str>,
    model: Option<&Value>,
) -> Obj {
    let mut actor = Obj::new();
    actor.insert("siteId".into(), Value::String(reference.site_id.clone()));
    actor.insert("ordinal".into(), ordinal_value(reference));
    if let Some(bounded_name) = bounded_name(non_empty(name), PRODUCTION.max_actor_name_length) {
        actor.insert("name".into(), Value::String(bounded_name));
    }
    if let Some(session) = session_id.filter(|s| !s.is_empty()) {
        actor.insert("sessionId".into(), Value::String(session.to_string()));
    }
    if let Some(phase) = phase_name {
        actor.insert("phaseName".into(), Value::String(phase));
    }
    if let Some(model) =
        non_empty(model).filter(|m| utf16_len(m) <= PRODUCTION.max_subagent_model_length)
    {
        actor.insert("model".into(), Value::String(model));
    }
    actor.insert("status".into(), Value::String("waiting".into()));
    actor
}

/// `withDerivedWorkflowActorStatuses`: three-state actor status from the node phases.
pub fn with_derived_statuses(mut run: Obj) -> Obj {
    use std::collections::HashSet;
    let nodes = list(&run, "nodes");
    let mut executing = HashSet::new();
    let mut live = HashSet::new();
    let mut owned = HashSet::new();
    for node in &nodes {
        let (Some(site), Some(ordinal)) = (
            node.get("actorSiteId").and_then(Value::as_str),
            js_number(node.get("actorOrdinal")),
        ) else {
            continue;
        };
        let key = super::js::entry_key(site, ordinal);
        owned.insert(key.clone());
        match node.get("phase").and_then(Value::as_str) {
            Some("executing") | Some("repairing") | Some("nudged") => {
                executing.insert(key);
            }
            Some("queued") | Some("dispatched") | Some("waiting") => {
                live.insert(key);
            }
            _ => {}
        }
    }
    let run_live = matches!(
        run.get("status").and_then(Value::as_str),
        Some("pending") | Some("running")
    );
    let mut actors = list(&run, "actors");
    for actor in &mut actors {
        let key = entry_ref(actor).map(|r| r.key()).unwrap_or_default();
        let status = if !run_live {
            "completed"
        } else if executing.contains(&key) {
            "running"
        } else if live.contains(&key) || !owned.contains(&key) {
            "waiting"
        } else {
            "completed"
        };
        if actor.get("status").and_then(Value::as_str) != Some(status) {
            actor.insert("status".into(), Value::String(status.into()));
        }
    }
    put_list(&mut run, "actors", actors);
    run
}

/// `boundedSessionId`: a non-empty string within the limit, with no truncation.
fn bounded_session_id(value: Option<&Value>) -> Option<String> {
    non_empty(value).filter(|text| utf16_len(text) <= PRODUCTION.max_session_id_length)
}

/// `actorsWithTranscriptSession`: which session holds the subagent's transcript, after a node event.
fn actors_with_transcript_session(
    mut actors: Vec<Obj>,
    event_type: &str,
    payload: &Obj,
    actor_ref: Option<&InstanceRef>,
    envelope_session_id: Option<&str>,
) -> Vec<Obj> {
    let Some(actor_ref) = actor_ref else {
        return actors;
    };
    let envelope = envelope_session_id.map(|s| Value::String(s.to_string()));
    let session_id =
        if event_type == "node-settled" && payload.get("cached") == Some(&Value::Bool(true)) {
            bounded_session_id(payload.get("sourceSessionId"))
                .or_else(|| bounded_session_id(envelope.as_ref()))
        } else if event_type == "node-dispatched" {
            bounded_session_id(envelope.as_ref())
        } else {
            None
        };
    let Some(session_id) = session_id else {
        return actors;
    };
    let Some(index) = actors
        .iter()
        .position(|actor| entry_ref(actor).is_some_and(|r| r.same(actor_ref)))
    else {
        return actors;
    };
    if actors[index].get("sessionId").and_then(Value::as_str) == Some(session_id.as_str()) {
        return actors;
    }
    actors[index].insert("sessionId".into(), Value::String(session_id));
    actors
}

/// `reduceRunStarted`: back to running, usage reset, and the previous incarnation's terminal remnants
/// removed. An overflowed run restarts with empty tables.
pub fn reduce_run_started(run: Obj, payload: &Obj, derived: &Derived<'_>) -> Obj {
    let original = run.clone();
    let mut rebased = run;
    for key in [
        "error",
        "resultPreview",
        "pendingQuestions",
        "resumable",
        "stopReason",
        "unlistedByPhase",
    ] {
        rebased.shift_remove(key);
    }
    let resumed_from =
        str_field(payload, "resumedFrom").or_else(|| str_field(&rebased, "resumedFrom"));
    let subagent_model = read_subagent_model(payload.get("subagentModel"))
        .or_else(|| str_field(&rebased, "subagentModel"));
    let mut next = without_waiting_holes(rebased);
    if let Some(value) = resumed_from {
        next.insert("resumedFrom".into(), Value::String(value));
    }
    if let Some(value) = subagent_model {
        next.insert("subagentModel".into(), Value::String(value));
    }
    next.insert("status".into(), Value::String("running".into()));
    next.insert("usage".into(), json!({"spentTokens": 0, "nodesUsed": 0}));
    if !truncated_flag(&original) {
        next.insert(
            "actors".into(),
            Value::Array(
                list(&original, "actors")
                    .into_iter()
                    .map(Value::Object)
                    .collect(),
            ),
        );
        next.insert(
            "nodes".into(),
            Value::Array(
                list(&original, "nodes")
                    .into_iter()
                    .map(Value::Object)
                    .collect(),
            ),
        );
    } else {
        next.insert("actors".into(), json!([]));
        next.insert("nodes".into(), json!([]));
    }
    let _ = derived;
    reduce_run_started_concurrency(next, payload)
}

fn read_subagent_model(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty() && utf16_len(text) <= PRODUCTION.max_subagent_model_length)
        .then(|| text.to_string())
}

fn without_waiting_holes(mut run: Obj) -> Obj {
    let Some(holes) = run.get("holes").and_then(Value::as_array).cloned() else {
        return run;
    };
    let kept: Vec<Value> = holes
        .iter()
        .filter(|hole| hole.get("state").and_then(Value::as_str) == Some("filled"))
        .cloned()
        .collect();
    if kept.len() == holes.len() {
        return run;
    }
    run.shift_remove("holes");
    if !kept.is_empty() {
        run.insert("holes".into(), Value::Array(kept));
    }
    run
}

fn reduce_run_started_concurrency(mut run: Obj, payload: &Obj) -> Obj {
    let limit =
        positive_integer(plain(payload.get("caps")).and_then(|caps| caps.get("maxConcurrency")));
    let read_ceiling = positive_integer(payload.get("concurrencyCeiling"));
    let ceiling = read_ceiling.filter(|c| *c <= PRODUCTION.max_concurrency_ceiling);
    if let Some(value) = ceiling
        && js_number(run.get("concurrencyCeiling")) != Some(value)
    {
        run.insert("concurrencyCeiling".into(), number_value(value));
    }
    let (Some(limit), Some(ceiling)) = (limit, ceiling) else {
        return run;
    };
    if limit == ceiling {
        return run;
    }
    let mut concurrency = plain(run.get("concurrency")).cloned().unwrap_or_else(|| {
        let mut base = Obj::new();
        base.insert("cap".into(), number_value(ceiling));
        base
    });
    concurrency.insert("ceiling".into(), number_value(ceiling));
    concurrency.insert("limit".into(), number_value(limit));
    run.insert("concurrency".into(), Value::Object(concurrency));
    run
}

/// `reduceRunCapsChanged`: a limit change while running, in place.
pub fn reduce_run_caps_changed(mut run: Obj, payload: &Obj) -> Obj {
    let max_concurrency =
        positive_integer(plain(payload.get("caps")).and_then(|caps| caps.get("maxConcurrency")));
    let read_ceiling = positive_integer(payload.get("concurrencyCeiling"));
    let payload_ceiling = read_ceiling.filter(|c| *c <= PRODUCTION.max_concurrency_ceiling);
    if let Some(value) = payload_ceiling
        && js_number(run.get("concurrencyCeiling")) != Some(value)
    {
        run.insert("concurrencyCeiling".into(), number_value(value));
    }
    let ceiling = payload_ceiling.or_else(|| js_number(run.get("concurrencyCeiling")));
    let (Some(max_concurrency), Some(ceiling)) = (max_concurrency, ceiling) else {
        return run;
    };
    let existing = plain(run.get("concurrency")).cloned();
    if max_concurrency != ceiling {
        let mut concurrency = existing.unwrap_or_else(|| {
            let mut base = Obj::new();
            base.insert("cap".into(), number_value(ceiling));
            base
        });
        concurrency.insert("ceiling".into(), number_value(ceiling));
        concurrency.insert("limit".into(), number_value(max_concurrency));
        run.insert("concurrency".into(), Value::Object(concurrency));
        return run;
    }
    let Some(existing) = existing else { return run };
    if !existing.contains_key("limit") {
        return run;
    }
    let mut shared = existing;
    shared.shift_remove("limit");
    shared.insert("ceiling".into(), number_value(ceiling));
    let cap = js_number(shared.get("cap")).unwrap_or(0.0);
    let cap_reaches_ceiling = cap >= ceiling;
    if !shared.contains_key("cooldownMs") && cap_reaches_ceiling {
        run.shift_remove("concurrency");
        return run;
    }
    run.insert("concurrency".into(), Value::Object(shared));
    run
}

/// `reduceConcurrencyChanged`: the process coordinator adjusted the cap for this run's key.
pub fn reduce_concurrency_changed(mut run: Obj, payload: &Obj) -> Obj {
    let Some(next) = positive_integer(payload.get("next")) else {
        return run;
    };
    let previous = positive_integer(payload.get("previous")).unwrap_or(next);
    let existing = plain(run.get("concurrency")).cloned();
    let ceiling = js_number(run.get("concurrencyCeiling")).unwrap_or_else(|| {
        let from_run = js_number(existing.as_ref().and_then(|c| c.get("ceiling"))).unwrap_or(0.0);
        from_run.max(previous).max(next)
    });
    let key = str_field(payload, "key");
    let limit = existing.as_ref().and_then(|c| c.get("limit")).cloned();
    let cooldown = if payload.get("reason").and_then(Value::as_str) == Some("idle_reset") {
        None
    } else {
        non_negative_integer(payload.get("cooldownMs"))
    };
    let mut concurrency = Obj::new();
    if let Some(key) = key.filter(|k| utf16_len(k) <= PRODUCTION.max_concurrency_key_length) {
        concurrency.insert("key".into(), Value::String(key));
    }
    concurrency.insert("cap".into(), number_value(next));
    concurrency.insert("ceiling".into(), number_value(ceiling));
    if let Some(limit) = limit {
        concurrency.insert("limit".into(), limit);
    }
    if let Some(cooldown) = cooldown {
        concurrency.insert("cooldownMs".into(), number_value(cooldown));
    }
    run.insert("concurrency".into(), Value::Object(concurrency));
    run
}

fn without_cooldown(mut run: Obj) -> Obj {
    let Some(mut concurrency) = plain(run.get("concurrency")).cloned() else {
        return run;
    };
    if !concurrency.contains_key("cooldownMs") {
        return run;
    }
    concurrency.shift_remove("cooldownMs");
    run.insert("concurrency".into(), Value::Object(concurrency));
    run
}

/// `reducePhaseEntered`: adds a declared phase, or raises its rounds.
pub fn reduce_phase_entered(mut run: Obj, payload: &Obj, _derived: &Derived<'_>) -> Obj {
    let Some(raw) = payload.get("name").and_then(Value::as_str) else {
        return run;
    };
    let name = bounded(raw, PRODUCTION.max_phase_name_length);
    if name.is_empty() {
        return run;
    }
    let ordinal = match payload.get("ordinal").and_then(js_integer_value) {
        Some(value) if value > 0 => value,
        _ => 1,
    };
    let existing = list(&run, "phases");
    let index = existing
        .iter()
        .position(|phase| phase.get("name").and_then(Value::as_str) == Some(name.as_str()));
    let mut truncated = truncated_flag(&run);
    let phases: Vec<Obj> = match index {
        Some(position) => {
            let current_rounds = existing[position]
                .get("rounds")
                .and_then(js_integer_value)
                .unwrap_or(0);
            if current_rounds >= ordinal {
                existing
            } else {
                existing
                    .into_iter()
                    .enumerate()
                    .map(|(i, mut phase)| {
                        if i == position {
                            phase.insert("rounds".into(), Value::from(ordinal));
                        }
                        phase
                    })
                    .collect()
            }
        }
        None if existing.len() >= PRODUCTION.max_phases => {
            truncated = true;
            existing
        }
        None => {
            let mut next = existing;
            let mut phase = Obj::new();
            phase.insert("name".into(), Value::String(name.clone()));
            phase.insert("rounds".into(), Value::from(ordinal));
            next.push(phase);
            next
        }
    };
    put_list(&mut run, "phases", phases);
    run.insert("currentPhase".into(), Value::String(name));
    if truncated {
        run.insert("truncated".into(), Value::Bool(true));
    }
    run
}

fn js_integer_value(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (is_integer(number)).then_some(number as i64)
}

fn read_phase_alongside(raw: Option<&Value>, count: usize) -> Option<Vec<Vec<i64>>> {
    let raw = raw?.as_array()?;
    let mut out = Vec::new();
    let mut any = false;
    for index in 0..count {
        let mut indexes: Vec<i64> = Vec::new();
        if let Some(entry) = raw.get(index).and_then(Value::as_array) {
            for value in entry {
                let Some(number) = value.as_f64().filter(|n| is_integer(*n)) else {
                    continue;
                };
                let value = number as i64;
                if value < 0
                    || value >= count as i64
                    || value == index as i64
                    || indexes.contains(&value)
                {
                    continue;
                }
                indexes.push(value);
                if indexes.len() >= PRODUCTION.max_phases {
                    break;
                }
            }
        }
        if !indexes.is_empty() {
            any = true;
        }
        out.push(indexes);
    }
    any.then_some(out)
}

fn read_phase_holes(raw: Option<&Value>, count: usize) -> Option<Vec<i64>> {
    let raw = raw?.as_array()?;
    let mut out: Vec<i64> = Vec::new();
    for value in raw {
        let Some(number) = value.as_f64().filter(|n| is_integer(*n)) else {
            continue;
        };
        let value = number as i64;
        if value < 0 || value >= count as i64 || out.contains(&value) {
            continue;
        }
        out.push(value);
        if out.len() >= PRODUCTION.max_phases {
            break;
        }
    }
    (!out.is_empty()).then_some(out)
}

fn read_phase_names(raw: Option<&Value>) -> Option<Vec<String>> {
    let raw = raw?.as_array()?;
    let mut names = Vec::new();
    for value in raw {
        let Some(text) = value.as_str() else { continue };
        let name = bounded(text, PRODUCTION.max_phase_name_length);
        if name.is_empty() {
            continue;
        }
        names.push(name);
        if names.len() >= PRODUCTION.max_phases {
            break;
        }
    }
    (!names.is_empty()).then_some(names)
}

fn int_array(values: &[i64]) -> Value {
    Value::Array(values.iter().map(|v| Value::from(*v)).collect())
}

/// `reduceRunLaunched`: the declared phase table, alongside lists and holes.
pub fn reduce_run_launched(mut run: Obj, payload: &Obj) -> Obj {
    let Some(raw) = payload.get("phaseNames").and_then(Value::as_array) else {
        return run;
    };
    let names = read_phase_names(Some(&Value::Array(raw.clone()))).unwrap_or_default();
    if names.is_empty() {
        return run;
    }
    let alongside = read_phase_alongside(payload.get("phaseAlongside"), names.len());
    let holes = read_phase_holes(payload.get("holes"), names.len());
    run.insert(
        "phaseNames".into(),
        Value::Array(names.iter().map(|n| Value::String(n.clone())).collect()),
    );
    if let Some(alongside) = alongside {
        run.insert(
            "phaseAlongside".into(),
            Value::Array(alongside.iter().map(|entry| int_array(entry)).collect()),
        );
    }
    if let Some(holes) = holes {
        run.insert("phaseHoles".into(), int_array(&holes));
    }
    run
}

/// `reduceHoleReached`: a hole waits. The entry is merged by site, and the table is bounded.
pub fn reduce_hole_reached(mut run: Obj, payload: &Obj) -> Obj {
    let Some(instance) = plain(payload.get("instance")) else {
        return run;
    };
    let site_id = str_field(instance, "siteId");
    let ordinal = instance
        .get("ordinal")
        .and_then(js_integer_value)
        .unwrap_or(0);
    let name = bounded_name(str_field(payload, "name"), PRODUCTION.max_phase_name_length);
    let (Some(site_id), Some(name)) = (site_id, name) else {
        return run;
    };
    let type_value =
        str_field(payload, "type").map(|t| bounded(&t, PRODUCTION.max_hole_type_length));
    let prompt =
        str_field(payload, "prompt").map(|p| ellipsized(&p, PRODUCTION.max_hole_prompt_length));
    let since = read_epoch(payload.get("reachedAt")).or_else(|| read_epoch(payload.get("since")));

    let mut entry = Obj::new();
    entry.insert("siteId".into(), Value::String(site_id.clone()));
    entry.insert("ordinal".into(), Value::from(ordinal));
    entry.insert("name".into(), Value::String(name));
    if let Some(t) = &type_value {
        entry.insert("type".into(), Value::String(t.clone()));
    }
    if let Some(p) = &prompt {
        entry.insert("prompt".into(), Value::String(p.clone()));
    }
    entry.insert("state".into(), Value::String("waiting".into()));
    if let Some(since) = since {
        entry.insert("since".into(), Value::from(since));
    }

    let existing = list(&run, "holes");
    if let Some(index) = existing
        .iter()
        .position(|hole| hole.get("siteId").and_then(Value::as_str) == Some(site_id.as_str()))
    {
        let previous = &existing[index];
        let mut merged = entry;
        if !merged.contains_key("type")
            && let Some(t) = previous.get("type")
        {
            merged.insert("type".into(), t.clone());
        }
        if !merged.contains_key("prompt")
            && let Some(p) = previous.get("prompt")
        {
            merged.insert("prompt".into(), p.clone());
        }
        let next: Vec<Obj> = existing
            .into_iter()
            .enumerate()
            .map(|(i, hole)| if i == index { merged.clone() } else { hole })
            .collect();
        put_list(&mut run, "holes", next);
        return run;
    }
    if existing.len() >= PRODUCTION.max_holes {
        run.insert("truncated".into(), Value::Bool(true));
        return run;
    }
    let mut next = existing;
    next.push(entry);
    put_list(&mut run, "holes", next);
    run
}

fn read_epoch(value: Option<&Value>) -> Option<i64> {
    let number = js_number(value)?;
    (number.is_finite() && number >= 0.0).then(|| number.floor() as i64)
}

/// `reduceHoleFilled`: the hole becomes filled; the phase table is replaced when named.
pub fn reduce_hole_filled(run: Obj, payload: &Obj) -> Obj {
    let Some(site_id) = str_field(payload, "siteId") else {
        return run;
    };
    let filled_at = read_epoch(payload.get("filledAt"));
    let filled_by = str_field(payload, "filledBy").map(|s| bounded(&s, 128));
    let mut next = run.clone();
    let existing = list(&run, "holes");
    if let Some(index) = existing
        .iter()
        .position(|hole| hole.get("siteId").and_then(Value::as_str) == Some(site_id.as_str()))
    {
        let mut reached = existing[index].clone();
        reached.shift_remove("prompt");
        reached.insert("state".into(), Value::String("filled".into()));
        if let Some(at) = filled_at {
            reached.insert("filledAt".into(), Value::from(at));
        }
        if let Some(by) = &filled_by {
            reached.insert("filledBy".into(), Value::String(by.clone()));
        }
        let mapped: Vec<Obj> = existing
            .into_iter()
            .enumerate()
            .map(|(i, hole)| if i == index { reached.clone() } else { hole })
            .collect();
        put_list(&mut next, "holes", mapped);
    }
    let Some(phase_names) = read_phase_names(payload.get("phaseNames")) else {
        return next;
    };
    let phase_holes = read_phase_holes(payload.get("holes"), phase_names.len());
    let phase_alongside = shift_phase_alongside(&run, &phase_names);
    next.shift_remove("phaseAlongside");
    next.shift_remove("phaseHoles");
    next.insert(
        "phaseNames".into(),
        Value::Array(
            phase_names
                .iter()
                .map(|n| Value::String(n.clone()))
                .collect(),
        ),
    );
    if let Some(alongside) = phase_alongside {
        next.insert(
            "phaseAlongside".into(),
            Value::Array(alongside.iter().map(|entry| int_array(entry)).collect()),
        );
    }
    if let Some(holes) = phase_holes {
        next.insert("phaseHoles".into(), int_array(&holes));
    }
    next
}

/// `shiftPhaseAlongside`: re-indexes the alongside lists when phases are inserted before the old list.
fn shift_phase_alongside(run: &Obj, names: &[String]) -> Option<Vec<Vec<i64>>> {
    let old: Vec<String> = run
        .get("phaseNames")?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    let alongside: Vec<Vec<i64>> = run
        .get("phaseAlongside")?
        .as_array()?
        .iter()
        .map(|entry| {
            entry
                .as_array()
                .map(|items| items.iter().filter_map(js_integer_value).collect())
                .unwrap_or_default()
        })
        .collect();
    let inserted = names.len() as i64 - old.len() as i64;
    if inserted < 0 {
        return None;
    }
    let mut h: i64 = -1;
    for (i, old_name) in old.iter().enumerate() {
        if names.get(i) != Some(old_name) {
            break;
        }
        h = i as i64;
    }
    if h < 0 {
        return None;
    }
    for (i, old_name) in old.iter().enumerate().skip(h as usize + 1) {
        if names.get(i + inserted as usize) != Some(old_name) {
            return None;
        }
    }
    let shift = |i: i64| if i <= h { i } else { i + inserted };
    let mut out: Vec<Vec<i64>> = Vec::new();
    for i in 0..names.len() as i64 {
        let source = if i <= h { i } else { i - inserted };
        let entry: Vec<i64> = if i > h && i <= h + inserted {
            Vec::new()
        } else if source >= 0 {
            alongside.get(source as usize).cloned().unwrap_or_default()
        } else {
            Vec::new()
        };
        out.push(entry.into_iter().map(shift).collect());
    }
    out.iter().any(|entry| !entry.is_empty()).then_some(out)
}

fn read_last_tool(value: Option<&Value>) -> Option<Obj> {
    let record = plain(value)?;
    let name = record
        .get("name")
        .and_then(Value::as_str)
        .map(|n| bounded(n, PRODUCTION.max_last_tool_name_length))?;
    if name.is_empty() {
        return None;
    }
    let mut out = Obj::new();
    out.insert("name".into(), Value::String(name));
    if let Some(target) = record
        .get("target")
        .and_then(Value::as_str)
        .map(|t| bounded(t, PRODUCTION.max_last_tool_target_length))
        && !target.is_empty()
    {
        out.insert("target".into(), Value::String(target));
    }
    Some(out)
}

/// `reduceNodeProgress`: one parsed turn. Not a lifecycle event; only the three readings change.
pub fn reduce_node_progress(mut run: Obj, reference: &InstanceRef, payload: &Obj) -> Obj {
    let mut nodes = list(&run, "nodes");
    let Some(index) = nodes
        .iter()
        .position(|node| entry_ref(node).is_some_and(|r| r.same(reference)))
    else {
        return run;
    };
    let node = nodes[index].clone();
    let turn = positive_integer(payload.get("turn")).or_else(|| js_number(node.get("turn")));
    let tool_calls =
        non_negative_integer(payload.get("toolCalls")).or_else(|| js_number(node.get("toolCalls")));
    let last_tool = read_last_tool(payload.get("lastTool"))
        .map(Value::Object)
        .or_else(|| node.get("lastTool").cloned());
    let mut next = node;
    if let Some(turn) = turn {
        next.insert("turn".into(), number_value(turn));
    }
    if let Some(tool_calls) = tool_calls {
        next.insert("toolCalls".into(), number_value(tool_calls));
    }
    if let Some(last_tool) = last_tool {
        next.insert("lastTool".into(), last_tool);
    }
    nodes[index] = next;
    put_list(&mut run, "nodes", nodes);
    run
}

/// `carryNodeProgress`: the three readings and the head, carried across events as Node does.
fn carry_node_progress(event_type: &str, payload: &Obj, previous: Option<&Obj>) -> Obj {
    let requeued = event_type == "node-queued";
    let born = requeued
        || (event_type == "node-settled" && payload.get("cached") == Some(&Value::Bool(true)));
    let carried = if born { None } else { previous };
    let head = payload
        .get("instructionsHead")
        .and_then(Value::as_str)
        .map(|h| bounded(h, PRODUCTION.max_instructions_head_length))
        .filter(|h| !h.is_empty());
    let instructions_head = if requeued {
        head
    } else {
        head.or_else(|| {
            previous
                .and_then(|p| p.get("instructionsHead"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
    };
    let mut out = Obj::new();
    if let Some(head) = instructions_head {
        out.insert("instructionsHead".into(), Value::String(head));
    }
    if let Some(carried) = carried {
        for key in ["turn", "toolCalls", "lastTool"] {
            if let Some(value) = carried.get(key) {
                out.insert(key.into(), value.clone());
            }
        }
    }
    out
}

fn node_phase_of(event_type: &str) -> Option<&'static str> {
    match event_type {
        "node-queued" => Some("queued"),
        "node-dispatched" => Some("dispatched"),
        "node-executing" => Some("executing"),
        "node-waiting" => Some("waiting"),
        "node-repairing" => Some("repairing"),
        "node-nudged" => Some("nudged"),
        "node-settled" => Some("settled"),
        _ => None,
    }
}

/// The node-lifecycle branch of `applyWorkflowRunEvent`.
pub fn reduce_node_event(
    mut run: Obj,
    event_type: &str,
    payload: &Obj,
    derived: &Derived<'_>,
) -> Obj {
    let Some(reference) = instance_ref(payload.get("instance")) else {
        return run;
    };
    let Some(phase) = node_phase_of(event_type) else {
        return run;
    };
    let born = event_type == "node-queued"
        || (event_type == "node-settled" && payload.get("cached") == Some(&Value::Bool(true)));
    let actor_ref = instance_ref(payload.get("actor"));
    let dispatch_actor = if event_type == "node-dispatched" {
        actor_ref.as_ref().map(|actor| {
            workflow_actor_entry(
                actor,
                payload.get("actorName"),
                bounded_name(
                    str_field(payload, "actorPhaseName"),
                    PRODUCTION.max_phase_name_length,
                ),
                derived.actor_session_id,
                payload.get("actorModel"),
            )
        })
    } else {
        None
    };
    let seat = Seat {
        event_type,
        reference: reference.clone(),
        actor_ref: actor_ref.clone(),
        actor: dispatch_actor,
        born,
        advances_water_mark: derived.advances_water_mark,
    };
    let seating = seat_workflow_node(&run, &seat, derived.limits);
    let seated = seating.run;

    let nodes_before = list(&seated, "nodes");
    let previous_index = nodes_before
        .iter()
        .position(|node| entry_ref(node).is_some_and(|r| r.same(&reference)));
    let previous = previous_index.map(|i| nodes_before[i].clone());
    let kind = match payload.get("kind").and_then(Value::as_str) {
        Some("ask") | Some("world-read") => payload.get("kind").cloned(),
        _ => previous.as_ref().and_then(|p| p.get("kind")).cloned(),
    };
    let phase_name = bounded_name(
        str_field(payload, "phaseName"),
        PRODUCTION.max_phase_name_length,
    )
    .map(Value::String)
    .or_else(|| previous.as_ref().and_then(|p| p.get("phaseName")).cloned());

    let mut node = Obj::new();
    node.insert("siteId".into(), Value::String(reference.site_id.clone()));
    node.insert("ordinal".into(), ordinal_value(&reference));
    if let Some(kind) = kind {
        node.insert("kind".into(), kind);
    }
    node.insert("phase".into(), Value::String(phase.into()));
    if let Some(outcome) = payload.get("outcome").and_then(Value::as_str)
        && matches!(outcome, "ok" | "failed" | "cancelled")
    {
        node.insert("outcome".into(), Value::String(outcome.into()));
    }
    if payload.get("cached") == Some(&Value::Bool(true)) {
        node.insert("cached".into(), Value::Bool(true));
    }
    match (
        &actor_ref,
        previous
            .as_ref()
            .and_then(|p| p.get("actorSiteId"))
            .cloned(),
    ) {
        (Some(actor), _) => {
            node.insert("actorSiteId".into(), Value::String(actor.site_id.clone()));
            node.insert("actorOrdinal".into(), ordinal_value(actor));
        }
        (None, Some(site)) => {
            node.insert("actorSiteId".into(), site);
            if let Some(ordinal) = previous
                .as_ref()
                .and_then(|p| p.get("actorOrdinal"))
                .cloned()
            {
                node.insert("actorOrdinal".into(), ordinal);
            }
        }
        (None, None) => {}
    }
    if let Some(phase_name) = phase_name {
        node.insert("phaseName".into(), phase_name);
    }
    for (key, value) in carry_node_progress(event_type, payload, previous.as_ref()) {
        node.insert(key, value);
    }

    let (upserted_nodes, upserted_truncated) = upsert_bounded_by_instance(
        &nodes_before,
        node.clone(),
        derived.limits.max_nodes,
        seating.admit_new,
    );

    let first_dispatch = event_type == "node-dispatched"
        && admits_new_entry(&run, derived.advances_water_mark)
        && previous
            .as_ref()
            .is_none_or(|p| p.get("phase").and_then(Value::as_str) == Some("queued"));
    let restored = if seating.activated {
        discount_unlisted_instance(usage_of(&seated))
    } else {
        usage_of(&seated)
    };
    let mut counted = restored;
    if first_dispatch {
        let used = counted
            .get("nodesUsed")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        counted.insert("nodesUsed".into(), Value::from(used));
    }
    let usage = count_unlisted_instance(
        counted,
        upserted_truncated,
        derived.advances_water_mark,
        event_type,
        payload.get("cached") == Some(&Value::Bool(true)),
    );

    // Node reads `seated.truncated` (after eviction), not the incoming run's flag.
    let seated_truncated = truncated_flag(&seated);
    let absorbed =
        if upserted_truncated && derived.advances_water_mark && born && phase == "settled" {
            absorb_refused_settled_node(seated, &node, derived.limits)
        } else {
            seated
        };
    let transcript_actors = actors_with_transcript_session(
        list(&absorbed, "actors"),
        event_type,
        payload,
        actor_ref.as_ref(),
        derived.actor_session_id,
    );
    let mut result = absorbed;
    result.insert("usage".into(), Value::Object(usage));
    put_list(&mut result, "actors", transcript_actors);
    put_list(&mut result, "nodes", upserted_nodes);
    if upserted_truncated || seated_truncated {
        result.insert("truncated".into(), Value::Bool(true));
    }
    run = result;
    with_derived_statuses(run)
}

fn usage_of(run: &Obj) -> Obj {
    run.get("usage")
        .and_then(|u| plain(Some(u)).cloned())
        .unwrap_or_default()
}

/// `upsertBoundedByInstance`: replace in place, or append within the limit. Returns (list, truncated).
fn upsert_bounded_by_instance(
    list: &[Obj],
    entry: Obj,
    limit: usize,
    admit_new: bool,
) -> (Vec<Obj>, bool) {
    let key = entry_ref(&entry);
    if let Some(index) = list.iter().position(|item| entry_ref(item) == key) {
        let mut next = list.to_vec();
        next[index] = entry;
        return (next, false);
    }
    if !admit_new || list.len() >= limit {
        return (list.to_vec(), true);
    }
    let mut next = list.to_vec();
    next.push(entry);
    (next, false)
}

/// `reduceActorCreated`: a subagent's birth. Makes room for an active newcomer if the table is full.
pub fn reduce_actor_created(run: Obj, payload: &Obj, derived: &Derived<'_>) -> Obj {
    let Some(reference) = instance_ref(payload.get("actor")) else {
        return run;
    };
    let phase_name = bounded_name(
        str_field(payload, "phaseName"),
        PRODUCTION.max_phase_name_length,
    );
    let actor = workflow_actor_entry(
        &reference,
        payload.get("name"),
        phase_name.clone(),
        derived.actor_session_id,
        payload.get("model"),
    );
    // admitsNewEntry reads the incoming run, before eviction (Node passes `run`, not `seated`).
    let admit_new = admits_new_entry(&run, derived.advances_water_mark);
    let seated = if derived.advances_water_mark {
        with_room_for_actor(run, &reference, derived.limits)
    } else {
        run
    };
    let actors = list(&seated, "actors");
    let (upserted, truncated) =
        upsert_bounded_by_instance(&actors, actor, derived.limits.max_actors, admit_new);
    let absorbed = if truncated && derived.advances_water_mark {
        absorb_refused_actor(seated.clone(), phase_name.as_deref(), derived.limits)
    } else {
        seated.clone()
    };
    let mut result = absorbed;
    put_list(&mut result, "actors", upserted);
    if truncated || truncated_flag(&seated) {
        result.insert("truncated".into(), Value::Bool(true));
    }
    with_derived_statuses(result)
}

/// `workflowReportPreview`: `JSON.stringify(item, null, 2)` (strings unchanged), cut for display.
pub fn report_preview(item: Option<&Value>) -> String {
    let text = match item {
        None => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(value) => serde_json::to_string_pretty(value).unwrap_or_default(),
    };
    ellipsized(&text, PRODUCTION.max_report_preview_length)
}

/// `report`: one incremental output. Does not touch nodes or actors.
pub fn reduce_report(mut run: Obj, payload: &Obj, derived: &Derived<'_>) -> Obj {
    let Some(reference) = instance_ref(payload.get("instance")) else {
        return run;
    };
    let artifact_id = str_field(payload, "artifactId");
    let mut report = Obj::new();
    report.insert("siteId".into(), Value::String(reference.site_id.clone()));
    report.insert("ordinal".into(), ordinal_value(&reference));
    report.insert(
        "preview".into(),
        Value::String(report_preview(payload.get("item"))),
    );
    if let Some(id) = &artifact_id {
        report.insert("artifactId".into(), Value::String(id.clone()));
    }
    let existing = list(&run, "reports");
    let first_sighting = !existing
        .iter()
        .any(|item| entry_ref(item).is_some_and(|r| r.same(&reference)));
    let (upserted, truncated) =
        upsert_bounded_by_instance(&existing, report, PRODUCTION.max_reports, true);
    let counted = match (&artifact_id, first_sighting) {
        (Some(id), true) => count_tagged_report(&run, id),
        _ => None,
    };
    put_list(&mut run, "reports", upserted);
    if let Some(counted) = counted {
        put_list(&mut run, "artifacts", counted);
    }
    if truncated || truncated_flag(&run) {
        run.insert("truncated".into(), Value::Bool(true));
    }
    let _ = derived;
    run
}

/// `countTaggedReport`: increments `itemCount` on the artifact with that id, if it is listed.
fn count_tagged_report(run: &Obj, artifact_id: &str) -> Option<Vec<Obj>> {
    let mut artifacts = run
        .get("artifacts")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|a| a.as_object().cloned())
        .collect::<Vec<_>>();
    let index = artifacts
        .iter()
        .position(|a| a.get("id").and_then(Value::as_str) == Some(artifact_id))?;
    let current = js_number(artifacts[index].get("itemCount")).unwrap_or(0.0);
    artifacts[index].insert("itemCount".into(), number_value(current + 1.0));
    Some(artifacts)
}

/// `workflowArtifactSummary`: the latest-version metadata kept in the snapshot.
pub fn artifact_summary(value: Option<&Value>, limits: &Limits) -> Option<Obj> {
    let record = plain(value)?;
    let id = str_field(record, "id")?;
    let kind = str_field(record, "kind")?;
    if !ARTIFACT_KINDS.contains(&kind.as_str()) {
        return None;
    }
    let version = record.get("version")?.as_f64()?;
    if !is_integer(version) || version < 1.0 {
        return None;
    }
    let mut out = Obj::new();
    out.insert(
        "id".into(),
        Value::String(bounded(&id, limits.max_artifact_id_length)),
    );
    out.insert("kind".into(), Value::String(kind));
    if let Some(title) = str_field(record, "title") {
        out.insert(
            "title".into(),
            Value::String(bounded(&title, limits.max_artifact_title_length)),
        );
    }
    let capped = (version as u64).min(limits.max_artifact_versions);
    out.insert("version".into(), Value::from(capped));
    if let Some(content_type) = str_field(record, "contentType") {
        out.insert(
            "contentType".into(),
            Value::String(bounded(&content_type, 128)),
        );
    }
    if let Some(bytes) = js_number(record.get("bytes")).filter(|b| is_integer(*b) && *b >= 0.0) {
        out.insert("bytes".into(), number_value(bytes));
    }
    if record.get("primary") == Some(&Value::Bool(true)) {
        out.insert("primary".into(), Value::Bool(true));
    }
    Some(out)
}

/// `artifact-published`: upsert by artifact id, keeping the existing `itemCount`.
pub fn reduce_artifact_published(mut run: Obj, payload: &Obj, derived: &Derived<'_>) -> Obj {
    let Some(summary) = artifact_summary(payload.get("artifact"), derived.limits) else {
        return run;
    };
    let artifacts: Vec<Obj> = run
        .get("artifacts")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|a| a.as_object().cloned())
                .collect()
        })
        .unwrap_or_default();
    let id = summary
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let (next, truncated) = if let Some(index) = artifacts
        .iter()
        .position(|a| a.get("id").and_then(Value::as_str) == Some(id.as_str()))
    {
        let mut entry = summary;
        if let Some(count) = artifacts[index].get("itemCount").cloned() {
            entry.insert("itemCount".into(), count);
        }
        let mut next = artifacts.clone();
        next[index] = entry;
        (next, false)
    } else if artifacts.len() >= PRODUCTION.max_artifacts {
        (artifacts, true)
    } else {
        let mut next = artifacts;
        next.push(summary);
        (next, false)
    };
    put_list(&mut run, "artifacts", next);
    if truncated || truncated_flag(&run) {
        run.insert("truncated".into(), Value::Bool(true));
    }
    run
}

fn bounded_question_text(text: &str) -> String {
    ellipsized(text, PRODUCTION.max_question_length)
}

/// `escalation-raised`: a pending question, upserted by `qid`.
pub fn reduce_escalation_raised(mut run: Obj, payload: &Obj, _derived: &Derived<'_>) -> Obj {
    let (Some(qid), Some(question)) = (str_field(payload, "qid"), str_field(payload, "question"))
    else {
        return run;
    };
    let actor_ref = instance_ref(payload.get("actor"));
    let actor_name = bounded_name(
        str_field(payload, "actorName"),
        PRODUCTION.max_actor_name_length,
    );
    let context = str_field(payload, "context");
    let asked_at = payload
        .get("askedAt")
        .filter(|v| js_number(Some(v)).is_some_and(f64::is_finite))
        .cloned();
    let mut pending = Obj::new();
    pending.insert("qid".into(), Value::String(qid.clone()));
    if let Some(actor) = &actor_ref {
        pending.insert("actorSiteId".into(), Value::String(actor.site_id.clone()));
        pending.insert("actorOrdinal".into(), ordinal_value(actor));
    }
    if let Some(name) = actor_name {
        pending.insert("actorName".into(), Value::String(name));
    }
    pending.insert(
        "question".into(),
        Value::String(bounded_question_text(&question)),
    );
    if let Some(context) = context {
        pending.insert(
            "context".into(),
            Value::String(bounded_question_text(&context)),
        );
    }
    if let Some(at) = asked_at {
        pending.insert("askedAt".into(), at);
    }

    let existing: Vec<Obj> = run
        .get("pendingQuestions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_object().cloned())
                .collect()
        })
        .unwrap_or_default();
    let (next, truncated) = if let Some(index) = existing
        .iter()
        .position(|item| item.get("qid").and_then(Value::as_str) == Some(qid.as_str()))
    {
        let mut next = existing.clone();
        next[index] = pending;
        (next, false)
    } else if existing.len() >= PRODUCTION.max_pending_questions {
        (existing, true)
    } else {
        let mut next = existing;
        next.push(pending);
        (next, false)
    };
    put_list(&mut run, "pendingQuestions", next);
    if truncated || truncated_flag(&run) {
        run.insert("truncated".into(), Value::Bool(true));
    }
    run
}

/// `withoutPendingQuestions`: drops the entries the predicate rejects, and the key when none remain.
pub fn without_pending_questions(mut run: Obj, keep: impl Fn(&Obj) -> bool) -> Obj {
    let Some(current) = run
        .get("pendingQuestions")
        .and_then(Value::as_array)
        .cloned()
    else {
        return run;
    };
    let remaining: Vec<Value> = current
        .iter()
        .filter(|item| item.as_object().is_some_and(&keep))
        .cloned()
        .collect();
    if remaining.len() == current.len() {
        return run;
    }
    if remaining.is_empty() {
        run.shift_remove("pendingQuestions");
    } else {
        run.insert("pendingQuestions".into(), Value::Array(remaining));
    }
    run
}

/// `run-settled`: the terminal state. Clears what cannot be answered any more, and normalises the
/// status vocabulary (unknown values become errored, with the text kept).
pub fn reduce_run_settled(run: Obj, payload: &Obj) -> Obj {
    let status = payload.get("status");
    let message = plain(payload.get("error"))
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let cleared =
        without_waiting_holes(without_cooldown(without_pending_questions(run, |_| false)));
    let carried_stop = if status.and_then(Value::as_str) == Some("stopped") {
        payload
            .get("stopReason")
            .and_then(Value::as_str)
            .filter(|reason| STOP_REASONS.contains(reason))
            .map(str::to_string)
    } else {
        None
    };
    let superseded_by = if carried_stop.as_deref() == Some("superseded") {
        str_field(payload, "supersededBy")
    } else {
        None
    };
    let status_text = status.and_then(Value::as_str);
    let terminal = matches!(
        status_text,
        Some("completed") | Some("errored") | Some("stopped")
    );
    let settled_message = if terminal {
        message
    } else {
        Some(message.unwrap_or_else(|| {
            format!(
                "run settled with an unrecognized status: {}",
                js_string(status)
            )
        }))
    };
    let mut next = cleared;
    next.insert(
        "status".into(),
        Value::String(if terminal {
            status_text.unwrap_or("errored").to_string()
        } else {
            "errored".to_string()
        }),
    );
    if let Some(reason) = carried_stop {
        next.insert("stopReason".into(), Value::String(reason));
    }
    if let Some(by) = superseded_by {
        next.insert("supersededBy".into(), Value::String(by));
    }
    if let Some(text) = settled_message {
        next.insert(
            "error".into(),
            Value::String(bounded(&text, PRODUCTION.max_error_length)),
        );
    }
    if payload.get("resumable") == Some(&Value::Bool(true)) {
        next.insert("resumable".into(), Value::Bool(true));
    }
    with_derived_statuses(next)
}

/// `Derived` and the constructors above are used by the replay as well. Kept for the tests.
pub fn same_json(left: &Value, right: &Value) -> bool {
    json_equal(left, right)
}
