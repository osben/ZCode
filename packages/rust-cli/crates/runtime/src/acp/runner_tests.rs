#![allow(
    clippy::disallowed_methods,
    reason = "tests write the agent records and read the mock agent's state file directly"
)]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::abort::{Abort, AbortReason};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, RunId, SessionId};
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::model::{ApiMessage, ModelSelection, QuerySource};
use rust_cli_kernel_api::orchestration::{
    QueryError, QueryRequest, QueryRunner, QueryStop, RunSink,
};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::{MemoryStore, RecordingSink, SequentialIds};
use rust_cli_kernel_api::user_input::INTERRUPT_TEXTS;
use rust_cli_proc::ledger::Ledger;
use serde_json::json;

use super::test_support::mock_agent;
use super::{AcpHost, AcpSetup, ExternalAgentRunner};

/// The runner's fallback: never reached by an ACP selection.
struct NoModel;

#[async_trait]
impl QueryRunner for NoModel {
    async fn run(
        &self,
        _request: QueryRequest,
        _sink: Arc<dyn RunSink>,
        _abort: Abort,
    ) -> Result<QueryStop, QueryError> {
        panic!("an ACP selection reached the model loop");
    }

    fn transcript(
        &self,
        _history: &[Message],
        _selection: &ModelSelection,
        _mid_system: Option<bool>,
    ) -> Vec<ApiMessage> {
        Vec::new()
    }
}

struct Harness {
    dir: tempfile::TempDir,
    runner: Arc<ExternalAgentRunner>,
    _scope: TaskScope,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let records_file = dir.path().join("fork_acp_agents.json");
        let state = dir.path().join("agent-state.json");
        let file = json!({"schemaVersion": 1, "agents": [{
            "agentId": "mock", "providerName": "Mock Agent", "enabled": true,
            "command": mock_agent(), "args": ["--state", state],
        }]});
        std::fs::write(&records_file, file.to_string()).unwrap();
        let scope = TaskScope::root("acp-test", |_| {});
        let host = AcpHost::new(
            AcpSetup {
                records_file,
                env: Arc::from(Vec::new()),
                ledger: Ledger::open(dir.path().join("ledger")),
            },
            Arc::new(MemoryStore::default()),
            Arc::new(SequentialIds::default()),
            scope.spawner(),
        );
        let runner = Arc::new(ExternalAgentRunner {
            inner: Arc::new(NoModel),
            host: Arc::new(host),
        });
        Self {
            dir,
            runner,
            _scope: scope,
        }
    }

    fn request(&self, messages: Vec<Message>) -> QueryRequest {
        QueryRequest::new(
            SessionId::new("s1"),
            RunId::new("r1"),
            WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new(self.dir.path().display().to_string()),
            },
            messages,
            ModelSelection::new("acp:mock", "mock"),
            PermissionMode::Default,
            QuerySource::MainThread,
        )
    }

    fn agent_got(&self, method: &str) -> bool {
        std::fs::read_to_string(self.dir.path().join("agent-state.json"))
            .is_ok_and(|state| state.contains(method))
    }

    async fn release(&self) {
        self.runner.host.pool.release(&SessionId::new("s1")).await;
    }
}

fn user(id: &str, text: &str, origin: UserOrigin) -> Message {
    Message::User(UserMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        origin,
        intent: None,
        stall_execution: None,
    })
}

fn texts(messages: &[Message]) -> Vec<String> {
    messages
        .iter()
        .flat_map(|message| match message {
            Message::User(user) => user.content.clone(),
            Message::Assistant(assistant) => assistant.content.clone(),
            _ => Vec::new(),
        })
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_refused_automatic_turn_still_commits_its_prompt_hook_messages() {
    let harness = Harness::new();
    let mut request = harness.request(vec![user(
        "m1",
        "continue",
        UserOrigin::Meta {
            source: rust_cli_kernel_api::goal::CONTINUATION_SOURCE.to_owned(),
        },
    )]);
    request.prompt_hook_messages = vec![user(
        "hook",
        "hook context",
        UserOrigin::Meta {
            source: "hook".to_owned(),
        },
    )];
    let sink = Arc::new(RecordingSink::default());
    let stop = harness
        .runner
        .run(request, sink.clone(), Abort::new())
        .await
        .expect("run");
    assert!(
        matches!(&stop, QueryStop::ApiError { message } if message.contains("runtime continuations")),
        "{stop:?}"
    );
    assert_eq!(texts(&sink.messages()), vec!["hook context".to_owned()]);
}

#[tokio::test]
async fn a_failed_segment_commit_fails_the_turn() {
    let harness = Harness::new();
    let sink = Arc::new(RecordingSink::default());
    // The text before the tool call is committed when the tool call arrives; that commit fails.
    sink.fail_next_commit_message();
    let result = harness
        .runner
        .run(
            harness.request(vec![user("m1", "narrate", UserOrigin::Human)]),
            sink.clone(),
            Abort::new(),
        )
        .await;
    assert!(
        matches!(result, Err(QueryError::Store(_))),
        "a lost segment must fail the turn like the query loop: {result:?}"
    );
    harness.release().await;
}

#[tokio::test]
async fn an_answer_that_settles_after_stop_ends_the_turn_interrupted() {
    let harness = Harness::new();
    let sink = Arc::new(RecordingSink::default());
    let abort = Abort::new();
    let running = {
        let runner = harness.runner.clone();
        let request = harness.request(vec![user("m1", "slow", UserOrigin::Human)]);
        let sink = sink.clone();
        let abort = abort.clone();
        tokio::spawn(async move { runner.run(request, sink, abort).await })
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        while !harness.agent_got("session/prompt") {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the agent got the prompt");
    // The agent answers `end_turn` after its pause; the Stop lands before that.
    abort.abort(AbortReason::User);
    let stop = running.await.expect("task").expect("run");
    assert_eq!(stop, QueryStop::Aborted);
    assert_eq!(
        texts(&sink.messages()).last().map(String::as_str),
        Some(INTERRUPT_TEXTS[0]),
        "the interrupt marker follows a stopped turn"
    );
    harness.release().await;
}
