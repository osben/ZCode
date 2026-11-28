//! Fork: Node's "ZCode Desktop Context" text (core `context/sections/desktop.ts`), byte for byte, and the session's Gen UI
//! directory. The text rides the environment announcement (specs/fork-rust-desktop-context-announcement.md).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::env_files::EnsureDir;
use rust_cli_kernel_api::machine::Files;
use rust_cli_kernel_api::orchestration::OrchestrationError;
use rust_cli_prompts::texts::{self, render};
use sha2::{Digest, Sha256};

use crate::config::DesktopContext;

/// What the environment announcement says about the desktop (Node `withDesktopContext`): present only on a request
/// that gets the ZCode Desktop Context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DesktopFacts {
    /// The session's Gen UI output directory when the Host supplied a root; the Interactive views block goes with it.
    pub(crate) directory: Option<String>,
}

/// The ZCode Desktop Context text (Node `buildDesktopContextContent`). Without a Gen UI directory the whole Interactive
/// views block is left out, and nothing replaces it.
pub(crate) fn content(has_directory: bool) -> String {
    let views = if has_directory {
        format!("{}\n\n", texts::desktop_gen_ui())
    } else {
        String::new()
    };
    render(texts::desktop_context(), &[("interactive_views", &views)])
}

/// Node's error for a relative root or workspace (shared `getGenUiOutputDirectory`).
pub(crate) const NOT_ABSOLUTE: &str = "Gen UI output root and workspace must be absolute";

/// The session's Gen UI output directory under the Host's root (shared `getGenUiOutputDirectory`): the root joined
/// with the hex SHA-256 of `JSON.stringify([workspaceIdentity?.trim() || workspacePath, sessionId])`. The Rust
/// app-server serves local workspaces only, so the key is the workspace path. None without a root (Node
/// `!genUiOutputRoot`); an error for a relative root or workspace, as Node throws.
pub(crate) fn directory(
    desktop: &DesktopContext,
    workspace: &str,
    session: &str,
) -> Result<Option<String>, &'static str> {
    let Some(root) = desktop
        .gen_ui_root
        .as_deref()
        .filter(|root| !root.is_empty())
    else {
        return Ok(None);
    };
    let root = Path::new(root);
    if !root.is_absolute() || !Path::new(workspace).is_absolute() {
        return Err(NOT_ABSOLUTE);
    }
    let key = serde_json::to_string(&[workspace, session]).map_err(|_| NOT_ABSOLUTE)?;
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(Some(resolve(root).join(hex).to_string_lossy().into_owned()))
}

/// Node's `path.resolve` for an absolute path: drops `.`, repeated and trailing separators, and applies `..`
/// lexically (no symlinks are followed).
fn resolve(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// Each session's Gen UI output directory, the single owner of that fact in this process. Node fixes the key at
/// runtime start (`config.workspacePath`), so EnterWorktree does not move it. Rust keys the directory on the workspace
/// of the session's first request and keeps it: a later workspace change (EnterWorktree, `/cd`) does not rename it.
/// The workspace change is not persisted (tools-more.md D23), so a resumed session starts from the same workspace.
#[derive(Default)]
pub(crate) struct Directories(Mutex<HashMap<String, String>>);

impl Directories {
    /// The session's directory, created on the primary env before it is first named (Node
    /// `ensureGenUiOutputDirectory`). A failure fails the request and is retried on the next one.
    pub(crate) async fn for_session(
        &self,
        desktop: &DesktopContext,
        files: &dyn Files,
        workspace: &WorkspaceRef,
        session: &str,
    ) -> Result<Option<String>, OrchestrationError> {
        if let Some(directory) = self.0.lock_unpoisoned().get(session) {
            return Ok(Some(directory.clone()));
        }
        let directory =
            directory(desktop, workspace.root.as_str(), session).map_err(|message| {
                OrchestrationError::Failed {
                    message: message.to_owned(),
                }
            })?;
        let Some(directory) = directory else {
            return Ok(None);
        };
        let request = EnsureDir {
            path: EnvPath::new(&directory),
        };
        files.ensure_dir(workspace, request).await.map_err(|error| {
            tracing::warn!(event = "context.gen_ui_dir.failed", error = %error, "creating the Gen UI output directory failed");
            OrchestrationError::Failed {
                message: format!("Gen UI output directory unavailable: {error}"),
            }
        })?;
        self.0
            .lock_unpoisoned()
            .entry(session.to_owned())
            .or_insert(directory.clone());
        Ok(Some(directory))
    }
}

#[cfg(test)]
#[path = "desktop_tests.rs"]
mod tests;
