//! Fork: `v4/storage/sessionData/deletionPreview` and `deletionExecute` (Node `session-data/permanent-deletion.ts`):
//! the preview's blockers, retained artifacts and revision, and the execute's barrier, file removal and rows.

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::metering::{ActivityQuery, ActivityStats, RequestStats, SessionMetering};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{CreateSession, KernelError, SessionHandle};
use rust_cli_kernel_api::session_deletion::{
    DeletionBegin, DeletionFork, DeletionReference, DeletionReferrer, SessionDeletionSnapshot,
};
use rust_cli_kernel_api::store::{
    FrontendRecord, SessionFilter, SessionSummary, StoreError, StoreQueries,
};
use rust_cli_kernel_api::testing::{FixedClock, MemoryStore, selection};
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::{Value, json};

use super::{execute, preview};
use crate::context::Context;
use crate::server::{Defaults, Server};

const ROOT: &str = "sess_root";
const CHILD: &str = "sess_child";
const OTHER: &str = "sess_other";
const WORKSPACE: &str = "/work/example";

/// One recorded `begin`: the root, the revision it presented, and the retained `(session, artifact)` pairs.
type Begun = Vec<(String, String, Vec<(String, String)>)>;

/// The store double: a canned snapshot, `Unsupported` when asked, and a record of the barrier calls.
struct DeletionStore {
    inner: MemoryStore,
    snapshot: SessionDeletionSnapshot,
    unsupported: bool,
    begun: StdMutex<Begun>,
    completed: StdMutex<Vec<String>>,
}

#[async_trait]
impl StoreQueries for DeletionStore {
    async fn metering(&self, session: &SessionId) -> Result<SessionMetering, StoreError> {
        self.inner.metering(session).await
    }

    async fn request_stats(&self, session: &SessionId) -> Result<RequestStats, StoreError> {
        self.inner.request_stats(session).await
    }

    async fn activity(&self, query: ActivityQuery) -> Result<ActivityStats, StoreError> {
        self.inner.activity(query).await
    }

    async fn put_record(
        &self,
        session: &SessionId,
        record: &FrontendRecord,
    ) -> Result<(), StoreError> {
        self.inner.put_record(session, record).await
    }

    async fn records(
        &self,
        session: &SessionId,
        kind: &str,
    ) -> Result<Vec<FrontendRecord>, StoreError> {
        self.inner.records(session, kind).await
    }

    async fn inspect_session_deletion(
        &self,
        _root: &SessionId,
    ) -> Result<SessionDeletionSnapshot, StoreError> {
        if self.unsupported {
            return Err(StoreError::Unsupported {
                what: "session deletion inspect".to_owned(),
            });
        }
        Ok(self.snapshot.clone())
    }

    async fn begin_session_deletion(
        &self,
        root: &SessionId,
        revision: &str,
        _operation_id: &str,
        retained: &[(SessionId, String)],
    ) -> Result<DeletionBegin, StoreError> {
        self.begun.lock().unwrap().push((
            root.as_str().to_owned(),
            revision.to_owned(),
            retained
                .iter()
                .map(|(session, artifact)| (session.as_str().to_owned(), artifact.clone()))
                .collect(),
        ));
        Ok(DeletionBegin::Admitted)
    }

    async fn complete_session_deletion(&self, root: &SessionId) -> Result<(), StoreError> {
        self.completed
            .lock()
            .unwrap()
            .push(root.as_str().to_owned());
        Ok(())
    }
}

/// The kernel double: it has no open sessions and no running subagents.
struct DeletionKernel {
    store: Arc<DeletionStore>,
}

#[async_trait]
impl rust_cli_kernel_api::session_api::Kernel for DeletionKernel {
    fn queries(&self) -> Arc<dyn StoreQueries> {
        self.store.clone()
    }

    async fn create_session(&self, _request: CreateSession) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "create".to_owned(),
        })
    }

    async fn open_session(
        &self,
        _session: &SessionId,
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

/// The snapshot of a tree `ROOT` → `CHILD`, a fork `OTHER` outside it, and one artifact of `CHILD` that `OTHER`
/// still names.
fn snapshot() -> SessionDeletionSnapshot {
    SessionDeletionSnapshot {
        workspace_path: Some(WORKSPACE.to_owned()),
        workspace_identity: None,
        revision: "rev-1".to_owned(),
        session_ids: vec![ROOT.to_owned(), CHILD.to_owned()],
        forks: vec![DeletionFork {
            session_id: OTHER.to_owned(),
            title: "fork".to_owned(),
        }],
        references: vec![DeletionReference {
            session_id: CHILD.to_owned(),
            artifact_id: "art1".to_owned(),
            referrers: vec![DeletionReferrer {
                session_id: OTHER.to_owned(),
                title: "fork".to_owned(),
            }],
        }],
        foreign_runtime: false,
        local_runtime_ids: Vec::new(),
        pending_work: false,
        deleting: false,
        completed: false,
    }
}

/// The scope is returned too: it must outlive the test. The storage root is a temporary directory with `cli/`.
fn server(store: DeletionStore, storage: &Path) -> (TaskScope, Arc<Server>, Arc<DeletionStore>) {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    context.set_storage_root(storage.to_path_buf());
    let store = Arc::new(store);
    let kernel = Arc::new(DeletionKernel {
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

fn store(snapshot: SessionDeletionSnapshot) -> DeletionStore {
    DeletionStore {
        inner: MemoryStore::default(),
        snapshot,
        unsupported: false,
        begun: StdMutex::new(Vec::new()),
        completed: StdMutex::new(Vec::new()),
    }
}

/// `<cli>/artifacts/<root|child>/…`, `<cli>/exec/<child>/…`: the per-session directories and the retained artifact.
async fn lay_out_files(storage: &Path) {
    let cli = storage.join("cli");
    for (dir, file) in [
        ("artifacts/sess_root", "own.txt"),
        ("artifacts/sess_child", "art1-ref.bin"),
        ("artifacts/sess_child", "other.txt"),
        ("exec/sess_child", "log.txt"),
    ] {
        rust_cli_fs::append(&cli.join(dir).join(file), b"0123")
            .await
            .unwrap();
    }
}

async fn exists(path: &Path) -> bool {
    rust_cli_fs::link_stat(path).await.unwrap().is_some()
}

fn workspace() -> Value {
    json!({"workspacePath": WORKSPACE})
}

fn preview_params() -> Value {
    json!({"sessionId": ROOT, "workspace": workspace()})
}

#[tokio::test]
async fn preview_lists_the_tree_retained_artifact_and_revision() {
    let storage = tempfile::tempdir().unwrap();
    lay_out_files(storage.path()).await;
    let (_scope, server, _store) = server(store(snapshot()), storage.path());
    let result = preview(&server, &preview_params()).await.unwrap();
    assert_eq!(result["sessionId"], ROOT);
    assert_eq!(result["sessionIds"], json!([ROOT, CHILD]));
    assert_eq!(
        result["forks"],
        json!([{"sessionId": OTHER, "title": "fork"}])
    );
    assert_eq!(result["retainedArtifacts"][0]["artifactId"], "art1");
    assert_eq!(result["retainedArtifacts"][0]["fileName"], "art1-ref.bin");
    assert_eq!(result["deletedFiles"], 3);
    assert_eq!(result["incomplete"], false);
    assert_eq!(result["completed"], false);
    assert!(result.get("blockedReason").is_none());
    assert_eq!(result["revision"].as_str().unwrap().len(), 64);
}

#[tokio::test]
async fn execute_removes_files_and_rows_but_keeps_the_retained_artifact() {
    let storage = tempfile::tempdir().unwrap();
    lay_out_files(storage.path()).await;
    let (_scope, server, store) = server(store(snapshot()), storage.path());
    let revision = preview(&server, &preview_params()).await.unwrap()["revision"]
        .as_str()
        .unwrap()
        .to_owned();
    let result = execute(
        &server,
        &json!({"sessionId": ROOT, "workspace": workspace(), "revision": revision, "operationId": "op-1"}),
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "deleted");
    assert_eq!(result["retainedArtifacts"], 1);
    assert_eq!(
        *store.begun.lock().unwrap(),
        vec![(
            ROOT.to_owned(),
            "rev-1".to_owned(),
            vec![(CHILD.to_owned(), "art1".to_owned())]
        )]
    );
    assert_eq!(*store.completed.lock().unwrap(), vec![ROOT.to_owned()]);
    let cli = storage.path().join("cli");
    assert!(!exists(&cli.join("artifacts/sess_root/own.txt")).await);
    assert!(!exists(&cli.join("artifacts/sess_child/other.txt")).await);
    assert!(!exists(&cli.join("exec/sess_child")).await);
    assert!(exists(&cli.join("artifacts/sess_child/art1-ref.bin")).await);
}

#[tokio::test]
async fn execute_with_a_stale_revision_is_blocked_and_changes_nothing() {
    let storage = tempfile::tempdir().unwrap();
    lay_out_files(storage.path()).await;
    let (_scope, server, store) = server(store(snapshot()), storage.path());
    let result = execute(
        &server,
        &json!({"sessionId": ROOT, "workspace": workspace(), "revision": "old", "operationId": "op-1"}),
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "blocked");
    assert_eq!(result["reason"], "changed");
    assert!(store.begun.lock().unwrap().is_empty());
    assert!(exists(&storage.path().join("cli/exec/sess_child")).await);
}

#[tokio::test]
async fn a_foreign_runtime_blocks_the_preview_as_in_use() {
    let storage = tempfile::tempdir().unwrap();
    lay_out_files(storage.path()).await;
    let mut snap = snapshot();
    snap.foreign_runtime = true;
    let (_scope, server, _store) = server(store(snap), storage.path());
    let result = preview(&server, &preview_params()).await.unwrap();
    assert_eq!(result["blockedReason"], "in-use");
}

#[tokio::test]
async fn a_completed_tree_executes_as_deleted_without_work() {
    let storage = tempfile::tempdir().unwrap();
    let mut snap = snapshot();
    snap.completed = true;
    let (_scope, server, store) = server(store(snap), storage.path());
    let result = execute(
        &server,
        &json!({"sessionId": ROOT, "workspace": workspace(), "revision": "x", "operationId": "op"}),
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "deleted");
    assert!(store.begun.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_workspace_mismatch_is_refused_before_anything_is_read() {
    let storage = tempfile::tempdir().unwrap();
    let (_scope, server, _store) = server(store(snapshot()), storage.path());
    let error = preview(
        &server,
        &json!({"sessionId": ROOT, "workspace": {"workspacePath": "/elsewhere"}}),
    )
    .await
    .unwrap_err();
    assert!(
        error.message.contains("session-data.identity-mismatch"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn an_unsafe_session_id_and_extra_keys_are_invalid_params() {
    let storage = tempfile::tempdir().unwrap();
    let (_scope, server, _store) = server(store(snapshot()), storage.path());
    let bad_id = preview(
        &server,
        &json!({"sessionId": "../x", "workspace": workspace()}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        bad_id.code,
        rust_cli_protocol_core::rpc::RpcError::invalid_params("").code
    );
    let extra = preview(
        &server,
        &json!({"sessionId": ROOT, "workspace": workspace(), "revision": "x"}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        extra.code,
        rust_cli_protocol_core::rpc::RpcError::invalid_params("").code
    );
}

#[tokio::test]
async fn a_store_without_the_protocol_answers_method_not_found() {
    let storage = tempfile::tempdir().unwrap();
    let mut unsupported = store(snapshot());
    unsupported.unsupported = true;
    let (_scope, server, _store) = server(unsupported, storage.path());
    let error = preview(&server, &preview_params()).await.unwrap_err();
    assert_eq!(
        error.code,
        rust_cli_protocol_core::rpc::RpcError::method_not_found("").code
    );
}

/// Node reports the errno name of a removal failure; a failure without an errno falls back to the caller's reason.
#[test]
fn file_failures_report_node_error_codes() {
    let errno = super::session_data_files::FileError::Io(std::io::Error::from_raw_os_error(13));
    assert_eq!(errno.code_or("unavailable"), "EACCES");
    let without = super::session_data_files::FileError::Io(std::io::Error::other("boom"));
    assert_eq!(without.code_or("unavailable"), "unavailable");
    assert_eq!(without.code_or("unknown"), "unknown");
}
