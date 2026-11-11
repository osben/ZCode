//! fork_execution_worktree: Node's columns, set once; a database without them holds no worktree.

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::SessionStore;

use super::*;
use crate::tests::{TestStore, started};

/// The Node agent's fork migration `9002_fork_session_execution_worktree` (zcode-rs does not migrate it).
fn node_columns(conn: &Connection) {
    conn.execute_batch(
        "alter table session add column execution_directory text;
         alter table session add column execution_branch text;",
    )
    .unwrap();
}

#[tokio::test]
async fn without_the_node_columns_there_is_no_worktree_and_a_write_is_refused() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let conn = t.connection();
    assert_eq!(read(&conn, "sess_1").unwrap(), None);
    let loaded = t.store.load(&SessionId::new("sess_1")).await.unwrap();
    assert!(!loaded.execution_worktree);
    assert!(matches!(
        write(&conn, "sess_1", "/w/.worktrees/a", Some("a")),
        Err(StoreError::Unsupported { .. })
    ));
}

#[tokio::test]
async fn the_first_worktree_is_kept_and_the_directory_stays_the_parent() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let conn = t.connection();
    node_columns(&conn);
    assert_eq!(read(&conn, "sess_1").unwrap(), None);
    write(&conn, "sess_1", "/w/.worktrees/a", Some("feat/a")).unwrap();
    write(&conn, "sess_1", "/elsewhere", Some("other")).unwrap();
    let stored = read(&conn, "sess_1").unwrap().unwrap();
    assert_eq!(stored.directory.as_str(), "/w");
    assert_eq!(stored.path.as_str(), "/w/.worktrees/a");
    assert_eq!(stored.branch.as_deref(), Some("feat/a"));
    assert!(matches!(
        write(&conn, "sess_none", "/x", None),
        Err(StoreError::NotFound { .. })
    ));
}

#[tokio::test]
async fn a_cold_open_runs_in_the_worktree_and_lists_under_the_parent() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let conn = t.connection();
    node_columns(&conn);
    let worktree = t.dir.path().join("wt-a");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    // What Node's `persist` writes for a worktree session: `directory` the parent, the execution columns the worktree.
    conn.execute(
        "update session set execution_directory = ?1, execution_branch = 'feat/a' where id = 'sess_1'",
        [worktree.to_str().unwrap()],
    )
    .unwrap();
    let id = SessionId::new("sess_1");
    let loaded = t.store.load(&id).await.unwrap();
    assert_eq!(
        loaded.meta.workspace.root.as_str(),
        worktree.to_str().unwrap()
    );
    assert!(loaded.execution_worktree);
    let row = crate::reconcile_row::row(&conn, "sess_1").unwrap().unwrap();
    assert_eq!(row["directory"], "/w");
    // The listed workspace is the row's directory, never the worktree it runs in.
    let key = rust_cli_kernel_api::store::StoreQueries::session_workspace_key(&t.store, &id)
        .await
        .unwrap();
    assert_eq!(key.as_deref(), Some("/w"));
    let unknown = SessionId::new("sess_none");
    let none = rust_cli_kernel_api::store::StoreQueries::session_workspace_key(&t.store, &unknown)
        .await
        .unwrap();
    assert_eq!(none, None);
    // A Node row with a workspace identity is listed under the identity (Node `workspaceID ?? directory`).
    conn.execute(
        "update session set workspace_id = 'remote:ssh:box:/repo' where id = 'sess_1'",
        [],
    )
    .unwrap();
    let key = rust_cli_kernel_api::store::StoreQueries::session_workspace_key(&t.store, &id)
        .await
        .unwrap();
    assert_eq!(key.as_deref(), Some("remote:ssh:box:/repo"));
}

#[tokio::test]
async fn a_missing_worktree_stays_the_root_so_tools_never_reach_the_parent() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let conn = t.connection();
    node_columns(&conn);
    let gone = t.dir.path().join("removed-worktree");
    write(&conn, "sess_1", gone.to_str().unwrap(), Some("feat/a")).unwrap();
    let loaded = t.store.load(&SessionId::new("sess_1")).await.unwrap();
    assert_eq!(loaded.meta.workspace.root.as_str(), gone.to_str().unwrap());
    // The stored fact stays: the listing still reports the worktree (as missing).
    assert!(read(&conn, "sess_1").unwrap().is_some());
}
