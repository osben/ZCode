//! Fork (specs/fork-rust-managed-worktree-trust-identity.md): the trust store key of a workspace root. A local
//! managed worktree maps to its source repository, so hook and plugin trust granted there holds in the worktree and a
//! grant made in the worktree is written under the source. Ports Node `resolveWorkspaceHookTrustIdentity` and
//! `resolveManagedWorktreeSourcePath` (`packages/shared/src/managed-worktree/trust-identity.ts`).
//!
//! Every check must pass; any failure or IO error keeps the root itself, so the mapping never grants more than the
//! source repository has.

use std::path::{Path, PathBuf};

use rust_cli_base::path::normalize;
use rust_cli_paths::StoragePaths;

const GITDIR_PREFIX: &str = "gitdir:";
const GIT_DIR: &str = ".git";
const WORKTREES_DIR: &str = "worktrees";
const BUCKET_LEN: usize = 4;

/// The trust store key of `root`: the source repository path for a local managed worktree, else `root` unchanged.
pub(crate) async fn resolve(paths: &StoragePaths, root: &str, local: bool) -> String {
    if !local {
        return root.to_owned();
    }
    match source_path(paths.managed_worktrees().as_path(), Path::new(root)).await {
        Some(source) => source.to_string_lossy().into_owned(),
        None => root.to_owned(),
    }
}

/// Node `resolveManagedWorktreeSourcePath`.
async fn source_path(managed_root: &Path, workspace: &Path) -> Option<PathBuf> {
    let managed_root = realpath(managed_root).await?;
    let workspace = realpath(workspace).await?;
    let (worktree_root, rest) = parse(&managed_root, &workspace)?;

    // 1. `<worktree>/.git` is a regular file: `gitdir: <common>/worktrees/<id>`.
    let dot_git = worktree_root.join(GIT_DIR);
    if !rust_cli_fs::stat(&dot_git).await.ok()??.is_file {
        return None;
    }
    let admin = realpath(&pointer(
        &worktree_root,
        &read(&dot_git).await?,
        GITDIR_PREFIX,
    )?)
    .await?;
    let worktrees = admin.parent()?;
    if worktrees.file_name()? != WORKTREES_DIR {
        return None;
    }
    let common = worktrees.parent()?;

    // 2. The backlink `<admin>/gitdir` names this checkout's `.git`, so no directory can pose as the source.
    let backlink = realpath(&pointer(&admin, &read(&admin.join("gitdir")).await?, "")?).await?;
    if backlink != realpath(&dot_git).await? {
        return None;
    }

    // 3. `<admin>/commondir` resolves to `common`.
    let commondir = realpath(&pointer(
        &admin,
        &read(&admin.join("commondir")).await?,
        "",
    )?)
    .await?;
    if commondir != common {
        return None;
    }

    // 4. `common` is the source toplevel's `.git` directory (not bare, not nested).
    let source_root = common.parent()?;
    let source_dot_git = source_root.join(GIT_DIR);
    if !rust_cli_fs::is_dir(&source_dot_git).await || realpath(&source_dot_git).await? != common {
        return None;
    }
    Some(if rest.as_os_str().is_empty() {
        source_root.to_path_buf()
    } else {
        source_root.join(rest)
    })
}

/// Node `parseManagedWorktreePath`: `<managedRoot>/<bucket>/<name>[/<rest>]`, `bucket` 4 lowercase hex characters.
fn parse(managed_root: &Path, path: &Path) -> Option<(PathBuf, PathBuf)> {
    let relative = path.strip_prefix(managed_root).ok()?;
    let mut parts = relative.iter();
    let bucket = parts.next()?.to_str()?;
    let name = parts.next()?;
    let hex = bucket.len() == BUCKET_LEN
        && bucket
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !hex {
        return None;
    }
    let rest: PathBuf = parts.collect();
    Some((managed_root.join(bucket).join(name), rest))
}

/// Node `resolveGitPointer`: the first line, trimmed, after `prefix`; relative to `base`.
fn pointer(base: &Path, content: &str, prefix: &str) -> Option<PathBuf> {
    let line = content.split('\n').next().unwrap_or_default();
    let line = line.strip_suffix('\r').unwrap_or(line).trim();
    let value = if prefix.is_empty() {
        line
    } else {
        line.strip_prefix(prefix)?.trim()
    };
    if value.is_empty() {
        return None;
    }
    let value = Path::new(value);
    Some(if value.is_absolute() {
        value.to_path_buf()
    } else {
        normalize(&base.join(value))
    })
}

async fn read(path: &Path) -> Option<String> {
    let bytes = rust_cli_fs::read_optional(path).await.ok()??;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

async fn realpath(path: &Path) -> Option<PathBuf> {
    rust_cli_fs::realpath(path).await.ok()
}

#[cfg(test)]
#[path = "trust_identity_tests.rs"]
mod tests;
