//! Context composition (Node `runtime/context-composition/classifier.ts`, spec
//! `specs/fork-rust-agent-parity.md`, "Context composition, session deletion and model-request metrics"): one model
//! request split into the eleven categories of `v4/conversation/contextComposition`, and the coarse seven of the
//! usage ring.
//!
//! Pure functions only. The request is read, never changed. Sizes are UTF-16 units (`chars`) and Node's token
//! estimate (`estimate_text`). Where Rust's request model has no Node counterpart, the difference is listed in the
//! spec; the names of the categories and the wire shape follow Node.

use rust_cli_base::js::json::stringify;
use rust_cli_base::js::string::{utf16_len, utf16_prefix};
use rust_cli_base::tokens::estimate_text;
use rust_cli_kernel_api::message::{Message, SystemMessage, UserOrigin};
use rust_cli_kernel_api::model::{SystemBlock, ToolDefinition};
use serde_json::{Value, json};

/// Node `CONTEXT_COMPOSITION_MAX_ITEMS`.
pub const MAX_ITEMS: usize = 50;
/// Node `CONTEXT_COMPOSITION_MAX_ITEM_NAME_CHARS` (UTF-16 units, as JS `slice` counts them).
pub const MAX_ITEM_NAME_UNITS: usize = 200;

/// Node's reminder sources that Rust also raises as attachments (`SYSTEM_REMINDER_SOURCES` names that have a Rust
/// attachment source). An attachment or meta message with one of these sources is counted as `reminders`.
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

/// The eleven categories, in Node's order.
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

    /// The coarse usage-ring source of this category (Node `USAGE_SOURCE_BY_CATEGORY`). Deferred tools are projected
    /// by origin in Node; Rust has no deferred tools in its request model, so they follow the built-in source here.
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

    /// Position in [`Self::ALL`]; the declaration order above is that order (checked by `category_ids_follow_node_order`).
    fn index(self) -> usize {
        self as usize
    }
}

/// The seven coarse sources of the usage ring (Node `ContextCompositionUsageSource`), in ring order.
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

/// One named part of a category: a tool, a system block, a reminder source, a message role.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub name: String,
    pub chars: u64,
    pub tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Category {
    pub id: CategoryId,
    pub chars: u64,
    pub tokens: u64,
    pub items: Vec<Item>,
}

/// One request's full breakdown: always the eleven categories, in [`CategoryId::ALL`] order, zero values included.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Breakdown {
    pub categories: Vec<Category>,
}

/// The request parts the classifier reads. Borrowed: classifying never changes the request.
pub struct Input<'a> {
    pub system: &'a [SystemBlock],
    pub messages: &'a [Message],
    pub tools: &'a [ToolDefinition],
}

/// Node `toContextCompositionCategories`: a category as it goes on the wire (zero categories dropped, items sorted by
/// tokens descending, at most [`MAX_ITEMS`], names cut to [`MAX_ITEM_NAME_UNITS`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WireCategory {
    pub id: &'static str,
    pub tokens: u64,
    pub chars: u64,
    pub items: Option<Vec<WireItem>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WireItem {
    pub name: String,
    pub tokens: u64,
}

#[derive(Default)]
struct Accumulator {
    chars: u64,
    tokens: u64,
    items: Vec<Item>,
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
        let slot = &mut self.slots[id.index()];
        slot.chars += chars;
        slot.tokens += tokens;
        match slot.items.iter_mut().find(|item| item.name == name) {
            Some(item) => {
                item.chars += chars;
                item.tokens += tokens;
            }
            None => slot.items.push(Item {
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
/// - System blocks are `system_prompt`. Rust does not keep Node's per-section metadata, so there are no
///   `skills` or `tool_prompt` sections here (see the spec's deviation list).
/// - Each message is sized by its JSON, the way Node sizes its projected message.
/// - Attachments and meta messages go by source: instructions to `meta_user_context`, the reminder sources to
///   `reminders`, the rest to `messages`.
/// - A compact boundary is `compact_summary`. A turn is `messages`, named by its role.
/// - Tools go by name: `mcp__` to `mcp_tool_schemas`, `app__` to `app_tool_schemas`, the rest to
///   `system_tool_schemas`. Each is sized by its name, description and input schema.
pub fn classify(input: &Input<'_>) -> Breakdown {
    let mut builder = Builder::new();
    for block in input.system {
        builder.add(CategoryId::SystemPrompt, "system_block", &block.text);
    }
    for message in input.messages {
        let (id, name) = message_category(message);
        let content = serde_json::to_value(message).unwrap_or(Value::Null);
        builder.add(id, &name, &stringify(&content));
    }
    for tool in input.tools {
        let id = tool_category(&tool.name);
        let content = json!({
            "name": tool.name,
            "description": tool.description,
            "inputSchema": tool.input_schema,
        });
        builder.add(id, &tool.name, &stringify(&content));
    }
    builder.finish()
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

fn source_category(source: &str) -> (CategoryId, String) {
    let id = if source == INSTRUCTION_SOURCE {
        CategoryId::MetaUserContext
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

/// Node `toContextCompositionCategories`.
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

#[cfg(test)]
#[path = "composition_tests.rs"]
mod tests;
