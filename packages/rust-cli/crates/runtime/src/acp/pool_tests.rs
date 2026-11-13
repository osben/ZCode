use std::sync::Arc;

use rust_cli_acp::{AcpErrorCode, AcpLaunch};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::testing::MemoryStore;
use rust_cli_proc::ledger::Ledger;

use super::AcpPool;

fn pool(dir: &tempfile::TempDir) -> AcpPool {
    AcpPool::new(
        Arc::from(Vec::new()),
        Ledger::open(dir.path().join("ledger")),
        Arc::new(MemoryStore::default()),
    )
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
