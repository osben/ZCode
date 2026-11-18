//! `NodeActorSessions`: the session row and the `workflow_actor` link of an actor, written through node-store, and the
//! turn calls delegated to the turn side. Runs on the Node-format database the shared user data uses.
use crate::actor_sessions::{ActorTurns, NodeActorSessions};
use crate::driver_owner::{ActorSessionRequest, ActorSessions};
use crate::driver_rules::WORKFLOW_ACTOR_LINK_ROLE;
use crate::engine::AskMessage;
use crate::model::Ref;
use rust_cli_node_store::mint_actor_session_id;
use serde_json::json;
use std::path::Path;
use std::time::Duration;

fn database() -> rusqlite::Connection {
    let (conn, _) = rust_cli_node_store::open_session_database(
        Path::new(":memory:"),
        Duration::from_secs(1),
        0,
    )
    .expect("in-memory session database with every Node migration");
    conn
}

fn add_parent(conn: &rusqlite::Connection, id: &str) {
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values (?, 'proj', null, ?, '/work', 'title', '0.0.0', 1, 1)",
        rusqlite::params![id, id],
    )
    .expect("parent session row");
}

#[derive(Default)]
struct Turns {
    started: Vec<String>,
    cancelled: Vec<String>,
    rejected: Vec<(String, String)>,
}

impl ActorTurns for Turns {
    fn start_turn(
        &mut self,
        session: &str,
        _instance: &Ref,
        _message: &AskMessage,
    ) -> anyhow::Result<()> {
        self.started.push(session.to_owned());
        Ok(())
    }

    fn cancel_turn(&mut self, session: &str, _instance: &Ref) -> anyhow::Result<()> {
        self.cancelled.push(session.to_owned());
        Ok(())
    }

    fn reject_parked(&mut self, session: &str, qid: &str) -> anyhow::Result<()> {
        self.rejected.push((session.to_owned(), qid.to_owned()));
        Ok(())
    }

    fn deliver_answer(&mut self, _session: &str, _qid: &str, _answer: &str) -> anyhow::Result<()> {
        Ok(())
    }
}

fn request(parent: Option<&str>) -> ActorSessionRequest {
    ActorSessionRequest {
        run_id: "run_1".into(),
        parent_session_id: parent.map(str::to_owned),
        actor: Ref::new("site", 1),
        title: "workflow subagent site@1".into(),
        link_path: "dwf/run_1/site@1".into(),
        persona: json!({}),
    }
}

fn clock() -> i64 {
    42
}

#[test]
fn create_session_writes_a_workflow_child_row_and_its_workflow_actor_link() {
    let conn = database();
    add_parent(&conn, "sess_p");
    let mut sessions = NodeActorSessions::new(&conn, "/work", "0.0.0", clock, Turns::default());
    let id = sessions
        .create_session(&request(Some("sess_p")))
        .expect("session");
    assert!(id.starts_with("sess_dwf-run__1-"), "{id}"); // the underscore is escaped to two, as Node does

    let (task_type, parent): (String, Option<String>) = conn
        .query_row(
            "select task_type, parent_id from session where id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("session row");
    assert_eq!(task_type, "workflow_child");
    assert_eq!(parent.as_deref(), Some("sess_p"));

    let (role, path, child, link_parent): (String, String, String, Option<String>) = conn
        .query_row(
            "select role, path, child_session_id, parent_session_id from session_task_link where child_session_id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("link row");
    assert_eq!(role, WORKFLOW_ACTOR_LINK_ROLE);
    assert_eq!(path, "dwf/run_1/site@1");
    assert_eq!(child, id);
    assert_eq!(link_parent.as_deref(), Some("sess_p"));
}

#[test]
fn the_session_id_is_the_replay_envelope_id_for_the_actor() {
    let conn = database();
    add_parent(&conn, "sess_p");
    let mut sessions = NodeActorSessions::new(&conn, "/work", "0.0.0", clock, Turns::default());
    let id = sessions
        .create_session(&request(Some("sess_p")))
        .expect("session");
    assert_eq!(id, mint_actor_session_id("run_1", "site", 1.0));
}

#[test]
fn an_actor_without_a_parent_session_is_refused_and_writes_nothing() {
    let conn = database();
    let mut sessions = NodeActorSessions::new(&conn, "/work", "0.0.0", clock, Turns::default());
    let error = sessions
        .create_session(&request(None))
        .expect_err("no parent, no session");
    assert!(error.to_string().contains("parent"), "{error}");
    let count: i64 = conn
        .query_row(
            "select count(*) from session where task_type = 'workflow_child'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(count, 0);
}

#[test]
fn turn_calls_are_delegated_to_the_turn_side_unchanged() {
    let conn = database();
    let mut sessions = NodeActorSessions::new(&conn, "/work", "0.0.0", clock, Turns::default());
    let message = AskMessage {
        instructions: "do it".into(),
        typed: false,
        schema: None,
    };
    sessions
        .start_turn("sess_x", &Ref::new("ask", 1), &message)
        .expect("start");
    sessions
        .cancel_turn("sess_x", &Ref::new("ask", 1))
        .expect("cancel");
    sessions
        .reject_parked("sess_x", "dwfq-run-0")
        .expect("reject");
    let turns = sessions.into_turns();
    assert_eq!(turns.started, vec!["sess_x".to_owned()]);
    assert_eq!(turns.cancelled, vec!["sess_x".to_owned()]);
    assert_eq!(
        turns.rejected,
        vec![("sess_x".to_owned(), "dwfq-run-0".to_owned())]
    );
}
