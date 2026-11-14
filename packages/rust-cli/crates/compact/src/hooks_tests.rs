//! 压缩里的 hooks 顺序与 SessionStart（`compact`）的消息（compact.md §7）。

use rust_cli_base::sync::LockUnpoisoned;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_base::models::GLM_5_3;
use rust_cli_kernel_api::ids::{AgentId, MessageId};
use rust_cli_kernel_api::message::{AttachmentMessage, CompactTrigger, Message};
use rust_cli_kernel_api::orchestration::{HookEvent, HookEventName, HookOutcome, HookRunner};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::engine::Engine;
use crate::test_support::{Reply, ScriptedRunner, human, no_tools, ports, reply, request};

#[derive(Default)]
struct Recorded(Mutex<Vec<HookEvent>>);

#[async_trait]
impl HookRunner for Recorded {
    async fn run(&self, event: HookEvent, _cancel: CancellationToken) -> HookOutcome {
        let name = event.name;
        self.0.lock_unpoisoned().push(event);
        if name != HookEventName::SessionStart {
            return HookOutcome::default();
        }
        HookOutcome {
            messages: vec![Message::Attachment(AttachmentMessage {
                id: MessageId::new("hook_ctx"),
                source: "hook_additional_context".to_owned(),
                text: "<system-reminder>\nSessionStart hook additional context: again\n</system-reminder>".to_owned(),
                data: Value::Null,
            })],
            ..HookOutcome::default()
        }
    }
}

#[tokio::test]
async fn session_start_runs_inside_every_compaction_before_post_compact() {
    for trigger in [
        CompactTrigger::Manual,
        CompactTrigger::Auto,
        CompactTrigger::Reactive,
    ] {
        let hooks = Arc::new(Recorded::default());
        let runner = ScriptedRunner::new(vec![Reply::Text("<summary>S</summary>".to_owned())]);
        let mut ports = ports(runner, no_tools());
        ports.hooks = hooks.clone();
        let mut request = request(vec![human("u1", "hi"), reply("a1", "ok", None)], trigger);
        request.agent = Some(AgentId::new("agent_1"));
        let result = Engine { ports: &ports }
            .run(&request, true, &CancellationToken::new(), None)
            .await
            .unwrap();
        let seen = hooks.0.lock_unpoisoned().clone();
        let names: Vec<HookEventName> = seen.iter().map(|event| event.name).collect();
        assert_eq!(
            names,
            [
                HookEventName::PreCompact,
                HookEventName::SessionStart,
                HookEventName::PostCompact
            ]
        );
        let start = &seen[1];
        // 对 compact 不传标题：只有 source 与 model；子代理里带 agent_id。
        assert_eq!(
            start.payload,
            json!({"source": "compact", "model": GLM_5_3})
        );
        assert_eq!(start.context.agent, Some(AgentId::new("agent_1")));
        // hook 消息排在附件之后，与边界、摘要一起交给调用方提交。
        assert_eq!(
            result.restored.last().map(|message| message.id().as_str()),
            Some("hook_ctx")
        );
    }
}

/// Hook runner whose SessionStart run gives a hook group with `text`, or nothing for `None`: the `hook_success`
/// attachment first, then the additional-context attachment, as the hook fold orders them.
struct StartContext(Option<&'static str>);

#[async_trait]
impl HookRunner for StartContext {
    async fn run(&self, event: HookEvent, _cancel: CancellationToken) -> HookOutcome {
        match (event.name, self.0) {
            (HookEventName::SessionStart, Some(text)) => HookOutcome {
                messages: vec![
                    success_attachment("hook_ok", text),
                    context_attachment("hook_ctx", text),
                ],
                ..HookOutcome::default()
            },
            _ => HookOutcome::default(),
        }
    }
}

/// A SessionStart additional-context attachment as the hook fold writes it.
fn context_attachment(id: &str, text: &str) -> Message {
    Message::Attachment(AttachmentMessage {
        id: MessageId::new(id),
        source: "hook_additional_context".to_owned(),
        text: format!(
            "<system-reminder>\nSessionStart hook additional context: {text}\n</system-reminder>"
        ),
        data: json!({"hookName": "SessionStart", "hookEvent": "SessionStart", "content": [text]}),
    })
}

/// A `hook_success` attachment as the hook fold writes it for the SessionStart run.
fn success_attachment(id: &str, text: &str) -> Message {
    Message::Attachment(AttachmentMessage {
        id: MessageId::new(id),
        source: "hook_success".to_owned(),
        text: format!("SessionStart hook success: {text}"),
        data: json!({"hookName": "SessionStart", "hookEvent": "SessionStart"}),
    })
}

/// An automatic compaction keeps the last group, which starts at the last assistant message; the SessionStart context
/// `kept` follows that reply, so it is in the kept group.
fn history_keeping_context(kept: &str) -> Vec<Message> {
    vec![
        human("u1", "first"),
        reply("a1", "one", None),
        human("u2", "second"),
        reply("a2", "two", None),
        context_attachment("ctx_kept", kept),
    ]
}

/// Runs an automatic compaction whose SessionStart hook gives `hook`, and returns the result.
async fn compact_with_hook(
    hook: Option<&'static str>,
    history: Vec<Message>,
) -> rust_cli_kernel_api::compaction::CompactResult {
    let runner = ScriptedRunner::new(vec![Reply::Text("<summary>S</summary>".to_owned())]);
    let mut ports = ports(runner, no_tools());
    ports.hooks = Arc::new(StartContext(hook));
    Engine { ports: &ports }
        .run(
            &request(history, CompactTrigger::Auto),
            true,
            &CancellationToken::new(),
            None,
        )
        .await
        .unwrap()
}

/// The restored attachments with `source`, as their full text.
fn restored_sources(
    result: &rust_cli_kernel_api::compaction::CompactResult,
    source: &str,
) -> Vec<String> {
    result
        .restored
        .iter()
        .filter_map(|message| match message {
            Message::Attachment(attachment) if attachment.source == source => {
                Some(attachment.text.clone())
            }
            _ => None,
        })
        .collect()
}

/// The restored SessionStart context attachments, as their full text.
fn restored_contexts(result: &rust_cli_kernel_api::compaction::CompactResult) -> Vec<String> {
    result
        .restored
        .iter()
        .filter_map(|message| match message {
            Message::Attachment(attachment) if attachment.source == "hook_additional_context" => {
                Some(attachment.text.clone())
            }
            _ => None,
        })
        .collect()
}

/// Node `runCompactSessionStartHooks` skips a context equal to the latest one the compaction keeps (`preservedEntries`):
/// the group is not restored, and the result still reports that the hook gave a context.
#[tokio::test]
async fn a_compact_context_equal_to_the_kept_one_is_not_restored() {
    let result = compact_with_hook(Some("same"), history_keeping_context("same")).await;
    assert!(result.boundary.preserved.is_some(), "the context is kept");
    assert!(
        restored_contexts(&result).is_empty(),
        "{:?}",
        restored_contexts(&result)
    );
    assert!(result.session_start_context);
}

/// Node drops the whole hook group of a duplicate context, so the `hook_success` row does not pile up on every
/// compaction: neither attachment of the SessionStart(`compact`) run is restored, and the flag is still set.
#[tokio::test]
async fn a_duplicate_compact_group_drops_its_hook_success() {
    let result = compact_with_hook(Some("same"), history_keeping_context("same")).await;
    assert!(
        restored_sources(&result, "hook_success").is_empty(),
        "{:?}",
        restored_sources(&result, "hook_success")
    );
    assert!(restored_contexts(&result).is_empty());
    assert!(result.session_start_context);
}

/// A changed context restores its whole hook group: the `hook_success` attachment and the context, in that order.
#[tokio::test]
async fn a_changed_compact_group_restores_its_hook_success() {
    let result = compact_with_hook(Some("newer"), history_keeping_context("same")).await;
    assert_eq!(restored_sources(&result, "hook_success").len(), 1);
    assert_eq!(restored_contexts(&result).len(), 1);
    let group: Vec<&str> = result
        .restored
        .iter()
        .filter_map(|message| match message {
            Message::Attachment(attachment)
                if matches!(
                    attachment.source.as_str(),
                    "hook_success" | "hook_additional_context"
                ) =>
            {
                Some(attachment.source.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(group, ["hook_success", "hook_additional_context"]);
    assert!(result.session_start_context);
}

/// A changed context is restored, and the result reports it.
#[tokio::test]
async fn a_changed_compact_context_is_restored() {
    let result = compact_with_hook(Some("newer"), history_keeping_context("same")).await;
    let restored = restored_contexts(&result);
    assert_eq!(restored.len(), 1, "{restored:?}");
    assert!(restored[0].contains("newer"));
    assert!(result.session_start_context);
}

/// Only the kept history counts: a context that the compaction summarizes away does not stop the restore.
#[tokio::test]
async fn a_context_outside_the_kept_history_does_not_stop_the_restore() {
    let history = vec![
        context_attachment("ctx_old", "same"),
        human("u1", "first"),
        reply("a1", "one", None),
        human("u2", "second"),
        reply("a2", "two", None),
    ];
    let result = compact_with_hook(Some("same"), history).await;
    assert!(
        result.boundary.preserved.is_some(),
        "the last group is kept"
    );
    let restored = restored_contexts(&result);
    assert_eq!(restored.len(), 1, "{restored:?}");
    assert!(restored[0].contains("same"));
}

/// A SessionStart hook with no context leaves the flag off, so the session keeps its held result.
#[tokio::test]
async fn no_compact_context_leaves_the_flag_off() {
    let result = compact_with_hook(None, history_keeping_context("same")).await;
    assert!(restored_contexts(&result).is_empty());
    assert!(!result.session_start_context);
}
