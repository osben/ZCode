//! 投影的纯函数测试：合成的内核事件 → App 的行与状态。

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{
    CommandId, EnvironmentId, InteractionId, MessageId, SessionId, ToolUseId, TraceId, TurnId,
};
use rust_cli_kernel_api::message::{
    AssistantMessage, Message, ToolResultContent, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::store::{SessionKind, SessionMeta};
use rust_cli_kernel_api::testing::selection;
use serde_json::json;

use super::*;

#[path = "background_result_tests.rs"]
mod background_result;
#[path = "background_shells_tests.rs"]
mod background_shells;
#[path = "external_agent_status_tests.rs"]
mod external_agent_status;
#[path = "external_tools_tests.rs"]
mod external_tools;
#[path = "fork_notice_tests.rs"]
mod fork_notice;
#[path = "goal_verify_tests.rs"]
mod goal_verify;
#[path = "guided_steer_tests.rs"]
mod guided_steer;
#[path = "interrupted_reply_tests.rs"]
mod interrupted_reply;
#[path = "model_change_tests.rs"]
mod model_change;
#[path = "rebuild_running_tests.rs"]
mod rebuild_running;
#[path = "streaming_tool_tests.rs"]
mod streaming_tool;
#[path = "subagent_rows_tests.rs"]
mod subagent_rows;

fn view(messages: Vec<Message>) -> SessionView {
    SessionView::new(
        SessionMeta {
            id: SessionId::new("session_1"),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            title: String::new(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
            incognito: None,
        },
        messages,
        selection(),
        PermissionMode::Default,
    )
}

fn user(id: &str, text: &str) -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new(id),
        content: vec![ContentBlock::Text { text: text.into() }],
        origin: UserOrigin::Human,
    })
}

fn assistant(id: &str, content: Vec<ContentBlock>) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content,
        model: "m".into(),
        stop_reason: None,
        usage: None,
    })
}

/// 按顺序喂事件（seq 从 1 起，revision 照会话 actor 的规则：状态变化加一）。
struct Feed {
    projection: Projection,
    seq: u64,
    revision: u64,
}

impl Feed {
    fn new() -> Self {
        Self {
            projection: Projection::from_view(
                &view(Vec::new()),
                Followup::Queue,
                vec!["high".into()],
            ),
            seq: 0,
            revision: 0,
        }
    }

    fn apply(&mut self, event: KernelEvent) -> Vec<Value> {
        self.seq += 1;
        if !matches!(
            event,
            KernelEvent::StreamDelta { .. } | KernelEvent::ContextUsage { .. }
        ) {
            self.revision += 1;
        }
        self.projection.apply(
            &SequencedEvent {
                seq: self.seq,
                event,
                revision: self.revision,
            },
            2000 + self.seq,
        )
    }
}

fn ops(deltas: &[Value]) -> Vec<String> {
    deltas
        .iter()
        .map(|delta| match delta["op"].as_str().unwrap() {
            "state.updated" => {
                let mut keys: Vec<&str> = delta["patch"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect();
                keys.sort_unstable();
                format!("state({})", keys.join(","))
            }
            op if delta.get("row").is_some() => {
                format!("{op}({})", delta["row"]["kind"].as_str().unwrap())
            }
            op => op.to_owned(),
        })
        .collect()
}

#[test]
fn a_text_turn_becomes_rows_and_control_states() {
    let mut feed = Feed::new();
    let started = feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("c1")),
    });
    assert_eq!(
        ops(&started),
        [
            "row.appended(turnHeader)",
            "state(availability,control,inputRouting,revision)"
        ]
    );
    let patch = &started[1]["patch"];
    assert_eq!(patch["control"]["phase"], "running");
    assert_eq!(patch["control"]["canStop"], true);
    assert_eq!(
        patch["control"]["activeWorks"][0]["foregroundExecutionId"],
        "runtime_command_1"
    );
    assert_eq!(patch["inputRouting"]["mode"], "enqueue");
    let input = feed.apply(KernelEvent::MessageDone {
        message: user("msg_u1", "hello"),
    });
    assert_eq!(input[0]["row"]["text"], "hello");
    assert_eq!(input[0]["row"]["sourceCommandId"], "c1");
    let delta = |text: &str| KernelEvent::StreamDelta {
        turn: TurnId::new("turn_1"),
        response: 0,
        index: 0,
        delta: BlockDelta::Text(text.into()),
    };
    assert_eq!(
        ops(&feed.apply(delta("hi "))),
        ["row.appended(assistantText)", "row.delta"]
    );
    assert_eq!(ops(&feed.apply(delta("there"))), ["row.delta"]);
    let done = feed.apply(KernelEvent::MessageDone {
        message: assistant(
            "msg_a1",
            vec![ContentBlock::Text {
                text: "hi there".into(),
            }],
        ),
    });
    assert_eq!(done[0]["row"]["state"], "complete");
    assert_eq!(done[0]["row"]["text"], "hi there");
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: Some(Usage {
            input_tokens: 10,
            output_tokens: 3,
            ..Usage::default()
        }),
    });
    assert_eq!(
        ops(&finished),
        [
            "row.upserted(turnHeader)",
            "row.upserted(assistantText)",
            "state(availability,control,inputRouting,revision,usage)"
        ]
    );
    assert_eq!(finished[0]["row"]["state"], "completedSuccess");
    // Fork: the finished reply offers retry and fork (Node `materializeCommandRowActions`).
    assert_eq!(
        finished[1]["row"]["actions"],
        json!({"canRetry": true, "canFork": true})
    );
    assert_eq!(finished[2]["patch"]["control"]["phase"], "completedSuccess");
    assert_eq!(
        finished[2]["patch"]["usage"]["cumulative"]["outputTokens"],
        3
    );
    let snapshot = feed.projection.snapshot(9, "epoch-1");
    let kinds: Vec<&str> = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["turnHeader", "userInput", "assistantText"]);
    assert_eq!(snapshot["rows"]["firstRowId"], 1);
    assert_eq!(snapshot["seq"], 9);
    assert_eq!(snapshot["revision"], feed.revision);
    assert_eq!(snapshot["config"]["followupMode"], "queue");
    assert_eq!(feed.projection.last_reply().as_deref(), Some("hi there"));
}

#[test]
fn a_permission_ask_marks_the_tool_and_lists_the_interaction() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let tool = ToolUseId::new("toolu_1");
    feed.apply(KernelEvent::MessageDone {
        message: assistant(
            "msg_a1",
            vec![ContentBlock::ToolUse {
                id: tool.clone(),
                name: "Write".into(),
                input: json!({"file_path": "/w/a.txt"}),
            }],
        ),
    });
    let asked = feed.apply(KernelEvent::InteractionAsked {
        interaction: InteractionId::new("int_1"),
        request: InteractionRequest::Permission {
            origin: None,
            tool_use: tool.clone(),
            tool: "Write".into(),
            input: json!({"file_path": "/w/a.txt"}),
            message: "Write a.txt?".into(),
            suggestions: Vec::new(),
            rule_seed: None,
            asked_by: None,
            machine: Default::default(),
            once: false,
            independent: false,
        },
    });
    assert_eq!(asked[0]["row"]["status"], "pendingApproval");
    assert_eq!(asked[0]["row"]["approvalInteractionId"], "int_1");
    let pending = &asked[1]["patch"]["pendingInteractions"][0];
    assert_eq!(pending["interactionId"], "int_1");
    assert_eq!(pending["anchorRowId"], asked[0]["row"]["rowId"]);
    assert_eq!(pending["payload"]["toolCallId"], "toolu_1");
    assert_eq!(
        pending["payload"]["fullAccessOption"]["optionId"],
        "fullAccess"
    );
    assert_eq!(pending["payload"]["options"].as_array().unwrap().len(), 3);
    // B3: the session's own ask offers guarded or full access (Node `modeSwitch: "choose"`).
    assert_eq!(pending["payload"]["modeSwitch"], "choose");
    assert_eq!(feed.projection.pending_permissions(), 1);
    let resolved = feed.apply(KernelEvent::InteractionResolved {
        interaction: InteractionId::new("int_1"),
    });
    assert_eq!(resolved[0]["row"]["status"], "running");
    assert_eq!(resolved[1]["patch"]["pendingInteractions"], json!([]));
    let done = feed.apply(KernelEvent::ToolDone {
        tool_use: tool,
        output: rust_cli_kernel_api::tool::ToolOutput {
            content: vec![ToolResultContent::Text { text: "ok".into() }],
            is_error: false,
            display: Value::Null,
        },
    });
    assert_eq!(done[0]["row"]["status"], "success");
    assert_eq!(done[0]["row"]["output"]["text"], "ok");
}

/// A guarded dangerous command asks once (Node `approvalMode: "user-once"`): only allow once and
/// deny, no full access option.
#[test]
fn a_single_use_ask_offers_no_always_allow_and_no_full_access() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let tool = ToolUseId::new("toolu_1");
    feed.apply(KernelEvent::MessageDone {
        message: assistant(
            "msg_a1",
            vec![ContentBlock::ToolUse {
                id: tool.clone(),
                name: "Bash".into(),
                input: json!({"command": "rm -rf target"}),
            }],
        ),
    });
    let asked = feed.apply(KernelEvent::InteractionAsked {
        interaction: InteractionId::new("int_1"),
        request: InteractionRequest::Permission {
            origin: None,
            tool_use: tool,
            tool: "Bash".into(),
            input: json!({"command": "rm -rf target"}),
            message: "Dangerous command requires your approval for this execution".into(),
            suggestions: Vec::new(),
            rule_seed: None,
            asked_by: None,
            machine: Default::default(),
            once: true,
            independent: false,
        },
    });
    let payload = &asked[1]["patch"]["pendingInteractions"][0]["payload"];
    let kinds: Vec<&str> = payload["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|option| option["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["allowOnce", "deny"]);
    assert!(payload.get("fullAccessOption").is_none());
    // B3: guarded already, the ask can only switch to full access (Node `modeSwitch: "fullAccessOnly"`).
    assert_eq!(payload["modeSwitch"], "fullAccessOnly");
}

/// B3 (Node `product-projection.ts`, `!payload.origin && !payload.optionsPolicy`): a subagent's ask and an independent
/// confirmation (Plan mode's MCP ask) offer no permission mode switch: no `modeSwitch` and no `fullAccessOption`.
#[test]
fn a_subagent_ask_and_an_independent_ask_offer_no_mode_switch() {
    use rust_cli_kernel_api::ids::AgentId;
    use rust_cli_kernel_api::orchestration::AskOrigin;
    let origin = AskOrigin {
        agent: AgentId::new("agent_1"),
        agent_type: "general-purpose".into(),
        child_session: SessionId::new("sess_child"),
        parent_session: SessionId::new("sess_parent"),
        description: "child".into(),
        parent_tool_use: None,
    };
    for (origin, once, independent) in [(Some(origin), false, false), (None, false, true)] {
        let mut feed = Feed::new();
        feed.apply(KernelEvent::TurnStarted {
            turn: TurnId::new("turn_1"),
            command: None,
        });
        let asked = feed.apply(KernelEvent::InteractionAsked {
            interaction: InteractionId::new("int_1"),
            request: InteractionRequest::Permission {
                origin: origin.map(Box::new),
                tool_use: ToolUseId::new("toolu_1"),
                tool: "mcp__srv__write".into(),
                input: json!({}),
                message: "ask".into(),
                suggestions: Vec::new(),
                rule_seed: None,
                asked_by: None,
                machine: Default::default(),
                once,
                independent,
            },
        });
        let payload = asked
            .iter()
            .find_map(|delta| delta["patch"]["pendingInteractions"].get(0))
            .map(|pending| &pending["payload"])
            .unwrap();
        assert!(payload.get("modeSwitch").is_none(), "{payload}");
        assert!(payload.get("fullAccessOption").is_none(), "{payload}");
    }
}

/// Plan mode's MCP ask is independent but not `once` (its PermissionRequest hooks run); it still offers allow once and
/// deny only (Node `optionsPolicy: "no-always-allow"`).
#[test]
fn an_independent_ask_offers_allow_once_and_deny_only() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let asked = feed.apply(KernelEvent::InteractionAsked {
        interaction: InteractionId::new("int_1"),
        request: InteractionRequest::Permission {
            origin: None,
            tool_use: ToolUseId::new("toolu_1"),
            tool: "mcp__srv__write".into(),
            input: json!({}),
            message: "ask".into(),
            suggestions: Vec::new(),
            rule_seed: None,
            asked_by: None,
            machine: Default::default(),
            once: false,
            independent: true,
        },
    });
    let payload = asked
        .iter()
        .find_map(|delta| delta["patch"]["pendingInteractions"].get(0))
        .map(|pending| &pending["payload"])
        .unwrap();
    assert_eq!(
        payload["options"],
        crate::projection::state::single_use_permission_options()
    );
    assert!(payload.get("modeSwitch").is_none(), "{payload}");
}

#[test]
fn an_interrupted_turn_cancels_running_tools() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    feed.apply(KernelEvent::ToolStarted {
        tool_use: ToolUseId::new("toolu_1"),
        name: "Bash".into(),
        input: json!({"command": "sleep 60"}),
    });
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Interrupted,
        usage: None,
    });
    let rows: Vec<(&str, &str)> = finished
        .iter()
        .filter_map(|delta| {
            let row = delta.get("row")?;
            Some((
                row["kind"].as_str()?,
                row["status"].as_str().or(row["state"].as_str())?,
            ))
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("toolCall", "cancelled"),
            ("turnHeader", "completedInterrupted")
        ]
    );
    assert_eq!(feed.projection.phase(), Phase::CompletedInterrupted);
}

#[test]
fn a_cold_view_rebuilds_the_rows_of_finished_turns() {
    let projection = Projection::from_view(
        &view(vec![
            user("msg_u1", "first"),
            assistant("msg_a1", vec![ContentBlock::Text { text: "one".into() }]),
            user("msg_u2", "second"),
            assistant("msg_a2", vec![ContentBlock::Text { text: "two".into() }]),
        ]),
        Followup::Guide,
        Vec::new(),
    );
    let snapshot = projection.snapshot(0, "epoch");
    let rows: Vec<String> = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            format!(
                "{}:{}",
                row["kind"].as_str().unwrap(),
                row["text"].as_str().or(row["state"].as_str()).unwrap_or("")
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            "turnHeader:completedSuccess",
            "userInput:first",
            "assistantText:one",
            "turnHeader:completedSuccess",
            "userInput:second",
            "assistantText:two",
        ]
    );
    assert_eq!(snapshot["control"]["phase"], "completedSuccess");
    assert_eq!(snapshot["inputRouting"]["mode"], "startNow");
    assert_eq!(snapshot["config"]["followupMode"], "guide");
}

/// Fork: after an agent restart a cold turn keeps the command that submitted it, so the App settles that command.
#[test]
fn a_cold_turn_carries_its_stored_submitting_command() {
    let mut cold = view(vec![
        user("msg_u1", "first"),
        assistant("msg_a1", vec![ContentBlock::Text { text: "one".into() }]),
        user("msg_u2", "second"),
    ]);
    cold.commands
        .insert(MessageId::new("msg_u1"), CommandId::new("cmd_1"));
    let snapshot = Projection::from_view(&cold, Followup::Guide, Vec::new()).snapshot(0, "epoch");
    let commands: Vec<String> = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] != "assistantText")
        .map(|row| {
            format!(
                "{}:{}",
                row["kind"].as_str().unwrap(),
                row["sourceCommandId"].as_str().unwrap_or("-")
            )
        })
        .collect();
    assert_eq!(
        commands,
        [
            "turnHeader:cmd_1",
            "userInput:cmd_1",
            "turnHeader:-",
            "userInput:-",
        ]
    );
}

/// revision 只在事件带来的值变了时才进 patch；流式增量不带 patch。
#[test]
fn the_revision_comes_from_the_events_only() {
    let mut projection = Projection::from_view(&view(Vec::new()), Followup::Queue, Vec::new());
    let event = |seq, revision, event| SequencedEvent {
        seq,
        event,
        revision,
    };
    let deltas = projection.apply(
        &event(
            1,
            4,
            KernelEvent::TitleChanged {
                title: "t".into(),
                source: Default::default(),
            },
        ),
        0,
    );
    assert_eq!(deltas[0]["patch"]["revision"], 4);
    assert_eq!(deltas[0]["patch"]["meta"]["title"], "t");
    let deltas = projection.apply(
        &event(
            2,
            4,
            KernelEvent::ContextUsage {
                used_tokens: 5,
                max_tokens: 10,
                compact_at: Some(8),
                window_tokens: Some(12),
            },
        ),
        0,
    );
    assert!(deltas[0]["patch"].get("revision").is_none());
    // 内核生效的自动压缩阈值进 V4 的 `autoCompactThresholdTokens`（compact.md §2.3；以前恒为 null）。
    assert_eq!(
        deltas[0]["patch"]["usage"]["contextWindow"]["autoCompactThresholdTokens"],
        8
    );
    // Fork: `maxTokens` is the model window (Node), not the window minus the summary reserve.
    assert_eq!(
        deltas[0]["patch"]["usage"]["contextWindow"]["maxTokens"],
        12
    );
    // Fork: an unknown model publishes no context window (Node), not the 200,000 fallback.
    let deltas = projection.apply(
        &event(
            3,
            4,
            KernelEvent::ContextUsage {
                used_tokens: 5,
                max_tokens: 10,
                compact_at: Some(8),
                window_tokens: None,
            },
        ),
        0,
    );
    assert!(deltas[0]["patch"]["usage"]["contextWindow"].is_null());
    assert_eq!(projection.revision(), 4);
    let changed = projection.set_followup(Followup::Guide);
    assert_eq!(changed["patch"]["config"]["followupMode"], "guide");
}

/// 对拍找到的三处（与 Node 相同）：拒绝了的工具调用投成 cancelled；中断后补的那条消息不出行；空闲时提交的输入不投成排队项。
#[test]
fn denied_tools_interrupt_markers_and_immediate_inputs_follow_node() {
    let mut feed = Feed::new();
    feed.projection.remember_input(
        "c1",
        InputMeta {
            client: "k".into(),
            origin: None,
            text: "hi".into(),
            admitted_at: 0,
            requested: "startNow",
            admitted: "startNow",
            attachments: Vec::new(),
            automation: None,
        },
    );
    let queued = feed.apply(KernelEvent::QueueChanged {
        items: vec![QueuedInput {
            edit_lock: None,
            intent: None,
            command: CommandId::new("c1"),
            text: "hi".into(),
            delivery: rust_cli_kernel_api::session_api::Delivery::Queue,
            kind: Default::default(),
            execution: None,
        }],
    });
    assert!(
        queued
            .iter()
            .all(|delta| delta["patch"].get("queue").is_none())
    );
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("c1")),
    });
    feed.apply(KernelEvent::ToolStarted {
        tool_use: ToolUseId::new("toolu_1"),
        name: "Bash".into(),
        input: json!({"command": "rm -rf x"}),
    });
    feed.projection.deny("toolu_1");
    let done = feed.apply(KernelEvent::ToolDone {
        tool_use: ToolUseId::new("toolu_1"),
        output: rust_cli_kernel_api::tool::ToolOutput {
            content: vec![ToolResultContent::Text {
                text: "denied".into(),
            }],
            is_error: true,
            display: Value::Null,
        },
    });
    assert_eq!(done[0]["row"]["status"], "cancelled");
    let marker = feed.apply(KernelEvent::MessageDone {
        message: user("msg_i", rust_cli_kernel_api::user_input::INTERRUPT_TEXTS[0]),
    });
    assert!(marker.iter().all(|delta| delta.get("row").is_none()));
}

/// Fork: the remembered admission follows the kernel's (`Projection::readmit`): an input remembered as `startNow` that
/// the kernel queued (its `SubmitWith` answered `Queued`) is a queue item after all, shown with `admitted: "queue"`,
/// whether the kernel's `QueueChanged` arrived before the correction or after it; an input remembered as `queue` that
/// the kernel started is never a queue item.
#[test]
fn the_remembered_admission_follows_the_kernel() {
    let meta = |admitted: &'static str| InputMeta {
        client: "k".into(),
        origin: None,
        text: "hi".into(),
        admitted_at: 0,
        requested: "startNow",
        admitted,
        attachments: Vec::new(),
        automation: None,
    };
    let queued = || KernelEvent::QueueChanged {
        items: vec![QueuedInput {
            edit_lock: None,
            intent: None,
            command: CommandId::new("c1"),
            text: "hi".into(),
            delivery: rust_cli_kernel_api::session_api::Delivery::Queue,
            kind: Default::default(),
            execution: None,
        }],
    };
    // The event first: the item is hidden, and the correction publishes it.
    let mut feed = Feed::new();
    feed.projection.remember_input("c1", meta("startNow"));
    feed.apply(queued());
    let delta = feed
        .projection
        .readmit("c1", "queue")
        .expect("the correction publishes the queue");
    assert_eq!(
        delta["patch"]["queue"]["items"][0]["delivery"]["admitted"],
        "queue"
    );
    // The correction first: the event shows the item.
    let mut feed = Feed::new();
    feed.projection.remember_input("c1", meta("startNow"));
    assert!(feed.projection.readmit("c1", "queue").is_none());
    let deltas = feed.apply(queued());
    assert!(
        deltas
            .iter()
            .any(|delta| delta["patch"]["queue"]["items"][0]["delivery"]["admitted"] == "queue")
    );
    // Predicted `queue`, started by the kernel: no queue item appears, and the empty queue is not republished.
    let mut feed = Feed::new();
    feed.projection.remember_input("c1", meta("queue"));
    assert!(feed.projection.readmit("c1", "startNow").is_none());
    let deltas = feed.apply(KernelEvent::QueueChanged { items: Vec::new() });
    assert!(
        deltas
            .iter()
            .all(|delta| delta["patch"].get("queue").is_none())
    );
}

/// Fork: a cold `userInput` row shows the stored attachments as chips (after a restart too), and `attachmentRead`
/// authorizes their refs; the bubble is only the typed text.
#[test]
fn cold_rows_carry_the_chips_of_stored_attachments() {
    use rust_cli_kernel_api::message::{AttachedBody, AttachedFile};

    let message = Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("msg_u1"),
        content: vec![
            ContentBlock::Text { text: "see".into() },
            ContentBlock::File {
                file: AttachedFile {
                    name: "p.png".into(),
                    mime: "image/png".into(),
                    bytes: 4,
                    reference: Some("zcode-artifact://session_1/a".into()),
                    preview_reference: Some("zcode-artifact://session_1/b".into()),
                    stored: None,
                    material: None,
                    image: None,
                    unnamed: false,
                    body: AttachedBody::Omitted,
                },
            },
        ],
        origin: UserOrigin::Human,
    });
    let projection = Projection::from_view(
        &view(vec![
            message,
            assistant("msg_a1", vec![ContentBlock::Text { text: "ok".into() }]),
        ]),
        Followup::Guide,
        Vec::new(),
    );
    let snapshot = projection.snapshot(0, "epoch");
    let row = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "userInput")
        .unwrap()
        .clone();
    assert_eq!(row["text"], "see");
    assert_eq!(
        row["attachments"],
        json!([{"fileName": "p.png", "mime": "image/png", "bytes": 4,
            "ref": "zcode-artifact://session_1/a", "previewRef": "zcode-artifact://session_1/b"}])
    );
    assert_eq!(
        projection.attachment_mime("zcode-artifact://session_1/b"),
        Some(("image/png".into(), false))
    );
    assert_eq!(
        projection.attachment_mime("zcode-artifact://session_1/c"),
        None
    );
}

/// Fork: Share reads (`v4/conversation/attachmentRead` / `attachmentStat`) are authorised by the row, the index and the
/// ref, and open the stored part's artifact before the App's local path (Node `resolvePromptAttachment`).
#[test]
fn share_reads_resolve_a_row_attachment_to_its_stored_source() {
    use rust_cli_kernel_api::message::{AttachedBody, AttachedFile, ImageSource};

    let file = |name: &str, reference: &str, stored: Option<&str>, body: AttachedBody| {
        ContentBlock::File {
            file: AttachedFile {
                name: name.into(),
                mime: "text/markdown".into(),
                bytes: 4,
                reference: Some(reference.into()),
                preview_reference: None,
                stored: stored.map(Box::from),
                material: None,
                image: None,
                unnamed: false,
                body,
            },
        }
    };
    let message = Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("msg_u1"),
        content: vec![
            ContentBlock::Text { text: "see".into() },
            file(
                "p.png",
                "/tmp/p.png",
                Some("zcode-artifact://session_1/img"),
                AttachedBody::Image {
                    source: ImageSource::Base64 {
                        media_type: "image/png".into(),
                        data: "iVBORw==".into(),
                    },
                },
            ),
            file(
                "n.md",
                "/tmp/n.md",
                None,
                AttachedBody::Text {
                    text: "hi".into(),
                    read: None,
                },
            ),
        ],
        origin: UserOrigin::Human,
    });
    let projection = Projection::from_view(
        &view(vec![
            message,
            assistant("msg_a1", vec![ContentBlock::Text { text: "ok".into() }]),
        ]),
        Followup::Guide,
        Vec::new(),
    );
    let snapshot = projection.snapshot(0, "epoch");
    let row = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "userInput")
        .unwrap()
        .clone();
    let row_id = row["rowId"].as_u64().unwrap();
    assert_eq!(
        projection.row_attachment(row_id, "msg_u1", 0, "/tmp/p.png"),
        Some(AttachmentSource {
            mime: "image/png".into(),
            source: Some("zcode-artifact://session_1/img".into()),
        })
    );
    assert_eq!(
        projection.row_attachment(row_id, "msg_u1", 1, "/tmp/n.md"),
        Some(AttachmentSource {
            mime: "text/plain".into(),
            source: Some("/tmp/n.md".into()),
        })
    );
    // Another index, another row or a ref the row does not carry is refused.
    assert_eq!(
        projection.row_attachment(row_id, "msg_u1", 1, "/tmp/p.png"),
        None
    );
    assert_eq!(
        projection.row_attachment(row_id, "msg_a1", 0, "/tmp/p.png"),
        None
    );
    assert_eq!(
        projection.row_attachment(row_id + 1, "msg_u1", 0, "/tmp/p.png"),
        None
    );
    // `v4/attachment/read` with a row target: the chip's MIME authorises it, the stored part is what it reads.
    let chip_mime = row["attachments"][0]["mime"].as_str().unwrap().to_owned();
    assert_eq!(
        projection.row_chip_mime(row_id, "msg_u1", 0, "/tmp/p.png"),
        Some((chip_mime, false))
    );
    assert_eq!(
        projection.row_chip_mime(row_id, "msg_u1", 1, "/tmp/p.png"),
        None
    );
    assert_eq!(
        projection.row_chip_mime(row_id, "msg_a1", 0, "/tmp/p.png"),
        None
    );
    // Without a row target the ref alone finds its chip (Node's previewSource).
    assert_eq!(
        projection
            .attachment_source("/tmp/n.md")
            .and_then(|source| source.source),
        Some("/tmp/n.md".into())
    );
    assert_eq!(projection.attachment_source("/tmp/other.png"), None);
}

/// Fork: one finished turn `n` (typed input `msg_u<n>`, reply `msg_a<n>`).
fn finished_turn(feed: &mut Feed, n: u32) {
    let turn = TurnId::new(format!("turn_{n}"));
    feed.apply(KernelEvent::TurnStarted {
        turn: turn.clone(),
        command: Some(CommandId::new(format!("c{n}"))),
    });
    feed.apply(KernelEvent::MessageDone {
        message: user(&format!("msg_u{n}"), "question"),
    });
    feed.apply(KernelEvent::MessageDone {
        message: assistant(
            &format!("msg_a{n}"),
            vec![ContentBlock::Text {
                text: "answer".into(),
            }],
        ),
    });
    feed.apply(KernelEvent::TurnFinished {
        turn,
        outcome: TurnOutcome::Success,
        usage: None,
    });
}

fn row_of<'a>(
    projection: &'a Projection,
    kind: &str,
    entity_prefix: &str,
) -> &'a Map<String, Value> {
    projection
        .rows
        .iter()
        .find(|row| {
            row["kind"] == kind
                && row["entityId"]
                    .as_str()
                    .is_some_and(|entity| entity.starts_with(entity_prefix))
        })
        .unwrap()
}

#[test]
fn row_actions_follow_the_latest_turn_like_node() {
    let mut feed = Feed::new();
    finished_turn(&mut feed, 1);
    finished_turn(&mut feed, 2);
    let projection = &feed.projection;
    let (user_1, user_2) = (
        row_of(projection, "userInput", "msg_u1"),
        row_of(projection, "userInput", "msg_u2"),
    );
    let (reply_1, reply_2) = (
        row_of(projection, "assistantText", "msg_a1"),
        row_of(projection, "assistantText", "msg_a2"),
    );
    assert!(user_1.get("actions").is_none());
    assert_eq!(
        user_2["actions"],
        json!({"canEdit": true, "editDisposition": "rewind"})
    );
    assert_eq!(reply_1["actions"], json!({"canFork": true}));
    assert_eq!(
        reply_2["actions"],
        json!({"canRetry": true, "canFork": true})
    );
    let id = |row: &Map<String, Value>| row["rowId"].as_u64().unwrap();
    let entity = |row: &Map<String, Value>| row["entityId"].as_str().unwrap().to_owned();
    assert_eq!(
        projection.row_target(id(user_2), &entity(user_2), RowAction::Edit),
        Ok(RowTarget {
            user_message: "msg_u2".into(),
            assistant_message: None,
        })
    );
    assert_eq!(
        projection.row_target(id(user_1), &entity(user_1), RowAction::Edit),
        Err(TargetMiss::Unavailable)
    );
    assert_eq!(
        projection.row_target(id(reply_1), &entity(reply_1), RowAction::Retry),
        Err(TargetMiss::Unavailable)
    );
    assert_eq!(
        projection.row_target(id(reply_1), &entity(reply_1), RowAction::Fork),
        Ok(RowTarget {
            user_message: "msg_u1".into(),
            assistant_message: Some("msg_a1".into()),
        })
    );
    // A stale entity id for the same row, or a row the projection no longer holds, is stale.
    assert_eq!(
        projection.row_target(id(reply_2), "other", RowAction::Retry),
        Err(TargetMiss::Stale)
    );
    assert_eq!(
        projection.row_target(u64::MAX, &entity(reply_2), RowAction::Retry),
        Err(TargetMiss::Stale)
    );
}

#[test]
fn row_actions_are_withheld_while_running_or_compacting() {
    let mut feed = Feed::new();
    finished_turn(&mut feed, 1);
    let started = feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_2"),
        command: None,
    });
    // Retry needs an idle session; fork and edit stay.
    let reply = started
        .iter()
        .find(|delta| delta["op"] == "row.upserted" && delta["row"]["kind"] == "assistantText")
        .unwrap();
    assert_eq!(reply["row"]["actions"], json!({"canFork": true}));
    feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_2"),
        outcome: TurnOutcome::Interrupted,
        usage: None,
    });
    feed.apply(KernelEvent::CompactStarted {
        trigger: rust_cli_kernel_api::message::CompactTrigger::Manual,
    });
    let projection = &feed.projection;
    assert!(
        row_of(projection, "userInput", "msg_u1")
            .get("actions")
            .is_none()
    );
    assert!(
        row_of(projection, "assistantText", "msg_a1")
            .get("actions")
            .is_none()
    );
}

#[test]
fn a_cold_projection_carries_row_actions() {
    let projection = Projection::from_view(
        &view(vec![
            user("msg_u1", "question"),
            assistant(
                "msg_a1",
                vec![ContentBlock::Text {
                    text: "answer".into(),
                }],
            ),
        ]),
        Followup::Queue,
        Vec::new(),
    );
    assert_eq!(
        row_of(&projection, "userInput", "msg_u1")["actions"],
        json!({"canEdit": true, "editDisposition": "rewind"})
    );
    assert_eq!(
        row_of(&projection, "assistantText", "msg_a1")["actions"],
        json!({"canRetry": true, "canFork": true})
    );
}

/// Fork: one compact marker row per compaction, running then success (Node `onCompactLifecycle`).
#[test]
fn a_compaction_is_one_marker_row_from_running_to_success() {
    use rust_cli_kernel_api::message::CompactTrigger;
    let mut feed = Feed::new();
    finished_turn(&mut feed, 1);
    let started = feed.apply(KernelEvent::CompactStarted {
        trigger: CompactTrigger::Manual,
    });
    let appended = started
        .iter()
        .find(|delta| delta["op"] == "row.appended")
        .unwrap();
    assert_eq!(appended["row"]["kind"], "timelineMarker");
    assert_eq!(appended["row"]["lane"], "assistantWork");
    assert_eq!(appended["row"]["turnId"], "turn_1");
    assert_eq!(
        appended["row"]["marker"],
        json!({"type": "compact", "origin": "manual", "status": "running"})
    );
    let done = feed.apply(KernelEvent::CompactDone {
        boundary: MessageId::new("msg_b"),
    });
    let upserted = done
        .iter()
        .find(|delta| delta["op"] == "row.upserted" && delta["row"]["kind"] == "timelineMarker")
        .unwrap();
    assert_eq!(upserted["row"]["rowId"], appended["row"]["rowId"]);
    assert_eq!(upserted["row"]["marker"]["status"], "success");
    let failed = feed.apply(KernelEvent::CompactFailed {
        trigger: CompactTrigger::Auto,
        message: "no".into(),
    });
    assert!(
        failed
            .iter()
            .all(|delta| delta["op"] != "row.upserted" || delta["row"]["kind"] != "timelineMarker")
    );
}

/// Fork: a compaction still running when its turn is stopped settles as `cancelled` and its work ends, like Node's
/// interrupted compaction; before, the marker stayed `Compressing context` and the row actions stayed withheld.
#[test]
fn a_compaction_stopped_with_its_turn_is_cancelled() {
    use rust_cli_kernel_api::message::CompactTrigger;
    let mut feed = Feed::new();
    finished_turn(&mut feed, 1);
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_2"),
        command: None,
    });
    let started = feed.apply(KernelEvent::CompactStarted {
        trigger: CompactTrigger::Auto,
    });
    let row = started
        .iter()
        .find(|delta| delta["op"] == "row.appended")
        .unwrap()["row"]["rowId"]
        .clone();
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_2"),
        outcome: TurnOutcome::Interrupted,
        usage: None,
    });
    let settled = finished
        .iter()
        .find(|delta| delta["op"] == "row.upserted" && delta["row"]["rowId"] == row)
        .unwrap();
    assert_eq!(settled["row"]["marker"]["status"], "cancelled");
    assert!(
        finished
            .iter()
            .any(|delta| delta["patch"]["availability"]["compact"]["allowed"] == true),
        "{finished:?}"
    );
}

/// Fork: a skipped compaction (too little history on the desktop) is one settled `noop` row (Node `skipped`).
#[test]
fn a_skipped_compaction_is_a_noop_row() {
    use rust_cli_kernel_api::message::CompactTrigger;
    let mut feed = Feed::new();
    finished_turn(&mut feed, 1);
    let skipped = feed.apply(KernelEvent::CompactSkipped {
        trigger: CompactTrigger::Auto,
    });
    let appended = skipped
        .iter()
        .find(|delta| delta["op"] == "row.appended")
        .unwrap();
    assert_eq!(
        appended["row"]["marker"],
        json!({"type": "compact", "origin": "auto", "status": "noop"})
    );
}

/// Fork: a skipped `/compact` settles its announced marker as `noop` (one row); its turn then completes without
/// changing it, and the row actions come back.
#[test]
fn a_skipped_manual_compaction_settles_its_marker_as_noop() {
    use rust_cli_kernel_api::message::CompactTrigger;
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("cmd_compact")),
    });
    feed.apply(KernelEvent::CompactStarted {
        trigger: CompactTrigger::Manual,
    });
    let skipped = feed.apply(KernelEvent::CompactSkipped {
        trigger: CompactTrigger::Manual,
    });
    assert!(!skipped.iter().any(|delta| delta["op"] == "row.appended"));
    let availability = skipped
        .iter()
        .find_map(|delta| delta["patch"].get("availability"))
        .unwrap();
    assert_eq!(availability["compact"]["allowed"], true);
    feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    let markers: Vec<_> = feed
        .projection
        .rows
        .iter()
        .filter(|row| row["kind"] == "timelineMarker")
        .collect();
    assert_eq!(markers.len(), 1);
    assert_eq!(markers[0]["marker"]["status"], "noop");
}

#[test]
fn a_cold_projection_shows_stored_compactions() {
    use rust_cli_kernel_api::message::{CompactBoundary, CompactTrigger, SystemMessage};
    let projection = Projection::from_view(
        &view(vec![
            user("msg_u1", "question"),
            Message::System(SystemMessage::CompactBoundary(CompactBoundary {
                id: MessageId::new("msg_b"),
                trigger: CompactTrigger::Manual,
                pre_tokens: 1200,
                summary: MessageId::new("msg_s"),
                preserved: None,
                discovered_tools: Vec::new(),
            })),
        ]),
        Followup::Queue,
        Vec::new(),
    );
    assert_eq!(
        row_of(&projection, "timelineMarker", "compact_")["marker"],
        json!({"type": "compact", "origin": "manual", "status": "success", "tokensBefore": 1200})
    );
}

#[test]
fn the_queue_pause_reason_follows_who_paused_it() {
    let mut feed = Feed::new();
    assert!(feed.projection.queue_state().get("pauseReason").is_none());
    let manual = feed.projection.set_auto_drain(false);
    assert_eq!(manual["patch"]["queue"]["autoDrain"], false);
    assert_eq!(manual["patch"]["queue"]["pauseReason"], "manual");
    let stopped = feed.projection.hold_for_stop();
    assert_eq!(stopped["patch"]["queue"]["pauseReason"], "stopped");
    let resumed = feed.projection.set_auto_drain(true);
    assert_eq!(resumed["patch"]["queue"]["autoDrain"], true);
    assert!(resumed["patch"]["queue"].get("pauseReason").is_none());
    assert!(!feed.projection.has_queue());
}

/// Node's `computeInputRouting`: a finished turn with a paused, non-empty queue asks the client to choose.
#[test]
fn a_held_queue_after_a_finished_turn_routes_input_to_a_choice() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    feed.projection.remember_input(
        "c2",
        InputMeta {
            client: "k".into(),
            origin: None,
            text: "later".into(),
            admitted_at: 0,
            requested: "queue",
            admitted: "queue",
            attachments: Vec::new(),
            automation: None,
        },
    );
    let queued = feed.apply(KernelEvent::QueueChanged {
        items: vec![QueuedInput {
            edit_lock: None,
            intent: None,
            command: CommandId::new("c2"),
            text: "later".into(),
            delivery: rust_cli_kernel_api::session_api::Delivery::Queue,
            kind: Default::default(),
            execution: None,
        }],
    });
    let routing = queued
        .iter()
        .find_map(|delta| delta["patch"].get("inputRouting"))
        .unwrap();
    assert_eq!(routing["mode"], "enqueue");
    let stopped = feed.projection.hold_for_stop();
    assert_eq!(stopped["patch"]["inputRouting"]["mode"], "enqueue");
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Interrupted,
        usage: None,
    });
    let routing = finished
        .iter()
        .find_map(|delta| delta["patch"].get("inputRouting"))
        .unwrap();
    assert_eq!(
        *routing,
        json!({"mode": "choice", "reasonCode": "heldQueueInputRequiresChoice"})
    );
    let resumed = feed.projection.set_auto_drain(true);
    assert_eq!(resumed["patch"]["inputRouting"]["mode"], "startNow");
}

/// Fork: a failed turn's `lastError.code` is the failure's Node error code when it has one (the media budget's
/// `MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE`, which the App localizes), else `fault.turn.failed`.
#[test]
fn a_failed_turn_carries_its_node_error_code() {
    fn last_error(deltas: &[Value]) -> Value {
        fn find(value: &Value) -> Option<Value> {
            match value {
                Value::Object(map) => map
                    .get("lastError")
                    .filter(|error| !error.is_null())
                    .cloned()
                    .or_else(|| map.values().find_map(find)),
                Value::Array(items) => items.iter().find_map(find),
                _ => None,
            }
        }
        deltas.iter().find_map(find).expect("a lastError patch")
    }
    let error = rust_cli_kernel_api::model::ModelError::CurrentAttachmentsTooLarge;
    for (n, (message, code, expected)) in [
        (
            error.to_string(),
            error.code().map(str::to_owned),
            "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
        ),
        ("upstream 500".to_owned(), None, "fault.turn.failed"),
    ]
    .into_iter()
    .enumerate()
    {
        let mut feed = Feed::new();
        let turn = TurnId::new(format!("turn_{n}"));
        feed.apply(KernelEvent::TurnStarted {
            turn: turn.clone(),
            command: None,
        });
        let deltas = feed.apply(KernelEvent::TurnFinished {
            turn,
            outcome: TurnOutcome::Failed {
                message: message.clone(),
                code,
            },
            usage: None,
        });
        let error = last_error(&deltas);
        assert_eq!(error["code"], expected);
        assert_eq!(error["message"], message.as_str());
    }
}

/// Fork: a failed turn with waiting inputs pauses the queue with `pauseReason: "error"` (Node `onTurnError`); a failed
/// manual `/compact` turn and a failed turn with an empty queue do not.
#[test]
fn a_failed_turn_pauses_a_waiting_queue_with_the_error_reason() {
    use rust_cli_kernel_api::message::CompactTrigger;
    let queued = || KernelEvent::QueueChanged {
        items: vec![QueuedInput {
            edit_lock: None,
            intent: None,
            command: CommandId::new("c2"),
            text: "later".into(),
            delivery: rust_cli_kernel_api::session_api::Delivery::Queue,
            kind: Default::default(),
            execution: None,
        }],
    };
    let failed = |turn: &str| KernelEvent::TurnFinished {
        turn: TurnId::new(turn),
        outcome: TurnOutcome::Failed {
            message: "upstream 500".into(),
            code: None,
        },
        usage: None,
    };
    let queue_of = |deltas: &[Value]| {
        deltas
            .iter()
            .find_map(|delta| delta["patch"].get("queue").cloned())
    };
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    feed.apply(queued());
    let deltas = feed.apply(failed("turn_1"));
    let queue = queue_of(&deltas).expect("the failed turn patches the queue");
    assert_eq!(queue["autoDrain"], false);
    assert_eq!(queue["pauseReason"], "error");
    assert!(!feed.projection.auto_drain());
    let resumed = feed.projection.set_auto_drain(true);
    assert!(resumed["patch"]["queue"].get("pauseReason").is_none());

    // A failed manual compaction keeps draining (Node pauses on a main turn error only).
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_2"),
        command: None,
    });
    feed.apply(KernelEvent::CompactStarted {
        trigger: CompactTrigger::Manual,
    });
    feed.apply(KernelEvent::CompactFailed {
        trigger: CompactTrigger::Manual,
        message: "no".into(),
    });
    feed.apply(failed("turn_2"));
    assert!(feed.projection.auto_drain());

    // No waiting input: nothing to pause.
    let mut empty = Feed::new();
    empty.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    empty.apply(failed("turn_1"));
    assert!(empty.projection.auto_drain());
}

/// Fork: the queue item's kind and frozen execution state come from the kernel's item (one owner):
/// a goal shows its objective, a compaction is `/compact`, and only a frozen state is shown.
#[test]
fn queue_items_show_the_kernel_kind_and_frozen_state() {
    use rust_cli_kernel_api::permission::{ExecutionState, PermissionMode};
    use rust_cli_kernel_api::session_api::{Delivery, InputExecution, QueuedKind};
    let mut feed = Feed::new();
    let item = |id: &str, text: &str, kind, execution| QueuedInput {
        edit_lock: None,
        intent: None,
        command: CommandId::new(id),
        text: text.into(),
        delivery: Delivery::Queue,
        kind,
        execution,
    };
    let frozen = InputExecution {
        state: ExecutionState {
            mode: PermissionMode::Guarded,
            plan: true,
        },
        selection: Some(selection()),
        limits: Default::default(),
        keeps_session_state: false,
    };
    let deltas = feed.apply(KernelEvent::QueueChanged {
        items: vec![
            item("c1", "plan this", QueuedKind::Text, Some(frozen)),
            item("c2", "/goal ship it", QueuedKind::Goal, None),
            item("c3", "/compact", QueuedKind::Compact, None),
            item(
                "c4",
                "run",
                QueuedKind::Text,
                Some(InputExecution {
                    state: ExecutionState::default(),
                    selection: None,
                    limits: rust_cli_kernel_api::turn_limits::TurnLimits::new(
                        Some("auto_1"),
                        Vec::new(),
                    ),
                    keeps_session_state: true,
                }),
            ),
        ],
    });
    let queue = deltas
        .iter()
        .find_map(|delta| delta["patch"].get("queue"))
        .unwrap();
    let items = queue["items"].as_array().unwrap();
    let kinds: Vec<&str> = items
        .iter()
        .map(|item| item["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        ["sendText", "sendGoalCommand", "compact", "sendText"]
    );
    assert_eq!(items[0]["mode"], "guarded");
    assert_eq!(items[0]["planEnabled"], true);
    assert_eq!(items[0]["modelSelection"], state::selection(&selection()));
    assert_eq!(items[1]["text"], "/goal ship it");
    assert!(items[1].get("mode").is_none());
    assert_eq!(items[2]["text"], "/compact");
    // An input that named no mode (an automation run's limits alone) shows none.
    assert!(items[3].get("mode").is_none(), "{:?}", items[3]);
    assert!(items[3].get("planEnabled").is_none(), "{:?}", items[3]);
}

/// Fork: the desktop composer adopts the session mode once per full-access grant and the plan
/// switch once per plan tool transition (Node `config.permissionGrant` / `config.planTransition`);
/// both stay in `config` across later mode patches and in the snapshot.
#[test]
fn full_access_grants_and_plan_tool_transitions_are_in_the_config() {
    let mut feed = Feed::new();
    let deltas = feed.apply(KernelEvent::PermissionGranted {
        interaction: "ask-1".into(),
    });
    let config = &deltas.last().unwrap()["patch"]["config"];
    assert_eq!(config["permissionGrant"], json!({"interactionId": "ask-1"}));
    let deltas = feed.apply(KernelEvent::PlanTransition {
        tool_call: "call-1".into(),
        enabled: false,
    });
    let config = &deltas.last().unwrap()["patch"]["config"];
    assert_eq!(
        config["planTransition"],
        json!({"toolCallId": "call-1", "planEnabled": false})
    );
    assert_eq!(config["permissionGrant"]["interactionId"], "ask-1");
    let snapshot = feed.projection.snapshot(1, "e");
    assert_eq!(snapshot["config"]["planTransition"]["toolCallId"], "call-1");
}

/// B3 review: a cold read keeps the last grant (the session view's, from the stored receipt, Node
/// `restorePermissionGrantMarker`), so the composer does not adopt it again; a rebuilt projection keeps the view's.
#[test]
fn a_cold_projection_keeps_the_stored_permission_grant() {
    let mut granted = view(Vec::new());
    granted.permission_grant = Some("ask-1".into());
    let projection = Projection::from_view(&granted, Followup::Queue, vec!["high".into()]);
    let snapshot = projection.snapshot(1, "e");
    assert_eq!(
        snapshot["config"]["permissionGrant"],
        json!({"interactionId": "ask-1"})
    );
    let rebuilt = projection.rebuilt(&granted).snapshot(2, "e");
    assert_eq!(
        rebuilt["config"]["permissionGrant"]["interactionId"],
        "ask-1"
    );
    let fresh = Projection::from_view(&view(Vec::new()), Followup::Queue, Vec::new());
    assert!(
        fresh.snapshot(1, "e")["config"]
            .get("permissionGrant")
            .is_none()
    );
}

/// Fork: the desktop goal is the snapshot `goal` (Node `goalStateSchema`) and drives the
/// `pauseGoal` / `resumeGoal` actions.
#[test]
fn goal_changes_are_the_snapshot_goal_and_its_actions() {
    use rust_cli_kernel_api::goal::{GoalPhase, GoalState};
    let mut feed = Feed::new();
    let snapshot = feed.projection.snapshot(1, "e");
    assert_eq!(snapshot["goal"], Value::Null);
    assert_eq!(
        snapshot["availability"]["pauseGoal"],
        json!({"allowed": false, "reasonCode": "noGoalToPause"})
    );
    let goal = |status| GoalState {
        target: "msg_goal".into(),
        objective: "tests pass".into(),
        status,
        iteration: 0,
        time_used_seconds: 3,
        active_run_started_at_ms: (status == GoalPhase::Active).then_some(1_000),
        summary_title: Some("Pass the tests".into()),
        verifications: Vec::new(),
    };
    let deltas = feed.apply(KernelEvent::GoalChanged {
        goal: Some(goal(GoalPhase::Active)),
    });
    let patch = &deltas.last().unwrap()["patch"];
    assert_eq!(
        patch["goal"],
        json!({
            "targetId": "msg_goal",
            "objective": "tests pass",
            "summaryTitle": "Pass the tests",
            "timeUsedSeconds": 3,
            "activeRunStartedAtMs": 1_000,
            "status": "active",
            "iteration": 0,
            "verifications": [],
            "iterations": [],
        })
    );
    assert_eq!(patch["availability"]["pauseGoal"], json!({"allowed": true}));
    assert_eq!(
        patch["availability"]["resumeGoal"],
        json!({"allowed": false, "reasonCode": "goalNotPaused"})
    );
    let deltas = feed.apply(KernelEvent::GoalChanged {
        goal: Some(goal(GoalPhase::Paused)),
    });
    let patch = &deltas.last().unwrap()["patch"];
    assert_eq!(patch["goal"]["status"], "paused");
    assert_eq!(patch["goal"]["activeRunStartedAtMs"], Value::Null);
    assert_eq!(
        patch["availability"]["resumeGoal"],
        json!({"allowed": true})
    );
    feed.apply(KernelEvent::GoalChanged { goal: None });
    assert_eq!(feed.projection.snapshot(1, "e")["goal"], Value::Null);
}

/// Fork: a manual compaction marker names the input that asked for it (Node `sourceCommandId`).
#[test]
fn a_manual_compact_marker_carries_its_source_command() {
    use rust_cli_kernel_api::message::CompactTrigger;
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_c"),
        command: Some(CommandId::new("cmd_compact")),
    });
    let started = feed.apply(KernelEvent::CompactStarted {
        trigger: CompactTrigger::Manual,
    });
    let appended = started
        .iter()
        .find(|delta| delta["op"] == "row.appended")
        .unwrap();
    assert_eq!(appended["row"]["sourceCommandId"], "cmd_compact");
}

/// Fork: a subagent's question reaches the parent with Node's `payload.origin`; its tool call is
/// not a parent row, so the ask has no anchor.
#[test]
fn a_delegated_question_carries_the_subagent_origin() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let asked = feed.apply(KernelEvent::InteractionAsked {
        interaction: InteractionId::new("int_q"),
        request: InteractionRequest::Question {
            tool_use: ToolUseId::new("toolu_child"),
            questions: json!([{"question": "Pick", "header": "P", "options": [{"label": "a"}]}]),
            origin: Some(Box::new(rust_cli_kernel_api::orchestration::AskOrigin {
                agent: rust_cli_kernel_api::ids::AgentId::new("agent_1"),
                agent_type: "general-purpose".into(),
                child_session: rust_cli_kernel_api::ids::SessionId::new("ses_child"),
                parent_session: rust_cli_kernel_api::ids::SessionId::new("ses_parent"),
                description: "Run case".into(),
                parent_tool_use: Some(ToolUseId::new("toolu_agent")),
            })),
        },
    });
    let pending = asked
        .iter()
        .find_map(|patch| patch["patch"]["pendingInteractions"].get(0))
        .unwrap();
    assert_eq!(pending["anchorRowId"], Value::Null);
    assert_eq!(
        pending["payload"]["origin"],
        json!({
            "kind": "subagent",
            "agentId": "agent_1",
            "agentType": "general-purpose",
            "childSessionId": "ses_child",
            "description": "Run case",
            "parentSessionId": "ses_parent",
            "parentToolCallId": "toolu_agent",
        })
    );
}

/// Node's turn header sums the output tokens of every model response in the turn (`ModelComplete`), not only the
/// last one: a read then a reply of 16 and 12 tokens shows 28.
#[test]
fn the_turn_header_sums_the_output_tokens_of_every_response() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let reply = |id: &str, tokens: u64| {
        Message::Assistant(AssistantMessage {
            id: MessageId::new(id),
            content: vec![ContentBlock::Text { text: id.into() }],
            model: "m".into(),
            stop_reason: None,
            usage: Some(Usage {
                output_tokens: tokens,
                ..Usage::default()
            }),
        })
    };
    let first = feed.apply(KernelEvent::MessageDone {
        message: reply("msg_a1", 16),
    });
    assert_eq!(first[0]["row"]["kind"], "turnHeader");
    assert_eq!(first[0]["row"]["outputTokens"], 16);
    feed.apply(KernelEvent::MessageDone {
        message: reply("msg_a2", 12),
    });
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: Some(Usage {
            output_tokens: 12,
            ..Usage::default()
        }),
    });
    assert_eq!(finished[0]["row"]["kind"], "turnHeader");
    assert_eq!(finished[0]["row"]["outputTokens"], 28);
}

/// Fork: Node's `/goal X` control turn makes no request: its header says `controlOnly` (the App shows no work
/// footer) and the earlier response's usage the kernel reports with it is not counted again.
#[test]
fn a_control_turn_header_is_control_only_and_counts_no_usage() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let marked = feed.apply(KernelEvent::TurnControlOnly {
        turn: TurnId::new("turn_1"),
    });
    assert_eq!(marked[0]["row"]["kind"], "turnHeader");
    assert_eq!(marked[0]["row"]["executionKind"], "controlOnly");
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: Some(Usage {
            output_tokens: 8,
            ..Usage::default()
        }),
    });
    assert_eq!(finished[0]["row"]["kind"], "turnHeader");
    assert_eq!(finished[0]["row"]["executionKind"], "controlOnly");
    assert_eq!(finished[0]["row"].get("outputTokens"), None);
    let snapshot = feed.projection.snapshot(9, "epoch-1");
    assert_eq!(snapshot["usage"]["cumulative"]["outputTokens"], 0);
}

/// Fork: a plan-mode policy denial settles its tool row like Node's `PermissionDenied` (`cancelled`, no output), not
/// as a failed tool, live and on a cold read of the stored result.
#[test]
fn a_plan_mode_denial_settles_the_tool_row_cancelled_live_and_cold() {
    use rust_cli_kernel_api::tool::PLAN_MODE_READ_ONLY;

    let tool = ToolUseId::new("toolu_w");
    let call = assistant(
        "msg_a1",
        vec![ContentBlock::ToolUse {
            id: tool.clone(),
            name: "Write".into(),
            input: json!({"file_path": "/w/x.txt", "content": "x"}),
        }],
    );
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: call.clone(),
    });
    let done = feed.apply(KernelEvent::ToolDone {
        tool_use: tool.clone(),
        output: rust_cli_kernel_api::tool::ToolOutput {
            content: vec![ToolResultContent::Text {
                text: PLAN_MODE_READ_ONLY.into(),
            }],
            is_error: true,
            display: Value::Null,
        },
    });
    let row = &done[0]["row"];
    assert_eq!(row["status"], "cancelled", "{row}");
    assert!(row.get("output").is_none(), "{row}");

    let result = Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("msg_r1"),
        content: vec![ContentBlock::ToolResult {
            tool_use_id: tool,
            content: vec![ToolResultContent::Text {
                text: PLAN_MODE_READ_ONLY.into(),
            }],
            is_error: true,
        }],
        origin: UserOrigin::ToolResult {
            assistant: MessageId::new("msg_a1"),
        },
    });
    let snapshot = Projection::from_view(
        &view(vec![user("msg_u1", "plan"), call, result]),
        Followup::Guide,
        Vec::new(),
    )
    .snapshot(0, "epoch");
    let cold = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "toolCall")
        .cloned()
        .unwrap_or_default();
    assert_eq!(cold["status"], "cancelled", "{snapshot}");
}

/// A background task notification: a meta user message, no typed input (Node `task-notification` origin).
fn notification(id: &str) -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: "<task-notification>done</task-notification>".into(),
        }],
        origin: UserOrigin::Meta {
            source: "task-notification".into(),
        },
    })
}

fn said(text: &str) -> Vec<ContentBlock> {
    vec![ContentBlock::Text { text: text.into() }]
}

/// The assistant row of message `id` (a streamed row keeps its `turn:response:index` entity id).
fn reply_of<'a>(projection: &'a Projection, id: &str) -> &'a Map<String, Value> {
    projection
        .rows
        .iter()
        .find(|row| row["kind"] == "assistantText" && row["assistantResponseId"] == id)
        .unwrap()
}

/// Fork: a turn opened by a notification offers `canFork` on its latest reply like a typed-input turn
/// (Node `materializeCommandRowActions` has no real-user requirement); earlier replies do not.
#[test]
fn a_notification_turn_offers_fork_on_its_final_reply() {
    let mut feed = Feed::new();
    let turn = TurnId::new("turn_n");
    feed.apply(KernelEvent::TurnStarted {
        turn: turn.clone(),
        command: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: notification("msg_notice"),
    });
    // Each model response is its own row key (turn, response, block): stream two responses.
    let reply = |response: u32, text: &str| KernelEvent::StreamDelta {
        turn: turn.clone(),
        response,
        index: 0,
        delta: BlockDelta::Text(text.into()),
    };
    feed.apply(reply(1, "checking"));
    feed.apply(KernelEvent::MessageDone {
        message: assistant("msg_n1", said("checking")),
    });
    feed.apply(reply(2, "noted"));
    feed.apply(KernelEvent::MessageDone {
        message: assistant("msg_n2", said("noted")),
    });
    let running = &feed.projection;
    assert!(reply_of(running, "msg_n2").get("actions").is_none());
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn,
        outcome: TurnOutcome::Success,
        usage: None,
    });
    let projection = &feed.projection;
    assert!(reply_of(projection, "msg_n1").get("actions").is_none());
    assert_eq!(
        reply_of(projection, "msg_n2")["actions"],
        json!({"canFork": true})
    );
    assert!(finished.iter().any(|delta| {
        delta["op"] == "row.upserted"
            && delta["row"]["assistantResponseId"] == "msg_n2"
            && delta["row"]["actions"] == json!({"canFork": true})
    }));
    let reply = reply_of(projection, "msg_n2");
    let (row_id, entity) = (
        reply["rowId"].as_u64().unwrap(),
        reply["entityId"].as_str().unwrap().to_owned(),
    );
    assert_eq!(
        projection.fork_target(row_id, &entity),
        Ok("msg_n2".to_owned())
    );
    // An earlier reply of the same turn is no longer the target: unavailable, not stale.
    let earlier = reply_of(projection, "msg_n1");
    assert_eq!(
        projection.fork_target(
            earlier["rowId"].as_u64().unwrap(),
            earlier["entityId"].as_str().unwrap()
        ),
        Err(TargetMiss::Unavailable)
    );
    assert_eq!(
        projection.fork_target(row_id, "other"),
        Err(TargetMiss::Stale)
    );
    assert_eq!(
        projection.fork_target(u64::MAX, &entity),
        Err(TargetMiss::Stale)
    );
}

/// Fork: a notification turn that is still running, or that ended interrupted, offers no fork.
#[test]
fn a_notification_turn_offers_no_fork_while_running_or_interrupted() {
    let mut feed = Feed::new();
    let turn = TurnId::new("turn_n");
    feed.apply(KernelEvent::TurnStarted {
        turn: turn.clone(),
        command: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: notification("msg_notice"),
    });
    feed.apply(KernelEvent::MessageDone {
        message: assistant("msg_n1", said("noted")),
    });
    feed.apply(KernelEvent::TurnFinished {
        turn,
        outcome: TurnOutcome::Interrupted,
        usage: None,
    });
    assert!(
        row_of(&feed.projection, "assistantText", "msg_n1")
            .get("actions")
            .is_none()
    );
}

/// Fork: a quoted input shows its typed text and its quotes from its input intent (Node `intent.text` and
/// `conversationQuotes`), cold and queued alike; the stored text keeps the block the model read. A text that merely
/// ends with a quote block has no chips, and an intent's `[]` is kept.
#[test]
fn a_quoted_input_shows_the_typed_text_and_its_quotes() {
    use rust_cli_kernel_api::input_intent::InputIntent;
    use rust_cli_kernel_api::session_api::{Delivery, QueuedKind};
    let expected = json!([{"text": "E2E selection", "path": "/w/a.ts"}]);
    let intent = |text: &str, quotes: Value| -> InputIntent {
        serde_json::from_value(json!({"text": text, "conversationQuotes": quotes})).unwrap()
    };
    let quoted_intent = intent("explain this", expected.clone());
    let quoted = quoted_intent.compose("explain this");
    let with_intent = |id: &str, text: &str, intent: InputIntent| {
        let Message::User(mut message) = user(id, text) else {
            unreachable!()
        };
        message.intent = Some(Box::new(intent));
        Message::User(message)
    };
    let projection = Projection::from_view(
        &view(vec![
            with_intent("msg_u1", &quoted, quoted_intent.clone()),
            assistant("msg_a1", vec![ContentBlock::Text { text: "ok".into() }]),
            user("msg_u2", "plain"),
            assistant("msg_a2", vec![ContentBlock::Text { text: "ok".into() }]),
            // A literal block without an intent is plain text.
            user("msg_u3", &quoted),
            assistant("msg_a3", vec![ContentBlock::Text { text: "ok".into() }]),
            with_intent("msg_u4", "typed", intent("typed", json!([]))),
            assistant("msg_a4", vec![ContentBlock::Text { text: "ok".into() }]),
        ]),
        Followup::Guide,
        Vec::new(),
    );
    let snapshot = projection.snapshot(0, "epoch");
    let inputs: Vec<&Value> = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "userInput")
        .collect();
    assert_eq!(inputs[0]["text"], "explain this");
    assert_eq!(inputs[0]["conversationQuotes"], expected);
    assert_eq!(inputs[1]["text"], "plain");
    assert!(inputs[1].get("conversationQuotes").is_none());
    assert_eq!(inputs[2]["text"], json!(quoted));
    assert!(inputs[2].get("conversationQuotes").is_none());
    assert_eq!(inputs[3]["text"], "typed");
    assert_eq!(inputs[3]["conversationQuotes"], json!([]));

    let mut feed = Feed::new();
    let deltas = feed.apply(KernelEvent::QueueChanged {
        items: vec![QueuedInput {
            edit_lock: None,
            intent: Some(Box::new(quoted_intent)),
            command: CommandId::new("c1"),
            text: "explain this".into(),
            delivery: Delivery::Queue,
            kind: QueuedKind::Text,
            execution: None,
        }],
    });
    let queue = deltas
        .iter()
        .find_map(|delta| delta["patch"].get("queue"))
        .unwrap();
    assert_eq!(queue["items"][0]["text"], "explain this");
    assert_eq!(queue["items"][0]["conversationQuotes"], expected);
}

/// B4 (specs/fork-rust-agent-parity.md): an extension source shows on the userInput row and on the queue item of the
/// input it was sent with. A body that imitates a source gets none: the source comes only from the intent.
#[test]
fn an_extension_source_shows_on_the_row_and_the_queue_item() {
    use rust_cli_kernel_api::input_intent::InputIntent;
    use rust_cli_kernel_api::session_api::{Delivery, QueuedKind};
    let source = json!({"kind": "extension", "pluginId": "gitlab@zcode-plugins-example"});
    let sourced: InputIntent =
        serde_json::from_value(json!({"text": "from plugin", "source": source})).unwrap();
    let Message::User(mut sent) = user("msg_u1", "from plugin") else {
        unreachable!()
    };
    sent.intent = Some(Box::new(sourced.clone()));
    let imitation = r#"{"kind":"extension","pluginId":"gitlab@zcode-plugins-example"}"#;
    let projection = Projection::from_view(
        &view(vec![
            Message::User(sent),
            assistant("msg_a1", vec![ContentBlock::Text { text: "ok".into() }]),
            user("msg_u2", imitation),
            assistant("msg_a2", vec![ContentBlock::Text { text: "ok".into() }]),
        ]),
        Followup::Guide,
        Vec::new(),
    );
    let snapshot = projection.snapshot(0, "epoch");
    let inputs: Vec<&Value> = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "userInput")
        .collect();
    assert_eq!(inputs[0]["source"], source);
    assert_eq!(inputs[1]["text"], imitation);
    assert!(inputs[1].get("source").is_none());

    let mut feed = Feed::new();
    let deltas = feed.apply(KernelEvent::QueueChanged {
        items: vec![QueuedInput {
            edit_lock: None,
            intent: Some(Box::new(sourced)),
            command: CommandId::new("c1"),
            text: "from plugin".into(),
            delivery: Delivery::Queue,
            kind: QueuedKind::Text,
            execution: None,
        }],
    });
    let queue = deltas
        .iter()
        .find_map(|delta| delta["patch"].get("queue"))
        .unwrap();
    assert_eq!(queue["items"][0]["source"], source);
}

/// Fork (specs/fork-rust-topic-resource.md): a bot-group input's row and queue item carry its `botGroupSource` (Node
/// `projection-rows.ts`, queue item `botGroupSource`), and the row shows the typed text instead of the prompt the
/// model read.
#[test]
fn a_bot_group_input_shows_its_source_and_typed_text() {
    use rust_cli_kernel_api::input_intent::InputIntent;
    use rust_cli_kernel_api::session_api::{Delivery, QueuedKind};
    let source = json!({"botId": "b1", "chatId": "oc_1", "threadId": "omt_1", "authorizationId": "a1",
        "messageId": "om_1"});
    let intent: InputIntent =
        serde_json::from_value(json!({"text": "hello bot", "botGroupSource": source})).unwrap();
    let Message::User(mut sent) = user(
        "msg_u1",
        "hello bot\n\nTopic history: see the attached file",
    ) else {
        unreachable!()
    };
    sent.intent = Some(Box::new(intent.clone()));
    let projection = Projection::from_view(
        &view(vec![
            Message::User(sent),
            assistant("msg_a1", vec![ContentBlock::Text { text: "ok".into() }]),
            user("msg_u2", "plain"),
            assistant("msg_a2", vec![ContentBlock::Text { text: "ok".into() }]),
        ]),
        Followup::Guide,
        Vec::new(),
    );
    let snapshot = projection.snapshot(0, "epoch");
    let inputs: Vec<&Value> = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "userInput")
        .collect();
    assert_eq!(inputs[0]["text"], "hello bot");
    assert_eq!(inputs[0]["botGroupSource"], source);
    assert!(inputs[1].get("botGroupSource").is_none());

    let mut feed = Feed::new();
    let deltas = feed.apply(KernelEvent::QueueChanged {
        items: vec![QueuedInput {
            edit_lock: None,
            intent: Some(Box::new(intent)),
            command: CommandId::new("c1"),
            text: "hello bot".into(),
            delivery: Delivery::Queue,
            kind: QueuedKind::Text,
            execution: None,
        }],
    });
    let queue = deltas
        .iter()
        .find_map(|delta| delta["patch"].get("queue"))
        .unwrap();
    assert_eq!(queue["items"][0]["botGroupSource"], source);
}

fn sequenced(seq: u64, event: KernelEvent) -> SequencedEvent {
    SequencedEvent {
        seq,
        event,
        revision: seq,
    }
}

/// Fork: a session renamed while closed is opened with its stored source; a live update that is not a title keeps
/// `custom` in the meta (it used to derive `generated` from any title).
#[test]
fn a_stored_custom_title_stays_custom_after_a_live_update() {
    use rust_cli_kernel_api::title::Source;
    let mut opened = view(Vec::new());
    opened.meta.title = "Renamed".into();
    opened.title_source = Some(Source::Custom);
    let mut projection = Projection::from_view(&opened, Followup::Queue, Vec::new());
    assert_eq!(projection.title_source(), Source::Custom);
    let update = KernelEvent::ContextUsage {
        used_tokens: 5,
        max_tokens: 10,
        compact_at: None,
        window_tokens: None,
    };
    projection.apply(&sequenced(1, update), 0);
    assert_eq!(
        projection.snapshot(1, "e")["meta"],
        json!({"title": "Renamed", "titleSource": "custom"})
    );
}

/// Fork: Node `onSessionTitleUpdated`: the event's source reaches the meta (`first_input` shows as `generated`), and
/// once the title is custom an automatic one does not replace it.
#[test]
fn a_live_rename_is_custom_and_an_automatic_title_does_not_replace_it() {
    use rust_cli_kernel_api::title::Source;
    let mut projection = Projection::from_view(&view(Vec::new()), Followup::Queue, Vec::new());
    let titled = |seq, title: &str, source| {
        sequenced(
            seq,
            KernelEvent::TitleChanged {
                title: title.into(),
                source,
            },
        )
    };
    let deltas = projection.apply(&titled(1, "fix the bug", Source::FirstInput), 0);
    assert_eq!(
        deltas[0]["patch"]["meta"],
        json!({"title": "fix the bug", "titleSource": "generated"})
    );
    let deltas = projection.apply(&titled(2, "Mine", Source::Custom), 0);
    assert_eq!(
        deltas[0]["patch"]["meta"],
        json!({"title": "Mine", "titleSource": "custom"})
    );
    projection.apply(&titled(3, "Generated", Source::Generated), 0);
    assert_eq!(projection.title(), "Mine");
    assert_eq!(projection.title_source(), Source::Custom);
    projection.apply(&titled(4, "Mine again", Source::Custom), 0);
    assert_eq!(
        projection.snapshot(4, "e")["meta"],
        json!({"title": "Mine again", "titleSource": "custom"})
    );
}

/// Fork: the queue item shows its composer edit lock while the kernel holds it (App `queueItemEditLockSchema`), and
/// an edit's attachment refs replace the chips the App shows for the item (the protocol's input metadata).
#[test]
fn a_queue_item_shows_its_edit_lock_and_its_attachment_chips() {
    use rust_cli_kernel_api::session_api::{Delivery, QueueEditLock, QueuedKind};
    let mut feed = Feed::new();
    let lock = QueueEditLock {
        editor_id: "ed1".into(),
        client_id: "client-desk".into(),
        input_origin: Some("desktop".into()),
    };
    let queued = |edit_lock: Option<QueueEditLock>| QueuedInput {
        intent: None,
        command: CommandId::new("c1"),
        text: "alpha".into(),
        delivery: Delivery::Queue,
        kind: QueuedKind::Text,
        execution: None,
        edit_lock,
    };
    let deltas = feed.apply(KernelEvent::QueueChanged {
        items: vec![queued(Some(lock))],
    });
    let queue = deltas
        .iter()
        .find_map(|delta| delta["patch"].get("queue"))
        .unwrap();
    assert_eq!(
        queue["items"][0]["editLock"],
        json!({"editorId": "ed1", "clientId": "client-desk", "inputOrigin": "desktop"})
    );
    // Released: the item carries no lock field at all.
    let deltas = feed.apply(KernelEvent::QueueChanged {
        items: vec![queued(None)],
    });
    let queue = deltas
        .iter()
        .find_map(|delta| delta["patch"].get("queue"))
        .unwrap();
    assert!(queue["items"][0].get("editLock").is_none());

    feed.projection.remember_input(
        "c1",
        InputMeta {
            client: "client-desk".into(),
            origin: None,
            text: "alpha".into(),
            admitted_at: 0,
            requested: "queue",
            admitted: "queue",
            attachments: vec![json!({"ref": "old"})],
            automation: None,
        },
    );
    let patch = feed
        .projection
        .set_queued_attachments("c1", vec![json!({"ref": "new"})])
        .expect("the input has metadata");
    assert_eq!(
        patch["patch"]["queue"]["items"][0]["attachments"],
        json!([{"ref": "new"}])
    );
    assert!(
        feed.projection
            .set_queued_attachments("missing", Vec::new())
            .is_none()
    );
}

/// Fork: a session-level ask (an MCP App authorization from the composer or a panel, a background subagent's ask)
/// outlives the turn that was running when it was asked. The kernel resolves the turn's own asks before `TurnFinished`
/// (`cancel_turn_asks`), so the projection keeps what is still pending. Found by `plugin-extension-mention` on Rust: a
/// mention's prompt asked during a turn vanished when the turn ended, though Rust still waited for its answer.
#[test]
fn a_session_level_ask_stays_pending_after_the_turn_ends() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    feed.apply(KernelEvent::InteractionAsked {
        interaction: InteractionId::new("int_app"),
        request: InteractionRequest::Permission {
            origin: None,
            tool_use: ToolUseId::new("helper_req_1"),
            tool: "mcp__plugin_e2e_mention__mention_search".into(),
            input: json!({"query": "a"}),
            message: "Allow?".into(),
            suggestions: Vec::new(),
            rule_seed: None,
            asked_by: None,
            machine: Default::default(),
            once: false,
            independent: false,
        },
    });
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    assert!(
        finished
            .iter()
            .all(|delta| delta["patch"].get("pendingInteractions").is_none()),
        "{finished:?}"
    );
    assert_eq!(feed.projection.pending_permissions(), 1);
    let snapshot = feed.projection.snapshot(9, "epoch-1");
    assert_eq!(
        snapshot["pendingInteractions"][0]["interactionId"],
        "int_app"
    );
}
