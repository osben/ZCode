//! `session/eraseTree` and `session/treeCounts` with a running subagent in the tree (Node
//! `findRunningSessionIds` plus `getDetachedChildSessionFacts().running`): the erase is refused
//! and changes nothing, and the tree counts it as running.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::metering::{ActivityQuery, ActivityStats, RequestStats, SessionMetering};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{CreateSession, KernelError, SessionHandle};
use rust_cli_kernel_api::store::{
    ErasedSessionTree, FrontendRecord, SessionFilter, SessionSummary, SessionTreeCounts,
    StoreError, StoreQueries,
};
use rust_cli_kernel_api::testing::{FixedClock, MemoryStore, selection};
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::json;

use super::*;
use crate::context::Context;
use crate::server::Defaults;

const ROOT: &str = "sess_root";
const CHILD: &str = "sess_subagent_agent_1";

/// A store whose tree is `ROOT` and its subagent `CHILD`; it records erases.
#[derive(Default)]
struct TreeStore {
    inner: MemoryStore,
    erased: StdMutex<Vec<Vec<String>>>,
}

#[async_trait]
impl StoreQueries for TreeStore {
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

    async fn session_tree_counts(
        &self,
        _root_ids: Vec<String>,
    ) -> Result<SessionTreeCounts, StoreError> {
        Ok(SessionTreeCounts {
            total: 2,
            side_chats: 0,
            subagents: 1,
            workflow_sessions: 0,
            workflow_runs: 0,
        })
    }

    async fn session_tree_ids(&self, _root_ids: Vec<String>) -> Result<Vec<String>, StoreError> {
        Ok(vec![ROOT.to_owned(), CHILD.to_owned()])
    }

    async fn session_tree_ids_with_surviving_children(
        &self,
        _root_ids: Vec<String>,
    ) -> Result<Vec<String>, StoreError> {
        Ok(Vec::new())
    }

    async fn erase_session_tree(
        &self,
        root_ids: Vec<String>,
    ) -> Result<ErasedSessionTree, StoreError> {
        self.erased.lock().unwrap().push(root_ids);
        Ok(ErasedSessionTree {
            erased_ids: vec![ROOT.to_owned(), CHILD.to_owned()],
            erased_roots: Vec::new(),
        })
    }
}

/// The kernel double: the agents report `running` as running subagent sessions; it records
/// `sessions_erased`.
struct TreeKernel {
    store: Arc<TreeStore>,
    running: Vec<SessionId>,
    erased: StdMutex<Vec<Vec<SessionId>>>,
}

#[async_trait]
impl rust_cli_kernel_api::session_api::Kernel for TreeKernel {
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

    async fn sessions_erased(&self, sessions: Vec<SessionId>) {
        self.erased.lock().unwrap().push(sessions);
    }

    fn running_agent_sessions(&self, sessions: &[SessionId]) -> Vec<SessionId> {
        sessions
            .iter()
            .filter(|session| self.running.contains(session))
            .cloned()
            .collect()
    }
}

/// The scope is returned too: it must outlive the test (the server's tasks run in it).
fn server(running: Vec<SessionId>) -> (TaskScope, Arc<Server>, Arc<TreeKernel>) {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let kernel = Arc::new(TreeKernel {
        store: Arc::new(TreeStore::default()),
        running,
        erased: StdMutex::new(Vec::new()),
    });
    let server = Arc::new(Server::new(
        context,
        kernel.clone(),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    (scope, server, kernel)
}

/// A running subagent in the tree blocks the erase: nothing is erased, the agents are not told,
/// and the subagent's session is reported as the blocking one.
#[tokio::test]
async fn a_running_subagent_blocks_the_erase_of_its_tree() {
    let (_scope, server, kernel) = server(vec![SessionId::new(CHILD)]);
    let params = json!({"sessionIds": [ROOT]});
    let counts = tree_counts(&server, &params).await.unwrap();
    assert_eq!(counts["running"], 1);
    let result = erase_tree(&server, &params).await.unwrap();
    assert_eq!(
        result,
        json!({
            "erasedSessionIds": [],
            "blockedRunningSessionIds": [CHILD],
            "fileFailureCount": 0,
            "filesRetainedCount": 0,
        })
    );
    assert!(kernel.store.erased.lock().unwrap().is_empty());
    assert!(kernel.erased.lock().unwrap().is_empty());
}

/// Without a running subagent (a parked one is not running) the same tree is erased and the
/// agents are told.
#[tokio::test]
async fn an_idle_tree_is_erased() {
    let (_scope, server, kernel) = server(Vec::new());
    let params = json!({"sessionIds": [ROOT]});
    assert_eq!(tree_counts(&server, &params).await.unwrap()["running"], 0);
    let result = erase_tree(&server, &params).await.unwrap();
    assert_eq!(result["erasedSessionIds"], json!([ROOT, CHILD]));
    assert_eq!(result["blockedRunningSessionIds"], json!([]));
    assert_eq!(kernel.store.erased.lock().unwrap().len(), 1);
    assert_eq!(
        *kernel.erased.lock().unwrap(),
        vec![vec![SessionId::new(ROOT), SessionId::new(CHILD)]]
    );
}
