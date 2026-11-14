//! Fork: the session runtime presence protocol on the shared database (specs/fork-rust-agent-parity.md "Session
//! runtime presence on the shared database").
use std::time::{Duration, Instant};

use rusqlite::{Connection, params};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::store::{
    SessionFilter, SessionOrder, SessionQuery, SessionStore, StoreError, StoreQueries,
};
use serde_json::Value;

use crate::repo::migrations::checksum;
use crate::tests::{TestStore, batch, meta, user};

/// Upstream `0025_session_permanent_deletion` exactly as Node's `SQLITE_MIGRATIONS` renders its `sql` (the template
/// expanded). node-store never applies it; the tests apply it the way a Node build migrates the shared database.
const UPSTREAM_0025: &str =
    rust_cli_base::include_lf!("fixtures/0025_session_permanent_deletion.sql");
const PINS: &str = include_str!("../../../../../fork-upstream-migrations.json");

fn sid() -> SessionId {
    SessionId::new("sess_presence")
}

/// A store whose database a Node build has migrated through 0025, with one session row.
async fn migrated() -> TestStore {
    let store = TestStore::new();
    store
        .store
        .create(meta("sess_presence", "/w", "t"))
        .await
        .unwrap();
    store.connection().execute_batch(UPSTREAM_0025).unwrap();
    store
}

fn presence(store: &TestStore) -> Vec<(String, String, i64)> {
    store
        .rows("select session_id, owner_id, process_id from session_runtime_presence order by owner_id")
        .into_iter()
        .map(|row| {
            (
                row[0].as_str().unwrap().to_owned(),
                row[1].as_str().unwrap().to_owned(),
                row[2].as_i64().unwrap(),
            )
        })
        .collect()
}

/// A presence release runs on a blocking thread after the guard drops: wait until `done` holds (bounded).
async fn eventually(store: &TestStore, done: impl Fn(&[(String, String, i64)]) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if done(&presence(store)) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "presence never settled: {:?}",
            presence(store)
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Node `${process.pid}:${randomUUID()}`.
fn node_owner_format(owner: &str) -> bool {
    let Some((pid, uuid)) = owner.split_once(':') else {
        return false;
    };
    pid == std::process::id().to_string()
        && uuid.len() == 36
        && uuid.chars().all(|c| c == '-' || c.is_ascii_hexdigit())
        && uuid.as_bytes()[14] == b'4'
}

/// A Rust transcription of the `session-data.running` decision of Node `beginSessionDeletion`
/// (`repositories/sessions.ts` `inspectSessionDeletion`, for a root without children, without the revision check)
/// inside `begin immediate`, then the `deleting` receipt. `node_owner` is the Node process's own owner id. The real
/// Node code runs against Rust's insert statement in
/// `apps/zcode-cli/packages/adapters/tests/fork-rust-runtime-presence.test.ts`.
fn node_begin_session_deletion(
    conn: &Connection,
    root: &str,
    node_owner: &str,
) -> Result<(), String> {
    conn.execute_batch("begin immediate").unwrap();
    let decided = (|| {
        let rows: Vec<(String, String, i64)> = conn
            .prepare("select session_id,owner_id,process_id from session_runtime_presence")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let mut foreign_runtime = false;
        for (session, owner, pid) in rows {
            if session != root || owner == node_owner {
                continue;
            }
            if rust_cli_fs::process_alive(u32::try_from(pid).unwrap()) {
                foreign_runtime = true;
            } else {
                conn.execute(
                    "delete from session_runtime_presence where session_id=? and owner_id=?",
                    params![session, owner],
                )
                .unwrap();
            }
        }
        let pending: bool = conn
            .query_row(
                "select exists(select 1 from session_input where session_id=?1 and status='admitted')
                   or exists(select 1 from session_target where session_id=?1 and status='active')",
                [root],
                |row| row.get(0),
            )
            .unwrap();
        if foreign_runtime || pending {
            return Err("session-data.running".to_owned());
        }
        conn.execute(
            "insert into session_purge(session_id,root_id,operation_id,retained_artifacts,workspace_path,workspace_identity,state) values(?1,?1,'op-1','[]','/w',null,'deleting')",
            [root],
        )
        .unwrap();
        Ok(())
    })();
    conn.execute_batch(if decided.is_ok() {
        "commit"
    } else {
        "rollback"
    })
    .unwrap();
    decided
}

#[test]
fn the_fixture_is_upstream_0025_byte_for_byte() {
    let pins: Value = serde_json::from_str(PINS).unwrap();
    let pinned = pins
        .as_object()
        .unwrap()
        .values()
        .filter_map(|set| set.get("cli"))
        .flat_map(|cli| cli.as_array().unwrap())
        .find(|entry| entry["id"] == "0025_session_permanent_deletion")
        .map(|entry| entry["checksum"].as_str().unwrap().to_owned())
        .expect("0025 is pinned in fork-upstream-migrations.json");
    assert_eq!(checksum(UPSTREAM_0025), pinned);
}

#[tokio::test]
async fn an_open_registers_a_row_in_node_format_and_the_drop_releases_it() {
    let store = migrated().await;
    let guard = store.store.register_runtime(&sid()).await.unwrap();
    assert!(guard.holds());
    let rows = presence(&store);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "sess_presence");
    assert!(node_owner_format(&rows[0].1), "owner {}", rows[0].1);
    assert_eq!(rows[0].2, i64::from(std::process::id()));
    drop(guard);
    eventually(&store, <[_]>::is_empty).await;
}

#[tokio::test]
async fn a_release_after_a_reopen_keeps_the_reopened_row() {
    let store = migrated().await;
    let first = store.store.register_runtime(&sid()).await.unwrap();
    let first_owner = presence(&store)[0].1.clone();
    // The close's release runs later, on a blocking thread; the reopen registers meanwhile.
    drop(first);
    let second = store.store.register_runtime(&sid()).await.unwrap();
    eventually(&store, |rows| rows.iter().all(|row| row.1 != first_owner)).await;
    let rows = presence(&store);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_ne!(rows[0].1, first_owner);
    drop(second);
    eventually(&store, <[_]>::is_empty).await;
}

#[tokio::test]
async fn node_begin_session_deletion_refuses_while_rust_holds_the_session() {
    let store = migrated().await;
    let node = store.connection();
    let node_owner = "1:00000000-0000-4000-8000-00000000abcd";
    let guard = store.store.register_runtime(&sid()).await.unwrap();
    assert_eq!(
        node_begin_session_deletion(&node, "sess_presence", node_owner),
        Err("session-data.running".to_owned())
    );
    assert!(store.rows("select * from session_purge").is_empty());
    // Closed: the purge goes through, and the next open is refused by the presence barrier.
    drop(guard);
    eventually(&store, <[_]>::is_empty).await;
    assert_eq!(
        node_begin_session_deletion(&node, "sess_presence", node_owner),
        Ok(())
    );
    assert_eq!(
        store.store.register_runtime(&sid()).await.unwrap_err(),
        StoreError::Deleting
    );
    assert!(presence(&store).is_empty());
}

#[tokio::test]
async fn a_purge_row_refuses_the_open_and_writes_as_deleting() {
    let store = migrated().await;
    store
        .connection()
        .execute(
            "insert into session_purge(session_id,root_id,operation_id,retained_artifacts,workspace_path,state) values('sess_presence','sess_presence','op','[]','/w','deleted')",
            [],
        )
        .unwrap();
    let refused = store.store.register_runtime(&sid()).await.unwrap_err();
    assert_eq!(refused, StoreError::Deleting);
    assert_eq!(refused.to_string(), "session-data.deleting");
    assert!(presence(&store).is_empty());
    // A write the purge triggers abort is typed, not a generic storage failure.
    let commit = store
        .store
        .commit(&sid(), batch(None, vec![user("u1", "hello")]))
        .await
        .unwrap_err();
    assert_eq!(commit, StoreError::Deleting);
    assert_eq!(
        store.store.assert_not_deleting(&[sid()]).await.unwrap_err(),
        StoreError::Deleting
    );
    assert_eq!(
        store
            .store
            .assert_not_deleting(&[SessionId::new("other")])
            .await,
        Ok(())
    );
}

#[tokio::test]
async fn lists_skip_a_session_being_purged() {
    let store = migrated().await;
    store
        .store
        .create(meta("sess_kept", "/w", "kept"))
        .await
        .unwrap();
    for id in ["sess_presence", "sess_kept"] {
        store
            .store
            .commit(
                &SessionId::new(id),
                batch(None, vec![user(&format!("{id}-u"), "hi")]),
            )
            .await
            .unwrap();
    }
    store
        .connection()
        .execute(
            "insert into session_purge(session_id,root_id,operation_id,retained_artifacts,workspace_path,state) values('sess_presence','sess_presence','op','[]','/w','deleting')",
            [],
        )
        .unwrap();
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new(crate::LOCAL_ENVIRONMENT),
        root: EnvPath::new("/w"),
    };
    let listed: Vec<String> = store
        .store
        .list(SessionFilter {
            workspace,
            limit: 10,
        })
        .await
        .unwrap()
        .into_iter()
        .map(|summary| summary.id.as_str().to_owned())
        .collect();
    assert_eq!(listed, ["sess_kept"]);
    let queried: Vec<String> = store
        .store
        .query_sessions(SessionQuery {
            environment: EnvironmentId::new(crate::LOCAL_ENVIRONMENT),
            root: None,
            order: SessionOrder::default(),
            limit: 10,
        })
        .await
        .unwrap()
        .sessions
        .into_iter()
        .map(|record| record.id.as_str().to_owned())
        .collect();
    assert_eq!(queried, ["sess_kept"]);
}

#[tokio::test]
async fn shutdown_releases_every_held_row() {
    let store = migrated().await;
    store
        .store
        .create(meta("sess_other", "/w", "t"))
        .await
        .unwrap();
    let first = store.store.register_runtime(&sid()).await.unwrap();
    let second = store
        .store
        .register_runtime(&SessionId::new("sess_other"))
        .await
        .unwrap();
    assert_eq!(presence(&store).len(), 2);
    store.store.release_presence_blocking();
    assert!(presence(&store).is_empty());
    // Guards dropped after the shutdown release find nothing to delete.
    drop((first, second));
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(presence(&store).is_empty());
}

#[tokio::test]
async fn a_database_without_0025_has_no_protocol() {
    let store = TestStore::new();
    store
        .store
        .create(meta("sess_presence", "/w", "t"))
        .await
        .unwrap();
    let guard = store.store.register_runtime(&sid()).await.unwrap();
    assert!(!guard.holds());
    assert_eq!(store.store.assert_not_deleting(&[sid()]).await, Ok(()));
    drop(guard);
    store.store.release_presence_blocking();
    store
        .store
        .commit(&sid(), batch(None, vec![user("u1", "hello")]))
        .await
        .unwrap();
}

/// Shortens the store connection's busy timeout so a locked database fails fast.
fn fail_fast_when_locked(store: &TestStore) {
    store
        .store
        .connection
        .lock()
        .unwrap()
        .as_ref()
        .expect("the store connection is open")
        .busy_timeout(Duration::from_millis(20))
        .unwrap();
}

/// A release that hits a locked database (Node holding `begin immediate` for its inspection) keeps the row owned:
/// Node `close()` deletes by owner, so a failed `unregisterSessionRuntime` is still cleaned up. The next presence
/// operation retries it, and the shutdown sweep releases whatever is left.
#[tokio::test]
async fn a_release_that_hits_a_locked_database_is_retried() {
    let store = migrated().await;
    store
        .store
        .create(meta("sess_other", "/w", "t"))
        .await
        .unwrap();
    let guard = store.store.register_runtime(&sid()).await.unwrap();
    let owner = presence(&store)[0].1.clone();
    fail_fast_when_locked(&store);
    let node = store.connection();
    node.execute_batch("begin immediate").unwrap();
    drop(guard);
    // The release ran and failed: its owner is marked released but still held.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !store.store.presence.lock().unwrap()[&owner].released {
        assert!(Instant::now() < deadline, "the release never ran");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(presence(&store).len(), 1, "the locked delete left the row");
    node.execute_batch("commit").unwrap();
    // The next register retries the failed release first.
    let other = store
        .store
        .register_runtime(&SessionId::new("sess_other"))
        .await
        .unwrap();
    let rows = presence(&store);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].0, "sess_other");
    drop(other);
    eventually(&store, <[_]>::is_empty).await;
}

/// The shutdown sweep keeps going past a failed delete and keeps every row it could not delete.
#[tokio::test]
async fn a_shutdown_sweep_on_a_locked_database_keeps_the_rows_for_the_next_sweep() {
    let store = migrated().await;
    store
        .store
        .create(meta("sess_other", "/w", "t"))
        .await
        .unwrap();
    let first = store.store.register_runtime(&sid()).await.unwrap();
    let second = store
        .store
        .register_runtime(&SessionId::new("sess_other"))
        .await
        .unwrap();
    fail_fast_when_locked(&store);
    let node = store.connection();
    node.execute_batch("begin immediate").unwrap();
    store.store.release_presence_blocking();
    assert_eq!(presence(&store).len(), 2);
    node.execute_batch("commit").unwrap();
    store.store.release_presence_blocking();
    assert!(presence(&store).is_empty());
    drop((first, second));
}

/// Node `SqliteSessionStore.getSession` returns null for a session with a purge row (`sqlite-session-store.ts`);
/// the store-level `load` is its counterpart.
#[tokio::test]
async fn a_cold_load_of_a_session_being_purged_is_not_found() {
    let store = migrated().await;
    store
        .connection()
        .execute(
            "insert into session_purge(session_id,root_id,operation_id,retained_artifacts,workspace_path,state) values('sess_presence','sess_presence','op','[]','/w','deleting')",
            [],
        )
        .unwrap();
    assert_eq!(
        store.store.load(&sid()).await.unwrap_err(),
        StoreError::NotFound { session: sid() }
    );
}
