//! Fork: `v4/storage/sessionData/measure` and `purge` (Node `zcode-protocol/session-data/index.ts`): the sizes of a tree
//! and its project memory, and the purge's keep rules (a referenced tree stays) and its rows and files.

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::metering::{ActivityQuery, ActivityStats, RequestStats, SessionMetering};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{CreateSession, KernelError, SessionHandle};
use rust_cli_kernel_api::store::{
    FrontendRecord, SessionFilter, SessionSummary, StoreError, StoreQueries,
};
use rust_cli_kernel_api::testing::{FixedClock, MemoryStore, selection};
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::{Value, json};

use super::{measure, purge};
use crate::context::Context;
use crate::server::{Defaults, Server};

const ROOT: &str = "sess_root";
const CHILD: &str = "sess_child";
const WORKSPACE: &str = "/work/Example Project";

/// The store double: a tree `ROOT` → `CHILD`, an optional referrer of `CHILD` outside the tree, and a record of the
/// purged roots.
struct DataStore {
    inner: MemoryStore,
    referrer: Option<String>,
    unsupported: bool,
    purged: StdMutex<Vec<Vec<String>>>,
}

#[async_trait]
impl StoreQueries for DataStore {
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

    async fn list_owned_session_trees(
        &self,
        roots: &[SessionId],
    ) -> Result<Vec<(SessionId, Vec<SessionId>)>, StoreError> {
        if self.unsupported {
            return Err(StoreError::Unsupported {
                what: "owned session trees".to_owned(),
            });
        }
        Ok(roots
            .iter()
            .map(|root| {
                let ids = if root.as_str() == ROOT {
                    vec![SessionId::new(ROOT), SessionId::new(CHILD)]
                } else {
                    Vec::new()
                };
                (root.clone(), ids)
            })
            .collect())
    }

    async fn list_artifact_referrers(
        &self,
        sessions: &[SessionId],
    ) -> Result<Vec<(SessionId, Vec<SessionId>)>, StoreError> {
        Ok(match &self.referrer {
            Some(other) if sessions.iter().any(|id| id.as_str() == CHILD) => {
                vec![(SessionId::new(CHILD), vec![SessionId::new(other)])]
            }
            _ => Vec::new(),
        })
    }

    async fn purge_session_rows(&self, sessions: &[SessionId]) -> Result<(), StoreError> {
        self.purged
            .lock()
            .unwrap()
            .push(sessions.iter().map(|id| id.as_str().to_owned()).collect());
        Ok(())
    }
}

/// The kernel double: no open sessions and no running subagents.
struct DataKernel {
    store: Arc<DataStore>,
}

#[async_trait]
impl rust_cli_kernel_api::session_api::Kernel for DataKernel {
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

fn server(store: DataStore, storage: &Path) -> (TaskScope, Arc<Server>, Arc<DataStore>) {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    context.set_storage_root(storage.to_path_buf());
    let store = Arc::new(store);
    let kernel = Arc::new(DataKernel {
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

fn store(referrer: Option<&str>) -> DataStore {
    DataStore {
        inner: MemoryStore::default(),
        referrer: referrer.map(str::to_owned),
        unsupported: false,
        purged: StdMutex::new(Vec::new()),
    }
}

/// `<cli>/artifacts/root/own.txt` (4 bytes), `<cli>/exec/child/log.txt` (4 bytes), and the project memory of the
/// workspace (3 bytes), in the folder Node's `resolveProjectMemoryRoot` names.
async fn lay_out(storage: &Path) -> std::path::PathBuf {
    let cli = storage.join("cli");
    rust_cli_fs::append(&cli.join("artifacts/sess_root/own.txt"), b"0123")
        .await
        .unwrap();
    rust_cli_fs::append(&cli.join("exec/sess_child/log.txt"), b"0123")
        .await
        .unwrap();
    let folder = crate::fork::session_data_size::project_memory_folder(&cli, WORKSPACE, None);
    rust_cli_fs::append(&folder.join("memory/notes.md"), b"abc")
        .await
        .unwrap();
    folder
}

fn params(extra: Value) -> Value {
    let mut value = json!({
        "sessionIds": [ROOT],
        "directories": [{"workspacePath": WORKSPACE}],
    });
    value
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    value
}

async fn exists(path: &Path) -> bool {
    rust_cli_fs::link_stat(path).await.unwrap().is_some()
}

#[tokio::test]
async fn measure_sums_the_tree_and_the_project_memory() {
    let storage = tempfile::tempdir().unwrap();
    lay_out(storage.path()).await;
    let (_scope, server, _store) = server(store(None), storage.path());
    let result = measure(&server, &params(json!({}))).await.unwrap();
    assert_eq!(result["sessions"], json!([{"sessionId": ROOT, "bytes": 8}]));
    assert_eq!(
        result["memory"],
        json!([{"workspacePath": WORKSPACE, "bytes": 3}])
    );
}

#[tokio::test]
async fn purge_removes_an_unreferenced_tree_its_rows_and_its_memory() {
    let storage = tempfile::tempdir().unwrap();
    let folder = lay_out(storage.path()).await;
    let (_scope, server, store) = server(store(None), storage.path());
    let result = purge(&server, &params(json!({}))).await.unwrap();
    assert_eq!(result["deleted"], json!([{"sessionId": ROOT, "bytes": 8}]));
    assert_eq!(result["kept"], json!([]));
    assert_eq!(result["failed"], json!([]));
    assert_eq!(
        result["memory"],
        json!([{"workspacePath": WORKSPACE, "bytes": 3}])
    );
    assert_eq!(*store.purged.lock().unwrap(), vec![vec![ROOT.to_owned()]]);
    assert!(!exists(&storage.path().join("cli/artifacts/sess_root/own.txt")).await);
    assert!(!exists(&folder).await);
}

#[tokio::test]
async fn purge_keeps_a_tree_that_another_session_still_references() {
    let storage = tempfile::tempdir().unwrap();
    lay_out(storage.path()).await;
    let (_scope, server, store) = server(store(Some("sess_other")), storage.path());
    let result = purge(&server, &params(json!({}))).await.unwrap();
    assert_eq!(
        result["kept"],
        json!([{"sessionId": ROOT, "reason": "referenced"}])
    );
    assert_eq!(result["deleted"], json!([]));
    assert!(store.purged.lock().unwrap().is_empty());
    assert!(exists(&storage.path().join("cli/artifacts/sess_root/own.txt")).await);
}

#[tokio::test]
async fn an_unknown_key_is_invalid_params() {
    let storage = tempfile::tempdir().unwrap();
    let (_scope, server, _store) = server(store(None), storage.path());
    let error = measure(&server, &params(json!({"bogus": 1})))
        .await
        .unwrap_err();
    assert_eq!(
        error.code,
        rust_cli_protocol_core::rpc::RpcError::invalid_params("").code
    );
}

#[tokio::test]
async fn a_store_without_the_protocol_answers_method_not_found() {
    let storage = tempfile::tempdir().unwrap();
    let mut unsupported = store(None);
    unsupported.unsupported = true;
    let (_scope, server, _store) = server(unsupported, storage.path());
    let error = purge(&server, &params(json!({}))).await.unwrap_err();
    assert_eq!(
        error.code,
        rust_cli_protocol_core::rpc::RpcError::method_not_found("").code
    );
}
