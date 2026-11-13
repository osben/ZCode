//! 会话侧 hooks 的接线（docs/specs/rust-cli/session-lifecycle.md §3、hooks.md §7）。
//!
//! hook 都在子任务里跑：UserPromptSubmit 是回合任务的第一段（输入管线在 input.rs），SessionStart 是启动后台工作，
//! Notification 是可取消的计时任务，SessionEnd 在调用方的任务里跑。actor 只按 `HookOutcome`
//! 提交消息、改标题、决定流程，所以 hook 跑多久都不会挡住中断与 `view`。

use rust_cli_kernel_api::hooks::{HookContext, HookEvent, HookEventName, HookOutcome};
use rust_cli_kernel_api::ids::CommandId;
// 权限询问多久没回答才发 Notification（6000 ms）：只定义在 kernel-api，TUI 的终端通知用同一个值（F58：
// 以前这里与 tui 各写一份）。
use rust_cli_kernel_api::interaction::NOTIFY_AFTER as PERMISSION_NOTIFY_DELAY;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::session_api::{Delivery, EndReason, QueuedInput, StartSource};
use rust_cli_kernel_api::store::{Fact, SessionMeta, StoreError};
use serde_json::{Map, Value, json};
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::SessionDeps;
use crate::actor::{Actor, Job, JobDone};

fn source_name(source: StartSource) -> &'static str {
    match source {
        StartSource::Startup => "startup",
        StartSource::Resume => "resume",
        StartSource::Clear => "clear",
        StartSource::Compact => "compact",
        StartSource::Fork => "fork",
    }
}

fn reason_name(reason: EndReason) -> &'static str {
    match reason {
        EndReason::Clear => "clear",
        EndReason::Resume => "resume",
        EndReason::Logout => "logout",
        EndReason::PromptInputExit => "prompt_input_exit",
        EndReason::Other => "other",
    }
}

fn event(
    meta: &SessionMeta,
    name: HookEventName,
    payload: Value,
    context: HookContext,
) -> HookEvent {
    HookEvent {
        context,
        ..HookEvent::new(name, meta.id.clone(), meta.workspace.clone(), payload)
    }
}

/// SessionStart 的载荷：`{source, model, session_title?}`（hooks.md §7）。
pub(crate) fn session_start(
    meta: &SessionMeta,
    source: StartSource,
    selection: &ModelSelection,
) -> HookEvent {
    let mut payload = Map::new();
    payload.insert("source".into(), source_name(source).into());
    payload.insert("model".into(), selection.model.clone().into());
    if !meta.title.is_empty() {
        payload.insert("session_title".into(), meta.title.clone().into());
    }
    // prompt hook 的缺省模型经小模型槽位从当前主模型得出（model.md §6.1）。
    let context = HookContext {
        selection: Some(selection.clone()),
        ..HookContext::default()
    };
    event(
        meta,
        HookEventName::SessionStart,
        Value::Object(payload),
        context,
    )
}

/// SessionEnd：不影响流程，返回失败的 hook 的提示（给 stderr）。
pub(crate) async fn session_end(
    deps: &SessionDeps,
    meta: &SessionMeta,
    reason: EndReason,
) -> Vec<String> {
    if !deps.hooks.has_hooks(HookEventName::SessionEnd) {
        return Vec::new();
    }
    let payload = json!({"reason": reason_name(reason)});
    let event = event(
        meta,
        HookEventName::SessionEnd,
        payload,
        HookContext::default(),
    );
    deps.hooks
        .run(event, CancellationToken::new())
        .await
        .notices
}

/// SessionStart 给的首条输入的命令 ID 前缀。
pub(crate) const SESSION_START_INPUT: &str = rust_cli_kernel_api::session_api::SESSION_START_INPUT;

/// The SessionStart additional-context attachment (source `hook_additional_context`, `data.hookEvent`
/// `SessionStart`): the message the pending slot dedups (Node `latestSessionStartContext`).
pub(crate) fn is_session_start_context(message: &Message) -> bool {
    matches!(
        message,
        Message::Attachment(attachment)
            if attachment.source == "hook_additional_context"
                && attachment.data.get("hookEvent").and_then(Value::as_str)
                    == Some(HookEventName::SessionStart.as_str())
    )
}

fn attachment_text(message: &Message) -> Option<&str> {
    match message {
        Message::Attachment(attachment) => Some(attachment.text.as_str()),
        _ => None,
    }
}

impl Actor {
    /// actor 启动时：有 SessionStart hook 才进入"启动"后台工作（没有时不改变行为，无竞态）。
    pub(crate) fn start_session(&mut self, source: StartSource) {
        if !self.deps.hooks.has_hooks(HookEventName::SessionStart) {
            return;
        }
        let event = session_start(&self.meta, source, &self.selection);
        let hooks = self.deps.hooks.clone();
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task = self.deps.spawner.spawn("session-start", async move {
            JobDone::Startup(Box::new(hooks.run(event, token).await))
        });
        self.job = Some(Job {
            task,
            cancel: Some(cancel),
        });
    }

    /// SessionStart 的结果：hook 消息进待写槽（不写库，第一个回合写入，见 [`Self::commit_pending_session_start`]），
    /// 改标题，`initial_user_message` 排到队首（命令 ID 以
    /// [`SESSION_START_INPUT`] 开头：回合结束后单独一个回合，不与排队输入成批，lane.rs）。
    ///
    /// 只保留最新一次非空的结果（Node `stageSessionStartContext`）。以前这里写库：会话刚建的预热会话就有消息，
    /// 发第一条时 `createSession` 的预留被拒（`it already has a conversation`）。
    pub(crate) async fn finish_startup(&mut self, outcome: HookOutcome) {
        if !outcome.messages.is_empty() {
            self.pending_session_start = outcome.messages;
        }
        if let Some(title) = outcome.session_title {
            self.retitle(title).await;
        }
        if let Some(text) = outcome.initial_user_message {
            let command = CommandId::new(format!(
                "{SESSION_START_INPUT}{}",
                self.deps.ids.operation()
            ));
            // 排在最前（通道与队列的头部），回合结束后先开它。
            self.inbox.push_first(QueuedInput {
                edit_lock: None,
                intent: None,
                command,
                text,
                delivery: Delivery::Queue,
                kind: Default::default(),
                execution: None,
            });
            self.emit_queue();
        }
        self.start_next().await;
    }

    /// Node `commitPendingSessionStartContext`: writes the held SessionStart result before a turn's input. It runs
    /// at the top of `start_turn`, which is Node's `session_persistence` phase: before the turn's `TurnStarted`, the
    /// UserPromptSubmit hook and the input, and before the model request is built, so the first request holds the
    /// context. A context equal to the latest SessionStart context in the history is a duplicate, and the whole group
    /// goes with it (a reopen with unchanged output adds nothing). The slot is cleared only after the write succeeds.
    pub(crate) async fn commit_pending_session_start(&mut self) -> Result<(), StoreError> {
        if self.pending_session_start.is_empty() {
            return Ok(());
        }
        let latest = self
            .messages
            .iter()
            .rev()
            .find(|message| is_session_start_context(message))
            .and_then(attachment_text);
        let duplicate = self
            .pending_session_start
            .iter()
            .any(|message| is_session_start_context(message) && attachment_text(message) == latest);
        if !duplicate {
            let messages = self.pending_session_start.clone();
            let appended = self.append(None, messages, Vec::new()).await?;
            self.after_commit(appended).await;
        }
        self.pending_session_start.clear();
        Ok(())
    }

    /// 改标题：先提交，再改内存、发事件。
    pub(crate) async fn retitle(&mut self, title: String) {
        let fact = Fact::TitleChanged {
            title: title.clone(),
        };
        if let Err(reason) = self.commit(None, vec![fact]).await {
            tracing::warn!(%reason, "the hook title was not stored");
            return;
        }
        // hook 给的标题按 Node 记为 custom：之后不再自动生成（titles.md §4）。
        self.titles.mark_custom();
        self.set_title(title, rust_cli_kernel_api::title::Source::Custom);
    }

    /// UserPromptSubmit 的事件：`{prompt, session_title?}`，带当前模式（hooks.md §7）。
    pub(crate) fn user_prompt_submit(&self, text: &str) -> HookEvent {
        let mut payload = Map::new();
        payload.insert("prompt".into(), text.into());
        if !self.meta.title.is_empty() {
            payload.insert("session_title".into(), self.meta.title.clone().into());
        }
        let context = HookContext {
            mode: Some(self.mode()),
            selection: Some(self.selection.clone()),
            ..HookContext::default()
        };
        event(
            &self.meta,
            HookEventName::UserPromptSubmit,
            Value::Object(payload),
            context,
        )
    }

    /// 权限询问：6 s 内没有回答就发 Notification；回答或取消时（Pending 被丢弃）计时随之取消。
    pub(crate) fn notify_permission(&self, request: &InteractionRequest) -> Option<DropGuard> {
        let InteractionRequest::Permission { tool, .. } = request else {
            return None;
        };
        if !self.deps.hooks.has_hooks(HookEventName::Notification) {
            return None;
        }
        let payload = json!({
            "message": format!("ZCode needs your permission to use {tool}"),
            "notification_type": "permission_prompt",
        });
        let hook = event(
            &self.meta,
            HookEventName::Notification,
            payload,
            HookContext::default(),
        );
        let hooks = self.deps.hooks.clone();
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        drop(
            self.deps
                .spawner
                .spawn("permission-notification", async move {
                    tokio::select! {
                        () = token.cancelled() => {}
                        () = tokio::time::sleep(PERMISSION_NOTIFY_DELAY) => {
                            let _ = hooks.run(hook, token).await;
                        }
                    }
                }),
        );
        Some(cancel.drop_guard())
    }
}

#[cfg(test)]
#[path = "hooks_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "early_interrupt_tests.rs"]
mod early_interrupt_tests;
