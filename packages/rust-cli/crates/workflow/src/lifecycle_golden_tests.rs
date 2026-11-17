//! Replays the run-lifecycle scenarios recorded from Node's `WorkflowEngine`
//! (`scripts/rust-cli/workflow-lifecycle-goldens.ts`, fixture `lifecycle-goldens.json`) and compares
//! every step result, the run row after each lifetime, the constructor error, the dispose count and
//! the event log (sequence and exact payload text).
use crate::canon::canonical_json;
use crate::engine::{AskMessage, EngineConfig, SubmitVerdict, WorkflowDriver, WorkflowEngine};
use crate::error::{ErrorCode, WorkflowError};
use crate::event::RunEvent;
use crate::journal::{JournalPort, MemoryJournal};
use crate::journal_dwf::DwfJournal;
use crate::model::{Caps, Ref, RunRow, StopReason};
use rust_cli_node_store::open_session_database;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

const GOLDENS: &str = include_str!("../fixtures/lifecycle-goldens.json");

#[derive(Default)]
struct RecordingDriver {
    emitted: Vec<String>,
    disposed: u64,
}

impl WorkflowDriver for RecordingDriver {
    fn create_actor_session(
        &mut self,
        _actor: &Ref,
        _persona: &Value,
        _seed: Option<&crate::imported_cache::ActorSessionSeed>,
    ) -> anyhow::Result<String> {
        unreachable!("the lifecycle goldens create no actors")
    }

    fn start_world_read(&mut self, _instance: &Ref, _op: &str, _args: &Value) {
        unreachable!("world reads are not used by this driver");
    }

    fn start_ask(&mut self, _session: &str, _instance: &Ref, _message: &AskMessage) {
        unreachable!("the lifecycle goldens start no asks")
    }

    fn respond_to_submit(&mut self, _instance: &Ref, _verdict: &SubmitVerdict) {
        unreachable!("the lifecycle goldens submit nothing")
    }

    fn cancel_ask(&mut self, _instance: &Ref) {
        unreachable!("the lifecycle goldens cancel no asks")
    }

    fn emit(&mut self, event: &RunEvent) {
        self.emitted.push(event.payload_json());
    }

    fn dispose(&mut self) {
        self.disposed += 1;
    }
}

fn error_from(json: &Value) -> WorkflowError {
    let code = json["code"]
        .as_str()
        .and_then(ErrorCode::parse)
        .expect("golden error code");
    WorkflowError::new(code, json["message"].as_str().expect("golden message"))
}

fn optional_text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn config_for(run_id: &str, lifetime: &Value) -> EngineConfig {
    let launch = lifetime
        .get("launch")
        .map(|launch| crate::event::LaunchFields {
            input_id: launch["inputId"]
                .as_str()
                .expect("golden launch inputId")
                .to_owned(),
            phase_names: launch.get("phaseNames").cloned(),
            subagent_model: optional_text(launch, "subagentModel"),
            subagent_permission_mode: optional_text(launch, "subagentPermissionMode"),
            model_bindings: launch.get("modelBindings").cloned(),
            script_path: optional_text(launch, "scriptPath"),
            phase_alongside: launch.get("phaseAlongside").cloned(),
            holes: launch.get("holes").cloned(),
            ..Default::default()
        });
    EngineConfig {
        run_id: run_id.to_owned(),
        caps: Caps {
            max_concurrency: lifetime["caps"].as_f64().expect("caps"),
        },
        script_text: optional_text(lifetime, "scriptText"),
        script_hash: optional_text(lifetime, "scriptHash"),
        name: optional_text(lifetime, "name"),
        args: lifetime.get("args").cloned(),
        parent_session_id: optional_text(lifetime, "parentSessionId"),
        cwd: optional_text(lifetime, "cwd"),
        tool_call_id: optional_text(lifetime, "toolCallId"),
        resumed_from: optional_text(lifetime, "resumedFrom"),
        launch,
        inherited_tokens: lifetime.get("inheritedTokens").and_then(Value::as_f64),
        ..Default::default()
    }
}

/// Runs one step and returns its JSON result (`null`, or a boolean for a retune).
fn run_step<J: JournalPort>(
    engine: &mut WorkflowEngine<&mut J, &mut RecordingDriver>,
    step: &Value,
) -> Value {
    match step["op"].as_str().expect("op") {
        "log" => {
            engine
                .log(step["message"].as_str().expect("message"))
                .expect("log");
            Value::Null
        }
        "retune" => {
            // JSON cannot carry NaN; the generator writes it as null, and Node's step was NaN. Any other
            // non-number is a broken fixture, not a NaN.
            let value = match &step["value"] {
                Value::Null => f64::NAN,
                other => other
                    .as_f64()
                    .expect("golden retune value is a number or null"),
            };
            Value::Bool(engine.set_max_concurrency(value).expect("retune"))
        }
        "usage" => {
            engine
                .record_usage(step["tokens"].as_f64().expect("tokens"))
                .expect("usage");
            Value::Null
        }
        "complete" => {
            engine.complete(step["artifact"].clone()).expect("complete");
            Value::Null
        }
        "stop" => {
            let reason =
                StopReason::parse(step["reason"].as_str().expect("reason")).expect("stop reason");
            let error = step.get("error").map(error_from);
            let superseded_by = optional_text(step, "supersededBy");
            engine.stop(reason, error, superseded_by).expect("stop");
            Value::Null
        }
        "fail" => {
            engine.fail(error_from(&step["error"])).expect("fail");
            Value::Null
        }
        other => panic!("unknown golden op {other}"),
    }
}

fn scenarios() -> Vec<Value> {
    let goldens: Value = serde_json::from_str(GOLDENS).expect("golden file parses");
    let list = goldens["scenarios"].as_array().expect("scenarios").clone();
    assert!(
        list.len() >= 6,
        "expected at least 6 scenarios, got {}",
        list.len()
    );
    list
}

#[test]
fn memory_journal_matches_node_for_every_scenario() {
    for scenario in scenarios() {
        replay_scenario(&scenario, &mut MemoryJournal::new());
    }
}

#[test]
fn dwf_journal_matches_node_for_every_scenario() {
    for scenario in scenarios() {
        let (conn, _) = open_session_database(Path::new(":memory:"), Duration::from_secs(1), 0)
            .expect("session database with every Node migration");
        replay_scenario(&scenario, &mut DwfJournal::new(&conn, || 0));
    }
}

fn replay_scenario<J: JournalPort>(scenario: &Value, journal: &mut J) {
    let name = scenario["name"].as_str().unwrap_or_default().to_owned();
    let input = &scenario["input"];
    let run_id = input["runId"].as_str().expect("runId");
    let mut driver = RecordingDriver::default();
    let lifetimes = input["lifetimes"].as_array().expect("lifetimes");
    let expected = scenario["lifetimes"]
        .as_array()
        .expect("expected lifetimes");
    assert_eq!(lifetimes.len(), expected.len(), "{name}: lifetime count");
    for (index, (lifetime, want)) in lifetimes.iter().zip(expected).enumerate() {
        let config = config_for(run_id, lifetime);
        match WorkflowEngine::new(config, &mut *journal, &mut driver) {
            Err(error) => {
                let thrown = error
                    .downcast_ref::<WorkflowError>()
                    .expect("workflow error");
                // The whole toJSON shape: code, message and the typed parts (mismatch for a hash mismatch).
                assert_eq!(
                    canonical_json(&thrown.to_json()),
                    canonical_json(&want["constructError"]),
                    "{name} lifetime {index}: construct error"
                );
            }
            Ok(mut engine) => {
                assert!(
                    want.get("constructError").is_none(),
                    "{name} lifetime {index}: expected a constructor error"
                );
                let steps = lifetime["steps"].as_array().expect("steps");
                let results: Vec<Value> = steps
                    .iter()
                    .map(|step| run_step(&mut engine, step))
                    .collect();
                assert_eq!(
                    &Value::Array(results),
                    &want["results"],
                    "{name} lifetime {index}: step results"
                );
            }
        }
        // A run with no row is recorded as null (the generator's `run: row === undefined ? null`).
        let row = journal.get_run(run_id).expect("get_run");
        let got_row = row.as_ref().map_or(Value::Null, RunRow::to_json);
        assert_eq!(
            canonical_json(&got_row),
            canonical_json(&want["run"]),
            "{name} lifetime {index}: run row"
        );
        assert_eq!(
            driver.disposed,
            want["disposed"].as_u64().expect("disposed"),
            "{name} lifetime {index}: dispose count"
        );
    }
    let stored = journal.list_events(run_id).expect("events");
    let expected_events = scenario["events"].as_array().expect("events");
    assert_eq!(stored.len(), expected_events.len(), "{name}: event count");
    for (entry, want) in stored.iter().zip(expected_events) {
        assert_eq!(
            entry.sequence,
            want["sequence"].as_u64().expect("sequence"),
            "{name}: sequence"
        );
        assert_eq!(
            entry.payload_json,
            want["payloadJson"].as_str().expect("payload"),
            "{name}: payload text"
        );
    }
    assert_eq!(
        driver.emitted.len(),
        stored.len(),
        "{name}: driver saw every event"
    );
    for (emitted, entry) in driver.emitted.iter().zip(&stored) {
        assert_eq!(
            emitted, &entry.payload_json,
            "{name}: driver payload matches journal"
        );
    }
}
