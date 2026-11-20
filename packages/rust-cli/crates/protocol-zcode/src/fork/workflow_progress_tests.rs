//! W7-5e: the production progress port appends Node's event to the parent session and hands the deltas to the Host.

use std::sync::{Arc, Mutex};

use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use rust_cli_node_store::{MIGRATION_LOCK_WAIT, open_session_database};
use serde_json::{Value, json};

use super::{ProgressDelivery, WorkflowProgressHost};

#[derive(Default)]
struct Recording {
    calls: Mutex<Vec<(String, Vec<Value>)>>,
}

impl ProgressDelivery for Recording {
    fn deliver(&self, parent_session_id: &str, deltas: Vec<Value>) {
        self.calls
            .lock()
            .expect("calls")
            .push((parent_session_id.to_owned(), deltas));
    }
}

/// Node's `DynamicWorkflowRunProgressPayload` for one `node-settled` event.
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

/// A session database with one parent session, and the port over it.
fn port() -> (tempfile::TempDir, WorkflowProgressHost, Arc<Recording>) {
    let dir = tempfile::tempdir().expect("temp dir");
    let database = dir.path().join("s.db");
    {
        let (conn, _) =
            open_session_database(&database, MIGRATION_LOCK_WAIT, 1).expect("session database");
        conn.execute(
            "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
             values ('ses_parent', 'proj', null, 'p', '/work', 'title', '0.0.0', 1, 5)",
            [],
        )
        .expect("parent session");
    }
    let recording = Arc::new(Recording::default());
    let host = WorkflowProgressHost::new(database, recording.clone());
    (dir, host, recording)
}

fn stored_rows(dir: &tempfile::TempDir) -> Vec<(String, String)> {
    let (conn, _) = open_session_database(&dir.path().join("s.db"), MIGRATION_LOCK_WAIT, 2)
        .expect("session database");
    let mut query = conn
        .prepare("select type, data from session_entry where session_id = 'ses_parent' order by id")
        .expect("query");
    query
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("rows")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collected")
}

#[test]
fn the_port_appends_nodes_event_to_the_parent_and_hands_the_deltas_to_the_host() {
    let (dir, host, recording) = port();
    let delta = json!({"workflowRuns": {"dwfrun-7": {"status": "running"}}});

    host.record("ses_parent", &node_payload(), std::slice::from_ref(&delta))
        .expect("recorded");

    let rows = stored_rows(&dir);
    assert_eq!(rows.len(), 1, "one progress row for the event");
    assert_eq!(rows[0].0, "dynamic_workflow_run_progress");
    let data: Value = serde_json::from_str(&rows[0].1).expect("the row's data is JSON");
    assert_eq!(data, node_payload(), "the row is Node's payload, unchanged");

    let calls = recording.calls.lock().expect("calls");
    assert_eq!(calls.len(), 1, "the Host hears the deltas once");
    assert_eq!(calls[0].0, "ses_parent");
    assert_eq!(calls[0].1, vec![delta]);
}

#[test]
fn a_refused_append_is_an_error_and_tells_the_host_nothing() {
    let (_dir, host, recording) = port();
    let refused = json!({"sequence": 1, "eventType": "log", "payload": {}});

    assert!(
        host.record("ses_parent", &refused, &[json!({"x": 1})])
            .is_err(),
        "a payload without a run id is refused"
    );
    assert!(
        recording.calls.lock().expect("calls").is_empty(),
        "no notification for an event that was not appended"
    );
}
