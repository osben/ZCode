//! 执行状态的修改（docs/specs/rust-cli/tools-more.md §2.3、shell-permissions.md §4.6）。执行状态（权限模式 ×
//! plan 开关）只有会话 actor 一个 owner：前端的 `SetMode` / `SetPlan` 命令与工具的 `SessionOps::set_plan`
//! （EnterPlanMode、ExitPlanMode）走同一个入口，先提交 `ExecutionChanged` 事实，成功后才改内存里的状态并通知前端。
//! 主循环经 `SessionOps::view` 读判决用的模式（plan 开时是 plan），所以同一回合里后续的工具调用立即按新状态判决。
//! 工具不改权限模式（工作线 F134 删掉了没有调用方的 `Interactions::set_mode` 与这里的 `change_mode`）。
//!
//! 修复线 F20（用户决定）：plan 是独立开关。以前 plan 是一个模式，进入前的模式不在这里（TUI 记 `before_plan`，
//! ExitPlanMode 按审批的回答换模式）；现在权限模式一直在 actor 里，开关 plan 不动它，退出 plan 后就是进入前的值。
//!
//! 计划模式的两个会话标志也在这里（docs/specs/rust-cli/context.md §13.4）：改状态成功后按判决用的（旧, 新）
//! 模式更新，提交 `plan_mode_reentry` / `plan_mode_exit` 后清掉对应的标志。

use rust_cli_kernel_api::ids::{CommandId, InteractionId};
use rust_cli_kernel_api::interaction::PermissionAnswer;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::permission::{ExecutionState, PermissionMode};
use rust_cli_kernel_api::session_api::{Ack, CommandResult, InputExecution, KernelEvent};
use rust_cli_kernel_api::store::{Fact, StoreError};

use crate::actor::{Actor, rejected};

impl Actor {
    /// 判决、工具、上下文与 hook 看的模式：plan 开时是 plan，否则是权限模式。
    pub(crate) fn mode(&self) -> PermissionMode {
        self.execution.effective()
    }

    /// 工具开关 plan（EnterPlanMode、ExitPlanMode）：权限模式不变，不写项目的持久模式。
    /// Fork: `tool_call` (the plan tool's call) is reported after the change (`PlanTransition`).
    pub(crate) async fn change_plan(
        &mut self,
        enabled: bool,
        tool_call: Option<String>,
    ) -> Result<(), StoreError> {
        self.apply(None, self.execution.with_plan(enabled), false)
            .await?;
        if let Some(tool_call) = tool_call {
            self.log
                .append(KernelEvent::PlanTransition { tool_call, enabled });
        }
        Ok(())
    }

    /// 用户切换权限模式（前端的 `SetMode`，shift+tab 与 `/mode`）：同一批写本机项目的持久模式
    /// （docs/specs/rust-cli/config.md §2.2，Node `setMode` 写 `runtime.getMode()`，即切换后的权限模式；`plan`
    /// 只打开 plan，写的仍是当前的权限模式）。plan 开关不变（Node 的 `setMode` 会关掉 plan，见 spec 的待确认）。
    pub(crate) async fn user_mode(
        &mut self,
        command: CommandId,
        mode: PermissionMode,
    ) -> Result<(), StoreError> {
        self.apply(Some(command), self.execution.with_mode(mode), true)
            .await
    }

    /// 用户开关 plan（前端的 `SetPlan`，`/plan`）：同 App 的 plan 开关（Node `setExecutionState({planEnabled})`），
    /// 不写项目的持久模式。
    pub(crate) async fn user_plan(
        &mut self,
        command: CommandId,
        enabled: bool,
    ) -> Result<(), StoreError> {
        self.apply(Some(command), self.execution.with_plan(enabled), false)
            .await
    }

    /// Fork: an input's frozen execution state (`Command::SubmitWith`) when the input starts its turn:
    /// the model, then the mode and plan, each only when it differs; the mode is saved as the project
    /// mode like a user `SetMode`.
    pub(crate) async fn submitted_execution(
        &mut self,
        execution: InputExecution,
    ) -> Result<(), StoreError> {
        if let Some(selection) = execution.selection
            && selection != self.selection
        {
            self.select_model(None, selection).await?;
        }
        let next = execution.state;
        if next != self.execution {
            let save = next.mode != self.execution.mode;
            self.apply_with(None, next, save, false).await?;
        }
        Ok(())
    }

    /// Fork: an absorbed guide's frozen mode and Plan switch (`settle_steering`), applied to the running turn the way a
    /// user `SetMode` / `SetPlan` would be; the mode is saved as the project mode.
    pub(crate) async fn absorbed_execution(
        &mut self,
        next: rust_cli_kernel_api::permission::ExecutionState,
    ) -> Result<(), StoreError> {
        if next == self.execution {
            return Ok(());
        }
        let save = next.mode != self.execution.mode;
        self.apply(None, next, save).await
    }

    /// Fork (B3): the permission dialog's mode switch (`Command::GrantPermissionMode`, Node
    /// `resolvePermissionMode`). One actor step, the owner of the pending asks: check the ask, grant the mode, then
    /// answer the ask allow once. Every refusal comes before the commit, so a refused grant leaves the mode and the
    /// ask as they were (the user can retry or deny); after the commit the answer cannot fail.
    pub(crate) async fn grant_permission_mode(
        &mut self,
        command: CommandId,
        interaction: InteractionId,
        mode: PermissionMode,
    ) -> Ack {
        let Some(pending) = self
            .pending
            .iter()
            .find(|pending| pending.id == interaction)
        else {
            return Ack::Accepted {
                result: CommandResult::NotPending,
            };
        };
        if let Err(reason) = grantable(&pending.request, mode) {
            return rejected(reason);
        }
        // Node refuses while an input is reserved or drained outside the queue: it would keep its old mode.
        if self.inbox.foreground_reserved() || self.inbox.releasing() {
            return rejected(QUEUE_BUSY);
        }
        if let Err(error) = self
            .grant_mode(command.clone(), interaction.as_str().to_owned(), mode)
            .await
        {
            return rejected(error);
        }
        let allow = PermissionAnswer::Allow {
            remember: Vec::new(),
        };
        self.resolve(command, interaction, allow.into()).await
    }

    /// The session's permission mode becomes `mode` (plan kept, saved like a user `SetMode`) and so does every queued
    /// input's frozen mode (their plan switches kept); then `PermissionGranted`. The same mode as now is still a grant
    /// (Node does not short-circuit it).
    async fn grant_mode(
        &mut self,
        command: CommandId,
        interaction: String,
        mode: PermissionMode,
    ) -> Result<(), StoreError> {
        if self.execution.mode != mode {
            self.apply(Some(command), self.execution.with_mode(mode), true)
                .await?;
        }
        if self.inbox.set_queued_mode(mode) {
            self.emit_queue();
        }
        self.log
            .append(KernelEvent::PermissionGranted { interaction });
        Ok(())
    }

    async fn apply(
        &mut self,
        command: Option<CommandId>,
        next: ExecutionState,
        save: bool,
    ) -> Result<(), StoreError> {
        self.apply_with(command, next, save, true).await
    }

    /// `start_peers`: peer messages the new mode releases may start a turn at once; an input's own state
    /// (`submitted_execution`) passes `false` because that input's turn starts next.
    async fn apply_with(
        &mut self,
        command: Option<CommandId>,
        next: ExecutionState,
        save: bool,
        start_peers: bool,
    ) -> Result<(), StoreError> {
        let mut facts = vec![Fact::ExecutionChanged { state: next }];
        if save {
            facts.push(Fact::ProjectModeSet { mode: next.mode });
        }
        self.commit(command, facts).await?;
        let previous = self.execution;
        self.plan_flags = self
            .plan_flags
            .after_transition(previous.effective(), next.effective());
        self.execution = next;
        if previous.mode != next.mode {
            self.log
                .append(KernelEvent::ModeChanged { mode: next.mode });
            // 模式类别可能变了：扣住的同伴消息重新判断（cross-session.md §1.6）。
            self.peers_mode_changed(start_peers).await;
        }
        if previous.plan != next.plan {
            self.log
                .append(KernelEvent::PlanChanged { enabled: next.plan });
        }
        Ok(())
    }

    /// 已提交的消息若是 context 产生的 reentry / exit，清掉对应的标志。
    pub(crate) fn plan_attachment_committed(&mut self, message: &Message) {
        if let Message::Attachment(attachment) = message {
            self.plan_flags = self.plan_flags.after_commit(&attachment.source);
        }
    }
}

/// Node `interaction-registry.ts`: the ask is no permission ask of the session itself, or an independent confirmation.
const NOT_SUPPORTED: &str = "Full access is not supported for this interaction";
/// Node `interaction-broker.ts`: a once-ask (guarded already) takes only full access.
const ALREADY_GUARDED: &str = "Already in autonomous mode";
/// Node `permission-full-access.ts`.
const QUEUE_BUSY: &str = "Queue mutation is busy; retry approval";

/// Fork (B3): whether `request` may grant `mode` (Node's broker registers the grant hook only for an ask without
/// `origin` and `optionsPolicy`; a user-once ask takes only `yolo`).
fn grantable(request: &InteractionRequest, mode: PermissionMode) -> Result<(), &'static str> {
    let InteractionRequest::Permission {
        once,
        independent,
        origin: None,
        ..
    } = request
    else {
        return Err(NOT_SUPPORTED);
    };
    if *independent
        || !matches!(
            mode,
            PermissionMode::BypassPermissions | PermissionMode::Guarded
        )
    {
        return Err(NOT_SUPPORTED);
    }
    if *once && mode != PermissionMode::BypassPermissions {
        return Err(ALREADY_GUARDED);
    }
    Ok(())
}

#[cfg(test)]
#[path = "mode_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "plan_flags_tests.rs"]
mod plan_flags_tests;
