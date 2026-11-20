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
    let state = store
        .run_state("run_1", 4.0)
        .unwrap()
        .expect("the run replays");
    let pending = state["pendingQuestions"].as_array().expect("pending list");
    assert_eq!(pending.len(), 1, "{state:?}");
    assert_eq!(pending[0]["qid"], "dwfq-run_1-0");
    assert_eq!(pending[0]["question"], "which branch?");
    assert_eq!(pending[0]["actorName"], "poet");
    assert!(store.run_state("run_9", 4.0).unwrap().is_none());
}

/// 9.42: the run row's own timestamps (the detail read needs them; the row read leaves them out).
#[test]
fn run_times_read_the_row_timestamps_and_none_for_an_unknown_run() {
    let conn = database();
    add_session(&conn, "ses_p");
    dwf::create_run(&conn, &run("run_1", "ses_p", "/w", DwfStatus::Running), 7).unwrap();
    let store = store(conn);
    store.interrupt_run("run_1").unwrap();

    assert_eq!(store.run_times("run_1").unwrap(), Some((7, 500)));
    assert_eq!(store.run_times("run_9").unwrap(), None);
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
