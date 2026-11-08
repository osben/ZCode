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
        },
        messages,
        selection(),
        PermissionMode::Default,
    )
}

fn user(id: &str, text: &str) -> Message {
    Message::User(UserMessage {
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
        &event(1, 4, KernelEvent::TitleChanged { title: "t".into() }),
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
        },
    );
    let queued = feed.apply(KernelEvent::QueueChanged {
        items: vec![QueuedInput {
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

/// Fork: a cold `userInput` row shows the stored attachments as chips (after a restart too), and `attachmentRead`
/// authorizes their refs; the bubble is only the typed text.
#[test]
fn cold_rows_carry_the_chips_of_stored_attachments() {
    use rust_cli_kernel_api::message::{AttachedBody, AttachedFile};

    let message = Message::User(UserMessage {
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
        Some("image/png".into())
    );
    assert_eq!(
        projection.attachment_mime("zcode-artifact://session_1/c"),
        None
    );
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
        },
    );
    let queued = feed.apply(KernelEvent::QueueChanged {
        items: vec![QueuedInput {
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

/// Fork: the queue item's kind and frozen execution state come from the kernel's item (one owner):
/// a goal shows its objective, a compaction is `/compact`, and only a frozen state is shown.
#[test]
fn queue_items_show_the_kernel_kind_and_frozen_state() {
    use rust_cli_kernel_api::permission::{ExecutionState, PermissionMode};
    use rust_cli_kernel_api::session_api::{Delivery, InputExecution, QueuedKind};
    let mut feed = Feed::new();
    let item = |id: &str, text: &str, kind, execution| QueuedInput {
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
    };
    let deltas = feed.apply(KernelEvent::QueueChanged {
        items: vec![
            item("c1", "plan this", QueuedKind::Text, Some(frozen)),
            item("c2", "/goal ship it", QueuedKind::Goal, None),
            item("c3", "/compact", QueuedKind::Compact, None),
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
    assert_eq!(kinds, ["sendText", "sendGoalCommand", "compact"]);
    assert_eq!(items[0]["mode"], "guarded");
    assert_eq!(items[0]["planEnabled"], true);
    assert_eq!(items[0]["modelSelection"], state::selection(&selection()));
    assert_eq!(items[1]["text"], "ship it");
    assert!(items[1].get("mode").is_none());
    assert_eq!(items[2]["text"], "/compact");
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
            "summaryTitle": null,
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
