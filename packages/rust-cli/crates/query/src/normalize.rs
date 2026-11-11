//! 会话消息 → 发给模型的 API 消息（规则见 docs/specs/rust-cli/context.md §3）。
//!
//! 1. attachment 上浮：排到它前面的人类输入之前，直到遇到 assistant 或工具结果；
//! 2. user 角色的 attachment 并进相邻的 user 消息；system 角色的 attachment 去掉
//!    `<system-reminder>` 包装后用空行连接，在下一条 assistant 之前或末尾折叠成一条
//!    `role: system` 消息（模型不支持时按 user 角色处理）；带内容块的 attachment（图片等）不折叠，
//!    按 user 处理（折叠只收纯文字）；
//! 3. 相邻 user 消息合并时，前一条以文本结尾、后一条以文本开头就在前一段文本后补一个换行，
//!    工具结果排在最前；按 user 角色接上的提醒遇到末尾的工具结果时并进它（kernel-api `reminder_fold`）；
//! 4. 人类插话（`queued_command`、`commandMode: prompt`）在有 system turn 时按人类输入：去掉包装，作为文本块接在上一条
//!    user 消息（工具结果）后面（context.md §3 第 10 条）；
//! 5. 每轮 effort：人类输入之后的 effort 与上次说过的不同时，挂在
//!    紧跟其后的 system 消息上（没有就插一条只带 `output_config` 的 system 消息）；
//! 6. 最后一条有内容的消息的最后一个块打缓存断点（默认计划）；摘要请求
//!    （不写缓存）往前挪一条；
//! 7. 每条 assistant 里 tool_use 移到末尾（context.md §3 第 11 条），合并之后做配对兜底（第 12 条，`pairing`）。
//!
//! 其余规则（tool_reference 剥离、thinking 清理、错误结果去图等）属于工作线 L1。

use std::collections::HashMap;

use rust_cli_kernel_api::hooks::queued_command;
use rust_cli_kernel_api::ids::ToolUseId;
use rust_cli_kernel_api::message::{AttachmentRole, ContentBlock, Message};
use rust_cli_kernel_api::model::{ApiContent, ApiMessage, ApiRole, CacheControl, TurnOutputConfig};
use rust_cli_kernel_api::reminder_fold::{array_result, fold_into_tool_result};
use rust_cli_prompts::reminder;

/// normalize 的选项（随模型变化）。
#[derive(Debug, Clone, Default)]
pub(crate) struct NormalizeOptions {
    /// 模型接受对话中间的 `role: system` 消息。
    pub system_turns: bool,
    /// 模型接受每轮的 effort（beta `per-turn-control`）时，这次请求的 effort。
    pub turn_effort: Option<String>,
    /// 摘要请求不写缓存：断点往前挪一条（[`skip_write_marker`]）。
    pub skip_cache_write: bool,
    /// Fork: OpenAI-compatible protocols (`ModelCapabilities::separate_user_messages`). Every user message, reminder and
    /// media attachment becomes its own message: no adjacent-user merge and no reminder fold into tool results, like
    /// Node when `foldRemindersIntoToolResults` is off.
    pub separate_user_messages: bool,
}

fn message(role: ApiRole, content: Vec<ApiContent>) -> ApiMessage {
    ApiMessage {
        role,
        content,
        output_config: None,
    }
}

fn plain(blocks: Vec<ContentBlock>) -> Vec<ApiContent> {
    blocks
        .into_iter()
        // Fork: an attached file reaches the model as its reminders or image (kernel-api `prompt_attachment::blocks`).
        .flat_map(|block| match block {
            ContentBlock::File { file } => rust_cli_kernel_api::prompt_attachment::blocks(&file),
            block => vec![block],
        })
        .map(|block| ApiContent {
            block,
            cache_control: None,
            meta: false,
        })
        .collect()
}

fn text(value: String) -> ApiContent {
    ApiContent {
        block: ContentBlock::Text { text: value },
        cache_control: None,
        meta: false,
    }
}

/// 停止上浮的位置：assistant，或以工具结果开头的 user 消息。
fn stops_hoisting(message: &Message) -> bool {
    match message {
        Message::Assistant(_) => true,
        Message::User(user) => {
            matches!(user.content.first(), Some(ContentBlock::ToolResult { .. }))
        }
        Message::Attachment(_) | Message::System(_) => false,
    }
}

/// attachment 上浮：从后往前扫，attachment 越过普通 user 消息，
/// 停在最近的 assistant / 工具结果之后。
fn hoist(messages: Vec<&Message>) -> Vec<&Message> {
    if !messages
        .iter()
        .any(|message| matches!(message, Message::Attachment(_)))
    {
        return messages;
    }
    let mut reversed: Vec<&Message> = Vec::with_capacity(messages.len());
    let mut pending: Vec<&Message> = Vec::new();
    for message in messages.into_iter().rev() {
        if matches!(message, Message::Attachment(_)) {
            pending.push(message);
            continue;
        }
        if stops_hoisting(message) {
            reversed.append(&mut pending);
        }
        reversed.push(message);
    }
    reversed.append(&mut pending);
    reversed.reverse();
    reversed
}

/// 工具结果排在最前，其余保持原序。
fn tool_results_first(content: &mut Vec<ApiContent>) {
    let (mut results, rest): (Vec<_>, Vec<_>) = content
        .drain(..)
        .partition(|item| matches!(item.block, ContentBlock::ToolResult { .. }));
    results.extend(rest);
    *content = results;
}

/// Fork: content made only of tool results.
fn only_results(content: &[ApiContent]) -> bool {
    !content.is_empty()
        && content
            .iter()
            .all(|item| matches!(item.block, ContentBlock::ToolResult { .. }))
}

/// Fork: a meta notification message with more than one block.
fn notification_batch(user: &rust_cli_kernel_api::message::UserMessage) -> bool {
    user.content.len() > 1
        && matches!(&user.origin, rust_cli_kernel_api::message::UserOrigin::Meta { source }
            if source == rust_cli_kernel_api::hooks::queued_command::TASK_NOTIFICATION)
}

/// 相邻 user 消息合并：文本接文本时，前一段末尾补一个换行。
fn merge_user(into: &mut Vec<ApiContent>, next: Vec<ApiContent>) {
    if let (Some(last), Some(first)) = (into.last_mut(), next.first())
        && let (ContentBlock::Text { text }, ContentBlock::Text { .. }) =
            (&mut last.block, &first.block)
    {
        text.push('\n');
    }
    into.extend(next);
    tool_results_first(into);
}

struct Builder {
    out: Vec<ApiMessage>,
    /// [`NormalizeOptions::separate_user_messages`].
    separate: bool,
    folded: Vec<String>,
    /// 已发出的 tool_use 的工具名：提醒并进工具结果时按它推结果的形式（`array_result`）。
    tool_names: HashMap<ToolUseId, String>,
}

impl Builder {
    fn last_role(&self) -> Option<ApiRole> {
        self.out.last().map(|message| message.role)
    }

    fn push_user(&mut self, content: Vec<ApiContent>) {
        match self.out.last_mut() {
            Some(last) if last.role == ApiRole::User && !self.separate => {
                merge_user(&mut last.content, content);
            }
            // The executor records each result of one reply as its own message, and pairing only reads the first user
            // message after a reply. Separate mode therefore still keeps consecutive results together; split apart,
            // the later results were replaced with missing-result errors and dropped as orphans.
            Some(last)
                if last.role == ApiRole::User
                    && only_results(&last.content)
                    && only_results(&content) =>
            {
                last.content.extend(content);
            }
            _ => self.out.push(message(ApiRole::User, content)),
        }
    }

    /// user 角色的 attachment：接在上一条 user 消息之后，不补换行；那条消息
    /// 以工具结果结尾时并进工具结果（context.md §3 第 9 条）。
    ///
    /// 缺陷修复（R4 F7）：原来总是另起文本块。模型不支持 system turn 时每个工具轮的提醒都走这里，
    /// 应把它并进工具结果的字符串、缓存断点落在工具结果上，所以 GLM 等没有卡片的模型每个工具轮的请求形状都不对。
    fn push_reminder(&mut self, value: String) {
        match self.out.last_mut() {
            Some(last) if last.role == ApiRole::User && !self.separate => {
                let names = &self.tool_names;
                let array_form = |id: &ToolUseId, is_error: bool| {
                    names
                        .get(id)
                        .is_some_and(|name| array_result(name, is_error))
                };
                if !fold_into_tool_result(&mut last.content, &value, array_form) {
                    last.content.push(text(value));
                    tool_results_first(&mut last.content);
                }
            }
            _ => self.out.push(message(ApiRole::User, vec![text(value)])),
        }
    }

    /// 带内容块的 attachment（docs/specs/rust-cli/tui-input.md §1.3，context.md §3 第 8 条）：上一条是 user 时，
    /// 调用说明与内容块依次接在后面；否则调用说明单独一条 user 消息、内容块另起一条（这两条 meta
    /// 消息原样推入，之后的内容接在第二条后面）。
    fn push_media(&mut self, value: String, blocks: Vec<ContentBlock>) {
        // Fork: marked so the request media budget does not count these as the user's own input.
        let meta = |mut content: ApiContent| {
            content.meta = true;
            content
        };
        let blocks: Vec<ApiContent> = plain(blocks).into_iter().map(meta).collect();
        let value = meta(text(value));
        match self.out.last_mut() {
            Some(last) if last.role == ApiRole::User && !self.separate => {
                last.content.push(value);
                last.content.extend(blocks);
                tool_results_first(&mut last.content);
            }
            _ => {
                self.out.push(message(ApiRole::User, vec![value]));
                self.out.push(message(ApiRole::User, blocks));
            }
        }
    }

    /// 折叠的 system 文本落地。
    fn flush(&mut self) {
        if self.folded.is_empty() {
            return;
        }
        let joined = self.folded.drain(..).collect::<Vec<_>>().join("\n\n");
        match self.last_role() {
            Some(ApiRole::System) => {
                if let Some(ContentBlock::Text { text }) = self
                    .out
                    .last_mut()
                    .and_then(|last| last.content.last_mut())
                    .map(|item| &mut item.block)
                {
                    text.push_str("\n\n");
                    text.push_str(&joined);
                }
            }
            Some(ApiRole::User) => self.out.push(message(ApiRole::System, vec![text(joined)])),
            // 前面没有 user 消息可跟：退回成一条带包装的 user 提醒。
            Some(ApiRole::Assistant) | None => self
                .out
                .push(message(ApiRole::User, vec![text(reminder::wrap(&joined))])),
        }
    }
}

fn is_thinking(block: &ContentBlock) -> bool {
    matches!(
        block,
        ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. }
    )
}

/// 回复里 tool_use 之后还有别的块时，tool_use 移到末尾，其余块保持相对顺序、各自分开；有 tool_use 段夹在两个
/// thinking 块之间时整条不动（query.md §1.7）。
///
/// 修 bug（工作线 F81）：以前实时路径按 API 的块顺序发，冷读取却是文字在前、tool_use 在后，同一段历史续写前后
/// 请求不同。
fn tool_uses_last(blocks: Vec<ContentBlock>) -> Vec<ContentBlock> {
    let is_call = |block: &ContentBlock| matches!(block, ContentBlock::ToolUse { .. });
    let (mut seen_call, mut after_call, mut splits_thinking) = (false, false, false);
    let (mut previous_thinking, mut in_calls) = (false, false);
    for block in &blocks {
        if is_call(block) {
            seen_call = true;
            in_calls = true;
            continue;
        }
        after_call |= seen_call;
        let thinking = is_thinking(block);
        splits_thinking |= thinking && previous_thinking && in_calls;
        previous_thinking = thinking;
        in_calls = false;
    }
    if !after_call || splits_thinking {
        return blocks;
    }
    let (calls, mut rest): (Vec<_>, Vec<_>) = blocks.into_iter().partition(is_call);
    rest.extend(calls);
    rest
}

/// 每轮 effort。assistant 消息还没有记录当时的 effort
/// （工作线 L1），所以每轮都按这次请求的 effort 算：只有第一条人类输入之后会带上它。
fn turn_effort(messages: Vec<ApiMessage>, effort: &str) -> Vec<ApiMessage> {
    let config = || TurnOutputConfig {
        effort: Some(effort.to_owned()),
    };
    let mut out = Vec::with_capacity(messages.len() + 1);
    let mut announced = false;
    let mut pending = false;
    for mut item in messages {
        if pending && item.role != ApiRole::User {
            pending = false;
            announced = true;
            if item.role == ApiRole::System {
                item.output_config = Some(config());
                out.push(item);
                continue;
            }
            out.push(ApiMessage {
                output_config: Some(config()),
                ..message(ApiRole::System, Vec::new())
            });
        }
        let is_user = item.role == ApiRole::User;
        out.push(item);
        if is_user {
            pending = !announced;
        }
    }
    if pending {
        out.push(ApiMessage {
            output_config: Some(config()),
            ..message(ApiRole::System, Vec::new())
        });
    }
    out
}

pub(crate) fn normalize<'a>(
    messages: impl IntoIterator<Item = &'a Message>,
    options: &NormalizeOptions,
) -> Vec<ApiMessage> {
    let mut builder = Builder {
        out: Vec::new(),
        separate: options.separate_user_messages,
        folded: Vec::new(),
        tool_names: HashMap::new(),
    };
    for item in hoist(messages.into_iter().collect()) {
        match item {
            // Fork: a notification batch (one message, a text block per notification) reaches the
            // model like one user message per notification: every block but the last ends with a
            // newline, as Node sends `persistBackgroundTaskNotificationBatch`'s parts.
            Message::User(user) if notification_batch(user) => {
                for block in &user.content {
                    builder.push_user(plain(vec![block.clone()]));
                }
            }
            // Fork: Node's empty real user message goes to the provider as `(no content)`, before the reminders.
            Message::User(user)
                if rust_cli_kernel_api::prompt_attachment::reminders_only(&user.content) =>
            {
                let mut content = vec![text(crate::texts::NO_CONTENT.to_owned())];
                // The empty typed text is what the padding replaces (Node drops empty text blocks).
                content.extend(plain(
                    user.content
                        .iter()
                        .filter(|block| !matches!(block, ContentBlock::Text { text } if text.is_empty()))
                        .cloned()
                        .collect(),
                ));
                builder.push_user(content);
            }
            Message::User(user) => builder.push_user(plain(user.content.clone())),
            // 只供显示的 attachment（如 `max_turns_reached`）文本为空，渲染为空。
            Message::Attachment(attachment) if attachment.text.is_empty() => {}
            // Fork: a steer with a source (plan feedback) reaches the model as the plain user text, after the tool
            // result, never folded into it (Node `steering.ts`: no guide presentation for a sourced input).
            Message::Attachment(attachment) if queued_command::sourced(attachment).is_some() => {
                let (_, prompt) = queued_command::sourced(attachment).unwrap_or_default();
                builder.push_user(vec![text(prompt.to_owned())]);
            }
            // Fork: a typed steer is a mid-turn input (Node 3.17 `inputPresentationRole` `mid_turn`): with system turns
            // it folds into the run's system message like any system-role attachment, and without an anchor it falls
            // back to one wrapped user reminder (`flush`). The Rust port used to send it as unwrapped user text (F13).
            Message::Attachment(attachment) => {
                let blocks = attachment.blocks();
                if !blocks.is_empty() {
                    builder.push_media(attachment.text.clone(), blocks);
                } else if options.system_turns && attachment.role() == AttachmentRole::System {
                    builder
                        .folded
                        .push(reminder::unwrap(&attachment.text).to_owned());
                } else {
                    builder.push_reminder(attachment.text.clone());
                }
            }
            Message::Assistant(assistant) => {
                builder.flush();
                for block in &assistant.content {
                    if let ContentBlock::ToolUse { id, name, .. } = block {
                        builder.tool_names.insert(id.clone(), name.clone());
                    }
                }
                let content = plain(tool_uses_last(assistant.content.clone()));
                match builder.out.last_mut() {
                    Some(last) if last.role == ApiRole::Assistant => last.content.extend(content),
                    _ => builder.out.push(message(ApiRole::Assistant, content)),
                }
            }
            Message::System(_) => {}
        }
    }
    builder.flush();
    let paired = crate::pairing::ensure_pairing(builder.out);
    let mut out = match &options.turn_effort {
        Some(effort) => turn_effort(paired, effort),
        None => paired,
    };
    let marker = if options.skip_cache_write {
        skip_write_marker(&mut out)
    } else {
        out.iter_mut()
            .rev()
            .find_map(|item| item.content.last_mut())
    };
    if let Some(last) = marker {
        last.cache_control = Some(CacheControl {
            kind: "ephemeral".to_owned(),
            ttl: None,
            scope: None,
        });
    }
    out
}

/// 能盖缓存章的消息：不是 system 消息；assistant 的最后一块不是
/// thinking，也不是空文本。
fn stampable(message: &ApiMessage) -> bool {
    match message.role {
        ApiRole::System => false,
        ApiRole::User => true,
        ApiRole::Assistant => message
            .content
            .last()
            .is_some_and(|item| match &item.block {
                ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. } => false,
                ContentBlock::Text { text } => !text.is_empty(),
                _ => true,
            }),
    }
}

/// 摘要请求的断点（不写缓存）：最后一条能盖章的消息
/// 之前的那一条的最后一块。
///
/// 缺陷修复（L25）：原来摘要请求与主循环一样标在最后一块（末尾的 system 提醒）上；摘要
/// 请求不写缓存，断点落在倒数第二条能盖章的消息上。
fn skip_write_marker(messages: &mut [ApiMessage]) -> Option<&mut ApiContent> {
    let last = messages.iter().rposition(stampable)?;
    let before = messages[..last].iter().rposition(stampable)?;
    messages[before].content.last_mut()
}

#[cfg(test)]
#[path = "normalize_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "normalize_order_tests.rs"]
mod order_tests;
