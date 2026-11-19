//! Cases from the ocr review of PR #563 (round 1): git output limits, the git timeout, and pathspec magic.

use crate::error::ErrorCode;
use crate::world_read::{
    GlobHits, GrepHits, RunOutcome, RunRequest, RunStatus, RunStream, WorldReadPorts, caps,
    execute_world_read,
};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Mutex;

/// Records every request and answers `git` runs from a queue.
#[derive(Default)]
struct Host {
    git: Mutex<Vec<RunOutcome>>,
    calls: Mutex<Vec<RunRequest>>,
}

fn ok(stdout: &str, bytes: usize, truncated: bool) -> RunOutcome {
    RunOutcome {
        status: RunStatus::Completed,
        exit_code: Some(0),
        error: None,
        stdout: RunStream {
            text: stdout.to_owned(),
            bytes,
            truncated,
            tail: None,
        },
        stderr: RunStream::default(),
    }
}

impl WorldReadPorts for Host {
    fn glob(&self, _pattern: &str, _limit: usize) -> Result<GlobHits, String> {
        Ok(GlobHits::default())
    }

    fn read_text(&self, _path: &str) -> Result<String, String> {
        Ok(String::new())
    }

    fn grep(
        &self,
        _pattern: &str,
        _glob: Option<&str>,
        _head_limit: usize,
    ) -> Result<GrepHits, String> {
        Ok(GrepHits::default())
    }

    fn run(&self, request: &RunRequest) -> Result<RunOutcome, String> {
        self.calls.lock().unwrap().push(request.clone());
        let mut git = self.git.lock().unwrap();
        Ok(if git.is_empty() {
            ok("", 0, false)
        } else {
            git.remove(0)
        })
    }
}

fn cwd() -> PathBuf {
    PathBuf::from("/ws/root")
}

/// Finding 1: a git text op whose output hit the inline limit must not be parsed as complete. The read fails with the
/// cap error, as the other capped reads do.
#[test]
fn git_output_that_hit_the_inline_limit_is_rejected_not_parsed_as_complete() {
    let host = Host::default();
    // First answer: the prefix call. Second: the status call, truncated at the inline limit.
    host.git.lock().unwrap().push(ok("\n", 1, false));
    host.git
        .lock()
        .unwrap()
        .push(ok("? a.md\0? b", caps::GIT_TEXT_OUTPUT_BYTES + 1, true));
    let error = execute_world_read(&cwd(), &host, "git-status", &[]).expect_err("truncated");
    assert_eq!(error.code, ErrorCode::WorldReadCapExceeded);
    assert!(error.message.contains("git status"), "{}", error.message);
}

/// Finding 1, the same rule for a path list: changed-files over the inline limit is refused.
#[test]
fn git_changed_files_over_the_inline_limit_is_refused() {
    let host = Host::default();
    host.git.lock().unwrap().push(ok("\n", 1, false));
    host.git
        .lock()
        .unwrap()
        .push(ok("a.md\0", caps::GIT_TEXT_OUTPUT_BYTES + 1, true));
    let error = execute_world_read(&cwd(), &host, "git-changed-files", &[json!("main")])
        .expect_err("truncated");
    assert_eq!(error.code, ErrorCode::WorldReadCapExceeded);
}

/// Finding 3: git runs carry the default 300 s timeout (Node's exec adapter default), not `None`.
#[test]
fn git_runs_carry_the_default_timeout() {
    let host = Host::default();
    execute_world_read(&cwd(), &host, "git-log", &[json!(1)]).unwrap();
    let calls = host.calls.lock().unwrap();
    assert_eq!(calls[0].timeout_ms, Some(caps::RUN_DEFAULT_TIMEOUT_MS));
}

/// Finding 2: a pathspec that starts with `:` is git pathspec magic (`:/x`, `:(top)x`, `:!x`) and can leave the
/// workspace even after `--`. It is refused before git runs.
#[test]
fn a_git_path_that_starts_with_a_colon_is_refused_before_git_runs() {
    let host = Host::default();
    for bad in [":/x", ":(top)x", ":!x", ":"] {
        let error = execute_world_read(&cwd(), &host, "git-diff", &[Value::Null, json!(bad)])
            .expect_err("pathspec magic is refused");
        assert_eq!(error.code, ErrorCode::DriverError, "{bad}");
        assert!(
            error.message.contains("starts with ':'"),
            "{}",
            error.message
        );
    }
    assert!(host.calls.lock().unwrap().is_empty());
}
