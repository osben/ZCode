//! 会话消息模型（docs/specs/rust-cli/README.md §5）。
//!
//! 消息分 user / assistant / attachment / system 四类，内容块是 Anthropic
//! Messages 的块。这是内核的 canonical 形状；发给模型前由 query 的 normalize 转成 API 消息，
//! 落库时由会话存储适配器映射成自己的记录（本地是 Node 记录）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{MessageId, ToolUseId};
use crate::store::ArtifactRef;

/// Anthropic Messages 的内容块。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Image {
        source: ImageSource,
        /// Fork: the attached file's name (Node `source.placeholder`). The model never sees it, except as
        /// `[Attached <mime>: <name>]` when the endpoint takes no images; it is not stored.
        #[serde(skip)]
        name: Option<String>,
    },
    /// Fork: an attached video (Node's `video` model block). Only the model request carries it: `query::normalize`
    /// expands an attached video into it, and the stored message keeps the `file` part.
    Video {
        source: ImageSource,
        /// The attached file's name, as for [`ContentBlock::Image`].
        #[serde(skip)]
        name: Option<String>,
    },
    Thinking {
        thinking: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    RedactedThinking {
        data: String,
    },
    ToolUse {
        id: ToolUseId,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: ToolUseId,
        content: Vec<ToolResultContent>,
        #[serde(default)]
        is_error: bool,
    },
    /// Anthropic 服务端工具的调用（WebSearch 的旁路请求里出现，docs/specs/rust-cli/tools-more.md §5）。
    /// ID 是服务端的 `srvtoolu_…`，不是客户端工具的 [`ToolUseId`]。
    ServerToolUse {
        id: String,
        name: String,
        input: Value,
    },
    /// 服务端 web_search 的结果：`content` 是结果数组，或 `{type: web_search_tool_result_error,
    /// error_code}`，原样保存，回放时原样发回。
    WebSearchToolResult {
        tool_use_id: String,
        content: Value,
    },
    /// Fork: a file the App attached to a user message. It is stored as Node's `file` part (the one owner of the
    /// attachment, read back by both runtimes) and expanded into the model's reminders by `query::normalize`.
    File {
        file: AttachedFile,
    },
    /// Fork: a settled tool or plan row of an ACP agent turn (specs/fork-rust-agent-parity.md "ACP external agents",
    /// rule 5), stored as Node's `tool` part with `metadata.externalAgent`. It is a record for the App only: the model
    /// never sees it (`query::normalize` drops it). Boxed: rare, and every message block pays for the variant's size.
    ExternalTool(Box<ExternalTool>),
}

/// Fork: one ACP tool or plan row (Node `ExternalAgentToolRows`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExternalTool {
    /// The row id minted for the agent's `toolCallId` (the part's `callID`).
    pub id: ToolUseId,
    /// `acp:<kind|other>`, or `TodoWrite` for a plan.
    pub name: String,
    /// The agent's title; empty when it gave none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    pub input: Value,
    /// The result text, or the error text of a failed row.
    pub output: String,
    #[serde(default)]
    pub is_error: bool,
}

/// Fork: an App file attachment of a user message (Node `file` part of `persistUserPrompt`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttachedFile {
    /// The file name the App shows and the reminders name.
    pub name: String,
    pub mime: String,
    /// The size the App declared.
    pub bytes: u64,
    /// The App's ref: a local absolute path (desktop) or a `zcode-artifact://` URI (web remote).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    /// The App's `previewRef` (a smaller rendition the App previews instead), when it sent one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// `Box<str>`: keeps the block within the size of a model stream event (clippy `large_enum_variant`).
    pub preview_reference: Option<Box<str>>,
    /// The session artifact (`zcode-artifact://`) holding an image's `data:` URL, Node's `metadata.artifactUri`: the
    /// stored part points at it instead of inlining the bytes, and a cold load reads the image back from it.
    ///
    /// For text material it is the local file holding the text (Node writes the decoded web-remote text as a session
    /// artifact and names its path), so the chip keeps the App's ref.
    ///
    /// `Box<str>`, like `preview_reference`: keeps the block within the size of a model stream event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored: Option<Box<str>>,
    /// The App's `sourceKind` / `messageCount` of text material. Only the live row shows it: the stored part does not
    /// hold it (Node puts the input refs on the live row and builds a cold chip from the part).
    /// Boxed: rare, and every message block pays for the field's size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<Box<Material>>,
    /// Node's `metadata.image` of an image prepared for the model (specs/fork-agent-runtime-selection.md "Image
    /// preparation"). Boxed: only images have it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<Box<ImageInfo>>,
    /// The stored part has no `filename` (Node's web-remote image and video resolvers write none): `name` is then only
    /// the chip's (Node `attachmentMetasOfMessage`), and the model gets no name (Node's cold media block takes
    /// `placeholder: source.text.value ?? filename`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unnamed: bool,
    pub body: AttachedBody,
}

/// Fork: Node `PreparedImageData.metadata`, how an attached image was prepared for the model. The pixel sizes are
/// unknown for a WebP image, which is sent as it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_height: Option<u32>,
    pub max_dimension: u32,
    pub resized: bool,
    /// The size of the bytes sent.
    pub transformed_size_bytes: u64,
}

/// Fork: Node `attachmentSourceKindSchema`, the text material the App sends by reference only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MaterialKind {
    TopicHistory,
    ClipboardText,
}

/// Fork: the App's marks of a text material attachment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Material {
    pub kind: MaterialKind,
    /// The number of messages a topic history holds (the chip's label).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u64>,
}

/// What of an [`AttachedFile`] reaches the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachedBody {
    /// A text file read inline (Node's Read-style reminder pair). `read` is set for a desktop file the agent read
    /// (Node `resolveLocalFileAttachment`): the submitted path and the view of the file that was sent.
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        read: Option<Box<TextRead>>,
    },
    /// An image sent as an image block.
    Image { source: ImageSource },
    /// A video sent as a video block (Node `resolveInlineMediaAttachment` / `resolveLocalVideoAttachment`); `source`
    /// holds the video's media type.
    Video { source: ImageSource },
    /// Only the metadata reminder (too large, unsupported or unreadable).
    Omitted,
    /// Node's path reference (`resolvedPathReferenceAttachment`): a local file the model is told to read with its
    /// tools, e.g. a binary file. `text` is the note as sent, kept so a cold load replays it unchanged.
    PathReference { text: String },
    /// Node's `attachment_read_failed` placeholder of a desktop text file that could not be read: nothing of it reaches
    /// the model (Node `isFailedTextAttachmentPlaceholder`).
    ReadFailed,
    /// Node's placeholder of a file that could not be read or prepared for the model (`resolvedPlaceholderAttachment`,
    /// `code` its `errorCode`, e.g. `attachment_image_resize_failed`): the model reads `[Attached <mime>: <label>]`.
    /// `label` is Node's (`path ?? attachment-<n>`) for a part Node wrote without a name; `None` labels it by the
    /// submitted path, else the file name. `url` is the part's `url` when no ref holds it (Node keeps an inline data URL
    /// there), so the part is written back as Node stored it.
    #[serde(alias = "image_failed")]
    Placeholder {
        code: Box<str>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<Box<str>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<Box<str>>,
    },
}

/// Fork: the view of a desktop text file that was sent (Node's `metadata.preview` of `resolveLocalFileAttachment`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextRead {
    /// The path the App submitted (Node `source.text.value`): the Read reminder names it.
    pub path: String,
    /// The first line sent, 1-based.
    pub start_line: u64,
    /// The lines of the whole file.
    pub total_lines: u64,
    /// The file's size on disk.
    pub original_bytes: u64,
    /// Node `truncated`: set only by the token cap's partial view (a plain 2000-line cut is not marked).
    pub truncated: bool,
    pub truncated_by_token_cap: bool,
    /// Node `partialViewNotice`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

/// 图片来源。大图不内联在消息里，用 Artifact 引用，在发给模型的一侧物化（§6 规则 10）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ImageSource {
    Base64 {
        media_type: String,
        data: String,
    },
    Artifact {
        media_type: String,
        artifact: ArtifactRef,
    },
}

/// tool_result 的内容。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolResultContent {
    Text {
        text: String,
    },
    Image {
        source: ImageSource,
    },
    /// PDF 文档（Read 整读 PDF 的结果，docs/specs/rust-cli/tools-files.md §1.5，修复线 F24）。`source` 与图片
    /// 同一种写法（base64 或 Artifact 引用），`media_type` 是 `application/pdf`；Anthropic 线格式是
    /// `{type: "document", source: {type: "base64", media_type, data}}`。
    Document {
        source: ImageSource,
    },
    /// ToolSearch 的结果：引用一个延迟工具，API 在服务端展开它的完整定义
    /// （beta `advanced-tool-use`，docs/specs/rust-cli/tools-more.md §3.6）。
    ToolReference {
        tool_name: String,
    },
}

impl ToolResultContent {
    /// 文字块的文字；图片、文档与工具引用没有。
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Text { text } => Some(text),
            Self::Image { .. } | Self::Document { .. } | Self::ToolReference { .. } => None,
        }
    }
}

/// 工具结果里的文字：文字块按顺序以换行接起来（图片、文档与工具引用不算）。前端的预览、技能的命令输出与 App 的
/// 投影共用这一份（F129，审查 E11）。
pub fn text_of(content: &[ToolResultContent]) -> String {
    content
        .iter()
        .filter_map(ToolResultContent::text)
        .collect::<Vec<_>>()
        .join("\n")
}

/// `tool_reference` 在不支持它的地方（OpenAI 协议、Node 记录的文本）降成的文本。
pub fn tool_reference_text(tool_name: &str) -> String {
    format!("Tool loaded: {tool_name}")
}

/// 一条 user 消息从哪里来。决定 UI 是否显示、resume 时怎样重放。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UserOrigin {
    /// 用户输入。
    Human,
    /// 工具结果，`assistant` 是发出 tool_use 的那条 assistant 消息。
    ToolResult { assistant: MessageId },
    /// 内核生成、只给模型看的消息（续写提示、hook 阻塞原因等）；`source` 是来源标签。
    Meta { source: String },
    /// 压缩摘要。
    CompactSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserMessage {
    pub id: MessageId,
    pub content: Vec<ContentBlock>,
    pub origin: UserOrigin,
    /// Fork: the App input this message was admitted as (Node's input intent, [`crate::input_intent`]); `None` for
    /// TUI and CLI inputs and every message that is not a typed input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<Box<crate::input_intent::InputIntent>>,
    /// The run (`executionId`) a no-progress reminder was built for: only on a message that is exactly one such reminder
    /// (Node's `subagentStall.executionId`, written by the store and the projection). `None` for every other message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stall_execution: Option<String>,
}

/// 模型停止的原因（Anthropic `stop_reason`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    StopSequence,
    ToolUse,
    PauseTurn,
    Refusal,
    /// 模型的上下文窗口用满（线上的 `model_context_window_exceeded`）：主循环同输出上限续写，用尽时另有文字
    /// （docs/specs/rust-cli/provider-errors.md §2.3、D7，修复线 F113）。以前是 `Unknown`，回合静默结束。
    ModelContextWindowExceeded,
    #[serde(other)]
    Unknown,
}

/// token 用量（Anthropic `usage`）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
}

/// 用量的累加（headless 的 result 与 `/usage`、App 的投影、TUI 的视图共用，F129，审查 E11）。穷举解构：加字段时这里
/// 编译失败，不会漏加。
impl std::ops::AddAssign for Usage {
    fn add_assign(&mut self, other: Self) {
        let Self {
            input_tokens,
            output_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
        } = other;
        self.input_tokens += input_tokens;
        self.output_tokens += output_tokens;
        self.cache_creation_input_tokens += cache_creation_input_tokens;
        self.cache_read_input_tokens += cache_read_input_tokens;
    }
}

/// 一次模型响应：一条消息、多个块（不按内容块拆成多行）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssistantMessage {
    pub id: MessageId,
    pub content: Vec<ContentBlock>,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<StopReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

/// 不是模型生成的 assistant 消息的模型名。
pub const SYNTHETIC_MODEL: &str = "<synthetic>";

/// 续写会话时补在最后一条没有回答的 user 消息之后的 assistant 文字（docs/specs/rust-cli/session-lifecycle.md
/// §6.3.1）：界面不显示；随续写后的第一批提交落库，存成只给模型看的记录（工作线 F77）。
pub const NO_RESPONSE_REQUESTED: &str = "No response requested.";

/// 发给模型的内容为空时的占位文字（docs/specs/rust-cli/query.md §1.8 的配对兜底；context 的静默提醒不把它算作
/// 可见输出）。
pub const NO_CONTENT: &str = "(no content)";

/// 续写时补给没有结果的调用的结果文字（`is_error`，docs/specs/rust-cli/session-lifecycle.md §6.3）：会话结束之前没有
/// 记下结果，结果未知。会话的 settle 给本工程写的未结调用补它；Node 写的未结调用由存储冷读取补 Node 自己的文字
/// （§6.3.2，工作线 F88）。
pub const INTERRUPTED_CALL: &str = "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]";

impl AssistantMessage {
    /// 续写时补的 assistant（[`NO_RESPONSE_REQUESTED`]，模型名是 [`SYNTHETIC_MODEL`]）。
    pub fn is_resume_sentinel(&self) -> bool {
        self.model == SYNTHETIC_MODEL
            && matches!(
                self.content.as_slice(),
                [ContentBlock::Text { text }] if text == NO_RESPONSE_REQUESTED
            )
    }
}

/// attachment（system-reminder 类内容）：渲染好的文本加上结构化数据。
///
/// 落库形状是 `text` part + `synthetic` + `metadata.source`，`text` 自带 `<system-reminder>` 包装
/// （§5）；`data` 供 resume 后计算增量（例如 delta 类 attachment）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttachmentMessage {
    pub id: MessageId,
    pub source: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub data: Value,
}

/// attachment 发给模型时的角色。
///
/// System：支持对话中间 system 消息的模型上，折叠进紧跟 user 消息的 `role: system` 消息；
/// User：留在 user 消息里，排在人类输入之前。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentRole {
    User,
    System,
}

/// 以 user 角色渲染的 attachment 来源。来源名就是
/// attachment type；表外的来源都按 system 渲染。
const USER_ROLE_SOURCES: &[&str] = &[
    "dir_sync_notice",
    "unknown_command_fallback",
    "session_context",
    "instructions",
    "coordinator_context",
    "context_sections",
    "remote_session_change",
    "fork_briefing",
    "poll_events",
    "cowork_memory_context",
    "account_memory_recall",
    "artifact_opening_prefetch",
];

/// attachment 在 `text` 之后的内容块所在的 `data` 成员（docs/specs/rust-cli/tui-input.md §1.3）。
///
/// 某些 attachment 渲染出非文字内容：`@` 提及的图片、带图片输出的 notebook。这些块按顺序
/// 排在 `text` 之后发给模型；`data` 是它们在内核里的唯一位置（会话存储按自己的形状另存）。
pub const ATTACHMENT_BLOCKS: &str = "blocks";

impl AttachmentMessage {
    /// 角色由来源决定，不单独存储：Node 记录只保存 `metadata.source`，resume 后按同一张表还原。
    pub fn role(&self) -> AttachmentRole {
        if USER_ROLE_SOURCES.contains(&self.source.as_str()) {
            AttachmentRole::User
        } else {
            AttachmentRole::System
        }
    }

    /// `text` 之后的内容块（[`ATTACHMENT_BLOCKS`]）；没有或形状不对时为空。有内容块的 attachment 发给模型时
    /// 按 user 处理，不折进 system 消息（只折纯文字的 attachment）。
    pub fn blocks(&self) -> Vec<ContentBlock> {
        self.data
            .get(ATTACHMENT_BLOCKS)
            .and_then(|blocks| serde_json::from_value(blocks.clone()).ok())
            .unwrap_or_default()
    }
}

/// 压缩边界。`preserved` 是压缩后原样保留的消息段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompactBoundary {
    pub id: MessageId,
    pub trigger: CompactTrigger,
    pub pre_tokens: u64,
    pub summary: MessageId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preserved: Option<PreservedSegment>,
    /// 压缩前已加载的工具（经 `tool_reference` 引用过的，加上前一个边界带下来的），排序：压缩之后照样算已加载
    /// （docs/specs/rust-cli/compact.md §3.5）。旧记录没有这一项。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub discovered_tools: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactTrigger {
    Manual,
    Auto,
    Reactive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreservedSegment {
    pub head: MessageId,
    pub anchor: MessageId,
    pub tail: MessageId,
}

/// system 消息：不发给模型（或由 normalize 特殊处理）的会话标记。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum SystemMessage {
    CompactBoundary(CompactBoundary),
    /// 用户中断了这一轮。
    Interrupted {
        id: MessageId,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    User(UserMessage),
    Assistant(AssistantMessage),
    Attachment(AttachmentMessage),
    System(SystemMessage),
}

impl Message {
    pub fn id(&self) -> &MessageId {
        match self {
            Self::User(message) => &message.id,
            Self::Assistant(message) => &message.id,
            Self::Attachment(message) => &message.id,
            Self::System(SystemMessage::CompactBoundary(boundary)) => &boundary.id,
            Self::System(SystemMessage::Interrupted { id }) => id,
        }
    }
}

#[cfg(test)]
#[path = "message_tests.rs"]
mod tests;
