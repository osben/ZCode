//! Fork: the session-data protocol methods against the real session store and the real files (not the doubles of the
//! other test modules). The database is the shared golden fixture (`node-store/src/fixtures/session_deletion_golden.sql`,
//! the rows Node's repository reads in its golden test), with the same per-session files on disk. The expected values
//! are the ones Node produces for this state (`node-store` golden test and the Node cross-check in the PR body).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{CreateSession, KernelError, SessionHandle};
use rust_cli_kernel_api::store::{SessionFilter, SessionSummary, StoreQueries};
use rust_cli_kernel_api::testing::{FixedClock, selection};
use rust_cli_node_store::{NodeIds, NodeStore};
use rust_cli_paths::{StoragePaths, StorageSettings};
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::{Value, json};

use super::session_data::{measure, purge};
use super::session_deletion::{execute, preview};
use crate::context::Context;
use crate::server::{Defaults, Server};

const UPSTREAM_0025: &str =
    include_str!("../../../node-store/src/fixtures/0025_session_permanent_deletion.sql");
const GOLDEN: &str = include_str!("../../../node-store/src/fixtures/session_deletion_golden.sql");
/// Node's preview revision for this state (the snapshot revision hashed with the file list and the blocker, as
/// `previewSessionDeletionWith` does): Node's inspect and file listing over the same fixture and files, 2026-11-17.
const GOLDEN_REVISION: &str = "49f0e7bb6a7fb14c2599747fe36bfc0099bd9a641791b2c1c492da3f2d262848";
const WORKSPACE: &str = "/work/example";

/// A kernel whose queries are the real store.
struct StoreKernel {
    store: Arc<NodeStore>,
}

#[async_trait]
impl rust_cli_kernel_api::session_api::Kernel for StoreKernel {
    fn queries(&self) -> Arc<dyn StoreQueries> {
        self.store.clone()
    }

    async fn create_session(
        &self,
        _request: CreateSession,
    ) -> Result<rust_cli_kernel_api::ids::SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "create".to_owned(),
        })
    }

    async fn open_session(
        &self,
        _session: &rust_cli_kernel_api::ids::SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Err(KernelError::Unsupported {
            what: "open".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }
}

/// A store over `<storage>/cli/db/db.sqlite`, migrated, with the 0025 tables and the golden rows. Returns the store, its
/// server and the scope that keeps the server's tasks alive.
async fn fixture(storage: &Path) -> (TaskScope, Arc<Server>, Arc<NodeStore>) {
    let db = storage.join("cli/db/db.sqlite");
    let paths = StoragePaths::resolve(
        &StorageSettings {
            session_db_path: db.to_str(),
            storage_dir: storage.to_str(),
        },
        storage,
        storage,
    );
    let store = Arc::new(NodeStore::new(
        paths,
        Arc::new(NodeIds::new(Arc::new(FixedClock(5)))),
    ));
    // Listing opens and migrates the database; the 0025 tables and the golden rows are then added through a second
    // connection, as a Node build that migrated the shared database would leave them.
    store
        .list_owned_session_trees(&[rust_cli_kernel_api::ids::SessionId::new("root")])
        .await
        .unwrap();
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection.execute_batch(UPSTREAM_0025).unwrap();
    connection.execute_batch(GOLDEN).unwrap();
    drop(connection);

    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    context.set_storage_root(storage.to_path_buf());
    let kernel = Arc::new(StoreKernel {
        store: store.clone(),
    });
    let server = Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    (scope, server, store)
}

/// The files of the fixture: 4 bytes each, the artifact `art1` of `child` is the one `other` and `fork` name.
async fn lay_out(storage: &Path) {
    let cli = storage.join("cli");
    for path in [
        "artifacts/root/own.txt",
        "artifacts/child/art1-ref.bin",
        "artifacts/child/other.txt",
        "exec/child/log.txt",
    ] {
        rust_cli_fs::append(&cli.join(path), b"0123").await.unwrap();
    }
}

async fn exists(path: &Path) -> bool {
    rust_cli_fs::link_stat(path).await.unwrap().is_some()
}

fn workspace() -> Value {
    json!({"workspacePath": WORKSPACE})
}

/// The protocol round: measure, then purge of the referenced tree (kept), then preview and execute of the tree.
#[tokio::test]
async fn the_session_data_methods_run_end_to_end_on_the_real_store() {
    let storage = tempfile::tempdir().unwrap();
    lay_out(storage.path()).await;
    let (_scope, server, _store) = fixture(storage.path()).await;

    // Measure: four files of 4 bytes across root and child.
    let sizes = measure(
        &server,
        &json!({"sessionIds": ["root"], "directories": [{"workspacePath": WORKSPACE}]}),
    )
    .await
    .unwrap();
    assert_eq!(
        sizes["sessions"],
        json!([{"sessionId": "root", "bytes": 16}])
    );

    // Purge: `child` is named by `other` and `fork`, so the tree is kept as referenced, and nothing is removed.
    let kept = purge(
        &server,
        &json!({"sessionIds": ["root"], "directories": [{"workspacePath": WORKSPACE}]}),
    )
    .await
    .unwrap();
    assert_eq!(
        kept["kept"],
        json!([{"sessionId": "root", "reason": "referenced"}])
    );
    assert!(exists(&storage.path().join("cli/artifacts/root/own.txt")).await);

    // Preview: the golden revision (Node's), the fork, and the retained artifact with its referrers.
    let plan = preview(
        &server,
        &json!({"sessionId": "root", "workspace": workspace()}),
    )
    .await
    .unwrap();
    assert_eq!(plan["revision"], GOLDEN_REVISION);
    assert_eq!(plan["sessionIds"], json!(["root", "child"]));
    assert_eq!(
        plan["forks"],
        json!([{"sessionId": "fork", "title": "フォーク fork"}])
    );
    assert_eq!(plan["deletedFiles"], 3);
    assert!(plan.get("blockedReason").is_none());

    // Execute: the tree is gone except the retained artifact; the fork survives.
    let done = execute(
        &server,
        &json!({
            "sessionId": "root",
            "workspace": workspace(),
            "revision": GOLDEN_REVISION,
            "operationId": "integration-op",
        }),
    )
    .await
    .unwrap();
    assert_eq!(done["status"], "deleted");
    // Node reports the count of retained references (`preview.retainedArtifacts.length`), not of files: three here.
    assert_eq!(done["retainedArtifacts"], 3);
    let cli = storage.path().join("cli");
    assert!(!exists(&cli.join("artifacts/root/own.txt")).await);
    assert!(!exists(&cli.join("exec/child/log.txt")).await);
    assert!(exists(&cli.join("artifacts/child/art1-ref.bin")).await);
    let rows = rusqlite::Connection::open(storage.path().join("cli/db/db.sqlite"))
        .unwrap()
        .query_row(
            "select count(*) from session where id in ('root','child')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    assert_eq!(rows, 0);
    let fork_rows = rusqlite::Connection::open(storage.path().join("cli/db/db.sqlite"))
        .unwrap()
        .query_row(
            "select count(*) from session where id = 'fork'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    assert_eq!(fork_rows, 1);
}
