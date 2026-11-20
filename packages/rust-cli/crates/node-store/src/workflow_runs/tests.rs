//! Reducer, delta and replay tests (W3). Red first: the goldens come from Node's reducer
//! (`scripts/rust-cli/workflow-runs-goldens.ts`); the drift guard in
//! `packages/shared/src/zcode-protocol-v4/workflow-runs-goldens.test.ts` keeps the file current.

use std::time::Duration;

use serde_json::{Value, json};

use std::borrow::Cow;

use super::delta::{apply_all, diff};
use super::js::{ellipsized, json_equal, utf8_json_len, utf16_len, utf16_prefix};
use super::projection::{self, LiveProjection};
use super::publish::{LEGACY_MAX_ENTRIES, clamp_for_legacy, encode_for_legacy, growth_upper_bound};
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
        let mut state = State::default();
        for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let envelope = Envelope::from_value(&step["envelope"]);
            let before = state.clone();
            // The ops come from the reducer itself (W7-0: reduce mutates `state` in place).
            let ops = reduce(&mut state, &envelope, &limits);
            let changed = step["changed"].as_bool().unwrap();
            assert_eq!(ops.is_some(), changed, "{name} step {index}: change flag");
            let Some(ops) = ops else {
                assert_eq!(step["ops"].as_str().unwrap(), "[]", "{name} step {index}");
                assert_eq!(
                    serialize(&state),
                    serialize(&before),
                    "{name} step {index}: a no-op leaves the state byte-identical"
                );
                continue;
            };
            let ops_text = serde_json::to_string(&Value::Array(ops.clone())).unwrap();
            assert_eq!(
                step["ops"].as_str().unwrap(),
                ops_text,
                "{name} step {index}: ops"
            );
            // The returned ops are the same as the diff of the two states (the oracle).
            assert_eq!(
                ops,
                diff(Some(&before), &state),
                "{name} step {index}: oracle"
            );
            checked_ops += 1;
            if let Some(expected) = step["state"].as_str() {
                assert_eq!(expected, serialize(&state), "{name} step {index}: state");
                checked_states += 1;
            }
            // The property: applying the delta to the prior state reproduces the next state, byte for byte.
            let applied = apply_all(Some(&before), &ops).expect("ops apply to a state");
            assert_eq!(
                serialize(&applied),
                serialize(&state),
                "{name} step {index}: applyAll(prior, ops) == next"
            );
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
        let mut state = State::default();
        let mut sequence = 0.0;
        let mut changed_steps = 0;
        for _ in 0..600 {
            sequence += 1.0;
            let envelope = random_envelope(&mut rng, sequence);
            let before = state.clone();
            let Some(ops) = reduce(&mut state, &envelope, &limits) else {
                assert_eq!(serialize(&state), serialize(&before), "seed {seed}: no-op");
                continue;
            };
            assert_eq!(ops, diff(Some(&before), &state), "seed {seed}: oracle");
            let applied = apply_all(Some(&before), &ops).expect("ops apply");
            assert_eq!(serialize(&applied), serialize(&state), "seed {seed}");
            changed_steps += 1;
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
    let mut state = State::default();
    reduce(
        &mut state,
        &envelope(
            "run-started",
            json!({"caps": {"maxConcurrency": 2}, "concurrencyCeiling": 4}),
            1.0,
        ),
        &PRODUCTION,
    )
    .unwrap();
    reduce(
        &mut state,
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
    let mut state = State::default();
    assert!(reduce(&mut state, &event, &PRODUCTION).is_some());
    let first = serialize(&state);
    assert!(reduce(&mut state, &event, &PRODUCTION).is_none());
    assert_eq!(
        serialize(&state),
        first,
        "the replay left the state as it was"
    );
}

/// Invalid envelopes change nothing: no runId, no eventType.
#[test]
fn invalid_envelopes_are_no_ops() {
    let missing_run = Envelope {
        run_id: None,
        event_type: Some("run-started".into()),
        ..Envelope::default()
    };
    let mut state = State::default();
    assert!(reduce(&mut state, &missing_run, &PRODUCTION).is_none());
    let missing_type = Envelope {
        run_id: Some("r".into()),
        ..Envelope::default()
    };
    assert!(reduce(&mut state, &missing_type, &PRODUCTION).is_none());
    assert_eq!(state, State::default());
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
    let mut live = LiveProjection::new(PRODUCTION);
    let ops = live.apply(&envelope).expect("a run is born");
    assert_eq!(ops.len(), 1);
    assert_eq!(live.snapshot()["runs"][0]["runId"], json!("r1"));
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
    let mut folded = State::default();
    for envelope in replay_envelopes(&run, &stored, 8.0) {
        let before = folded.clone();
        if let Some(ops) = reduce(&mut folded, &envelope, &PRODUCTION) {
            assert_eq!(ops, diff(Some(&before), &folded));
            assert_eq!(
                serialize(&apply_all(Some(&before), &ops).unwrap()),
                serialize(&folded)
            );
        }
    }
    assert_eq!(serialize(&folded), serialize(&state));
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
/// The reducer cost grows with the size of the run it rebuilds on every event, so the full-size fixture
/// (400 actors and 400 nodes per run, about 118 s in debug) runs at 1/16 scale here: nine runs of 50
/// actors and 50 nodes, against a budget of 6144 / 16 = 384. 8 x 100 = 800 > 384, so the oldest terminal
/// run is evicted by the budget, and the run cut drops the first run. The real constant is pinned at
/// full scale by `production_entry_budget_evicts_at_full_scale`.
#[test]
fn wide_fan_out_hits_the_entry_budget_and_the_run_cut() {
    let limits = Limits {
        max_total_entries: PRODUCTION.max_total_entries / 16,
        ..PRODUCTION
    };
    let mut state = State::default();
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
        for ordinal in 1..=50u64 {
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
            let runs_before = state.runs.len();
            let before = (step.is_multiple_of(97)).then(|| state.clone());
            let Some(ops) = reduce(&mut state, &event, &limits) else {
                continue;
            };
            if let Some(before) = before {
                assert_eq!(ops, diff(Some(&before), &state), "step {step}: oracle");
                let applied = apply_all(Some(&before), &ops).expect("ops apply");
                assert_eq!(serialize(&applied), serialize(&state), "step {step}");
            }
            removed_runs += runs_before.saturating_sub(state.runs.len());
        }
    }
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
        total <= limits.max_total_entries,
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

/// The production budget at full scale, checked on the eviction function directly with the run lists
/// built in bulk (no reducer events, so it is fast): nine completed runs of 400 actors and 400 nodes,
/// 9 x 800 = 7200 > 6144. The oldest terminal runs leave until the total fits (dwfrun-1 and dwfrun-2,
/// leaving 5600); the event run (dwfrun-9) is never evicted.
#[test]
fn production_entry_budget_evicts_at_full_scale() {
    assert_eq!(PRODUCTION.max_total_entries, 6144);
    let run = |n: u64| -> super::js::Obj {
        let actors: Vec<Value> = (1..=400u64)
            .map(|o| json!({"siteId": "agent#1", "ordinal": o}))
            .collect();
        let nodes: Vec<Value> = (1..=400u64)
            .map(|o| json!({"siteId": "ask#1", "ordinal": o}))
            .collect();
        json!({"runId": format!("dwfrun-{n}"), "status": "completed", "actors": actors, "nodes": nodes})
            .as_object()
            .unwrap()
            .clone()
    };
    let runs: Vec<super::js::Obj> = (1..=9u64).map(run).collect();
    let kept =
        super::eviction::evict_for_entry_budget(runs, "dwfrun-9", PRODUCTION.max_total_entries);
    let ids: Vec<String> = kept
        .iter()
        .map(|r| r["runId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        ids,
        (3..=9u64)
            .map(|n| format!("dwfrun-{n}"))
            .collect::<Vec<_>>()
    );
    let total: usize = kept
        .iter()
        .map(|r| r["actors"].as_array().unwrap().len() + r["nodes"].as_array().unwrap().len())
        .sum();
    assert_eq!(total, 5600);
    assert!(total <= PRODUCTION.max_total_entries);
}

/// Node `sanitizeIdSegment` maps each UTF-16 code unit, so an astral character (two units) becomes two
/// underscores (`dwfrun-😀x` gives `dwfrun-__x`). Golden: `scripts/rust-cli/workflow-driver-goldens.ts`.
#[test]
fn an_astral_character_in_a_run_id_maps_to_two_underscores_as_node_does() {
    assert_eq!(
        mint_actor_session_id("dwfrun-😀x", "x.y-z", 10.0),
        "sess_dwf-dwfrun-__x-x.y-z_10"
    );
}

// ---- W7-0: in-place reduction, the LiveProjection holder, and the publisher rules ----

fn event_for(run: &str, event: &str, payload: Value, sequence: f64) -> Envelope {
    Envelope {
        run_id: Some(run.into()),
        tool_call_id: Some(format!("tc-{run}")),
        sequence: Some(sequence),
        event_type: Some(event.into()),
        payload: payload.as_object().cloned(),
        actor_session_id: None,
    }
}

/// An event for one run leaves the other runs alone: the reducer rebuilds only the run it touches.
/// The heap buffer of another run's `nodes` array is the same before and after (a clone would move it).
#[test]
fn an_event_for_one_run_does_not_rebuild_the_other_runs() {
    let mut state = State::default();
    reduce(
        &mut state,
        &event_for("r1", "run-started", json!({}), 1.0),
        &PRODUCTION,
    )
    .unwrap();
    let queued = json!({"instance": {"siteId": "ask#1", "ordinal": 1}, "kind": "ask", "phaseName": "Survey"});
    reduce(
        &mut state,
        &event_for("r1", "node-queued", queued, 2.0),
        &PRODUCTION,
    )
    .unwrap();
    let nodes = state.runs[0]["nodes"].as_array().unwrap();
    assert!(!nodes.is_empty(), "the buffer under test is not empty");
    let buffer = nodes.as_ptr();

    reduce(
        &mut state,
        &event_for("r2", "run-started", json!({}), 3.0),
        &PRODUCTION,
    )
    .unwrap();
    assert_eq!(state.runs.len(), 2);
    assert_eq!(state.runs[0]["runId"], json!("r1"));
    assert_eq!(
        state.runs[0]["nodes"].as_array().unwrap().as_ptr(),
        buffer,
        "r1 was not rebuilt"
    );
}

/// Node `countLongerUpserts`: nodes that a longer entry replaced in place during this step.
fn count_longer_upserts(prior: Option<&State>, next: &State) -> usize {
    let (Some(before), Some(after)) = (prior.and_then(|s| s.runs.first()), next.runs.first())
    else {
        return 0;
    };
    let nodes_of = |run: &super::js::Obj| -> Vec<Value> {
        run.get("nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let before_nodes = nodes_of(before);
    nodes_of(after)
        .iter()
        .filter(|node| {
            before_nodes
                .iter()
                .find(|old| old["siteId"] == node["siteId"] && old["ordinal"] == node["ordinal"])
                .is_some_and(|old| utf8_json_len(node) > utf8_json_len(old))
        })
        .count()
}

/// Node `evictionEnvelopes()` (conversation-workflow-run-deltas.test.ts): one run that keeps hitting
/// the entry budget. Named ask groups (eviction victims), unowned world reads (free nodes), a
/// `lastTool.target` that grows (longer upserts), and a cached-settlement tail (orphans).
fn node_eviction_envelopes() -> Vec<Envelope> {
    let mut out: Vec<Envelope> = Vec::new();
    let mut push = |event_type: &str, payload: Value| {
        let sequence = out.len() as f64;
        out.push(Envelope {
            run_id: Some("dwfrun-1".into()),
            tool_call_id: Some("tc-1".into()),
            sequence: Some(sequence),
            event_type: Some(event_type.into()),
            payload: payload.as_object().cloned(),
            actor_session_id: None,
        });
    };
    push("run-started", json!({"runId": "dwfrun-1"}));
    for ordinal in 1..=40u64 {
        let actor = json!({"siteId": "agent#1", "ordinal": ordinal});
        let instance = json!({"siteId": "ask#1", "ordinal": ordinal});
        let phase_name = format!("phase-{}", ordinal % 5);
        push(
            "actor-created",
            json!({"actor": actor, "name": format!("agent-{ordinal}"), "phaseName": phase_name}),
        );
        push(
            "node-queued",
            json!({"instance": instance, "actor": actor, "kind": "ask", "phaseName": phase_name}),
        );
        push("node-dispatched", json!({"instance": instance}));
        push("node-executing", json!({"instance": instance}));
        let target = "t".repeat(((ordinal * 5) % 64) as usize);
        push(
            "node-progress",
            json!({"instance": instance, "turn": ordinal, "toolCalls": ordinal * 3, "lastTool": {"name": "Bash", "target": target}}),
        );
        if ordinal % 4 == 0 {
            let world = json!({"siteId": "world#1", "ordinal": ordinal});
            push(
                "node-queued",
                json!({"instance": world, "kind": "world-read"}),
            );
            push("node-settled", json!({"instance": world, "outcome": "ok"}));
        }
        let outcome = if ordinal % 9 == 0 { "failed" } else { "ok" };
        push(
            "node-settled",
            json!({"instance": instance, "outcome": outcome}),
        );
    }
    push("run-started", json!({"runId": "dwfrun-1"}));
    for ordinal in 1..=10u64 {
        push(
            "node-settled",
            json!({
                "instance": {"siteId": "ask#1", "ordinal": ordinal},
                "actor": {"siteId": "agent#1", "ordinal": ordinal},
                "cached": true,
                "outcome": "ok",
                "phaseName": format!("phase-{}", ordinal % 5),
            }),
        );
    }
    out
}

/// Node: `eviction stream` growth and key-level checks (conversation-workflow-run-deltas.test.ts,
/// 腾位事件流). Every step is a key-level delta, the growth bound covers the growth, and each of the
/// three shapes (removals, a header key born, a longer upsert) actually occurs.
#[test]
fn node_eviction_stream_every_step_is_key_level_and_within_the_growth_bound() {
    let limits = PRODUCTION.with_entry_limits(4, 4, 3);
    let mut state = State::default();
    let (mut removals, mut header_born, mut longer_upserts, mut fallbacks) =
        (0usize, 0usize, 0usize, 0usize);
    for envelope in node_eviction_envelopes() {
        let prior = (state.revision > 0).then(|| state.clone());
        let Some(ops) = reduce(&mut state, &envelope, &limits) else {
            continue;
        };
        assert_eq!(
            ops,
            diff(prior.as_ref(), &state),
            "the reducer's ops are the diff"
        );
        let prior_len = prior.as_ref().map_or(0, |p| utf8_json_len(&p.to_value()));
        let growth = utf8_json_len(&state.to_value()) as isize - prior_len as isize;
        match growth_upper_bound(&ops) {
            None => fallbacks += 1,
            Some(bound) => {
                assert!(
                    bound as isize >= growth,
                    "bound {bound} covers growth {growth}"
                );
                let ops_len = utf8_json_len(&Value::Array(ops.clone()));
                assert!(
                    ops_len as isize >= growth,
                    "ops {ops_len} cover growth {growth}"
                );
            }
        }
        longer_upserts += count_longer_upserts(prior.as_ref(), &state);
        for op in &ops {
            if op["op"] != json!("workflowRun.updated") {
                continue;
            }
            if op.get("removedActors").is_some() || op.get("removedNodes").is_some() {
                removals += 1;
            }
            if op["run"].get("unlistedByPhase").is_some() || op["run"].get("truncated").is_some() {
                header_born += 1;
            }
        }
    }
    assert!(removals > 0, "a removal happened");
    assert!(header_born > 0, "a header key was born");
    assert!(longer_upserts > 0, "a longer entry replaced a shorter one");
    assert_eq!(fallbacks, 0, "no step fell back to a whole-key patch");
    assert_eq!(state.runs[0]["truncated"], json!(true));
    assert!(
        state.runs[0]["unlistedByPhase"]
            .as_array()
            .is_some_and(|grid| !grid.is_empty())
    );
}

/// Consumer check: the holder's deltas, applied to a consumer copy, keep the copy equal to the holder
/// after every step, including the snapshot a client reads. Covers the entry budget (tiny limits) and
/// the run cut (ten runs at production limits, so the oldest runs leave).
#[test]
fn live_projection_deltas_keep_a_consumer_equal_to_the_holder() {
    let mut evicting = LiveProjection::new(PRODUCTION.with_entry_limits(4, 4, 3));
    let mut consumer: Option<State> = None;
    assert!(
        State::from_value(&evicting.snapshot()).is_none(),
        "an empty snapshot is not a state"
    );
    let mut removed_ops = 0usize;
    for envelope in node_eviction_envelopes() {
        let Some(ops) = evicting.apply(&envelope) else {
            continue;
        };
        removed_ops += ops
            .iter()
            .filter(|op| {
                op["op"] == json!("workflowRun.removed")
                    || op.get("removedActors").is_some()
                    || op.get("removedNodes").is_some()
            })
            .count();
        consumer = apply_all(consumer.as_ref(), &ops);
        assert_eq!(projection::snapshot(consumer.as_ref()), evicting.snapshot());
    }
    assert!(removed_ops > 0, "the budget evicted entries");

    let mut cut = LiveProjection::new(PRODUCTION);
    let mut consumer: Option<State> = None;
    let mut run_removals = 0usize;
    for run in 1..=10usize {
        for envelope in [
            event_for(
                &format!("dwfrun-{run}"),
                "run-started",
                json!({}),
                run as f64 * 2.0 - 1.0,
            ),
            event_for(
                &format!("dwfrun-{run}"),
                "run-settled",
                json!({"status": "completed"}),
                run as f64 * 2.0,
            ),
        ] {
            let Some(ops) = cut.apply(&envelope) else {
                continue;
            };
            run_removals += ops
                .iter()
                .filter(|op| op["op"] == json!("workflowRun.removed"))
                .count();
            consumer = apply_all(consumer.as_ref(), &ops);
            assert_eq!(projection::snapshot(consumer.as_ref()), cut.snapshot());
        }
    }
    assert_eq!(cut.state().runs.len(), PRODUCTION.max_runs);
    assert_eq!(
        run_removals,
        10 - PRODUCTION.max_runs,
        "the oldest runs were cut"
    );
}

/// A holder seeded from a cold replay continues the fold: the next event's deltas take the seeded
/// consumer to the holder's state.
#[test]
fn a_live_projection_seeded_from_replay_continues_the_fold() {
    let conn = database();
    let stored = stored_events(&conn, &journal());
    let run = run_row(RunStatus::Running);
    let seed = replay_state(&run, &stored, 8.0, &PRODUCTION).expect("replay yields a run");
    let mut live = LiveProjection::from_state(seed.clone(), PRODUCTION);
    let next = event_for(
        "dwfrun-1",
        "usage-updated",
        json!({"spentTokens": 42}),
        100.0,
    );
    let ops = live.apply(&next).expect("a new event changes the run");
    let consumer = apply_all(Some(&seed), &ops).expect("ops apply to the seed");
    assert_eq!(serialize(&consumer), serialize(live.state()));
    assert_eq!(live.state().runs[0]["usage"]["spentTokens"], json!(42));
}

/// A run object for a seed; `run_id` is `None` for a run with no `runId` key.
fn seed_run(run_id: Option<Value>, ordinal: u64) -> super::js::Obj {
    let mut run = json!({
        "status": "running",
        "usage": {"spentTokens": 0, "nodesUsed": 0},
        "actors": [],
        "nodes": [],
        "lastEventSequence": ordinal,
    })
    .as_object()
    .unwrap()
    .clone();
    if let Some(id) = run_id {
        run.insert("runId".into(), id);
    }
    run
}

/// Whatever the seed, the holder's state meets the contract `reduce` relies on (at most `max_runs`
/// runs, each with a string `runId`), and the next event's ops are exactly `diff` between the two
/// states.
fn assert_seed_meets_the_reducer_contract(seed: State, envelope: &Envelope) {
    let mut live = LiveProjection::from_state(seed, PRODUCTION);
    let before = live.state().clone();
    assert!(
        before.runs.len() <= PRODUCTION.max_runs,
        "at most max_runs runs, found {}",
        before.runs.len()
    );
    assert!(
        before
            .runs
            .iter()
            .all(|run| run.get("runId").and_then(Value::as_str).is_some()),
        "every run has a string runId"
    );
    let ops = live.apply(envelope).expect("the event changes the run");
    assert_eq!(
        ops,
        diff(Some(&before), live.state()),
        "the ops are the diff of the two states"
    );
}

/// Over the run limit: the event is for the oldest run, which the run-count cut drains in the same
/// step. Without normalising the seed, the ops carry a `removed` and an `updated` for that run.
#[test]
fn a_seed_over_the_run_limit_is_brought_within_it_before_the_first_event() {
    let runs: Vec<super::js::Obj> = (1..=10u64)
        .map(|n| seed_run(Some(json!(format!("dwfrun-{n}"))), n))
        .collect();
    let seed = State { revision: 10, runs };
    let event = event_for(
        "dwfrun-1",
        "usage-updated",
        json!({"spentTokens": 5}),
        100.0,
    );
    assert_seed_meets_the_reducer_contract(seed, &event);
}

/// A run with no `runId` (and one with a non-string id) cannot be addressed by `reduce`, but `diff`
/// would still report it as `removed` with an empty id. The holder drops such runs at the seed.
#[test]
fn a_seed_run_without_a_string_run_id_is_dropped_before_the_first_event() {
    let runs = vec![
        seed_run(None, 1),
        seed_run(Some(json!(7)), 2),
        seed_run(Some(json!("dwfrun-2")), 3),
    ];
    let seed = State { revision: 3, runs };
    let event = event_for(
        "dwfrun-2",
        "usage-updated",
        json!({"spentTokens": 9}),
        100.0,
    );
    assert_seed_meets_the_reducer_contract(seed, &event);
}

/// Encoding for old consumers, Node `encodeConversationDeltasForLegacy`: a batch with no run deltas
/// comes back as the same slice.
#[test]
fn a_batch_without_run_deltas_comes_back_as_the_same_slice() {
    let deltas = vec![
        row_op(),
        json!({"op": "state.updated", "patch": {"revision": 3}}),
    ];
    let encoded = encode_for_legacy(&deltas, Some(&run_state(2, 0)));
    assert!(matches!(encoded, Cow::Borrowed(_)));
    assert!(std::ptr::eq(encoded.as_ptr(), deltas.as_ptr()));
}

/// Node: a batch of run deltas becomes one whole-key patch, placed at the last dropped op's position,
/// carrying the current projection rather than an intermediate state.
#[test]
fn a_batch_of_run_deltas_folds_into_one_whole_key_patch_at_the_last_dropped_position() {
    let tail = json!({"op": "state.updated", "patch": {"revision": 9}});
    let deltas = vec![
        updated_op("dwfrun-1", 5),
        row_op(),
        updated_op("dwfrun-1", 6),
        json!({"op": "workflowRun.removed", "runId": "dwfrun-2", "revision": 7}),
        tail.clone(),
    ];
    let encoded = encode_for_legacy(&deltas, Some(&run_state(2, 0)));
    let ops: Vec<&str> = encoded
        .iter()
        .map(|op| op["op"].as_str().unwrap())
        .collect();
    assert_eq!(ops, vec!["row.appended", "state.updated", "state.updated"]);
    assert_eq!(encoded[0], deltas[1]);
    assert_eq!(encoded[2], tail);
    let whole = &encoded[1]["patch"]["workflowRuns"];
    assert_eq!(whole["revision"], json!(7));
    assert_eq!(whole["runs"][0]["nodes"].as_array().unwrap().len(), 2);
}

/// Node: a table over the legacy bound (256) is cut to 256, keeping the live entries first and the
/// earliest rest in table order, and the run is marked `truncated`.
#[test]
fn an_over_legacy_table_is_cut_to_256_and_marked_truncated() {
    let state = run_state(LEGACY_MAX_ENTRIES + 40, 300);
    let batch = [updated_op("dwfrun-1", 8)];
    let encoded = encode_for_legacy(&batch, Some(&state));
    let run = &encoded[0]["patch"]["workflowRuns"]["runs"][0];
    assert_eq!(run["nodes"].as_array().unwrap().len(), LEGACY_MAX_ENTRIES);
    assert_eq!(run["actors"].as_array().unwrap().len(), LEGACY_MAX_ENTRIES);
    assert_eq!(run["truncated"], json!(true));
    assert_eq!(run["nodes"][0]["ordinal"], json!(1));
    assert_eq!(
        run["nodes"][LEGACY_MAX_ENTRIES - 1]["ordinal"],
        json!(LEGACY_MAX_ENTRIES)
    );
}

/// Node: a state within the legacy bound is returned as it is (no copy, no `truncated`).
#[test]
fn a_state_within_the_legacy_bound_is_returned_as_it_is() {
    let state = run_state(3, 3);
    assert!(matches!(clamp_for_legacy(&state), Cow::Borrowed(_)));
}

/// Node: with no `workflowRuns` key to replace, the run deltas are dropped and nothing is inserted.
#[test]
fn without_a_workflow_runs_key_the_run_deltas_are_dropped_and_nothing_is_inserted() {
    let batch = [row_op(), updated_op("dwfrun-1", 1)];
    let encoded = encode_for_legacy(&batch, None);
    assert_eq!(encoded.to_vec(), vec![row_op()]);
}

/// Node: a key-level batch's growth bound is above the batch's own bytes.
#[test]
fn an_all_key_level_batch_has_a_growth_bound_above_its_own_bytes() {
    let deltas = vec![updated_op("dwfrun-1", 5), updated_op("dwfrun-2", 6)];
    let bound = growth_upper_bound(&deltas).expect("every op is key-level");
    assert!(bound > serde_json::to_string(&deltas).unwrap().len());
}

/// Node: any other op in the batch forces an exact measurement.
#[test]
fn any_other_op_in_the_batch_forces_an_exact_measurement() {
    assert_eq!(
        growth_upper_bound(&[updated_op("dwfrun-1", 5), row_op()]),
        None
    );
}

/// Node: an empty batch takes the fast path, with room for a wider `seq` (16 digits).
#[test]
fn an_empty_batch_takes_the_fast_path_with_room_for_a_wider_seq() {
    let bound = growth_upper_bound(&[]).expect("an empty batch is key-level");
    assert!(bound > String::from("9007199254740991").len());
}

/// Node: a whole-key `workflowRuns` patch never takes the fast path, because its bytes are not a bound
/// on growth.
#[test]
fn a_whole_key_workflow_runs_patch_is_never_on_the_fast_path() {
    let whole =
        json!({"op": "state.updated", "patch": {"workflowRuns": run_state(300, 0).to_value()}});
    assert_eq!(growth_upper_bound(std::slice::from_ref(&whole)), None);
    assert_eq!(
        growth_upper_bound(&[updated_op("dwfrun-1", 5), whole]),
        None
    );
}

fn updated_op(run_id: &str, revision: u64) -> Value {
    json!({"op": "workflowRun.updated", "runId": run_id, "revision": revision, "run": {"lastEventSequence": revision}})
}

fn row_op() -> Value {
    json!({"op": "row.appended", "row": {"rowId": 1, "kind": "assistantText", "turnId": "turn-1", "text": "hi", "streaming": false, "createdAt": 0}})
}

/// A state with one run of `node_count` live nodes and `actor_count` idle actors (Node `runState`).
fn run_state(node_count: usize, actor_count: usize) -> State {
    let actors: Vec<Value> = (1..=actor_count)
        .map(|ordinal| json!({"siteId": "actor#1", "ordinal": ordinal, "status": "idle"}))
        .collect();
    let nodes: Vec<Value> = (1..=node_count)
        .map(|ordinal| json!({"siteId": "ask#1", "ordinal": ordinal, "phase": "dispatched"}))
        .collect();
    let run = json!({
        "runId": "dwfrun-1",
        "status": "running",
        "usage": {"spentTokens": 0, "nodesUsed": node_count},
        "actors": actors,
        "nodes": nodes,
        "lastEventSequence": node_count,
    });
    State {
        revision: 7,
        runs: vec![run.as_object().unwrap().clone()],
    }
}
