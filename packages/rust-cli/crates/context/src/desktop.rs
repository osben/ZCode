//! Fork: Node's "ZCode Desktop Context" system section (core `context/sections/desktop.ts`), byte for byte
//! (specs/fork-rust-agent-parity.md, "ZCode Desktop Context").

use std::collections::HashSet;
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

/// The section's name in `/context` (Node's section name).
pub(crate) const NAME: &str = "ZCode Desktop Context";

/// The section text. `directory` is the session's Gen UI output directory when the Host supplied a root.
pub(crate) fn section(directory: Option<&str>) -> String {
    let views = match directory {
        // Node writes the directory with `JSON.stringify`; serde_json escapes strings the same way.
        Some(directory) => render(
            texts::desktop_gen_ui(),
            &[(
                "directory",
                &serde_json::to_string(directory).unwrap_or_default(),
            )],
        ),
        None => texts::desktop_gen_ui_none().to_owned(),
    };
    render(texts::desktop_context(), &[("interactive_views", &views)])
}

/// The session's Gen UI output directory under the Host's root (shared `getGenUiOutputDirectory`): the root joined
/// with the hex SHA-256 of `JSON.stringify([workspaceIdentity?.trim() || workspacePath, sessionId])`. The Rust
/// app-server serves local workspaces only, so the key is the workspace path. None for a relative root (Node refuses
/// it).
pub(crate) fn directory(
    desktop: &DesktopContext,
    workspace: &str,
    session: &str,
) -> Option<String> {
    let root = Path::new(desktop.gen_ui_root.as_deref()?);
    if !root.is_absolute() || !Path::new(workspace).is_absolute() {
        return None;
    }
    let key = serde_json::to_string(&[workspace, session]).ok()?;
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Some(resolve(root).join(hex).to_string_lossy().into_owned())
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

/// The Gen UI output directories this process has created (the single owner of "created" for the section).
#[derive(Default)]
pub(crate) struct Created(Mutex<HashSet<String>>);

impl Created {
    /// Creates `directory` on the primary env once; later requests reuse it.
    pub(crate) async fn ensure(
        &self,
        files: &dyn Files,
        workspace: &WorkspaceRef,
        directory: &str,
    ) -> Result<(), OrchestrationError> {
        if self.0.lock_unpoisoned().contains(directory) {
            return Ok(());
        }
        let request = EnsureDir {
            path: EnvPath::new(directory),
        };
        files.ensure_dir(workspace, request).await.map_err(|error| {
            tracing::warn!(event = "context.gen_ui_dir.failed", error = %error, "creating the Gen UI output directory failed");
            OrchestrationError::Failed {
                message: format!("Gen UI output directory unavailable: {error}"),
            }
        })?;
        self.0.lock_unpoisoned().insert(directory.to_owned());
        Ok(())
    }
}

#[cfg(test)]
#[path = "desktop_tests.rs"]
mod tests;
