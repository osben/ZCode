//! Tests of the host's run queries and the orphan settlement over the dwf journal (W7-5a-4).

use std::path::Path;
use std::time::Duration;

use rust_cli_node_store::dwf::{self, RunRecord, RunStatus as DwfStatus};
use serde_json::json;

use crate::model::RunStatus;
use crate::run_store::{RunListQuery, RunStore, SqliteRunStore, interrupted_message};

fn database() -> rusqlite::Connection {
    let (conn, _) = rust_cli_node_store::open_session_database(
        Path::new(":memory:"),
        Duration::from_secs(1),
        0,
    )
    .expect("session database");
    conn
}

fn add_session(conn: &rusqlite::Connection, id: &str) {
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values (?, 'proj', null, ?, '/work', 'title', '0.0.0', 1, 1)",
        rusqlite::params![id, id],
    )
    .expect("session row for the run's parent");
}

fn run(id: &str, parent: &str, cwd: &str, status: DwfStatus) -> RunRecord {
    RunRecord {
        run_id: id.to_owned(),
        parent_session_id: Some(parent.to_owned()),
        cwd: Some(cwd.to_owned()),
        script_text: Some(format!("return {id}")),
        max_concurrency: 2,
        status,
        ..RunRecord::default()
    }
}

fn store(conn: rusqlite::Connection) -> SqliteRunStore {
    SqliteRunStore::new(conn, || 500)
}

#[test]
fn non_terminal_runs_are_this_parents_unsettled_rows_in_id_order() {
    let conn = database();
    add_session(&conn, "ses_p");
    add_session(&conn, "ses_other");
    dwf::create_run(&conn, &run("run_b", "ses_p", "/w", DwfStatus::Pending), 1).unwrap();
    dwf::create_run(&conn, &run("run_a", "ses_p", "/w", DwfStatus::Running), 1).unwrap();
    dwf::create_run(&conn, &run("run_c", "ses_p", "/w", DwfStatus::Completed), 1).unwrap();
    dwf::create_run(
        &conn,
        &run("run_x", "ses_other", "/w", DwfStatus::Running),
        1,
    )
    .unwrap();
    let store = store(conn);

    let ids: Vec<String> = store
        .non_terminal_runs("ses_p")
        .unwrap()
        .into_iter()
        .map(|row| row.run_id)
        .collect();
    assert_eq!(ids, ["run_a", "run_b"]);
}

#[test]
fn interrupt_settles_as_stopped_interrupted_with_the_node_message_and_no_event() {
    let conn = database();
    add_session(&conn, "ses_p");
    dwf::create_run(&conn, &run("run_1", "ses_p", "/w", DwfStatus::Running), 1).unwrap();
    let store = store(conn);

    store.interrupt_run("run_1").unwrap();

    let row = store.get_run("run_1").unwrap().expect("the run");
    assert_eq!(row.status, RunStatus::Stopped);
    assert_eq!(row.stop_reason, Some(crate::model::StopReason::Interrupted));
    assert_eq!(
        row.failure,
        Some(json!({"code": "Interrupted", "message": interrupted_message("run_1")}))
    );
    assert_eq!(
        interrupted_message("run_1"),
        "dynamic workflow run run_1 was interrupted: the owning process exited before the run settled"
    );
    assert_eq!(
        store.non_terminal_runs("ses_p").unwrap().len(),
        0,
        "a settled run is no longer non-terminal"
    );
    assert!(
        dwf::list_events(&store.lock_for_test(), "run_1")
            .unwrap()
            .is_empty(),
        "the sweep writes no dwf_event"
    );
}

#[test]
fn interrupt_of_an_unknown_run_is_an_error() {
    let store = store(database());
    assert!(store.interrupt_run("run_missing").is_err());
}

#[test]
fn list_rows_carry_the_journal_timestamps_and_the_failure_of_an_interrupted_run() {
    let conn = database();
    add_session(&conn, "ses_p");
    dwf::create_run(&conn, &run("run_1", "ses_p", "/w", DwfStatus::Running), 7).unwrap();
    let store = store(conn);
    store.interrupt_run("run_1").unwrap();

    let rows = store.runs_of_session("ses_p", 16).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].time_created, 7);
    assert_eq!(rows[0].time_updated, 500, "the settlement's clock");
    assert_eq!(
        rows[0].run.stop_reason,
        Some(crate::model::StopReason::Interrupted)
    );
    assert!(rows[0].run.failure.is_some());
}

/// 9.42: the run's projected state is the journal's replay, so an escalation the journal has raised and not resolved is
/// a pending question of the run. An unknown run has no state.
#[test]
fn run_state_replays_the_open_escalations_of_the_journal() {
    let conn = database();
    add_session(&conn, "ses_p");
    dwf::create_run(&conn, &run("run_1", "ses_p", "/w", DwfStatus::Running), 7).unwrap();
    dwf::append_event(
        &conn,
        "run_1",
        &json!({"type": "escalation-raised", "qid": "dwfq-run_1-0", "question": "which branch?",
                "actor": {"siteId": "agent#1", "ordinal": 1}, "actorName": "poet", "askedAt": 9}),
        9,
    )
    .unwrap();
    let store = store(conn);
    let detail = store
        .run_detail("run_1", Some(4.0))
        .unwrap()
        .expect("the run is held");
    let state = detail.state.expect("the run replays");
    let pending = state["pendingQuestions"].as_array().expect("pending list");
    assert_eq!(pending.len(), 1, "{state:?}");
    assert_eq!(pending[0]["qid"], "dwfq-run_1-0");
    assert_eq!(pending[0]["question"], "which branch?");
    assert_eq!(pending[0]["actorName"], "poet");
    assert!(store.run_detail("run_9", Some(4.0)).unwrap().is_none());
}

/// 9.42: the detail's row carries the row's own timestamps and result from the same snapshot. Without a configured default
/// nothing is replayed (`state` is `None`), and a row with no event yet has no replayed state either.
#[test]
fn run_detail_carries_the_row_timestamps_and_replays_only_with_a_default_and_an_event() {
    let conn = database();
    add_session(&conn, "ses_p");
    dwf::create_run(&conn, &run("run_1", "ses_p", "/w", DwfStatus::Running), 7).unwrap();
    dwf::create_run(&conn, &run("run_2", "ses_p", "/w", DwfStatus::Running), 8).unwrap();
    dwf::append_event(
        &conn,
        "run_1",
        &json!({"type": "escalation-raised", "qid": "q", "question": "?",
                "actor": {"siteId": "agent#1", "ordinal": 1}, "askedAt": 9}),
        9,
    )
    .unwrap();
    let store = store(conn);
    store.interrupt_run("run_1").unwrap();

    let detail = store.run_detail("run_1", None).unwrap().expect("held");
    assert_eq!(detail.run.time_created, 7);
    assert_eq!(detail.run.time_updated, 500, "the settlement's clock");
    assert!(detail.state.is_none(), "no default, so no replay");

    let replayed = store.run_detail("run_1", Some(4.0)).unwrap().expect("held");
    assert!(replayed.state.is_some());

    let no_event = store.run_detail("run_2", Some(4.0)).unwrap().expect("held");
    assert_eq!(no_event.run.time_created, 8);
    assert!(
        no_event.state.is_none(),
        "a row with no event has no replayed state"
    );
}

/// 9.46: the detail carries the roster, read from the journal in the same snapshot: the log tail, the actors, and the launch's
/// script path and model bindings. Without a configured default the projected state is absent, so the pending questions
/// are unknown and no subagent is parked.
#[test]
fn run_detail_carries_the_roster_read_from_the_journal() {
    let conn = database();
    add_session(&conn, "ses_p");
    dwf::create_run(&conn, &run("run_1", "ses_p", "/w", DwfStatus::Running), 7).unwrap();
    dwf::append_event(
        &conn,
        "run_1",
        &json!({"type": "run-launched", "scriptPath": "/w/flow.js", "modelBindings": {"poet": "openai/gpt-x"}}),
        8,
    )
    .unwrap();
    dwf::append_event(
        &conn,
        "run_1",
        &json!({"type": "log", "message": "fetching"}),
        9,
    )
    .unwrap();
    dwf::put_actor(
        &conn,
        &dwf::ActorRecord {
            run_id: "run_1".into(),
            site_id: "agent".into(),
            ordinal: 1,
            name: Some("poet".into()),
            ..Default::default()
        },
        10,
    )
    .unwrap();
    let store = store(conn);

    // Divergence 564 (9.50): the events are read with or without a configured default, so the keys that come from them
    // (the launch's script path and model bindings, the log tail) are present in both cases (551's contract, kept). Only
    // the replayed state needs the default.
    let detail = store.run_detail("run_1", None).unwrap().expect("held");
    assert!(detail.state.is_none(), "no default, so no replay");
    assert_eq!(detail.roster["scriptPath"], "/w/flow.js");
    assert_eq!(
        detail.roster["modelBindings"],
        json!({"poet": "openai/gpt-x"})
    );
    assert_eq!(detail.roster["logTail"][0]["message"], "fetching");
    assert_eq!(
        detail.roster["actors"],
        json!([{"siteId": "agent", "ordinal": 1, "name": "poet"}])
    );
    assert_eq!(detail.roster["health"]["pendingQuestionsKnown"], false);
    let with_default = store.run_detail("run_1", Some(4.0)).unwrap().expect("held");
    assert_eq!(with_default.roster["scriptPath"], "/w/flow.js");
    assert_eq!(
        with_default.roster["modelBindings"],
        json!({"poet": "openai/gpt-x"})
    );
    assert_eq!(with_default.roster["logTail"][0]["message"], "fetching");
}

#[test]
fn list_runs_applies_cwd_and_the_logical_status_filter() {
    let conn = database();
    add_session(&conn, "ses_p");
    dwf::create_run(&conn, &run("run_1", "ses_p", "/w1", DwfStatus::Running), 1).unwrap();
    dwf::create_run(&conn, &run("run_2", "ses_p", "/w2", DwfStatus::Running), 1).unwrap();
    let store = store(conn);
    store.interrupt_run("run_2").unwrap();

    let in_w1 = store
        .list_runs(&RunListQuery {
            cwd: Some("/w1".to_owned()),
            limit: 5,
            statuses: None,
        })
        .unwrap();
    assert_eq!(in_w1.len(), 1);
    assert_eq!(in_w1[0].run.run_id, "run_1");

    let stopped = store
        .list_runs(&RunListQuery {
            cwd: None,
            limit: 5,
            statuses: Some(vec![RunStatus::Stopped]),
        })
        .unwrap();
    assert_eq!(stopped.len(), 1, "the interrupted run is stopped");
    assert_eq!(stopped[0].run.run_id, "run_2");
}

/// 9.50 (divergence 564): the detail reads the reports through the bounded event read. Its replayed state is the one a full read
/// gives: the first 64 reports keep their previews, and the run's roster rows come from the non-report rows only.
#[test]
fn run_detail_replays_the_same_state_as_a_full_read_over_more_than_the_report_cap() {
    let conn = database();
    add_session(&conn, "ses_p");
    dwf::create_run(&conn, &run("run_1", "ses_p", "/w", DwfStatus::Running), 7).unwrap();
    dwf::append_event(
        &conn,
        "run_1",
        &json!({"type": "run-started", "concurrencyCeiling": 4}),
        8,
    )
    .unwrap();
    let cap = rust_cli_node_store::WORKFLOW_RUN_LIMITS.max_reports;
    for ordinal in 0..(cap as i64 + 6) {
        dwf::append_event(
            &conn,
            "run_1",
            &json!({"type": "report", "instance": {"siteId": "site#1", "ordinal": ordinal},
                    "item": format!("report {ordinal}"), "label": "l"}),
            9,
        )
        .unwrap();
    }
    let record = dwf::get_run(&conn, "run_1").unwrap().expect("the run row");
    let full_events = dwf::list_events(&conn, "run_1").unwrap();
    let expected = rust_cli_node_store::replay_run_state(
        &record,
        &full_events,
        4.0,
        &rust_cli_node_store::WORKFLOW_RUN_LIMITS,
    )
    .and_then(|replayed| {
        replayed
            .runs
            .into_iter()
            .find(|run| run.get("runId").and_then(serde_json::Value::as_str) == Some("run_1"))
    })
    .expect("the full replay has the run");

    let store = store(conn);
    let detail = store.run_detail("run_1", Some(4.0)).unwrap().expect("held");
    let state = detail.state.expect("replayed with a default");
    assert_eq!(
        state.get("reports"),
        expected.get("reports"),
        "the bounded read replays the same reports as the full read"
    );
    let reports = state["reports"].as_array().expect("reports");
    assert_eq!(reports.len(), cap, "the run keeps the first {cap} reports");
    assert_eq!(reports[0]["preview"], json!("report 0"));
}

/// 9.61: the detail carries each published artifact's latest record in first-publication order, with the description the
/// projection drops (Node's port detail keeps it). The terminal notice's chips read it, with no configured default.
#[test]
fn run_detail_carries_the_latest_record_of_each_published_artifact() {
    let conn = database();
    add_session(&conn, "ses_p");
    dwf::create_run(&conn, &run("run_1", "ses_p", "/w", DwfStatus::Running), 7).unwrap();
    let published = |id: &str, version: u64, description: Option<&str>| {
        let mut artifact = json!({"id": id, "kind": "markdown", "version": version});
        if let Some(description) = description {
            artifact["description"] = json!(description);
        }
        json!({"type": "artifact-published", "instance": {"siteId": "a#1", "ordinal": version}, "artifact": artifact})
    };
    for (sequence, event) in [
        published("notes", 1, Some("first")),
        published("notes", 2, Some("second")),
        published("board", 1, Some("gone")),
        published("board", 2, None),
    ]
    .iter()
    .enumerate()
    {
        dwf::append_event(&conn, "run_1", event, 10 + sequence as i64).unwrap();
    }
    let detail = store(conn)
        .run_detail("run_1", None)
        .unwrap()
        .expect("held");
    assert_eq!(
        detail.published_artifacts,
        vec![
            json!({"id": "notes", "kind": "markdown", "version": 2, "description": "second"}),
            json!({"id": "board", "kind": "markdown", "version": 2}),
        ]
    );
}
