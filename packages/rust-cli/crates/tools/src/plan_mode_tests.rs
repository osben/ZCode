use std::sync::Arc;

use rust_cli_kernel_api::ids::AgentId;
use rust_cli_kernel_api::orchestration::{InteractionRequest, PlanApprovalAnswer};
use rust_cli_kernel_api::permission::{PermissionDecision, PermissionMode};
use rust_cli_kernel_api::testing::ScriptedInteractions;
use rust_cli_kernel_api::tool::{PromptContext, Tool, Validation};
use serde_json::json;
use tokio::sync::mpsc;

use super::*;
use crate::test_more::{Ctx, TextEnv, output_text};

const PLAN: &str = "# Plan\n1. do it";

fn approve(mode: PermissionMode) -> rust_cli_kernel_api::orchestration::Answer {
    PlanApprovalAnswer::Approve { mode }.into()
}

fn plan_context(interactions: Arc<ScriptedInteractions>) -> Ctx {
    let mut context = Ctx::with_session(interactions);
    context.set_text_env(Arc::new(TextEnv::new(&[])));
    context.mode = PermissionMode::Plan;
    context
}

#[tokio::test]
async fn entering_plan_mode_only_turns_the_plan_switch_on() {
    let interactions = Arc::new(ScriptedInteractions::default());
    let tool = EnterPlanModeTool::new(true);
    let context = Ctx::with_session(interactions.clone()).build();
    assert_eq!(
        tool.validate_input(&json!({}), &context).await,
        Validation::Ok
    );
    assert!(matches!(
        tool.check_permissions(&json!({}), &context).await,
        PermissionDecision::Allow { .. }
    ));
    let (progress, _) = mpsc::channel(1);
    let output = tool.call(json!({}), context, progress).await.unwrap();
    assert_eq!(output_text(&output), texts::ENTERED_PLAN_MODE);
    // 修复线 F20：只开 plan，不改权限模式。
    assert_eq!(interactions.plans(), [true]);
    // 子代理不能进入计划模式。
    let mut agent = Ctx::with_session(interactions);
    agent.agent = Some(AgentId::new("a1"));
    assert_eq!(
        tool.validate_input(&json!({}), &agent.build()).await,
        Validation::Invalid {
            message: texts::PLAN_MODE_MAIN_ONLY.to_owned(),
            error_code: Some(1),
        }
    );
}

#[test]
fn plan_tools_are_deferred_and_interactive_only() {
    for tool in [
        Arc::new(EnterPlanModeTool::new(false)) as Arc<dyn Tool>,
        Arc::new(ExitPlanModeTool::new(false)),
    ] {
        assert!(tool.should_defer());
        assert!(!tool.is_enabled());
    }
    let tool = EnterPlanModeTool::new(true);
    let with_bash = PromptContext {
        tool_names: vec!["Bash".to_owned()],
        mode: PermissionMode::Default,
    };
    let description = tool.description(&with_bash);
    assert!(
        description.contains(
            "1. Thoroughly explore the codebase using `find`/Glob, `grep`/Grep, and Read\n"
        )
    );
    assert!(!description.contains("{{"));
}

/// 修 bug（修复线 F9）：探索工具的写法按 Glob / Grep 在不在工具清单里，
/// 与这次请求带不带 Bash 无关；`/context` 的计数请求只带 EnterPlanMode 一个工具时以前写成 `Glob, Grep, and Read`。
#[test]
fn the_explore_tools_follow_the_search_tools_not_the_bash_tool() {
    let tool = EnterPlanModeTool::new(true);
    let describe = |names: &[&str]| {
        tool.description(&PromptContext {
            tool_names: names.iter().map(|name| (*name).to_owned()).collect(),
            mode: PermissionMode::Default,
        })
    };
    let lean = "1. Thoroughly explore the codebase using `find`/Glob, `grep`/Grep, and Read\n";
    let named = "1. Thoroughly explore the codebase using Glob, Grep, and Read\n";
    // 计数子集：只有 EnterPlanMode 自己。
    assert!(describe(&["EnterPlanMode"]).contains(lean));
    assert!(describe(&["Bash", "Read"]).contains(lean));
    // 启动参数点名了 Glob / Grep。
    assert!(describe(&["Bash", "Glob", "Grep", "Read"]).contains(named));
    assert!(describe(&["Grep"]).contains(named));
}

#[tokio::test]
async fn approving_the_plan_only_turns_the_plan_switch_off() {
    let interactions = Arc::new(ScriptedInteractions::new([approve(
        PermissionMode::AcceptEdits,
    )]));
    let tool = ExitPlanModeTool::new(true);
    let context = plan_context(interactions.clone()).build();
    assert_eq!(
        tool.validate_input(&json!({"plan": PLAN}), &context).await,
        Validation::Ok
    );
    let (progress, _) = mpsc::channel(1);
    let output = tool
        .call(json!({"plan": PLAN}), context, progress)
        .await
        .unwrap();
    assert_eq!(output_text(&output), texts::plan_approved(PLAN));
    // 修复线 F20：批准只关掉 plan，回答里的模式不用来改权限模式（退出后是进入前的模式，由会话 actor 保留）。
    assert_eq!(interactions.plans(), [false]);
    match &interactions.asked()[..] {
        [InteractionRequest::PlanApproval { plan, .. }] => assert_eq!(plan, PLAN),
        other => panic!("unexpected {other:?}"),
    }
}

/// Node 3.17 `ExitPlanModeInputSchema`：`plan` 必填、去掉首尾空白后非空、最多 20000 个字符。
#[tokio::test]
async fn the_plan_input_is_validated_like_node() {
    let tool = ExitPlanModeTool::new(true);
    let context = plan_context(Arc::new(ScriptedInteractions::default())).build();
    let invalid = |message: &str| Validation::Invalid {
        message: message.to_owned(),
        error_code: Some(1),
    };
    let blank = json!({"plan": " \n\t "});
    assert_eq!(
        tool.validate_input(&blank, &context).await,
        invalid("String must contain at least 1 character(s)")
    );
    assert_eq!(
        tool.validate_input(&json!({}), &context).await,
        invalid("Invalid input: expected string, received undefined")
    );
    assert_eq!(
        tool.validate_input(&json!({"plan": 3}), &context).await,
        invalid("Invalid input: expected string, received undefined")
    );
    // 最长 20000 个 UTF-16 码元：BMP 字符一个码元，表情符号两个。
    let max = "a".repeat(20_000);
    assert_eq!(
        tool.validate_input(&json!({"plan": max}), &context).await,
        Validation::Ok
    );
    let too_long = "a".repeat(20_001);
    assert_eq!(
        tool.validate_input(&json!({"plan": too_long}), &context)
            .await,
        invalid("Too big: expected string to have <=20000 characters")
    );
    let emoji_max = "😀".repeat(10_000);
    assert_eq!(
        tool.validate_input(&json!({"plan": emoji_max}), &context)
            .await,
        Validation::Ok
    );
    let emoji_too_long = "😀".repeat(10_001);
    assert_eq!(
        tool.validate_input(&json!({"plan": emoji_too_long}), &context)
            .await,
        invalid("Too big: expected string to have <=20000 characters")
    );
    // 执行时同样拒绝：没有批准请求，也不退出 plan。
    let interactions = Arc::new(ScriptedInteractions::default());
    let (progress, _) = mpsc::channel(1);
    let result = tool
        .call_with_messages(blank, plan_context(interactions.clone()).build(), progress)
        .await;
    assert!(result.is_err());
    assert!(interactions.asked().is_empty());
    assert!(interactions.plans().is_empty());
}

/// 没有计划（或计划全是空白）不会走到这里：输入校验先拒绝，所以批准文本只有有计划的一种。
#[tokio::test]
async fn the_approved_text_carries_the_trimmed_plan() {
    let interactions = Arc::new(ScriptedInteractions::new([approve(
        PermissionMode::Default,
    )]));
    let tool = ExitPlanModeTool::new(true);
    let (progress, _) = mpsc::channel(1);
    let output = tool
        .call(
            json!({"plan": "\n# Plan\n1. do it\n"}),
            plan_context(interactions.clone()).build(),
            progress,
        )
        .await
        .unwrap();
    assert_eq!(output_text(&output), texts::plan_approved(PLAN));
    assert_eq!(interactions.plans(), [false]);
}

#[tokio::test]
async fn keep_planning_rejects_with_the_feedback_and_keeps_the_mode() {
    let feedback = PlanApprovalAnswer::KeepPlanning {
        feedback: Some("add tests".to_owned()),
    };
    let interactions = Arc::new(ScriptedInteractions::new([
        rust_cli_kernel_api::orchestration::Answer::from(feedback),
    ]));
    let tool = ExitPlanModeTool::new(true);
    let (progress, _) = mpsc::channel(1);
    let output = tool
        .call(
            json!({"plan": PLAN}),
            plan_context(interactions.clone()).build(),
            progress,
        )
        .await
        .unwrap();
    assert!(output.is_error);
    assert_eq!(
        output_text(&output),
        format!("{REJECT_WITH_REASON}add tests")
    );
    assert!(interactions.plans().is_empty());
}

/// Node's `withPlanExitDeniedTurnStop`: a bare decline ends the turn, feedback does not.
#[tokio::test]
async fn a_decline_without_feedback_ends_the_turn() {
    let cases = [
        (PlanApprovalAnswer::KeepPlanning { feedback: None }, true),
        (
            PlanApprovalAnswer::KeepPlanning {
                feedback: Some("add tests".to_owned()),
            },
            false,
        ),
    ];
    for (answer, stops) in cases {
        let interactions = Arc::new(ScriptedInteractions::new([
            rust_cli_kernel_api::orchestration::Answer::from(answer),
        ]));
        let tool = ExitPlanModeTool::new(true);
        let (progress, _) = mpsc::channel(1);
        let called = tool
            .call_with_messages(
                json!({"plan": PLAN}),
                plan_context(interactions.clone()).build(),
                progress,
            )
            .await
            .unwrap();
        assert!(called.output.is_error);
        assert_eq!(called.stop_turn, stops);
    }
}

#[tokio::test]
async fn exit_outside_plan_mode_is_invalid() {
    let tool = ExitPlanModeTool::new(true);
    let context = Ctx::new(Arc::new(ScriptedInteractions::default())).build();
    assert_eq!(
        tool.validate_input(&json!({"plan": PLAN}), &context).await,
        Validation::Invalid {
            message: texts::NOT_IN_PLAN_MODE.to_owned(),
            error_code: Some(1),
        }
    );
}

#[tokio::test]
async fn a_subagent_plan_is_approved_without_touching_the_session_mode() {
    let interactions = Arc::new(ScriptedInteractions::new([approve(
        PermissionMode::Default,
    )]));
    let mut context = plan_context(interactions.clone());
    context.agent = Some(AgentId::new("a1"));
    let tool = ExitPlanModeTool::new(true);
    let (progress, _) = mpsc::channel(1);
    let output = tool
        .call(json!({"plan": PLAN}), context.build(), progress)
        .await
        .unwrap();
    assert_eq!(output_text(&output), texts::AGENT_PLAN_APPROVED);
    assert!(interactions.plans().is_empty());
}
