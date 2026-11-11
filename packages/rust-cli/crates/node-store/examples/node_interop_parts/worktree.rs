//! Fork interop: an execution-worktree session (specs/fork-rust-agent-parity.md "Execution worktree").
//!
//! - `worktree-write <storage-dir> <worktree>`: a session listed under the interop workspace that runs in
//!   `<worktree>` (`execution_directory`, branch `feat/interop`), its prepared-worktree marker active, as the
//!   activation leaves it. The database must already carry Node's fork columns (Node opened it first). Prints the id.
//! - `worktree-read <storage-dir> <session>`: the cold-open root, the stored execution worktree and the latest
//!   marker of a session either runtime wrote.
use rust_cli_kernel_api::store::{FrontendRecord, StoreQueries};

use super::*;

const KIND: &str = "v4/worktree_preparation";

pub(super) async fn write(dir: &str, worktree: &str) -> Result<()> {
    let store = store(dir)?;
    let id = create(&store).await?;
    store
        .put_record(
            &id,
            &FrontendRecord {
                kind: KIND.to_owned(),
                key: format!("{KIND}:{}", id.as_str()),
                data: json!({"attemptId": "attempt-1", "branchName": "feat/interop",
                    "targetPath": worktree, "baseBranch": "main", "status": "active"}),
            },
        )
        .await?;
    store
        .set_execution_worktree(&id, &EnvPath::new(worktree), Some("feat/interop"))
        .await?;
    print(&json!({"session": id.as_str()}))
}

pub(super) async fn read(dir: &str, session: &str) -> Result<()> {
    let store = store(dir)?;
    let id = SessionId::new(session);
    let loaded = store.load(&id).await?;
    let execution = store.execution_worktree(&id).await?;
    let marker = store
        .records(&id, KIND)
        .await?
        .pop()
        .map(|record| record.data);
    print(&json!({
        "root": loaded.meta.workspace.root.as_str(),
        "execution": execution.map(|worktree| json!({
            "directory": worktree.directory.as_str(),
            "path": worktree.path.as_str(),
            "branch": worktree.branch,
        })),
        "marker": marker,
    }))
}
