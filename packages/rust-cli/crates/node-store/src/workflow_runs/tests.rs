//! Reducer, delta and replay tests (W3). Red first: the goldens come from Node's reducer
//! (`scripts/rust-cli/workflow-runs-goldens.ts`); the drift guard in
//! `packages/shared/src/zcode-protocol-v4/workflow-runs-goldens.test.ts` keeps the file current.

use std::time::Duration;

use serde_json::{Value, json};

use super::delta::{apply_all, diff};
use super::js::{ellipsized, json_equal, utf16_len, utf16_prefix};
use super::projection;
use super::replay::{mint_actor_session_id, replay_envelopes, replay_state};
use super::{Envelope, Limits, PRODUCTION, State, reduce};
use crate::repo::dwf::{self, RunRecord, RunStatus, StoredEvent};

const GOLDENS: &str = include_str!("../../fixtures/workflow-runs/goldens.json");

fn serialize(state: &State) -> String {
    serde_json::to_string(&state.to_value()).expect("state serializes")
}

fn limits_from(value: &Value) -> Limits {
    if value.is_null() {
        return PRODUCTION;
    }
    let read = |key: &str| value.get(key).and_then(Value::as_u64).expect("entry limit") as usize;
    PRODUCTION.with_entry_limits(read("maxActors"), read("maxNodes"), read("maxPhases"))
}

/// Node's golden: every step must match Node's reducer and delta byte for byte.
#[test]
fn node_goldens_reproduce_state_and_deltas_byte_for_byte() {
    let file: Value = serde_json::from_str(GOLDENS).expect("goldens parse");
    assert_eq!(file["schema"], json!(1));
    let scenarios = file["scenarios"].as_array().expect("scenarios");
    assert_eq!(
        scenarios.len(),
        5,
        "the scenario set is part of the contract"
    );
    let mut checked_states = 0usize;
    let mut checked_ops = 0usize;
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let limits = limits_from(&scenario["limits"]);
        eprintln!(
            "golden scenario {name}: {} steps",
            scenario["steps"].as_array().unwrap().len()
        );
        let mut prior: Option<State> = None;
        for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let envelope = Envelope::from_value(&step["envelope"]);
            let next = reduce(prior.as_ref(), &envelope, &limits);
            let changed = step["changed"].as_bool().unwrap();
            assert_eq!(next.is_some(), changed, "{name} step {index}: change flag");
            let Some(next) = next else {
                assert_eq!(step["ops"].as_str().unwrap(), "[]", "{name} step {index}");
                continue;
            };
            let ops = diff(prior.as_ref(), &next);
            let ops_text = serde_json::to_string(&Value::Array(ops.clone())).unwrap();
            assert_eq!(
                step["ops"].as_str().unwrap(),
                ops_text,
                "{name} step {index}: ops"
            );
            checked_ops += 1;
            if let Some(expected) = step["state"].as_str() {
                assert_eq!(expected, serialize(&next), "{name} step {index}: state");
                checked_states += 1;
            }
            // The property: applying the delta to the prior state reproduces the next state, byte for byte.
            let applied = apply_all(prior.as_ref(), &ops).expect("ops apply to a state");
            assert_eq!(
                serialize(&applied),
                serialize(&next),
                "{name} step {index}: applyAll(prior, diff) == next"
            );
            prior = Some(next);
        }
    }
    assert!(checked_states > 100, "states compared: {checked_states}");
    assert!(checked_ops > 300, "ops compared: {checked_ops}");
}

/// The eviction, unlisted and truncation paths are actually reached by the goldens (otherwise the
/// byte checks above prove nothing about them).
#[test]
fn goldens_reach_eviction_unlisted_and_truncation() {
    let file: Value = serde_json::from_str(GOLDENS).unwrap();
    let mut removals = 0;
    let mut cleared = 0;
    let mut truncated_states = 0;
    let mut unlisted_states = 0;
    let mut whole_key = 0;
    for scenario in file["scenarios"].as_array().unwrap() {
        for step in scenario["steps"].as_array().unwrap() {
            let ops: Vec<Value> = serde_json::from_str(step["ops"].as_str().unwrap()).unwrap();
            for op in &ops {
                match op["op"].as_str() {
                    Some("workflowRun.removed") => removals += 1,
                    Some("state.updated") => whole_key += 1,
                    _ => {}
                }
                if op.get("removedActors").is_some() || op.get("removedNodes").is_some() {
                    removals += 1;
                }
                if op.get("cleared").is_some() {
                    cleared += 1;
                }
            }
            if let Some(state) = step["state"].as_str() {
                let value: Value = serde_json::from_str(state).unwrap();
                for run in value["runs"].as_array().unwrap() {
                    if run.get("truncated") == Some(&json!(true)) {
                        truncated_states += 1;
                    }
                    if run.get("unlistedByPhase").is_some() {
                        unlisted_states += 1;
                    }
                }
            }
        }
    }
    assert!(removals > 0, "removals");
    assert!(cleared > 0, "cleared keys");
    assert!(truncated_states > 0, "truncated runs");
    assert!(unlisted_states > 0, "unlisted buckets");
    assert_eq!(whole_key, 0, "no step falls back to a whole-key patch");
}

/// Seeded pseudo-random streams: `applyAll(prior, diff(prior, next)) == next` at every changed step,
/// under production and tiny limits. The generator is xorshift64, so the stream is the same on every run.
#[test]
fn property_apply_of_diff_reproduces_next_for_random_streams() {
    for &(seed, limits) in &[
        (1u64, PRODUCTION),
        (2, PRODUCTION.with_entry_limits(4, 4, 3)),
        (3, PRODUCTION.with_entry_limits(2, 3, 2)),
        (4, PRODUCTION.with_entry_limits(5, 6, 4)),
    ] {
        let mut rng = Xorshift(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let mut prior: Option<State> = None;
        let mut sequence = 0.0;
        let mut changed_steps = 0;
        for _ in 0..600 {
            sequence += 1.0;
            let envelope = random_envelope(&mut rng, sequence);
            let Some(next) = reduce(prior.as_ref(), &envelope, &limits) else {
                continue;
            };
            let ops = diff(prior.as_ref(), &next);
            let applied = apply_all(prior.as_ref(), &ops).expect("ops apply");
            assert_eq!(serialize(&applied), serialize(&next), "seed {seed}");
            changed_steps += 1;
            prior = Some(next);
        }
        assert!(
            changed_steps > 100,
            "seed {seed} changed {changed_steps} steps"
        );
    }
}

struct Xorshift(u64);

impl Xorshift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn random_envelope(rng: &mut Xorshift, sequence: f64) -> Envelope {
    let actor_ordinal = rng.below(10) + 1;
    let ask_ordinal = rng.below(25) + 1;
    let phases = ["Survey", "Write", "Review"];
    let phase = phases[rng.below(3) as usize];
    let actor = json!({"siteId": "agent#1", "ordinal": actor_ordinal});
    let instance = json!({"siteId": "ask#1", "ordinal": ask_ordinal});
    let (event, payload) = match rng.below(12) {
        0 => (
            "actor-created",
            json!({"actor": actor, "name": format!("a{actor_ordinal}"), "phaseName": phase}),
        ),
        1 | 2 => (
            "node-queued",
            json!({"instance": instance, "actor": actor, "kind": "ask", "phaseName": phase}),
        ),
        3 => (
            "node-dispatched",
            json!({"instance": instance, "actor": actor, "actorName": format!("a{actor_ordinal}")}),
        ),
        4 => ("node-executing", json!({"instance": instance})),
        5 => (
            "node-progress",
            json!({"instance": instance, "turn": rng.below(9) + 1, "toolCalls": rng.below(30), "lastTool": {"name": "Bash", "target": "ls"}}),
        ),
        6 => (
            "node-settled",
            json!({"instance": instance, "actor": actor, "outcome": "ok", "cached": rng.below(4) == 0, "sourceSessionId": "sess-x"}),
        ),
        7 => (
            "report",
            json!({"instance": {"siteId": "report#1", "ordinal": rng.below(70) + 1}, "item": {"n": ask_ordinal}}),
        ),
        8 => (
            "escalation-raised",
            json!({"qid": format!("q-{}", rng.below(5)), "question": "why", "actor": actor, "actorName": "a"}),
        ),
        9 => ("usage-updated", json!({"spentTokens": sequence as u64 * 7})),
        10 => (
            "phase-entered",
            json!({"name": phase, "ordinal": rng.below(3) + 1}),
        ),
        _ => ("node-waiting", json!({"instance": instance})),
    };
    let mut full = payload.as_object().unwrap().clone();
    full.insert("type".into(), json!(event));
    Envelope {
        run_id: Some("dwfrun-r".into()),
        tool_call_id: Some("tc".into()),
        sequence: Some(sequence),
        event_type: Some(event.into()),
        payload: Some(full.into_iter().filter(|(k, _)| k != "type").collect()),
        actor_session_id: None,
    }
}

/// `JS .length` counts UTF-16 units; a cut that would split an emoji rounds down.
#[test]
fn truncation_counts_utf16_units_and_never_splits_a_pair() {
    let emoji = "a😀b"; // 1 + 2 + 1 UTF-16 units
    assert_eq!(utf16_len(emoji), 4);
    assert_eq!(
        utf16_prefix(emoji, 2),
        "a",
        "a cut inside the pair rounds down"
    );
    assert_eq!(utf16_prefix(emoji, 3), "a😀");
    // ellipsized(limit): slice(0, limit - 1) + "…" when longer than the limit.
    assert_eq!(ellipsized("abcd", 4), "abcd");
    assert_eq!(ellipsized("abcde", 4), "abc…");
    assert_eq!(
        ellipsized("ab😀😀", 4),
        "ab…",
        "limit-1 = 3 units lands inside a pair: round down"
    );
}

#[test]
fn json_equality_ignores_key_order_and_treats_five_and_five_point_zero_alike() {
    let left = json!({"a": 5, "b": [1, {"x": "y"}]});
    let right: Value = serde_json::from_str(r#"{"b":[1,{"x":"y"}],"a":5.0}"#).unwrap();
    assert!(json_equal(&left, &right));
    assert!(!json_equal(&json!({"a": 5}), &json!({"a": 6})));
    assert!(!json_equal(&json!({"a": 5}), &json!({"a": 5, "b": null})));
}

/// Canonical run key order follows the schema, whatever order the reducer appended keys in.
#[test]
fn run_keys_are_canonical_after_reduction() {
    let envelope = |event: &str, payload: Value, seq: f64| Envelope {
        run_id: Some("r1".into()),
        tool_call_id: Some("tc".into()),
        sequence: Some(seq),
        event_type: Some(event.into()),
        payload: payload.as_object().cloned(),
        actor_session_id: None,
    };
    let mut state = reduce(
        None,
        &envelope(
            "run-started",
            json!({"caps": {"maxConcurrency": 2}, "concurrencyCeiling": 4}),
            1.0,
        ),
        &PRODUCTION,
    )
    .unwrap();
    state = reduce(
        Some(&state),
        &envelope("usage-updated", json!({"spentTokens": 9}), 2.0),
        &PRODUCTION,
    )
    .unwrap();
    let keys: Vec<&String> = state.runs[0].keys().collect();
    assert_eq!(keys.first().map(|k| k.as_str()), Some("runId"));
    let position = |name: &str| keys.iter().position(|k| k.as_str() == name).unwrap();
    assert!(position("status") < position("usage"));
    assert!(position("usage") < position("concurrency"));
    assert!(position("concurrency") < position("concurrencyCeiling"));
    assert_eq!(keys.last().map(|k| k.as_str()), Some("lastEventSequence"));
}

/// A replayed event (same sequence) is a semantic no-op: no state, no delta, no revision bump.
#[test]
fn replayed_events_are_idempotent() {
    let event = Envelope {
        run_id: Some("r1".into()),
        tool_call_id: None,
        sequence: Some(3.0),
        event_type: Some("actor-created".into()),
        payload: json!({"actor": {"siteId": "a", "ordinal": 1}, "name": "x"})
            .as_object()
            .cloned(),
        actor_session_id: Some("s".into()),
    };
    let first = reduce(None, &event, &PRODUCTION).unwrap();
    assert!(reduce(Some(&first), &event, &PRODUCTION).is_none());
}

/// Invalid envelopes change nothing: no runId, no eventType.
#[test]
fn invalid_envelopes_are_no_ops() {
    let missing_run = Envelope {
        run_id: None,
        event_type: Some("run-started".into()),
        ..Envelope::default()
    };
    assert!(reduce(None, &missing_run, &PRODUCTION).is_none());
    let missing_type = Envelope {
        run_id: Some("r".into()),
        ..Envelope::default()
    };
    assert!(reduce(None, &missing_type, &PRODUCTION).is_none());
}

/// Empty snapshot stays what Rust answers today when no run exists.
#[test]
fn projection_snapshot_is_the_empty_answer_without_a_run() {
    assert_eq!(projection::snapshot(None), json!({"runs": []}));
    assert_eq!(
        projection::snapshot(Some(&State::default())),
        json!({"runs": []})
    );
    let envelope = Envelope {
        run_id: Some("r1".into()),
        event_type: Some("run-started".into()),
        payload: json!({}).as_object().cloned(),
        ..Envelope::default()
    };
    let (state, ops) =
        projection::on_progress(None, &envelope, &PRODUCTION).expect("a run is born");
    assert_eq!(ops.len(), 1);
    assert_eq!(
        projection::snapshot(Some(&state))["runs"][0]["runId"],
        json!("r1")
    );
}

// ---- Cold replay from dwf_event through the W2 repository ----

fn database() -> rusqlite::Connection {
    let (conn, _) =
        crate::repo::open::open(std::path::Path::new(":memory:"), Duration::from_secs(1), 0)
            .expect("in-memory session database with every Node migration");
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values ('parent', 'proj', null, 'parent', '/work', 'title', '0.0.0', 1, 1)",
        [],
    )
    .expect("parent session row");
    conn
}

fn run_row(status: RunStatus) -> RunRecord {
    RunRecord {
        run_id: "dwfrun-1".into(),
        parent_session_id: Some("parent".into()),
        tool_call_id: Some("tc-1".into()),
        max_concurrency: 4,
        status,
        ..RunRecord::default()
    }
}

fn stored_events(conn: &rusqlite::Connection, events: &[Value]) -> Vec<StoredEvent> {
    dwf::create_run(conn, &run_row(RunStatus::Pending), 1).unwrap();
    for event in events {
        dwf::append_event(conn, "dwfrun-1", event, 5).unwrap();
    }
    dwf::list_events(conn, "dwfrun-1").unwrap()
}

fn journal() -> Vec<Value> {
    vec![
        json!({"type": "run-launched", "inputId": "in-1", "phaseNames": ["Survey"], "modelBindings": {"fast": "claude-haiku"}, "subagentModel": "claude-sonnet"}),
        json!({"type": "run-started", "caps": {"maxConcurrency": 4}}),
        json!({"type": "actor-created", "actor": {"siteId": "agent#1", "ordinal": 1}, "name": "scout", "persona": {"model": "fast"}, "phaseName": "Survey"}),
        json!({"type": "node-queued", "instance": {"siteId": "ask#1", "ordinal": 1}, "actor": {"siteId": "agent#1", "ordinal": 1}, "kind": "ask", "phaseName": "Survey"}),
        json!({"type": "node-dispatched", "instance": {"siteId": "ask#1", "ordinal": 1}, "actor": {"siteId": "agent#1", "ordinal": 1}, "actorName": "scout", "actorPersonaModel": "fast"}),
        json!({"type": "hole-reached", "instance": {"siteId": "hole#00000001", "ordinal": 1}, "name": "Verdict"}),
        json!({"type": "node-settled", "instance": {"siteId": "ask#1", "ordinal": 1}, "actor": {"siteId": "agent#1", "ordinal": 1}, "outcome": "ok"}),
    ]
}

#[test]
fn replay_mints_the_derived_fields_the_live_path_sends() {
    let conn = database();
    let events = stored_events(&conn, &journal());
    let run = run_row(RunStatus::Running);
    let envelopes = replay_envelopes(&run, &events, 8.0);
    assert_eq!(envelopes.len(), 7);

    let session = mint_actor_session_id("dwfrun-1", "agent#1", 1.0);
    assert_eq!(session, "sess_dwf-dwfrun-1-agent_1_1");
    // run-started carries the launch's subagent model and the default concurrency ceiling.
    let started = envelopes[1].payload.as_ref().unwrap();
    assert_eq!(started["concurrencyCeiling"], json!(8));
    assert_eq!(started["subagentModel"], json!("claude-sonnet"));
    // actor-created: persona model resolved through the bindings; the envelope names the session.
    assert_eq!(
        envelopes[2].payload.as_ref().unwrap()["model"],
        json!("claude-haiku")
    );
    assert_eq!(
        envelopes[2].actor_session_id.as_deref(),
        Some(session.as_str())
    );
    // node-dispatched: actorModel resolved the same way.
    assert_eq!(
        envelopes[4].payload.as_ref().unwrap()["actorModel"],
        json!("claude-haiku")
    );
    // hole-reached: reachedAt is the journal's time_created; `type` is not minted (W4).
    assert_eq!(
        envelopes[5].payload.as_ref().unwrap()["reachedAt"],
        json!(5)
    );
    assert!(envelopes[5].payload.as_ref().unwrap().get("type").is_none());
}

#[test]
fn replay_settles_a_terminal_run_from_the_row() {
    let conn = database();
    // A stopped row with superseded: the trailing run-settled in the journal is replaced by the row.
    let mut events = journal();
    events.push(json!({"type": "run-settled", "status": "cancelled", "stopReason": "user"}));
    let stored = stored_events(&conn, &events);
    let run = RunRecord {
        status: RunStatus::Stopped,
        stop_reason: Some(dwf::StopReason::Superseded),
        superseded_by: Some("dwfrun-2".into()),
        ..run_row(RunStatus::Stopped)
    };
    let envelopes = replay_envelopes(&run, &stored, 8.0);
    let last = envelopes.last().unwrap();
    assert_eq!(last.event_type.as_deref(), Some("run-settled"));
    let payload = last.payload.as_ref().unwrap();
    assert_eq!(payload["status"], json!("stopped"));
    assert_eq!(payload["stopReason"], json!("superseded"));
    assert_eq!(payload["supersededBy"], json!("dwfrun-2"));
    assert!(
        payload.get("resumable").is_none(),
        "superseded is not resumable"
    );
    assert_eq!(
        last.sequence,
        Some(stored.last().unwrap().sequence as f64),
        "the replaced settlement keeps its sequence"
    );
}

#[test]
fn replay_state_is_the_fold_of_the_replayed_envelopes() {
    let conn = database();
    let stored = stored_events(&conn, &journal());
    let run = run_row(RunStatus::Completed);
    let state = replay_state(&run, &stored, 8.0, &PRODUCTION).expect("replay yields a run");
    let value = state.to_value();
    let record = &value["runs"][0];
    assert_eq!(record["status"], json!("completed"));
    assert_eq!(
        record["actors"][0]["sessionId"],
        json!("sess_dwf-dwfrun-1-agent_1_1")
    );
    assert_eq!(record["actors"][0]["model"], json!("claude-haiku"));
    assert_eq!(record["nodes"][0]["phase"], json!("settled"));
    // Every envelope replayed, the state and its delta agree (the same property as live).
    let mut prior: Option<State> = None;
    for envelope in replay_envelopes(&run, &stored, 8.0) {
        if let Some(next) = reduce(prior.as_ref(), &envelope, &PRODUCTION) {
            let ops = diff(prior.as_ref(), &next);
            assert_eq!(
                serialize(&apply_all(prior.as_ref(), &ops).unwrap()),
                serialize(&next)
            );
            prior = Some(next);
        }
    }
    assert_eq!(serialize(&prior.unwrap()), serialize(&state));
}

#[test]
fn payload_bounds_cut_strings_arrays_and_depth_as_the_contracts_do() {
    let long = "x".repeat(3000);
    let items: Vec<Value> = (0..40).map(|i| json!(i)).collect();
    let payload = json!({
        "text": long,
        "items": items,
        "deep": {"a": {"b": {"c": {"d": {"e": {"f": "too deep"}}}}}},
    });
    let bounded = super::replay::bound_payload(payload.as_object().unwrap());
    assert_eq!(bounded["text"].as_str().unwrap().len(), 2048);
    assert_eq!(bounded["items"].as_array().unwrap().len(), 32);
    // Depth 0 is the payload; `deep.a.b.c.d` sits at depth 5 and is kept; `e` would be at depth 6 and is dropped.
    assert!(bounded["deep"]["a"]["b"]["c"]["d"].get("e").is_none());
    assert!(bounded["deep"]["a"]["b"]["c"].get("d").is_some());
}

/// Entry budget and the run cut, which the Node goldens do not record (the fixture would be too large).
/// Nine runs of 400 actors and 400 nodes: 8 x 800 = 6400 entries > 6144, so the oldest terminal run
/// is evicted, and the run cut drops the first run. Checked by the delta property at sampled steps
/// and at the end; the eviction itself is asserted.
#[test]
fn wide_fan_out_hits_the_entry_budget_and_the_run_cut() {
    let mut prior: Option<State> = None;
    let mut sequence = 0.0;
    let mut removed_runs = 0usize;
    let mut step = 0usize;
    let envelope = |run: usize, event: &str, payload: Value, seq: f64| Envelope {
        run_id: Some(format!("dwfrun-{run}")),
        tool_call_id: Some(format!("tc-{run}")),
        sequence: Some(seq),
        event_type: Some(event.into()),
        payload: payload.as_object().cloned(),
        actor_session_id: None,
    };
    for run in 1..=9usize {
        let mut events = vec![envelope(
            run,
            "run-started",
            json!({"caps": {"maxConcurrency": 4}, "concurrencyCeiling": 8}),
            {
                sequence += 1.0;
                sequence
            },
        )];
        for ordinal in 1..=400u64 {
            let actor = json!({"siteId": "agent#1", "ordinal": ordinal});
            let instance = json!({"siteId": "ask#1", "ordinal": ordinal});
            events.push(envelope(
                run,
                "actor-created",
                json!({"actor": actor, "name": "a", "phaseName": "Survey"}),
                0.0,
            ));
            events.push(envelope(
                run,
                "node-queued",
                json!({"instance": instance, "actor": actor, "kind": "ask", "phaseName": "Survey"}),
                0.0,
            ));
            if ordinal % 2 == 0 {
                events.push(envelope(
                    run,
                    "node-settled",
                    json!({"instance": instance, "actor": actor, "outcome": "ok"}),
                    0.0,
                ));
            }
        }
        events.push(envelope(
            run,
            "run-settled",
            json!({"status": "completed"}),
            0.0,
        ));
        for mut event in events {
            if event.sequence == Some(0.0) {
                sequence += 1.0;
                event.sequence = Some(sequence);
            }
            step += 1;
            let Some(next) = reduce(prior.as_ref(), &event, &PRODUCTION) else {
                continue;
            };
            if step.is_multiple_of(97) {
                let ops = diff(prior.as_ref(), &next);
                let applied = apply_all(prior.as_ref(), &ops).expect("ops apply");
                assert_eq!(serialize(&applied), serialize(&next), "step {step}");
            }
            if let Some(prev) = &prior {
                removed_runs += prev.runs.len().saturating_sub(next.runs.len());
            }
            prior = Some(next);
        }
    }
    let state = prior.expect("state");
    assert!(
        removed_runs > 0,
        "a terminal run was evicted by the entry budget or the run cut"
    );
    assert!(state.runs.len() <= PRODUCTION.max_runs);
    let total: usize = state
        .runs
        .iter()
        .map(|r| {
            r.get("actors")
                .and_then(Value::as_array)
                .map_or(0, Vec::len)
                + r.get("nodes").and_then(Value::as_array).map_or(0, Vec::len)
        })
        .sum();
    assert!(
        total <= PRODUCTION.max_total_entries,
        "entries {total} within the budget"
    );
    let last = state.runs.last().unwrap();
    assert_eq!(last["runId"], json!("dwfrun-9"));
    assert_eq!(last["status"], json!("completed"));
    assert_eq!(
        serialize(&apply_all(None, &diff(None, &state)).unwrap()),
        serialize(&state)
    );
}
