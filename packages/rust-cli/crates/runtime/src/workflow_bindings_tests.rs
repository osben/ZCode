//! Tests of the production actor bindings (9.35). The port reads a real `NodeStore` over a temp database; the launch seam
//! is checked against the recorded fields Node writes on `run-launched`.

use std::sync::Arc;

use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::ids::{OwnerEpoch, SessionId, TraceId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::store::{Fact, FactBatch, SessionKind, SessionMeta, SessionStore};
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

fn port(store: Arc<NodeStore>) -> Arc<SessionBindings> {
    Arc::new(SessionBindings::new(
        store,
        OpenSessions::default(),
        tokio::runtime::Handle::current(),
    ))
}

/// The port blocks on the store, so it is called off the runtime's threads, as the owner's factory is.
async fn read(
    port: Arc<SessionBindings>,
    parent: &'static str,
) -> (Option<ParentBindings>, Option<PermissionMode>) {
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

    let (bindings, mode) = read(port(store), "ses_p").await;

    let bindings = bindings.expect("the parent is known");
    assert_eq!(
        bindings.selection,
        Some(ModelSelection::new("acct-a", "ma")),
        "the parent's selection"
    );
    assert_eq!(bindings.workspace.root.as_str(), "/work", "the workspace");
    assert_eq!(mode, Some(PermissionMode::AcceptEdits), "the parent's mode");
}

/// A parent with no selection is known, with none: its actors are refused at their asks (9.33), not at the launch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_parent_without_a_selection_is_known_with_none() {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = store_with(dir.path(), "ses_p", vec![]).await;

    let (bindings, _) = read(port(store), "ses_p").await;

    let bindings = bindings.expect("the parent is known");
    assert_eq!(bindings.selection, None, "no selection");
}

/// A session the store does not have is not known, so a launch from it is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unknown_parent_is_not_known() {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = store_with(dir.path(), "ses_p", vec![]).await;

    let (bindings, mode) = read(port(store), "ses_missing").await;

    assert!(bindings.is_none(), "an unknown session has no bindings");
    assert_eq!(mode, None, "and no mode");
}

/// A bare port for the launch seam: a fixed mode, and no bindings.
struct FixedMode(Option<PermissionMode>);

impl ActorBindingsPort for FixedMode {
    fn parent_bindings(&self, _parent: &str) -> Option<ParentBindings> {
        None
    }

    fn parent_permission_mode(&self, _parent: &str) -> Option<PermissionMode> {
        self.0
    }
}

fn recorded(mode: Option<PermissionMode>) -> Option<String> {
    let mut config = EngineConfig {
        parent_session_id: Some("ses_p".to_owned()),
        ..Default::default()
    };
    record_parent_mode(&mut config, &FixedMode(mode));
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

/// A parent whose mode is not known records nothing: the key is absent, as Node's `workflowSubagentPermissionModeField`
/// leaves it out when the host reports no mode.
#[test]
fn a_launch_from_a_parent_with_no_known_mode_records_nothing() {
    assert_eq!(recorded(None), None);
}
