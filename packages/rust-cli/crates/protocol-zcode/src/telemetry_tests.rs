use rust_cli_kernel_api::ids::{CommandId, MessageId, ToolUseId, TurnId};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, Message, Usage, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::session_api::{KernelEvent, TurnOutcome};
use rust_cli_kernel_api::tool::ToolOutput;
use serde_json::{Value, json};

use super::{Observed, Provider, Role, SubagentLink, Telemetry, uuid_v7};

/// The fields `conversationTelemetryFactSchema` allows per kind (packages/shared/src/zcode-protocol-v4/telemetry.ts);
/// the schema is strict, so any other field drops the fact on the Host.
fn allowed(kind: &str) -> Vec<&'static str> {
    let mut fields = vec![
        "memoryEnabled",
        "version",
        "eventId",
        "eventSeq",
        "occurredAt",
        "sessionId",
        "sourceCommandId",
        "turnId",
        "kind",
    ];
    fields.extend(match kind {
        "turn.started" => &[
            "inputOrigin",
            "modelName",
            "modelProvider",
            "executionKind",
            "inputSource",
            "backgroundSource",
        ][..],
        "model.request.status" => &[
            "requestId",
            "status",
            "providerId",
            "modelId",
            "providerKind",
            "providerHostname",
            "transport",
            "querySource",
            "queryId",
            "attempt",
            "maxAttempts",
            "durationMs",
        ],
        "stream.chunk" => &[
            "channel",
            "chunkLength",
            "firstChunk",
            "assistantMessageId",
            "partId",
            "parentToolCallId",
        ],
        "tool.lifecycle" => &[
            "phase",
            "toolCallId",
            "toolName",
            "durationMs",
            "errorCode",
            "errorMessage",
        ],
        "usage.delta" => &[
            "requestId",
            "providerId",
            "modelId",
            "providerKind",
            "providerHostname",
            "inputTokens",
            "outputTokens",
            "totalTokens",
            "reasoningTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
        ],
        "subagent.lifecycle" => &[
            "phase",
            "agentId",
            "agentType",
            "childSessionId",
            "parentToolCallId",
            "background",
            "status",
            "errorMessage",
        ],
        "turn.terminal" => &[
            "status",
            "resultType",
            "durationMs",
            "tokenCount",
            "toolCallCount",
            "errorCode",
            "errorMessage",
            "backgroundSubagentResultConsumed",
        ],
        other => panic!("unexpected kind {other}"),
    });
    fields
}

/// Every fact has only the schema's fields, no empty string field (`min(1)`), and a unique event ID.
pub(crate) fn assert_schema(facts: &[Value]) {
    let mut ids = std::collections::HashSet::new();
    for fact in facts {
        let kind = fact["kind"].as_str().expect("kind");
        let allowed = allowed(kind);
        for (key, value) in fact.as_object().expect("object") {
            assert!(allowed.contains(&key.as_str()), "{kind} has {key}: {fact}");
            assert!(
                value.as_str() != Some(""),
                "{kind} has an empty {key}: {fact}"
            );
        }
        assert!(
            ids.insert(fact["eventId"].as_str().expect("eventId").to_owned()),
            "duplicate event id: {fact}"
        );
    }
}

fn provider() -> Provider {
    Provider {
        provider: "e2e-upstream".into(),
        model: "deepseek-v4-flash".into(),
        kind: Some("anthropic".into()),
        host: Some("127.0.0.1".into()),
    }
}

struct Run {
    telemetry: Telemetry,
    provider: Provider,
    seq: u64,
    facts: Vec<Value>,
}

impl Run {
    fn new(session: &str, role: Role) -> Self {
        Self {
            telemetry: Telemetry::new(session, role),
            provider: provider(),
            seq: 0,
            facts: Vec::new(),
        }
    }

    fn event(&mut self, event: KernelEvent) {
        self.seq += 1;
        let at = Observed {
            scope: "",
            seq: self.seq,
            now: 1_000 + self.seq,
            provider: &self.provider,
        };
        let facts = self.telemetry.observe(&event, &at);
        self.facts.extend(facts);
    }

    fn links(&mut self, links: &[SubagentLink]) -> Vec<String> {
        let mut out = Vec::new();
        self.seq += 1;
        let at = Observed {
            scope: "table-",
            seq: self.seq,
            now: 1_000 + self.seq,
            provider: &self.provider,
        };
        let spawned = self.telemetry.subagents(links, &at, &mut out);
        self.facts.extend(out);
        spawned
    }

    fn kinds(&self) -> Vec<String> {
        self.facts
            .iter()
            .map(|fact| {
                let kind = fact["kind"].as_str().unwrap_or_default();
                let detail = fact
                    .get("status")
                    .or_else(|| fact.get("phase"))
                    .and_then(Value::as_str);
                detail.map_or_else(|| kind.to_owned(), |detail| format!("{kind}:{detail}"))
            })
            .collect()
    }

    fn assert_schema(&self) {
        assert_schema(&self.facts);
    }
}

fn turn_started(turn: &str, command: Option<&str>) -> KernelEvent {
    KernelEvent::TurnStarted {
        turn: TurnId::new(turn),
        command: command.map(CommandId::new),
    }
}

fn text_delta(turn: &str, response: u32, text: &str) -> KernelEvent {
    KernelEvent::StreamDelta {
        turn: TurnId::new(turn),
        response,
        index: 0,
        delta: BlockDelta::Text(text.into()),
    }
}

fn assistant(id: &str, input: u64, output: u64) -> KernelEvent {
    KernelEvent::MessageDone {
        message: Message::Assistant(AssistantMessage {
            id: MessageId::new(id),
            content: vec![],
            model: "deepseek-v4-flash".into(),
            stop_reason: None,
            usage: Some(Usage {
                input_tokens: input,
                output_tokens: output,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            }),
        }),
    }
}

fn finished(turn: &str) -> KernelEvent {
    KernelEvent::TurnFinished {
        turn: TurnId::new(turn),
        outcome: TurnOutcome::Success,
        usage: None,
    }
}

#[test]
fn a_plain_turn_reports_its_request_usage_and_terminal() {
    let mut run = Run::new("sess_main", Role::Main);
    run.event(turn_started("turn_1", Some("cmd-1")));
    run.event(text_delta("turn_1", 0, "hello"));
    run.event(text_delta("turn_1", 0, " there"));
    run.event(assistant("msg_1", 128, 12));
    run.event(finished("turn_1"));

    assert_eq!(
        run.kinds(),
        [
            "turn.started",
            "model.request.status:model_request_started",
            "stream.chunk",
            "stream.chunk",
            "model.request.status:model_request_completed",
            "usage.delta",
            "turn.terminal:success",
        ]
    );
    run.assert_schema();
    let facts = &run.facts;
    assert!(facts.iter().all(|fact| fact["sourceCommandId"] == "cmd-1"));
    assert_eq!(facts[0]["modelName"], "deepseek-v4-flash");
    assert_eq!(facts[2]["firstChunk"], true);
    assert_eq!(facts[3]["firstChunk"], false);
    assert_eq!(facts[1]["requestId"], facts[5]["requestId"]);
    assert_eq!(facts[1]["providerHostname"], "127.0.0.1");
    assert_eq!(facts[1]["querySource"], "main_turn");
    assert_eq!(facts[5]["totalTokens"], 140);
    assert_eq!(facts[6]["tokenCount"], 140);
    assert_eq!(facts[6]["toolCallCount"], 0);
    assert_eq!(facts[6]["resultType"], "success");
}

#[test]
fn a_tool_turn_reports_the_tool_lifecycle() {
    let mut run = Run::new("sess_main", Role::Main);
    run.event(turn_started("turn_1", Some("cmd-1")));
    run.event(KernelEvent::ToolInputStarted {
        turn: TurnId::new("turn_1"),
        response: 0,
        index: 0,
        tool_use: ToolUseId::new("toolu_1"),
        name: "Bash".into(),
    });
    run.event(assistant("msg_1", 128, 16));
    run.event(KernelEvent::ToolStarted {
        tool_use: ToolUseId::new("toolu_1"),
        name: "Bash".into(),
        input: json!({"command": "true"}),
    });
    run.event(KernelEvent::ToolDone {
        tool_use: ToolUseId::new("toolu_1"),
        output: ToolOutput {
            content: vec![],
            is_error: false,
            display: Value::Null,
        },
    });
    run.event(text_delta("turn_1", 1, "done"));
    run.event(assistant("msg_2", 128, 12));
    run.event(finished("turn_1"));

    assert_eq!(
        run.kinds(),
        [
            "turn.started",
            "model.request.status:model_request_started",
            "tool.lifecycle:scheduled",
            "model.request.status:model_request_completed",
            "usage.delta",
            "tool.lifecycle:started",
            "tool.lifecycle:completed",
            "model.request.status:model_request_started",
            "stream.chunk",
            "model.request.status:model_request_completed",
            "usage.delta",
            "turn.terminal:success",
        ]
    );
    run.assert_schema();
    let tool = &run.facts[6];
    assert_eq!(tool["toolName"], "Bash");
    assert_eq!(tool["toolCallId"], "toolu_1");
    assert_eq!(tool["durationMs"], 1);
    let terminal = run.facts.last().expect("terminal");
    assert_eq!(terminal["toolCallCount"], 1);
    assert_eq!(terminal["tokenCount"], 284);
    assert_ne!(run.facts[1]["requestId"], run.facts[7]["requestId"]);
}

#[test]
fn a_wake_turn_gets_a_fresh_command_and_its_background_source() {
    let mut run = Run::new("sess_main", Role::Main);
    run.event(turn_started("turn_2", None));
    assert!(run.facts.is_empty(), "the start waits for the notification");
    run.event(KernelEvent::MessageDone {
        message: Message::User(UserMessage {
            stall_execution: None,
            intent: None,
            id: MessageId::new("msg_n"),
            content: vec![ContentBlock::Text {
                text:
                    "<task-notification>\n<task-id>agent_1</task-id>\n<status>completed</status>\n\
                       <summary>Agent \"Check history\" completed</summary>\n</task-notification>"
                        .into(),
            }],
            origin: UserOrigin::Meta {
                source: "task_notification".into(),
            },
        }),
    });
    run.event(text_delta("turn_2", 0, "ok"));
    run.event(assistant("msg_3", 128, 12));
    run.event(finished("turn_2"));

    run.assert_schema();
    let started = &run.facts[0];
    assert_eq!(started["kind"], "turn.started");
    assert_eq!(started["inputSource"], "background_task");
    assert_eq!(started["backgroundSource"], "subagent");
    // The held start keeps the seq of its TurnStarted.
    assert_eq!(started["eventSeq"], 1);
    let command = started["sourceCommandId"].as_str().expect("command");
    assert_eq!(&command[14..15], "7", "a UUID v7: {command}");
    assert!(
        run.facts
            .iter()
            .all(|fact| fact["sourceCommandId"] == command)
    );
    let terminal = run.facts.last().expect("terminal");
    assert_eq!(terminal["backgroundSubagentResultConsumed"], true);
}

#[test]
fn subagent_rows_report_spawn_and_stop_once() {
    let mut run = Run::new("sess_main", Role::Main);
    run.event(turn_started("turn_1", Some("cmd-1")));
    let link = |status: &str| SubagentLink {
        agent: "agent_1".into(),
        agent_type: Some("general-purpose".into()),
        child: "sess_subagent_agent_1".into(),
        parent_tool: "toolu_agent".into(),
        background: true,
        status: status.into(),
        turn: Some("turn_1".into()),
    };
    assert_eq!(run.links(&[link("running")]), ["sess_subagent_agent_1"]);
    assert!(run.links(&[link("running")]).is_empty());
    run.event(finished("turn_1"));
    run.links(&[link("success")]);
    run.links(&[link("success")]);

    assert_eq!(
        run.kinds(),
        [
            "turn.started",
            "subagent.lifecycle:running",
            "turn.terminal:success",
            "subagent.lifecycle:completed",
        ]
    );
    run.assert_schema();
    let spawned = &run.facts[1];
    assert_eq!(spawned["phase"], "spawned");
    assert_eq!(spawned["sourceCommandId"], "cmd-1");
    assert_eq!(spawned["background"], true);
    assert_eq!(spawned["childSessionId"], "sess_subagent_agent_1");
    let stopped = &run.facts[3];
    assert_eq!(stopped["phase"], "stopped");
    assert!(stopped.get("sourceCommandId").is_none());
    assert_eq!(stopped["turnId"], "turn_1");
}

#[test]
fn a_child_run_reports_under_the_child_session_without_a_command() {
    let mut run = Run::new("sess_subagent_agent_1", Role::Child);
    run.event(turn_started("turn_c", None));
    run.event(text_delta("turn_c", 0, "child"));
    run.event(assistant("msg_c", 128, 12));
    run.event(finished("turn_c"));

    assert_eq!(
        run.kinds(),
        [
            "turn.started",
            "model.request.status:model_request_started",
            "stream.chunk",
            "model.request.status:model_request_completed",
            "usage.delta",
            "turn.terminal:success",
        ]
    );
    run.assert_schema();
    assert_eq!(run.facts[0]["inputSource"], "subagent");
    assert_eq!(run.facts[1]["querySource"], "subagent");
    assert!(
        run.facts
            .iter()
            .all(|fact| fact.get("sourceCommandId").is_none())
    );
    assert!(
        run.facts
            .iter()
            .all(|fact| fact["sessionId"] == "sess_subagent_agent_1")
    );
}

#[test]
fn uuid_v7_has_the_version_and_variant_bits() {
    let id = uuid_v7(0x0190_0000_0001);
    assert_eq!(id.len(), 36);
    assert_eq!(&id[..13], "01900000-0001");
    assert_eq!(&id[14..15], "7");
    assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"), "{id}");
}

#[test]
fn a_subagent_notification_merged_into_a_user_turn_marks_it_consumed() {
    let mut run = Run::new("sess_main", Role::Main);
    run.event(turn_started("turn_1", Some("cmd-1")));
    run.event(KernelEvent::MessageDone {
        message: Message::User(UserMessage {
            stall_execution: None,
            intent: None,
            id: MessageId::new("msg_n"),
            content: vec![ContentBlock::Text {
                text: "<system-reminder>\n<task-notification>\n<task-id>agent_1</task-id>\n\
                       <summary>Agent \"Check\" completed</summary>\n</task-notification>"
                    .into(),
            }],
            origin: UserOrigin::Meta {
                source: "task_notification".into(),
            },
        }),
    });
    run.event(finished("turn_1"));

    run.assert_schema();
    let started = &run.facts[0];
    assert!(
        started.get("inputSource").is_none(),
        "a user turn keeps its own source"
    );
    let terminal = run.facts.last().expect("terminal");
    assert_eq!(terminal["backgroundSubagentResultConsumed"], true);
}

#[test]
fn a_subagent_notification_merged_at_a_tool_boundary_marks_the_turn_consumed() {
    use rust_cli_kernel_api::hooks::queued_command;
    use rust_cli_kernel_api::message::AttachmentMessage;

    let mut run = Run::new("sess_main", Role::Main);
    run.event(turn_started("turn_1", Some("cmd-1")));
    run.event(KernelEvent::MessageDone {
        message: Message::Attachment(AttachmentMessage {
            id: MessageId::new("msg_a"),
            source: queued_command::SOURCE.into(),
            text: "<system-reminder>\n<task-notification>\n<task-id>agent_1</task-id>\n\
                   <summary>Agent \"Check\" completed</summary>\n</task-notification>"
                .into(),
            data: json!({ queued_command::MODE_KEY: queued_command::TASK_NOTIFICATION }),
        }),
    });
    run.event(finished("turn_1"));

    run.assert_schema();
    let terminal = run.facts.last().expect("terminal");
    assert_eq!(terminal["backgroundSubagentResultConsumed"], true);
}

#[test]
fn a_resumed_subagent_reports_a_second_lifecycle_pair() {
    let mut run = Run::new("sess_main", Role::Main);
    let link = |status: &str| SubagentLink {
        agent: "agent_1".into(),
        agent_type: Some("general-purpose".into()),
        child: "sess_subagent_agent_1".into(),
        parent_tool: "toolu_agent".into(),
        background: true,
        status: status.into(),
        turn: Some("turn_1".into()),
    };
    run.event(turn_started("turn_1", Some("cmd-1")));
    assert_eq!(run.links(&[link("running")]), ["sess_subagent_agent_1"]);
    run.event(finished("turn_1"));
    run.links(&[link("success")]);
    // `SendMessage` in a later turn resumes the settled agent: its row runs again and the run is read again.
    run.event(turn_started("turn_2", Some("cmd-2")));
    assert_eq!(run.links(&[link("running")]), ["sess_subagent_agent_1"]);
    run.event(finished("turn_2"));
    run.links(&[link("success")]);

    assert_eq!(
        run.kinds(),
        [
            "turn.started",
            "subagent.lifecycle:running",
            "turn.terminal:success",
            "subagent.lifecycle:completed",
            "turn.started",
            "subagent.lifecycle:running",
            "turn.terminal:success",
            "subagent.lifecycle:completed",
        ]
    );
    run.assert_schema();
    let respawned = &run.facts[5];
    assert_eq!(respawned["phase"], "spawned");
    assert_eq!(respawned["turnId"], "turn_2");
    assert_eq!(respawned["sourceCommandId"], "cmd-2");
    // Node reports the stop under the turn of its spawn (the resuming turn), not the row's launch turn.
    assert_eq!(run.facts[7]["turnId"], "turn_2");
}

#[test]
fn a_subagent_without_its_call_id_omits_the_parent_tool_call() {
    let mut run = Run::new("sess_main", Role::Main);
    run.links(&[SubagentLink {
        agent: "agent_1".into(),
        agent_type: None,
        child: "sess_subagent_agent_1".into(),
        parent_tool: String::new(),
        background: false,
        status: "running".into(),
        turn: None,
    }]);
    run.assert_schema();
    assert!(run.facts[0].get("parentToolCallId").is_none());
}
