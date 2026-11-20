//! Execution side of world reads (Node `workflow-world-read.ts`, `executeWorldRead`).
//!
//! The driver turns an `(op, args)` pair into one observation of the workspace. This module does three things:
//! 1. validates each op's arguments by position and fails loudly with a `DriverError` (never coerces);
//! 2. enforces the caps in [`caps`], rejecting over-cap output instead of truncating it;
//! 3. runs the read through [`WorldReadPorts`], the port the host supplies.
//!
//! Git argv and parsing are in [`crate::world_git`]. This module never touches the journal or a session.

// WorkflowError is the engine's error type (Node WorkflowError): its Err path is cold, and boxing it would split the type.
#![allow(clippy::result_large_err)]

use crate::error::{ErrorCode, WorkflowError};
use crate::world_git::{
    GIT_SHOW_PREFIX_ARGV, GIT_STATUS_ARGV, git_changed_files_plans, git_diff_argv, git_log_argv,
    js_cmp, parse_git_log, parse_git_path_list, parse_git_show_prefix,
    parse_git_status_porcelain_v2,
};
use rust_cli_base::js::json::stringify;
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// The caps of Node's `WORLD_READ_CAPS`. Every limit is named here; nothing is clamped silently.
pub mod caps {
    pub const GLOB_MAX_FILES: usize = 2000;
    pub const GREP_MAX_MATCHES: usize = 2000;
    pub const GREP_MAX_SERIALIZED_BYTES: usize = 256 * 1024;
    pub const GIT_DIFF_MAX_BYTES: usize = 512 * 1024;
    pub const GIT_LOG_MAX_COUNT: u64 = 100;
    pub const GIT_LOG_DEFAULT_COUNT: u64 = 20;
    pub const RUN_STREAM_MAX_BYTES: usize = 16 * 1024 * 1024;
    pub const RUN_DEFAULT_TIMEOUT_MS: u64 = 300_000;
    /// Inline limit for git text output (path lists, status, log). Not a spec cap.
    pub const GIT_TEXT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
}

/// A `world.run` request for the port. `max_inline_bytes` and `tail_bytes` are the output limit of the port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRequest {
    /// The workspace root the command runs in (Node `cwd: deps.cwd`).
    pub cwd: PathBuf,
    pub file: String,
    pub args: Vec<String>,
    /// The timeout in milliseconds. `None` means the port applies its own default; the git reads always pass
    /// `caps::RUN_DEFAULT_TIMEOUT_MS`, and `world.run` passes the timeout the script asked for.
    pub timeout_ms: Option<u64>,
    pub max_inline_bytes: usize,
    pub tail_bytes: Option<usize>,
}

/// How a run ended, as the port reports it (Node's `ExecutionResult.status`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunStatus {
    Completed,
    /// A nonzero exit when `error` is `None`; a failure with an error otherwise.
    Failed,
    TimedOut,
    Cancelled,
    SpawnError,
}

/// One output stream. `text` holds the inline text, `bytes` the full size, `truncated` whether the inline limit was
/// hit, and `tail` the last `tail_bytes` when the request asked for a tail.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunStream {
    pub text: String,
    pub bytes: usize,
    pub truncated: bool,
    pub tail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutcome {
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    /// The error message of a failure that is not a nonzero exit.
    pub error: Option<String>,
    pub stdout: RunStream,
    pub stderr: RunStream,
}

/// The files a glob matched: `files` are the absolute paths the port returned (at most the limit asked for) and
/// `total` is the full count of matches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GlobHits {
    pub files: Vec<String>,
    pub total: usize,
}

/// One content match from a search: `line` and `text` are `None` for an entry that is not a content match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrepEntry {
    pub path: String,
    pub line: Option<u64>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GrepHits {
    pub entries: Vec<GrepEntry>,
    pub truncated: bool,
}

/// The host's side of a world read. Every method is blocking and runs on a worker thread, never on the owner.
/// An `Err` is a port fault: the read fails with a `DriverError` carrying the message.
pub trait WorldReadPorts: Send + Sync {
    /// Files matching `pattern` under the workspace, up to `limit` of them. Paths are absolute.
    fn glob(&self, pattern: &str, limit: usize) -> Result<GlobHits, String>;
    /// The text of an absolute path inside the workspace.
    fn read_text(&self, path: &str) -> Result<String, String>;
    /// Content matches of `pattern` (optionally filtered by `glob`), up to `head_limit` entries.
    fn grep(
        &self,
        pattern: &str,
        glob: Option<&str>,
        head_limit: usize,
    ) -> Result<GrepHits, String>;
    /// Run a fixed argv in the workspace. A run that could not start is `Ok` with `RunStatus::SpawnError`.
    fn run(&self, request: &RunRequest) -> Result<RunOutcome, String>;
}

/// The read ports of one workspace root. A snippet's reads are rooted at its session's directory, as Node roots a snippet
/// at its cwd (specs/fork-rust-workflow-engine.md, 9.41, divergence 313), so the ports are made per call, not once per
/// process.
pub trait WorldReadRoots: Send + Sync {
    /// The ports for `root`. `glob` and `grep` search under `root`. `files.read` reaches `read_text` with an absolute path
    /// that the engine has already confined to the cwd it was given, so the port does not check containment itself. `run`
    /// takes its cwd per request, so it is not rooted here.
    fn at(&self, root: &Path) -> Arc<dyn WorldReadPorts>;
}

/// Execute one world read or run. `cwd` is the workspace root (the base of every relative path).
pub fn execute_world_read(
    cwd: &Path,
    ports: &dyn WorldReadPorts,
    op: &str,
    args: &[Value],
) -> Result<Value, WorkflowError> {
    match op {
        "glob" => {
            let pattern = string_args(op, args, &["pattern"])?.remove(0);
            world_glob(cwd, ports, &pattern)
        }
        "read" => {
            let arg = string_args(op, args, &["path"])?.remove(0);
            world_read(cwd, ports, &arg)
        }
        "grep" => {
            let mut out = optional_string_args(op, args, &["pattern"], &["glob"])?;
            let glob = out.pop().flatten();
            let pattern = out.remove(0).unwrap_or_default();
            world_grep(cwd, ports, &pattern, glob.as_deref())
        }
        "git-changed-files" => {
            let mut out = optional_string_args(op, args, &[], &["base"])?;
            git_changed_files(cwd, ports, out.remove(0).as_deref())
        }
        "git-diff" => {
            let mut out = optional_string_args(op, args, &[], &["base", "path"])?;
            let path = out.pop().flatten();
            let base = out.remove(0);
            git_diff(cwd, ports, base.as_deref(), path.as_deref())
        }
        "git-status" => {
            string_args(op, args, &[])?;
            git_status(cwd, ports)
        }
        "git-log" => {
            let count = optional_count(op, args, "count")?;
            git_log(cwd, ports, count)
        }
        "run" => world_run(cwd, ports, args),
        other => Err(driver_error(format!(
            "Unsupported world-read op \"{other}\"."
        ))),
    }
}

// ——————————————————————————————— Argument validation ———————————————————————————————

fn driver_error(message: impl Into<String>) -> WorkflowError {
    WorkflowError::new(ErrorCode::DriverError, message)
}

fn cap_exceeded(message: impl Into<String>) -> WorkflowError {
    WorkflowError::new(ErrorCode::WorldReadCapExceeded, message)
}

/// Node `describeArg`: a short shape for error messages.
pub fn describe_arg(value: Option<&Value>) -> &'static str {
    match value {
        None | Some(Value::Null) => "null",
        Some(Value::Array(_)) => "array",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Object(_)) => "object",
    }
}

/// Node `Number.isInteger` on a JSON number: a finite number with no fraction.
fn js_integer(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0).then_some(number)
}

fn require_string(
    op: &str,
    value: &Value,
    name: &str,
    index: usize,
) -> Result<String, WorkflowError> {
    match value {
        Value::String(text) => Ok(text.clone()),
        other => Err(driver_error(format!(
            "world-read {op}: arg {} ({name}) must be a string, got {}.",
            index + 1,
            describe_arg(Some(other))
        ))),
    }
}

/// Exact arity: each name is a required string.
fn string_args(op: &str, args: &[Value], names: &[&str]) -> Result<Vec<String>, WorkflowError> {
    if args.len() != names.len() {
        return Err(driver_error(format!(
            "world-read {op} takes {} arguments ({}), got {}.",
            names.len(),
            names.join(", "),
            args.len()
        )));
    }
    names
        .iter()
        .enumerate()
        .map(|(index, name)| require_string(op, &args[index], name, index))
        .collect()
}

/// Trailing-optional strings. An absent or `null` optional position is `None`; extra arguments are refused.
fn optional_string_args(
    op: &str,
    args: &[Value],
    required: &[&str],
    optional: &[&str],
) -> Result<Vec<Option<String>>, WorkflowError> {
    let max = required.len() + optional.len();
    if args.len() < required.len() || args.len() > max {
        let range = if required.len() == max {
            max.to_string()
        } else {
            format!("{}~{max}", required.len())
        };
        let mut names: Vec<String> = required.iter().map(|n| (*n).to_owned()).collect();
        names.extend(optional.iter().map(|n| format!("{n}?")));
        return Err(driver_error(format!(
            "world-read {op} takes {range} arguments ({}), got {}.",
            names.join(", "),
            args.len()
        )));
    }
    let mut out = Vec::with_capacity(max);
    for (index, name) in required.iter().enumerate() {
        out.push(Some(require_string(op, &args[index], name, index)?));
    }
    for (offset, name) in optional.iter().enumerate() {
        let index = required.len() + offset;
        match args.get(index) {
            None | Some(Value::Null) => out.push(None),
            Some(value) => out.push(Some(require_string(op, value, name, index)?)),
        }
    }
    Ok(out)
}

/// `git.log(count?)`: an integer from 1 to the cap. A larger value is refused, not clamped.
fn optional_count(op: &str, args: &[Value], name: &str) -> Result<u64, WorkflowError> {
    if args.len() > 1 {
        return Err(driver_error(format!(
            "world-read {op} takes at most 1 argument ({name}?), got {}.",
            args.len()
        )));
    }
    let max = caps::GIT_LOG_MAX_COUNT;
    let raw = match args.first() {
        None => return Ok(caps::GIT_LOG_DEFAULT_COUNT),
        Some(value) => value,
    };
    let number = match js_integer(raw) {
        Some(number) if number >= 1.0 => number,
        _ => {
            return Err(driver_error(format!(
                "world-read {op}: argument '{name}' must be an integer >= 1, got {}.",
                describe_arg(Some(raw))
            )));
        }
    };
    if number > max as f64 {
        return Err(driver_error(format!(
            "world-read {op}: argument '{name}'={} is over the cap of {max}; pass at most {max}.",
            number as u64
        )));
    }
    Ok(number as u64)
}

// ——————————————————————————————— Paths ———————————————————————————————

/// Lexical normalization: `.` dropped, `..` pops a normal component (never past the root).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(Component::ParentDir);
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Node `resolveWithinWorkspace`: the lexical resolution of `arg` against `cwd`, or `None` when it escapes. Symlinks
/// are not followed; artifact publishing adds a real-path check on top.
pub fn resolve_within_workspace(cwd: &Path, arg: &str) -> Option<PathBuf> {
    let root = normalize(cwd);
    let resolved = normalize(&root.join(arg));
    resolved.starts_with(&root).then_some(resolved)
}

/// Node `toWorkspaceRelative`: an absolute path becomes workspace-relative; a relative path is kept. Separators are
/// `/`, so the value does not depend on the host.
pub fn to_workspace_relative(cwd: &Path, path: &str) -> String {
    let as_path = Path::new(path);
    let relative = if as_path.is_absolute() {
        normalize(as_path)
            .strip_prefix(normalize(cwd))
            .map(Path::to_path_buf)
            .unwrap_or_else(|_| as_path.to_path_buf())
    } else {
        as_path.to_path_buf()
    };
    relative.to_string_lossy().replace('\\', "/")
}

fn assert_within_workspace(op: &str, cwd: &Path, arg: &str) -> Result<PathBuf, WorkflowError> {
    resolve_within_workspace(cwd, arg).ok_or_else(|| {
        driver_error(format!(
            "world-read {op}: path '{arg}' is outside the workspace; pass a path inside it."
        ))
    })
}

/// JavaScript string order for lists the journal stores.
fn sort_js(values: &mut [String]) {
    values.sort_by(|a, b| js_cmp(a, b));
}

fn port_fault(message: String) -> WorkflowError {
    driver_error(message)
}

// ——————————————————————————————— files.* ———————————————————————————————

fn world_glob(
    cwd: &Path,
    ports: &dyn WorldReadPorts,
    pattern: &str,
) -> Result<Value, WorkflowError> {
    let cap = caps::GLOB_MAX_FILES;
    // One extra result proves the cap is exceeded: exactly `cap` matches are a complete result.
    let hits = ports.glob(pattern, cap + 1).map_err(port_fault)?;
    if hits.files.len() > cap || hits.total > cap {
        return Err(cap_exceeded(format!(
            "files.glob: over {cap} files match (the cap). Narrow the pattern."
        )));
    }
    let mut paths: Vec<String> = hits
        .files
        .iter()
        .map(|path| to_workspace_relative(cwd, path))
        .collect();
    sort_js(&mut paths);
    Ok(json!(paths))
}

fn world_read(cwd: &Path, ports: &dyn WorldReadPorts, arg: &str) -> Result<Value, WorkflowError> {
    let path = assert_within_workspace("read", cwd, arg)?;
    let content = ports
        .read_text(&path.to_string_lossy())
        .map_err(port_fault)?;
    Ok(Value::String(content))
}

fn world_grep(
    cwd: &Path,
    ports: &dyn WorldReadPorts,
    pattern: &str,
    glob: Option<&str>,
) -> Result<Value, WorkflowError> {
    let cap = caps::GREP_MAX_MATCHES;
    let hits = ports.grep(pattern, glob, cap + 1).map_err(port_fault)?;
    if hits.entries.len() > cap || hits.truncated {
        return Err(cap_exceeded(format!(
            "files.grep: over {cap} matches (the cap). Narrow the pattern or add a glob."
        )));
    }
    let mut matches = Vec::new();
    for entry in hits.entries {
        // An entry without a line number or text is not a content match; skip it rather than invent one.
        let (Some(line), Some(text)) = (entry.line, entry.text) else {
            continue;
        };
        matches.push(json!({
            "path": to_workspace_relative(cwd, &entry.path),
            "line": line,
            "text": text,
        }));
    }
    let array = Value::Array(matches);
    let serialized = stringify(&array).len();
    if serialized > caps::GREP_MAX_SERIALIZED_BYTES {
        return Err(cap_exceeded(format!(
            "files.grep: result is {serialized} bytes, over the {}-byte cap. Narrow the pattern or \
             add a glob.",
            caps::GREP_MAX_SERIALIZED_BYTES
        )));
    }
    Ok(array)
}

// ——————————————————————————————— git.* ———————————————————————————————

/// What a git read does when the port's output reached the inline limit.
#[derive(Clone, Copy)]
enum Truncation {
    /// A text read: the output is partial, so the read is refused. The hint names the knob that fixes it for this op.
    Refuse { hint: &'static str },
    /// The caller judges the size itself (git.diff, with its own cap).
    CallerChecks,
}

/// Run `git` with a fixed argv and return its stdout. A non-zero exit or a failed run is a catchable `DriverError`.
fn run_git(
    cwd: &Path,
    ports: &dyn WorldReadPorts,
    argv: &[String],
    max_inline_bytes: usize,
    truncation: Truncation,
) -> Result<RunStream, WorkflowError> {
    let outcome = ports
        .run(&RunRequest {
            cwd: cwd.to_path_buf(),
            file: "git".to_owned(),
            args: argv.to_vec(),
            timeout_ms: Some(caps::RUN_DEFAULT_TIMEOUT_MS),
            max_inline_bytes,
            tail_bytes: None,
        })
        .map_err(port_fault)?;
    let exit = outcome.exit_code.unwrap_or(0);
    if outcome.status != RunStatus::Completed || exit != 0 {
        let detail = first_line(&outcome.stderr.text)
            .or_else(|| first_line(&outcome.stdout.text))
            .unwrap_or_else(|| status_name(&outcome.status).to_owned());
        let exit_text = outcome
            .exit_code
            .map_or_else(|| "n/a".to_owned(), |code| code.to_string());
        return Err(driver_error(format!(
            "git {} failed ({}, exit={exit_text}): {detail}",
            argv.join(" "),
            status_name(&outcome.status)
        )));
    }
    // A text read that hit the inline limit is partial. Parsing it would drop entries silently, so it is refused.
    match truncation {
        Truncation::Refuse { hint }
            if outcome.stdout.truncated || outcome.stdout.bytes > max_inline_bytes =>
        {
            return Err(cap_exceeded(format!(
                "git {} output is over the {max_inline_bytes}-byte inline limit; the read is refused rather than parsed as a partial result. {hint}",
                argv.join(" ")
            )));
        }
        Truncation::Refuse { .. } | Truncation::CallerChecks => {}
    }
    Ok(outcome.stdout)
}

fn status_name(status: &RunStatus) -> &'static str {
    match status {
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
        RunStatus::TimedOut => "timed_out",
        RunStatus::Cancelled => "cancelled",
        RunStatus::SpawnError => "spawn_error",
    }
}

/// The first line of a text, trimmed the way JavaScript `trim` does (for messages only).
fn first_line(text: &str) -> Option<String> {
    let line = text.split('\n').next().unwrap_or("").trim();
    (!line.is_empty()).then(|| line.to_owned())
}

fn git_prefix(cwd: &Path, ports: &dyn WorldReadPorts) -> Result<String, WorkflowError> {
    let out = run_git(
        cwd,
        ports,
        &GIT_SHOW_PREFIX_ARGV
            .iter()
            .map(|s| (*s).to_owned())
            .collect::<Vec<_>>(),
        caps::GIT_TEXT_OUTPUT_BYTES,
        Truncation::Refuse {
            hint: "Narrow the workspace.",
        },
    )?;
    Ok(parse_git_show_prefix(&out.text))
}

fn git_changed_files(
    cwd: &Path,
    ports: &dyn WorldReadPorts,
    base: Option<&str>,
) -> Result<Value, WorkflowError> {
    // Validate the base before any git command runs.
    let plans = git_changed_files_plans(base)?;
    let prefix = git_prefix(cwd, ports)?;
    let mut paths = Vec::new();
    for plan in plans {
        let out = run_git(
            cwd,
            ports,
            &plan,
            caps::GIT_TEXT_OUTPUT_BYTES,
            Truncation::Refuse {
                hint: "Pass a base ref to list only tracked changes, or narrow the workspace.",
            },
        )?;
        paths.extend(parse_git_path_list(&out.text, &prefix)?);
    }
    // The union is deduplicated and sorted, so the journaled value depends only on content.
    paths.sort_by(|a, b| js_cmp(a, b));
    paths.dedup();
    Ok(json!(paths))
}

fn git_diff(
    cwd: &Path,
    ports: &dyn WorldReadPorts,
    base: Option<&str>,
    path: Option<&str>,
) -> Result<Value, WorkflowError> {
    let cap = caps::GIT_DIFF_MAX_BYTES;
    let argv = git_diff_argv(base, path)?;
    // cap + 1, as for grep: one byte over proves the output is over the cap.
    let out = run_git(cwd, ports, &argv, cap + 1, Truncation::CallerChecks)?;
    if out.bytes > cap || out.truncated {
        return Err(cap_exceeded(format!(
            "git.diff: output is {} bytes, over the {cap}-byte cap. Pass a path to narrow.",
            out.bytes
        )));
    }
    Ok(Value::String(out.text))
}

fn git_status(cwd: &Path, ports: &dyn WorldReadPorts) -> Result<Value, WorkflowError> {
    let prefix = git_prefix(cwd, ports)?;
    let argv: Vec<String> = GIT_STATUS_ARGV.iter().map(|s| (*s).to_owned()).collect();
    let out = run_git(
        cwd,
        ports,
        &argv,
        caps::GIT_TEXT_OUTPUT_BYTES,
        Truncation::Refuse {
            hint: "Narrow the workspace.",
        },
    )?;
    Ok(parse_git_status_porcelain_v2(&out.text, &prefix)?.to_json())
}

fn git_log(cwd: &Path, ports: &dyn WorldReadPorts, count: u64) -> Result<Value, WorkflowError> {
    let out = run_git(
        cwd,
        ports,
        &git_log_argv(count),
        caps::GIT_TEXT_OUTPUT_BYTES,
        Truncation::Refuse {
            hint: "Lower the count.",
        },
    )?;
    let commits = parse_git_log(&out.text)?;
    Ok(Value::Array(
        commits
            .iter()
            .map(crate::world_git::GitCommitResult::to_json)
            .collect(),
    ))
}

// ——————————————————————————————— world.run ———————————————————————————————

/// `opts.output` of `world.run`. One mode applies to both streams.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutput {
    Full,
    Discard,
    Tail(usize),
}

/// The largest tail: the same budget as a full stream.
pub const RUN_TAIL_MAX_BYTES: usize = caps::RUN_STREAM_MAX_BYTES;

fn run_output_shapes() -> String {
    format!(
        "\"full\", \"discard\", or {{ tail: n }} with n an integer from 1 to {RUN_TAIL_MAX_BYTES}"
    )
}

const RUN_OVER_CAP_HINT: &str = "Pass opts.output: { tail: n } to keep the last n bytes, or \"discard\" if only the \
exit code matters.";
const OUTPUT_PREVIEW_CHARS: usize = 80;

fn describe_output_arg(raw: &Value) -> String {
    let text = stringify(raw);
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() > OUTPUT_PREVIEW_CHARS {
        format!(
            "{}…",
            String::from_utf16_lossy(&units[..OUTPUT_PREVIEW_CHARS])
        )
    } else {
        text
    }
}

fn run_output_arg(raw: Option<&Value>) -> Result<RunOutput, WorkflowError> {
    let raw = match raw {
        None => return Ok(RunOutput::Full),
        Some(value) => value,
    };
    match raw.as_str() {
        Some("full") => return Ok(RunOutput::Full),
        Some("discard") => return Ok(RunOutput::Discard),
        _ => {}
    }
    let invalid = || {
        driver_error(format!(
            "world.run: opts.output must be {}; got {}.",
            run_output_shapes(),
            describe_output_arg(raw)
        ))
    };
    let Value::Object(map) = raw else {
        return Err(invalid());
    };
    if map.len() != 1 || !map.contains_key("tail") {
        return Err(invalid());
    }
    let bytes = map.get("tail").and_then(js_integer);
    match bytes {
        Some(number) if number >= 1.0 && number <= RUN_TAIL_MAX_BYTES as f64 => {
            Ok(RunOutput::Tail(number as usize))
        }
        _ => Err(invalid()),
    }
}

/// Arguments of `world.run`: `[cmd, args?, opts?]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunArgs {
    pub cmd: String,
    pub argv: Vec<String>,
    pub timeout_ms: u64,
    pub output: RunOutput,
}

pub fn run_args(args: &[Value]) -> Result<RunArgs, WorkflowError> {
    if args.is_empty() || args.len() > 3 {
        return Err(driver_error(format!(
            "world.run takes 1 to 3 arguments (cmd, args?, opts?), got {}.",
            args.len()
        )));
    }
    let cmd = require_string("run", &args[0], "cmd", 0)?;

    let mut argv = Vec::new();
    if let Some(raw) = args.get(1) {
        let Value::Array(items) = raw else {
            return Err(driver_error(format!(
                "world.run: argument 2 (args) must be an array of strings, got {}.",
                describe_arg(Some(raw))
            )));
        };
        for (index, item) in items.iter().enumerate() {
            match item {
                Value::String(text) => argv.push(text.clone()),
                other => {
                    return Err(driver_error(format!(
                        "world.run: args[{index}] must be a string, got {}. Stringify values.",
                        describe_arg(Some(other))
                    )));
                }
            }
        }
    }

    let mut timeout_ms = caps::RUN_DEFAULT_TIMEOUT_MS;
    let mut output = RunOutput::Full;
    if let Some(raw) = args.get(2) {
        let Value::Object(opts) = raw else {
            return Err(driver_error(format!(
                "world.run: arg 3 (opts) must be an options object or omitted, got {}.",
                describe_arg(Some(raw))
            )));
        };
        if let Some(timeout) = opts.get("timeoutMs") {
            match js_integer(timeout) {
                Some(number) if number >= 1.0 => timeout_ms = number as u64,
                _ => {
                    return Err(driver_error(format!(
                        "world.run: opts.timeoutMs must be an integer >= 1, got {}.",
                        describe_arg(Some(timeout))
                    )));
                }
            }
        }
        output = run_output_arg(opts.get("output"))?;
    }
    Ok(RunArgs {
        cmd,
        argv,
        timeout_ms,
        output,
    })
}

/// Node `worldRun`: a nonzero exit is a value; a timeout, a spawn error or an output over the cap is not.
fn world_run(
    cwd: &Path,
    ports: &dyn WorldReadPorts,
    args: &[Value],
) -> Result<Value, WorkflowError> {
    let RunArgs {
        cmd,
        argv,
        timeout_ms,
        output,
    } = run_args(args)?;
    let stdout_cap = caps::RUN_STREAM_MAX_BYTES;
    let stderr_cap = caps::RUN_STREAM_MAX_BYTES;
    let (max_inline_bytes, tail_bytes) = match output {
        RunOutput::Full => (stdout_cap.max(stderr_cap) + 1, None),
        RunOutput::Discard => (0, None),
        RunOutput::Tail(bytes) => (0, Some(bytes)),
    };
    let outcome = ports
        .run(&RunRequest {
            cwd: cwd.to_path_buf(),
            file: cmd.clone(),
            args: argv,
            timeout_ms: Some(timeout_ms),
            max_inline_bytes,
            tail_bytes,
        })
        .map_err(port_fault)?;

    if outcome.status == RunStatus::TimedOut {
        return Err(driver_error(format!(
            "world.run '{cmd}' timed out after {timeout_ms}ms. Raise opts.timeoutMs or narrow the work."
        )));
    }
    // A completed run and a failure that is only a nonzero exit both observed the command. Anything else did not.
    let ran_to_exit = outcome.status == RunStatus::Completed
        || (outcome.status == RunStatus::Failed
            && outcome.error.is_none()
            && outcome.exit_code.is_some());
    if !ran_to_exit {
        let detail = outcome
            .error
            .clone()
            .or_else(|| {
                first_line(&outcome.stderr.text)
                    .or_else(|| outcome.stderr.tail.as_deref().and_then(first_line))
            })
            .unwrap_or_else(|| status_name(&outcome.status).to_owned());
        return Err(driver_error(format!(
            "world.run '{cmd}' did not run to completion ({}): {detail}",
            status_name(&outcome.status)
        )));
    }

    let exit_code = outcome.exit_code.unwrap_or(0);
    match output {
        RunOutput::Discard => Ok(json!({"exitCode": exit_code, "stdout": "", "stderr": ""})),
        RunOutput::Tail(_) => {
            let (Some(stdout_tail), Some(stderr_tail)) = (outcome.stdout.tail, outcome.stderr.tail)
            else {
                return Err(driver_error(format!(
                    "world.run '{cmd}': the execution port returned no output tail for output: {{ tail: {} }}.",
                    tail_bytes.unwrap_or(0)
                )));
            };
            Ok(json!({"exitCode": exit_code, "stdout": stdout_tail, "stderr": stderr_tail}))
        }
        RunOutput::Full => {
            if outcome.stdout.bytes > stdout_cap || outcome.stdout.truncated {
                return Err(cap_exceeded(format!(
                    "world.run '{cmd}': stdout is {} bytes, over the {stdout_cap}-byte cap. \
                     {RUN_OVER_CAP_HINT} Or quiet the output (e.g. --quiet), or write a file and files.read a summary.",
                    outcome.stdout.bytes
                )));
            }
            if outcome.stderr.bytes > stderr_cap || outcome.stderr.truncated {
                return Err(cap_exceeded(format!(
                    "world.run '{cmd}': stderr is {} bytes, over the {stderr_cap}-byte cap. \
                     {RUN_OVER_CAP_HINT} Or reduce the diagnostics, or write a file and files.read a summary.",
                    outcome.stderr.bytes
                )));
            }
            Ok(json!({
                "exitCode": exit_code,
                "stdout": outcome.stdout.text,
                "stderr": outcome.stderr.text,
            }))
        }
    }
}

#[cfg(test)]
#[path = "world_read_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "world_read_real_tests.rs"]
mod real_tests;

#[cfg(test)]
#[path = "world_read_node_cases_tests.rs"]
mod node_cases;
