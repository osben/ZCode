//! Replays the resume, amend and world-row scenarios recorded from Node's engine and import builder
//! (`scripts/rust-cli/workflow-import-goldens.ts`, fixture `import-goldens.json`; specs/fork-rust-workflow-engine.md
//! section 9.5).
//!
//! A scenario is a sequence of runs on one journal, in the order the generator ran them. For each run that imports
//! from a predecessor, the build is computed from the journal the same way the generator did (preflight, then the
//! build with the transcript counts of the scenario). Compared with Node, per scenario: each lifetime's build result,
//! step results, constructor error, run row, node rows, actor rows and dispose count; the settlements of asks and
//! world reads in settlement order; the driver calls in call order (session seeds included); and every event's
//! sequence and exact payload text.
use crate::canon::canonical_json;
use crate::engine::{
    AskMessage, AskSpec, AskStats, EngineConfig, SubmitVerdict, WorkflowDriver, WorkflowEngine,
};
use crate::engine_world::world_read_driver_error;
use crate::error::WorkflowError;
use crate::event::RunEvent;
use crate::import_build::{
    BuildOptions, BuildOutcome, build_imported_cache, build_json, preflight_amend_import,
    preflight_json,
};
use crate::imported_cache::{ActorSessionSeed, ImportedRunCache};
use crate::journal::{JournalPort, MemoryJournal};
use crate::journal_dwf::DwfJournal;
use crate::model::{ActorRow, Caps, NodeRow, Ref, StopReason, Violation};
use anyhow::Result;
use rust_cli_node_store::open_session_database;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

const GOLDENS: &str = include_str!("../fixtures/import-goldens.json");

/// What the driver saw, shared with the harness (the engine takes the driver by value).
#[derive(Default)]
struct State {
    calls: Vec<Value>,
    disposed: u64,
    run_id: String,
    /// Instances of the live world reads started since the last take, in call order.
    started_world: Vec<Ref>,
}

#[derive(Clone, Default)]
struct Recording(Rc<RefCell<State>>);

impl WorkflowDriver for Recording {
    fn create_actor_session(
        &mut self,
        actor: &Ref,
        _persona: &Value,
        seed: Option<&ActorSessionSeed>,
    ) -> Result<String> {
        let mut state = self.0.borrow_mut();
        state.calls.push(json!({
            "op": "createActorSession",
            "actor": actor.key(),
            "seed": seed.map_or(Value::Null, seed_json),
        }));
        Ok(format!("sess:{}/{}", state.run_id, actor.key()))
    }

    fn start_ask(&mut self, session: &str, instance: &Ref, message: &AskMessage) {
        self.0.borrow_mut().calls.push(json!({
            "op": "startAsk",
            "session": session,
            "instance": instance.key(),
            "instructions": message.instructions,
            "typed": message.typed,
        }));
    }

    fn respond_to_submit(&mut self, instance: &Ref, verdict: &SubmitVerdict) {
        let verdict = match verdict {
            SubmitVerdict::Accept => json!({"kind": "accept"}),
            SubmitVerdict::Nudge => json!({"kind": "nudge"}),
            SubmitVerdict::Reject { violations } => json!({
                "kind": "reject",
                "violations": violations.iter().map(Violation::to_json).collect::<Vec<_>>(),
            }),
        };
        self.0.borrow_mut().calls.push(json!({
            "op": "respondToSubmit",
            "instance": instance.key(),
            "verdict": verdict,
        }));
    }

    fn cancel_ask(&mut self, instance: &Ref) {
        self.0
            .borrow_mut()
            .calls
            .push(json!({"op": "cancelAsk", "instance": instance.key()}));
    }

    fn start_world_read(&mut self, instance: &Ref, op: &str, args: &Value) {
        let mut state = self.0.borrow_mut();
        state
            .calls
            .push(json!({"op": "executeWorldRead", "worldOp": op, "args": args}));
        state.started_world.push(instance.clone());
    }

    fn emit(&mut self, _event: &RunEvent) {}

    fn dispose(&mut self) {
        self.0.borrow_mut().disposed += 1;
    }
}

fn seed_json(seed: &ActorSessionSeed) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("sourceSessionId".into(), json!(seed.source_session_id));
    map.insert("messageCount".into(), json!(seed.message_count));
    if let Some(model) = &seed.resolved_model {
        map.insert("resolvedModel".into(), json!(model));
    }
    Value::Object(map)
}

/// The test validator: a string schema accepts strings only (the generator's rule).
fn validate(schema: &Value, value: &Value) -> Vec<Violation> {
    if schema.get("type").and_then(Value::as_str) == Some("string") && !value.is_string() {
        let got = match value {
            Value::Null => "null",
            Value::Array(_) => "array",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Object(_) => "object",
        };
        return vec![Violation {
            path: "$".into(),
            expected: "string".into(),
            got: got.into(),
        }];
    }
    Vec::new()
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().expect(key).to_owned()
}

fn optional_text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn ref_of(value: &Value) -> Ref {
    Ref::new(
        text(value, "site"),
        value["ordinal"].as_u64().expect("ordinal"),
    )
}

fn stats_of(value: &Value) -> AskStats {
    AskStats {
        tokens: value["tokens"].as_f64().expect("tokens"),
        tool_calls: value["toolCalls"].as_f64().expect("toolCalls"),
        turns: value["turns"].as_f64().expect("turns"),
        world_tool_calls: value.get("worldToolCalls").and_then(Value::as_f64),
    }
}

fn outcome_json(tag: &str, result: &Result<Value, WorkflowError>) -> Value {
    match result {
        Ok(value) => json!({"tag": tag, "ok": true, "value": value}),
        Err(error) => json!({"tag": tag, "ok": false, "error": error.to_json()}),
    }
}

/// Ticket and world-call bookkeeping of one lifetime. A world read's instance is taken from the driver right after
/// the call, since the driver is called synchronously in the step (the generator's `currentTag`).
#[derive(Default)]
struct Tags {
    by_ticket: HashMap<u64, String>,
    world: HashMap<String, (Ref, String, Value)>,
}

fn run_step<J: JournalPort, D: WorkflowDriver>(
    engine: &mut WorkflowEngine<J, D>,
    step: &Value,
    tags: &mut Tags,
    recording: &Recording,
) -> Value {
    match text(step, "op").as_str() {
        "createActor" => {
            let name = optional_text(step, "name");
            let persona = step.get("persona");
            match engine.create_actor(&text(step, "site"), name.as_deref(), persona) {
                Ok(id) => json!({"actorId": id}),
                Err(error) => {
                    let error = error
                        .downcast_ref::<WorkflowError>()
                        .expect("createActor refuses with a workflow error");
                    json!({"error": error.to_json()})
                }
            }
        }
        "ask" => {
            let ticket = engine
                .ask(
                    &text(step, "site"),
                    &text(step, "actor"),
                    &text(step, "instructions"),
                )
                .expect("ask");
            tags.by_ticket.insert(ticket, text(step, "tag"));
            Value::Null
        }
        "worldRead" => {
            let args: Vec<Value> = step["args"].as_array().expect("args").clone();
            recording.0.borrow_mut().started_world.clear();
            let ticket = engine
                .world_read(&text(step, "site"), &text(step, "worldOp"), args.clone())
                .expect("worldRead");
            let tag = text(step, "tag");
            tags.by_ticket.insert(ticket, tag.clone());
            let started = recording.0.borrow_mut().started_world.pop();
            if let Some(instance) = started {
                tags.world
                    .insert(tag, (instance, text(step, "worldOp"), Value::Array(args)));
            }
            Value::Null
        }
        "worldDone" => {
            let tag = text(step, "tag");
            let (instance, op, args) = tags
                .world
                .remove(&tag)
                .expect("a live world read for this tag");
            let result = if step.get("ok").and_then(Value::as_bool) == Some(true) {
                Ok(step["value"].clone())
            } else {
                Err(world_read_driver_error(&op, &args))
            };
            engine
                .world_read_settled(&instance, result)
                .expect("worldDone");
            Value::Null
        }
        "askMutating" => {
            engine
                .ask_mutating(&ref_of(&step["at"]))
                .expect("askMutating");
            Value::Null
        }
        "setBoundary" => {
            engine
                .set_message_boundary(
                    &ref_of(&step["at"]),
                    step["boundary"].as_u64().expect("boundary"),
                )
                .expect("setBoundary");
            Value::Null
        }
        "submit" => {
            // The generator ends the turn right after a submit, so the ask settles.
            engine
                .submit_attempted(&ref_of(&step["at"]), step["payload"].clone())
                .expect("submit");
            engine
                .turn_ended(&ref_of(&step["at"]), "")
                .expect("turnEnded");
            Value::Null
        }
        "stats" => {
            engine
                .ask_stats(&ref_of(&step["at"]), stats_of(&step["stats"]))
                .expect("stats");
            Value::Null
        }
        "complete" => {
            engine.complete(step["artifact"].clone()).expect("complete");
            Value::Null
        }
        "stop" => {
            let reason = StopReason::parse(&text(step, "reason")).expect("stop reason");
            engine.stop(reason, None, None).expect("stop");
            Value::Null
        }
        other => panic!("unknown golden op {other}"),
    }
}

fn caps_of(lifetime: &Value) -> Caps {
    Caps {
        max_concurrency: lifetime["caps"].as_f64().expect("caps"),
    }
}

fn ask_specs() -> HashMap<String, AskSpec> {
    let string_schema = json!({"type": "string"});
    HashMap::from([
        (
            "ask#1".to_owned(),
            AskSpec {
                typed: true,
                schema: Some(string_schema.clone()),
            },
        ),
        (
            "ask#2".to_owned(),
            AskSpec {
                typed: true,
                schema: Some(string_schema),
            },
        ),
        (
            "free#1".to_owned(),
            AskSpec {
                typed: false,
                schema: None,
            },
        ),
    ])
}

/// Sorted by canonical text, so the comparison does not depend on the journal's row order.
fn sorted_rows(rows: Vec<Value>) -> Value {
    let mut rows = rows;
    rows.sort_by_key(canonical_json);
    Value::Array(rows)
}

/// The lifetime with its node and actor rows in canonical order, so the row order of a journal does not count.
fn normalized(lifetime: &Value) -> Value {
    let mut lifetime = lifetime.clone();
    for key in ["nodes", "actors"] {
        if let Some(rows) = lifetime[key].as_array().cloned() {
            lifetime[key] = sorted_rows(rows);
        }
    }
    lifetime
}

/// Replays one scenario and returns the observations in the golden's shape.
fn replay<J: JournalPort>(scenario: &Value, journal: &mut J) -> Value {
    let counts: HashMap<String, u64> = scenario["input"]
        .get("transcriptCounts")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(session, count)| (session.clone(), count.as_u64().expect("count")))
                .collect()
        })
        .unwrap_or_default();
    let recording = Recording::default();
    let mut outcomes: Vec<Value> = Vec::new();
    let mut runs: Vec<Value> = Vec::new();
    for run in scenario["input"]["runs"].as_array().expect("runs") {
        let run_id = text(run, "runId");
        let import_from = optional_text(run, "importFrom");
        let mut lifetimes: Vec<Value> = Vec::new();
        for lifetime in run["lifetimes"].as_array().expect("lifetimes") {
            recording.0.borrow_mut().run_id = run_id.clone();
            let mut build = Value::Null;
            let mut imported: Option<ImportedRunCache> = None;
            if let Some(from) = &import_from {
                let count_of = |session: &str| counts.get(session).copied();
                let options = BuildOptions {
                    count: Some(&count_of),
                    quiet_sessions: None,
                };
                let preflight = preflight_amend_import(&*journal, from).expect("preflight");
                let built = build_imported_cache(&*journal, from, options).expect("build");
                build = json!({
                    "preflight": preflight_json(&preflight),
                    "built": build_json(&built),
                });
                if let BuildOutcome::Built { cache, .. } = built {
                    imported = Some(cache);
                }
            }
            let config = EngineConfig {
                run_id: run_id.clone(),
                caps: caps_of(lifetime),
                ask_specs: ask_specs(),
                validate,
                imported_cache: imported,
                resumed_from: import_from.clone(),
                ..EngineConfig::default()
            };
            let steps = lifetime["steps"].as_array().expect("steps");
            let mut tags = Tags::default();
            let mut results: Vec<Value> = Vec::new();
            let mut construct_error = None;
            match WorkflowEngine::new(config, &mut *journal, recording.clone()) {
                Err(error) => {
                    let error = error
                        .downcast_ref::<WorkflowError>()
                        .expect("constructor refuses with a workflow error");
                    construct_error = Some(error.to_json());
                    results = vec![Value::Null; steps.len()];
                }
                Ok(mut engine) => {
                    // The generator flushes once after construction, before the first step.
                    engine.drain().expect("drain");
                    for outcome in engine.take_outcomes() {
                        let tag = tags.by_ticket.get(&outcome.ticket).expect("tagged").clone();
                        outcomes.push(outcome_json(&tag, &outcome.result));
                    }
                    for step in steps {
                        results.push(run_step(&mut engine, step, &mut tags, &recording));
                        engine.drain().expect("drain");
                        for outcome in engine.take_outcomes() {
                            let tag = tags.by_ticket.get(&outcome.ticket).expect("tagged").clone();
                            outcomes.push(outcome_json(&tag, &outcome.result));
                        }
                    }
                }
            }
            let run_row = journal
                .get_run(&run_id)
                .expect("get_run")
                .map_or(Value::Null, |row| row.to_json());
            let nodes = journal.list_nodes(&run_id).expect("list_nodes");
            let actors = journal.list_actors(&run_id).expect("list_actors");
            let disposed = std::mem::take(&mut recording.0.borrow_mut().disposed);
            let mut lifetime_json = serde_json::Map::new();
            lifetime_json.insert("build".into(), build);
            if let Some(error) = construct_error {
                lifetime_json.insert("constructError".into(), error);
            }
            lifetime_json.insert("results".into(), Value::Array(results));
            lifetime_json.insert("run".into(), run_row);
            lifetime_json.insert(
                "nodes".into(),
                sorted_rows(nodes.iter().map(NodeRow::to_json).collect()),
            );
            lifetime_json.insert(
                "actors".into(),
                sorted_rows(actors.iter().map(ActorRow::to_json).collect()),
            );
            lifetime_json.insert("disposed".into(), json!(disposed));
            lifetimes.push(Value::Object(lifetime_json));
        }
        runs.push(json!({"runId": run_id, "lifetimes": lifetimes}));
    }
    let mut events = Vec::new();
    for run in scenario["input"]["runs"].as_array().expect("runs") {
        let run_id = text(run, "runId");
        for stored in journal.list_events(&run_id).expect("list_events") {
            events.push(json!({
                "runId": run_id,
                "sequence": stored.sequence,
                "payloadJson": stored.payload_json,
            }));
        }
    }
    let driver_calls = recording.0.borrow().calls.clone();
    json!({
        "name": scenario["name"],
        "runs": runs,
        "outcomes": outcomes,
        "driverCalls": driver_calls,
        "events": events,
    })
}

fn scenarios() -> Vec<Value> {
    let goldens: Value = serde_json::from_str(GOLDENS).expect("golden file parses");
    goldens["scenarios"].as_array().expect("scenarios").clone()
}

/// Compares one scenario part by part, so a mismatch names the part that differs.
fn check(scenario: &Value, actual: &Value) {
    let name = scenario["name"].as_str().expect("name");
    let expected_runs = scenario["runs"].as_array().expect("runs");
    let actual_runs = actual["runs"].as_array().expect("runs");
    assert_eq!(actual_runs.len(), expected_runs.len(), "{name}: run count");
    for (index, (got, want)) in actual_runs.iter().zip(expected_runs).enumerate() {
        let got_lifetimes = got["lifetimes"].as_array().expect("lifetimes");
        let want_lifetimes = want["lifetimes"].as_array().expect("lifetimes");
        assert_eq!(
            got_lifetimes.len(),
            want_lifetimes.len(),
            "{name}: run {index} lifetime count"
        );
        for (life, (got, want)) in got_lifetimes.iter().zip(want_lifetimes).enumerate() {
            assert_eq!(
                canonical_json(&normalized(got)),
                canonical_json(&normalized(want)),
                "{name}: run {index} lifetime {life}"
            );
        }
    }
    assert_eq!(
        canonical_json(&actual["outcomes"]),
        canonical_json(&scenario["outcomes"]),
        "{name}: settlements in settlement order"
    );
    assert_eq!(
        canonical_json(&actual["driverCalls"]),
        canonical_json(&scenario["driverCalls"]),
        "{name}: driver calls"
    );
    assert_eq!(
        actual["events"], scenario["events"],
        "{name}: events (sequence and payload text)"
    );
}

#[test]
fn memory_journal_matches_node_for_every_import_scenario() {
    for scenario in scenarios() {
        let mut journal = MemoryJournal::new();
        let actual = replay(&scenario, &mut journal);
        check(&scenario, &actual);
    }
}

#[test]
fn dwf_journal_matches_node_for_every_import_scenario() {
    for scenario in scenarios() {
        let (conn, _) = open_session_database(Path::new(":memory:"), Duration::from_secs(1), 0)
            .expect("session database with every Node migration");
        let mut journal = DwfJournal::new(&conn, || 0);
        let actual = replay(&scenario, &mut journal);
        check(&scenario, &actual);
    }
}
