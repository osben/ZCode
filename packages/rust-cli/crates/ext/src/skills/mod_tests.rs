//! 清单：去掉禁止模型调用的与未激活的条件 skill（ext.md §2.3、§2.6）。

use std::sync::Arc;

use rust_cli_kernel_api::ids::{MessageId, ToolUseId};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, ToolResultContent, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::testing::MemoryEnvironment;
use serde_json::json;

use super::*;
use crate::test_support::{CWD, facts, workspace};

fn read(path: &str) -> Vec<Message> {
    vec![
        Message::Assistant(AssistantMessage {
            id: MessageId::new("a1"),
            content: vec![ContentBlock::ToolUse {
                id: ToolUseId::new("t1"),
                name: "Read".to_owned(),
                input: json!({"file_path": path}),
            }],
            model: "m".to_owned(),
            stop_reason: None,
            usage: None,
        }),
        Message::User(UserMessage {
            stall_execution: None,
            intent: None,
            id: MessageId::new("u1"),
            content: vec![ContentBlock::ToolResult {
                tool_use_id: ToolUseId::new("t1"),
                content: vec![ToolResultContent::Text {
                    text: "x".to_owned(),
                }],
                is_error: false,
            }],
            origin: UserOrigin::ToolResult {
                assistant: MessageId::new("a1"),
            },
        }),
    ]
}

#[tokio::test]
async fn the_listing_hides_model_disabled_and_inactive_conditional_skills() {
    let dir = format!("{CWD}/.zcode/skills");
    let env = MemoryEnvironment::new(facts())
        .with_file(
            &format!("{dir}/always/SKILL.md"),
            "---\ndescription: Always\n---\n",
        )
        .with_file(
            &format!("{dir}/hidden/SKILL.md"),
            "---\ndescription: H\ndisable-model-invocation: true\n---\n",
        )
        .with_file(
            &format!("{dir}/ts/SKILL.md"),
            "---\ndescription: TS\npaths: src/**/*.ts\n---\n",
        );
    let env = Arc::new(env);
    let catalog = SkillCatalog::new(env.clone(), env);
    // 内置的 `loop`、`init`、`security-review` 排在最后（builtin_tests.rs 里测），这里只看文件 skill。
    let lines = |entries: Vec<ListingEntry>| -> Vec<String> {
        let mut lines: Vec<String> = entries.into_iter().map(|entry| entry.line).collect();
        lines.retain(|line| {
            !["- loop: ", "- init: ", "- security-review: "]
                .iter()
                .any(|builtin| line.starts_with(builtin))
        });
        lines
    };
    assert_eq!(
        lines(catalog.listing(&workspace(), None, &[], "").await),
        ["- always: Always"]
    );
    let history = read(&format!("{CWD}/src/main.ts"));
    assert_eq!(
        lines(catalog.listing(&workspace(), None, &history, "").await),
        ["- always: Always", "- ts: TS"]
    );
}

/// `skills/referenceCatalog` entries: file skills only (no built-ins), the frontmatter name
/// when set, the directory name otherwise, and the `SKILL.md` path of the skill.
#[tokio::test]
async fn references_list_file_skills_with_their_skill_md_path() {
    let dir = format!("{CWD}/.zcode/skills");
    let env = MemoryEnvironment::new(facts())
        .with_file(
            &format!("{dir}/review/SKILL.md"),
            "---\nname: Code review\ndescription: Reviews\n---\n",
        )
        .with_file(
            &format!("{dir}/plain/SKILL.md"),
            "---\ndescription: Plain\n---\n",
        );
    let env = Arc::new(env);
    let catalog = SkillCatalog::new(env.clone(), env);
    let mut references = catalog.references(&workspace()).await;
    references.sort_by(|a, b| a.path.cmp(&b.path));
    let summary: Vec<(String, String, String)> = references
        .into_iter()
        .map(|reference| {
            (
                reference.name,
                reference.path,
                serde_json::to_value(reference.scope).unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                "plain".to_owned(),
                format!("{dir}/plain/SKILL.md"),
                "\"workspace\"".to_owned()
            ),
            (
                "Code review".to_owned(),
                format!("{dir}/review/SKILL.md"),
                "\"workspace\"".to_owned()
            ),
        ]
    );
}
