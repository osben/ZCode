//! 子会话的文件 checkpoint（session-lifecycle.md §4.2、agents.md §4.1）。

use std::sync::Arc;

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{
    AgentId, ArtifactId, EnvironmentId, MessageId, SessionId, ToolUseId, TraceId,
};
use rust_cli_kernel_api::message::{
    ContentBlock, Message, ToolResultContent, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::orchestration::{QueryEvent, RunSink};
use rust_cli_kernel_api::store::{
    ArtifactPurpose, ArtifactRef, SessionKind, SessionMeta, SessionStore,
};
use rust_cli_kernel_api::testing::{MemoryStore, SequentialIds};
use rust_cli_kernel_api::tool::ToolOutput;
use serde_json::json;

use super::ChildSink;
use crate::live::Live;

#[tokio::test]
async fn subagent_writes_settle_checkpoints_in_the_child_session() {
    let store = Arc::new(MemoryStore::default());
    let child = SessionId::new("sess_subagent_agent_1");
    store
        .create(SessionMeta {
            id: child.clone(),
            kind: SessionKind::Subagent,
            parent: Some(SessionId::new("sess_parent")),
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/Users/dev/work"),
            },
            title: "edit".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: 1,
            incognito: None,
        })
        .await
        .unwrap();
    let sink = ChildSink::new(
        store.clone(),
        Arc::new(SequentialIds::default()),
        Arc::new(Live::default()),
        AgentId::new("agent_1"),
        child.clone(),
        MessageId::new("prompt_1"),
        None,
    );
    let artifact = ArtifactRef {
        session: child.clone(),
        id: ArtifactId::new("checkpoint-tool-result-1.json"),
        purpose: ArtifactPurpose::Checkpoint,
        media_type: "application/json".to_owned(),
        size: 10,
    };
    sink.emit(QueryEvent::ToolFinished {
        tool_use: ToolUseId::new("toolu_1"),
        output: ToolOutput {
            content: Vec::new(),
            is_error: false,
            display: json!({"checkpoint": {"artifact": artifact, "path": "/Users/dev/work/a.txt", "additions": 1, "deletions": 0}}),
        },
    })
    .await;
    sink.commit_message(Message::User(UserMessage {
        stall_execution: None,
        epilogue_start: None,
        intent: None,
        id: MessageId::new("result_1"),
        content: vec![ContentBlock::ToolResult {
            tool_use_id: ToolUseId::new("toolu_1"),
            content: vec![ToolResultContent::Text {
                text: "ok".to_owned(),
            }],
            is_error: false,
        }],
        origin: UserOrigin::ToolResult {
            assistant: MessageId::new("assistant_1"),
        },
    }))
    .await
    .unwrap();
    let loaded = store.load(&child).await.unwrap();
    assert_eq!(loaded.checkpoints.len(), 1);
    let checkpoint = &loaded.checkpoints[0];
    assert_eq!(checkpoint.prompt, MessageId::new("prompt_1"));
    assert_eq!(checkpoint.assistant, MessageId::new("assistant_1"));
    assert_eq!(checkpoint.tool_use, ToolUseId::new("toolu_1"));
    assert_eq!(checkpoint.snapshot, artifact);
}

#[tokio::test]
async fn subagent_calls_are_committed_with_their_messages_in_the_child_session() {
    use rust_cli_kernel_api::message::AssistantMessage;
    use rust_cli_kernel_api::metering::{CallStatus, Metered, ToolCall};
    use rust_cli_kernel_api::store::Fact;

    let store = Arc::new(MemoryStore::default());
    let child = SessionId::new("sess_subagent_agent_2");
    store
        .create(SessionMeta {
            id: child.clone(),
            kind: SessionKind::Subagent,
            parent: Some(SessionId::new("sess_parent")),
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/Users/dev/work"),
            },
            title: "look".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: 1,
            incognito: None,
        })
        .await
        .unwrap();
    let sink = ChildSink::new(
        store.clone(),
        Arc::new(SequentialIds::default()),
        Arc::new(Live::default()),
        AgentId::new("agent_2"),
        child.clone(),
        MessageId::new("prompt_1"),
        None,
    );
    let call = ToolCall {
        tool_use: ToolUseId::new("toolu_1"),
        name: "Read".to_owned(),
        started_at_ms: 1,
        completed_at_ms: 2,
        status: CallStatus::Completed,
        output_bytes: 2,
    };
    let assistant = Message::Assistant(AssistantMessage {
        id: MessageId::new("assistant_1"),
        content: vec![ContentBlock::Text {
            text: "hi".to_owned(),
        }],
        model: "m".to_owned(),
        stop_reason: None,
        usage: None,
    });
    sink.commit_metered(Some(assistant), Metered::Tool(call.clone()))
        .await
        .unwrap();
    sink.commit_metered(None, Metered::Tool(call.clone()))
        .await
        .unwrap();
    let facts = store.facts(&child);
    assert!(matches!(facts[0], Fact::MessageAppended { .. }));
    assert_eq!(facts[1], Fact::ToolCalled { call: call.clone() });
    assert_eq!(facts[2], Fact::ToolCalled { call });
    // 同批提交的 assistant 仍记进子代理的结果（最后一条 assistant）。
    assert_eq!(
        sink.outcome().0.map(|a| a.id),
        Some(MessageId::new("assistant_1"))
    );
}

/// 缺陷 D5（architecture-review.md）：子代理再派生的子代理（孙会话）要在子会话里有关联事实。子代理的 Agent 调用的结果
/// 提交时，排在工具结果与它的 checkpoint 之后、同一批写 `Fact::SubagentLinked`（与主会话同一份规则，node-store.md
/// §4.6）。以前子代理的提交路径不记关联，App 的子代理面板找不到孙会话。
#[tokio::test]
async fn a_nested_agent_call_links_the_grandchild_session_in_the_same_batch() {
    use rust_cli_kernel_api::store::Fact;

    let store = Arc::new(MemoryStore::default());
    let child = SessionId::new("sess_subagent_agent_1");
    store
        .create(SessionMeta {
            id: child.clone(),
            kind: SessionKind::Subagent,
            parent: Some(SessionId::new("sess_parent")),
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/Users/dev/work"),
            },
            title: "nest".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: 1,
            incognito: None,
        })
        .await
        .unwrap();
    let sink = ChildSink::new(
        store.clone(),
        Arc::new(SequentialIds::default()),
        Arc::new(Live::default()),
        AgentId::new("agent_1"),
        child.clone(),
        MessageId::new("prompt_1"),
        None,
    );
    sink.emit(QueryEvent::ToolFinished {
        tool_use: ToolUseId::new("toolu_agent"),
        output: ToolOutput {
            content: Vec::new(),
            is_error: false,
            display: json!({"agent": {
                "agentId": "agent_2",
                "childSessionId": "sess_subagent_agent_2",
                "agentType": "Explore",
            }}),
        },
    })
    .await;
    sink.commit_message(Message::User(UserMessage {
        stall_execution: None,
        epilogue_start: None,
        intent: None,
        id: MessageId::new("result_1"),
        content: vec![ContentBlock::ToolResult {
            tool_use_id: ToolUseId::new("toolu_agent"),
            content: vec![ToolResultContent::Text {
                text: "done".to_owned(),
            }],
            is_error: false,
        }],
        origin: UserOrigin::ToolResult {
            assistant: MessageId::new("assistant_1"),
        },
    }))
    .await
    .unwrap();
    let facts = store.facts(&child);
    let kinds: Vec<&str> = facts
        .iter()
        .map(|fact| match fact {
            Fact::MessageAppended { .. } => "message",
            Fact::SubagentLinked { .. } => "link",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, ["message", "link"]);
    assert_eq!(store.batch_turns(&child).len(), 1, "one batch");
    assert_eq!(
        facts[1],
        Fact::SubagentLinked {
            tool_use: ToolUseId::new("toolu_agent"),
            agent: AgentId::new("agent_2"),
            child: SessionId::new("sess_subagent_agent_2"),
            agent_type: "Explore".to_owned(),
        }
    );
}

/// Node `ToolCallStarted` counts: every started call counts, protocol tools included, and only the world-touching ones
/// count as world. A run with started calls and no committed assistant message (so a count of the transcript's tool
/// uses would read 0) still reports the started calls: the count comes from the started stream.
#[test]
fn started_calls_count_from_the_stream_and_only_world_tools_count_as_world() {
    use crate::child::RunStats;
    let mut stats = RunStats::default();
    stats.tool_started("Read");
    stats.tool_started("Bash");
    stats.tool_started("submit_result");
    stats.tool_started("escalate");
    assert_eq!(stats.tool_calls, 4, "every started call counts");
    assert_eq!(
        stats.world_tool_calls, 2,
        "Read and Bash touch the world; the protocol tools do not"
    );
    assert_eq!(
        stats.usage_requests, 0,
        "no response was committed, so no request is counted"
    );
}

/// Node `isWorldTouchingToolCall`: the protocol tools are the ones with a session or userInteraction scope, and an
/// unknown tool is world-touching (its scope is undefined in Node).
#[test]
fn the_protocol_tools_are_not_world_touching_and_an_unknown_tool_is() {
    use crate::child::is_world_touching;
    for name in [
        "Agent",
        "AskUserQuestion",
        "escalate",
        "EnterPlanMode",
        "ExitPlanMode",
        "ReadTopicResource",
        "RespondToCoordinator",
        "SendMessage",
        "Skill",
        "submit_result",
        "TodoWrite",
        "TaskStop",
    ] {
        assert!(!is_world_touching(name), "{name} is protocol-only");
    }
    assert!(is_world_touching("Write"));
    assert!(is_world_touching("some_mcp_tool"));
}

/// Node `usage.totalTokens` is the sum over the turn's requests, and `modelRequestCount` counts those with usage. Two
/// requests with usage sum; a request without usage adds nothing to either.
#[test]
fn the_turns_tokens_sum_over_every_request_with_usage() {
    use crate::child::RunStats;
    use rust_cli_kernel_api::message::Usage;
    let mut stats = RunStats::default();
    stats.model_request(Some(Usage {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    }));
    stats.model_request(None);
    stats.model_request(Some(Usage {
        input_tokens: 20,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 3,
    }));
    assert_eq!(
        stats.usage_requests, 2,
        "the request without usage is not counted"
    );
    assert_eq!(stats.usage_tokens, 15 + 30, "each request's tokens, summed");
}

/// The tool count comes from the started stream, not from the transcript. A run that started two tools and committed no
/// assistant message has two counted calls, while the transcript-derived count (the tool_use blocks of the committed
/// messages, returned by `outcome`) is 0.
#[tokio::test]
async fn the_tool_count_comes_from_the_started_stream_not_from_the_transcript() {
    let store = Arc::new(MemoryStore::default());
    let child = SessionId::new("sess_subagent_agent_stream");
    store
        .create(SessionMeta {
            id: child.clone(),
            kind: SessionKind::Subagent,
            parent: Some(SessionId::new("sess_parent")),
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/Users/dev/work"),
            },
            title: "stream".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: 1,
            incognito: None,
        })
        .await
        .unwrap();
    let sink = ChildSink::new(
        store.clone(),
        Arc::new(SequentialIds::default()),
        Arc::new(Live::default()),
        AgentId::new("agent_stream"),
        child.clone(),
        MessageId::new("prompt_stream"),
        None,
    );
    for (id, name) in [("toolu_read", "Read"), ("toolu_bash", "Bash")] {
        sink.emit(QueryEvent::ToolStarted {
            tool_use: ToolUseId::new(id),
            name: name.to_owned(),
            input: json!({}),
        })
        .await;
    }
    let (_, transcript_tool_uses) = sink.outcome();
    assert_eq!(
        transcript_tool_uses, 0,
        "no assistant message was committed, so the transcript shows no tool use"
    );
    let stats = sink.run_stats();
    assert_eq!(
        stats.tool_calls, 2,
        "the started stream shows the two calls"
    );
    assert_eq!(
        stats.world_tool_calls, 2,
        "Read and Bash both touch the world"
    );
}

/// Node `createModelUsageSummaryFromEvents` sums the usage of every request that carries it, whatever its status: a
/// cancelled request that reports usage counts its request and its tokens.
#[tokio::test]
async fn a_cancelled_request_with_usage_counts_its_request_and_tokens() {
    let store = Arc::new(MemoryStore::default());
    let child = SessionId::new("sess_subagent_agent_cancelled_usage");
    store
        .create(SessionMeta {
            id: child.clone(),
            kind: SessionKind::Subagent,
            parent: Some(SessionId::new("sess_parent")),
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/Users/dev/work"),
            },
            title: "cancelled".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: 1,
            incognito: None,
        })
        .await
        .unwrap();
    let sink = ChildSink::new(
        store.clone(),
        Arc::new(SequentialIds::default()),
        Arc::new(Live::default()),
        AgentId::new("agent_cancelled_usage"),
        child.clone(),
        MessageId::new("prompt_cancelled_usage"),
        None,
    );
    let call = rust_cli_kernel_api::metering::ModelCall {
        usage: Some(rust_cli_kernel_api::message::Usage {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        }),
        ..rust_cli_kernel_api::metering::ModelCall::new(
            MessageId::new("msg_cancelled"),
            rust_cli_kernel_api::model::QuerySource::Subagent("Explore".to_owned()),
            rust_cli_kernel_api::testing::selection(),
            1_000,
            4_000,
            rust_cli_kernel_api::metering::CallStatus::Cancelled,
        )
    };
    sink.commit_metered(None, rust_cli_kernel_api::metering::Metered::Model(call))
        .await
        .unwrap();
    let stats = sink.run_stats();
    assert_eq!(
        stats.usage_requests, 1,
        "a cancelled request with usage is counted"
    );
    assert_eq!(stats.usage_tokens, 15, "its input and output tokens");
}

/// Node's `isWorldTouchingToolCall` excludes exactly the tools whose side-effect scope is `session` or `userInteraction`.
/// In Node's handler files on origin/fork those are: Agent, AskUserQuestion, escalate, EnterPlanMode, ExitPlanMode,
/// ReadTopicResource, RespondToCoordinator, SendMessage, Skill, submit_result, TaskStop, TodoWrite. Pinned by name: 12
/// names.
#[test]
fn the_protocol_only_set_is_exactly_nodes_session_and_user_interaction_tools() {
    use rust_cli_kernel_api::tool_names as names;
    let protocol = [
        names::AGENT,
        names::ASK_USER_QUESTION,
        crate::escalate::NAME,
        names::ENTER_PLAN_MODE,
        names::EXIT_PLAN_MODE,
        names::READ_TOPIC_RESOURCE,
        crate::respond::NAME,
        names::SEND_MESSAGE,
        names::SKILL,
        crate::submit::NAME,
        names::TASK_STOP,
        names::TODO_WRITE,
    ];
    for name in protocol {
        assert!(
            !crate::child::is_world_touching(name),
            "{name} is protocol-only"
        );
    }
    assert!(
        crate::child::is_world_touching(names::READ),
        "Read touches the world"
    );
}

/// A call refused at its permission check is scheduled and then finished with an error, and never starts (Node
/// counts `ToolCallStarted` only): the child's tool count leaves it out, and the call that ran is counted.
#[tokio::test]
async fn a_refused_call_is_scheduled_and_finished_but_not_counted() {
    let store = Arc::new(MemoryStore::default());
    let child = SessionId::new("sess_subagent_agent_refused");
    store
        .create(SessionMeta {
            id: child.clone(),
            kind: SessionKind::Subagent,
            parent: Some(SessionId::new("sess_parent")),
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/Users/dev/work"),
            },
            title: "refused".to_owned(),
            trace: TraceId::new("trace"),
            created_at_ms: 1,
            incognito: None,
        })
        .await
        .unwrap();
    let sink = ChildSink::new(
        store.clone(),
        Arc::new(SequentialIds::default()),
        Arc::new(Live::default()),
        AgentId::new("agent_refused"),
        child.clone(),
        MessageId::new("prompt_refused"),
        None,
    );
    sink.emit(QueryEvent::ToolScheduled {
        tool_use: ToolUseId::new("toolu_bash"),
        name: "Bash".to_owned(),
        input: json!({}),
    })
    .await;
    sink.emit(QueryEvent::ToolFinished {
        tool_use: ToolUseId::new("toolu_bash"),
        output: rust_cli_kernel_api::tool::ToolOutput {
            content: Vec::new(),
            is_error: true,
            display: serde_json::Value::Null,
        },
    })
    .await;
    sink.emit(QueryEvent::ToolScheduled {
        tool_use: ToolUseId::new("toolu_read"),
        name: "Read".to_owned(),
        input: json!({}),
    })
    .await;
    sink.emit(QueryEvent::ToolStarted {
        tool_use: ToolUseId::new("toolu_read"),
        name: "Read".to_owned(),
        input: json!({}),
    })
    .await;
    let stats = sink.run_stats();
    assert_eq!(stats.tool_calls, 1, "only the call that started is counted");
    assert_eq!(stats.world_tool_calls, 1);
}
