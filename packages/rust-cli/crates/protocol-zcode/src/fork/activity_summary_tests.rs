use super::*;
use serde_json::{Map, Value, json};

fn run(id: &str, status: &str) -> Map<String, Value> {
    json!({"runId": id, "status": status})
        .as_object()
        .unwrap()
        .clone()
}

fn appended(kind: &str, origin: &str) -> Value {
    json!({"op": "row.appended", "row": {"rowId": 7, "kind": kind, "origin": origin}})
}

#[test]
fn only_an_appended_real_user_input_row_sets_the_boundary() {
    assert!(is_new_real_input(&[appended("userInput", "realUser")]));
    for delta in [
        appended("userInput", "backgroundResult"),
        appended("userInput", "workflowLaunch"),
        appended("turnHeader", "userInput"),
        json!({"op": "row.upserted", "row": {"rowId": 3, "kind": "userInput", "origin": "realUser"}}),
        json!({"op": "state.updated", "patch": {}}),
    ] {
        assert!(!is_new_real_input(std::slice::from_ref(&delta)), "{delta}");
    }
}

#[test]
fn the_boundary_takes_the_finished_works_children_and_runs() {
    let works = json!([
        {"workId": "w-run", "status": "running"},
        {"workId": "w-done", "status": "completed"},
        {"workId": "w-cancel", "status": "cancelled"}
    ]);
    let subagents = json!({
        "childSessionIds": ["c-live", "c-done"],
        "running": [{"childSessionId": "c-live", "status": "running"}]
    });
    let runs = [
        run("r-stop", "stopped"),
        run("r-run", "running"),
        run("r-wait", "pending"),
        run("r-ok", "completed"),
        run("r-err", "errored"),
    ];
    let facts = Facts {
        works: &works,
        subagents: &subagents,
        runs: &runs,
    };
    assert_eq!(
        dismissed(1234, &facts),
        json!({
            "at": 1234,
            "workIds": ["w-done", "w-cancel"],
            "subagentIds": ["c-done"],
            "workflowRunIds": ["r-stop", "r-ok", "r-err"]
        })
    );
}

#[test]
fn an_empty_session_still_sends_all_four_keys() {
    let facts = Facts {
        works: &Value::Null,
        subagents: &Value::Null,
        runs: &[],
    };
    assert_eq!(
        dismissed(5, &facts),
        json!({"at": 5, "workIds": [], "subagentIds": [], "workflowRunIds": []})
    );
}

#[test]
fn an_item_that_runs_again_leaves_the_boundary() {
    let boundary = json!({
        "at": 10,
        "workIds": ["w1", "w2"],
        "subagentIds": ["c1", "c2"],
        "workflowRunIds": ["r1", "r2", "r3"]
    });
    let works =
        json!([{"workId": "w1", "status": "running"}, {"workId": "w2", "status": "completed"}]);
    let subagents = json!({"childSessionIds": ["c1", "c2"], "running": [{"childSessionId": "c2"}]});
    let runs = [
        run("r1", "running"),
        run("r2", "stopped"),
        run("r3", "pending"),
    ];
    let facts = Facts {
        works: &works,
        subagents: &subagents,
        runs: &runs,
    };
    assert_eq!(
        without_running(&boundary, &facts),
        Some(json!({
            "at": 10,
            "workIds": ["w2"],
            "subagentIds": ["c1"],
            "workflowRunIds": ["r2"]
        }))
    );
}

fn ended(child: &str, ended_at: u64) -> crate::fork::subagents::EndedOutcome {
    crate::fork::subagents::EndedOutcome {
        child: child.to_owned(),
        status: "success".to_owned(),
        ended_at,
        completed_at: None,
    }
}

#[test]
fn the_cold_boundary_prefers_the_childs_own_completion_time() {
    let mut launched_early = ended("c-bg", 900);
    launched_early.completed_at = Some(1500);
    assert_eq!(
        cold_dismissed(1000, &[launched_early], &[])["subagentIds"],
        json!([])
    );
}

fn journaled(run_id: &str, status: &str, updated_at: i64) -> (String, String, i64) {
    (run_id.to_owned(), status.to_owned(), updated_at)
}

#[test]
fn the_cold_boundary_takes_what_had_ended_by_the_last_input() {
    let children = [
        ended("c-before", 900),
        ended("c-at", 1000),
        ended("c-after", 1001),
    ];
    let runs = [
        journaled("r-before", "cancelled", 800),
        journaled("r-after", "completed", 1500),
        journaled("r-live", "running", 100),
        journaled("r-wait", "pending", 100),
    ];
    assert_eq!(
        cold_dismissed(1000, &children, &runs),
        json!({
            "at": 1000,
            "workIds": [],
            "subagentIds": ["c-before", "c-at"],
            "workflowRunIds": ["r-before"]
        })
    );
}

#[test]
fn a_cold_boundary_of_a_session_with_no_activity_has_all_four_keys() {
    assert_eq!(
        cold_dismissed(7, &[], &[]),
        json!({"at": 7, "workIds": [], "subagentIds": [], "workflowRunIds": []})
    );
}

#[test]
fn a_boundary_with_nothing_running_again_is_left_alone() {
    let boundary =
        json!({"at": 10, "workIds": ["w1"], "subagentIds": [], "workflowRunIds": ["r1"]});
    let works = json!([{"workId": "w1", "status": "completed"}]);
    let runs = [run("r1", "stopped")];
    let facts = Facts {
        works: &works,
        subagents: &Value::Null,
        runs: &runs,
    };
    assert_eq!(without_running(&boundary, &facts), None);
}
