//! Replays the holes, artifacts and reports scenarios recorded from Node's `WorkflowEngine`
//! (`scripts/rust-cli/workflow-holes-goldens.ts`, fixture `holes-goldens.json`; spec 9.6).
//!
//! Each scenario runs once per lifetime (a resumed lifetime is a new engine over the same journal). Every
//! step is followed by `drain`, as the generator flushes between steps. The driver's publish requests, the
//! hole and artifact outcomes (in settlement order) and every event's exact payload text are compared with
//! Node. Each step's `now` is the clock value the generator injected.
use crate::canon::canonical_json;
use crate::engine::{AskOutcome, EngineConfig, WorkflowDriver, WorkflowEngine};
use crate::engine_artifacts::ArtifactPublishRequest;
use crate::engine_holes::HoleFill;
use crate::error::{ErrorCode, WorkflowError};
use crate::event::RunEvent;
use crate::journal::{JournalPort, MemoryJournal};
use crate::journal_dwf::DwfJournal;
use crate::model::{Caps, Ref, Violation};
use anyhow::Result;
use rust_cli_node_store::open_session_database;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

const GOLDENS: &str = include_str!("../fixtures/holes-goldens.json");

/// What the recording driver saw, shared by every lifetime of one scenario (Node's test driver is one object).
#[derive(Default)]
struct Shared {
    calls: Vec<Value>,
    emitted: u64,
    disposed: u64,
    /// Publish requests in call order, with the instance they were issued for.
    publishes: Vec<(Ref, ArtifactPublishRequest)>,
}

struct Recording {
    shared: Rc<RefCell<Shared>>,
}

impl WorkflowDriver for Recording {
    fn create_actor_session(
        &mut self,
        _actor: &Ref,
        _persona: &Value,
        _seed: Option<&crate::imported_cache::ActorSessionSeed>,
    ) -> Result<String> {
        Err(anyhow::anyhow!("not used in the holes goldens"))
    }

    fn start_ask(&mut self, _session: &str, _instance: &Ref, _message: &crate::engine::AskMessage) {
        panic!("not used in the holes goldens");
    }

    fn respond_to_submit(&mut self, _instance: &Ref, _verdict: &crate::engine::SubmitVerdict) {
        panic!("not used in the holes goldens");
    }

    fn cancel_ask(&mut self, _instance: &Ref) {
        panic!("not used in the holes goldens");
    }

    fn start_world_read(&mut self, _instance: &Ref, _op: &str, _args: &Value) {
        panic!("not used in the holes goldens");
    }

    fn emit(&mut self, _event: &RunEvent) {
        self.shared.borrow_mut().emitted += 1;
    }

    fn dispose(&mut self) {
        self.shared.borrow_mut().disposed += 1;
    }

    fn has_artifact_store(&self) -> bool {
        true
    }

    fn start_artifact_publish(&mut self, instance: &Ref, request: &ArtifactPublishRequest) {
        let mut shared = self.shared.borrow_mut();
        shared
            .calls
            .push(json!({"op": "executeArtifactPublish", "request": request.to_json()}));
        shared.publishes.push((instance.clone(), request.clone()));
    }
}

fn validate(_schema: &Value, _value: &Value) -> Vec<Violation> {
    Vec::new()
}

fn scenarios() -> Vec<Value> {
    let goldens: Value = serde_json::from_str(GOLDENS).expect("golden file parses");
    let list = goldens["scenarios"].as_array().expect("scenarios").clone();
    assert_eq!(list.len(), 5);
    list
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

fn error_of(value: &Value) -> WorkflowError {
    let code = ErrorCode::parse(&text(value, "code")).expect("known code");
    WorkflowError::new(code, text(value, "message"))
}

fn outcome_json(tag: &str, outcome: &AskOutcome) -> Value {
    match &outcome.result {
        Ok(value) => json!({"tag": tag, "ok": true, "value": value}),
        Err(error) => json!({"tag": tag, "ok": false, "error": error.to_json()}),
    }
}

/// Node's `fill` object: the spec tables, the script and the phase names, as the generator passes them.
fn fill_of(step: &Value) -> HoleFill {
    let mut site_phases = HashMap::new();
    if let Some(map) = step.get("sitePhases").and_then(Value::as_object) {
        for (site, phase) in map {
            site_phases.insert(site.clone(), phase.as_str().unwrap_or_default().to_owned());
        }
    }
    HoleFill {
        site_id: text(step, "site"),
        code: text(step, "code"),
        script_text: text(&step["script"], "text"),
        script_hash: text(&step["script"], "hash"),
        ask_specs: HashMap::new(),
        site_phases,
        phase_names: step["phaseNames"]
            .as_array()
            .map(|names| {
                names
                    .iter()
                    .map(|n| n.as_str().unwrap_or_default().to_owned())
                    .collect()
            })
            .unwrap_or_default(),
        holes: step.get("holes").and_then(Value::as_array).map(|list| {
            list.iter()
                .map(|n| n.as_u64().expect("hole index"))
                .collect()
        }),
        filled_by: step
            .get("filledBy")
            .and_then(Value::as_str)
            .map(str::to_owned),
        script_path: step
            .get("scriptPath")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

/// The record the generator's driver returns for a successful publish (same key order).
fn record_of(request: &ArtifactPublishRequest, now: f64) -> Value {
    let mut record = serde_json::Map::new();
    record.insert("id".into(), json!(request.id));
    record.insert("kind".into(), json!(request.op));
    record.insert("version".into(), json!(request.version));
    record.insert(
        "uri".into(),
        json!(format!(
            "zcode-artifact://{}/v{}",
            request.id, request.version
        )),
    );
    record.insert("bytes".into(), json!(4));
    record.insert("contentType".into(), json!("text/plain"));
    if request.op == "file" {
        record.insert("sourcePath".into(), json!(request.path));
    }
    record.insert("publishedAt".into(), json!(now));
    Value::Object(record)
}

/// Runs the scenario's lifetimes against one journal and returns the output in the golden's shape.
fn replay<J: JournalPort>(scenario: &Value, journal: &mut J) -> Value {
    let shared = Rc::new(RefCell::new(Shared::default()));
    let run_id = text(scenario, "runId");
    let mut outcomes: Vec<Value> = Vec::new();
    let mut lifetimes: Vec<Value> = Vec::new();
    for lifetime in scenario["lifetimes"].as_array().expect("lifetimes") {
        let config = EngineConfig {
            run_id: run_id.clone(),
            caps: Caps {
                max_concurrency: scenario["caps"].as_f64().expect("caps"),
            },
            ask_specs: HashMap::new(),
            validate,
            site_phases: scenario
                .get("sitePhases")
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .map(|(site, phase)| (site.clone(), phase.as_str().unwrap().to_owned()))
                        .collect()
                })
                .unwrap_or_default(),
            script_hash: lifetime
                .get("scriptHash")
                .and_then(Value::as_str)
                .map(str::to_owned),
            ..EngineConfig::default()
        };
        let driver = Recording {
            shared: Rc::clone(&shared),
        };
        let mut construct_error: Option<Value> = None;
        let mut results: Vec<Value> = Vec::new();
        // Tags of the promises the script holds: ticket → tag, and tag → publish index.
        let mut tickets: HashMap<u64, String> = HashMap::new();
        let mut publish_of_tag: BTreeMap<String, usize> = BTreeMap::new();
        let mut engine = match WorkflowEngine::new(config, &mut *journal, driver) {
            Ok(engine) => Some(engine),
            Err(error) => {
                let error = error
                    .downcast_ref::<WorkflowError>()
                    .cloned()
                    .expect("constructor error is a WorkflowError");
                construct_error = Some(error.to_json());
                None
            }
        };
        for step in lifetime["steps"].as_array().expect("steps") {
            let op = text(step, "op");
            let now = step["now"].as_f64().expect("now");
            let mut result = Value::Null;
            if let Some(engine) = engine.as_mut() {
                match op.as_str() {
                    "phase" => engine.enter_phase(&text(step, "name")).expect("phase"),
                    "report" => {
                        let artifact_id = step.get("artifactId").and_then(Value::as_str);
                        engine
                            .report(&text(step, "site"), step["item"].clone(), artifact_id)
                            .expect("report");
                    }
                    "declare" => {
                        let args: Vec<Value> = step["args"].as_array().unwrap().clone();
                        engine
                            .declare_artifact(&text(step, "site"), &text(step, "preset"), &args)
                            .expect("declare");
                    }
                    "publish" => {
                        let args: Vec<Value> = step["args"].as_array().unwrap().clone();
                        let before = shared.borrow().publishes.len();
                        let ticket = engine
                            .publish_artifact(&text(step, "site"), &text(step, "kind"), &args)
                            .expect("publish");
                        let tag = text(step, "tag");
                        tickets.insert(ticket, tag.clone());
                        if shared.borrow().publishes.len() > before {
                            publish_of_tag.insert(tag, before);
                        }
                    }
                    "publishSettle" => {
                        let tag = text(step, "tag");
                        let index = publish_of_tag[&tag];
                        let (instance, request) = shared.borrow().publishes[index].clone();
                        let settled = if step["ok"].as_bool().unwrap() {
                            Ok(record_of(&request, now))
                        } else {
                            Err(error_of(&step["error"]))
                        };
                        engine
                            .artifact_publish_settled(&instance, settled)
                            .expect("publish settled");
                    }
                    "hole" => {
                        let prompt = step.get("prompt").and_then(Value::as_str);
                        let ticket = engine
                            .hole(&text(step, "site"), &text(step, "name"), prompt, now)
                            .expect("hole");
                        tickets.insert(ticket, text(step, "tag"));
                    }
                    "fill" => {
                        let filled = engine.fill_hole(fill_of(step), now).expect("fill");
                        result = filled.to_json();
                    }
                    "complete" => engine.complete(step["artifact"].clone()).expect("complete"),
                    "stop" => {
                        let error = step.get("error").map(error_of);
                        engine
                            .stop(
                                crate::model::StopReason::parse(&text(step, "reason"))
                                    .expect("stop reason"),
                                error,
                                None,
                            )
                            .expect("stop");
                    }
                    other => panic!("unknown step {other}"),
                }
                engine.drain().expect("drain");
                for outcome in engine.take_outcomes() {
                    let tag = tickets
                        .get(&outcome.ticket)
                        .cloned()
                        .expect("ticket has a tag");
                    outcomes.push(outcome_json(&tag, &outcome));
                }
            }
            results.push(result);
        }
        let open_holes = engine.as_ref().map_or(Value::Array(Vec::new()), |engine| {
            Value::Array(
                engine
                    .open_holes()
                    .iter()
                    .map(crate::engine_holes::OpenHole::to_json)
                    .collect(),
            )
        });
        let filled_holes = engine.as_ref().map_or(Value::Array(Vec::new()), |engine| {
            Value::Array(
                engine
                    .filled_holes()
                    .iter()
                    .map(crate::engine_holes::FilledHole::to_json)
                    .collect(),
            )
        });
        drop(engine);
        let run = journal
            .get_run(&run_id)
            .expect("run")
            .map(|row| row.to_json());
        let nodes: Vec<Value> = journal
            .list_nodes(&run_id)
            .expect("nodes")
            .iter()
            .map(crate::model::NodeRow::to_json)
            .collect();
        lifetimes.push(json!({
            "constructError": construct_error,
            "results": results,
            "run": run,
            "nodes": nodes,
            "openHoles": open_holes,
            "filledHoles": filled_holes,
            "disposed": shared.borrow().disposed,
        }));
    }
    let events: Vec<Value> = journal
        .list_events(&run_id)
        .expect("events")
        .iter()
        .map(|entry| json!({"sequence": entry.sequence, "payloadJson": entry.payload_json}))
        .collect();
    let shared = shared.borrow();
    json!({
        "name": text(scenario, "name"),
        "lifetimes": lifetimes,
        "outcomes": outcomes,
        "driverCalls": shared.calls,
        "events": events,
        "emittedCount": shared.emitted,
    })
}

/// Compares one scenario part by part, so a mismatch names the part that differs.
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
        for part in [
            "constructError",
            "results",
            "run",
            "nodes",
            "openHoles",
            "filledHoles",
            "disposed",
        ] {
            assert_eq!(
                canonical_json(&got[part]),
                canonical_json(&want[part]),
                "{name}: lifetime {index}, {part}"
            );
        }
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
        actual["emittedCount"], scenario["emittedCount"],
        "{name}: events the driver was told about"
    );
    assert_eq!(
        actual["events"], scenario["events"],
        "{name}: events (sequence and payload text)"
    );
}

#[test]
fn memory_journal_matches_node_for_every_holes_scenario() {
    for scenario in scenarios() {
        let mut journal = MemoryJournal::new();
        let actual = replay(&scenario["input"], &mut journal);
        check(&scenario, &actual);
    }
}

#[test]
fn dwf_journal_matches_node_for_every_holes_scenario() {
    for scenario in scenarios() {
        let (conn, _) = open_session_database(Path::new(":memory:"), Duration::from_secs(1), 0)
            .expect("session database with every Node migration");
        let mut journal = DwfJournal::new(&conn, || 0);
        let actual = replay(&scenario["input"], &mut journal);
        check(&scenario, &actual);
    }
}
