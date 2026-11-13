//! 工具类事件的合并（docs/specs/rust-cli/hooks.md §4.3、§6）。
//!
//! 结果按配置顺序传入（engine 排序，Node 逐个运行 hook），逐个折叠（PreToolUse、PostToolUse、
//! PostToolUseFailure、PermissionRequest 各一个函数）；聚合规则（权限优先级、updatedInput）在结果循环里逐个合并。

use rust_cli_kernel_api::clock::Ids;
use rust_cli_kernel_api::hooks::HookOutcome;
use rust_cli_kernel_api::permission::PermissionDecision;
use serde_json::Value;

use crate::result::{Behavior, HookResult, Outcome, PermissionRequestDecision};
use crate::texts;

/// 折叠用到的公共信息。
pub(crate) struct Fold<'a> {
    pub ids: &'a dyn Ids,
    /// 事件名。
    pub event: &'a str,
    /// `<事件>[:<match query>]`。
    pub hook_name: &'a str,
}

impl Fold<'_> {
    pub(crate) fn context(
        &self,
        hook_name: &str,
        contexts: &[String],
    ) -> Option<rust_cli_kernel_api::message::Message> {
        texts::additional_context(self.ids, hook_name, self.event, contexts)
    }
}

/// 只给用户看的 `systemMessage`。
pub(crate) fn notices(results: &[HookResult]) -> Vec<String> {
    results
        .iter()
        .filter_map(|result| result.system_message.clone())
        .collect()
}

/// Node `mergePermissionBehavior`: deny > ask > the last decision.
fn aggregate(current: Option<Behavior>, next: Behavior) -> Option<Behavior> {
    Some(match (current, next) {
        (_, Behavior::Deny) | (Some(Behavior::Deny), _) => Behavior::Deny,
        (_, Behavior::Ask) | (Some(Behavior::Ask), _) => Behavior::Ask,
        (_, Behavior::Allow) => Behavior::Allow,
    })
}

/// Where a PreToolUse deny came from. Its text is picked after the loop: Node takes the last truthy reason of the hooks
/// that gave a decision (`hookPermissionDecisionReason`), not the reason of the hook that denied.
enum Denial {
    /// A prevented call (`continue: false`, exit 2, `decision: "block"`): the reason, else the last stop reason, else
    /// Node's `Blocked by PreToolUse hook`.
    Stopped,
    /// A `permissionDecision: "deny"` that does not prevent: the reason, else the documented default text.
    Decision,
}

/// Node `mergePermissionBehavior` over the PreToolUse results in config order (`runner.ts`). `continue: false` is a
/// deny (`processHookOutput` sets `permissionBehavior: "deny"`) and refuses the call even when a later hook allows it.
pub(crate) fn pre_tool_use(fold: &Fold<'_>, results: &[HookResult]) -> HookOutcome {
    let mut outcome = HookOutcome {
        notices: notices(results),
        ..HookOutcome::default()
    };
    let mut aggregated: Option<Behavior> = None;
    let mut denial: Option<Denial> = None;
    let mut reason: Option<String> = None;
    // Node `updatedInput`: the last hook that sets it, whatever its behavior.
    let mut updated_input: Option<Value> = None;
    for result in results {
        if result.prevent {
            outcome.prevent_continuation = true;
            // Node `mergeHookRunResult` assigns `stopReason` on every preventing result, even when it has none.
            outcome.stop_reason.clone_from(&result.stop_reason);
            aggregated = aggregate(aggregated, Behavior::Deny);
            denial = Some(Denial::Stopped);
        }
        if let Some(blocking) = &result.blocking {
            outcome.blocking_error = Some(texts::pre_tool_blocking(fold.hook_name, blocking));
            aggregated = aggregate(aggregated, Behavior::Deny);
            // A blocking result without a permission decision (or one that also prevents) refuses like a stop.
            if result.prevent || result.behavior != Some(Behavior::Deny) {
                denial = Some(Denial::Stopped);
            }
        }
        if let Some(behavior) = result.behavior {
            aggregated = aggregate(aggregated, behavior);
            if result.reason.is_some() {
                reason.clone_from(&result.reason);
            }
            if behavior == Behavior::Deny {
                denial = Some(if result.prevent {
                    Denial::Stopped
                } else {
                    Denial::Decision
                });
            }
        }
        if result.updated_input.is_some() {
            updated_input.clone_from(&result.updated_input);
        }
        if let Some(context) = &result.additional_context {
            outcome.additional_context.push(context.clone());
            outcome
                .messages
                .extend(fold.context(fold.hook_name, std::slice::from_ref(context)));
        }
    }
    outcome.decision = match aggregated {
        None => None,
        Some(Behavior::Allow) => Some(PermissionDecision::Allow {
            updated_input: None,
        }),
        Some(Behavior::Ask) => {
            let message = reason.clone().unwrap_or_else(|| {
                texts::decision_default(fold.hook_name, "asked for confirmation for")
            });
            Some(PermissionDecision::ask(message, Vec::new()))
        }
        Some(Behavior::Deny) => {
            let message = match denial {
                Some(Denial::Stopped) => reason
                    .clone()
                    .or_else(|| outcome.stop_reason.clone())
                    .unwrap_or_else(|| texts::BLOCKED_BY_PRE_TOOL_USE.to_owned()),
                Some(Denial::Decision) | None => reason
                    .clone()
                    .unwrap_or_else(|| texts::decision_default(fold.hook_name, "denied")),
            };
            Some(PermissionDecision::Deny { message })
        }
    };
    // A refused call never applies `updatedInput` (Node returns before it, `call-runner.ts`).
    outcome.updated_input = match outcome.decision {
        Some(PermissionDecision::Deny { .. }) => None,
        _ => updated_input,
    };
    if outcome.prevent_continuation {
        let message = outcome
            .stop_reason
            .clone()
            .unwrap_or_else(|| texts::STOPPED_BY_HOOK.to_owned());
        outcome.after_result.push(texts::stopped_continuation(
            fold.ids,
            fold.hook_name,
            fold.event,
            &message,
        ));
    }
    outcome
}

pub(crate) fn post_tool_use(fold: &Fold<'_>, results: &[HookResult]) -> HookOutcome {
    let mut outcome = HookOutcome {
        notices: notices(results),
        ..HookOutcome::default()
    };
    for result in results {
        if result.outcome == Outcome::Cancelled {
            continue;
        }
        if result.updated_tool_output.is_some() {
            outcome
                .updated_tool_output
                .clone_from(&result.updated_tool_output);
        }
        // Node uses only a PostToolUse hook's context: `continue: false` does not stop the turn
        // (`shouldPreventContinuation`), so `result.prevent` is not read here.
        if let Some(blocking) = &result.blocking {
            outcome
                .blocking_error
                .get_or_insert_with(|| blocking.error.clone());
            outcome.messages.push(texts::blocking_error(
                fold.ids,
                fold.hook_name,
                fold.event,
                blocking,
            ));
        }
        if let Some(context) = &result.additional_context {
            outcome.additional_context.push(context.clone());
            outcome
                .messages
                .extend(fold.context(fold.hook_name, std::slice::from_ref(context)));
        }
    }
    outcome
}

pub(crate) fn post_tool_use_failure(fold: &Fold<'_>, results: &[HookResult]) -> HookOutcome {
    let mut outcome = HookOutcome {
        notices: notices(results),
        ..HookOutcome::default()
    };
    for result in results {
        if let Some(blocking) = &result.blocking {
            outcome
                .blocking_error
                .get_or_insert_with(|| blocking.error.clone());
            outcome.messages.push(texts::blocking_error(
                fold.ids,
                fold.hook_name,
                fold.event,
                blocking,
            ));
        }
        if let Some(context) = &result.additional_context {
            outcome.additional_context.push(context.clone());
            outcome
                .messages
                .extend(fold.context(fold.hook_name, std::slice::from_ref(context)));
        }
    }
    outcome
}

/// Node `processHookOutput` + `hook-flow.ts` (specs/fork-rust-agent-parity.md, "Hook output for PermissionRequest and
/// PostToolUse"): a stopping hook (`continue: false`, `decision: "block"`, exit code 2) denies first, with the last
/// stopping hook's text; otherwise the last decision wins; otherwise `decision: "approve"` allows.
pub(crate) fn permission_request(results: &[HookResult]) -> HookOutcome {
    let mut outcome = HookOutcome {
        notices: notices(results),
        ..HookOutcome::default()
    };
    if let Some(stop) = results.iter().rev().find_map(permission_request_stop) {
        outcome.decision = Some(PermissionDecision::Deny {
            message: stop.unwrap_or_else(|| texts::DENIED_BY_PERMISSION_REQUEST_HOOK.to_owned()),
        });
        return outcome;
    }
    match results
        .iter()
        .rev()
        .find_map(|result| result.permission_request.clone())
    {
        Some(PermissionRequestDecision::Allow { updated_input }) => {
            outcome.decision = Some(PermissionDecision::Allow {
                updated_input: None,
            });
            outcome.updated_input = updated_input;
        }
        Some(PermissionRequestDecision::Deny { message }) => {
            outcome.decision = Some(PermissionDecision::Deny {
                // Node `decision.message ?? "Denied by PermissionRequest hook"`: an empty message is kept.
                message: message
                    .unwrap_or_else(|| texts::DENIED_BY_PERMISSION_REQUEST_HOOK.to_owned()),
            });
        }
        None if results
            .iter()
            .any(|result| result.behavior == Some(Behavior::Allow)) =>
        {
            outcome.decision = Some(PermissionDecision::Allow {
                updated_input: None,
            });
        }
        None => {}
    }
    outcome
}

/// Whether a PermissionRequest hook stops the call, and its Node `stopReason`. Node stops only on
/// `preventContinuation`: `continue: false` (`stopReason ?? reason`), top-level `decision: "block"`
/// (`stopReason ?? reason ?? systemMessage`), both folded into `stop_reason` by `output::process`, and exit code 2
/// (the blocking text). A `hookSpecificOutput` deny is a decision, not a stop (Node `permissionRequestResult`).
fn permission_request_stop(result: &HookResult) -> Option<Option<String>> {
    if result.prevent || result.block_requested {
        return Some(result.stop_reason.clone());
    }
    result
        .blocking
        .as_ref()
        .map(|blocking| Some(blocking.error.clone()))
}

/// PermissionDenied：任何 hook 给出 `retry: true` 即重试。
pub(crate) fn permission_denied(results: &[HookResult]) -> HookOutcome {
    HookOutcome {
        notices: notices(results),
        retry: results.iter().any(|result| result.retry),
        ..HookOutcome::default()
    }
}

#[cfg(test)]
#[path = "fold_tests.rs"]
mod tests;
