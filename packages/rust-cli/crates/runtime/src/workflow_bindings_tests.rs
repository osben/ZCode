//! Tests of the production actor bindings (9.35). The port reads a real `NodeStore` over a temp database; the launch seam
//! is checked against the recorded fields Node writes on `run-launched`.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::ids::{OwnerEpoch, SessionId, TraceId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::store::{
    CommitReceipt, Fact, FactBatch, ForkReceipt, LoadedSession, SessionFilter, SessionFork,
    SessionKind, SessionMeta, SessionPage, SessionQuery, SessionStore, SessionSummary, StoreError,
};
use rust_cli_node_store::{NodeIds, NodeStore};
use rust_cli_paths::{StoragePaths, StorageSettings};
use rust_cli_workflow::engine::EngineConfig;

use super::SessionBindings;
use crate::table::OpenSessions;
use crate::workflow_owner::{ActorBindingsPort, ParentBindings, record_parent_mode};

/// A store over a temp home, and the session `id` created with `facts` committed to it.
async fn store_with(dir: &std::path::Path, id: &str, facts: Vec<Fact>) -> Arc<NodeStore> {
    let paths = StoragePaths::resolve(&StorageSettings::default(), dir, dir);
    let clock = Arc::new(rust_cli_base::clock::SystemClock::utc());
    let store = Arc::new(NodeStore::new(paths, Arc::new(NodeIds::new(clock))));
    let session = SessionId::new(id);
    store
        .create(SessionMeta {
            id: session.clone(),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: rust_cli_kernel_api::env::WorkspaceRef {
                environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
                root: EnvPath::new("/work"),
            },
            title: "parent".to_owned(),
            trace: TraceId::new(id),
            created_at_ms: 1,
            incognito: None,
        })
        .await
        .expect("the parent session");
    if !facts.is_empty() {
        store
            .commit(
                &session,
                FactBatch {
                    owner_epoch: OwnerEpoch::LOCAL,
                    command: None,
                    facts,
                    turn: None,
                },
            )
            .await
            .expect("the parent's facts");
    }
    store
}

/// The app's default mode (the kernel's `Defaults::mode`), used when a stored session has no mode.
const APP_DEFAULT: PermissionMode = PermissionMode::Default;

fn port_over(store: Arc<dyn SessionStore>, fallback: PermissionMode) -> Arc<SessionBindings> {
    Arc::new(SessionBindings::new(
        store,
        OpenSessions::default(),
        tokio::runtime::Handle::current(),
        fallback,
    ))
}

/// What a reshaped store does to `load`: every other call goes to the real store unchanged.
enum Reshape {
    /// A storage error, as a busy or broken database gives.
    Fail,
    /// The session with no stored mode and no plan flag (a session the app did not write a mode for).
    NoMode,
}

/// A store that reshapes `load` (the port reads a parent's selection, workspace and mode all through it).
struct Reshaped {
    inner: Arc<NodeStore>,
    reshape: Reshape,
}

#[async_trait]
impl SessionStore for Reshaped {
    async fn create(&self, meta: SessionMeta) -> Result<(), StoreError> {
        self.inner.create(meta).await
    }

    async fn commit(
        &self,
        session: &SessionId,
        batch: FactBatch,
    ) -> Result<CommitReceipt, StoreError> {
        self.inner.commit(session, batch).await
    }

    async fn load(&self, session: &SessionId) -> Result<LoadedSession, StoreError> {
        match self.reshape {
            Reshape::Fail => Err(StoreError::Storage {
                message: "the database is busy".to_owned(),
            }),
            Reshape::NoMode => {
                let mut loaded = self.inner.load(session).await?;
                loaded.mode = None;
                loaded.plan = false;
                Ok(loaded)
            }
        }
    }

    async fn list(&self, filter: SessionFilter) -> Result<Vec<SessionSummary>, StoreError> {
        self.inner.list(filter).await
    }

    async fn entries(
        &self,
        session: &SessionId,
        kind: &str,
    ) -> Result<Vec<(String, serde_json::Value)>, StoreError> {
        self.inner.entries(session, kind).await
    }

    async fn fork(&self, fork: SessionFork) -> Result<ForkReceipt, StoreError> {
        self.inner.fork(fork).await
    }

    async fn query_sessions(&self, query: SessionQuery) -> Result<SessionPage, StoreError> {
        self.inner.query_sessions(query).await
    }

    async fn rename(&self, session: &SessionId, title: &str) -> Result<(), StoreError> {
        self.inner.rename(session, title).await
    }

    async fn delete(&self, session: &SessionId) -> Result<(), StoreError> {
        self.inner.delete(session).await
    }
}

/// The port blocks on the store, so it is called off the runtime's threads, as the owner's factory is.
async fn read(
    port: Arc<SessionBindings>,
    parent: &'static str,
) -> (
    Result<Option<ParentBindings>, String>,
    Result<Option<PermissionMode>, String>,
) {
    tokio::task::spawn_blocking(move || {
        (
            port.parent_bindings(parent),
            port.parent_permission_mode(parent),
        )
    })
    .await
    .expect("the read finishes")
}

/// The parent's model selection, workspace and mode come from the session store.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_port_reads_the_parents_selection_workspace_and_mode_from_the_store() {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = store_with(
        dir.path(),
        "ses_p",
        vec![
            Fact::ModelSelected {
                selection: ModelSelection::new("acct-a", "ma"),
            },
            Fact::ModeChanged {
                mode: PermissionMode::AcceptEdits,
            },
        ],
    )
    .await;

    let (bindings, mode) = read(port_over(store, APP_DEFAULT), "ses_p").await;

    let bindings = bindings
        .expect("the read succeeds")
        .expect("the parent is known");
    assert_eq!(
        bindings.selection,
        Some(ModelSelection::new("acct-a", "ma")),
        "the parent's selection"
    );
    assert_eq!(bindings.workspace.root.as_str(), "/work", "the workspace");
    assert_eq!(
        mode.expect("the read succeeds"),
        Some(PermissionMode::AcceptEdits),
        "the parent's mode"
    );
}

/// A parent with no selection is known, with none: its actors are refused at their asks (9.33), not at the launch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_parent_without_a_selection_is_known_with_none() {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = store_with(dir.path(), "ses_p", vec![]).await;

    let (bindings, _) = read(port_over(store, APP_DEFAULT), "ses_p").await;

    let bindings = bindings
        .expect("the read succeeds")
        .expect("the parent is known");
    assert_eq!(bindings.selection, None, "no selection");
}

/// A session the store does not have is not known: the bindings are None, and the mode read refuses (it is never
/// recorded as absent, which the actors would read as YOLO).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unknown_parent_is_not_known_and_its_mode_read_refuses() {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = store_with(dir.path(), "ses_p", vec![]).await;

    let (bindings, mode) = read(port_over(store, APP_DEFAULT), "ses_missing").await;

    assert!(
        bindings.expect("the read succeeds").is_none(),
        "an unknown session has no bindings"
    );
    assert!(mode.is_err(), "the mode read refuses an unknown session");
}

/// Fail closed (9.35, review finding 1): a store that cannot read the parent refuses both reads and the launch's mode
/// record. Nothing is recorded as absent, so no run starts whose actors would read YOLO.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_that_cannot_read_refuses_the_reads_and_the_mode_record() {
    let dir = tempfile::tempdir().expect("temp dir");
    let inner = store_with(dir.path(), "ses_p", vec![]).await;
    let port = port_over(
        Arc::new(Reshaped {
            inner,
            reshape: Reshape::Fail,
        }),
        APP_DEFAULT,
    );

    let read_port = port.clone();
    let (bindings, mode) = tokio::task::spawn_blocking(move || {
        (
            read_port.parent_bindings("ses_p"),
            read_port.parent_permission_mode("ses_p"),
        )
    })
    .await
    .expect("the read finishes");
    assert!(bindings.is_err(), "the bindings read refuses");
    assert!(mode.is_err(), "the mode read refuses: {mode:?}");

    let recorded_port = port.clone();
    let (result, config) = tokio::task::spawn_blocking(move || {
        let mut config = EngineConfig {
            parent_session_id: Some("ses_p".to_owned()),
            ..Default::default()
        };
        let result = record_parent_mode(&mut config, recorded_port.as_ref());
        (result, config)
    })
    .await
    .expect("the record finishes");
    assert!(result.is_err(), "the launch is refused: {result:?}");
    assert!(
        config.launch.is_none(),
        "no mode is recorded, so no actor reads YOLO by default"
    );
}

/// Finding 2: a stored session with no mode reads the app's mode, as the session's own cold read does (the kernel's
/// `Defaults::mode`), not a hardcoded default.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_with_no_stored_mode_reads_the_apps_default_mode() {
    let dir = tempfile::tempdir().expect("temp dir");
    let inner = store_with(dir.path(), "ses_p", vec![]).await;
    let store = Arc::new(Reshaped {
        inner,
        reshape: Reshape::NoMode,
    });

    let (_, mode) = read(port_over(store, PermissionMode::AcceptEdits), "ses_p").await;

    assert_eq!(
        mode.expect("the read succeeds"),
        Some(PermissionMode::AcceptEdits),
        "the app's mode fills the missing one"
    );
}

/// Finding 3 (the no-channel path): a parent that is not open has no session-level asks, so its actors' asks have no
/// channel. The open path needs a running session and is not covered by this unit test.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_parent_that_is_not_open_has_no_interactions_channel() {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = store_with(dir.path(), "ses_p", vec![]).await;

    let (bindings, _) = read(port_over(store, APP_DEFAULT), "ses_p").await;

    let bindings = bindings
        .expect("the read succeeds")
        .expect("the parent is known");
    assert!(
        bindings.interactions.is_none(),
        "no open session, no session-level asks"
    );
}

/// A bare port for the launch seam: a fixed mode, and no bindings.
struct FixedMode(Option<PermissionMode>);

impl ActorBindingsPort for FixedMode {
    fn parent_bindings(&self, _parent: &str) -> Result<Option<ParentBindings>, String> {
        Ok(None)
    }

    fn parent_permission_mode(&self, _parent: &str) -> Result<Option<PermissionMode>, String> {
        Ok(self.0)
    }
}

fn recorded(mode: Option<PermissionMode>) -> Option<String> {
    let mut config = EngineConfig {
        parent_session_id: Some("ses_p".to_owned()),
        ..Default::default()
    };
    record_parent_mode(&mut config, &FixedMode(mode)).expect("the mode is read");
    config
        .launch
        .and_then(|launch| launch.subagent_permission_mode)
}

/// Node's submit records the session's mode as its subagent mode: plan and build read as build, edit as edit, bypass as
/// yolo, and guarded and auto are recordable under their own names (the workflow crate's set, Node's `RECORDABLE_MODES`).
#[test]
fn the_launch_records_the_parents_mode_as_node_records_it() {
    assert_eq!(
        recorded(Some(PermissionMode::Default)).as_deref(),
        Some("build")
    );
    assert_eq!(
        recorded(Some(PermissionMode::Plan)).as_deref(),
        Some("build")
    );
    assert_eq!(
        recorded(Some(PermissionMode::AcceptEdits)).as_deref(),
        Some("edit")
    );
    assert_eq!(
        recorded(Some(PermissionMode::BypassPermissions)).as_deref(),
        Some("yolo")
    );
    assert_eq!(
        recorded(Some(PermissionMode::Guarded)).as_deref(),
        Some("guarded")
    );
    assert_eq!(
        recorded(Some(PermissionMode::Auto)).as_deref(),
        Some("auto")
    );
}

/// A port with no store to read a mode from (Ok(None)) records nothing: the key is absent, as Node's
/// `workflowSubagentPermissionModeField` leaves it out when the host reports no mode.
#[test]
fn a_port_with_no_mode_to_read_records_nothing() {
    assert_eq!(recorded(None), None);
}
