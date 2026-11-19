//! The Node cases of `workflow-driver-world-read-args.test.ts` and `workflow-driver-world-run.test.ts` that the existing
//! Rust tests do not state directly. Each test names the Node case it ports. The mapping table is in spec 9.11.

use crate::error::ErrorCode;
use crate::world_read::{
    GlobHits, GrepHits, RunOutcome, RunRequest, RunStatus, RunStream, WorldReadPorts, caps,
    execute_world_read,
};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Mutex;

/// Records every `run` request and answers with a canned outcome.
#[derive(Default)]
struct Run {
    answers: Mutex<Vec<RunOutcome>>,
    calls: Mutex<Vec<RunRequest>>,
}

fn stream(text: &str, bytes: usize) -> RunStream {
    RunStream {
        text: text.to_owned(),
        bytes,
        truncated: false,
        tail: None,
    }
}

fn outcome(stdout: RunStream, stderr: RunStream) -> RunOutcome {
    RunOutcome {
        status: RunStatus::Completed,
        exit_code: Some(0),
        error: None,
        stdout,
        stderr,
    }
}

impl WorldReadPorts for Run {
    fn glob(&self, _pattern: &str, _limit: usize) -> Result<GlobHits, String> {
        Ok(GlobHits {
            files: vec!["/workspace/root/a.ts".to_owned()],
            total: 1,
        })
    }

    fn read_text(&self, _path: &str) -> Result<String, String> {
        Ok("body".to_owned())
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
        let mut answers = self.answers.lock().unwrap();
        Ok(if answers.is_empty() {
            outcome(stream("", 0), stream("", 0))
        } else {
            answers.remove(0)
        })
    }
}

fn cwd() -> PathBuf {
    PathBuf::from("/workspace/root")
}

fn run(port: &Run, args: &[Value]) -> Result<Value, crate::error::WorkflowError> {
    execute_world_read(&cwd(), port, "run", args)
}

fn message(result: Result<Value, crate::error::WorkflowError>) -> String {
    result.expect_err("an error").message
}

// ——— workflow-driver-world-read-args.test.ts ———

/// "passes well-formed positional args through to the fs port" (glob and read through the port).
#[test]
fn args_case_well_formed_glob_and_read_reach_the_port_and_return_its_values() {
    let port = Run::default();
    let glob = execute_world_read(&cwd(), &port, "glob", &[json!("src/**")]).unwrap();
    assert_eq!(glob, json!(["a.ts"]));
    let read = execute_world_read(&cwd(), &port, "read", &[json!("a.ts")]).unwrap();
    assert_eq!(read, json!("body"));
}

/// "rejects a wrong-typed argument": glob with a number, with undefined (JSON null), and with an array.
#[test]
fn args_case_wrong_typed_glob_arguments_are_driver_errors_including_an_array() {
    let port = Run::default();
    for bad in [json!(42), Value::Null, json!(["src/**"])] {
        let error = execute_world_read(&cwd(), &port, "glob", &[bad]).expect_err("refused");
        assert_eq!(error.code, ErrorCode::DriverError);
    }
}

// ——— workflow-driver-world-run.test.ts ———

/// "passes argv, cwd, default 300s timeout and cap+1 output limit to the port": the request carries the workspace cwd.
#[test]
fn run_case_the_request_carries_the_workspace_cwd() {
    let port = Run::default();
    run(&port, &[json!("lean"), json!(["--make", "a.lean"])]).unwrap();
    let calls = port.calls.lock().unwrap();
    assert_eq!(calls[0].cwd, cwd());
    assert_eq!(calls[0].timeout_ms, Some(caps::RUN_DEFAULT_TIMEOUT_MS));
    assert_eq!(calls[0].max_inline_bytes, caps::RUN_STREAM_MAX_BYTES + 1);
    assert_eq!(calls[0].tail_bytes, None);
}

/// "honours opts.timeoutMs with no upper clamp (long-running tests are in-contract)".
#[test]
fn run_case_a_timeout_is_not_clamped() {
    let port = Run::default();
    run(
        &port,
        &[
            json!("lake"),
            json!(["build"]),
            json!({"timeoutMs": 3_600_000}),
        ],
    )
    .unwrap();
    assert_eq!(port.calls.lock().unwrap()[0].timeout_ms, Some(3_600_000));
}

/// "rejects a timeout as a catchable DriverError naming the wall clock": the default timeout is in the message.
#[test]
fn run_case_default_timeout_message_names_three_hundred_thousand_ms() {
    let port = Run::default();
    port.answers.lock().unwrap().push(RunOutcome {
        status: RunStatus::TimedOut,
        exit_code: None,
        error: None,
        stdout: stream("", 0),
        stderr: stream("", 0),
    });
    let error = message(run(&port, &[json!("lake"), json!(["build"])]));
    assert!(error.contains("300000ms"), "{error}");
}

/// "runs whatever command the compiled script hands it: there is no runtime allowlist".
#[test]
fn run_case_a_command_that_was_never_declared_runs() {
    let port = Run::default();
    let value = run(&port, &[json!("echo"), json!(["hi"])]).unwrap();
    assert_eq!(value["exitCode"], 0);
    assert_eq!(port.calls.lock().unwrap()[0].file, "echo");
}

/// "accepts exactly cap bytes in full mode (the +1 probe tells 'exactly' from 'over')".
#[test]
fn run_case_exactly_cap_bytes_of_stdout_is_allowed() {
    let port = Run::default();
    port.answers.lock().unwrap().push(outcome(
        stream("x", caps::RUN_STREAM_MAX_BYTES),
        stream("", 0),
    ));
    let value = run(&port, &[json!("node"), json!([])]).unwrap();
    assert_eq!(value["stdout"], "x");
}

/// "rejects stdout over the 16 MiB cap with actionable guidance (cap+1 probe)": the message names the tail option.
#[test]
fn run_case_over_cap_stdout_message_points_to_the_tail_option() {
    let port = Run::default();
    port.answers.lock().unwrap().push(outcome(
        stream("x", caps::RUN_STREAM_MAX_BYTES + 1),
        stream("", 0),
    ));
    let error = run(&port, &[json!("node"), json!(["-e", "spam"])]).expect_err("over the cap");
    assert_eq!(error.code, ErrorCode::WorldReadCapExceeded);
    assert!(error.message.contains("stdout"), "{}", error.message);
    assert!(
        error.message.contains("opts.output: { tail: n }"),
        "{}",
        error.message
    );
}

/// "rejects stderr over the cap the same way" (stderr flagged truncated).
#[test]
fn run_case_stderr_over_cap_is_a_cap_error_naming_stderr() {
    let port = Run::default();
    port.answers.lock().unwrap().push(outcome(
        stream("", 0),
        RunStream {
            text: "y".to_owned(),
            bytes: 1,
            truncated: true,
            tail: None,
        },
    ));
    let error = run(&port, &[json!("node"), json!([])]).expect_err("stderr over");
    assert_eq!(error.code, ErrorCode::WorldReadCapExceeded);
    assert!(error.message.contains("stderr"), "{}", error.message);
}

/// "validates argument shapes loudly, never coercing": every bad shape is refused and the port is never called.
#[test]
fn run_case_bad_argument_shapes_are_refused_and_nothing_runs() {
    let port = Run::default();
    let cases: Vec<Vec<Value>> = vec![
        vec![],
        vec![json!(42)],
        vec![json!("lean"), json!("not-an-array")],
        vec![json!("lean"), json!([1])],
        vec![json!("lean"), json!([]), json!("not-opts")],
        vec![json!("lean"), json!([]), json!({"timeoutMs": 0})],
        vec![json!("lean"), json!([]), json!({"timeoutMs": 1.5})],
        vec![json!("lean"), json!([]), json!({}), json!("extra")],
    ];
    for args in &cases {
        let error = run(&port, args).expect_err("refused");
        assert_eq!(error.code, ErrorCode::DriverError, "{args:?}");
    }
    assert!(port.calls.lock().unwrap().is_empty());
}

// ——— world.run output modes ———

/// "explicit output 'full' sends the same request as the default".
#[test]
fn run_output_case_explicit_full_equals_the_default_request() {
    let port = Run::default();
    run(
        &port,
        &[json!("lean"), json!([]), json!({"output": "full"})],
    )
    .unwrap();
    let calls = port.calls.lock().unwrap();
    assert_eq!(calls[0].max_inline_bytes, caps::RUN_STREAM_MAX_BYTES + 1);
    assert_eq!(calls[0].tail_bytes, None);
}

/// "discard still returns a nonzero exit as a value".
#[test]
fn run_output_case_discard_returns_a_nonzero_exit_as_a_value() {
    let port = Run::default();
    port.answers.lock().unwrap().push(RunOutcome {
        status: RunStatus::Failed,
        exit_code: Some(1),
        error: None,
        stdout: stream("", 10),
        stderr: stream("", 10),
    });
    let value = run(
        &port,
        &[json!("pnpm"), json!(["test"]), json!({"output": "discard"})],
    )
    .unwrap();
    assert_eq!(value, json!({"exitCode": 1, "stdout": "", "stderr": ""}));
}

/// "tail accepts n at both bounds (1 and the cap)".
#[test]
fn run_output_case_tail_accepts_one_and_the_cap() {
    let port = Run::default();
    // The port must answer with a tail for a tail request (the Node test's `huge("x")`).
    let with_tail = || RunStream {
        text: String::new(),
        bytes: 100,
        truncated: true,
        tail: Some("x".to_owned()),
    };
    port.answers.lock().unwrap().extend([
        outcome(with_tail(), with_tail()),
        outcome(with_tail(), with_tail()),
    ]);
    run(
        &port,
        &[json!("node"), json!([]), json!({"output": {"tail": 1}})],
    )
    .unwrap();
    run(
        &port,
        &[
            json!("node"),
            json!([]),
            json!({"output": {"tail": caps::RUN_STREAM_MAX_BYTES}}),
        ],
    )
    .unwrap();
    let tails: Vec<Option<usize>> = port
        .calls
        .lock()
        .unwrap()
        .iter()
        .map(|c| c.tail_bytes)
        .collect();
    assert_eq!(tails, vec![Some(1), Some(caps::RUN_STREAM_MAX_BYTES)]);
}

/// "rejects bad output shapes with an actionable DriverError before running anything".
#[test]
fn run_output_case_bad_output_shapes_are_refused_before_running() {
    let port = Run::default();
    let shapes = [
        json!("quiet"),
        Value::Null,
        json!([]),
        json!({}),
        json!({"tail": 0}),
        json!({"tail": -1}),
        json!({"tail": 1.5}),
        json!({"tail": "64"}),
        json!({"tail": caps::RUN_STREAM_MAX_BYTES + 1}),
        json!({"tail": 64, "head": 64}),
    ];
    for shape in shapes {
        let error = run(
            &port,
            &[json!("lean"), json!([]), json!({"output": shape.clone()})],
        )
        .expect_err("refused");
        assert_eq!(error.code, ErrorCode::DriverError, "{shape}");
        assert!(error.message.contains("opts.output"), "{}", error.message);
    }
    assert!(port.calls.lock().unwrap().is_empty());
}
