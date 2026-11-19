//! `git.*` world reads, pure half (Node `workflow-git-world-read.ts`).
//!
//! Argument validation, the fixed argv of each op, and the parsers for porcelain-v2 status, log and path lists. No
//! process is started here; the execution half lives in [`crate::world_read`].
//!
//! Read-only by construction: argv is built only for the allowed subcommands. A base ref must pass a strict character
//! check (no leading `-`, no `..`), a path must be workspace-relative and contained, and paths always follow `--`.
//! Output is NUL-separated (`-z`), and every path on the wire is repository-root-relative, so the workspace prefix
//! (`rev-parse --show-prefix`) is stripped once when parsing.

// WorkflowError is the engine's error type (Node WorkflowError): its Err path is cold, and boxing it would split the type.
#![allow(clippy::result_large_err)]

use crate::error::{ErrorCode, WorkflowError};
use serde_json::{Map, Value};
use std::cmp::Ordering;

/// `git log` field format: NUL-separated hash, subject, author name and author date (ISO-8601).
pub const GIT_LOG_PRETTY: &str = "--pretty=format:%H%x00%s%x00%an%x00%aI";

/// Workspace prefix relative to the repository root (`sub/nested/`, empty at the repository root).
pub const GIT_SHOW_PREFIX_ARGV: &[&str] = &["rev-parse", "--show-prefix"];

/// Fixed argv for `git status`. `--branch` supplies the branch; `-- .` confines observation to the workspace.
pub const GIT_STATUS_ARGV: &[&str] = &["status", "--porcelain=v2", "-z", "--branch", "--", "."];

/// Fixed argv for untracked files. `--exclude-standard` respects ignore rules; `--full-name` keeps the paths
/// repository-root-relative like the other commands.
pub const GIT_UNTRACKED_ARGV: &[&str] = &[
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--full-name",
    "--",
    ".",
];

/// The workspace pathspec. Git observations stay inside the workspace, as the other world reads do.
const WORKSPACE_PATHSPEC: &str = ".";

/// One argv (without the `git` executable) to run for an op.
pub type GitArgv = Vec<String>;

/// `git.status()` result (Node `GitStatus`). `branch` is absent for a detached HEAD.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitStatusResult {
    pub branch: Option<String>,
    pub clean: bool,
    pub staged: Vec<String>,
    pub unstaged: Vec<String>,
    pub untracked: Vec<String>,
}

impl GitStatusResult {
    /// The value the script receives, with Node's key order (`branch` only when present).
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        if let Some(branch) = &self.branch {
            map.insert("branch".into(), Value::String(branch.clone()));
        }
        map.insert("clean".into(), Value::Bool(self.clean));
        map.insert("staged".into(), strings(&self.staged));
        map.insert("unstaged".into(), strings(&self.unstaged));
        map.insert("untracked".into(), strings(&self.untracked));
        Value::Object(map)
    }
}

/// One `git.log()` entry (Node `GitCommit`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommitResult {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

impl GitCommitResult {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("hash".into(), Value::String(self.hash.clone()));
        map.insert("subject".into(), Value::String(self.subject.clone()));
        map.insert("author".into(), Value::String(self.author.clone()));
        map.insert("date".into(), Value::String(self.date.clone()));
        Value::Object(map)
    }
}

fn strings(values: &[String]) -> Value {
    Value::Array(values.iter().cloned().map(Value::String).collect())
}

/// JavaScript string order: comparison by UTF-16 code units (Node `.sort()` and `<` on journaled values).
pub fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn driver_error(message: String) -> WorkflowError {
    WorkflowError::new(ErrorCode::DriverError, message)
}

/// Validate a base ref and return it. The message says why it was rejected so the script author can fix it.
pub fn validate_git_ref(op: &str, value: &str) -> Result<String, WorkflowError> {
    if value.is_empty() {
        return Err(driver_error(format!(
            "world-read {op}: base must not be empty. Pass a ref such as \"main\" or omit it."
        )));
    }
    if value.starts_with('-') {
        return Err(driver_error(format!(
            "world-read {op}: base '{value}' starts with '-', which git would read as an option, \
             not a ref. Pass a plain ref."
        )));
    }
    if value.contains("..") {
        return Err(driver_error(format!(
            "world-read {op}: base '{value}' is a '..' range; only a single ref is accepted. Pass \
             one ref."
        )));
    }
    if !is_git_ref(value) {
        return Err(driver_error(format!(
            "world-read {op}: base '{value}' is not a valid ref. A ref starts with a letter or \
             digit, followed by letters, digits and . _ / @ ^ ~ - (no whitespace or syntax \
             characters such as {{}} :)."
        )));
    }
    Ok(value.to_owned())
}

/// `^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$`.
fn is_git_ref(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '@' | '^' | '~' | '-'))
}

/// Absolute paths, independent of the platform: a leading `/` or `\`, or a drive letter.
fn looks_absolute(value: &str) -> bool {
    // The JavaScript pattern `^[A-Za-z]:[\\/]?` makes the separator optional, so `C:x` counts too.
    if value.starts_with('/') || value.starts_with('\\') {
        return true;
    }
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Validate a workspace-relative path and return it with separators unified as `/`.
pub fn validate_git_path(op: &str, value: &str) -> Result<String, WorkflowError> {
    if value.is_empty() {
        return Err(driver_error(format!(
            "world-read {op}: path must not be empty. Pass a workspace-relative path or omit it."
        )));
    }
    if value.starts_with('-') {
        return Err(driver_error(format!(
            "world-read {op}: path '{value}' starts with '-', which git could read as an option. \
             Pass a path that does not start with '-'."
        )));
    }
    // `:` starts git pathspec magic (`:/x`, `:(top)x`, `:!x`), which reads outside the workspace even after `--`.
    if value.starts_with(':') {
        return Err(driver_error(format!(
            "world-read {op}: path '{value}' starts with ':', which git reads as pathspec magic. Pass \
             a plain workspace-relative path."
        )));
    }
    if looks_absolute(value) {
        return Err(driver_error(format!(
            "world-read {op}: path '{value}' is absolute; only workspace-relative paths are \
             accepted. Pass the path relative to the workspace root."
        )));
    }
    // Normalize before checking for `..`, or `..\x` could slip through the segment split.
    let normalized = value.replace('\\', "/");
    if normalized.split('/').any(|segment| segment == "..") {
        return Err(driver_error(format!(
            "world-read {op}: path '{value}' contains a '..' segment and would leave the \
             workspace. Pass a path inside the workspace."
        )));
    }
    Ok(normalized)
}

/// The argv commands for `git.changedFiles(base?)`. Without a base: `diff --name-only HEAD` and the untracked list.
/// With a base: `diff --name-only <base>` only (a file never added to git cannot be compared with a ref).
pub fn git_changed_files_plans(base: Option<&str>) -> Result<Vec<GitArgv>, WorkflowError> {
    let reference = match base {
        None => "HEAD".to_owned(),
        Some(value) => validate_git_ref("git-changed-files", value)?,
    };
    let tracked = argv(&[
        "diff",
        "--name-only",
        "-z",
        &reference,
        "--",
        WORKSPACE_PATHSPEC,
    ]);
    if base.is_some() {
        return Ok(vec![tracked]);
    }
    Ok(vec![tracked, argv(GIT_UNTRACKED_ARGV)])
}

/// argv for `git.diff(base?, path?)`. `--relative` makes the patch headers workspace-relative; the path always follows
/// `--`.
pub fn git_diff_argv(base: Option<&str>, path: Option<&str>) -> Result<GitArgv, WorkflowError> {
    let reference = match base {
        None => "HEAD".to_owned(),
        Some(value) => validate_git_ref("git-diff", value)?,
    };
    let pathspec = match path {
        None => WORKSPACE_PATHSPEC.to_owned(),
        Some(value) => validate_git_path("git-diff", value)?,
    };
    Ok(argv(&["diff", "--relative", &reference, "--", &pathspec]))
}

/// argv for `git.log(count)`. No pathspec: a commit is a repository-level object.
pub fn git_log_argv(count: u64) -> GitArgv {
    argv(&["log", &format!("-n{count}"), GIT_LOG_PRETTY])
}

/// The workspace prefix from `rev-parse --show-prefix` (one trailing newline removed).
pub fn parse_git_show_prefix(stdout: &str) -> String {
    let trimmed = stdout.strip_suffix('\n').unwrap_or(stdout);
    trimmed.strip_suffix('\r').unwrap_or(trimmed).to_owned()
}

/// Split `-z` output on NUL and drop the empty segments the terminator leaves.
fn nul_segments(stdout: &str) -> Vec<&str> {
    stdout
        .split('\0')
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// Strip the workspace prefix to get a workspace-relative path. A path outside the prefix fails the read: the pathspec
/// is meant to confine every result, so reaching this means the scoping is broken.
fn strip_workspace_prefix(prefix: &str, path: &str) -> Result<String, WorkflowError> {
    if prefix.is_empty() {
        return Ok(path.to_owned());
    }
    match path.strip_prefix(prefix) {
        Some(rest) => Ok(rest.to_owned()),
        None => Err(driver_error(format!(
            "git reported path '{path}' outside the workspace prefix '{prefix}'. The pathspec should \
             have scoped the read to the workspace, so the scoping is broken; report this as a bug."
        ))),
    }
}

/// The remainder of a space-separated record from field `index` on (fields are one space apart; the final path may
/// contain spaces).
fn field_tail(line: &str, index: usize) -> &str {
    let mut rest = line;
    for _ in 0..index {
        match rest.find(' ') {
            Some(at) => rest = &rest[at + 1..],
            None => return "",
        }
    }
    rest
}

/// Sort and deduplicate by JavaScript string order.
fn sorted_unique(values: Vec<String>) -> Vec<String> {
    let mut values = values;
    values.sort_by(|a, b| js_cmp(a, b));
    values.dedup();
    values
}

/// Parse `git status --porcelain=v2 -z --branch -- .`. Rename records use two NUL segments; the second (the original
/// path) is consumed and not reported. An unmerged entry counts as unstaged.
pub fn parse_git_status_porcelain_v2(
    stdout: &str,
    prefix: &str,
) -> Result<GitStatusResult, WorkflowError> {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    let mut branch: Option<String> = None;

    let segments = nul_segments(stdout);
    let mut index = 0;
    while index < segments.len() {
        let segment = segments[index];
        index += 1;
        if let Some(head) = segment.strip_prefix("# branch.head ") {
            // Detached HEAD reads "(detached)", which is not a branch name, so `branch` stays absent.
            if head != "(detached)" {
                branch = Some(head.to_owned());
            }
            continue;
        }
        if segment.starts_with('#') {
            continue;
        }
        let kind = segment.chars().next();
        match kind {
            Some(k @ ('1' | '2')) => {
                let xy = segment.split(' ').nth(1).unwrap_or("..");
                let path = field_tail(segment, if k == '1' { 8 } else { 9 });
                if k == '2' {
                    index += 1;
                }
                if path.is_empty() {
                    continue;
                }
                let relative = strip_workspace_prefix(prefix, path)?;
                let mut xy_chars = xy.chars();
                let index_status = xy_chars.next();
                let worktree_status = xy_chars.next();
                if index_status.is_some_and(|c| c != '.') {
                    staged.push(relative.clone());
                }
                if worktree_status.is_some_and(|c| c != '.') {
                    unstaged.push(relative);
                }
            }
            Some('u') => {
                let path = field_tail(segment, 10);
                if !path.is_empty() {
                    unstaged.push(strip_workspace_prefix(prefix, path)?);
                }
            }
            Some('?') => {
                let path = field_tail(segment, 1);
                if !path.is_empty() {
                    untracked.push(strip_workspace_prefix(prefix, path)?);
                }
            }
            _ => {}
        }
    }

    let staged = sorted_unique(staged);
    let unstaged = sorted_unique(unstaged);
    let untracked = sorted_unique(untracked);
    let clean = staged.is_empty() && unstaged.is_empty() && untracked.is_empty();
    Ok(GitStatusResult {
        branch,
        clean,
        staged,
        unstaged,
        untracked,
    })
}

/// Parse [`GIT_LOG_PRETTY`] output: one record per line, four NUL-separated fields. A record with another field count
/// is an error, so a partial commit never reaches the journal.
pub fn parse_git_log(stdout: &str) -> Result<Vec<GitCommitResult>, WorkflowError> {
    let mut commits = Vec::new();
    for raw in stdout.split('\n') {
        let record = raw.strip_suffix('\r').unwrap_or(raw);
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.split('\0').collect();
        if fields.len() != 4 {
            return Err(driver_error(format!(
                "world-read git-log: cannot parse the output; a record should have 4 NUL-separated \
                 fields, got {}. Retry, and report this as a bug if it persists.",
                fields.len()
            )));
        }
        commits.push(GitCommitResult {
            hash: fields[0].to_owned(),
            subject: fields[1].to_owned(),
            author: fields[2].to_owned(),
            date: fields[3].to_owned(),
        });
    }
    Ok(commits)
}

/// Parse `--name-only -z` / `ls-files -z` output into workspace-relative paths (the prefix is stripped once here).
pub fn parse_git_path_list(stdout: &str, prefix: &str) -> Result<Vec<String>, WorkflowError> {
    nul_segments(stdout)
        .into_iter()
        .map(|path| strip_workspace_prefix(prefix, path))
        .collect()
}

fn argv(parts: &[&str]) -> GitArgv {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

#[cfg(test)]
#[path = "world_git_tests.rs"]
mod tests;
