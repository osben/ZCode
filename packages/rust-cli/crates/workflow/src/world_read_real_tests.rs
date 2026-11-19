//! The git world reads against a real repository (Node `workflow-git-world-read-real.test.ts`). The test host runs git
//! with `std::process::Command`; glob, read and grep are not exercised here, so they report unsupported.

#![expect(
    clippy::disallowed_methods,
    reason = "the test prepares a temporary git repository directly, as env-local's git tests do"
)]

use crate::error::ErrorCode;
use crate::world_read::{
    GlobHits, GrepHits, RunOutcome, RunRequest, RunStatus, RunStream, WorldReadPorts,
    execute_world_read,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Runs real processes in the workspace.
struct LocalPorts {
    cwd: PathBuf,
}

impl WorldReadPorts for LocalPorts {
    fn glob(&self, _pattern: &str, _limit: usize) -> Result<GlobHits, String> {
        Err("glob is not part of the git test host".to_owned())
    }

    fn read_text(&self, _path: &str) -> Result<String, String> {
        Err("read is not part of the git test host".to_owned())
    }

    fn grep(
        &self,
        _pattern: &str,
        _glob: Option<&str>,
        _head_limit: usize,
    ) -> Result<GrepHits, String> {
        Err("grep is not part of the git test host".to_owned())
    }

    fn run(&self, request: &RunRequest) -> Result<RunOutcome, String> {
        let output = Command::new(&request.file)
            .args(&request.args)
            .current_dir(&self.cwd)
            .output()
            .map_err(|error| error.to_string())?;
        let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
        let stdout = text(&output.stdout);
        let stderr = text(&output.stderr);
        let status = if output.status.success() {
            RunStatus::Completed
        } else {
            RunStatus::Failed
        };
        Ok(RunOutcome {
            status,
            exit_code: output.status.code(),
            error: None,
            stdout: RunStream {
                bytes: stdout.len(),
                text: stdout,
                truncated: false,
                tail: None,
            },
            stderr: RunStream {
                bytes: stderr.len(),
                text: stderr,
                truncated: false,
                tail: None,
            },
        })
    }
}

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A repository with one commit, a subdirectory `sub/`, and changes inside and outside it.
fn repository() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let root = dir.path();
    git(root, &["init", "-q", "-b", "main"]);
    git(root, &["config", "user.name", "Test"]);
    git(root, &["config", "user.email", "test@example.com"]);
    std::fs::create_dir_all(root.join("sub")).expect("sub");
    std::fs::write(root.join("sub/tracked.md"), "one\n").expect("write");
    std::fs::write(root.join("outside.md"), "one\n").expect("write");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "first commit"]);
    // Changes: tracked modified inside, tracked modified outside, staged, untracked with a space and non-ASCII name.
    std::fs::write(root.join("sub/tracked.md"), "two\n").expect("write");
    std::fs::write(root.join("outside.md"), "two\n").expect("write");
    std::fs::write(root.join("sub/staged.md"), "s\n").expect("write");
    git(root, &["add", "sub/staged.md"]);
    std::fs::write(root.join("sub/new file \u{6587}.md"), "n\n").expect("write");
    dir
}

fn run(dir: &Path, op: &str, args: &[Value]) -> Result<Value, crate::error::WorkflowError> {
    let ports = LocalPorts {
        cwd: dir.join("sub"),
    };
    execute_world_read(&dir.join("sub"), &ports, op, args)
}

#[test]
fn status_inside_a_subdirectory_reports_workspace_relative_paths_only() {
    let dir = repository();
    let status = run(dir.path(), "git-status", &[]).expect("status");
    assert_eq!(status["branch"], "main");
    assert_eq!(status["clean"], false);
    assert_eq!(status["staged"], json!(["staged.md"]));
    assert_eq!(status["unstaged"], json!(["tracked.md"]));
    assert_eq!(status["untracked"], json!(["new file \u{6587}.md"]));
}

#[test]
fn changed_files_without_a_base_lists_tracked_changes_and_untracked_files_under_the_workspace() {
    let dir = repository();
    let changed = run(dir.path(), "git-changed-files", &[]).expect("changed files");
    // `outside.md` is modified too, but lies outside the workspace subdirectory and is not listed.
    assert_eq!(
        changed,
        json!(["new file \u{6587}.md", "staged.md", "tracked.md"])
    );
}

#[test]
fn changed_files_with_a_base_lists_only_tracked_changes() {
    let dir = repository();
    let changed = run(dir.path(), "git-changed-files", &[json!("HEAD")]).expect("changed files");
    assert_eq!(changed, json!(["staged.md", "tracked.md"]));
}

#[test]
fn diff_inside_the_workspace_is_relative_and_contains_the_change() {
    let dir = repository();
    let diff = run(
        dir.path(),
        "git-diff",
        &[json!("HEAD"), json!("tracked.md")],
    )
    .expect("diff");
    let text = diff.as_str().expect("a string");
    assert!(
        text.contains("+two"),
        "the patch holds the new line: {text}"
    );
    assert!(
        !text.contains("outside.md"),
        "the patch stays in the workspace: {text}"
    );
}

#[test]
fn log_returns_the_commit_with_a_full_hash_and_subject() {
    let dir = repository();
    let log = run(dir.path(), "git-log", &[json!(1)]).expect("log");
    let commits = log.as_array().expect("an array");
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0]["subject"], "first commit");
    assert_eq!(commits[0]["hash"].as_str().map(str::len), Some(40));
    assert_eq!(commits[0]["author"], "Test");
}

#[test]
fn a_repository_that_is_not_there_fails_the_read_with_a_catchable_driver_error() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    std::fs::create_dir_all(dir.path().join("sub")).expect("sub");
    let error = run(dir.path(), "git-status", &[]).expect_err("not a repository");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert!(
        error
            .message
            .starts_with("git rev-parse --show-prefix failed"),
        "{}",
        error.message
    );
}
