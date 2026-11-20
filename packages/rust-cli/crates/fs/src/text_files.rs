//! Fork: whole-file text IO for the saved-workflow store (specs/fork-rust-workflow-engine.md, W7-8b). Saved definitions are
//! small local files that the agent process reads and writes synchronously, as Node does. The IO lives here because
//! this crate is the local storage entry point; the store's rules live with the tools.

use std::io;
use std::path::{Path, PathBuf};

/// Reads a file as UTF-8 text.
pub fn read_text(path: &Path) -> io::Result<String> {
    std::fs::read_to_string(path)
}

/// The names of the entries of a directory, unsorted. A missing directory is `ErrorKind::NotFound`. A name that is not
/// UTF-8 is converted lossily: it then carries U+FFFD, which no saved-workflow name may contain, so the store lists it
/// as an unusable file instead of reading it under a different name.
pub fn list_file_names(dir: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        names.push(entry?.file_name().to_string_lossy().into_owned());
    }
    Ok(names)
}

/// Writes a file, creating its parent directories first. The write is not atomic: a crash in the middle can leave a
/// partly written file, as Node's `writeFileSync` can. The store's readers report such a file as invalid.
pub fn write_text(path: &Path, text: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, text)
}

/// Whether the path is an existing regular file. `metadata` follows symlinks, so a link to a regular file counts; any
/// stat error (a missing path, a permission error, a broken link) counts as not-a-file.
pub fn is_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}

/// The path with every symlink resolved. Fails when the path does not exist.
pub fn canonicalize_path(path: &Path) -> io::Result<PathBuf> {
    std::fs::canonicalize(path)
}

/// Makes `link` a symbolic link to `target` (Unix). Used by the storage tests to set up a link out of the workspace.
#[cfg(unix)]
pub fn symlink_to(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(test)]
#[path = "text_files_tests.rs"]
mod tests;
