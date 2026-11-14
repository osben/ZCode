//! 计划模式的 attachment（docs/specs/rust-cli/context.md §13，工作线 L11c）：`plan_mode`（完整、简略、
//! 子代理两种文本）、`plan_mode_exit`。计划是 ExitPlanMode 的 `plan` 参数，文本里不写计划文件路径（Node 3.17）。
//!
//! 模式与两个会话标志取 `ContextRequest.mode` / `plan_flags`（会话 actor 是唯一 owner，同一个快照），
//! 节奏从压缩边界之后的历史推导；退出看 `needs_exit_attachment` 或历史（§13.4）。context 不改标志：
//! actor 提交这里产生的 exit 时清掉对应的标志。

use rust_cli_kernel_api::env::{EnvPath, ReadFile};
use rust_cli_kernel_api::env_files::{FileKind, StatFile};
use rust_cli_kernel_api::message::{AttachmentMessage, Message, UserOrigin};
use rust_cli_kernel_api::orchestration::ContextRequest;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::plan::{self, PlanFiles, PlanModeFlags};
use rust_cli_kernel_api::tool_names;
use rust_cli_prompts::texts;
use serde_json::{Value, json};

use crate::PromptAssembler;

/// 来源（attachment type）。
pub(crate) const PLAN_MODE: &str = "plan_mode";
pub(crate) const REENTRY: &str = plan::REENTRY_SOURCE;
pub(crate) const EXIT: &str = plan::EXIT_SOURCE;
pub(crate) const PLAN_FILE_REFERENCE: &str = "plan_file_reference";
/// Node `PLAN_FILE_REFERENCE_MAX_BYTES`: `PLAN_MODE_MAX_PLAN_CHARS * 4 + 1024`.
const PLAN_FILE_REFERENCE_MAX_BYTES: u64 = 20_000 * 4 + 1024;
/// 两次 plan_mode 之间至少隔几次人类输入。
const TURNS_BETWEEN_ATTACHMENTS: usize = 5;
/// 每第几条 plan_mode 是完整提醒。
const FULL_REMINDER_EVERY_N_ATTACHMENTS: usize = 5;

/// 最近一条计划模式 attachment。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Last {
    /// `plan_mode`（旧会话里的 `plan_mode_reentry` 也算进入）。
    Entered,
    /// `plan_mode_exit`。
    Exited,
}

/// 这一步要发什么（不含 IO，便于单测）。
///
/// Node 3.17 没有再次进入的提醒（`plan_mode_reentry`）：每次进入都是普通的 `plan_mode`，所以这里不分叉。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Due {
    Nothing,
    /// 发 `plan_mode`，`full` 为完整提醒。
    Enter {
        full: bool,
    },
    Exit,
}

/// 本步的请求里是否看得到 AskUserQuestion（只影响子代理的提醒）。
fn asks_user_question(request: &ContextRequest) -> bool {
    request
        .tool_names
        .iter()
        .any(|name| name == tool_names::ASK_USER_QUESTION)
}

/// 从后往前读历史：最近一条计划模式 attachment、它之后的人类输入次数（遇到 exit 就停），
/// 以及最近的 exit 之后的 `plan_mode` 条数。
fn trail(history: &[Message]) -> (Option<Last>, usize, usize) {
    let (mut last, mut turns, mut since_exit) = (None, 0, 0);
    for message in history.iter().rev() {
        match message {
            Message::User(user) if last.is_none() && user.origin == UserOrigin::Human => {
                turns += 1;
            }
            Message::Attachment(attachment) => match attachment.source.as_str() {
                PLAN_MODE => {
                    last.get_or_insert(Last::Entered);
                    since_exit += 1;
                }
                REENTRY => {
                    last.get_or_insert(Last::Entered);
                }
                EXIT => {
                    last.get_or_insert(Last::Exited);
                    break;
                }
                _ => {}
            },
            _ => {}
        }
    }
    (last, turns, since_exit)
}

/// 按模式、会话标志与历史决定这一步的计划模式 attachment。
pub(crate) fn due(history: &[Message], mode: PermissionMode, flags: PlanModeFlags) -> Due {
    let (last, turns, since_exit) = trail(history);
    if mode != PermissionMode::Plan {
        // 退出：标志为真，或历史里（最近的退出之后）有 plan_mode / reentry。
        let entered = last == Some(Last::Entered);
        return if flags.needs_exit_attachment || entered {
            Due::Exit
        } else {
            Due::Nothing
        };
    }
    if last == Some(Last::Entered) && turns < TURNS_BETWEEN_ATTACHMENTS {
        return Due::Nothing;
    }
    Due::Enter {
        full: (since_exit + 1) % FULL_REMINDER_EVERY_N_ATTACHMENTS == 1,
    }
}

/// `plan_mode` 的文本（Node `buildRuntimeModeReminderBody`）：子代理、简略、完整。
/// 计划是 ExitPlanMode 的 `plan` 参数，提醒里不再提计划文件的路径。
/// `ask_user_question`：子代理只有看得到 AskUserQuestion 时才提它（Node 同样判断）。
fn reminder(full: bool, subagent: bool, ask_user_question: bool) -> &'static str {
    if subagent {
        return if ask_user_question {
            texts::plan_mode_subagent_ask()
        } else {
            texts::plan_mode_subagent()
        };
    }
    if full {
        texts::plan_mode_full()
    } else {
        texts::plan_mode_sparse()
    }
}

impl PromptAssembler {
    /// 本会话的计划文件（`<工作区>/.zcode/plans/plan-<会话>.md`，子代理是子会话的文件）与它是否存在；
    /// 执行环境答不出路径风格时为 None（不发计划模式 attachment）。文件只记在 attachment 的数据里，不进文本。
    pub(crate) async fn plan_file(&self, request: &ContextRequest) -> Option<(EnvPath, bool)> {
        let facts = match self.ports.info.path_facts(&request.workspace).await {
            Ok(facts) => facts,
            Err(error) => {
                tracing::warn!(%error, "path facts unavailable; skipping the plan mode attachments");
                return None;
            }
        };
        let path = PlanFiles::in_workspace(&facts, &request.workspace.root, &request.session)?
            .path(request.agent.as_ref());
        // 读得到文件才算存在。
        let stat = self
            .ports
            .files
            .stat(&request.workspace, StatFile { path: path.clone() })
            .await;
        let exists = matches!(stat, Ok(Some(stat)) if stat.kind == FileKind::File);
        Some((path, exists))
    }

    /// 压缩附件里的计划文件（Node `readApprovedPlanFileReferenceEntry`）：计划文件存在且去掉首尾空白后
    /// 非空时带上路径与原样内容，不看模式。超过字节上限或读失败时不带（Node 让压缩失败；这里只影响延续）。
    pub(crate) async fn post_compact_plan_file(
        &self,
        request: &ContextRequest,
    ) -> Option<AttachmentMessage> {
        let (path, exists) = self.plan_file(request).await?;
        if !exists {
            return None;
        }
        let stat = self
            .ports
            .files
            .stat(&request.workspace, StatFile { path: path.clone() })
            .await;
        if let Ok(Some(stat)) = &stat
            && stat.size > PLAN_FILE_REFERENCE_MAX_BYTES
        {
            tracing::warn!(
                size = stat.size,
                "plan file over the size cap; not referenced after compaction"
            );
            return None;
        }
        let content = match self
            .ports
            .files
            .read_file(&request.workspace, ReadFile { path: path.clone() })
            .await
        {
            Ok(content) => String::from_utf8_lossy(&content.bytes).into_owned(),
            Err(error) => {
                tracing::warn!(%error, "plan file unreadable; not referenced after compaction");
                return None;
            }
        };
        if content.trim().is_empty() {
            return None;
        }
        let text = plan_file_reference(path.as_str(), &content);
        let data = json!({ "planFilePath": path.as_str() });
        Some(self.attachment(PLAN_FILE_REFERENCE, (text, data)))
    }

    /// 压缩附件里的计划模式提醒：模式是 plan 时总是
    /// 一条完整的 `plan_mode`（不看节奏与再次进入）。以前由压缩后下一步的上下文按“边界之后还没发过”补发，
    /// F10 起当步 attachment 只在输入与工具轮之后产生，所以放进压缩附件（compact.md §3.4）。
    pub(crate) async fn post_compact_plan_mode(
        &self,
        request: &ContextRequest,
    ) -> Option<AttachmentMessage> {
        if request.mode != PermissionMode::Plan {
            return None;
        }
        let (path, exists) = self.plan_file(request).await?;
        let path = path.as_str();
        let subagent = request.agent.is_some();
        let data: Value = json!({
            "reminderType": "full",
            "isSubAgent": subagent,
            "planFilePath": path,
            "planExists": exists,
        });
        let text = reminder(true, subagent, asks_user_question(request));
        Some(self.attachment(PLAN_MODE, (text.to_owned(), data)))
    }

    /// 这一步的计划模式 attachment。
    pub(crate) async fn plan_mode(
        &self,
        request: &ContextRequest,
        history: &[Message],
    ) -> Vec<AttachmentMessage> {
        let due = due(history, request.mode, request.plan_flags);
        if due == Due::Nothing {
            return Vec::new();
        }
        let Some((path, exists)) = self.plan_file(request).await else {
            return Vec::new();
        };
        let path = path.as_str();
        match due {
            Due::Nothing => Vec::new(),
            Due::Exit => {
                let data = json!({"planFilePath": path, "planExists": exists});
                vec![self.attachment(EXIT, (texts::plan_mode_exit().to_owned(), data))]
            }
            Due::Enter { full } => {
                let subagent = request.agent.is_some();
                let data: Value = json!({
                    "reminderType": if full { "full" } else { "sparse" },
                    "isSubAgent": subagent,
                    "planFilePath": path,
                    "planExists": exists,
                });
                let text = reminder(full, subagent, asks_user_question(request));
                vec![self.attachment(PLAN_MODE, (text.to_owned(), data))]
            }
        }
    }
}

/// Node `formatPlanFileReference`.
fn plan_file_reference(path: &str, content: &str) -> String {
    format!(
        "A plan file exists from plan mode at: {path}\n\nPlan contents:\n\n{content}\n\nIf this plan is relevant to the current work and not already complete, continue working on it."
    )
}

#[cfg(test)]
#[path = "plan_mode_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "plan_mode_due_tests.rs"]
mod due_tests;
