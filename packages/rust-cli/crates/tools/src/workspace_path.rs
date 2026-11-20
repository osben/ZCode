//! Fork: the containment check for a file the model names by path (SaveWorkflow's `script_path`, CreateWorkflow's `path`).
//!
//! A path must stay inside the workspace twice: lexically (no `..` escape), and once symlinks are resolved, so a link
//! inside the workspace cannot lead out of it (divergences 113 and 119 of the workflow spec). The caller reads the
//! returned `real` path, the one that was checked, not the named one: a link swapped in after the check then cannot
//! redirect the read.

use std::io;
use std::path::{Component, Path, PathBuf};

use rust_cli_fs::canonicalize_path;

/// A path the model named that is inside the workspace: as named (for messages), and as its real location (the read).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Contained {
    pub(crate) named: PathBuf,
    pub(crate) real: PathBuf,
}

/// Why a named path cannot be used. Each tool words these in its own way.
#[derive(Debug)]
pub(crate) enum Refusal {
    /// The path is outside the workspace (lexically, or once its symlinks are resolved).
    Outside,
    /// The path or the workspace could not be resolved (a missing file, a dangling link, a permission error).
    Unresolved(io::Error),
}

/// Lexical normalization of `.` and `..` (no disk access).
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Checks `input_path` (absolute, or relative to `cwd`) against the workspace root `cwd`. Any failure to resolve the
/// real path refuses: the check never falls back to the lexical result alone.
pub(crate) fn contain(cwd: &Path, input_path: &str) -> Result<Contained, Refusal> {
    let joined = if Path::new(input_path).is_absolute() {
        PathBuf::from(input_path)
    } else {
        cwd.join(input_path)
    };
    let named = normalize(&joined);
    if !named.starts_with(normalize(cwd)) {
        return Err(Refusal::Outside);
    }
    let root = canonicalize_path(cwd).map_err(Refusal::Unresolved)?;
    let real = canonicalize_path(&named).map_err(Refusal::Unresolved)?;
    if !real.starts_with(&root) {
        return Err(Refusal::Outside);
    }
    Ok(Contained { named, real })
}

#[cfg(test)]
#[path = "workspace_path_tests.rs"]
mod tests;
