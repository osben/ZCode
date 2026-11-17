//! Fork: the sizes and the project memory folder of session data (Node `session-data-files/index.ts` `measure*`,
//! `core/src/memory/project-root.ts` `resolveProjectMemoryRoot`). Measuring is read-only: a symlink counts 0 and is
//! never followed, and a missing path is 0.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::session_data_files::{FileError, session_paths};

/// Node `measurePath`: the bytes of the real files under `path`; a missing path is 0.
pub(crate) async fn measure_path(path: &Path) -> Result<u64, FileError> {
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Some(stat) = rust_cli_fs::link_stat(&current).await? else {
            continue;
        };
        if stat.is_symlink {
            continue;
        }
        if stat.is_dir {
            stack.extend(rust_cli_fs::dir_entries(&current).await?);
        } else {
            total += stat.len;
        }
    }
    Ok(total)
}

/// Node `measureSession`: the bytes of every location of one session. No storage-root check, as in Node.
pub(crate) async fn measure_session(cli: &Path, session_id: &str) -> Result<u64, FileError> {
    let mut total = 0;
    for path in session_paths(cli, session_id)? {
        total += measure_path(&path).await?;
    }
    Ok(total)
}

/// Node `resolveProjectMemoryRoot` up to its project folder: `<cli>/memories/projects/<slug>-<sha256(key)[..16]>`. The key
/// is the trimmed workspace identity, else the normalized path (lowercased on Windows). With an identity the slug is
/// `project`; otherwise it is the sanitized basename of the path.
pub(crate) fn project_memory_folder(
    cli: &Path,
    workspace_path: &str,
    workspace_identity: Option<&str>,
) -> PathBuf {
    project_memory_folder_for(cli, workspace_path, workspace_identity, cfg!(windows))
}

/// [`project_memory_folder`] for the platform rules named by `windows`: Node's win32 `path.resolve` and `basename`
/// (drive-absolute paths, both separators, lowercased key) or the POSIX ones. Tests pass both.
pub(crate) fn project_memory_folder_for(
    cli: &Path,
    workspace_path: &str,
    workspace_identity: Option<&str>,
    windows: bool,
) -> PathBuf {
    let identity = workspace_identity
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let normalized = if windows {
        normalize_win32_path(workspace_path)
    } else {
        normalize_path(workspace_path)
    };
    let key = match identity {
        Some(identity) => identity.to_owned(),
        None if windows => normalized.to_lowercase(),
        None => normalized.clone(),
    };
    let digest = format!("{:x}", Sha256::digest(key.as_bytes()));
    let slug = match identity {
        Some(_) => "project".to_owned(),
        None => sanitize_slug(basename(&normalized, windows)),
    };
    cli.join("memories")
        .join("projects")
        .join(format!("{slug}-{}", &digest[..16]))
}

/// Node `path.basename` of a normalized path: the last segment, split on `/` (and `\` on win32).
fn basename(normalized: &str, windows: bool) -> &str {
    if windows {
        normalized.rsplit(['/', '\\']).next().unwrap_or_default()
    } else {
        normalized.rsplit('/').next().unwrap_or_default()
    }
}

/// Node `sanitizeProjectSlug`: lowercase, each run of other characters becomes `-`, trimmed, at most 48 characters,
/// `project` when nothing is left.
fn sanitize_slug(value: &str) -> String {
    // Node `replace(/[^a-z0-9._-]+/g, "-")`: each run of other characters is one `-`, a literal `-` is kept as it is.
    let mut slug = String::new();
    let mut in_other_run = false;
    for character in value.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            slug.push(character);
            in_other_run = false;
        } else if !in_other_run {
            slug.push('-');
            in_other_run = true;
        }
    }
    let trimmed: String = slug.trim_matches('-').chars().take(48).collect();
    if trimmed.is_empty() {
        "project".to_owned()
    } else {
        trimmed
    }
}

/// Node `path.win32.resolve` of a drive-absolute path (`C:\dir`, `C:/dir`): both separators, `.` and `..` resolved, no
/// trailing separator, the drive letter kept as given. A path without a drive is not resolved against the cwd's drive
/// (Node does that); it takes the POSIX form, which the Host does not send on Windows.
fn normalize_win32_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let drive_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\');
    if !drive_absolute {
        return normalize_path(path);
    }
    let (drive, rest) = path.split_at(2);
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("{drive}\\{}", parts.join("\\"))
}

/// Lexical normalization of an absolute POSIX path (Node `path.resolve` for the paths the Host sends).
fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::{project_memory_folder, project_memory_folder_for};
    use std::path::Path;

    /// Goldens from Node's `resolveProjectMemoryRoot` (`core/src/memory/project-root.ts`, cliStorageRoot `/cli`) with the
    /// `/memory` suffix removed, 2026-11-17.
    #[test]
    fn project_folders_match_nodes_resolve_project_memory_root() {
        let cli = Path::new("/cli");
        let folder = |path: &str, identity: Option<&str>| {
            project_memory_folder(cli, path, identity)
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(
            folder("/work/Example Project", None),
            "/cli/memories/projects/example-project-d6d9600b8caa8d6d"
        );
        assert_eq!(
            folder("/work/a/../My_Repo!!--x/", Some(" ident ")),
            "/cli/memories/projects/project-e77c4b3f81059b97"
        );
        assert_eq!(
            folder("/work/My_Repo!!--x/", None),
            "/cli/memories/projects/my_repo---x-ff23fa6ced8d2b12"
        );
        assert_eq!(
            folder("/", None),
            "/cli/memories/projects/project-8a5edab282632443"
        );
    }

    /// Goldens from Node's `resolveProjectMemoryRoot` on win32 (`path.win32.resolve`, `path.win32.basename`, the key
    /// lowercased), run with Node for drive-absolute paths. The folder names do not depend on the host platform.
    #[test]
    fn project_folders_match_nodes_win32_resolve_project_memory_root() {
        let cli = Path::new("/cli");
        let folder = |path: &str, identity: Option<&str>| {
            project_memory_folder_for(cli, path, identity, true)
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(
            folder("C:\\Work\\Example Project\\", None),
            "/cli/memories/projects/example-project-aa3ffddafeed2e6f"
        );
        assert_eq!(
            folder("D:/work/a/../My_Repo!!--x/", None),
            "/cli/memories/projects/my_repo---x-7dc976376d4eda73"
        );
        assert_eq!(
            folder("D:\\work\\a\\..\\My_Repo!!--x\\", None),
            "/cli/memories/projects/my_repo---x-7dc976376d4eda73"
        );
        assert_eq!(
            folder("c:\\Mixed\\CASE\\Dir", None),
            "/cli/memories/projects/dir-aa9f63d771ea4391"
        );
        assert_eq!(
            folder("C:/Users/Me/Dev/ZCode", None),
            "/cli/memories/projects/zcode-85a9226d5beff670"
        );
        assert_eq!(
            folder("C:\\", None),
            "/cli/memories/projects/project-3dc8472eaebe1a9d"
        );
        assert_eq!(
            folder("E:\\Work\\Some Repo", Some(" ident ")),
            "/cli/memories/projects/project-e77c4b3f81059b97"
        );
    }
}
