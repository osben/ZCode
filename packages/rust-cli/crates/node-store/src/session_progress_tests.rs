//! W7-5e: the progress payload lands as Node's `dynamic_workflow_run_progress` event, byte for byte.
use rusqlite::params;
use serde_json::{Value, json};

use super::{PROGRESS_ENTRY_TYPE, record_progress};
use crate::{MIGRATION_LOCK_WAIT, open_session_database};

/// Node's `DynamicWorkflowRunProgressPayload` for one `node-settled` event, written as Node's `toProgressPayload` writes
/// it (`actorSessionId` is a derived field, present on an ask's cached settle).
fn node_payload() -> Value {
    json!({
        "runId": "dwfrun-7",
        "toolCallId": "toolu_9",
        "sequence": 12,
        "eventType": "node-settled",
        "payload": {"nodeId": "n1", "status": "done", "cached": false},
        "actorSessionId": "sess_dwf-dwfrun-7-a1"
    })
}

fn database() -> (tempfile::TempDir, rusqlite::Connection) {
    let dir = tempfile::tempdir().expect("temp dir");
    let (conn, _) = open_session_database(&dir.path().join("s.db"), MIGRATION_LOCK_WAIT, 1)
        .expect("session database");
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values ('ses_parent', 'proj', null, 'p', '/work', 'title', '0.0.0', 1, 5)",
        [],
    )
    .expect("parent session");
    (dir, conn)
}

#[test]
fn the_payload_is_appended_to_the_parent_as_nodes_event_byte_for_byte() {
    let (_dir, conn) = database();
    record_progress(&conn, "ses_parent", &node_payload(), 42).expect("recorded");

    let (kind, time, data): (String, i64, String) = conn
        .query_row(
            "select type, time_created, data from session_entry where session_id = ?",
            params!["ses_parent"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("one progress row");
    assert_eq!(kind, PROGRESS_ENTRY_TYPE);
    assert_eq!(time, 42);
    let stored: Value = serde_json::from_str(&data).expect("the row's data is JSON");
    assert_eq!(stored, node_payload());
}

#[test]
fn a_re_record_of_the_same_sequence_replaces_the_row_and_keeps_the_session_time() {
    let (_dir, conn) = database();
    record_progress(&conn, "ses_parent", &node_payload(), 42).expect("first");
    record_progress(&conn, "ses_parent", &node_payload(), 43).expect("second");

    let rows: i64 = conn
        .query_row(
            "select count(*) from session_entry where session_id = 'ses_parent' and type = ?",
            params![PROGRESS_ENTRY_TYPE],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(rows, 1);
    let updated: i64 = conn
        .query_row(
            "select time_updated from session where id = 'ses_parent'",
            [],
            |row| row.get(0),
        )
        .expect("session row");
    assert_eq!(
        updated, 5,
        "a progress row does not move the session's activity time"
    );
}

#[test]
fn a_payload_without_a_run_id_or_sequence_is_refused() {
    let (_dir, conn) = database();
    let no_run = json!({"sequence": 1, "eventType": "log", "payload": {}});
    assert!(record_progress(&conn, "ses_parent", &no_run, 1).is_err());
    let no_sequence = json!({"runId": "dwfrun-7", "eventType": "log", "payload": {}});
    assert!(record_progress(&conn, "ses_parent", &no_sequence, 1).is_err());
}
