//! Fork (specs/fork-rust-hook-script-entry.md, D24): reads the entry scripts of project hooks, at discovery (the
//! digest) and right before each run (the re-check). Ports Node `readWorkspaceHookScriptState` and
//! `readWorkspaceHookScriptStates` (`packages/shared/src/workspace-hook-config.ts`).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::stream::{self, StreamExt};
use rust_cli_fs::BoundedRead;
use rust_cli_hooks::script_entry::{ScriptState, ScriptVerifier};
use rust_cli_hooks::workspace_digest::ScriptStates;
use rust_cli_kernel_api::env::{EnvError, EnvPath, ReadFile, WorkspaceRef};
use rust_cli_kernel_api::env_files::{FileKind, StatFile};
use rust_cli_kernel_api::machine::Files;

/// Node `MAX_SCRIPT_BYTES`.
const MAX_SCRIPT_BYTES: u64 = 16 * 1024 * 1024;
/// Node `DISCOVERY_READ_BUDGET_MS`: one deadline for all the reads of a discovery.
const DISCOVERY_BUDGET: Duration = Duration::from_secs(5);
/// Node `MAX_CONCURRENT_SCRIPT_READS`.
const MAX_CONCURRENT_READS: usize = 8;

/// Where a workspace's scripts are read.
#[derive(Clone, Copy)]
pub(crate) enum Scripts<'a> {
    /// The workspace is on this machine: read the files directly, without blocking on a FIFO (the session).
    Local,
    /// Through a files port, the one that also read the workspace's config (another environment, or the App's
    /// review of a local workspace).
    Port {
        files: &'a dyn Files,
        workspace: &'a WorkspaceRef,
    },
}

impl<'a> Scripts<'a> {
    /// The reader of `workspace`: local for the local environment.
    pub(crate) fn of(files: &'a dyn Files, workspace: &'a WorkspaceRef) -> Self {
        if workspace.environment.as_str() == rust_cli_node_store::LOCAL_ENVIRONMENT {
            Self::Local
        } else {
            Self::Port { files, workspace }
        }
    }

    /// Whether the workspace is on this machine (a local managed worktree's trust identity is its source repository).
    pub(crate) fn is_local(&self) -> bool {
        match self {
            Self::Local => true,
            Self::Port { workspace, .. } => {
                workspace.environment.as_str() == rust_cli_node_store::LOCAL_ENVIRONMENT
            }
        }
    }

    /// The state of `<root>/<path>`; the path is joined as written, with no symlink resolution of its own.
    pub(crate) async fn state(&self, root: &str, path: &str) -> ScriptState {
        match self {
            Self::Local => local(&Path::new(root).join(path)).await,
            Self::Port { files, workspace } => through_port(*files, workspace, root, path).await,
        }
    }
}

async fn local(path: &Path) -> ScriptState {
    match rust_cli_fs::read_script_file(path, MAX_SCRIPT_BYTES).await {
        Ok(BoundedRead::Bytes(bytes)) => ScriptState::File(rust_cli_base::hash::sha256_hex(&bytes)),
        Ok(BoundedRead::Missing) => ScriptState::Missing,
        Ok(BoundedRead::NotRegular | BoundedRead::TooLarge) | Err(_) => ScriptState::Unverifiable,
    }
}

async fn through_port(
    files: &dyn Files,
    workspace: &WorkspaceRef,
    root: &str,
    path: &str,
) -> ScriptState {
    let path = EnvPath::new(format!("{}/{path}", root.trim_end_matches(['/', '\\'])));
    match files.stat(workspace, StatFile { path: path.clone() }).await {
        Ok(None) => return ScriptState::Missing,
        Ok(Some(stat)) if stat.kind == FileKind::File && stat.size <= MAX_SCRIPT_BYTES => {}
        Ok(Some(_)) | Err(_) => return ScriptState::Unverifiable,
    }
    match files.read_file(workspace, ReadFile { path }).await {
        Ok(content) if content.bytes.len() as u64 <= MAX_SCRIPT_BYTES => {
            ScriptState::File(rust_cli_base::hash::sha256_hex(&content.bytes))
        }
        Err(EnvError::NotFound { .. }) => ScriptState::Missing,
        Ok(_) | Err(_) => ScriptState::Unverifiable,
    }
}

/// Node `readWorkspaceHookScriptStates`: each path once, at most [`MAX_CONCURRENT_READS`] at a time, under one
/// [`DISCOVERY_BUDGET`]; a path not read by then has no state, so its entry is unverifiable.
pub(crate) async fn read_states(
    scripts: Scripts<'_>,
    root: &str,
    paths: Vec<String>,
) -> ScriptStates {
    read_states_within(scripts, root, paths, DISCOVERY_BUDGET).await
}

pub(crate) async fn read_states_within(
    scripts: Scripts<'_>,
    root: &str,
    paths: Vec<String>,
    budget: Duration,
) -> ScriptStates {
    let mut states = ScriptStates::new();
    let mut reads = stream::iter(paths.into_iter().map(|path| async move {
        let state = scripts.state(root, &path).await;
        (path, state)
    }))
    .buffer_unordered(MAX_CONCURRENT_READS);
    let deadline = tokio::time::sleep(budget);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            biased;
            () = &mut deadline => break,
            next = reads.next() => match next {
                Some((path, state)) => {
                    states.insert(path, state);
                }
                None => break,
            },
        }
    }
    states
}

/// The engine's re-check reader (`HookEngine::set_script_verifier`).
pub(crate) struct Verifier {
    pub(crate) files: Arc<dyn Files>,
}

#[async_trait]
impl ScriptVerifier for Verifier {
    async fn state(&self, workspace: &WorkspaceRef, path: &str) -> ScriptState {
        Scripts::of(self.files.as_ref(), workspace)
            .state(workspace.root.as_str(), path)
            .await
    }
}

#[cfg(test)]
#[path = "hook_scripts_tests.rs"]
mod tests;
