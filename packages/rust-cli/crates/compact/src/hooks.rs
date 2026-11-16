//! 压缩的 PreCompact / PostCompact hooks（docs/specs/rust-cli/hooks.md §7、compact.md §7）。

use rust_cli_kernel_api::hooks::HookInvocation;
use rust_cli_kernel_api::message::{CompactTrigger, Message};
use rust_cli_kernel_api::orchestration::{
    CompactRequest, HookContext, HookEvent, HookEventName, HookOutcome, HookRunner,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::engine::Failure;

/// Fork: keep one dispatch's runs for the caller to report (HK-UP-01); none without a run. The caller gates the
/// reporting, the engine having no sink.
fn keep(dispatches: &mut Vec<HookInvocation>, name: HookEventName, outcome: &HookOutcome) {
    if let Some(id) = outcome
        .invocation
        .as_ref()
        .filter(|_| !outcome.runs.is_empty())
    {
        dispatches.push(HookInvocation {
            id: id.clone(),
            hook_event: name,
            tool_use: None,
            tool_name: None,
            runs: outcome.runs.clone(),
        });
    }
}

fn trigger_name(trigger: CompactTrigger) -> &'static str {
    // 反应式压缩以 `auto` 调 hook。
    match trigger {
        CompactTrigger::Manual => "manual",
        CompactTrigger::Auto | CompactTrigger::Reactive => "auto",
    }
}

/// hook 给的说明接在用户说明后面。
fn merge_instructions(user: Option<&str>, hook: Option<String>) -> Option<String> {
    match (
        user.filter(|text| !text.is_empty()),
        hook.filter(|text| !text.is_empty()),
    ) {
        (Some(user), Some(hook)) => Some(format!("{user}\n\n{hook}")),
        (Some(user), None) => Some(user.to_owned()),
        (None, hook) => hook,
    }
}

/// 压缩 hook 的上下文：模式与子代理（hooks.md §7）。
fn hook_context(request: &CompactRequest) -> HookContext {
    HookContext {
        mode: request.mode,
        agent: request.agent.clone(),
        // prompt hook 的缺省模型经小模型槽位从它得出（model.md §6.1）。
        selection: Some(request.selection.clone()),
        ..HookContext::default()
    }
}

/// PreCompact hook（hooks.md §7）。
pub(crate) async fn pre_compact(
    hooks: &dyn HookRunner,
    request: &CompactRequest,
    cancel: &CancellationToken,
    dispatches: &mut Vec<HookInvocation>,
) -> Result<Option<String>, Failure> {
    let event = HookEvent {
        context: hook_context(request),
        ..HookEvent::new(
            HookEventName::PreCompact,
            request.session.clone(),
            request.workspace.clone(),
            json!({
                "trigger": trigger_name(request.trigger),
                "custom_instructions": request.instructions,
            }),
        )
    };
    let outcome = hooks.run(event, cancel.clone()).await;
    keep(dispatches, HookEventName::PreCompact, &outcome);
    if let Some(reason) = outcome.blocking_error {
        return Err(Failure::Blocked(reason));
    }
    // hooks crate 已把成功 hook 的输出合并成 `custom_instructions`（hooks.md §7）。
    Ok(merge_instructions(
        request.instructions.as_deref(),
        outcome.custom_instructions,
    ))
}

/// SessionStart（`compact`）：压缩成功后、PostCompact 之前（spec §7）。
/// 载荷只有 `source` 与 `model`（对 compact 不传标题）；返回要排在附件之后提交的 hook 消息。
pub(crate) async fn session_start(
    hooks: &dyn HookRunner,
    request: &CompactRequest,
    cancel: &CancellationToken,
    dispatches: &mut Vec<HookInvocation>,
) -> Vec<Message> {
    let event = HookEvent {
        context: HookContext {
            agent: request.agent.clone(),
            session_mode: request.mode,
            ..HookContext::default()
        },
        ..HookEvent::new(
            HookEventName::SessionStart,
            request.session.clone(),
            request.workspace.clone(),
            json!({"source": "compact", "model": request.selection.model}),
        )
    };
    let outcome = hooks.run(event, cancel.clone()).await;
    keep(dispatches, HookEventName::SessionStart, &outcome);
    outcome.messages
}

/// PostCompact hook：结果只用于显示（spec §7）。
pub(crate) async fn post_compact(
    hooks: &dyn HookRunner,
    request: &CompactRequest,
    summary: &str,
    cancel: &CancellationToken,
    dispatches: &mut Vec<HookInvocation>,
) {
    let event = HookEvent {
        context: hook_context(request),
        ..HookEvent::new(
            HookEventName::PostCompact,
            request.session.clone(),
            request.workspace.clone(),
            json!({
                "trigger": trigger_name(request.trigger),
                "compact_summary": summary,
            }),
        )
    };
    let outcome = hooks.run(event, cancel.clone()).await;
    keep(dispatches, HookEventName::PostCompact, &outcome);
    let _ = outcome;
}

#[cfg(test)]
#[path = "hooks_tests.rs"]
mod tests;
