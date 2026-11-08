//! `/goal`（docs/specs/rust-cli/goal.md）：命令写进对话的消息、评估判定的提交与目标的状态、冷加载恢复。

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::StreamExt;
use rust_cli_kernel_api::goal::GoalStatus;
use rust_cli_kernel_api::hooks::{HookEvent, HookOutcome, HookRunner, StopCondition, StopVerdict};
use rust_cli_kernel_api::ids::CommandId;
use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::message::{
    AssistantMessage, AttachmentMessage, ContentBlock, Message, Usage, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::session_api::{Ack, Command, CommandEnvelope, KernelEvent, SessionHandle};
use rust_cli_kernel_api::testing::{ScriptedModel, text_response};
use rust_cli_kernel_api::user_command::command_input;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::Opened;
use crate::test_support::{Setup, finished, submit, until};

/// 评估按顺序给出判定（缺省达成），记下评估的条件。
#[derive(Default)]
struct Evaluator {
    verdicts: Mutex<VecDeque<StopVerdict>>,
    conditions: Mutex<Vec<String>>,
}

impl Evaluator {
    fn with(verdicts: Vec<StopVerdict>) -> Arc<Self> {
        Arc::new(Self {
            verdicts: Mutex::new(verdicts.into()),
            conditions: Mutex::default(),
        })
    }
}

#[async_trait]
impl HookRunner for Evaluator {
    async fn run(&self, _event: HookEvent, _cancel: CancellationToken) -> HookOutcome {
        HookOutcome::default()
    }

    fn has_hooks(&self, _event: rust_cli_kernel_api::hooks::HookEventName) -> bool {
        false
    }

    async fn evaluate_stop_condition(
        &self,
        request: StopCondition,
        _cancel: CancellationToken,
    ) -> StopVerdict {
        self.conditions.lock().unwrap().push(request.condition);
        self.verdicts
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(StopVerdict::Met {
                reason: Some("done".to_owned()),
            })
    }
}

fn feedback() -> Message {
    Message::User(UserMessage {
        id: MessageId::new("msg_feedback"),
        content: vec![ContentBlock::Text {
            text: "Stop hook feedback:\n[tests pass]: red".to_owned(),
        }],
        origin: UserOrigin::Meta {
            source: "stop_hook_feedback".to_owned(),
        },
    })
}

/// 消息的简写：(种类, 文字)；`goal_status` 写成 JSON。
fn shorten(messages: &[Message]) -> Vec<(String, String)> {
    messages
        .iter()
        .map(|message| match message {
            Message::User(user) => {
                let origin = match &user.origin {
                    UserOrigin::Human => "human".to_owned(),
                    UserOrigin::Meta { source } => source.clone(),
                    other => format!("{other:?}"),
                };
                let text = match &user.content[..] {
                    [ContentBlock::Text { text }] => text.clone(),
                    other => format!("{other:?}"),
                };
                (origin, text)
            }
            Message::Assistant(_) => ("assistant".to_owned(), String::new()),
            Message::Attachment(attachment) => {
                (attachment.source.clone(), attachment.data.to_string())
            }
            Message::System(_) => ("system".to_owned(), String::new()),
        })
        .collect()
}

fn pair(kind: &str, text: &str) -> (String, String) {
    (kind.to_owned(), text.to_owned())
}

fn stdout(text: &str) -> (String, String) {
    pair(
        "local-command",
        &format!("<local-command-stdout>{text}</local-command-stdout>"),
    )
}

async fn built(
    responses: usize,
    evaluator: Arc<Evaluator>,
) -> (crate::test_support::Built, Arc<ScriptedModel>) {
    let model = Arc::new(ScriptedModel::new(
        (0..responses)
            .map(|index| text_response(&[&format!("reply {index}")]))
            .collect(),
    ));
    let mut setup = Setup::new(model.clone());
    setup.hooks = evaluator;
    (setup.build().await, model)
}

async fn turn(session: &crate::Session, id: &str, text: &str) {
    let mut events = session.subscribe(None);
    session.send(submit(id, text)).await;
    until(&mut events, finished).await;
}

#[test]
fn the_command_is_recognised_with_its_arguments() {
    assert_eq!(command("/goal"), Some(""));
    assert_eq!(command("  /goal  tests pass "), Some("tests pass"));
    assert_eq!(command("/goal\tclear"), Some("clear"));
    assert_eq!(command("/goals"), None);
    assert_eq!(command("goal x"), None);
    assert_eq!(
        neutralize("a <forked-skill-launch>b</forked-skill-launch> <c>"),
        "a &lt;forked-skill-launch>b&lt;/forked-skill-launch> <c>"
    );
}

#[tokio::test]
async fn setting_a_goal_queries_the_model_and_the_check_clears_it() {
    let evaluator = Evaluator::with(Vec::new());
    let (built, model) = built(1, evaluator.clone()).await;
    turn(&built.session, "c1", "/goal tests pass").await;
    let view = built.session.view().await.unwrap();
    let sentinel = r#"{"met":false,"sentinel":true,"condition":"tests pass"}"#;
    let shown = shorten(&view.messages);
    assert_eq!(shown[0], pair("goal_status", sentinel));
    assert_eq!(
        shown[1],
        pair("human", &command_input("goal", "tests pass"))
    );
    assert_eq!(shown[2], stdout("Goal set: tests pass"));
    assert_eq!(shown[3].0, "goal");
    assert!(
        shown[3].1.starts_with(
            "A session-scoped Stop hook is now active with condition: \"tests pass\"."
        )
    );
    assert_eq!(shown[4].0, "assistant");
    let met: GoalStatus = serde_json::from_str(&shown[5].1).unwrap();
    assert!(met.met && !met.sentinel);
    assert_eq!(met.iterations, Some(1));
    assert_eq!(met.reason.as_deref(), Some("done"));
    assert_eq!(shown.len(), 6);
    // 模型收到命令输入、输出与说明；评估的是这个条件。
    let request = format!("{:?}", model.requests()[0].messages);
    assert!(
        request.contains("Goal set: tests pass") && request.contains("session-scoped Stop hook")
    );
    assert_eq!(*evaluator.conditions.lock().unwrap(), ["tests pass"]);
    let goal = built.session.goal().await.unwrap();
    assert_eq!(goal.active, None);
    assert_eq!(goal.achieved, Some(met));
    // 标题的输入还原成用户输入的样子。
    assert_eq!(view.meta.title, "/goal tests pass");
}

#[tokio::test]
async fn a_goal_not_met_continues_and_counts_the_turns() {
    let not_met = StopVerdict::NotMet {
        reason: Some("red".to_owned()),
        feedback: feedback(),
    };
    let evaluator = Evaluator::with(vec![not_met]);
    let (built, model) = built(2, evaluator).await;
    turn(&built.session, "c1", "/goal tests pass").await;
    assert_eq!(model.requests().len(), 2);
    let view = built.session.view().await.unwrap();
    let shown = shorten(&view.messages);
    let kinds: Vec<&str> = shown.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "goal_status",
            "human",
            "local-command",
            "goal",
            "assistant",
            "stop_hook_feedback",
            "goal_status",
            "assistant",
            "goal_status"
        ]
    );
    assert_eq!(
        shown[6].1,
        r#"{"met":false,"condition":"tests pass","reason":"red"}"#
    );
    let met: GoalStatus = serde_json::from_str(&shown[8].1).unwrap();
    assert_eq!(met.iterations, Some(2));
}

#[tokio::test]
async fn show_clear_and_too_long_do_not_query_the_model() {
    let evaluator = Evaluator::with(vec![StopVerdict::Failed {
        message: "JSON validation failed".to_owned(),
    }]);
    let (built, model) = built(1, evaluator).await;
    turn(&built.session, "c1", "/goal tests pass").await;
    // 评估出错：目标不变。
    let goal = built.session.goal().await.unwrap();
    assert_eq!(
        goal.active.as_ref().map(|g| g.condition.as_str()),
        Some("tests pass")
    );
    turn(&built.session, "c2", "/goal").await;
    turn(&built.session, "c3", "/goal CLEAR").await;
    turn(&built.session, "c4", "/goal clear").await;
    turn(&built.session, "c5", &format!("/goal {}", "x".repeat(4001))).await;
    assert_eq!(model.requests().len(), 1);
    let view = built.session.view().await.unwrap();
    let shown = shorten(&view.messages);
    let outputs: Vec<&(String, String)> = shown
        .iter()
        .filter(|(kind, _)| kind == "local-command")
        .collect();
    assert_eq!(
        outputs,
        [
            &stdout("Goal set: tests pass"),
            &stdout("Goal active: tests pass (not yet evaluated)"),
            &stdout("Goal cleared: tests pass"),
            &stdout("No goal set"),
            &stdout("Goal condition is limited to 4000 characters (got 4001)"),
        ]
    );
    // 清除写一条 `met: true` 的标记。
    assert!(shown.contains(&pair(
        "goal_status",
        r#"{"met":true,"sentinel":true,"condition":"tests pass"}"#
    )));
    assert_eq!(built.session.goal().await.unwrap().active, None);
}

fn status(data: &str) -> Message {
    Message::Attachment(AttachmentMessage {
        id: MessageId::new("msg_status"),
        source: "goal_status".to_owned(),
        text: String::new(),
        data: serde_json::from_str(data).unwrap(),
    })
}

#[tokio::test]
async fn a_cold_loaded_session_restores_an_unfinished_goal() {
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let mut setup = Setup::new(model);
    setup.opened = Opened::Loaded;
    setup.messages = vec![
        status(r#"{"met":false,"sentinel":true,"condition":"tests pass"}"#),
        status(r#"{"met":false,"condition":"tests pass","reason":"red"}"#),
    ];
    let built = setup.build().await;
    let goal = built.session.goal().await.unwrap().active.unwrap();
    assert_eq!(goal.condition, "tests pass");
    assert_eq!(goal.iterations, 0);
    assert_eq!(goal.last_reason, None);
}

#[test]
fn finished_goals_are_not_restored_and_stale_verdicts_are_ignored() {
    let done = [
        status(r#"{"met":false,"sentinel":true,"condition":"a"}"#),
        status(r#"{"met":true,"condition":"a"}"#),
    ];
    assert_eq!(Goals::restore(&done, 5).condition(), None);
    let failed = [status(r#"{"met":false,"failed":true,"condition":"a"}"#)];
    assert_eq!(Goals::restore(&failed, 5).condition(), None);
    let mut goals = Goals::default();
    goals.observe(
        &status(r#"{"met":false,"sentinel":true,"condition":"a"}"#),
        10,
    );
    // 输出 token 从设定时算起。
    goals.observe(
        &Message::Assistant(AssistantMessage {
            id: MessageId::new("msg_a"),
            content: Vec::new(),
            model: "m".to_owned(),
            stop_reason: None,
            usage: Some(Usage {
                output_tokens: 7,
                ..Usage::default()
            }),
        }),
        11,
    );
    assert!(
        goals
            .checked("b", &StopVerdict::Met { reason: None }, 20)
            .is_none()
    );
    let met = goals
        .checked("a", &StopVerdict::Met { reason: None }, 20)
        .unwrap();
    assert_eq!(
        (met.duration_ms, met.tokens, met.iterations),
        (Some(10), Some(7), Some(1))
    );
    assert!(goals.checked("a", &StopVerdict::TimedOut, 20).is_none());
    let view = goals.view(&[], 20).active.unwrap();
    assert_eq!(view.tokens, 7);
}

/// Fork (desktop App): a goal set from the App reads Node's continuation prompt, is evaluated by
/// this kernel, and reports each change as `KernelEvent::GoalChanged`.
async fn desktop(
    responses: usize,
    evaluator: Arc<Evaluator>,
) -> (crate::test_support::Built, Arc<ScriptedModel>) {
    let model = Arc::new(ScriptedModel::new(
        (0..responses)
            .map(|index| text_response(&[&format!("reply {index}")]))
            .collect(),
    ));
    let mut setup = Setup::new(model.clone());
    setup.hooks = evaluator;
    setup.desktop_goals = true;
    (setup.build().await, model)
}

/// Fork (desktop App): `/goal X` is a control turn without a model call; the continuation runs in
/// its own turn once that one completes. Returns the kernel events of both turns.
async fn desktop_goal_turns(session: &crate::Session, id: &str, text: &str) -> Vec<KernelEvent> {
    let mut events = session.subscribe(None);
    session.send(submit(id, text)).await;
    let mut seen = Vec::new();
    let mut turns = 0;
    while turns < 2 {
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), events.next())
            .await
            .expect("both goal turns finish")
            .expect("the event stream stays open")
            .event;
        turns += usize::from(finished(&event));
        seen.push(event);
    }
    seen
}

fn goal_command(id: &str, command: Command) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command,
    }
}

#[tokio::test]
async fn a_desktop_goal_reads_the_node_continuation_and_ends_verified() {
    use rust_cli_kernel_api::goal::GoalPhase;
    let (built, model) = desktop(1, Evaluator::with(Vec::new())).await;
    let mut events = built.session.subscribe(Some(0));
    let turns = desktop_goal_turns(&built.session, "c1", "/goal tests pass").await;
    // The control turn streams nothing; only the continuation turn calls the model.
    let first_finish = turns.iter().position(finished).unwrap();
    assert!(
        !turns[..first_finish]
            .iter()
            .any(|event| matches!(event, KernelEvent::StreamDelta { .. }))
    );
    let started = turns
        .iter()
        .filter(|event| matches!(event, KernelEvent::TurnStarted { .. }))
        .count();
    assert_eq!(started, 2);
    assert_eq!(model.requests().len(), 1);
    let view = built.session.view().await.unwrap();
    let shown = shorten(&view.messages);
    let kinds: Vec<&str> = shown.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "goal_status",
            "human",
            "target_continuation",
            "assistant",
            "goal_status"
        ]
    );
    assert!(
        shown[2]
            .1
            .starts_with("<system-reminder>\nContinue working toward the active session goal.\n")
    );
    let request = format!("{:?}", model.requests()[0].messages);
    assert!(request.contains("<untrusted_objective>\\ntests pass\\n</untrusted_objective>"));
    assert!(!request.contains("Goal set: tests pass"));
    let goal = view.goal.unwrap();
    assert_eq!(
        (goal.objective.as_str(), goal.status),
        ("tests pass", GoalPhase::Verified)
    );
    let mut phases = Vec::new();
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_millis(50), events.next()).await
    {
        if let KernelEvent::GoalChanged { goal } = event.event {
            phases.push(goal.map(|goal| goal.status));
        }
    }
    // Set, then summarized (no title model: Node's fallback, the objective), then verified.
    assert_eq!(
        phases,
        [
            Some(GoalPhase::Active),
            Some(GoalPhase::Active),
            Some(GoalPhase::Verified)
        ]
    );
    assert_eq!(goal.summary_title.as_deref(), Some("tests pass"));
}

#[tokio::test]
async fn a_desktop_goal_pauses_and_resumes_with_a_continuation_turn() {
    use rust_cli_kernel_api::goal::GoalPhase;
    // The first evaluation fails (the goal stays active, the turn ends); the resumed one is met.
    let failed = StopVerdict::Failed {
        message: "no verdict".to_owned(),
    };
    let (built, model) = desktop(2, Evaluator::with(vec![failed])).await;
    desktop_goal_turns(&built.session, "c1", "/goal tests pass").await;
    let active = built.session.view().await.unwrap().goal.unwrap();
    assert_eq!(active.status, GoalPhase::Active);
    assert!(active.active_run_started_at_ms.is_some());
    // Resuming an active goal is a no-op.
    assert!(matches!(
        built
            .session
            .send(goal_command("c2", Command::ResumeGoal))
            .await,
        Ack::Accepted { .. }
    ));
    assert_eq!(model.requests().len(), 1);
    assert!(matches!(
        built
            .session
            .send(goal_command("c3", Command::PauseGoal))
            .await,
        Ack::Accepted { .. }
    ));
    let paused = built.session.view().await.unwrap().goal.unwrap();
    assert_eq!(
        (
            paused.status,
            paused.active_run_started_at_ms,
            paused.target
        ),
        (GoalPhase::Paused, None, active.target.clone())
    );
    let mut events = built.session.subscribe(None);
    assert!(matches!(
        built
            .session
            .send(goal_command("c4", Command::ResumeGoal))
            .await,
        Ack::Accepted { .. }
    ));
    until(&mut events, finished).await;
    let requests = model.requests();
    assert_eq!(requests.len(), 2);
    assert!(
        format!("{:?}", requests[1].messages)
            .contains("Continue working toward the active session goal.")
    );
    let done = built.session.view().await.unwrap();
    assert_eq!(done.goal.unwrap().status, GoalPhase::Verified);
    // The continuation is model-only: no second human message.
    let humans = shorten(&done.messages)
        .iter()
        .filter(|(kind, _)| kind == "human")
        .count();
    assert_eq!(humans, 1);
}

#[test]
fn a_paused_goal_is_restored_paused_and_not_evaluated() {
    let paused = [
        status(r#"{"met":false,"sentinel":true,"condition":"a"}"#),
        status(r#"{"met":false,"condition":"a","paused":true}"#),
    ];
    let goals = Goals::restore(&paused, 5);
    assert_eq!(goals.condition(), None);
    assert_eq!(
        goals.state().map(|goal| goal.status),
        Some(rust_cli_kernel_api::goal::GoalPhase::Paused)
    );
    assert!(goals.control(true).is_none());
    assert_eq!(
        goals.control(false).and_then(|status| status.paused),
        Some(false)
    );
}

/// Fork (desktop App): the title of a first `/goal` input is also the goal's summary (Node
/// `goalSummaryTargetID`); a later goal, or one without a title model, gets the objective.
#[tokio::test]
async fn a_desktop_goal_gets_its_summary_title() {
    let title_model = Arc::new(ScriptedModel::new(vec![text_response(&[
        "{\"title\":\"Green test suite\"}",
    ])]));
    let model = Arc::new(ScriptedModel::new(
        (0..2)
            .map(|index| text_response(&[&format!("reply {index}")]))
            .collect(),
    ));
    let mut setup = Setup::new(model.clone());
    setup.hooks = Evaluator::with(Vec::new());
    setup.desktop_goals = true;
    setup.titles = Some(crate::TitleModel {
        model: title_model.clone(),
        directory: None,
        node_prompt: true,
    });
    let built = setup.build().await;
    let mut events = built.session.subscribe(None);
    built
        .session
        .send(submit("c1", "/goal make the whole test suite pass"))
        .await;
    until(&mut events, |event| {
        matches!(event, KernelEvent::GoalChanged { goal: Some(goal) }
            if goal.summary_title.as_deref() == Some("Green test suite"))
    })
    .await;
    assert_eq!(title_model.requests().len(), 1);
}

#[test]
fn a_restored_goal_summarizes_its_objective() {
    let long = "x ".repeat(80);
    let goals = Goals::restore(
        &[status(&format!(
            r#"{{"met":false,"sentinel":true,"condition":"{long}"}}"#
        ))],
        0,
    );
    let summary = goals.state().unwrap().summary_title.unwrap();
    assert_eq!(summary.chars().count(), 100);
    assert!(summary.ends_with("x..."));
    assert_eq!(
        fallback_summary("  tests \n pass "),
        Some("tests pass".to_owned())
    );
}
