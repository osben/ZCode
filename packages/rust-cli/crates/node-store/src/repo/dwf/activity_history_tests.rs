//! Fork: the full Activity index of one parent session (Node `getActivityHistory`).

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

fn run(id: &str, parent: &str, status: RunStatus) -> RunRecord {
    RunRecord {
        run_id: id.to_owned(),
        parent_session_id: Some(parent.to_owned()),
        cwd: Some("/w".to_owned()),
        script_text: Some("return 1".to_owned()),
        max_concurrency: 2,
        status,
        ..RunRecord::default()
    }
}

fn actor(run_id: &str, ordinal: i64, session: Option<&str>) -> ActorRecord {
    ActorRecord {
        run_id: run_id.to_owned(),
        site_id: "site".to_owned(),
        ordinal,
        session_id: session.map(str::to_owned),
        ..ActorRecord::default()
    }
}

#[test]
fn history_lists_every_run_of_the_parent_with_its_physical_status_and_last_sequence() {
    let conn = database();
    add_session(&conn, "ses_p");
    add_session(&conn, "ses_q");
    // More runs than any preview holds: the read has no limit.
    for index in 0..105 {
        create_run(
            &conn,
            &run(&format!("run_{index:03}"), "ses_p", RunStatus::Completed),
            1,
        )
        .unwrap();
    }
    create_run(&conn, &run("run_stopped", "ses_p", RunStatus::Stopped), 1).unwrap();
    create_run(&conn, &run("run_failed", "ses_p", RunStatus::Errored), 1).unwrap();
    create_run(&conn, &run("run_other", "ses_q", RunStatus::Completed), 1).unwrap();
    append_event(&conn, "run_000", &json!({"type": "run-started"}), 1).unwrap();
    append_event(&conn, "run_000", &json!({"type": "run-settled"}), 2).unwrap();

    let history = activity_history(&conn, "ses_p").unwrap();
    assert_eq!(history.runs.len(), 107);
    let by_id: std::collections::HashMap<_, _> = history
        .runs
        .iter()
        .map(|item| (item.run_id.as_str(), item))
        .collect();
    assert!(!by_id.contains_key("run_other"));
    assert_eq!(by_id["run_000"].status, "completed");
    assert_eq!(by_id["run_000"].sequence, 1);
    assert_eq!(
        by_id["run_001"].sequence, -1,
        "a run with no event has sequence -1"
    );
    assert_eq!(by_id["run_stopped"].status, "cancelled");
    assert_eq!(by_id["run_failed"].status, "failed");
}

#[test]
fn history_lists_each_actor_session_once_and_skips_actors_without_one() {
    let conn = database();
    add_session(&conn, "ses_p");
    add_session(&conn, "ses_q");
    create_run(&conn, &run("run_a", "ses_p", RunStatus::Completed), 1).unwrap();
    create_run(&conn, &run("run_b", "ses_p", RunStatus::Running), 1).unwrap();
    create_run(&conn, &run("run_q", "ses_q", RunStatus::Completed), 1).unwrap();
    put_actor(&conn, &actor("run_a", 0, Some("ses_actor_1")), 1).unwrap();
    put_actor(&conn, &actor("run_a", 1, Some("ses_actor_1")), 1).unwrap();
    put_actor(&conn, &actor("run_b", 0, Some("ses_actor_2")), 1).unwrap();
    put_actor(&conn, &actor("run_b", 1, None), 1).unwrap();
    put_actor(&conn, &actor("run_q", 0, Some("ses_actor_q")), 1).unwrap();

    let mut children = activity_history(&conn, "ses_p").unwrap().child_session_ids;
    children.sort();
    assert_eq!(children, ["ses_actor_1", "ses_actor_2"]);
}

#[test]
fn history_of_a_parent_with_no_runs_is_empty() {
    let conn = database();
    add_session(&conn, "ses_p");
    assert_eq!(
        activity_history(&conn, "ses_p").unwrap(),
        ActivityHistory::default()
    );
}

#[test]
fn history_carries_the_time_of_each_runs_last_event_or_its_last_update() {
    let conn = database();
    add_session(&conn, "ses_p");
    create_run(&conn, &run("run_ev", "ses_p", RunStatus::Completed), 10).unwrap();
    create_run(&conn, &run("run_bare", "ses_p", RunStatus::Stopped), 20).unwrap();
    append_event(&conn, "run_ev", &json!({"type": "run-started"}), 11).unwrap();
    append_event(&conn, "run_ev", &json!({"type": "run-settled"}), 15).unwrap();

    let history = activity_history(&conn, "ses_p").unwrap();
    let at = |id: &str| {
        history
            .runs
            .iter()
            .find(|item| item.run_id == id)
            .map(|item| item.updated_at)
    };
    assert_eq!(at("run_ev"), Some(15));
    assert_eq!(
        at("run_bare"),
        Some(20),
        "no event: the run row's update time"
    );
}

#[test]
fn history_time_includes_a_settlement_written_without_an_event() {
    // Startup reconciliation interrupts a run through the row, with no journal event.
    let conn = database();
    add_session(&conn, "ses_p");
    create_run(&conn, &run("run_cut", "ses_p", RunStatus::Running), 10).unwrap();
    append_event(&conn, "run_cut", &json!({"type": "run-started"}), 11).unwrap();
    interrupt_unsettled_run(&conn, "run_cut", &Settlement::default(), 40).unwrap();

    let history = activity_history(&conn, "ses_p").unwrap();
    assert_eq!(history.runs[0].updated_at, 40);
}
