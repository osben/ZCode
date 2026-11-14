//! 工具执行管线（校验、hooks、权限、调用与结果预算）。
//!
//! 顺序：schema 校验 → 工具自己的 `validate_input` → PreToolUse hooks → 权限判决（需要时先跑
//! PermissionRequest hooks，再询问用户）→ 执行 → PostToolUse / PostToolUseFailure hooks。任何一步拒绝
//! 都返回 `is_error` 的结果，不进入下一步。hook 的决定与判决链的先后、hook 消息的位置见
//! docs/specs/rust-cli/hooks.md §6。

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::js::string::utf16_prefix;
use rust_cli_kernel_api::message::ToolResultContent;
use rust_cli_kernel_api::orchestration::{
    HookEventName, HookRunner, InteractionRequest, PermissionAnswer, PermissionGate, ToolExecution,
    ToolExecutor,
};
use rust_cli_kernel_api::permission::{PermissionDecision, PermissionRule};
use rust_cli_kernel_api::tool::{
    Tool, ToolCallOutput, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation,
};
use rust_cli_kernel_api::unparsed_input;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::budget;
use crate::pipeline_hooks::{self as hooks, HookMessages};
use crate::pipeline_machine::{Machines, Routed, tag};
use crate::texts;
use crate::validate::{strip_unknown, validate};

pub(crate) const REJECT_MESSAGE: &str = rust_cli_kernel_api::tool::REJECT_MESSAGE;
/// Fork: the Node agent's denial with feedback (`buildPermissionDeniedContent`, bootstrap `permission-options.ts`):
/// the full denial, STOP sentence included, then the user's words.
pub(crate) const REJECT_WITH_REASON: &str = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed. To tell you how to proceed, the user said:\n";
/// 工具使用被中断时的文字（kernel-api 的定义，F55）。
const INTERRUPT_FOR_TOOL_USE: &str = rust_cli_kernel_api::user_input::INTERRUPT_TEXTS[1];
/// Node's message of a cancelled call (`timeout.ts` `executeWithTimeout`, `CoreErrorType.ToolCancelled`).
const NODE_TOOL_CANCELLED: &str = "Tool execution cancelled";
const NO_OUTPUT: &str = "Command failed with no output";
/// `formatError` 超过这个长度（UTF-16 单元）时保留首尾各一半。
const ERROR_LIMIT: usize = 10_000;

/// 执行管线；权限判决链、hooks 与执行环境的注册表由 runtime 注入。
pub struct Pipeline {
    gate: Arc<dyn PermissionGate>,
    hooks: Arc<dyn HookRunner>,
    /// 按调用的 `machine` 选机器（R3，remote-exec.md §20.6）；没有时不路由。
    machines: Machines,
    /// Fork: the incognito tool gate; a tool the session's profile removes is not called even when the model names
    /// it (specs/fork-rust-agent-parity.md, "Incognito sessions").
    incognito: Option<Arc<dyn rust_cli_kernel_api::incognito::IncognitoToolGate>>,
    /// Fork (node_desktop): Node's hook semantics. PreToolUse messages follow the tool result, as Node's post-batch
    /// reminders, and the PermissionRequest input names the call (specs/fork-rust-agent-parity.md "Tool hook context
    /// after the tool result", "Command hook stdin").
    node_hooks: bool,
}

/// 子代理里的询问被拒时的结果文字（主线程是 [`REJECT_MESSAGE`]，docs/specs/rust-cli/agents.md §4.1.1）。
const SUBAGENT_REJECT: &str = "Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.";
const SUBAGENT_REJECT_WITH_REASON: &str = "Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user said:\n";

/// 用户拒绝（或撤回询问）时给模型的文字：子代理里的调用用子代理的那一段。
///
/// 修复线 F67：以前子代理与主线程同一段（`The user doesn't want to proceed …`）；子代理被拒时应该换个做法或报告限制，
/// 而不是停下来等用户。
fn rejection(context: &ToolUseContext, feedback: Option<&str>) -> String {
    match (context.agent.is_some(), feedback) {
        (false, Some(feedback)) if !feedback.trim().is_empty() => {
            format!("{REJECT_WITH_REASON}{}", feedback.trim())
        }
        (false, _) => REJECT_MESSAGE.to_owned(),
        (true, None) => SUBAGENT_REJECT.to_owned(),
        (true, Some(feedback)) => format!("{SUBAGENT_REJECT_WITH_REASON}{feedback}"),
    }
}

/// 拒绝的来源：PreToolUse hook 拒绝时，它的停止说明随结果交出（只在这类拒绝后交出）。
enum Rejection {
    ByHook(ToolOutput),
    Other(ToolOutput),
}

fn error(text: String) -> ToolOutput {
    ToolOutput {
        content: vec![ToolResultContent::Text { text }],
        is_error: true,
        display: Value::Null,
    }
}

/// 用户拒绝时的结果（拒绝文本、`is_error`）；提问与计划审批的工具在 `call` 里用它。
pub(crate) fn rejected(text: String) -> ToolOutput {
    error(text)
}

/// 一次权限询问：文字、建议规则与“只批准这一次”（判决链或 PreToolUse hook 的 `Ask`）。
struct Asking {
    message: String,
    suggestions: Vec<PermissionRule>,
    once: bool,
    independent: bool,
}

fn wrapped(text: &str) -> ToolOutput {
    error(format!("<tool_use_error>{text}</tool_use_error>"))
}

/// 错误文本：空消息换成固定文本，过长时保留首尾各 5000 个 UTF-16 单元。
fn format_error(message: &str) -> String {
    let message = message.trim();
    if message.is_empty() {
        return NO_OUTPUT.to_owned();
    }
    let length = message.encode_utf16().count();
    if length <= ERROR_LIMIT {
        return message.to_owned();
    }
    let half = ERROR_LIMIT / 2;
    let start = utf16_prefix(message, half);
    let end_units = length - half;
    let end = &message[utf16_prefix(message, end_units).len()..];
    format!(
        "{start}\n\n... [{} characters truncated] ...\n\n{end}",
        length - ERROR_LIMIT
    )
}

impl Pipeline {
    pub fn new(gate: Arc<dyn PermissionGate>, hooks: Arc<dyn HookRunner>) -> Self {
        Self {
            gate,
            hooks,
            machines: Machines::default(),
            incognito: None,
            node_hooks: false,
        }
    }

    /// Fork: Node's hook semantics (the Node desktop agent): PreToolUse messages after the tool result, before the
    /// PostToolUse ones, and `tool_use_id` in the PermissionRequest input.
    #[must_use]
    pub fn with_node_hooks(mut self, node_hooks: bool) -> Self {
        self.node_hooks = node_hooks;
        self
    }

    /// Fork: check every call against the session's incognito profile.
    #[must_use]
    pub fn with_incognito(
        mut self,
        gate: Arc<dyn rust_cli_kernel_api::incognito::IncognitoToolGate>,
    ) -> Self {
        self.incognito = Some(gate);
        self
    }

    /// 接上执行环境的注册表：带 `machine` 参数的工具按调用选机器（remote-exec.md §20.6）。
    #[must_use]
    pub fn with_machines(
        mut self,
        registry: Arc<dyn rust_cli_kernel_api::env_registry::EnvironmentRegistry>,
    ) -> Self {
        self.machines = Machines::new(registry);
        self
    }

    /// 判决链或 hook 改过的输入要重新通过 schema。
    fn revalidate(tool: &dyn Tool, schema: &Value, input: Value) -> Result<Value, ToolOutput> {
        match validate(tool.name(), schema, &input) {
            Some(message) => Err(wrapped(&format!("InputValidationError: {message}"))),
            None => Ok(input),
        }
    }

    /// 询问用户；先跑 PermissionRequest hooks（D10：跑完再决定是否询问）。返回 hook 改过的输入。
    /// 取消时按拒绝处理（中断的结果由执行器统一替换）。
    async fn ask(
        &self,
        tool: &dyn Tool,
        input: &Value,
        asking: Asking,
        call: &Routed,
    ) -> Result<Option<Value>, ToolOutput> {
        let context = &call.context;
        let Asking {
            message,
            suggestions,
            once,
            independent,
        } = asking;
        // 修复线 F20：guarded 的危险命令只批准这一次（Node `approvalMode: "user-once"` 时 `runHooks: false`）：
        // 不跑 PermissionRequest hooks，hook 不能替用户批准；没有“总是允许”（判决链不给建议规则）。工作线 F137：这个事实
        // 随判决给出（`Ask.once`），不再另问判决链（以前的 `ask_once` 又取一次执行环境的路径风格）。
        if !once {
            let mut payload = hooks::permission_request(tool.name(), input, &suggestions);
            // Node's PermissionRequest input carries the call id (`toolCallId`, alias `tool_use_id`).
            if self.node_hooks {
                payload["tool_use_id"] = Value::from(context.tool_use.as_str());
            }
            let payload = tag(payload, &call.machine);
            let event = hooks::event(HookEventName::PermissionRequest, &call.hooks, payload).await;
            let request = self.hooks.run(event, context.cancel.clone()).await;
            match request.decision {
                Some(PermissionDecision::Allow { .. }) => return Ok(request.updated_input),
                Some(PermissionDecision::Deny { message }) => return Err(error(message)),
                Some(PermissionDecision::Ask { .. } | PermissionDecision::Passthrough) | None => {}
            }
        }
        // “不再询问”一行的种子与建议规则出自同一套命令分析（shell-permissions.md §4.10）；前端不再自己算（F133）。
        let rule_seed = rust_cli_policy::ask_rule_seed(tool.name(), input, &suggestions);
        let request = InteractionRequest::Permission {
            origin: None,
            tool_use: context.tool_use.clone(),
            tool: tool.name().to_owned(),
            input: input.clone(),
            message: message.clone(),
            suggestions,
            rule_seed,
            asked_by: None,
            // 额外机器上的调用，询问带机器名（R3，remote-exec.md §20.8；主 env 不写出）。
            machine: call.machine.clone(),
            once,
            independent,
        };
        let Ok(answer) = crate::asking::ask::<PermissionAnswer>(context, request).await else {
            return Err(error(rejection(context, None)));
        };
        match answer {
            Some(PermissionAnswer::Allow { remember }) => {
                // “总是允许”：会话 actor 已把规则与交互的解决同一批落库；判决链按 `/permissions` 的路径读回库值、换上
                // LocalSettings 层（shell-permissions.md §5）。修复（R1-2）：以前这里交给判决链另存一份按会话的规则，
                // 子代理与 `/clear` 之后的新会话看不到，又问一次。
                // 规则只有一套，存在本机的项目里：用会话的工作区（远端调用的上下文换了工作区，R3）。
                if !remember.is_empty() {
                    self.gate.local_rules_committed(&call.hooks.workspace).await;
                }
                Ok(None)
            }
            Some(PermissionAnswer::Deny {
                feedback: Some(feedback),
            }) if !feedback.trim().is_empty() => Err(error(rejection(context, Some(&feedback)))),
            // 没有人能回答（-p）：模型收到询问本身的文本。
            Some(PermissionAnswer::Unavailable) => Err(error(message)),
            // 修 bug（工作线 F69）：`-p` 的后台子代理以前也给询问本身的文本；它所在的上下文不能询问，PermissionRequest
            // hooks（上面已跑）没有结论时给“不能询问”的拒绝文字（agents.md §4.1.1）。
            Some(PermissionAnswer::NoPrompts) => Err(error(
                rust_cli_policy::texts::prompts_unavailable(tool.name()),
            )),
            Some(PermissionAnswer::Deny { .. }) | None => Err(error(rejection(context, None))),
        }
    }

    /// 询问并换上 PermissionRequest hook 改过的输入。
    async fn ask_for(
        &self,
        tool: &dyn Tool,
        schema: &Value,
        input: Value,
        asking: Asking,
        call: &Routed,
    ) -> Result<Value, ToolOutput> {
        match self.ask(tool, &input, asking, call).await? {
            Some(updated) => Self::revalidate(tool, schema, updated),
            None => Ok(input),
        }
    }

    /// 完整的权限判决链。
    async fn decide(
        &self,
        tool: &dyn Tool,
        schema: &Value,
        input: Value,
        call: &Routed,
    ) -> Result<Value, ToolOutput> {
        match self.gate.decide(tool, &input, &call.context).await {
            PermissionDecision::Allow {
                updated_input: Some(updated),
            } => Self::revalidate(tool, schema, updated),
            PermissionDecision::Allow {
                updated_input: None,
            } => Ok(input),
            PermissionDecision::Deny { message } => Err(error(message)),
            PermissionDecision::Ask {
                message,
                suggestions,
                once,
                independent,
            } => {
                let asking = Asking {
                    message,
                    suggestions,
                    once,
                    independent,
                };
                self.ask_for(tool, schema, input, asking, call).await
            }
            // 没有理由的询问文字只在 policy 的 `texts`（F132 的 T15：以前这里内联了同一句）。
            PermissionDecision::Passthrough => {
                let asking = Asking {
                    message: rust_cli_policy::texts::request_message(tool.name(), None),
                    suggestions: Vec::new(),
                    once: false,
                    independent: false,
                };
                self.ask_for(tool, schema, input, asking, call).await
            }
        }
    }

    /// 校验、机器路由、PreToolUse hooks 与权限；通过时返回最终输入与路由后的上下文。
    async fn admit(
        &self,
        tool: &dyn Tool,
        mut input: Value,
        context: ToolUseContext,
        messages: &mut HookMessages,
    ) -> Result<(Value, Routed), Rejection> {
        // R5-1：输入在组装时不是合法 JSON（标记对象，kernel-api `unparsed_input`）：先于 schema 校验
        // 给出 JSON 解析失败的说明，不跑 hooks 与权限。
        if let Some(unparsed) = unparsed_input::parse(&input) {
            let message = texts::unparsed_input(tool.name(), unparsed.raw, unparsed.len);
            return Err(Rejection::Other(wrapped(&format!(
                "InputValidationError: {message}"
            ))));
        }
        // F98（remote-exec.md §25.2.2）：点名清单里有、没连上的机器时回“没有执行”，先于 schema 校验与去键。
        if let Some(message) = self.machines.not_connected(tool, &input) {
            return Err(Rejection::Other(wrapped(&message)));
        }
        let schema = tool.input_schema();
        // R3（remote-exec.md §20.6）：有远端机器时，去键与校验用加了 `machine` 的 schema（发给模型的同一组取值）。
        let plan = self.machines.plan(tool, &context);
        let checked = Machines::schema(schema.clone(), &plan);
        // 修复线 F51（agents.md §2）：宽松对象的工具（Agent）丢掉 schema 外的键、不报错，之后的 hook、
        // `validate_input` 与 `call` 都用丢掉之后的输入。以前一律按严格对象，
        // 模型给 Agent 传了 schema 外的键（例如 F51 删掉的 `model`）就报 InputValidationError。
        if tool.strips_unknown_keys() {
            input = strip_unknown(&checked, input);
        }
        if let Some(message) = validate(tool.name(), &checked, &input) {
            return Err(Rejection::Other(wrapped(&format!(
                "InputValidationError: {message}"
            ))));
        }
        let call = self
            .machines
            .route(tool, &mut input, context, &plan)
            .map_err(|message| Rejection::Other(wrapped(&message)))?;
        let context = &call.context;
        // Fork: a tool that runs in the workspace is refused while the session's execution worktree is gone, like
        // Node's `getMissingExecutionWorktreeToolError`; nothing runs in or recreates it. An ordinary session is not
        // guarded (`missing_workspace`).
        if tool.machine_param() == rust_cli_kernel_api::machine_param::MachineParam::RunsThere
            && let Some(message) = crate::common::missing_workspace(context).await
        {
            return Err(Rejection::Other(wrapped(&message)));
        }
        if let Validation::Invalid { message, .. } = tool.validate_input(&input, context).await {
            return Err(Rejection::Other(wrapped(&message)));
        }
        let payload = tag(
            hooks::pre_tool_use(tool.name(), &input, context),
            &call.machine,
        );
        let event = hooks::event(HookEventName::PreToolUse, &call.hooks, payload).await;
        let mut pre = self.hooks.run(event, context.cancel.clone()).await;
        hooks::take_pre(messages, &mut pre);
        if let Some(updated) = pre.updated_input.take() {
            if let Some(message) = validate(tool.name(), &schema, &updated) {
                return Err(Rejection::ByHook(error(format!(
                    "PreToolUse hook for {} returned updatedInput that failed schema validation: {message}",
                    tool.name()
                ))));
            }
            input = updated;
        }
        let other = Rejection::Other;
        let input = match pre.decision {
            Some(PermissionDecision::Deny { message }) => Err(Rejection::ByHook(error(message))),
            // hook 放行：deny / ask 规则与安全路径仍然生效（不可绕过的权限关卡）。
            Some(PermissionDecision::Allow { .. }) => {
                match self.gate.check_rules(tool, &input, context).await {
                    Some(PermissionDecision::Deny { message }) => Err(other(error(message))),
                    Some(PermissionDecision::Ask { .. }) => self
                        .decide(tool, &schema, input, &call)
                        .await
                        .map_err(other),
                    Some(PermissionDecision::Allow { .. } | PermissionDecision::Passthrough)
                    | None => Ok(input),
                }
            }
            // hook 要求询问：用 hook 的原因询问。hook 的询问不是“只批准这一次”（危险命令时 `check_rules` 一定拒绝或询问，
            // 走上面两支）。
            Some(PermissionDecision::Ask {
                message,
                suggestions,
                once,
                independent,
            }) => match self.gate.check_rules(tool, &input, context).await {
                Some(PermissionDecision::Deny { message }) => Err(other(error(message))),
                Some(PermissionDecision::Ask { .. }) => self
                    .decide(tool, &schema, input, &call)
                    .await
                    .map_err(other),
                Some(PermissionDecision::Allow { .. } | PermissionDecision::Passthrough) | None => {
                    let asking = Asking {
                        message,
                        suggestions,
                        once,
                        independent,
                    };
                    self.ask_for(tool, &schema, input, asking, &call)
                        .await
                        .map_err(other)
                }
            },
            Some(PermissionDecision::Passthrough) | None => self
                .decide(tool, &schema, input, &call)
                .await
                .map_err(other),
        }?;
        Ok((input, call))
    }

    /// 执行并跑 PostToolUse / PostToolUseFailure hooks。
    async fn call(
        &self,
        tool: &dyn Tool,
        input: Value,
        call: Routed,
        progress: mpsc::Sender<ToolProgress>,
        messages: &mut HookMessages,
    ) -> ToolOutput {
        let Routed {
            context,
            hooks: session,
            machine,
        } = call;
        let machine = &machine;
        match tool
            .call_with_messages(input.clone(), context.clone(), progress)
            .await
        {
            Ok(ToolCallOutput {
                mut output,
                mut new_messages,
                stop_turn,
            }) => {
                messages.stop_turn |= stop_turn;
                let payload = tag(
                    hooks::post_tool_use(tool.name(), &input, &output, &context),
                    machine,
                );
                let event = hooks::event(HookEventName::PostToolUse, &session, payload).await;
                let mut post = self.hooks.run(event, context.cancel.clone()).await;
                messages.after.append(&mut post.messages);
                // 工具自己的后续消息（Skill 的正文）排在 PostToolUse 的消息之后
                // （docs/specs/rust-cli/ext.md §2.4）。
                messages.after.append(&mut new_messages);
                if let Some(replacement) = post.updated_tool_output.take() {
                    hooks::replace_output(&mut output, replacement);
                }
                // hook 看到的是原始结果；给模型的结果再按预算落盘（在 hook 之后持久化）。
                budget::apply(
                    output,
                    tool.name(),
                    tool.max_result_size_chars(),
                    &context.session,
                    context.artifacts.as_ref(),
                )
                .await
            }
            Err(failure) => {
                // Fork: a call stopped on its own keeps its display and reaches the model as its own message (Node keeps
                // the `ToolCancelled` text), while the hooks see an interrupt (Node `isInterrupt`).
                let (failure, display) = match failure {
                    ToolError::Stopped { message, display } => (Err(message), display),
                    other => (Ok(other), Value::Null),
                };
                let interrupted = matches!(failure, Ok(ToolError::Cancelled) | Err(_));
                // Node's CoreError type of the failure (`error_details.type`).
                let kind = match &failure {
                    Ok(ToolError::InvalidInput { .. }) => "invalid_input",
                    Ok(ToolError::Cancelled) | Err(_) => "tool_cancelled",
                    Ok(_) => "tool_execution_failed",
                };
                let text = match &failure {
                    Ok(ToolError::Cancelled) => INTERRUPT_FOR_TOOL_USE.to_owned(),
                    Ok(other) => format_error(&other.to_string()),
                    Err(message) => message.clone(),
                };
                // Fork: Node's failure hook gets the raw `error.message` in `error` and `error_details`
                // (`hook-flow.ts` `runPostToolUseFailureHooks`); only the model's text is trimmed and limited.
                let hook_text = match &failure {
                    _ if !self.node_hooks => text.clone(),
                    Ok(ToolError::Cancelled) => NODE_TOOL_CANCELLED.to_owned(),
                    Ok(ToolError::InvalidInput { message } | ToolError::Failed { message }) => {
                        message.clone()
                    }
                    Ok(other) => other.to_string(),
                    Err(message) => message.clone(),
                };
                let mut payload = hooks::post_tool_use_failure(
                    tool.name(),
                    &input,
                    &hook_text,
                    interrupted,
                    &context,
                );
                // Node's failure input carries the error object next to its message (`error_details`).
                if self.node_hooks {
                    payload["error_details"] =
                        serde_json::json!({"message": hook_text, "type": kind});
                }
                let payload = tag(payload, machine);
                let event =
                    hooks::event(HookEventName::PostToolUseFailure, &session, payload).await;
                let mut post = self.hooks.run(event, context.cancel.clone()).await;
                messages.after.append(&mut post.messages);
                ToolOutput {
                    display,
                    ..error(text)
                }
            }
        }
    }
}

/// The answer to a tool the session does not offer (the incognito gate and the turn limits), the text an unregistered
/// tool gets.
fn no_such_tool(name: &str) -> ToolOutput {
    error(format!(
        "<tool_use_error>Error: No such tool available: {name}</tool_use_error>"
    ))
}

#[async_trait]
impl ToolExecutor for Pipeline {
    async fn execute(
        &self,
        tool: Arc<dyn Tool>,
        input: Value,
        context: ToolUseContext,
        progress: mpsc::Sender<ToolProgress>,
    ) -> ToolExecution {
        if self
            .incognito
            .as_ref()
            .is_some_and(|gate| gate.hides(&context.session, tool.as_ref()))
        {
            // Same answer as a tool that is not registered: the session never had it.
            return ToolExecution::output(no_such_tool(tool.name()));
        }
        // Fork: a tool the running turn hides (an automation turn's mutation tools, the Host's disallowlist,
        // CronPauseSelf outside an automation turn) answers like an unregistered one when the model names it anyway
        // (specs/fork-rust-automations.md). Without a session view the turn's limits are unknown: the automation
        // tools fail closed.
        let hidden = match context.session_ops.view().await {
            Some(view) => view.turn.hides(tool.name()),
            None => rust_cli_kernel_api::turn_limits::TurnLimits::hides_without_view(tool.name()),
        };
        if hidden {
            return ToolExecution::output(no_such_tool(tool.name()));
        }
        let mut messages = HookMessages {
            pre_after_result: self.node_hooks,
            ..HookMessages::default()
        };
        let (input, call) = match self
            .admit(tool.as_ref(), input, context, &mut messages)
            .await
        {
            Ok(admitted) => admitted,
            Err(Rejection::ByHook(output)) => return messages.finish(output, true),
            Err(Rejection::Other(output)) => return messages.finish(output, false),
        };
        let output = self
            .call(tool.as_ref(), input, call, progress, &mut messages)
            .await;
        messages.finish(output, true)
    }
}

#[cfg(test)]
#[path = "pipeline_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "pipeline_hook_tests.rs"]
mod hook_tests;

#[cfg(test)]
#[path = "pipeline_message_tests.rs"]
mod message_tests;

#[cfg(test)]
#[path = "pipeline_machine_tests.rs"]
mod machine_tests;
