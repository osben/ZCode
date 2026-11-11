//! Fork: reopening a top-level session adopts its persisted subagent children's notices (specs/fork-rust-agent-parity.md,
//! "After a restart, and on a remote executor"): the kernel's open hands the loaded meta to the agents, which start one
//! forwarder per child.

use std::sync::Arc;
use std::time::Duration;

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use rust_cli_kernel_api::session_api::StartSource;
use rust_cli_kernel_api::store::{SessionKind, SessionMeta, SessionStore};
use rust_cli_kernel_api::testing::{
    FixedClock, MemoryStore, NoticeEnvironment, ScriptedModel, SequentialIds, environments,
    selection,
};

use super::*;

fn meta(id: &str, kind: SessionKind, parent: Option<&str>) -> SessionMeta {
    SessionMeta {
        id: SessionId::new(id),
        kind,
        parent: parent.map(SessionId::new),
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/work"),
        },
        title: String::new(),
        trace: TraceId::new(id),
        created_at_ms: 0,
    }
}

#[tokio::test]
async fn opening_a_top_level_session_starts_one_forwarder_per_persisted_child() {
    let env = Arc::new(NoticeEnvironment::default());
    let store = Arc::new(MemoryStore::default());
    let root = "sess_root";
    let child = SessionId::new("sess_subagent_agent_old");
    store
        .create(meta(root, SessionKind::Interactive, None))
        .await
        .unwrap();
    store
        .create(meta(child.as_str(), SessionKind::Subagent, Some(root)))
        .await
        .unwrap();
    let kernel = LocalKernel::new(
        Ports {
            model: Arc::new(ScriptedModel::new(Vec::new())),
            environments: environments(env.clone()),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
    );
    let _session = kernel
        .open_session_as(&SessionId::new(root), StartSource::Resume)
        .await
        .unwrap();
    let adopted = || env.subscribed().iter().filter(|id| **id == child).count();
    tokio::time::timeout(Duration::from_secs(5), async {
        while adopted() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the persisted child got no forwarder");
    assert_eq!(adopted(), 1);
}
