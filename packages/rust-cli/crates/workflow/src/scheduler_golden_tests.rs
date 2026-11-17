//! Replays the scheduler and replay scenarios recorded from Node's `WorkflowEngine`
//! (`scripts/rust-cli/workflow-scheduler-goldens.ts`, fixture `scheduler-goldens.json`).
//!
//! Each scenario runs once per lifetime (a resumed lifetime is a new engine over the same journal). Every
//! step is followed by `drain`, as the generator flushes between steps. Compared with Node, per scenario:
//! the step results, the constructor error, the run, node and actor rows after each lifetime, the ask
//! settlements in settlement order, the driver calls in call order, and every event's sequence and exact
//! payload text.
use crate::canon::canonical_json;
use crate::engine::{
    AskSpec, AskStats, EngineConfig, SubmitVerdict, WorkflowDriver, WorkflowEngine,
};
use crate::error::{ErrorCode, WorkflowError};
use crate::event::RunEvent;
use crate::journal::{JournalPort, MemoryJournal};
use crate::journal_dwf::DwfJournal;
use crate::model::{ActorRow, Caps, NodeRow, Ref, StopReason, Violation};
use anyhow::Result;
use rust_cli_node_store::open_session_database;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

const GOLDENS: &str = include_str!("../fixtures/scheduler-goldens.json");

/// Records the driver calls and the emitted events, as Node's test driver does.
#[derive(Default)]
struct Recording {
    calls: Vec<Value>,
    emitted: Vec<String>,
    disposed: u64,
}

impl WorkflowDriver for Recording {
    fn create_actor_session(&mut self, actor: &Ref, _persona: &Value) -> Result<String> {
        self.calls
            .push(json!({"op": "createActorSession", "actor": actor.key()}));
        Ok(format!("sess:{}", actor.key()))
    }

    fn start_ask(&mut self, session: &str, instance: &Ref, message: &crate::engine::AskMessage) {
        self.calls.push(json!({
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
        self.calls.push(json!({
            "op": "respondToSubmit",
            "instance": instance.key(),
            "verdict": verdict,
        }));
    }

    fn cancel_ask(&mut self, instance: &Ref) {
        self.calls
            .push(json!({"op": "cancelAsk", "instance": instance.key()}));
    }

    fn emit(&mut self, event: &RunEvent) {
        self.emitted.push(event.payload_json());
    }

    fn dispose(&mut self) {
        self.disposed += 1;
    }
}

/// The test validator: a `{type: "string"}` schema accepts strings only (same rule as the generator).
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

fn error_of(value: &Value) -> WorkflowError {
    let code = ErrorCode::parse(&text(value, "code")).expect("golden error code");
    WorkflowError::new(code, text(value, "message"))
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

/// Runs one step and returns its golden result (`null` unless the step has one).
fn run_step<J: JournalPort, D: WorkflowDriver>(
    engine: &mut WorkflowEngine<J, D>,
    step: &Value,
    tags: &mut HashMap<u64, String>,
) -> Value {
    match text(step, "op").as_str() {
        "createActor" => {
            let name = optional_text(step, "name");
            match engine.create_actor(&text(step, "site"), name.as_deref(), step.get("persona")) {
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
            tags.insert(ticket, text(step, "tag"));
            Value::Null
        }
        "submit" => {
            engine
                .submit_attempted(&ref_of(&step["at"]), step["payload"].clone())
                .expect("submit");
            Value::Null
        }
        "turnEnded" => {
            engine
                .turn_ended(&ref_of(&step["at"]), &text(step, "finalText"))
                .expect("turnEnded");
            Value::Null
        }
        "askFailed" => {
            engine
                .ask_failed(&ref_of(&step["at"]), error_of(&step["error"]))
                .expect("askFailed");
            Value::Null
        }
        "stats" => {
            engine
                .ask_stats(&ref_of(&step["at"]), stats_of(&step["stats"]))
                .expect("stats");
            Value::Null
        }
        "retune" => Value::Bool(
            engine
                .set_max_concurrency(step["value"].as_f64().expect("value"))
                .expect("retune"),
        ),
        "phase" => {
            engine.enter_phase(&text(step, "name")).expect("phase");
            Value::Null
        }
        "log" => {
            engine.log(&text(step, "message")).expect("log");
            Value::Null
        }
        "complete" => {
            engine.complete(step["artifact"].clone()).expect("complete");
            Value::Null
        }
        "stop" => {
            let reason = StopReason::parse(&text(step, "reason")).expect("stop reason");
            let error = step.get("error").map(error_of);
            engine
                .stop(reason, error, optional_text(step, "supersededBy"))
                .expect("stop");
            Value::Null
        }
        "fail" => {
            engine.fail(error_of(&step["error"])).expect("fail");
            Value::Null
        }
        other => panic!("unknown golden op {other}"),
    }
}

fn config_for(scenario: &Value, lifetime: &Value) -> EngineConfig {
    let ask_specs: HashMap<String, AskSpec> = scenario["input"]["askSpecs"]
        .as_object()
        .expect("askSpecs")
        .iter()
        .map(|(site, spec)| {
            (
                site.clone(),
                AskSpec {
                    typed: spec["typed"].as_bool().expect("typed"),
                    schema: spec.get("schema").cloned(),
                },
            )
        })
        .collect();
    let site_phases = scenario["input"]
        .get("sitePhases")
        .and_then(Value::as_object)
        .map(|phases| {
            phases
                .iter()
                .map(|(site, phase)| (site.clone(), phase.as_str().expect("phase").to_owned()))
                .collect()
        })
        .unwrap_or_default();
    EngineConfig {
        run_id: text(&scenario["input"], "runId"),
        caps: Caps {
            max_concurrency: lifetime["caps"].as_f64().expect("caps"),
        },
        ask_specs,
        validate,
        site_phases,
        script_hash: optional_text(lifetime, "scriptHash"),
        inherited_tokens: lifetime.get("inheritedTokens").and_then(Value::as_f64),
        ..EngineConfig::default()
    }
}

/// Replays one scenario and returns the actual observations in the golden's shape.
fn replay<J: JournalPort>(scenario: &Value, journal: &mut J) -> Value {
    let run_id = text(&scenario["input"], "runId");
    let mut recording = Recording::default();
    let mut tags: HashMap<u64, String> = HashMap::new();
    let mut outcomes: Vec<Value> = Vec::new();
    let mut lifetimes: Vec<Value> = Vec::new();
    for lifetime in scenario["input"]["lifetimes"]
        .as_array()
        .expect("lifetimes")
    {
        let config = config_for(scenario, lifetime);
        let mut results = Vec::new();
        let mut construct_error = None;
        match WorkflowEngine::new(config, &mut *journal, &mut recording) {
            Err(error) => {
                let error = error
                    .downcast_ref::<WorkflowError>()
                    .expect("constructor refuses with a workflow error");
                construct_error = Some(error.to_json());
            }
            Ok(mut engine) => {
                for step in lifetime["steps"].as_array().expect("steps") {
                    results.push(run_step(&mut engine, step, &mut tags));
                    engine.drain().expect("drain");
                    for outcome in engine.take_outcomes() {
                        let tag = tags.get(&outcome.ticket).expect("tagged ticket");
                        outcomes.push(outcome_json(tag, &outcome.result));
                    }
                }
            }
        }
        let run = journal.get_run(&run_id).expect("get_run");
        let nodes = journal.list_nodes(&run_id).expect("list_nodes");
        let actors = journal.list_actors(&run_id).expect("list_actors");
        let mut entry = serde_json::Map::new();
        if let Some(error) = construct_error {
            entry.insert("constructError".into(), error);
        }
        entry.insert("results".into(), Value::Array(results));
        entry.insert("run".into(), run.map_or(Value::Null, |row| row.to_json()));
        entry.insert(
            "nodes".into(),
            Value::Array(nodes.iter().map(NodeRow::to_json).collect()),
        );
        entry.insert(
            "actors".into(),
            Value::Array(actors.iter().map(ActorRow::to_json).collect()),
        );
        entry.insert("disposed".into(), json!(recording.disposed));
        lifetimes.push(Value::Object(entry));
    }
    let events: Vec<Value> = journal
        .list_events(&run_id)
        .expect("list_events")
        .into_iter()
        .map(|entry| json!({"sequence": entry.sequence, "payloadJson": entry.payload_json}))
        .collect();
    assert_eq!(
        recording.emitted.len(),
        events.len(),
        "driver saw every event"
    );
    json!({
        "lifetimes": lifetimes,
        "outcomes": outcomes,
        "driverCalls": recording.calls,
        "events": events,
    })
}

fn scenarios() -> Vec<Value> {
    let goldens: Value = serde_json::from_str(GOLDENS).expect("golden file parses");
    let list = goldens["scenarios"].as_array().expect("scenarios").clone();
    assert_eq!(list.len(), 6);
    list
}

/// Compares one scenario, part by part, so a mismatch names the part that differs.
fn check(scenario: &Value, actual: &Value) {
    let name = scenario["name"].as_str().expect("name");
    let expected_lifetimes = scenario["lifetimes"].as_array().expect("lifetimes");
    let actual_lifetimes = actual["lifetimes"].as_array().expect("lifetimes");
    assert_eq!(
        actual_lifetimes.len(),
        expected_lifetimes.len(),
        "{name}: lifetime count"
    );
    for (index, (got, want)) in actual_lifetimes.iter().zip(expected_lifetimes).enumerate() {
        assert_eq!(
            canonical_json(got),
            canonical_json(want),
            "{name}: lifetime {index}"
        );
    }
    assert_eq!(
        canonical_json(&actual["outcomes"]),
        canonical_json(&scenario["outcomes"]),
        "{name}: outcomes in settlement order"
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
fn memory_journal_matches_node_for_every_scheduler_scenario() {
    for scenario in scenarios() {
        let mut journal = MemoryJournal::new();
        let actual = replay(&scenario, &mut journal);
        check(&scenario, &actual);
    }
}

#[test]
fn dwf_journal_matches_node_for_every_scheduler_scenario() {
    for scenario in scenarios() {
        let (conn, _) = open_session_database(Path::new(":memory:"), Duration::from_secs(1), 0)
            .expect("session database with every Node migration");
        let mut journal = DwfJournal::new(&conn, || 0);
        let actual = replay(&scenario, &mut journal);
        check(&scenario, &actual);
    }
}
