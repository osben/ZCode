use rust_cli_base::js::string::utf16_len;
use rust_cli_base::tokens::estimate_text;
use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::message::{
    AssistantMessage, AttachmentMessage, CompactBoundary, CompactTrigger, ContentBlock, Message,
    SystemMessage, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::model::{ApiMessage, SystemBlock, ToolDefinition, ToolFlags};
use serde_json::{Value, json};
use std::collections::BTreeMap;

use super::*;

fn human(id: &str, value: &str) -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: value.to_owned(),
        }],
        origin: UserOrigin::Human,
    })
}

fn attachment(id: &str, source: &str, body: &str) -> Message {
    Message::Attachment(AttachmentMessage {
        id: MessageId::new(id),
        source: source.to_owned(),
        text: body.to_owned(),
        data: Value::Null,
    })
}

fn assistant(id: &str, value: &str) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: value.to_owned(),
        }],
        model: "m".to_owned(),
        stop_reason: None,
        usage: None,
    })
}

fn tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.to_owned(),
        description: "does things".to_owned(),
        input_schema: json!({"type": "object"}),
        cache_control: None,
    }
}

fn block(text: &str) -> SystemBlock {
    SystemBlock {
        text: text.to_owned(),
        cache_control: None,
    }
}

fn classify_parts(
    system: &[SystemBlock],
    messages: &[Message],
    tools: &[ToolDefinition],
) -> Breakdown {
    let wire: Vec<Vec<ApiMessage>> = messages
        .iter()
        .map(|message| crate::api_messages(std::iter::once(message), "m", None))
        .collect();
    let parts: Vec<MessagePart<'_>> = messages
        .iter()
        .zip(&wire)
        .map(|(message, wire)| MessagePart { message, wire })
        .collect();
    let tool_parts: Vec<ToolPart<'_>> = tools
        .iter()
        .map(|definition| ToolPart {
            definition,
            deferred: false,
        })
        .collect();
    classify(&Input {
        system,
        messages: &parts,
        tools: &tool_parts,
    })
}

fn category(breakdown: &Breakdown, id: CategoryId) -> &Category {
    breakdown
        .categories
        .iter()
        .find(|category| category.id == id)
        .expect("every category is present")
}

#[test]
fn a_deferred_tool_is_sized_by_name_and_description_only() {
    let definition = ToolDefinition {
        name: "WebFetch".to_owned(),
        description: "fetch".to_owned(),
        input_schema: json!({"type": "object", "properties": {"url": {"type": "string"}}}),
        cache_control: None,
    };
    let tool_parts = [ToolPart {
        definition: &definition,
        deferred: true,
    }];
    let breakdown = classify(&Input {
        system: &[],
        messages: &[],
        tools: &tool_parts,
    });
    let deferred = category(&breakdown, CategoryId::DeferredToolSchemas);
    let expected = stringify(&json!({"name": "WebFetch", "description": "fetch"}));
    assert_eq!(deferred.chars, utf16_len(&expected) as u64);
    assert_eq!(
        category(&breakdown, CategoryId::SystemToolSchemas).tokens,
        0
    );
}

#[test]
fn measure_reads_the_deferred_flag_per_tool_name() {
    let fetch = tool("WebFetch");
    let read = tool("Read");
    let flags = BTreeMap::from([(
        "WebFetch".to_owned(),
        ToolFlags {
            defer_loading: true,
            ..ToolFlags::default()
        },
    )]);
    let breakdown = measure(&[], &[], &[fetch, read], &flags, "m", None);
    assert!(category(&breakdown, CategoryId::DeferredToolSchemas).tokens > 0);
    assert_eq!(
        category(&breakdown, CategoryId::SystemToolSchemas).items[0].name,
        "Read"
    );
}

#[test]
fn provider_usage_is_input_with_cache_and_context_with_output() {
    let usage = provider_usage(10, 2, 3, 4);
    assert_eq!(usage.input_tokens, 15);
    assert_eq!(usage.context_tokens, 19);
}

/// Node's CONTEXT_COMPOSITION_CATEGORY_IDS (packages/shared/src/zcode-protocol-v4/context-composition/contract.ts).
#[test]
fn category_ids_follow_node_order() {
    let names: Vec<&str> = CategoryId::ALL.iter().map(|id| id.as_str()).collect();
    assert_eq!(
        names,
        [
            "system_prompt",
            "meta_user_context",
            "skills",
            "tool_prompt",
            "system_tool_schemas",
            "mcp_tool_schemas",
            "app_tool_schemas",
            "deferred_tool_schemas",
            "reminders",
            "compact_summary",
            "messages",
        ]
    );
}

#[test]
fn breakdown_always_lists_the_eleven_categories() {
    let breakdown = classify_parts(&[], &[], &[]);
    assert_eq!(breakdown.categories.len(), 11);
    assert!(
        breakdown
            .categories
            .iter()
            .all(|c| c.tokens == 0 && c.items.is_empty())
    );
}

#[test]
fn system_blocks_count_as_system_prompt_with_node_estimate() {
    let text = "中文😀 system prompt";
    let breakdown = classify_parts(&[block(text)], &[], &[]);
    let system = category(&breakdown, CategoryId::SystemPrompt);
    assert_eq!(system.tokens, estimate_text(text));
    assert_eq!(system.chars, utf16_len(text) as u64);
    assert_eq!(system.items.len(), 1);
}

#[test]
fn tools_split_by_name_prefix() {
    let breakdown = classify_parts(
        &[],
        &[],
        &[
            tool("Read"),
            tool("mcp__github__search"),
            tool("app__open_page"),
        ],
    );
    for (id, name) in [
        (CategoryId::SystemToolSchemas, "Read"),
        (CategoryId::McpToolSchemas, "mcp__github__search"),
        (CategoryId::AppToolSchemas, "app__open_page"),
    ] {
        let found = category(&breakdown, id);
        assert_eq!(found.items.len(), 1, "{id:?}");
        assert_eq!(found.items[0].name, name);
        assert!(found.tokens > 0);
    }
    assert_eq!(
        category(&breakdown, CategoryId::DeferredToolSchemas).tokens,
        0
    );
}

#[test]
fn reminder_attachments_are_reminders_and_instructions_are_meta_user_context() {
    let messages = [
        attachment("a1", "environment", "cwd"),
        attachment("a2", "date", "today"),
        attachment("a3", "instructions", "AGENTS.md text"),
        attachment("a4", "file", "read output"),
    ];
    let breakdown = classify_parts(&[], &messages, &[]);
    let reminders = category(&breakdown, CategoryId::Reminders);
    let names: Vec<&str> = reminders.items.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["environment", "date"]);
    let instructions = category(&breakdown, CategoryId::MetaUserContext);
    assert_eq!(instructions.items[0].name, "instructions");
    // A file read is conversation content, not a reminder (Node: not in the reminder source list).
    let messages_category = category(&breakdown, CategoryId::Messages);
    assert_eq!(messages_category.items[0].name, "file");
}

#[test]
fn meta_origin_user_messages_use_their_source() {
    let meta = Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("m1"),
        content: vec![ContentBlock::Text {
            text: "plan exit".to_owned(),
        }],
        origin: UserOrigin::Meta {
            source: "plan_mode_exit".to_owned(),
        },
    });
    let breakdown = classify_parts(&[], &[meta], &[]);
    assert_eq!(
        category(&breakdown, CategoryId::Reminders).items[0].name,
        "plan_mode_exit"
    );
}

#[test]
fn compact_boundary_is_compact_summary_and_turns_are_messages() {
    let boundary = Message::System(SystemMessage::CompactBoundary(CompactBoundary {
        id: MessageId::new("b"),
        trigger: CompactTrigger::Auto,
        pre_tokens: 10,
        summary: MessageId::new("s"),
        preserved: None,
        discovered_tools: Vec::new(),
    }));
    // The summary is the message the boundary names; it is the compact summary, not a user turn.
    let messages = [
        human("h", "hello"),
        assistant("x", "hi"),
        human("s", "summary of earlier turns"),
        boundary,
    ];
    let breakdown = classify_parts(&[], &messages, &[]);
    assert!(category(&breakdown, CategoryId::CompactSummary).tokens > 0);
    let turns = category(&breakdown, CategoryId::Messages);
    let names: Vec<&str> = turns.items.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["user", "assistant"]);
}

#[test]
fn wire_drops_zero_categories_sorts_items_and_caps_them() {
    // Distinct source names keep 60 separate items in `messages` (same-name parts are summed into one item).
    let messages: Vec<Message> = (0..60)
        .map(|i| {
            attachment(
                &format!("a{i}"),
                &format!("file{i}"),
                &"x".repeat(i * 10 + 1),
            )
        })
        .collect();
    let breakdown = classify_parts(&[], &messages, &[]);
    let wire = wire_categories(&breakdown);
    assert_eq!(wire.len(), 1, "only the messages category is non-zero");
    assert_eq!(wire[0].id, "messages");
    let items = wire[0].items.as_ref().expect("items present");
    assert_eq!(items.len(), MAX_ITEMS);
    assert!(
        items
            .windows(2)
            .all(|pair| pair[0].tokens >= pair[1].tokens)
    );
}

#[test]
fn wire_truncates_item_names_in_utf16_units() {
    // 210 UTF-16 units: the cut is at 200 units, not at 200 characters or bytes.
    let long = format!("{}{}", "中".repeat(150), "x".repeat(60));
    let breakdown = classify_parts(&[], &[attachment("a", &long, "body")], &[]);
    let wire = wire_categories(&breakdown);
    let name = &wire[0].items.as_ref().unwrap()[0].name;
    assert_eq!(utf16_len(name), MAX_ITEM_NAME_UNITS);
}

#[test]
fn usage_projection_keeps_the_seven_coarse_sources_in_order() {
    let messages = [attachment("a1", "environment", "env"), human("h", "hello")];
    let breakdown = classify_parts(
        &[block("sys")],
        &messages,
        &[tool("mcp__s__t"), tool("app__p")],
    );
    let sources: Vec<&str> = usage_sources(&breakdown)
        .iter()
        .map(|(source, _, _)| source.as_str())
        .collect();
    assert_eq!(
        sources,
        [
            "system_prompt",
            "meta_user_context",
            "system_tool_schemas",
            "mcp_tool_schemas",
            "messages",
        ]
    );
}
