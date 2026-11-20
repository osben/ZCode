//! Fork: the containment check for a file the model names by path (SaveWorkflow's `script_path`, CreateWorkflow's `path`).
//!
//! A path must stay inside the workspace twice: lexically (no `..` escape), and once symlinks are resolved, so a link
//! inside the workspace cannot lead out of it (divergences 113 and 119 of the workflow spec).
//!
//! What this guarantees, precisely: the caller reads the returned `real` path, the one that was checked, not the named
//! one. So a link swapped in at the *named* path after the check cannot redirect that read. It does NOT guarantee that
//! nothing escapes between the check and the read: the check and the read are two path-based operations, so a writer
//! inside the workspace that replaces `real` itself, or one of its ancestor directories, with a link out of the
//! workspace in that window is still followed. Closing that needs a descriptor-pinned open (open, then verify the
//! descriptor's canonical path), which is not done here. The residual window is recorded with divergences 113 and 119.
//!
//! Input: `input_path` is absolute or relative to `cwd`. A relative path is joined to `cwd` and then normalized, so a
//! leading `..` is resolved against the workspace: it is accepted only when it lands back inside. `cwd` is expected to
//! be an absolute workspace root.

use std::io;
use std::path::{Path, PathBuf};

use rust_cli_base::path::normalize;
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

/// Whether `named` is under `root` by its components alone (no disk access). With `fold_ascii_case` the two are compared
/// lowercased, as Windows names them: `c:\work` and `C:\Work` are the same directory there.
pub(crate) fn lexically_within(named: &Path, root: &Path, fold_ascii_case: bool) -> bool {
    if !fold_ascii_case {
        return named.starts_with(root);
    }
    let folded_named = named.to_string_lossy().to_ascii_lowercase();
    let folded_root = root.to_string_lossy().to_ascii_lowercase();
    Path::new(&folded_named).starts_with(Path::new(&folded_root))
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
    // The lexical check is a fast reject. The real-path comparison below decides when both paths resolve, and on
    // Windows the canonical forms agree on case, so only this prefix check needs the fold.
    if !lexically_within(&named, &normalize(cwd), cfg!(windows)) {
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
