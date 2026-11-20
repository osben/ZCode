//! Host run lists (Node `dwf-journal-introspection.ts`: `listRuns`, `listRunsByParentSession`).

use super::codecs::PhysicalStatus;
use super::*;
use serde_json::json;
use std::time::Duration;

fn database() -> Connection {
    let (conn, _) = crate::repo::open::open(Path::new(":memory:"), Duration::from_secs(1), 0)
        .expect("in-memory session database with every Node migration");
    conn
}

fn add_session(conn: &Connection, id: &str) {
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values (?, 'proj', null, ?, '/work', 'title', '0.0.0', 1, 1)",
        rusqlite::params![id, id],
    )
    .expect("session row for the run's parent");
}

fn run_in(id: &str, parent: &str, cwd: &str, status: RunStatus) -> RunRecord {
    RunRecord {
        run_id: id.to_owned(),
        parent_session_id: Some(parent.to_owned()),
        cwd: Some(cwd.to_owned()),
        script_text: Some(format!("return {id}")),
        max_concurrency: 2,
        status,
        result: Some(json!("kept out of lists")),
        ..RunRecord::default()
    }
}

#[test]
fn session_list_is_newest_updated_first_with_the_id_tie_break_and_a_limit() {
    // Node: order by time_updated desc, id desc, limit ?. A zero limit is an empty page.
    let conn = database();
    add_session(&conn, "ses_p");
    add_session(&conn, "ses_other");
    create_run(
        &conn,
        &run_in("run_a", "ses_p", "/w", RunStatus::Running),
        10,
    )
    .unwrap();
    create_run(
        &conn,
        &run_in("run_b", "ses_p", "/w", RunStatus::Running),
        10,
    )
    .unwrap();
    create_run(
        &conn,
        &run_in("run_c", "ses_p", "/w", RunStatus::Running),
        20,
    )
    .unwrap();
    create_run(
        &conn,
        &run_in("run_x", "ses_other", "/w", RunStatus::Running),
        30,
    )
    .unwrap();

    let ids: Vec<String> = list_runs_by_parent_session(&conn, "ses_p", 16)
        .unwrap()
        .into_iter()
        .map(|row| row.run.run_id)
        .collect();
    assert_eq!(ids, ["run_c", "run_b", "run_a"]);
    assert_eq!(
        list_runs_by_parent_session(&conn, "ses_p", 2)
            .unwrap()
            .len(),
        2
    );
    assert!(
        list_runs_by_parent_session(&conn, "ses_p", 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn list_rows_carry_timestamps_and_never_the_result() {
    let conn = database();
    add_session(&conn, "ses_p");
    create_run(
        &conn,
        &run_in("run_a", "ses_p", "/w", RunStatus::Completed),
        10,
    )
    .unwrap();
    let row = list_runs_by_parent_session(&conn, "ses_p", 1)
        .unwrap()
        .remove(0);
    assert_eq!((row.time_created, row.time_updated), (10, 10));
    assert_eq!(row.run.result, None, "result_json is not selected");
}

#[test]
fn stopped_filter_matches_cancelled_and_interrupted_failures_only() {
    // Node encodeRunStatusPredicate: stopped = cancelled, or failed with code Interrupted;
    // errored = failed whose code is not Interrupted.
    let conn = database();
    add_session(&conn, "ses_p");
    create_run(
        &conn,
        &run_in("run_user", "ses_p", "/w", RunStatus::Stopped),
        1,
    )
    .unwrap();
    let mut interrupted = run_in("run_interrupted", "ses_p", "/w", RunStatus::Stopped);
    interrupted.stop_reason = Some(StopReason::Interrupted);
    interrupted.failure = Some(json!({"code": "Interrupted", "message": "gone"}));
    create_run(&conn, &interrupted, 2).unwrap();
    create_run(
        &conn,
        &run_in("run_err", "ses_p", "/w", RunStatus::Errored),
        3,
    )
    .unwrap();
    conn.execute(
        "update dwf_run set status = 'failed', failure_json = '{\"code\":\"DriverError\"}' where id = 'run_err'",
        [],
    )
    .unwrap();
    conn.execute(
        "update dwf_run set status = 'failed', failure_json = '{\"code\":\"Interrupted\"}' where id = 'run_interrupted'",
        [],
    )
    .unwrap();
    assert_eq!(
        PhysicalStatus::from_column("failed"),
        Some(PhysicalStatus::Failed)
    );

    let ids = |statuses: Vec<RunStatus>| -> Vec<String> {
        list_runs(
            &conn,
            &RunListQuery {
                cwd: None,
                limit: 10,
                statuses: Some(statuses),
            },
        )
        .unwrap()
        .into_iter()
        .map(|row| row.run.run_id)
        .collect()
    };
    let mut stopped = ids(vec![RunStatus::Stopped]);
    stopped.sort();
    assert_eq!(stopped, ["run_interrupted", "run_user"]);
    assert_eq!(ids(vec![RunStatus::Errored]), ["run_err"]);
    assert!(
        ids(vec![]).is_empty(),
        "an empty status set matches nothing"
    );
}

#[test]
fn list_runs_filters_by_cwd_and_orders_by_time_updated() {
    let conn = database();
    add_session(&conn, "ses_p");
    create_run(
        &conn,
        &run_in("run_a", "ses_p", "/w1", RunStatus::Running),
        10,
    )
    .unwrap();
    create_run(
        &conn,
        &run_in("run_b", "ses_p", "/w2", RunStatus::Running),
        20,
    )
    .unwrap();
    let rows = list_runs(
        &conn,
        &RunListQuery {
            cwd: Some("/w1".to_owned()),
            limit: 5,
            statuses: None,
        },
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].run.run_id, "run_a");
    let all = list_runs(
        &conn,
        &RunListQuery {
            cwd: None,
            limit: 5,
            statuses: None,
        },
    )
    .unwrap();
    assert_eq!(all[0].run.run_id, "run_b", "no cwd filter: newest first");
}

#[test]
fn list_runs_breaks_ties_on_time_updated_by_id_desc() {
    // Ties are realistic (one sweep stamps every orphan with the same clock). Node's listRuns has no tie-break
    // (divergence 251); here the order is pinned so a page is stable.
    let conn = database();
    add_session(&conn, "ses_p");
    create_run(
        &conn,
        &run_in("run_a", "ses_p", "/w", RunStatus::Running),
        10,
    )
    .unwrap();
    create_run(
        &conn,
        &run_in("run_b", "ses_p", "/w", RunStatus::Running),
        10,
    )
    .unwrap();
    let ids: Vec<String> = list_runs(
        &conn,
        &RunListQuery {
            cwd: None,
            limit: 5,
            statuses: None,
        },
    )
    .unwrap()
    .into_iter()
    .map(|row| row.run.run_id)
    .collect();
    assert_eq!(ids, ["run_b", "run_a"]);
}

#[test]
fn a_guarded_interrupt_writes_only_while_the_row_is_unsettled() {
    // A run that settled after it was enumerated keeps its settlement: the orphan write is conditional.
    let conn = database();
    add_session(&conn, "ses_p");
    create_run(
        &conn,
        &run_in("run_open", "ses_p", "/w", RunStatus::Running),
        1,
    )
    .unwrap();
    create_run(
        &conn,
        &run_in("run_done", "ses_p", "/w", RunStatus::Running),
        1,
    )
    .unwrap();
    update_run_status(&conn, "run_done", RunStatus::Completed, None, 2).unwrap();
    let settlement = Settlement {
        stop_reason: Some(StopReason::Interrupted),
        failure: Some(json!({"code": "Interrupted", "message": "gone"})),
        ..Settlement::default()
    };

    assert!(interrupt_unsettled_run(&conn, "run_open", &settlement, 3).unwrap());
    assert!(!interrupt_unsettled_run(&conn, "run_done", &settlement, 3).unwrap());

    assert_eq!(
        get_run(&conn, "run_open").unwrap().unwrap().status,
        RunStatus::Stopped
    );
    let done = get_run(&conn, "run_done").unwrap().unwrap();
    assert_eq!(done.status, RunStatus::Completed, "the settled run is kept");
    assert_eq!(done.stop_reason, None);
    assert!(interrupt_unsettled_run(&conn, "run_missing", &settlement, 3).is_err());
}
