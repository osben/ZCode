use serde_json::{Map, Value, json};

use super::activity;

fn run(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

#[test]
fn a_session_without_runs_has_no_activity() {
    assert_eq!(activity(&[], &json!([])), None);
}

#[test]
fn a_running_run_lights_its_current_phase_and_the_phases_its_nodes_were_born_in() {
    let runs = [run(json!({
        "runId": "run-1",
        "toolCallId": "call-1",
        "status": "running",
        "phases": [{"name": "Research"}, {"name": "Summary"}],
        "currentPhase": "Summary",
        "phaseNames": ["Research", "Summary", "Review"],
        "actors": [{"status": "running"}, {"status": "running"}, {"status": "completed"}],
        "nodes": [
            {"phase": "executing", "phaseName": "Research"},
            {"phase": "dispatched", "phaseName": "Review"}
        ]
    }))];
    let works = json!([
        {"kind": "shell", "workId": "run-1", "title": "not this", "startedAt": 1},
        {"kind": "workflow", "workId": "run-1", "title": "  Gray run  ", "startedAt": 42}
    ]);
    assert_eq!(
        activity(&runs, &works),
        Some(json!({"runs": [{
            "runId": "run-1",
            "toolCallId": "call-1",
            "name": "Gray run",
            "status": "running",
            "startedAt": 42,
            "phases": [
                {"name": "Research", "status": "running"},
                {"name": "Summary", "status": "running"},
                {"name": "Review", "status": "pending"}
            ],
            "currentPhase": "Summary",
            "agentsWorking": 2
        }]}))
    );
}

#[test]
fn without_declared_phases_the_entered_ones_and_the_current_one_are_listed() {
    let runs = [run(json!({
        "runId": "run-1",
        "status": "errored",
        "stopReason": "error",
        "phases": [{"name": "A"}],
        "currentPhase": "B",
        "actors": [],
        "nodes": [{"phase": "executing", "phaseName": "A"}]
    }))];
    let summary = activity(&runs, &json!([])).unwrap();
    assert_eq!(
        summary["runs"][0]["phases"],
        json!([{"name": "A", "status": "done"}, {"name": "B", "status": "failed"}])
    );
    assert_eq!(summary["runs"][0]["stopReason"], "error");
    assert!(summary["runs"][0].get("name").is_none());
    assert!(summary["runs"][0].get("startedAt").is_none());
}

#[test]
fn holes_and_parallel_phases_are_marked_on_the_declared_list() {
    let runs = [run(json!({
        "runId": "run-1",
        "status": "running",
        "phases": [{"name": "A"}],
        "currentPhase": "A",
        "phaseNames": ["A", "Fill", "Later"],
        "phaseAlongside": [[], [0, 1, 7], []],
        "phaseHoles": [1, 2],
        "holes": [{"name": "Fill", "state": "waiting"}],
        "actors": [],
        "nodes": []
    }))];
    let summary = activity(&runs, &json!([])).unwrap();
    assert_eq!(
        summary["runs"][0]["phases"],
        json!([
            {"name": "A", "status": "running"},
            {"name": "Fill", "status": "pending", "alongside": [0], "hole": "waiting"},
            {"name": "Later", "status": "pending", "hole": "open"}
        ])
    );
    assert_eq!(summary["runs"][0]["waitingHole"], "Fill");
}

#[test]
fn live_runs_come_first_then_the_latest_ended_at_most_four() {
    let settled =
        |id: &str| run(json!({"runId": id, "status": "completed", "actors": [], "nodes": []}));
    let runs = [
        settled("old"),
        run(json!({"runId": "live", "status": "pending", "actors": [], "nodes": []})),
        settled("late"),
        settled("no-end-1"),
        settled("no-end-2"),
    ];
    let works = json!([
        {"kind": "workflow", "workId": "old", "title": "t", "startedAt": 1, "endedAt": 5},
        {"kind": "workflow", "workId": "late", "title": "t", "startedAt": 1, "endedAt": 9}
    ]);
    let ids: Vec<Value> = activity(&runs, &works).unwrap()["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|summary| summary["runId"].clone())
        .collect();
    assert_eq!(
        ids,
        vec![
            json!("live"),
            json!("late"),
            json!("old"),
            json!("no-end-2")
        ]
    );
}
