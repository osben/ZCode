//! World reads through a fake port (Node `workflow-driver-world-read-args.test.ts`, `workflow-driver-world-run.test.ts`
//! and the cap cases of `workflow-world-read.ts`).

use super::*;
use std::sync::Mutex;

/// A port that answers from canned values and records every call.
#[derive(Default)]
struct Fake {
    glob: Mutex<Option<Result<GlobHits, String>>>,
    grep: Mutex<Option<Result<GrepHits, String>>>,
    text: Mutex<Option<Result<String, String>>>,
    runs: Mutex<Vec<RunOutcome>>,
    run_calls: Mutex<Vec<RunRequest>>,
    git_calls: Mutex<Vec<Vec<String>>>,
    git_answers: Mutex<Vec<RunOutcome>>,
    glob_limit: Mutex<Option<usize>>,
    grep_limit: Mutex<Option<usize>>,
}

fn stream(text: &str) -> RunStream {
    RunStream {
        text: text.to_owned(),
        bytes: text.len(),
        truncated: false,
        tail: None,
    }
}

fn completed(stdout: &str) -> RunOutcome {
    RunOutcome {
        status: RunStatus::Completed,
        exit_code: Some(0),
        error: None,
        stdout: stream(stdout),
        stderr: RunStream::default(),
    }
}

impl WorldReadPorts for Fake {
    fn glob(&self, _pattern: &str, limit: usize) -> Result<GlobHits, String> {
        *self.glob_limit.lock().unwrap() = Some(limit);
        self.glob
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| Ok(GlobHits::default()))
    }

    fn read_text(&self, path: &str) -> Result<String, String> {
        let _ = path;
        self.text
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| Ok(String::new()))
    }

    fn grep(
        &self,
        _pattern: &str,
        _glob: Option<&str>,
        head_limit: usize,
    ) -> Result<GrepHits, String> {
        *self.grep_limit.lock().unwrap() = Some(head_limit);
        self.grep
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| Ok(GrepHits::default()))
    }

    fn run(&self, request: &RunRequest) -> Result<RunOutcome, String> {
        if request.file == "git" {
            self.git_calls.lock().unwrap().push(request.args.clone());
            let mut answers = self.git_answers.lock().unwrap();
            return Ok(if answers.is_empty() {
                completed("")
            } else {
                answers.remove(0)
            });
        }
        self.run_calls.lock().unwrap().push(request.clone());
        let mut runs = self.runs.lock().unwrap();
        Ok(if runs.is_empty() {
            completed("")
        } else {
            runs.remove(0)
        })
    }
}

fn cwd() -> PathBuf {
    PathBuf::from("/ws/root")
}

fn strings(values: &[&str]) -> Vec<Value> {
    values.iter().map(|v| json!(v)).collect()
}

fn run(fake: &Fake, op: &str, args: &[Value]) -> Result<Value, WorkflowError> {
    execute_world_read(&cwd(), fake, op, args)
}

fn message(result: Result<Value, WorkflowError>) -> String {
    result.expect_err("an error").message
}

// ——— Arity and types ———

#[test]
fn a_string_op_refuses_extra_and_missing_arguments_with_the_arity_message() {
    let fake = Fake::default();
    assert_eq!(
        message(run(&fake, "glob", &strings(&["a", "b"]))),
        "world-read glob takes 1 arguments (pattern), got 2."
    );
    assert_eq!(
        message(run(&fake, "read", &[])),
        "world-read read takes 1 arguments (path), got 0."
    );
}

#[test]
fn a_non_string_argument_is_refused_and_never_coerced() {
    let fake = Fake::default();
    assert_eq!(
        message(run(&fake, "read", &[json!(3)])),
        "world-read read: arg 1 (path) must be a string, got number."
    );
    assert_eq!(
        message(run(&fake, "glob", &[Value::Null])),
        "world-read glob: arg 1 (pattern) must be a string, got null."
    );
}

#[test]
fn an_optional_argument_may_be_absent_or_null_but_extra_arguments_are_refused() {
    let fake = Fake::default();
    let err = message(run(&fake, "grep", &strings(&["a", "b", "c"])));
    assert_eq!(
        err,
        "world-read grep takes 1~2 arguments (pattern, glob?), got 3."
    );
    // A null optional is the same as an absent one.
    assert!(run(&fake, "git-diff", &[Value::Null, json!("a.ts")]).is_ok());
}

#[test]
fn git_status_takes_no_arguments() {
    let fake = Fake::default();
    assert_eq!(
        message(run(&fake, "git-status", &strings(&["x"]))),
        "world-read git-status takes 0 arguments (), got 1."
    );
}

#[test]
fn git_log_count_must_be_an_integer_from_one_to_the_cap() {
    let fake = Fake::default();
    assert_eq!(
        message(run(&fake, "git-log", &[json!(0)])),
        "world-read git-log: argument 'count' must be an integer >= 1, got number."
    );
    assert_eq!(
        message(run(&fake, "git-log", &[json!(101)])),
        "world-read git-log: argument 'count'=101 is over the cap of 100; pass at most 100."
    );
    assert_eq!(
        message(run(&fake, "git-log", &[json!(1.5)])),
        "world-read git-log: argument 'count' must be an integer >= 1, got number."
    );
    // An integral float is an integer, as in Node.
    assert!(run(&fake, "git-log", &[json!(5.0)]).is_ok());
    assert!(run(&fake, "git-log", &[]).is_ok());
}

#[test]
fn an_unknown_op_is_a_driver_error() {
    let fake = Fake::default();
    let error = run(&fake, "nope", &[]).expect_err("unknown");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert_eq!(error.message, "Unsupported world-read op \"nope\".");
}

// ——— files.glob ———

#[test]
fn glob_is_workspace_relative_and_sorted_in_javascript_order() {
    let fake = Fake::default();
    *fake.glob.lock().unwrap() = Some(Ok(GlobHits {
        files: vec![
            "/ws/root/b.md".to_owned(),
            "/ws/root/sub/a.md".to_owned(),
            "/ws/root/\u{1F600}.md".to_owned(),
            "/ws/root/\u{FF5E}.md".to_owned(),
        ],
        total: 4,
    }));
    let value = run(&fake, "glob", &strings(&["**/*.md"])).unwrap();
    assert_eq!(
        value,
        // UTF-16 order: "b.md" < "sub/a.md" < U+1F600 (lead unit 0xD83D) < U+FF5E.
        json!(["b.md", "sub/a.md", "\u{1F600}.md", "\u{FF5E}.md"])
    );
    assert_eq!(*fake.glob_limit.lock().unwrap(), Some(2001));
}

#[test]
fn glob_exactly_at_the_cap_is_allowed_and_one_over_is_rejected() {
    let fake = Fake::default();
    let files: Vec<String> = (0..2000).map(|i| format!("/ws/root/f{i}.md")).collect();
    *fake.glob.lock().unwrap() = Some(Ok(GlobHits {
        files: files.clone(),
        total: 2000,
    }));
    assert_eq!(
        run(&fake, "glob", &strings(&["*"]))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2000
    );

    let over = Fake::default();
    *over.glob.lock().unwrap() = Some(Ok(GlobHits {
        files: files.into_iter().take(2000).collect(),
        total: 2001,
    }));
    let error = run(&over, "glob", &strings(&["*"])).expect_err("over the cap");
    assert_eq!(error.code, ErrorCode::WorldReadCapExceeded);
    assert_eq!(
        error.message,
        "files.glob: over 2000 files match (the cap). Narrow the pattern."
    );
}

// ——— files.read ———

#[test]
fn read_returns_the_text_of_a_path_inside_the_workspace() {
    let fake = Fake::default();
    *fake.text.lock().unwrap() = Some(Ok("hello".to_owned()));
    assert_eq!(
        run(&fake, "read", &strings(&["src/a.ts"])).unwrap(),
        json!("hello")
    );
}

#[test]
fn read_refuses_a_path_that_leaves_the_workspace_lexically() {
    let fake = Fake::default();
    let error = run(&fake, "read", &strings(&["../secret"])).expect_err("outside");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert_eq!(
        error.message,
        "world-read read: path '../secret' is outside the workspace; pass a path inside it."
    );
    assert!(run(&fake, "read", &strings(&["/etc/passwd"])).is_err());
    // A name that begins with dots is a file name, not a parent segment.
    assert!(run(&fake, "read", &strings(&["..foo"])).is_ok());
}

// ——— files.grep ———

#[test]
fn grep_drops_entries_without_a_line_or_text_and_keeps_node_key_order() {
    let fake = Fake::default();
    *fake.grep.lock().unwrap() = Some(Ok(GrepHits {
        entries: vec![
            GrepEntry {
                path: "/ws/root/a.ts".to_owned(),
                line: Some(3),
                text: Some("TODO x".to_owned()),
            },
            GrepEntry {
                path: "/ws/root/b.ts".to_owned(),
                line: None,
                text: None,
            },
        ],
        truncated: false,
    }));
    let value = run(&fake, "grep", &strings(&["TODO"])).unwrap();
    assert_eq!(
        value,
        json!([{"path": "a.ts", "line": 3, "text": "TODO x"}])
    );
    assert_eq!(
        stringify(&value),
        "[{\"path\":\"a.ts\",\"line\":3,\"text\":\"TODO x\"}]"
    );
    assert_eq!(*fake.grep_limit.lock().unwrap(), Some(2001));
}

#[test]
fn grep_rejects_over_the_match_cap_and_over_the_serialized_byte_cap() {
    let fake = Fake::default();
    let entries: Vec<GrepEntry> = (0..2001)
        .map(|i| GrepEntry {
            path: format!("/ws/root/f{i}.ts"),
            line: Some(1),
            text: Some("x".to_owned()),
        })
        .collect();
    *fake.grep.lock().unwrap() = Some(Ok(GrepHits {
        entries,
        truncated: false,
    }));
    let error = run(&fake, "grep", &strings(&["x"])).expect_err("over");
    assert_eq!(error.code, ErrorCode::WorldReadCapExceeded);
    assert_eq!(
        error.message,
        "files.grep: over 2000 matches (the cap). Narrow the pattern or add a glob."
    );

    let big = Fake::default();
    let long = "y".repeat(300 * 1024);
    *big.grep.lock().unwrap() = Some(Ok(GrepHits {
        entries: vec![GrepEntry {
            path: "/ws/root/a.ts".to_owned(),
            line: Some(1),
            text: Some(long),
        }],
        truncated: false,
    }));
    let error = run(&big, "grep", &strings(&["y"])).expect_err("bytes");
    assert_eq!(error.code, ErrorCode::WorldReadCapExceeded);
    assert!(error.message.starts_with("files.grep: result is "));
}

// ——— git.* ———

fn git_outcome(status: RunStatus, exit: Option<i32>, stdout: &str, stderr: &str) -> RunOutcome {
    RunOutcome {
        status,
        exit_code: exit,
        error: None,
        stdout: stream(stdout),
        stderr: stream(stderr),
    }
}

#[test]
fn changed_files_without_a_base_unions_the_tracked_and_untracked_lists_sorted_and_unique() {
    let fake = Fake::default();
    fake.git_answers.lock().unwrap().extend([
        completed("sub/\n"),
        completed("sub/b.md\0sub/a.md\0"),
        completed("sub/a.md\0sub/new.md\0"),
    ]);
    let value = run(&fake, "git-changed-files", &[]).unwrap();
    assert_eq!(value, json!(["a.md", "b.md", "new.md"]));
    let calls = fake.git_calls.lock().unwrap();
    assert_eq!(calls[0], vec!["rev-parse", "--show-prefix"]);
    assert_eq!(calls[1][0..3], ["diff", "--name-only", "-z"]);
}

#[test]
fn a_failing_git_command_is_a_catchable_driver_error_with_its_first_stderr_line() {
    let fake = Fake::default();
    fake.git_answers.lock().unwrap().push(git_outcome(
        RunStatus::Failed,
        Some(128),
        "",
        "fatal: not a git repository\nmore",
    ));
    let error = run(&fake, "git-status", &[]).expect_err("not a repository");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert_eq!(
        error.message,
        "git rev-parse --show-prefix failed (failed, exit=128): fatal: not a git repository"
    );
}

#[test]
fn git_diff_rejects_output_over_the_cap_and_asks_for_a_path() {
    let fake = Fake::default();
    let big = RunOutcome {
        status: RunStatus::Completed,
        exit_code: Some(0),
        error: None,
        stdout: RunStream {
            text: String::new(),
            bytes: caps::GIT_DIFF_MAX_BYTES + 1,
            truncated: true,
            tail: None,
        },
        stderr: RunStream::default(),
    };
    fake.git_answers.lock().unwrap().push(big);
    let error = run(&fake, "git-diff", &[]).expect_err("over the cap");
    assert_eq!(error.code, ErrorCode::WorldReadCapExceeded);
    assert!(error.message.ends_with("Pass a path to narrow."));
}

#[test]
fn git_diff_refuses_a_path_that_starts_with_a_dash_before_running_git() {
    let fake = Fake::default();
    let error = run(&fake, "git-diff", &[Value::Null, json!("-x")]).expect_err("dash");
    assert!(error.message.contains("starts with '-'"));
    assert!(fake.git_calls.lock().unwrap().is_empty());
}

#[test]
fn git_status_is_parsed_with_the_show_prefix() {
    let fake = Fake::default();
    fake.git_answers.lock().unwrap().extend([
        completed("sub/\n"),
        completed("# branch.head main\0? sub/x.md\0"),
    ]);
    let value = run(&fake, "git-status", &[]).unwrap();
    assert_eq!(
        value,
        json!({"branch": "main", "clean": false, "staged": [], "unstaged": [], "untracked": ["x.md"]})
    );
}

#[test]
fn git_log_returns_commits_in_order() {
    let fake = Fake::default();
    fake.git_answers
        .lock()
        .unwrap()
        .push(completed("h1\0first\0Ann\u{0}2024-01-01T00:00:00Z\n"));
    let value = run(&fake, "git-log", &[json!(1)]).unwrap();
    assert_eq!(
        value,
        json!([{"hash": "h1", "subject": "first", "author": "Ann", "date": "2024-01-01T00:00:00Z"}])
    );
    assert_eq!(
        fake.git_calls.lock().unwrap()[0],
        vec!["log", "-n1", crate::world_git::GIT_LOG_PRETTY]
    );
}

// ——— world.run ———

#[test]
fn run_argument_shapes_are_checked_with_node_messages() {
    let fake = Fake::default();
    assert_eq!(
        message(run(&fake, "run", &[])),
        "world.run takes 1 to 3 arguments (cmd, args?, opts?), got 0."
    );
    assert_eq!(
        message(run(&fake, "run", &[json!("ls"), json!("x")])),
        "world.run: argument 2 (args) must be an array of strings, got string."
    );
    assert_eq!(
        message(run(&fake, "run", &[json!("ls"), json!([1])])),
        "world.run: args[0] must be a string, got number. Stringify values."
    );
    assert_eq!(
        message(run(&fake, "run", &[json!("ls"), json!([]), json!([])])),
        "world.run: arg 3 (opts) must be an options object or omitted, got array."
    );
    assert_eq!(
        message(run(
            &fake,
            "run",
            &[json!("ls"), json!([]), json!({"timeoutMs": 0})]
        )),
        "world.run: opts.timeoutMs must be an integer >= 1, got number."
    );
}

#[test]
fn run_output_modes_are_validated_and_the_shape_error_previews_the_value() {
    let fake = Fake::default();
    let error = message(run(
        &fake,
        "run",
        &[json!("ls"), json!([]), json!({"output": {"tail": 0}})],
    ));
    assert_eq!(
        error,
        "world.run: opts.output must be \"full\", \"discard\", or { tail: n } with n an integer from 1 to \
         16777216; got {\"tail\":0}."
    );
    let long = json!({"output": {"tail": 1, "extra": "x".repeat(100)}});
    let error = message(run(&fake, "run", &[json!("ls"), json!([]), long]));
    assert!(
        error.ends_with("…."),
        "a long value is cut at 80 characters: {error}"
    );
}

#[test]
fn a_completed_run_returns_exit_code_and_both_streams() {
    let fake = Fake::default();
    fake.runs.lock().unwrap().push(RunOutcome {
        status: RunStatus::Completed,
        exit_code: Some(0),
        error: None,
        stdout: stream("out"),
        stderr: stream("err"),
    });
    let value = run(&fake, "run", &[json!("ls"), json!(["-l"])]).unwrap();
    assert_eq!(
        value,
        json!({"exitCode": 0, "stdout": "out", "stderr": "err"})
    );
    let calls = fake.run_calls.lock().unwrap();
    assert_eq!(calls[0].timeout_ms, Some(300_000));
    assert_eq!(calls[0].max_inline_bytes, 16 * 1024 * 1024 + 1);
    assert_eq!(calls[0].args, vec!["-l"]);
}

#[test]
fn a_nonzero_exit_is_a_value_not_an_error() {
    let fake = Fake::default();
    fake.runs.lock().unwrap().push(RunOutcome {
        status: RunStatus::Failed,
        exit_code: Some(2),
        error: None,
        stdout: stream("partial"),
        stderr: stream(""),
    });
    let value = run(&fake, "run", &[json!("grep")]).unwrap();
    assert_eq!(
        value,
        json!({"exitCode": 2, "stdout": "partial", "stderr": ""})
    );
}

#[test]
fn a_timeout_and_a_spawn_error_and_a_run_with_an_error_are_driver_errors() {
    let fake = Fake::default();
    fake.runs.lock().unwrap().push(RunOutcome {
        status: RunStatus::TimedOut,
        exit_code: None,
        error: None,
        stdout: RunStream::default(),
        stderr: RunStream::default(),
    });
    assert_eq!(
        message(run(
            &fake,
            "run",
            &[json!("sleep"), json!([]), json!({"timeoutMs": 5})]
        )),
        "world.run 'sleep' timed out after 5ms. Raise opts.timeoutMs or narrow the work."
    );

    let spawn = Fake::default();
    spawn.runs.lock().unwrap().push(RunOutcome {
        status: RunStatus::SpawnError,
        exit_code: None,
        error: Some("no such file".to_owned()),
        stdout: RunStream::default(),
        stderr: RunStream::default(),
    });
    assert_eq!(
        message(run(&spawn, "run", &[json!("nope")])),
        "world.run 'nope' did not run to completion (spawn_error): no such file"
    );
}

#[test]
fn full_output_over_the_stream_cap_is_rejected_not_truncated() {
    let fake = Fake::default();
    fake.runs.lock().unwrap().push(RunOutcome {
        status: RunStatus::Completed,
        exit_code: Some(0),
        error: None,
        stdout: RunStream {
            text: String::new(),
            bytes: 16 * 1024 * 1024 + 1,
            truncated: true,
            tail: None,
        },
        stderr: RunStream::default(),
    });
    let error = run(&fake, "run", &[json!("cat")]).expect_err("over the cap");
    assert_eq!(error.code, ErrorCode::WorldReadCapExceeded);
    assert!(error.message.contains("over the 16777216-byte cap"));
}

#[test]
fn discard_sends_no_inline_bytes_and_returns_empty_streams() {
    let fake = Fake::default();
    fake.runs.lock().unwrap().push(RunOutcome {
        status: RunStatus::Completed,
        exit_code: Some(0),
        error: None,
        stdout: RunStream {
            text: String::new(),
            bytes: 999,
            truncated: true,
            tail: None,
        },
        stderr: RunStream::default(),
    });
    let value = run(
        &fake,
        "run",
        &[json!("ls"), json!([]), json!({"output": "discard"})],
    )
    .unwrap();
    assert_eq!(value, json!({"exitCode": 0, "stdout": "", "stderr": ""}));
    assert_eq!(fake.run_calls.lock().unwrap()[0].max_inline_bytes, 0);
}

#[test]
fn tail_returns_the_port_tail_and_a_missing_tail_is_a_driver_error() {
    let fake = Fake::default();
    fake.runs.lock().unwrap().push(RunOutcome {
        status: RunStatus::Completed,
        exit_code: Some(0),
        error: None,
        stdout: RunStream {
            text: String::new(),
            bytes: 100,
            truncated: true,
            tail: Some("end".to_owned()),
        },
        stderr: RunStream {
            text: String::new(),
            bytes: 0,
            truncated: false,
            tail: Some(String::new()),
        },
    });
    let value = run(
        &fake,
        "run",
        &[json!("ls"), json!([]), json!({"output": {"tail": 3}})],
    )
    .unwrap();
    assert_eq!(value, json!({"exitCode": 0, "stdout": "end", "stderr": ""}));
    assert_eq!(fake.run_calls.lock().unwrap()[0].tail_bytes, Some(3));

    let missing = Fake::default();
    missing.runs.lock().unwrap().push(completed("x"));
    let error = run(
        &missing,
        "run",
        &[json!("ls"), json!([]), json!({"output": {"tail": 3}})],
    )
    .expect_err("no tail");
    assert!(error.message.contains("returned no output tail"));
}

#[test]
fn a_port_fault_becomes_a_driver_error_with_its_message() {
    let fake = Fake::default();
    *fake.text.lock().unwrap() = Some(Err("disk gone".to_owned()));
    let error = run(&fake, "read", &strings(&["a.md"])).expect_err("fault");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert_eq!(error.message, "disk gone");
}

#[test]
fn resolve_and_relativize_follow_the_lexical_rule() {
    let root = Path::new("/ws/root");
    assert_eq!(
        resolve_within_workspace(root, "a/../b"),
        Some(PathBuf::from("/ws/root/b"))
    );
    assert_eq!(resolve_within_workspace(root, "../x"), None);
    assert_eq!(resolve_within_workspace(root, "/ws/other"), None);
    assert_eq!(to_workspace_relative(root, "/ws/root/a/b.md"), "a/b.md");
    assert_eq!(to_workspace_relative(root, "rel/x.md"), "rel/x.md");
}
