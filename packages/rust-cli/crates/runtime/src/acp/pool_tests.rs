#![allow(
    clippy::disallowed_methods,
    reason = "tests read the mock agent's pid file directly"
)]

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rust_cli_acp::{AcpErrorCode, AcpLaunch, AcpState};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::{AcpSessionBinding, StoreQueries as _};
use rust_cli_kernel_api::testing::MemoryStore;
use rust_cli_proc::ledger::Ledger;

use super::AcpPool;
use crate::acp::test_support::mock_agent;

fn pool_with(dir: &tempfile::TempDir, store: Arc<MemoryStore>) -> AcpPool {
    AcpPool::new(
        Arc::from(Vec::new()),
        Ledger::open(dir.path().join("ledger")),
        store,
    )
}

fn pool(dir: &tempfile::TempDir) -> AcpPool {
    pool_with(dir, Arc::new(MemoryStore::default()))
}

/// A launch that can never start: an acquire that reaches the spawn fails with `SpawnFailed`.
fn missing_agent(dir: &tempfile::TempDir) -> AcpLaunch {
    AcpLaunch {
        agent_id: "mock".to_owned(),
        command: "/nonexistent/acp-agent".to_owned(),
        args: Vec::new(),
        env: None,
        cwd: dir.path().display().to_string(),
    }
}

/// A working mock agent that writes its process id to `pid_file` at start.
fn mock_launch(dir: &tempfile::TempDir, pid_file: &Path) -> AcpLaunch {
    AcpLaunch {
        agent_id: "mock".to_owned(),
        command: mock_agent().display().to_string(),
        args: vec!["--pid-file".to_owned(), pid_file.display().to_string()],
        env: None,
        cwd: dir.path().display().to_string(),
    }
}

fn binding(launch: &AcpLaunch, acp_session_id: &str) -> AcpSessionBinding {
    AcpSessionBinding {
        agent_id: launch.agent_id.clone(),
        acp_session_id: acp_session_id.to_owned(),
        cwd: launch.cwd.clone(),
        launch_key: rust_cli_acp::launch_key(launch),
    }
}

#[tokio::test]
async fn a_release_before_the_reserved_acquire_runs_starts_no_agent() {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir);
    let session = SessionId::new("s1");
    // The turn reserves the slot synchronously; the acquire runs later in its own task.
    let reserved = pool.reserve(&session);
    pool.release(&session).await;
    let error = pool
        .acquire(reserved, missing_agent(&dir))
        .await
        .err()
        .expect("released");
    assert_eq!(error.code, AcpErrorCode::AgentDied, "{error:?}");
    assert!(pool.is_empty(), "a released session leaves no slot");
}

#[tokio::test]
async fn a_session_opened_again_after_release_gets_a_fresh_slot() {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir);
    let session = SessionId::new("s1");
    pool.release(&session).await;
    let error = pool
        .acquire(pool.reserve(&session), missing_agent(&dir))
        .await
        .err()
        .expect("spawn failure");
    assert_eq!(error.code, AcpErrorCode::SpawnFailed, "{error:?}");
}

#[tokio::test]
async fn release_twice_is_a_no_op_the_second_time() {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir);
    let session = SessionId::new("s1");
    let pid_file = dir.path().join("agent.pid");
    let runtime = pool
        .acquire(pool.reserve(&session), mock_launch(&dir, &pid_file))
        .await
        .expect("acquire");
    pool.release(&session).await;
    assert_eq!(runtime.state(), AcpState::Stopped);
    pool.release(&session).await;
    assert!(pool.is_empty());
}

#[tokio::test]
async fn an_unchanged_launch_reuses_the_resident_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir);
    let session = SessionId::new("s1");
    let pid_file = dir.path().join("agent.pid");
    let launch = mock_launch(&dir, &pid_file);
    let first = pool
        .acquire(pool.reserve(&session), launch.clone())
        .await
        .expect("first acquire");
    let pid = std::fs::read_to_string(&pid_file).unwrap();
    let second = pool
        .acquire(pool.reserve(&session), launch)
        .await
        .expect("second acquire");
    assert_eq!(std::fs::read_to_string(&pid_file).unwrap(), pid);
    assert_eq!(first.session_id(), second.session_id());
    assert_eq!(first.state(), AcpState::Ready);
    pool.release(&session).await;
}

#[tokio::test]
async fn a_release_during_an_acquire_stops_the_runtime_that_acquire_started() {
    let dir = tempfile::tempdir().unwrap();
    let pool = Arc::new(pool(&dir));
    let session = SessionId::new("s1");
    let pid_file = dir.path().join("agent.pid");
    let reserved = pool.reserve(&session);
    let acquiring = {
        let pool = pool.clone();
        let launch = mock_launch(&dir, &pid_file);
        tokio::spawn(async move { pool.acquire(reserved, launch).await })
    };
    // The acquire holds the slot's permit while the agent starts; the release has to wait for it.
    tokio::time::timeout(Duration::from_secs(10), async {
        while !pool.is_acquiring(&session) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the acquire takes the permit");
    // No await between the check and the release: the slot leaves the pool while the acquire still runs.
    let releasing = pool.release(&session);
    assert!(pool.is_empty());
    releasing.await;
    let runtime = acquiring
        .await
        .expect("acquire task")
        .expect("the acquire that held the permit finishes");
    assert_eq!(
        runtime.state(),
        AcpState::Stopped,
        "the release stopped the runtime the acquire stored"
    );
}

#[tokio::test]
async fn a_binding_of_another_agent_cwd_or_launch_is_cleared_and_not_resumed() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(MemoryStore::default());
    let pool = pool_with(&dir, store.clone());
    let session = SessionId::new("s1");
    let launch = missing_agent(&dir);
    let key = rust_cli_acp::launch_key(&launch);

    store
        .set_acp_binding(&session, &binding(&launch, "acp-1"))
        .await
        .unwrap();
    assert_eq!(
        pool.resume_target(&session, &launch, &key).await.as_deref(),
        Some("acp-1"),
        "a matching binding is resumed"
    );
    assert!(store.acp_binding(&session).await.unwrap().is_some());

    let mismatches = [
        AcpSessionBinding {
            agent_id: "other".to_owned(),
            ..binding(&launch, "acp-2")
        },
        AcpSessionBinding {
            cwd: "/elsewhere".to_owned(),
            ..binding(&launch, "acp-3")
        },
        AcpSessionBinding {
            launch_key: "stale".to_owned(),
            ..binding(&launch, "acp-4")
        },
    ];
    for stale in mismatches {
        store.set_acp_binding(&session, &stale).await.unwrap();
        assert_eq!(pool.resume_target(&session, &launch, &key).await, None);
        assert_eq!(
            store.acp_binding(&session).await.unwrap(),
            None,
            "{stale:?} is cleared"
        );
    }
}

#[tokio::test]
async fn a_failed_binding_write_clears_the_binding() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(MemoryStore::default());
    let pool = pool_with(&dir, store.clone());
    let session = SessionId::new("s1");
    let pid_file = dir.path().join("agent.pid");
    let launch = mock_launch(&dir, &pid_file);
    pool.acquire(pool.reserve(&session), launch.clone())
        .await
        .expect("first acquire");
    assert!(
        store.acp_binding(&session).await.unwrap().is_some(),
        "an acquire records the binding"
    );
    store.fail_next_acp_binding_write();
    pool.acquire(pool.reserve(&session), launch)
        .await
        .expect("the reuse still succeeds");
    assert_eq!(
        store.acp_binding(&session).await.unwrap(),
        None,
        "a failed write leaves no binding a cold start could load"
    );
    pool.release(&session).await;
}
