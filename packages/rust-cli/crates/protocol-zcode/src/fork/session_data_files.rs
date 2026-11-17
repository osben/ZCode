//! Fork: the files of one session under the CLI storage root, for permanent deletion (Node
//! `adapters/src/storage/session-data-files/index.ts`). The roots are Node's: the per-session directories
//! `artifacts`, `exec`, `agents`, `sessions`, and the model-call traces `debug|rollout/model-io-<id>.jsonl`.
//! Sizes count real files (`lstat`, so a symlink counts 0 and is not followed). A missing path is not an error, so
//! removing twice is harmless.

use std::path::{Path, PathBuf};

use rust_cli_kernel_api::session_deletion::locale_compare;

/// Node `SESSION_DIRECTORY_ROOTS`: directories keyed by exactly the session id.
const SESSION_DIRECTORY_ROOTS: [&str; 4] = ["artifacts", "exec", "agents", "sessions"];
/// Node `MODEL_IO_DIRECTORIES`: one `model-io-<id>.jsonl` file per session in each.
const MODEL_IO_DIRECTORIES: [&str; 2] = ["debug", "rollout"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileKind {
    Artifact,
    Record,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionFile {
    pub(crate) name: String,
    /// Relative to the CLI storage root, with the platform's separators (Node `relative(root, current)`): a backslash
    /// in a Unix file name stays part of the name.
    pub(crate) relative_path: String,
    pub(crate) kind: FileKind,
    pub(crate) bytes: u64,
}

#[derive(Debug)]
pub(crate) enum FileError {
    /// A Node error code such as `session-data.invalid-session-id`.
    Refused(&'static str),
    Io(std::io::Error),
}

impl FileError {
    /// The reason a failed file step reports: Node's `error.code` (the errno name), or `fallback` when the error has
    /// none. Execute falls back to `unavailable`; purge's per-session failure to `unknown`.
    pub(crate) fn code_or(&self, fallback: &str) -> String {
        match self {
            Self::Refused(code) => (*code).to_owned(),
            Self::Io(error) => {
                rust_cli_fs::error_code(error).map_or_else(|| fallback.to_owned(), str::to_owned)
            }
        }
    }
}

impl From<std::io::Error> for FileError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Node `SAFE_SESSION_ID`: the id is joined into a path, so it must be one plain segment.
pub(crate) fn is_safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Node `sessionPaths`: the six locations a session's files can be in.
pub(crate) fn session_paths(cli: &Path, session_id: &str) -> Result<Vec<PathBuf>, FileError> {
    if !is_safe_session_id(session_id) {
        return Err(FileError::Refused("session-data.invalid-session-id"));
    }
    let mut paths: Vec<PathBuf> = SESSION_DIRECTORY_ROOTS
        .iter()
        .map(|name| cli.join(name).join(session_id))
        .collect();
    paths.extend(
        MODEL_IO_DIRECTORIES
            .iter()
            .map(|name| cli.join(name).join(format!("model-io-{session_id}.jsonl"))),
    );
    Ok(paths)
}

/// Node `listSessionFiles`: every real file under the session's locations, sorted by relative path (ICU).
pub(crate) async fn list(cli: &Path, session_id: &str) -> Result<Vec<SessionFile>, FileError> {
    let artifacts = cli.join("artifacts").join(session_id);
    let mut result = Vec::new();
    for path in session_paths(cli, session_id)? {
        let kind = if path == artifacts {
            FileKind::Artifact
        } else {
            FileKind::Record
        };
        // A storage category directory replaced by a link must not lead the walk outside the storage root.
        if let Some(parent) = path.parent()
            && rust_cli_fs::link_stat(parent)
                .await?
                .is_some_and(|stat| stat.is_symlink)
        {
            return Err(FileError::Refused("session-data.symlink-root"));
        }
        let mut stack = vec![path];
        while let Some(current) = stack.pop() {
            let Some(meta) = rust_cli_fs::link_stat(&current).await? else {
                continue;
            };
            let relative = current
                .strip_prefix(cli)
                .unwrap_or(&current)
                .to_string_lossy()
                .into_owned();
            let name = current
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if meta.is_symlink {
                result.push(SessionFile {
                    name,
                    relative_path: relative,
                    kind,
                    bytes: 0,
                });
            } else if meta.is_dir {
                stack.extend(rust_cli_fs::dir_entries(&current).await?);
            } else {
                result.push(SessionFile {
                    name,
                    relative_path: relative,
                    kind,
                    bytes: meta.len,
                });
            }
        }
    }
    result.sort_by(|a, b| locale_compare(&a.relative_path, &b.relative_path));
    Ok(result)
}

/// Node `removeSession`: removes the session's files and returns the bytes of the files removed. With retained
/// artifacts, only the artifact files that match one of them survive, and the per-session directories and traces go.
/// Without any, the locations are removed whole and the bytes are the listing's.
pub(crate) async fn remove(
    cli: &Path,
    session_id: &str,
    retained: &[String],
) -> Result<u64, FileError> {
    let paths = session_paths(cli, session_id)?;
    let manifest = list(cli, session_id).await?;
    if retained.is_empty() {
        for path in &paths {
            remove_path(path).await?;
        }
        return Ok(manifest.iter().map(|file| file.bytes).sum());
    }
    let mut bytes = 0;
    for file in &manifest {
        let kept = file.kind == FileKind::Artifact
            && retained
                .iter()
                .any(|artifact| file.name.contains(artifact.as_str()));
        if kept {
            continue;
        }
        remove_path(&cli.join(&file.relative_path)).await?;
        bytes += file.bytes;
    }
    for path in paths.iter().skip(1) {
        remove_path(path).await?;
    }
    Ok(bytes)
}

/// Node `rm(path, { recursive: true, force: true })`: a link is removed as a link, and a missing path is not an error.
async fn remove_path(path: &Path) -> Result<(), FileError> {
    Ok(rust_cli_fs::remove_path_force(path).await?)
}
