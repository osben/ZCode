//! Stop / SubagentStop hooks 在主循环里的效果（docs/specs/rust-cli/hooks.md §7、query.md §1）。

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::abort::Abort;
use rust_cli_kernel_api::hooks::{HookEvent, HookEventName, HookOutcome, HookRunner};
use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::orchestration::QueryStop;
use rust_cli_kernel_api::testing::{ScriptedModel, text_response};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::run::tests::{parts, request, scope};

type Events =
    Vec<Result<rust_cli_kernel_api::model::ModelEvent, rust_cli_kernel_api::model::ModelError>>;

/// 按顺序返回给定的结果，并记下收到的事件。
#[derive(Default)]
struct ScriptedHooks {
    outcomes: Mutex<VecDeque<HookOutcome>>,
    events: Mutex<Vec<HookEvent>>,
}

#[async_trait]
impl HookRunner for ScriptedHooks {
    async fn run(&self, event: HookEvent, _cancel: CancellationToken) -> HookOutcome {
        self.events.lock().unwrap().push(event);
        self.outcomes
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_default()
    }
}

fn feedback(text: &str) -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("msg_hook"),
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        origin: UserOrigin::Meta {
            source: "hook_blocking_error".to_owned(),
        },
    })
}

fn blocking(text: &str) -> HookOutcome {
    HookOutcome {
        blocking_error: Some(text.to_owned()),
        messages: vec![feedback(text)],
        ..HookOutcome::default()
    }
}

async fn run(
    responses: usize,
    outcomes: Vec<HookOutcome>,
    max_turns: Option<u32>,
) -> (QueryStop, Vec<Message>, Vec<HookEvent>, usize) {
    let model = Arc::new(ScriptedModel::new(
        (0..responses)
            .map(|index| text_response(&[&format!("reply {index}")]))
            .collect(),
    ));
    let hooks = Arc::new(ScriptedHooks {
        outcomes: Mutex::new(outcomes.into()),
        events: Mutex::default(),
    });
    let mut parts = parts(model.clone(), Vec::new());
    parts.hooks = hooks.clone();
    let mut request = request("go");
    request.max_turns = max_turns;
    let (scope, sink) = scope(parts, &request, Abort::new());
    let stop = crate::run::run(scope, request).await.unwrap();
    let events = hooks.events.lock().unwrap().clone();
    (stop, sink.messages(), events, model.requests().len())
}

#[tokio::test]
async fn the_stop_hook_sees_the_last_reply_and_lets_the_turn_end() {
    let (stop, _messages, events, requests) = run(1, Vec::new(), None).await;
    assert_eq!(stop, QueryStop::Completed);
    assert_eq!(requests, 1);
    let [event] = events.as_slice() else {
        panic!("expected one Stop event: {events:?}");
    };
    assert_eq!(event.name, HookEventName::Stop);
    assert_eq!(
        event.payload,
        json!({
            "stop_hook_active": false,
            "last_assistant_message": "reply 0",
            "background_tasks": [],
            "session_crons": [],
        })
    );
    assert!(event.context.mode.is_some());
}

#[tokio::test]
async fn a_blocking_stop_hook_continues_the_turn_with_its_feedback() {
    let (stop, messages, events, requests) = run(
        2,
        vec![blocking("Stop hook feedback:\nrun the tests")],
        None,
    )
    .await;
    assert_eq!(stop, QueryStop::Completed);
    assert_eq!(requests, 2);
    assert!(messages.contains(&feedback("Stop hook feedback:\nrun the tests")));
    // 第二次 Stop 时 stop_hook_active 为真。
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].payload["stop_hook_active"], json!(true));
}

#[tokio::test]
async fn a_prevented_turn_ends_without_another_request() {
    let prevented = HookOutcome {
        prevent_continuation: true,
        stop_reason: Some("done for today".to_owned()),
        messages: vec![feedback("done for today")],
        ..HookOutcome::default()
    };
    let (stop, messages, _events, requests) = run(2, vec![prevented], None).await;
    // 工作线 F134：以 `stop_hook_prevented` 结束（以前是 `Completed`）。
    assert_eq!(stop, QueryStop::StopHookPrevented);
    assert_eq!(requests, 1);
    assert!(messages.contains(&feedback("done for today")));
}

#[tokio::test]
async fn blocking_stops_at_max_turns_and_at_the_block_cap() {
    // maxTurns = 1：阻塞后 turnCount 变 2，超过上限。
    let (stop, messages, _events, requests) =
        run(2, vec![blocking("Stop hook feedback:\nagain")], Some(1)).await;
    assert_eq!(stop, QueryStop::MaxTurns);
    assert_eq!(requests, 1);
    assert!(messages.iter().any(|message| matches!(
        message,
        Message::Attachment(attachment) if attachment.source == "max_turns_reached"
    )));
    // 连续阻塞 9 次：第 9 次超过上限 8，按 completed 结束，不再请求。
    let outcomes = (0..9)
        .map(|_| blocking("Stop hook feedback:\nagain"))
        .collect();
    let (stop, _messages, events, requests) = run(10, outcomes, None).await;
    assert_eq!(stop, QueryStop::Completed);
    assert_eq!(requests, 9);
    assert_eq!(events.len(), 9);
}

/// Fork: Node's cap (`MAX_STOP_HOOK_CONTINUATIONS`, specs/fork-rust-agent-parity.md "Stop continuation cap").
async fn run_node(
    responses: Vec<Events>,
    outcomes: Vec<HookOutcome>,
) -> (QueryStop, Vec<Message>, Vec<HookEvent>, usize) {
    let model = Arc::new(ScriptedModel::new(responses));
    let hooks = Arc::new(ScriptedHooks {
        outcomes: Mutex::new(outcomes.into()),
        events: Mutex::default(),
    });
    let mut parts = parts(model.clone(), Vec::new());
    parts.hooks = hooks.clone();
    parts.limits.stop_continuations = crate::StopContinuations::NodeTurn;
    let request = request("go");
    let (scope, sink) = scope(parts, &request, Abort::new());
    let stop = crate::run::run(scope, request).await.unwrap();
    let events = hooks.events.lock().unwrap().clone();
    (stop, sink.messages(), events, model.requests().len())
}

fn replies(count: usize) -> Vec<Events> {
    (0..count)
        .map(|index| text_response(&[&format!("reply {index}")]))
        .collect()
}

#[tokio::test]
async fn under_node_the_turn_ends_after_three_continuations_without_the_fourth_feedback() {
    let outcomes = (1..=5)
        .map(|index| blocking(&format!("Stop hook feedback:\nstep {index}")))
        .collect();
    let (stop, messages, events, requests) = run_node(replies(6), outcomes).await;
    assert_eq!(stop, QueryStop::Completed);
    assert_eq!(requests, 4);
    assert_eq!(events.len(), 4);
    for index in 1..=3 {
        assert!(messages.contains(&feedback(&format!("Stop hook feedback:\nstep {index}"))));
    }
    // Node writes the Stop context only when it continues.
    assert!(!messages.contains(&feedback("Stop hook feedback:\nstep 4")));
}

#[tokio::test]
async fn under_node_a_tool_round_does_not_reset_the_continuation_count() {
    use rust_cli_kernel_api::testing::tool_use_response;
    let responses = vec![
        text_response(&["reply 0"]),
        text_response(&["reply 1"]),
        tool_use_response("toolu_1", "Read", &json!({"file_path": "a"})),
        text_response(&["reply 3"]),
        text_response(&["reply 4"]),
        text_response(&["reply 5"]),
    ];
    let outcomes = (1..=5)
        .map(|index| blocking(&format!("Stop hook feedback:\nstep {index}")))
        .collect();
    let (stop, messages, events, requests) = run_node(responses, outcomes).await;
    assert_eq!(stop, QueryStop::Completed);
    // Blocks after replies 0, 1 and 3; the fourth Stop run (after reply 4) ends the turn.
    assert_eq!(requests, 5);
    assert_eq!(events.len(), 4);
    assert!(!messages.contains(&feedback("Stop hook feedback:\nstep 4")));
}
