//! Fork: `hookInvocation` rows and the blocked-prompt banner, like Node's `onHookRunLifecycle` and
//! `hookBlockErrorDelta` (bootstrap `zcode-protocol-v4/product-projection.ts`; specs/fork-rust-agent-parity.md
//! HK-UP-01). One row per dispatch in the running turn; a UserPromptSubmit block sets `lastError`.

use rust_cli_kernel_api::hooks::{
    HookEventName, HookInvocation, HookRunOutcome, HookRunRecord, HookSourceKind,
};
use serde_json::{Map, Value, json};

use super::state::{ErrorAttribution, LastError};
use super::{Projection, RowKind};

/// Node `USER_PROMPT_HOOK_BLOCK_ERROR_TYPE`.
const PROMPT_BLOCK: &str = "hooks_prompt_block";

/// Node `HOOK_SCRIPT_RUNNERS`.
const SCRIPT_RUNNERS: &[&str] = &[
    "bash",
    "bun",
    "deno",
    "node",
    "node.exe",
    "powershell",
    "pwsh",
    "python",
    "python3",
    "ruby",
    "sh",
    "zsh",
];

fn outcome_name(outcome: HookRunOutcome) -> &'static str {
    match outcome {
        HookRunOutcome::Success => "success",
        HookRunOutcome::Blocked => "blocked",
        HookRunOutcome::Failed => "failed",
        HookRunOutcome::Cancelled => "cancelled",
        HookRunOutcome::TimedOut => "timed_out",
    }
}

/// Node `hookExecutionState`: a thrown run (failed, cancelled, timed out) is `failed`.
fn execution_state(outcome: HookRunOutcome) -> &'static str {
    match outcome {
        HookRunOutcome::Success | HookRunOutcome::Blocked => "completed",
        HookRunOutcome::Failed | HookRunOutcome::Cancelled | HookRunOutcome::TimedOut => "failed",
    }
}

fn source_name(kind: HookSourceKind) -> &'static str {
    match kind {
        HookSourceKind::User => "user",
        HookSourceKind::Project => "project",
        HookSourceKind::Plugin => "plugin",
    }
}

/// Node `hookInvocationLane`.
fn lane(event: HookEventName) -> &'static str {
    match event {
        HookEventName::PreToolUse | HookEventName::PermissionRequest => "toolBefore",
        HookEventName::PostToolUse | HookEventName::PostToolUseFailure => "toolAfter",
        _ => "assistantWork",
    }
}

/// Node `unquoteHookDisplayToken`.
fn unquote(token: &str) -> String {
    if token.len() >= 2 && token.starts_with('"') && token.ends_with('"') {
        return serde_json::from_str::<String>(token)
            .unwrap_or_else(|_| token[1..token.len() - 1].to_owned());
    }
    if token.len() >= 2 && token.starts_with('\'') && token.ends_with('\'') {
        return token[1..token.len() - 1].to_owned();
    }
    token.to_owned()
}

/// The tokens of Node's `/"(?:\\.|[^"])*"|'[^']*'|\S+/gu` over a command display.
fn tokens(display: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < display.len() {
        let rest = &display[at..];
        let Some(first) = rest.chars().next() else {
            break;
        };
        if first.is_whitespace() {
            at += first.len_utf8();
            continue;
        }
        let end = match first {
            '"' => quoted_end(rest, true),
            '\'' => quoted_end(rest, false),
            _ => None,
        }
        .unwrap_or_else(|| {
            rest.char_indices()
                .find(|(_, c)| c.is_whitespace())
                .map_or(rest.len(), |(index, _)| index)
        });
        out.push(&rest[..end]);
        at += end;
    }
    out
}

/// The end of a quoted token at the start of `text`; `None` when it is not closed (Node then reads `\S+`).
fn quoted_end(text: &str, escapes: bool) -> Option<usize> {
    let quote = text.chars().next()?;
    let mut chars = text.char_indices().skip(1);
    while let Some((index, c)) = chars.next() {
        if escapes && c == '\\' {
            chars.next();
            continue;
        }
        if c == quote {
            return Some(index + c.len_utf8());
        }
    }
    None
}

fn last_segment(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// Node `hookCommandLabel`.
fn command_label(display: &str) -> Option<String> {
    let tokens = tokens(display);
    let executable_token = unquote(tokens.first()?);
    let executable = last_segment(&executable_token).to_owned();
    if executable.is_empty() {
        return None;
    }
    let Some(script_token) = tokens.get(1) else {
        return Some(executable);
    };
    if !SCRIPT_RUNNERS.contains(&executable.to_lowercase().as_str()) {
        return Some(executable);
    }
    let script = unquote(script_token);
    if script.is_empty() || script.starts_with('-') {
        return Some(executable);
    }
    let name = last_segment(&script);
    Some(if name.is_empty() {
        executable
    } else {
        format!("{executable} · {name}")
    })
}

/// Node `hookExecutionDisplayName` (Rust keeps no `statusMessage`).
fn display_name(run: &HookRunRecord) -> String {
    let executable = command_label(&run.display);
    match (
        run.plugin_name.as_deref().filter(|name| !name.is_empty()),
        executable,
    ) {
        (Some(plugin), Some(executable)) => format!("{plugin} · {executable}"),
        (Some(plugin), None) => plugin.to_owned(),
        (None, Some(executable)) => executable,
        (None, None) => format!("Hook #{}", run.index + 1),
    }
}

fn execution(run: &HookRunRecord, tool_name: Option<&str>) -> Value {
    let mut value = json!({
        "hookRunId": run.run,
        "hookIndex": run.index,
        "didExecute": true,
        "state": execution_state(run.outcome),
        "outcome": outcome_name(run.outcome),
        "startedAt": run.started_at_ms,
        "endedAt": run.started_at_ms + run.duration_ms,
        "durationMs": run.duration_ms,
        "displayName": display_name(run),
        "sourceKind": source_name(run.source_kind),
    });
    if let Some(reason) = run
        .block_reason
        .as_deref()
        .filter(|reason| !reason.trim().is_empty())
    {
        value["blockReason"] = json!(reason);
    }
    if let Some(plugin) = &run.plugin_name {
        value["pluginName"] = json!(plugin);
    }
    if let Some(tool) = tool_name {
        value["toolName"] = json!(tool);
    }
    value
}

/// Node `hookBlockErrorDelta` for the last blocked UserPromptSubmit run (each `HookRunBlocked` replaces the error).
pub(super) fn block_error(invocation: &HookInvocation, now: u64) -> Option<LastError> {
    if invocation.hook_event != HookEventName::UserPromptSubmit {
        return None;
    }
    let run = invocation
        .runs
        .iter()
        .rev()
        .find(|run| run.outcome == HookRunOutcome::Blocked)?;
    let reason = run.block_reason.as_deref()?;
    let diagnostic = [&run.stderr_preview, &run.error_message, &run.stdout_preview]
        .into_iter()
        .filter_map(|value| value.as_deref().map(str::trim))
        .find(|value| !value.is_empty() && *value != reason);
    let shown = diagnostic.unwrap_or(reason);
    let message = if shown == PROMPT_BLOCK {
        PROMPT_BLOCK.to_owned()
    } else {
        format!("{PROMPT_BLOCK}: {shown}")
    };
    let mut detail = format!("Hook block reason: {reason}");
    if let Some(diagnostic) = diagnostic {
        detail.push_str(&format!("\nHook error: {diagnostic}"));
    }
    Some(LastError {
        message,
        code: Some("fault.runtime.hookBlocked".to_owned()),
        at: now,
        recoverable: false,
        detail: Some(detail),
        attribution: Some(ErrorAttribution::HookBlocked),
    })
}

impl Projection {
    /// One dispatch's row in the running turn (Node appends it at the dispatch's first event; Rust reports the
    /// dispatch once it finished), and the banner of a blocked prompt.
    pub(super) fn hook_invocation(
        &mut self,
        invocation: &HookInvocation,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) -> bool {
        let Some(turn) = self.turn.as_ref().map(|turn| turn.id.clone()) else {
            return false;
        };
        let mut runs: Vec<&HookRunRecord> = invocation.runs.iter().collect();
        if runs.is_empty() {
            return false;
        }
        runs.sort_by_key(|run| run.index);
        let executions: Vec<Value> = runs
            .iter()
            .map(|run| execution(run, invocation.tool_name.as_deref()))
            .collect();
        let started = runs
            .iter()
            .map(|run| run.started_at_ms)
            .min()
            .unwrap_or(now);
        let ended = runs
            .iter()
            .map(|run| run.started_at_ms + run.duration_ms)
            .max()
            .unwrap_or(started);
        let state = if runs
            .iter()
            .any(|run| execution_state(run.outcome) == "failed")
        {
            "failed"
        } else {
            "completed"
        };
        let key = format!("hook:{}", invocation.id);
        // A dispatch is reported once, when it finished.
        if self.index.contains_key(&key) {
            return false;
        }
        let mut row: Map<String, Value> =
            self.base(&turn, &invocation.id, RowKind::HookInvocation, now, seq);
        row.insert("hookInvocationId".into(), json!(invocation.id));
        row.insert(
            "hookEventName".into(),
            json!(invocation.hook_event.as_str()),
        );
        row.insert("hookCount".into(), json!(runs.len()));
        row.insert("state".into(), json!(state));
        row.insert("startedAt".into(), json!(started));
        row.insert("endedAt".into(), json!(ended));
        row.insert("durationMs".into(), json!(ended.saturating_sub(started)));
        row.insert("lane".into(), json!(lane(invocation.hook_event)));
        if let Some(tool_use) = &invocation.tool_use {
            row.insert("anchorToolCallId".into(), json!(tool_use.as_str()));
        }
        row.insert("executions".into(), Value::Array(executions));
        self.append(key, row, out);
        match block_error(invocation, now) {
            Some(error) => {
                self.error = Some(error);
                true
            }
            None => false,
        }
    }
}
