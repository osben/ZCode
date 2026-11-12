//! 计划模式 attachment 的节奏与文本（context.md §13）。

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvFacts, EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{AgentId, EnvironmentId, MessageId, SessionId};
use rust_cli_kernel_api::listing::{ListingEntry, ListingSource, Listings};
use rust_cli_kernel_api::message::{AttachmentMessage, ContentBlock, UserMessage};
use rust_cli_kernel_api::model::{ModelSelection, QuerySource};
use rust_cli_kernel_api::orchestration::{ContextBuilder, ContextRequest, OrchestrationError};
use rust_cli_kernel_api::plan::PlanModeFlags;
use rust_cli_kernel_api::testing::{FixedClock, MemoryEnvironment, SequentialIds};
use serde_json::{Value, json};

use super::*;
use crate::{ContextConfig, ContextPorts, PromptAssembler, Surface};
use rust_cli_prompts::texts;

const PLAN: &str = "/Users/dev/w/.zcode/plans/plan-sess_1.md";

pub(super) fn human() -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("u"),
        content: vec![ContentBlock::Text {
            text: "go".to_owned(),
        }],
        origin: UserOrigin::Human,
    })
}

pub(super) fn marker(source: &str) -> Message {
    Message::Attachment(AttachmentMessage {
        id: MessageId::new("p"),
        source: source.to_owned(),
        text: String::new(),
        data: Value::Null,
    })
}

pub(super) fn humans(count: usize) -> Vec<Message> {
    (0..count).map(|_| human()).collect()
}

struct Skills;

#[async_trait]
impl ListingSource for Skills {
    async fn listings(&self, _request: &ContextRequest) -> Result<Listings, OrchestrationError> {
        Ok(Listings {
            skills: vec![ListingEntry {
                name: "review".to_owned(),
                line: "- review".to_owned(),
            }],
            ..Listings::default()
        })
    }
}

fn assembler(home: Option<&str>, plan: Option<&str>) -> PromptAssembler {
    assembler_with(home, plan.map(|path| (path, "# Plan\n")))
}

fn assembler_with(home: Option<&str>, plan: Option<(&str, &str)>) -> PromptAssembler {
    let facts = EnvFacts {
        cwd: EnvPath::new("/Users/dev/w"),
        platform: "linux".to_owned(),
        os_version: "Linux 6.8.0".to_owned(),
        shell: "bash".to_owned(),
        is_git_repo: false,
        home: home.map(EnvPath::new),
        uid: None,
    };
    let mut env = MemoryEnvironment::new(facts);
    if let Some((path, text)) = plan {
        env = env.with_file(path, text);
    }
    let env = Arc::new(env);
    PromptAssembler::new(
        ContextPorts {
            info: env.clone(),
            files: env.clone(),
            shell: env.clone(),
            git: env,
            clock: Arc::new(FixedClock(1_792_224_000_000)),
            ids: Arc::new(SequentialIds::default()),
            listings: Arc::new(Skills),
        },
        ContextConfig::new(Surface::Interactive),
    )
}

fn request(mode: PermissionMode, agent: Option<&str>) -> ContextRequest {
    let (session, source) = match agent {
        Some(_) => (
            "sess_subagent_agent_1",
            QuerySource::Subagent("general-purpose".to_owned()),
        ),
        None => ("sess_1", QuerySource::MainThread),
    };
    ContextRequest {
        agent: agent.map(AgentId::new),
        tool_names: ["Bash", "Skill"].map(str::to_owned).to_vec(),
        ..ContextRequest::new(
            SessionId::new(session),
            WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/Users/dev/w"),
            },
            source,
            mode,
            ModelSelection::new("p".to_owned(), rust_cli_base::models::GLM_5_3.to_owned()),
        )
    }
}

async fn plan_attachments(
    assembler: &PromptAssembler,
    request: ContextRequest,
    history: &[Message],
) -> Vec<AttachmentMessage> {
    let built = assembler.step(request, history).await.unwrap();
    built
        .attachments
        .into_iter()
        .filter(|attachment| attachment.source.starts_with("plan_mode"))
        .collect()
}

fn sources(attachments: &[AttachmentMessage]) -> Vec<&str> {
    attachments
        .iter()
        .map(|attachment| attachment.source.as_str())
        .collect()
}

#[tokio::test]
async fn the_full_reminder_comes_after_the_skill_listing_without_a_plan_file_path() {
    let built = assembler(Some("/Users/dev"), None)
        .step(request(PermissionMode::Plan, None), &[human()])
        .await
        .unwrap();
    let order: Vec<&str> = built
        .attachments
        .iter()
        .map(|attachment| attachment.source.as_str())
        .collect();
    let at = |name: &str| order.iter().position(|source| *source == name).unwrap();
    assert!(at("skill_listing") < at(PLAN_MODE));
    assert!(at(PLAN_MODE) < at("total_tokens_reminder"));
    let reminder = &built.attachments[at(PLAN_MODE)];
    assert_eq!(
        reminder.text,
        format!(
            "<system-reminder>\n{}\n</system-reminder>",
            texts::plan_mode_full()
        )
    );
    assert!(!reminder.text.contains("Plan File Info"));
    assert!(
        reminder
            .text
            .contains("pass the complete final plan in its `plan` parameter")
    );
    assert_eq!(
        reminder.data,
        json!({"reminderType": "full", "isSubAgent": false, "planFilePath": PLAN, "planExists": false})
    );
}

#[tokio::test]
async fn an_existing_plan_file_does_not_change_the_reminder_text() {
    let found = plan_attachments(
        &assembler(Some("/Users/dev"), Some(PLAN)),
        request(PermissionMode::Plan, None),
        &[human()],
    )
    .await;
    assert_eq!(sources(&found), [PLAN_MODE]);
    assert!(!found[0].text.contains(PLAN));
    assert_eq!(found[0].data["planExists"], json!(true));
}

#[tokio::test]
async fn the_sparse_reminder_is_one_fixed_line() {
    let mut history = vec![human(), marker(PLAN_MODE)];
    history.extend(humans(5));
    let found = plan_attachments(
        &assembler(Some("/Users/dev"), None),
        request(PermissionMode::Plan, None),
        &history,
    )
    .await;
    assert_eq!(
        found[0].text,
        format!(
            "<system-reminder>\n{}\n</system-reminder>",
            texts::plan_mode_sparse()
        )
    );
    assert!(!found[0].text.contains(PLAN));
    assert_eq!(found[0].data["reminderType"], json!("sparse"));
}

fn with_flags(mut request: ContextRequest, flags: PlanModeFlags) -> ContextRequest {
    request.plan_flags = flags;
    request
}

/// Node 3.17 没有再次进入的提醒：离开过 plan 的标志为真时，只有普通的完整提醒，没有 reentry。
#[tokio::test]
async fn reentering_gets_the_ordinary_reminder_and_no_reentry() {
    let history = vec![human(), marker(PLAN_MODE), marker(EXIT), human()];
    let exited = PlanModeFlags {
        has_exited: true,
        needs_exit_attachment: false,
    };
    let found = plan_attachments(
        &assembler(Some("/Users/dev"), Some(PLAN)),
        with_flags(request(PermissionMode::Plan, None), exited),
        &history,
    )
    .await;
    assert_eq!(sources(&found), [PLAN_MODE]);
    assert_eq!(found[0].data["reminderType"], json!("full"));
}

#[tokio::test]
async fn the_exit_reminder_has_no_plan_file_reference() {
    let history = vec![human(), marker(PLAN_MODE)];
    let found = plan_attachments(
        &assembler(Some("/Users/dev"), Some(PLAN)),
        request(PermissionMode::AcceptEdits, None),
        &history,
    )
    .await;
    assert_eq!(
        found[0].text,
        "<system-reminder>\n## Exited Plan Mode\n\nYou have exited plan mode. You can now make edits, run tools, and take actions.\n</system-reminder>"
    );
    assert_eq!(
        found[0].data,
        json!({"planFilePath": PLAN, "planExists": true})
    );
}

#[tokio::test]
async fn subagents_get_the_read_only_reminder_and_ask_only_when_they_can_ask() {
    // 子代理跑在子会话：同一目录下的 `plan-<子会话>.md`（tools-more.md §2.2、D15）。
    let plan = "/Users/dev/w/.zcode/plans/plan-sess_subagent_agent_1.md";
    // 子代理的 plan_mode 只在工具轮结束时的当步 attachment 里（F16，agents.md §4.3），这里直接取那一组。
    let found = assembler(Some("/Users/dev"), None)
        .turn_attachments(request(PermissionMode::Plan, Some("a1")), &[human()])
        .await
        .unwrap();
    let order: Vec<&str> = found
        .iter()
        .map(|attachment| attachment.source.as_str())
        .collect();
    let at = |name: &str| order.iter().position(|source| *source == name).unwrap();
    assert!(at("skill_listing") < at(PLAN_MODE));
    let reminder = &found[at(PLAN_MODE)];
    assert_eq!(
        reminder.text,
        format!(
            "<system-reminder>\n{}\n</system-reminder>",
            texts::plan_mode_subagent()
        )
    );
    assert!(!reminder.text.contains("AskUserQuestion"));
    assert!(!reminder.text.contains("Phase 1"));
    assert_eq!(reminder.data["isSubAgent"], json!(true));
    assert_eq!(reminder.data["planFilePath"], json!(plan));

    let mut with_ask = request(PermissionMode::Plan, Some("a1"));
    with_ask.tool_names.push("AskUserQuestion".to_owned());
    let found = assembler(Some("/Users/dev"), None)
        .turn_attachments(with_ask, &[human()])
        .await
        .unwrap();
    let reminder = found.iter().find(|a| a.source == PLAN_MODE).unwrap();
    assert_eq!(
        reminder.text,
        format!(
            "<system-reminder>\n{}\n</system-reminder>",
            texts::plan_mode_subagent_ask()
        )
    );
}

/// 计划文件在工作区里（Node 的位置），不再依赖 home。
#[tokio::test]
async fn the_plan_file_does_not_depend_on_the_home_directory() {
    let found = plan_attachments(
        &assembler(None, None),
        request(PermissionMode::Plan, None),
        &[human()],
    )
    .await;
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].data["planFilePath"], json!(PLAN));
}

/// F10（compact.md §3.4）：模式是 plan 时压缩附件带一条完整的 `plan_mode`，排在清单之前；
/// 不是 plan 时没有。以前由压缩后下一步的上下文补发，当步的 attachment 改到工具轮之后产生后放进压缩附件。
#[tokio::test]
async fn compaction_attaches_a_full_plan_reminder_in_plan_mode() {
    use rust_cli_kernel_api::compaction::PostCompactContext;
    let assembler = assembler(Some("/Users/dev"), Some(PLAN));
    let restored = assembler
        .post_compact(request(PermissionMode::Plan, None), &[])
        .await
        .unwrap();
    assert_eq!(
        restored
            .iter()
            .take(2)
            .map(|item| item.source.as_str())
            .collect::<Vec<_>>(),
        [PLAN_FILE_REFERENCE, PLAN_MODE]
    );
    assert_eq!(
        restored[1].data,
        json!({"reminderType": "full", "isSubAgent": false, "planFilePath": PLAN, "planExists": true})
    );
    let restored = assembler
        .post_compact(request(PermissionMode::Default, None), &[])
        .await
        .unwrap();
    assert!(
        restored
            .iter()
            .all(|item| !item.source.starts_with("plan_mode"))
    );
}

/// Node `readApprovedPlanFileReferenceEntry`: after compaction the approved plan file is referenced with
/// its path and raw content, first among the context attachments and in every mode.
#[tokio::test]
async fn compaction_references_the_approved_plan_file_in_any_mode() {
    use rust_cli_kernel_api::compaction::PostCompactContext;
    let plan = "  1. Persist the plan.\n2. Keep it.\n";
    let assembler = assembler_with(Some("/Users/dev"), Some((PLAN, plan)));
    let restored = assembler
        .post_compact(request(PermissionMode::Default, None), &[])
        .await
        .unwrap();
    let first = restored.first().expect("a plan file reference");
    assert_eq!(first.source, PLAN_FILE_REFERENCE);
    assert_eq!(first.data, json!({ "planFilePath": PLAN }));
    let expected = format!(
        "A plan file exists from plan mode at: {PLAN}\n\nPlan contents:\n\n{plan}\n\nIf this plan is relevant to the current work and not already complete, continue working on it."
    );
    assert_eq!(first.text, rust_cli_prompts::reminder::wrap(&expected));
    assert_eq!(
        restored
            .iter()
            .filter(|item| item.source == PLAN_FILE_REFERENCE)
            .count(),
        1
    );
}

#[tokio::test]
async fn compaction_skips_a_missing_blank_or_oversized_plan_file() {
    use rust_cli_kernel_api::compaction::PostCompactContext;
    let oversized = "x".repeat(20_000 * 4 + 1025);
    for plan in [None, Some(" \n\t\n"), Some(oversized.as_str())] {
        let assembler = assembler_with(Some("/Users/dev"), plan.map(|text| (PLAN, text)));
        let restored = assembler
            .post_compact(request(PermissionMode::Plan, None), &[])
            .await
            .unwrap();
        assert!(
            restored
                .iter()
                .all(|item| item.source != PLAN_FILE_REFERENCE),
            "plan file {:?}",
            plan.map(str::len)
        );
    }
}
