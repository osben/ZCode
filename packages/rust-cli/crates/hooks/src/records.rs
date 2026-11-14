//! Fork: the run record of each hook of one dispatch, as Node's `HookRun*` lifecycle events carry them
//! (`core/src/hooks/runner.ts`; specs/fork-rust-agent-parity.md HK-UP-01).

use rust_cli_kernel_api::hooks::{HookRunOutcome, HookRunRecord, HookSourceKind};

use crate::config::{HookCommand, HookOrigin};
use crate::mask;
use crate::result::{Behavior, Executed, HookResult, Outcome, PermissionRequestDecision, Raw};

/// Node's `blockReason` when the hook gave none.
const BLOCKED: &str = "Hook blocked execution";

/// One finished hook of a dispatch.
pub(crate) struct Ran<'a> {
    pub run: String,
    pub index: u32,
    pub hook: &'a HookCommand,
    pub origin: &'a HookOrigin,
    pub executed: &'a Executed,
    /// The interpreted result (the REPL path); `None` on the outside path.
    pub result: Option<&'a HookResult>,
    pub started_at_ms: u64,
    pub duration_ms: u64,
}

/// Node's `blocked`: a deny, a prevented continuation or a block request (exit 2 and `onError: "deny"` included).
fn blocks(result: &HookResult) -> bool {
    result.outcome == Outcome::Blocking
        || result.prevent
        || result.block_requested
        || result.behavior == Some(Behavior::Deny)
        || matches!(
            result.permission_request,
            Some(PermissionRequestDecision::Deny { .. })
        )
}

fn outcome(raw: Option<&Raw>, result: Option<&HookResult>) -> HookRunOutcome {
    // An async command reports its start only: the turn does not wait for it ("Command hook stdin").
    if matches!(raw, Some(Raw::Backgrounded)) {
        return HookRunOutcome::Success;
    }
    if result.is_some_and(blocks) {
        return HookRunOutcome::Blocked;
    }
    match raw {
        Some(Raw::Cancelled) => return HookRunOutcome::Cancelled,
        // Before `interpret` collapses it into a cancel.
        Some(Raw::TimedOut) => return HookRunOutcome::TimedOut,
        Some(Raw::Failed(_)) => return HookRunOutcome::Failed,
        _ => {}
    }
    match result {
        Some(result) => match result.outcome {
            Outcome::NonBlockingError => HookRunOutcome::Failed,
            Outcome::Cancelled => HookRunOutcome::Cancelled,
            Outcome::Success | Outcome::Blocking => HookRunOutcome::Success,
        },
        None => match raw {
            Some(Raw::Command { exit: 0, .. }) => HookRunOutcome::Success,
            Some(Raw::Command { exit: 2, .. }) => HookRunOutcome::Blocked,
            Some(Raw::Http { status, .. }) if (200..300).contains(status) => {
                HookRunOutcome::Success
            }
            _ => HookRunOutcome::Failed,
        },
    }
}

/// Node: `stopReason ?? hookPermissionDecisionReason ?? the PermissionRequest deny message ?? "Hook blocked
/// execution"`, masked; an exit 2 carries its stderr (else stdout) preview as the reason
/// (`createExitCodeBlockOutput`).
fn block_reason(result: Option<&HookResult>, raw: Option<&Raw>) -> String {
    let denied = result.and_then(|result| match &result.permission_request {
        Some(PermissionRequestDecision::Deny { message }) => message.clone(),
        _ => None,
    });
    let exit_two = match raw {
        Some(Raw::Command {
            stdout,
            stderr,
            exit: 2,
        }) => mask::preview(stderr).or_else(|| mask::preview(stdout)),
        _ => None,
    };
    let reason = result
        .and_then(|result| result.stop_reason.clone().or_else(|| result.reason.clone()))
        .or(denied)
        .or(exit_two)
        .unwrap_or_else(|| BLOCKED.to_owned());
    mask::text(&reason)
}

/// Node `createHookExecutionDescriptor`'s `commandDisplay`: a process hook's parts quoted as needed, a shell
/// command as written, masked.
fn command_display(hook: &HookCommand) -> String {
    let display = match hook {
        HookCommand::Command(command) => match &command.args {
            Some(args) => std::iter::once(&command.command)
                .chain(args)
                .map(|part| quote_part(part))
                .collect::<Vec<_>>()
                .join(" "),
            None => command.command.clone(),
        },
        other => other.display(),
    };
    mask::text(&display)
}

/// Node `quoteCommandPart`.
fn quote_part(value: &str) -> String {
    let plain = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./:@%+=,-".contains(c));
    if plain {
        value.to_owned()
    } else {
        serde_json::Value::from(value).to_string()
    }
}

pub(crate) fn record(ran: Ran<'_>) -> HookRunRecord {
    let raw = match ran.executed {
        Executed::Raw(raw) => Some(raw),
        Executed::Result(_) => None,
    };
    let outcome = outcome(raw, ran.result);
    let blocked = outcome == HookRunOutcome::Blocked;
    // Node keeps the diagnostics of a blocked run only; stdout only on exit 2.
    let (stderr_preview, stdout_preview) = match raw {
        Some(Raw::Command {
            stdout,
            stderr,
            exit,
        }) if blocked => (
            mask::diagnostic(stderr),
            mask::diagnostic(stdout).filter(|_| *exit == 2),
        ),
        _ => (None, None),
    };
    let (source_kind, plugin_name) = match ran.origin {
        HookOrigin::User => (HookSourceKind::User, None),
        HookOrigin::Project => (HookSourceKind::Project, None),
        HookOrigin::Plugin(name) => (HookSourceKind::Plugin, Some(name.clone())),
    };
    HookRunRecord {
        run: ran.run,
        index: ran.index,
        outcome,
        block_reason: blocked.then(|| block_reason(ran.result, raw)),
        error_message: stderr_preview.clone(),
        stderr_preview,
        stdout_preview,
        started_at_ms: ran.started_at_ms,
        duration_ms: if matches!(raw, Some(Raw::Backgrounded)) {
            0
        } else {
            ran.duration_ms
        },
        source_kind,
        plugin_name,
        display: command_display(ran.hook),
    }
}

#[cfg(test)]
#[path = "records_tests.rs"]
mod tests;
