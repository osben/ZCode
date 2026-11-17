//! Context composition (Node `runtime/context-composition/classifier.ts`, spec
//! `specs/fork-rust-agent-parity.md`, "Rust port"): one model request split into the eleven categories of
//! `v4/conversation/contextComposition`, and the coarse seven of the usage ring.
//!
//! The classifier is pure. [`measure`] builds its input from the request the query loop is about to send, and
//! [`record`] stores the result for the session. Sizes are UTF-16 units (`chars`) and Node's token estimate
//! (`estimate_text`), taken over the provider wire form of each message (the normalized `ApiMessage`s, as Node takes
//! its projected messages).

use rust_cli_base::js::json::stringify;
use rust_cli_base::js::string::{utf16_len, utf16_prefix};
use rust_cli_base::tokens::estimate_text;
use rust_cli_kernel_api::context_composition::{
    CompositionRecord, ProviderUsage, WireCategory, WireItem,
};
use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::message::{
    ContentBlock, Message, SystemMessage, ToolResultContent, UserOrigin,
};
use rust_cli_kernel_api::model::{ApiMessage, ApiRole, SystemBlock, ToolDefinition, ToolFlags};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};

/// Node `CONTEXT_COMPOSITION_MAX_ITEMS`.
pub const MAX_ITEMS: usize = 50;
/// Node `CONTEXT_COMPOSITION_MAX_ITEM_NAME_CHARS` (UTF-16 units, as JS `slice` counts them).
pub const MAX_ITEM_NAME_UNITS: usize = 200;

/// Node's reminder sources that Rust also raises as attachments. An attachment or meta message with one of these sources
/// is counted as `reminders`.
const REMINDER_SOURCES: &[&str] = &[
    "environment",
    "date",
    "date_change",
    "plan_mode_exit",
    "deferred_tools_delta",
    "nested_memory",
    "remote_machines",
    "goal_status",
    "hook_additional_context",
    "hook_success",
    "hook_stopped_continuation",
    "max_turns_reached",
    "read_truncation_notice",
    "diagnostics",
];
/// The instruction files (AGENTS.md and the memory index) are `meta_user_context`, not reminders.
const INSTRUCTION_SOURCE: &str = "instructions";
const MCP_PREFIX: &str = "mcp__";
const APP_PREFIX: &str = "app__";

/// The eleven categories, in Node's order. The declaration order is the order of [`CategoryId::ALL`]; the index is the
/// discriminant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CategoryId {
    SystemPrompt,
    MetaUserContext,
    Skills,
    ToolPrompt,
    SystemToolSchemas,
    McpToolSchemas,
    AppToolSchemas,
    DeferredToolSchemas,
    Reminders,
    CompactSummary,
    Messages,
}

impl CategoryId {
    pub const ALL: [CategoryId; 11] = [
        Self::SystemPrompt,
        Self::MetaUserContext,
        Self::Skills,
        Self::ToolPrompt,
        Self::SystemToolSchemas,
        Self::McpToolSchemas,
        Self::AppToolSchemas,
        Self::DeferredToolSchemas,
        Self::Reminders,
        Self::CompactSummary,
        Self::Messages,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SystemPrompt => "system_prompt",
            Self::MetaUserContext => "meta_user_context",
            Self::Skills => "skills",
            Self::ToolPrompt => "tool_prompt",
            Self::SystemToolSchemas => "system_tool_schemas",
            Self::McpToolSchemas => "mcp_tool_schemas",
            Self::AppToolSchemas => "app_tool_schemas",
            Self::DeferredToolSchemas => "deferred_tool_schemas",
            Self::Reminders => "reminders",
            Self::CompactSummary => "compact_summary",
            Self::Messages => "messages",
        }
    }

    /// The coarse usage-ring source of this category (Node `USAGE_SOURCE_BY_CATEGORY`). Deferred tools are projected by
    /// origin in Node; here an MCP deferred tool goes to MCP and the rest to the built-in source.
    pub const fn usage_source(self) -> UsageSource {
        match self {
            Self::SystemPrompt => UsageSource::SystemPrompt,
            Self::MetaUserContext | Self::Reminders => UsageSource::MetaUserContext,
            Self::Skills => UsageSource::Skills,
            Self::ToolPrompt => UsageSource::ToolPrompt,
            Self::SystemToolSchemas | Self::AppToolSchemas | Self::DeferredToolSchemas => {
                UsageSource::SystemToolSchemas
            }
            Self::McpToolSchemas => UsageSource::McpToolSchemas,
            Self::CompactSummary | Self::Messages => UsageSource::Messages,
        }
    }
}

/// The seven coarse sources of the usage ring (Node `ContextCompositionUsageSource`), in ring order. The declaration
/// order is the order of [`UsageSource::ORDER`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageSource {
    SystemPrompt,
    MetaUserContext,
    Skills,
    ToolPrompt,
    SystemToolSchemas,
    McpToolSchemas,
    Messages,
}

impl UsageSource {
    pub const ORDER: [UsageSource; 7] = [
        Self::SystemPrompt,
        Self::MetaUserContext,
        Self::Skills,
        Self::ToolPrompt,
        Self::SystemToolSchemas,
        Self::McpToolSchemas,
        Self::Messages,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SystemPrompt => "system_prompt",
            Self::MetaUserContext => "meta_user_context",
            Self::Skills => "skills",
            Self::ToolPrompt => "tool_prompt",
            Self::SystemToolSchemas => "system_tool_schemas",
            Self::McpToolSchemas => "mcp_tool_schemas",
            Self::Messages => "messages",
        }
    }
}

/// A part of a category, before the wire form: its name, UTF-16 size and estimated tokens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    pub name: String,
    pub chars: u64,
    pub tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Category {
    pub id: CategoryId,
    pub chars: u64,
    pub tokens: u64,
    pub items: Vec<Part>,
}

/// One request's full breakdown: always the eleven categories, in [`CategoryId::ALL`] order, zero values included.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Breakdown {
    pub categories: Vec<Category>,
}

/// A message of the request with the provider wire form it was sent as.
pub struct MessagePart<'a> {
    pub message: &'a Message,
    /// The normalized messages this one contributed (usually one; folded reminders and split user turns make more).
    pub wire: &'a [ApiMessage],
}

/// A tool of the request and whether it was sent deferred (name and description only, ToolSearch loads the rest).
pub struct ToolPart<'a> {
    pub definition: &'a ToolDefinition,
    pub deferred: bool,
}

/// The request parts the classifier reads. Borrowed: classifying never changes the request.
pub struct Input<'a> {
    pub system: &'a [SystemBlock],
    pub messages: &'a [MessagePart<'a>],
    pub tools: &'a [ToolPart<'a>],
}

#[derive(Default)]
struct Accumulator {
    chars: u64,
    tokens: u64,
    items: Vec<Part>,
}

struct Builder {
    slots: Vec<Accumulator>,
}

impl Builder {
    fn new() -> Self {
        Self {
            slots: CategoryId::ALL
                .iter()
                .map(|_| Accumulator::default())
                .collect(),
        }
    }

    /// Adds one part. Parts with the same name in one category are summed, as Node sums items by name.
    fn add(&mut self, id: CategoryId, name: &str, content: &str) {
        let chars = utf16_len(content) as u64;
        let tokens = estimate_text(content);
        let slot = &mut self.slots[id as usize];
        slot.chars += chars;
        slot.tokens += tokens;
        match slot.items.iter_mut().find(|item| item.name == name) {
            Some(item) => {
                item.chars += chars;
                item.tokens += tokens;
            }
            None => slot.items.push(Part {
                name: name.to_owned(),
                chars,
                tokens,
            }),
        }
    }

    fn finish(self) -> Breakdown {
        Breakdown {
            categories: CategoryId::ALL
                .into_iter()
                .zip(self.slots)
                .map(|(id, slot)| Category {
                    id,
                    chars: slot.chars,
                    tokens: slot.tokens,
                    items: slot.items,
                })
                .collect(),
        }
    }
}

/// Splits one request into the eleven categories.
///
/// - System blocks are `system_prompt`. There are no `skills` or `tool_prompt` sections yet: the request keeps no
///   per-section source (see the spec's deviation list).
/// - Each message is sized by its wire form: the JSON of its normalized messages.
/// - Attachments and meta messages go by source: instructions to `meta_user_context`, the reminder sources to
///   `reminders`, the rest to `messages`.
/// - A compact boundary is `compact_summary`. A turn is `messages`, named by its role.
/// - Tools go by name: `mcp__` to `mcp_tool_schemas`, `app__` to `app_tool_schemas`, the rest to
///   `system_tool_schemas`. A deferred tool is `deferred_tool_schemas` and is sized by name and description only.
pub fn classify(input: &Input<'_>) -> Breakdown {
    let mut builder = Builder::new();
    for block in input.system {
        builder.add(CategoryId::SystemPrompt, "system_block", &block.text);
    }
    // A compact boundary has no wire message of its own; its summary is a separate message, which is the compact summary.
    let summaries: Vec<&MessageId> = input
        .messages
        .iter()
        .filter_map(|part| match part.message {
            Message::System(SystemMessage::CompactBoundary(boundary)) => Some(&boundary.summary),
            _ => None,
        })
        .collect();
    let names = tool_names(input.messages);
    for part in input.messages {
        let (id, name) = if summaries.contains(&part.message.id()) {
            (CategoryId::CompactSummary, "compact_summary".to_owned())
        } else {
            message_category(part.message)
        };
        // Node sizes each of its messages on its own (its tokens are ceil'd per message), so each projected message is
        // added separately.
        for value in project(part.wire, &names) {
            builder.add(id, &name, &stringify(&value));
        }
    }
    for part in input.tools {
        let tool = part.definition;
        let (id, content) = if part.deferred {
            (
                CategoryId::DeferredToolSchemas,
                stringify(&json!({"name": tool.name, "description": tool.description})),
            )
        } else {
            (
                tool_category(&tool.name),
                stringify(&json!({
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                })),
            )
        };
        builder.add(id, &tool.name, &content);
    }
    builder.finish()
}

/// The name of every tool call in the request, by its id. A tool result takes its `toolName` from here, as Node's
/// tool message carries the name of the call it answers.
fn tool_names(messages: &[MessagePart<'_>]) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for part in messages {
        for wire in part.wire {
            for content in &wire.content {
                if let ContentBlock::ToolUse { id, name, .. } = &content.block {
                    names.insert(id.as_str().to_owned(), name.clone());
                }
            }
        }
    }
    names
}

/// Node's `ModelInputMessage`s for one request message, in the shape the classifier sizes: `{role, content, toolCalls,
/// toolCallId, toolName}` with keys in that order and absent when unset (`JSON.stringify` drops `undefined`).
///
/// - A tool result is a message of its own, role `tool`, with `toolCallId` and the call's `toolName`. It comes before
///   the turn's own message, as Node orders a turn's tool results ahead of its text.
/// - The turn's own message carries its text and its tool calls (`{id, name, input}`). With no text its `content` is `""`.
/// - `content` is a string when there is at most one text block, otherwise an array of `{type, ...}` blocks.
pub fn project(wire: &[ApiMessage], names: &HashMap<String, String>) -> Vec<Value> {
    let mut out = Vec::new();
    for message in wire {
        let role = match message.role {
            ApiRole::User => "user",
            ApiRole::Assistant => "assistant",
            ApiRole::System => "system",
        };
        let mut parts: Vec<Value> = Vec::new();
        let mut results_count = 0usize;
        let mut tool_calls: Vec<Value> = Vec::new();
        let mut results: Vec<Value> = Vec::new();
        for content in &message.content {
            match &content.block {
                ContentBlock::Text { text } => {
                    parts.push(json!({"type": "text", "text": text}));
                }
                ContentBlock::ToolUse { id, name, input } => {
                    tool_calls.push(json!({"id": id.as_str(), "name": name, "input": input}));
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } => {
                    results_count += 1;
                    let body: Vec<Value> = content.iter().map(tool_result_part).collect();
                    let mut result = Map::new();
                    result.insert("role".into(), json!("tool"));
                    result.insert("content".into(), content_value(body));
                    result.insert("toolCallId".into(), json!(tool_use_id.as_str()));
                    if let Some(name) = names.get(tool_use_id.as_str()) {
                        result.insert("toolName".into(), json!(name));
                    }
                    results.push(Value::Object(result));
                }
                other => {
                    // Blocks other than text, tool calls and results are sized by their wire JSON.
                    parts.push(serde_json::to_value(other).unwrap_or(Value::Null));
                }
            }
        }
        // A message whose content is only tool results has no message of its own.
        let has_own = !parts.is_empty() || !tool_calls.is_empty() || results_count == 0;
        out.extend(results);
        if has_own {
            let mut own = Map::new();
            own.insert("role".into(), json!(role));
            own.insert("content".into(), content_value(parts));
            if !tool_calls.is_empty() {
                own.insert("toolCalls".into(), Value::Array(tool_calls));
            }
            out.push(Value::Object(own));
        }
    }
    out
}

/// One tool result's content block as Node's text part (or the block's own JSON for non-text blocks).
fn tool_result_part(content: &ToolResultContent) -> Value {
    match content {
        ToolResultContent::Text { text } => json!({"type": "text", "text": text}),
        other => serde_json::to_value(other).unwrap_or(Value::Null),
    }
}

/// `content` of a projected message: `""` for none, the text itself for one text block, otherwise the blocks.
fn content_value(parts: Vec<Value>) -> Value {
    match parts.as_slice() {
        [] => json!(""),
        [single] if single["type"] == "text" => single["text"].clone(),
        _ => Value::Array(parts),
    }
}

fn message_category(message: &Message) -> (CategoryId, String) {
    match message {
        Message::Attachment(attachment) => source_category(&attachment.source),
        Message::User(user) => match &user.origin {
            UserOrigin::Meta { source } => source_category(source),
            _ => (CategoryId::Messages, "user".to_owned()),
        },
        Message::Assistant(_) => (CategoryId::Messages, "assistant".to_owned()),
        Message::System(SystemMessage::CompactBoundary(_)) => {
            (CategoryId::CompactSummary, "compact_summary".to_owned())
        }
        Message::System(SystemMessage::Interrupted { .. }) => {
            (CategoryId::Messages, "system".to_owned())
        }
    }
}

/// The skill listing attachment (context `skill_listing`): the announced skills, Node's `skills` category. Invoked skill
/// bodies (`invoked_skills`) are conversation content and stay messages.
const SKILL_LISTING_SOURCE: &str = "skill_listing";

fn source_category(source: &str) -> (CategoryId, String) {
    let id = if source == INSTRUCTION_SOURCE {
        CategoryId::MetaUserContext
    } else if source == SKILL_LISTING_SOURCE {
        CategoryId::Skills
    } else if REMINDER_SOURCES.contains(&source) {
        CategoryId::Reminders
    } else {
        CategoryId::Messages
    };
    (id, source.to_owned())
}

fn tool_category(name: &str) -> CategoryId {
    if name.starts_with(MCP_PREFIX) {
        CategoryId::McpToolSchemas
    } else if name.starts_with(APP_PREFIX) {
        CategoryId::AppToolSchemas
    } else {
        CategoryId::SystemToolSchemas
    }
}

/// Node `projectContextCompositionToUsageSources`: the non-zero coarse sources, in ring order.
pub fn usage_sources(breakdown: &Breakdown) -> Vec<(UsageSource, u64, u64)> {
    let mut totals = [(0u64, 0u64); 7];
    for category in &breakdown.categories {
        let index = category.id.usage_source() as usize;
        totals[index].0 += category.chars;
        totals[index].1 += category.tokens;
    }
    UsageSource::ORDER
        .into_iter()
        .zip(totals)
        .filter(|(_, (_, tokens))| *tokens > 0)
        .map(|(source, (chars, tokens))| (source, chars, tokens))
        .collect()
}

/// Node `toContextCompositionCategories`: zero categories dropped, items sorted by tokens, at most [`MAX_ITEMS`],
/// names cut to [`MAX_ITEM_NAME_UNITS`] UTF-16 units.
pub fn wire_categories(breakdown: &Breakdown) -> Vec<WireCategory> {
    breakdown
        .categories
        .iter()
        .filter(|category| category.tokens > 0)
        .map(|category| {
            let mut items: Vec<WireItem> = category
                .items
                .iter()
                .filter(|item| !item.name.is_empty())
                .map(|item| WireItem {
                    name: utf16_prefix(&item.name, MAX_ITEM_NAME_UNITS).to_owned(),
                    tokens: item.tokens,
                })
                .collect();
            // Stable sort: equal token counts keep the order the parts were seen in, as JS `toSorted` does.
            items.sort_by_key(|item| std::cmp::Reverse(item.tokens));
            items.truncate(MAX_ITEMS);
            WireCategory {
                id: category.id.as_str(),
                tokens: category.tokens,
                chars: category.chars,
                items: (!items.is_empty()).then_some(items),
            }
        })
        .collect()
}

/// The provider usage of a measured response, as the usage ring reads it: input with cache reads and writes, and that
/// plus the output tokens (Node `getModelUsageInputWindowTokens` / `getModelUsageContextTokens`).
pub fn provider_usage(
    input: u64,
    cache_creation: u64,
    cache_read: u64,
    output: u64,
) -> ProviderUsage {
    let input_tokens = input + cache_creation + cache_read;
    ProviderUsage {
        input_tokens,
        context_tokens: input_tokens + output,
    }
}

/// Builds the classifier input from the request the loop is about to send and classifies it.
///
/// The messages are the session's active history, each sized by the wire messages it normalizes to on its own. A
/// message whose wire form depends on its neighbours (a reminder folded into a tool result) is sized alone here, so the
/// fold is not reflected in the split between categories; the total is the same up to that fold.
pub fn measure(
    system: &[SystemBlock],
    active: &[&Message],
    tools: &[ToolDefinition],
    flags: &BTreeMap<String, ToolFlags>,
    model: &str,
    configured: Option<bool>,
) -> Breakdown {
    let wire: Vec<Vec<ApiMessage>> = active
        .iter()
        .map(|message| crate::api_messages(std::iter::once(*message), model, configured))
        .collect();
    let parts: Vec<MessagePart<'_>> = active
        .iter()
        .zip(&wire)
        .map(|(message, wire)| MessagePart { message, wire })
        .collect();
    let tool_parts: Vec<ToolPart<'_>> = tools
        .iter()
        .map(|definition| ToolPart {
            definition,
            deferred: flags
                .get(&definition.name)
                .is_some_and(|flag| flag.defer_loading),
        })
        .collect();
    classify(&Input {
        system,
        messages: &parts,
        tools: &tool_parts,
    })
}

/// [`measure`] for a caller that already knows each tool's deferral (the draft preview reads it from the tool list it
/// builds, not from request flags). `tools` pairs each definition with whether it is sent deferred.
pub fn measure_parts(
    system: &[SystemBlock],
    active: &[&Message],
    tools: &[(ToolDefinition, bool)],
    model: &str,
    configured: Option<bool>,
) -> Breakdown {
    let wire: Vec<Vec<ApiMessage>> = active
        .iter()
        .map(|message| crate::api_messages(std::iter::once(*message), model, configured))
        .collect();
    let parts: Vec<MessagePart<'_>> = active
        .iter()
        .zip(&wire)
        .map(|(message, wire)| MessagePart { message, wire })
        .collect();
    let tool_parts: Vec<ToolPart<'_>> = tools
        .iter()
        .map(|(definition, deferred)| ToolPart {
            definition,
            deferred: *deferred,
        })
        .collect();
    classify(&Input {
        system,
        messages: &parts,
        tools: &tool_parts,
    })
}

/// The stored record for a measured request: the wire categories and the estimate over all of them.
pub fn record(
    provider_id: &str,
    model_id: &str,
    measured_at_ms: u64,
    breakdown: &Breakdown,
) -> CompositionRecord {
    let categories = wire_categories(breakdown);
    CompositionRecord {
        provider_id: provider_id.to_owned(),
        model_id: model_id.to_owned(),
        measured_at_ms,
        estimated_tokens: breakdown.categories.iter().map(|c| c.tokens).sum(),
        categories,
        provider_usage: None,
    }
}

#[cfg(test)]
#[path = "composition_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "composition_projection_tests.rs"]
mod projection_tests;
