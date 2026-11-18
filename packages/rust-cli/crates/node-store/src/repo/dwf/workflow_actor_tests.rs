//! W6a part 2b: the actor session row is Node's `workflow_child` under its parent, and the owned-tree walk
//! includes it, as Node's `OWNED_CHILD_TASK_TYPES` does.
use super::*;
use std::path::Path;
use std::time::Duration;

fn database() -> Connection {
    let (conn, _) = crate::repo::open::open(Path::new(":memory:"), Duration::from_secs(1), 0)
        .expect("in-memory session database with every Node migration");
    conn
}

fn add_parent(conn: &Connection, id: &str) {
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values (?, 'proj', null, ?, '/work', 'title', '0.0.0', 1, 1)",
        params![id, id],
    )
    .expect("parent session row");
}

#[test]
fn a_workflow_actor_session_is_a_workflow_child_under_its_parent_and_not_a_fork() {
    let conn = database();
    add_parent(&conn, "sess_p");
    create_workflow_actor_session(
        &conn,
        &WorkflowActorSession {
            id: "sess_child",
            parent_session_id: "sess_p",
            directory: "/work",
            title: "workflow subagent site#1@0",
            trace_id: "trace_1",
            version: "0.0.0",
            created_at: 20,
        },
    )
    .expect("actor session row");
    let row: (String, Option<String>, String) = conn
        .query_row(
            "select task_type, parent_id, title from session where id = 'sess_child'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("row");
    assert_eq!(
        row,
        (
            "workflow_child".to_owned(),
            Some("sess_p".to_owned()),
            "workflow subagent site#1@0".to_owned()
        )
    );
}

#[test]
fn a_workflow_child_is_an_owned_member_of_its_parent_tree() {
    let conn = database();
    add_parent(&conn, "sess_p");
    create_workflow_actor_session(
        &conn,
        &WorkflowActorSession {
            id: "sess_child",
            parent_session_id: "sess_p",
            directory: "/work",
            title: "t",
            trace_id: "trace_1",
            version: "0.0.0",
            created_at: 20,
        },
    )
    .expect("actor session row");
    let tree = crate::session_deletion::owned_tree(&conn, "sess_p").expect("tree");
    assert_eq!(tree, vec!["sess_p".to_owned(), "sess_child".to_owned()]);
}
