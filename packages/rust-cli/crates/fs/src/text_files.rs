//! Fork: whole-file text IO for the saved-workflow store (specs/fork-rust-workflow-engine.md, W7-8b). Saved definitions are
//! small local files that the agent process reads and writes synchronously, as Node does. The IO lives here because
//! this crate is the local storage entry point; the store's rules live with the tools.

use std::io;
use std::path::Path;

/// Reads a file as UTF-8 text.
pub fn read_text(path: &Path) -> io::Result<String> {
    std::fs::read_to_string(path)
}

/// Makes `link` a symbolic link to `target` (Unix only). Tests use it to check that a link cannot lead a path out of its
/// root.
#[cfg(unix)]
pub fn symlink(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
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

/// Creates a new file with the text, failing with `AlreadyExists` when the path is taken (the claim is one operation, as
/// Node's `wx` flag). The parent directory must exist.
pub fn create_new_text(path: &Path, text: &str) -> io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(text.as_bytes())
}

/// The real path of an existing file or directory, with every symlink resolved. Used to check that a path stays inside a
/// root: a lexical check alone lets a symlink inside the root lead out of it. Same name as the helper of PR #585.
pub fn canonicalize_path(path: &Path) -> io::Result<std::path::PathBuf> {
    std::fs::canonicalize(path)
}

/// Creates a directory and its missing parents.
pub fn ensure_dir(path: &Path) -> io::Result<()> {
    std::fs::create_dir_all(path)
}

/// Whether the path is an existing regular file (a missing path or a directory is not).
pub fn is_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}

#[cfg(test)]
#[path = "text_files_tests.rs"]
mod tests;
