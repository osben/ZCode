//! `/goal` 的停止前检查（docs/specs/rust-cli/goal.md §4）：有目标时评估、未达成时继续、达成时结束、子代理不评估。

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::abort::Abort;
use rust_cli_kernel_api::hooks::{HookEvent, HookOutcome, HookRunner, StopCondition, StopVerdict};
use rust_cli_kernel_api::ids::{AgentId, MessageId};
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::model::{ApiRole, QuerySource};
use rust_cli_kernel_api::orchestration::{QueryRequest, QueryStop, RunSink};
use rust_cli_kernel_api::store::StoreError;
use rust_cli_kernel_api::testing::{RecordingSink, ScriptedModel, text_response};
use tokio_util::sync::CancellationToken;

use crate::RunScope;
use crate::run::tests::{parts, request};

/// 评估按顺序返回给定的判定，记下收到的条件与对话记录。
#[derive(Default)]
struct Evaluator {
    verdicts: Mutex<VecDeque<StopVerdict>>,
    asked: Mutex<Vec<StopCondition>>,
    /// The Stop hook outcomes, in order (none: the hooks let the turn end).
    outcomes: Mutex<VecDeque<HookOutcome>>,
}

#[async_trait]
impl HookRunner for Evaluator {
    async fn run(&self, _event: HookEvent, _cancel: CancellationToken) -> HookOutcome {
        self.outcomes
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_default()
    }

    async fn evaluate_stop_condition(
        &self,
        request: StopCondition,
        _cancel: CancellationToken,
    ) -> StopVerdict {
        self.asked.lock().unwrap().push(request);
        self.verdicts
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(StopVerdict::Met { reason: None })
    }
}

/// 带目标的输出端：判定未达成时把反馈当作已提交的消息返回，达成时清掉目标。
struct GoalSink {
    inner: RecordingSink,
    goal: Mutex<Option<String>>,
    reports: Mutex<Vec<(String, StopVerdict)>>,
}

impl GoalSink {
    fn new(goal: Option<&str>) -> Self {
        Self {
            inner: RecordingSink::default(),
            goal: Mutex::new(goal.map(str::to_owned)),
            reports: Mutex::default(),
        }
    }
}

/// 会话的状态是请求里的模式与工作区，加上这个目标。
#[async_trait]
impl rust_cli_kernel_api::testing::OpsOverride for GoalSink {
    async fn view(&self) -> Option<rust_cli_kernel_api::orchestration::RunView> {
        let request = request("");
        Some(rust_cli_kernel_api::orchestration::RunView {
            goal: self.goal.lock().unwrap().clone(),
            ..rust_cli_kernel_api::orchestration::RunView::new(request.mode, request.workspace)
        })
    }
}

/// 询问没有人回答（按询问的种类，`NoOneToAsk`）。
impl rust_cli_kernel_api::testing::AskOverride for GoalSink {}

/// 其余委托给记录的输出端。
#[async_trait]
impl rust_cli_kernel_api::testing::SinkOverride for GoalSink {
    fn sink(&self) -> &dyn RunSink {
        &self.inner
    }

    async fn goal_checked(
        &self,
        condition: String,
        verdict: StopVerdict,
    ) -> Result<Vec<Message>, StoreError> {
        self.reports
            .lock()
            .unwrap()
            .push((condition, verdict.clone()));
        Ok(match verdict {
            StopVerdict::NotMet { feedback, .. } => vec![feedback],
            StopVerdict::Met { .. } | StopVerdict::Impossible { .. } => {
                *self.goal.lock().unwrap() = None;
                Vec::new()
            }
            _ => Vec::new(),
        })
    }
}

fn feedback(text: &str) -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new(format!("msg_feedback_{text}")),
        content: vec![ContentBlock::Text {
            text: format!("Stop hook feedback:\n[tests pass]: {text}"),
        }],
        origin: UserOrigin::Meta {
            source: "stop_hook_feedback".to_owned(),
        },
    })
}

struct Ran {
    stop: QueryStop,
    requests: usize,
    asked: Vec<StopCondition>,
    reports: Vec<(String, StopVerdict)>,
    messages: Vec<Message>,
}

async fn run(goal: Option<&str>, verdicts: Vec<StopVerdict>, agent: Option<AgentId>) -> Ran {
    let model = Arc::new(ScriptedModel::new(
        (0..3)
            .map(|index| text_response(&[&format!("reply {index}")]))
            .collect(),
    ));
    let evaluator = Arc::new(Evaluator {
        verdicts: Mutex::new(verdicts.into()),
        ..Evaluator::default()
    });
    let mut parts = parts(model.clone(), Vec::new());
    parts.hooks = evaluator.clone();
    let request = QueryRequest {
        agent,
        ..request("go")
    };
    let sink = Arc::new(GoalSink::new(goal));
    let scope = Arc::new(RunScope::new(&request, sink.clone(), parts, Abort::new()));
    let stop = crate::run::run(scope, request).await.unwrap();
    let asked = std::mem::take(&mut *evaluator.asked.lock().unwrap());
    let reports = sink.reports.lock().unwrap().clone();
    Ran {
        stop,
        requests: model.requests().len(),
        asked,
        reports,
        messages: sink.inner.messages(),
    }
}

#[tokio::test]
async fn without_a_goal_nothing_is_evaluated() {
    let ran = run(None, Vec::new(), None).await;
    assert_eq!(ran.stop, QueryStop::Completed);
    assert_eq!(ran.requests, 1);
    assert!(ran.asked.is_empty());
}

#[tokio::test]
async fn a_goal_not_met_continues_the_turn_until_it_is_met() {
    let not_met = StopVerdict::NotMet {
        reason: Some("red".to_owned()),
        feedback: feedback("red"),
    };
    let ran = run(
        Some("tests pass"),
        vec![not_met.clone(), StopVerdict::Met { reason: None }],
        None,
    )
    .await;
    assert_eq!(ran.stop, QueryStop::Completed);
    assert_eq!(ran.requests, 2);
    assert_eq!(ran.asked.len(), 2);
    assert_eq!(ran.asked[0].condition, "tests pass");
    // 对话记录是 normalize 后的活动历史：以最后一条回复结尾。
    let first = &ran.asked[0].transcript;
    assert_eq!(first.last().map(|m| m.role), Some(ApiRole::Assistant));
    // 第二次评估看到了第一次的反馈与第二条回复；Stop 事件带 stop_hook_active。
    assert_eq!(ran.asked[1].transcript.len(), first.len() + 2);
    assert_eq!(ran.asked[1].event.payload["stop_hook_active"], true);
    assert_eq!(ran.reports.len(), 2);
    assert_eq!(ran.reports[0], ("tests pass".to_owned(), not_met));
    // 反馈由 actor 提交，主循环不再提交一次。
    assert!(!ran.messages.contains(&feedback("red")));
}

#[tokio::test]
async fn failures_and_impossible_goals_end_the_turn() {
    for verdict in [
        StopVerdict::Impossible { reason: None },
        StopVerdict::Failed {
            message: "JSON validation failed".to_owned(),
        },
        StopVerdict::TimedOut,
    ] {
        let ran = run(Some("tests pass"), vec![verdict], None).await;
        assert_eq!(ran.stop, QueryStop::Completed);
        assert_eq!(ran.requests, 1);
        assert_eq!(ran.reports.len(), 1);
    }
}

#[tokio::test]
async fn subagents_do_not_check_the_goal() {
    let ran = run(
        Some("tests pass"),
        Vec::new(),
        Some(AgentId::new("agent_1")),
    )
    .await;
    assert_eq!(ran.stop, QueryStop::Completed);
    assert!(ran.asked.is_empty());
    let _ = QuerySource::MainThread;
}

fn hook_block(text: &str) -> HookOutcome {
    HookOutcome {
        blocking_error: Some(text.to_owned()),
        messages: vec![Message::User(UserMessage {
            stall_execution: None,
            intent: None,
            id: MessageId::new(format!("msg_hook_{text}")),
            content: vec![ContentBlock::Text {
                text: text.to_owned(),
            }],
            origin: UserOrigin::Meta {
                source: "hook_blocking_error".to_owned(),
            },
        })],
        ..HookOutcome::default()
    }
}

fn has_text(messages: &[Message], wanted: &str) -> bool {
    messages.iter().any(|message| match message {
        Message::User(user) => user
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::Text { text } if text == wanted)),
        _ => false,
    })
}

/// Fork: the Node desktop rule (`StopContinuations::NodeTurn`) caps only Stop hook continuations (Node
/// `stopHookContinuationCount`, `turn-stop.ts`); a `/goal` continuation is its own input there (`goal-continuation`).
async fn run_node(goal: &str, outcomes: Vec<HookOutcome>, verdicts: Vec<StopVerdict>) -> Ran {
    let model = Arc::new(ScriptedModel::new(
        (0..12)
            .map(|index| text_response(&[&format!("reply {index}")]))
            .collect(),
    ));
    let evaluator = Arc::new(Evaluator {
        verdicts: Mutex::new(verdicts.into()),
        outcomes: Mutex::new(outcomes.into()),
        ..Evaluator::default()
    });
    let mut parts = parts(model.clone(), Vec::new());
    parts.hooks = evaluator.clone();
    parts.limits.stop_continuations = crate::StopContinuations::NodeTurn;
    let request = request("go");
    let sink = Arc::new(GoalSink::new(Some(goal)));
    let scope = Arc::new(RunScope::new(&request, sink.clone(), parts, Abort::new()));
    let stop = crate::run::run(scope, request).await.unwrap();
    let asked = std::mem::take(&mut *evaluator.asked.lock().unwrap());
    let reports = sink.reports.lock().unwrap().clone();
    Ran {
        stop,
        requests: model.requests().len(),
        asked,
        reports,
        messages: sink.inner.messages(),
    }
}

fn not_met(text: &str) -> StopVerdict {
    StopVerdict::NotMet {
        reason: None,
        feedback: feedback(text),
    }
}

/// Node checks the goal once the turn ends; an unmet goal starts a new turn whose Stop hooks count from zero.
#[tokio::test]
async fn under_node_an_unmet_goal_continues_past_the_hook_cap() {
    let mut hooks: Vec<_> = (1..=5)
        .map(|index| hook_block(&format!("step {index}")))
        .collect();
    // The new turn's hooks let it end after one more block.
    hooks.push(HookOutcome::default());
    let verdicts = vec![
        not_met("g1"),
        not_met("g2"),
        StopVerdict::Met { reason: None },
    ];
    let ran = run_node("tests pass", hooks, verdicts).await;
    assert_eq!(ran.stop, QueryStop::Completed);
    // Steps 1-3 continue; step 4 is past the cap, so the goal (g1) continues; step 5 continues the new turn; then
    // g2 continues and the met goal ends the turn.
    assert_eq!(ran.requests, 7);
    assert_eq!(ran.reports.len(), 3);
    let verdicts: Vec<_> = ran
        .reports
        .iter()
        .map(|(_, verdict)| verdict.clone())
        .collect();
    assert_eq!(
        verdicts,
        [
            not_met("g1"),
            not_met("g2"),
            StopVerdict::Met { reason: None }
        ]
    );
    for index in [1, 2, 3, 5] {
        assert!(
            has_text(&ran.messages, &format!("step {index}")),
            "step {index}"
        );
    }
    // Past the hook cap the hook feedback is not written.
    assert!(!has_text(&ran.messages, "step 4"));
}

#[tokio::test]
async fn under_node_a_goal_alone_is_not_held_to_the_hook_cap() {
    let mut verdicts: Vec<_> = (1..=5).map(|index| not_met(&format!("g{index}"))).collect();
    verdicts.push(StopVerdict::Met { reason: None });
    let ran = run_node("tests pass", Vec::new(), verdicts).await;
    assert_eq!(ran.stop, QueryStop::Completed);
    assert_eq!(ran.requests, 6);
    assert_eq!(ran.reports.len(), 6);
}

/// A goal that is never met still ends: past eight goal continuations the goal is not evaluated, so no unmet verdict
/// is written and then ended.
#[tokio::test]
async fn under_node_a_goal_never_met_ends_after_eight_continuations() {
    let verdicts = (1..=10)
        .map(|index| not_met(&format!("g{index}")))
        .collect();
    let ran = run_node("tests pass", Vec::new(), verdicts).await;
    assert_eq!(ran.stop, QueryStop::Completed);
    assert_eq!(ran.requests, 9);
    assert_eq!(ran.reports.len(), 8);
    assert_eq!(ran.asked.len(), 8);
}
