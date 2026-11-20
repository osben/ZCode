//! Fork: the sandbox entry file's writer (specs/fork-rust-workflow-engine.md, 4.1 and 5.2). The source comes from the
//! compile helper (`entrySource`); this module only puts it on disk, where the child is started from.
//!
//! The file stays after the run (the directory keeps what each run executed), and a `.gitignore` of `*` is written once,
//! so a user's own `.gitignore` is never changed. A project directory that cannot be written falls back to a directory
//! under the OS temp dir, with one warning, and the run starts as usual.

use std::io;
use std::path::{Path, PathBuf};

/// Where the entry was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryLocation {
    Project,
    Fallback,
}

/// The written entry: the path the child starts from, and where it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryFile {
    pub path: PathBuf,
    pub location: EntryLocation,
}

/// The same write options attachments use for local files: a plain file, created with its parents, no retry.
const WRITE: rust_cli_fs::WriteOptions = rust_cli_fs::WriteOptions {
    mode: rust_cli_fs::FileMode::Default,
    temp_name: rust_cli_fs::TempName::Visible,
    parent: rust_cli_fs::ParentDir::Create,
    rename_retry: &[],
};

/// `<cwd>/.zcode/workflow-runs`, the project directory of the entries.
pub fn project_dir(cwd: &Path) -> PathBuf {
    cwd.join(".zcode").join("workflow-runs")
}

/// The run's file name: every character outside `[A-Za-z0-9._-]` becomes `_`, so a separator cannot reach the path.
pub fn entry_file_name(run_id: &str) -> String {
    let safe: String = run_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe}.mjs")
}

/// Writes `source` as the run's entry. `warn` receives the kind of the error when the project directory is not usable.
/// The kind alone goes to the callback: the error text and the paths stay with the caller's own choice of what to log.
pub async fn write_entry(
    cwd: &Path,
    run_id: &str,
    source: &str,
    fallback_dir: &Path,
    warn: &mut (dyn FnMut(io::ErrorKind) + Send),
) -> io::Result<EntryFile> {
    let project = project_dir(cwd);
    let file_name = entry_file_name(run_id);
    match write_into(&project, &file_name, source).await {
        Ok(path) => Ok(EntryFile {
            path,
            location: EntryLocation::Project,
        }),
        Err(error) => {
            warn(error.kind());
            let path = write_into(fallback_dir, &file_name, source).await?;
            Ok(EntryFile {
                path,
                location: EntryLocation::Fallback,
            })
        }
    }
}

async fn write_into(dir: &Path, file_name: &str, source: &str) -> io::Result<PathBuf> {
    rust_cli_fs::create_dir_all(dir).await?;
    // Created only when absent (`wx`): an existing file, a user's edit included, is left as it is.
    rust_cli_fs::create_new_file(&dir.join(".gitignore"), b"*\n").await?;
    let path = dir.join(file_name);
    rust_cli_fs::atomic_write(&path, source.as_bytes(), WRITE).await?;
    Ok(path)
}

#[cfg(test)]
#[path = "workflow_entry_tests.rs"]
mod tests;
