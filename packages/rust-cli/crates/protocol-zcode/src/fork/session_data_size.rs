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
    let identity = workspace_identity
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let normalized = normalize_path(workspace_path);
    let key = match identity {
        Some(identity) => identity.to_owned(),
        None if cfg!(windows) => normalized.to_lowercase(),
        None => normalized.clone(),
    };
    let digest = format!("{:x}", Sha256::digest(key.as_bytes()));
    let slug = match identity {
        Some(_) => "project".to_owned(),
        None => sanitize_slug(normalized.rsplit('/').next().unwrap_or_default()),
    };
    cli.join("memories")
        .join("projects")
        .join(format!("{slug}-{}", &digest[..16]))
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
    use super::project_memory_folder;
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
}
