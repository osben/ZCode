//! Fork: reopening a top-level session adopts its persisted subagent children's notices (specs/fork-rust-agent-parity.md,
//! "After a restart, and on a remote executor"): the kernel's open hands the loaded meta to the agents, which start one
//! forwarder per child.

use std::sync::Arc;
use std::time::Duration;

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use rust_cli_kernel_api::session_api::{EndReason, Kernel, StartSource};
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

/// A kernel over `env` whose store holds a top-level session and one persisted subagent child of it.
async fn kernel_with_child(env: Arc<NoticeEnvironment>) -> (LocalKernel, SessionId, SessionId) {
    let store = Arc::new(MemoryStore::default());
    let root = SessionId::new("sess_root");
    let child = SessionId::new("sess_subagent_agent_old");
    store
        .create(meta(root.as_str(), SessionKind::Interactive, None))
        .await
        .unwrap();
    store
        .create(meta(
            child.as_str(),
            SessionKind::Subagent,
            Some(root.as_str()),
        ))
        .await
        .unwrap();
    let kernel = LocalKernel::new(
        Ports {
            model: Arc::new(ScriptedModel::new(Vec::new())),
            environments: environments(env),
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
    (kernel, root, child)
}

async fn eventually(mut done: impl FnMut() -> bool, what: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what}"));
}

#[tokio::test]
async fn opening_a_top_level_session_starts_one_forwarder_per_persisted_child() {
    let env = Arc::new(NoticeEnvironment::default());
    let (kernel, root, child) = kernel_with_child(env.clone()).await;
    let _session = kernel
        .open_session_as(&root, StartSource::Resume)
        .await
        .unwrap();
    let adopted = || env.subscribed().iter().filter(|id| **id == child).count();
    eventually(|| adopted() > 0, "the persisted child got no forwarder").await;
    assert_eq!(adopted(), 1);
}

/// Closing the top-level session releases it in the agents too: the child's forwarder (no live agent owns it) drops
/// its notice stream with the session actor's own.
#[tokio::test]
async fn closing_a_top_level_session_stops_its_childrens_forwarders() {
    let env = Arc::new(NoticeEnvironment::replaying());
    let (kernel, root, child) = kernel_with_child(env.clone()).await;
    let session = kernel
        .open_session_as(&root, StartSource::Resume)
        .await
        .unwrap();
    eventually(
        || env.subscribed().contains(&child) && env.live_subscriptions() == 2,
        "the session and its child did not both subscribe",
    )
    .await;
    session.close(EndReason::Other).await;
    eventually(
        || env.live_subscriptions() == 0,
        "a notice stream outlived the closed session",
    )
    .await;
}

/// Erasing sessions makes every machine forget them (their background commands are cancelled, pending notices
/// dropped), as Node's runtime close does.
#[tokio::test]
async fn erased_sessions_are_forgotten_on_the_machine() {
    let env = Arc::new(NoticeEnvironment::default());
    let (kernel, root, child) = kernel_with_child(env.clone()).await;
    kernel
        .sessions_erased(vec![root.clone(), child.clone()])
        .await;
    assert_eq!(env.closed(), [(root, true), (child, true)]);
}
