#![allow(
    clippy::disallowed_methods,
    reason = "tests write the agent records and read the mock agent's state file directly"
)]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::abort::{Abort, AbortReason};
use rust_cli_kernel_api::agents::{TaskPlanWriter, TaskRecord, TaskStatus};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, RunId, SessionId};
use rust_cli_kernel_api::message::{ContentBlock, ExternalTool, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::model::{ApiMessage, ModelSelection, QuerySource};
use rust_cli_kernel_api::orchestration::QueryEvent;
use rust_cli_kernel_api::orchestration::{
    QueryError, QueryRequest, QueryRunner, QueryStop, RunSink,
};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::store::{StoreError, StoreQueries as _};
use rust_cli_kernel_api::testing::{FixedClock, MemoryStore, RecordingSink, SequentialIds};
use rust_cli_kernel_api::user_input::INTERRUPT_TEXTS;
use rust_cli_proc::ledger::Ledger;
use serde_json::json;

use super::test_support::mock_agent;
use super::{AcpHost, AcpSetup, ExternalAgentRunner};

/// The task board's stand-in: one list, replaced whole.
#[derive(Default)]
struct Plans(std::sync::Mutex<Vec<TaskRecord>>);

#[async_trait]
impl TaskPlanWriter for Plans {
    async fn replace(
        &self,
        _session: &SessionId,
        tasks: Vec<TaskRecord>,
    ) -> Result<Vec<TaskRecord>, StoreError> {
        Ok(std::mem::replace(&mut *self.0.lock().unwrap(), tasks))
    }
}

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
    plans: Arc<Plans>,
    store: Arc<MemoryStore>,
    _scope: TaskScope,
}

impl Harness {
    fn new() -> Self {
        Self::with(&[], None)
    }

    /// A harness whose mock agent gets `flags` after `--state`, and whose stall window is `stall` when given.
    fn with(flags: &[&str], stall: Option<Duration>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let records_file = dir.path().join("fork_acp_agents.json");
        let state = dir.path().join("agent-state.json");
        let mut args = vec![json!("--state"), json!(state)];
        args.extend(flags.iter().map(|flag| json!(flag)));
        let file = json!({"schemaVersion": 1, "agents": [{
            "agentId": "mock", "providerName": "Mock Agent", "enabled": true,
            "command": mock_agent(), "args": args,
        }]});
        std::fs::write(&records_file, file.to_string()).unwrap();
        let scope = TaskScope::root("acp-test", |_| {});
        let plans = Arc::new(Plans::default());
        let store = Arc::new(MemoryStore::default());
        let mut host = AcpHost::new(
            AcpSetup {
                records_file,
                env: Arc::from(Vec::new()),
                ledger: Ledger::open(dir.path().join("ledger")),
            },
            store.clone(),
            (
                Arc::new(FixedClock(1_700_000_000_000)),
                Arc::new(SequentialIds::default()),
            ),
            plans.clone(),
            scope.spawner(),
        );
        if let Some(stall_warning) = stall {
            host.pool.set_timeouts(rust_cli_acp::AcpTimeouts {
                stall_warning,
                ..rust_cli_acp::AcpTimeouts::default()
            });
        }
        let runner = Arc::new(ExternalAgentRunner {
            inner: Arc::new(NoModel),
            host: Arc::new(host),
        });
        Self {
            dir,
            runner,
            plans,
            store,
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

    /// The ACP methods the mock agent received, in order.
    fn methods(&self) -> Vec<String> {
        let text =
            std::fs::read_to_string(self.dir.path().join("agent-state.json")).unwrap_or_default();
        let state: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        state["methods"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|method| method.as_str().map(str::to_owned))
            .collect()
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
    let messages = sink.messages();
    assert_eq!(
        texts(&messages).last().map(String::as_str),
        Some(INTERRUPT_TEXTS[0]),
        "the interrupt marker follows a stopped turn"
    );
    // The answer's usage is kept on the closed segment, as for a completed turn.
    let usage = messages.iter().find_map(|message| match message {
        Message::Assistant(assistant) => assistant.usage,
        _ => None,
    });
    assert_eq!(
        usage.map(|usage| (usage.input_tokens, usage.output_tokens)),
        Some((7, 3))
    );
    harness.release().await;
}

/// The ACP rows a run committed, each as (message index, row).
fn rows(messages: &[Message]) -> Vec<(usize, ExternalTool)> {
    messages
        .iter()
        .enumerate()
        .flat_map(|(at, message)| match message {
            Message::Assistant(assistant) => assistant
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ExternalTool(row) => Some((at, (**row).clone())),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        })
        .collect()
}

/// What the live rows did: (title, running) per `ExternalToolRow`, (output, error) per `ToolFinished`.
fn live(events: &[QueryEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            QueryEvent::ExternalToolRow {
                name,
                title,
                running,
                ..
            } => Some(format!("row {name} {title:?} running={running}")),
            QueryEvent::ToolFinished { output, .. } => Some(format!(
                "done {:?} error={}",
                output
                    .content
                    .iter()
                    .map(|item| match item {
                        rust_cli_kernel_api::message::ToolResultContent::Text { text } =>
                            text.clone(),
                        _ => String::new(),
                    })
                    .collect::<String>(),
                output.is_error
            )),
            _ => None,
        })
        .collect()
}

async fn run(harness: &Harness, text: &str) -> (QueryStop, Arc<RecordingSink>) {
    let sink = Arc::new(RecordingSink::default());
    let stop = harness
        .runner
        .run(
            harness.request(vec![user("m1", text, UserOrigin::Human)]),
            sink.clone(),
            Abort::new(),
        )
        .await
        .expect("run");
    (stop, sink)
}

/// Rule 6: a tool call is a live row (opened, started, settled) and one committed `ExternalTool` row with its title,
/// `rawInput` and output text, between the segments around it; it is never a model tool call.
#[tokio::test]
async fn a_tool_call_is_a_live_row_and_a_committed_row() {
    let harness = Harness::new();
    let (stop, sink) = run(&harness, "use a tool").await;
    assert_eq!(stop, QueryStop::Completed);
    assert_eq!(
        live(&sink.events()),
        vec![
            r#"row acp:read "Read a.txt" running=true"#,
            r#"row acp:read "Read a.txt" running=true"#,
            r#"done "file body" error=false"#,
        ]
    );
    let messages = sink.messages();
    let rows = rows(&messages);
    assert_eq!(rows.len(), 1);
    let (at, row) = &rows[0];
    assert_eq!(
        (
            row.name.as_str(),
            row.title.as_str(),
            row.output.as_str(),
            row.is_error
        ),
        ("acp:read", "Read a.txt", "file body", false)
    );
    assert_eq!(row.input, json!({"path": "a.txt"}));
    assert!(row.id.as_str().starts_with("acp_"));
    // The text after the row is its own message.
    assert_eq!(texts(&messages[at + 1..]), vec!["tool finished".to_owned()]);
    assert!(messages.iter().all(|message| {
        match message {
            Message::Assistant(assistant) => !assistant
                .content
                .iter()
                .any(|block| matches!(block, ContentBlock::ToolUse { .. })),
            _ => true,
        }
    }));
    harness.release().await;
}

/// Rule 6: a row still open when the agent ends its turn closes as an error with Node's text, after the last
/// segment, and carries the turn's usage when no segment did.
#[tokio::test]
async fn a_row_open_at_the_turn_end_closes_after_the_last_segment() {
    let harness = Harness::new();
    let (_, sink) = run(&harness, "narrate").await;
    let messages = sink.messages();
    let rows = rows(&messages);
    assert_eq!(rows.len(), 1);
    let (at, row) = &rows[0];
    assert_eq!(
        (row.output.as_str(), row.is_error),
        ("The agent turn ended before this tool finished", true)
    );
    assert_eq!(
        *at,
        messages.len() - 1,
        "the closed row follows the last segment"
    );
    assert_eq!(
        texts(&messages),
        vec!["let me look".to_owned(), "done looking".to_owned()]
    );
    harness.release().await;
}

/// Rule 6: when the last segment cannot be committed the turn fails like a mid-turn commit failure: its open rows
/// settle on screen with the failed-turn text, and nothing more is committed.
#[tokio::test]
async fn a_failed_last_segment_commit_settles_open_rows_live() {
    let harness = Harness::new();
    let sink = Arc::new(RecordingSink::default());
    // "let me look" is committed when the tool call arrives; "done looking" at the turn end fails.
    sink.fail_commit_message_after(1);
    let result = harness
        .runner
        .run(
            harness.request(vec![user("m1", "narrate", UserOrigin::Human)]),
            sink.clone(),
            Abort::new(),
        )
        .await;
    assert!(matches!(result, Err(QueryError::Store(_))), "{result:?}");
    assert_eq!(
        live(&sink.events()).last().map(String::as_str),
        Some(r#"done "The agent turn failed before this tool finished" error=true"#)
    );
    let messages = sink.messages();
    assert!(rows(&messages).is_empty());
    assert_eq!(texts(&messages), vec!["let me look".to_owned()]);
    harness.release().await;
}

/// Rule 6, Node `isTurnCancellationError`: an aborted turn whose last segment cannot be committed still ends
/// interrupted. Its open rows settle "Cancelled" on screen, and the interrupt marker follows.
#[tokio::test]
async fn stop_with_a_failed_last_segment_commit_still_ends_interrupted() {
    let harness = Harness::new();
    let sink = Arc::new(RecordingSink::default());
    // The tool call closes no segment (none is open yet); "still running" is the first commit, at the turn end.
    sink.fail_next_commit_message();
    let abort = Abort::new();
    let running = {
        let runner = harness.runner.clone();
        let request = harness.request(vec![user("m1", "dwell", UserOrigin::Human)]);
        let sink = sink.clone();
        let abort = abort.clone();
        tokio::spawn(async move { runner.run(request, sink, abort).await })
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        while !sink.events().iter().any(|event| {
            matches!(event, QueryEvent::Delta { delta: rust_cli_kernel_api::model::BlockDelta::Text(text), .. } if text.contains("still running"))
        }) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the segment opened");
    abort.abort(AbortReason::User);
    assert_eq!(
        running.await.expect("task").expect("run"),
        QueryStop::Aborted
    );
    assert_eq!(
        live(&sink.events()).last().map(String::as_str),
        Some(r#"done "Cancelled" error=true"#)
    );
    assert_eq!(texts(&sink.messages()), vec![INTERRUPT_TEXTS[0].to_owned()]);
    harness.release().await;
}

/// The ACP status events a run emitted, in order, with the text deltas around them.
fn statuses(events: &[QueryEvent]) -> Vec<String> {
    use rust_cli_kernel_api::model::BlockDelta;
    use rust_cli_kernel_api::orchestration::ExternalAgentStatus;
    events
        .iter()
        .filter_map(|event| match event {
            QueryEvent::ExternalAgentContextReset { agent } => Some(format!("reset {agent}")),
            QueryEvent::ExternalAgentStatus {
                agent,
                status: ExternalAgentStatus::Stalled { .. },
            } => Some(format!("stalled {agent}")),
            QueryEvent::ExternalAgentStatus {
                agent,
                status: ExternalAgentStatus::Resumed,
            } => Some(format!("resumed {agent}")),
            QueryEvent::Delta {
                delta: BlockDelta::Text(text),
                ..
            } => Some(format!("text {text}")),
            _ => None,
        })
        .collect()
}

/// Rule 14: a cold start whose earlier ACP session the agent cannot load starts a new one and says so once, before
/// the agent's first output (Node `takeSessionStart() === "reset"`). The first turn (`created`) says nothing.
#[tokio::test]
async fn a_session_the_agent_cannot_load_is_a_context_reset() {
    let harness = Harness::with(&["--refuse-load"], None);
    let (_, first) = run(&harness, "hello").await;
    assert_eq!(statuses(&first.events()), vec!["text pong".to_owned()]);
    // The runtime goes; the binding stays, so the next turn is a cold start that asks for the earlier session.
    harness.release().await;
    let (stop, second) = run(&harness, "hello").await;
    assert_eq!(stop, QueryStop::Completed);
    assert!(harness.agent_got("session/load"));
    assert_eq!(
        statuses(&second.events()),
        vec!["reset mock".to_owned(), "text pong".to_owned()]
    );
    harness.release().await;
}

/// Rule 14: a turn opened by a notice never draws a reset divider, so the projection may key the divider by the input
/// that opened its turn. The runner refuses the notice turn before it acquires the agent: no `session/load`, no reset.
/// The reset still owed goes to the next typed turn.
#[tokio::test]
async fn a_notice_turn_draws_no_context_reset() {
    let harness = Harness::with(&["--refuse-load"], None);
    run(&harness, "hello").await;
    harness.release().await;
    let notice = harness.request(vec![user(
        "n1",
        "<task-notification>done</task-notification>",
        UserOrigin::Meta {
            source: rust_cli_kernel_api::hooks::queued_command::TASK_NOTIFICATION.to_owned(),
        },
    )]);
    let sink = Arc::new(RecordingSink::default());
    let stop = harness
        .runner
        .run(notice, sink.clone(), Abort::new())
        .await
        .expect("run");
    assert!(
        matches!(&stop, QueryStop::ApiError { message } if message.contains("background results")),
        "{stop:?}"
    );
    assert!(statuses(&sink.events()).is_empty(), "{:?}", sink.events());
    assert!(!harness.agent_got("session/load"));
    let (_, typed) = run(&harness, "hello").await;
    assert_eq!(
        statuses(&typed.events()),
        vec!["reset mock".to_owned(), "text pong".to_owned()]
    );
    harness.release().await;
}

/// Rule 14: a loaded session is no reset, and the history the agent replays while loading is never shown.
#[tokio::test]
async fn a_loaded_session_is_no_reset_and_its_replay_is_not_shown() {
    let harness = Harness::new();
    run(&harness, "hello").await;
    harness.release().await;
    let (_, second) = run(&harness, "hello").await;
    assert!(harness.agent_got("session/load"));
    assert_eq!(statuses(&second.events()), vec!["text pong".to_owned()]);
    assert!(
        texts(&second.messages())
            .iter()
            .all(|text| !text.contains("replayed history"))
    );
    harness.release().await;
}

/// Rule 14: a prompt silent for the stall window reports `stalled` once, and the next frame `resumed` (Node
/// `StallWatch`). The window is shortened for the test; the mock pauses three times as long.
#[tokio::test]
async fn a_silent_prompt_stalls_then_resumes() {
    let harness = Harness::with(&[], Some(Duration::from_millis(100)));
    let (stop, sink) = run(&harness, "slow").await;
    assert_eq!(stop, QueryStop::Completed);
    assert_eq!(
        statuses(&sink.events()),
        vec![
            "text partial".to_owned(),
            "stalled mock".to_owned(),
            "resumed mock".to_owned()
        ]
    );
    let silent = sink.events().iter().find_map(|event| match event {
        QueryEvent::ExternalAgentStatus {
            status: rust_cli_kernel_api::orchestration::ExternalAgentStatus::Stalled { silent_ms },
            ..
        } => Some(*silent_ms),
        _ => None,
    });
    assert!(silent.is_some_and(|silent| silent >= 100), "{silent:?}");
    harness.release().await;
}

/// Rule 6: Stop closes an open row "Cancelled", committed before the interrupt marker.
#[tokio::test]
async fn stop_closes_open_rows_before_the_interrupt_marker() {
    let harness = Harness::new();
    let sink = Arc::new(RecordingSink::default());
    let abort = Abort::new();
    let running = {
        let runner = harness.runner.clone();
        let request = harness.request(vec![user("m1", "linger", UserOrigin::Human)]);
        let sink = sink.clone();
        let abort = abort.clone();
        tokio::spawn(async move { runner.run(request, sink, abort).await })
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        while !live(&sink.events())
            .iter()
            .any(|row| row.contains("running=true"))
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the row started");
    abort.abort(AbortReason::User);
    assert_eq!(
        running.await.expect("task").expect("run"),
        QueryStop::Aborted
    );
    let messages = sink.messages();
    let rows = rows(&messages);
    assert_eq!(rows.len(), 1);
    let (at, row) = &rows[0];
    assert_eq!(
        (row.name.as_str(), row.output.as_str(), row.is_error),
        ("acp:execute", "Cancelled", true)
    );
    assert_eq!(*at, messages.len() - 2);
    assert_eq!(
        texts(&messages[at + 1..]),
        vec![INTERRUPT_TEXTS[0].to_owned()]
    );
    assert!(live(&sink.events()).contains(&r#"done "Cancelled" error=true"#.to_owned()));
    harness.release().await;
}

/// Rule 7: a plan replaces the session's task list and settles at once as a `TodoWrite` row with Node's output.
#[tokio::test]
async fn a_plan_replaces_the_task_list_as_a_todo_write_row() {
    let harness = Harness::new();
    harness.plans.0.lock().unwrap().push(TaskRecord {
        id: "1".into(),
        subject: "Old step".into(),
        description: String::new(),
        active_form: None,
        owner: None,
        status: TaskStatus::Completed,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
    });
    let (_, sink) = run(&harness, "make a plan").await;
    let todos = json!([
        {"content": "Read the spec", "status": "completed", "priority": "high"},
        {"content": "Write the tests", "status": "in_progress", "priority": "medium"},
        {"content": "Ship the change", "status": "pending", "priority": "low"},
    ]);
    let rows = rows(&sink.messages());
    assert_eq!(rows.len(), 1);
    let row = &rows[0].1;
    assert_eq!(
        (row.name.as_str(), row.title.as_str(), row.is_error),
        ("TodoWrite", "Plan", false)
    );
    assert_eq!(row.input, json!({"todos": todos}));
    let output: serde_json::Value = serde_json::from_str(&row.output).unwrap();
    assert_eq!(
        output,
        json!({"oldTodos": [{"content": "Old step", "status": "completed", "priority": "medium"}],
            "todos": todos,
            "summary": {"total": 3, "pending": 1, "inProgress": 1, "completed": 1}})
    );
    // Node's key order (`JSON.stringify` of `{oldTodos, todos, summary}`).
    assert!(row.output.starts_with(
        r#"{"oldTodos":[{"content":"Old step","status":"completed","priority":"medium"}],"todos":"#
    ));
    // The turn sends no IDs: the task board numbers the plan after its high-water mark.
    let tasks = harness.plans.0.lock().unwrap().clone();
    let shape: Vec<(String, String, TaskStatus, Option<serde_json::Value>)> = tasks
        .into_iter()
        .map(|task| {
            let priority = task
                .metadata
                .and_then(|metadata| metadata.get("priority").cloned());
            (task.id, task.subject, task.status, priority)
        })
        .collect();
    assert_eq!(
        shape,
        vec![
            (
                String::new(),
                "Read the spec".into(),
                TaskStatus::Completed,
                Some(json!("high"))
            ),
            (
                String::new(),
                "Write the tests".into(),
                TaskStatus::InProgress,
                None
            ),
            (
                String::new(),
                "Ship the change".into(),
                TaskStatus::Pending,
                Some(json!("low"))
            ),
        ]
    );
    harness.release().await;
}

/// Rule 8: a `session_info_update` title goes to the session through `RunSink::external_title`.
#[tokio::test]
async fn an_agent_title_reaches_the_session() {
    let harness = Harness::new();
    let (_, sink) = run(&harness, "set a title").await;
    assert_eq!(sink.titles(), vec!["Parser fix from ACP".to_owned()]);
    harness.release().await;
}

/// Rule 6 (Node `rowFor`): a permission ask for a tool call no update named opens its `acp:other` row first, and the
/// ask names that row.
#[tokio::test]
async fn a_permission_ask_opens_its_row() {
    let harness = Harness::new();
    let (_, sink) = run(&harness, "ask permission").await;
    let events = sink.events();
    assert_eq!(live(&events)[0], r#"row acp:other "" running=false"#);
    harness.release().await;
}

/// The `ExternalAgentConfig` events of a run as (agent, the model option's current value).
fn configs(events: &[QueryEvent]) -> Vec<(String, String)> {
    events
        .iter()
        .filter_map(|event| match event {
            QueryEvent::ExternalAgentConfig { agent, options } => Some((
                agent.clone(),
                options
                    .iter()
                    .find(|option| option.id == "model")
                    .map(|option| option.current_value.clone())
                    .unwrap_or_default(),
            )),
            _ => None,
        })
        .collect()
}

fn catalog_file(harness: &Harness) -> Option<serde_json::Value> {
    let text =
        std::fs::read_to_string(harness.dir.path().join("fork_acp_agent_catalog.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Each choice is checked against the agent's options as they are after the previous answer (Node
/// `reconcileAcpSessionConfig` reads `runtime.configOptions` for every choice). Choosing mode `plan` makes this agent
/// switch the model to m2, so the stored `model=m1` is no longer current and is sent too.
#[tokio::test]
async fn a_choice_is_checked_against_the_options_after_the_previous_answer() {
    let harness = Harness::with(&["--config", "options", "--coupled-config"], None);
    let session = SessionId::new("s1");
    for (id, value) in [("mode", "plan"), ("model", "m1")] {
        harness
            .store
            .set_acp_choice(&session, "mock", id, value)
            .await
            .unwrap();
    }
    let (stop, _) = run(&harness, "hello").await;
    assert_eq!(stop, QueryStop::Completed);
    let methods = harness.methods();
    let sets: Vec<&String> = methods
        .iter()
        .filter(|method| method.starts_with("session/set_config_option"))
        .collect();
    assert_eq!(
        sets,
        [
            "session/set_config_option mode=plan",
            "session/set_config_option model=m1"
        ],
        "{methods:?}"
    );
    harness.release().await;
}

/// Stop while the agent has not answered a chosen value ends the turn at once as stopped: the pending call is
/// dropped, no later choice is sent and the agent is never prompted.
#[tokio::test]
async fn stop_during_the_config_reconcile_ends_the_turn_at_once() {
    let harness = Harness::with(&["--config", "options", "--hang-config"], None);
    let session = SessionId::new("s1");
    for (id, value) in [("mode", "plan"), ("model", "m2")] {
        harness
            .store
            .set_acp_choice(&session, "mock", id, value)
            .await
            .unwrap();
    }
    let sink = Arc::new(RecordingSink::default());
    let abort = Abort::new();
    let running = {
        let runner = harness.runner.clone();
        let request = harness.request(vec![user("m1", "hello", UserOrigin::Human)]);
        let sink = sink.clone();
        let abort = abort.clone();
        tokio::spawn(async move { runner.run(request, sink, abort).await })
    };
    while !harness.agent_got("session/set_config_option mode=plan") {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    abort.abort(AbortReason::User);
    // Far below the 30 s request timeout the pending call would otherwise wait for.
    let stop = tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .expect("the turn ended at Stop")
        .expect("task")
        .expect("run");
    assert_eq!(stop, QueryStop::Aborted);
    let methods = harness.methods();
    assert!(
        !methods
            .iter()
            .any(|method| method == "session/set_config_option model=m2"
                || method == "session/prompt"),
        "{methods:?}"
    );
    harness.release().await;
}
/// Rule 13 reconcile: the stored choices reach the agent before the prompt; a choice the agent does not offer and one
/// equal to its value are not sent. The agent's options become the display copy and an event; the catalog keeps the
/// handshake's values, not this session's.
#[tokio::test]
async fn stored_choices_reach_the_agent_before_the_prompt() {
    let harness = Harness::with(&["--config", "options"], None);
    let session = SessionId::new("s1");
    for (id, value) in [("model", "m2"), ("mode", "agent"), ("gone", "x")] {
        harness
            .store
            .set_acp_choice(&session, "mock", id, value)
            .await
            .unwrap();
    }
    let sink = Arc::new(RecordingSink::default());
    let stop = harness
        .runner
        .run(
            harness.request(vec![user("m1", "hello", UserOrigin::Human)]),
            sink.clone(),
            Abort::new(),
        )
        .await
        .expect("run");
    assert_eq!(stop, QueryStop::Completed);
    let methods = harness.methods();
    let set = methods
        .iter()
        .position(|method| method == "session/set_config_option model=m2")
        .expect("the model choice was sent");
    let prompt = methods
        .iter()
        .position(|method| method == "session/prompt")
        .expect("prompted");
    assert!(set < prompt, "{methods:?}");
    assert!(
        !methods
            .iter()
            .any(|method| method.contains("mode=") || method.contains("gone=")),
        "{methods:?}"
    );
    assert_eq!(
        configs(&sink.events()),
        [("mock".to_owned(), "m2".to_owned())]
    );
    let stored = harness.store.acp_config(&session).await.unwrap();
    let offered = rust_cli_kernel_api::external_agent_config::options_from_json(
        stored.offered.as_ref().expect("a display copy"),
    )
    .unwrap();
    assert_eq!(offered[1].current_value, "m2");
    assert_eq!(
        stored.choices.get("gone").map(String::as_str),
        Some("x"),
        "choices are kept"
    );
    let catalog = catalog_file(&harness).expect("the catalog");
    assert_eq!(catalog["agents"][0]["agentId"], "mock");
    assert_eq!(catalog["agents"][0]["options"][1]["currentValue"], "m1");
    harness.release().await;
}

/// A choice the agent refuses fails the turn with Node's text, and no prompt is sent.
#[tokio::test]
async fn a_refused_choice_fails_the_turn() {
    let harness = Harness::with(&["--config", "options", "--fail-config"], None);
    harness
        .store
        .set_acp_choice(&SessionId::new("s1"), "mock", "model", "m2")
        .await
        .unwrap();
    let sink = Arc::new(RecordingSink::default());
    let stop = harness
        .runner
        .run(
            harness.request(vec![user("m1", "hello", UserOrigin::Human)]),
            sink.clone(),
            Abort::new(),
        )
        .await
        .expect("run");
    assert!(
        matches!(&stop, QueryStop::ApiError { message } if message.starts_with("Could not set Model to Model 2: ")),
        "{stop:?}"
    );
    assert!(!harness.methods().contains(&"session/prompt".to_owned()));
    harness.release().await;
}

/// An agent-initiated change during the prompt is an event and the display copy; the choices stay as they are. The
/// next turn with the same options emits nothing.
#[tokio::test]
async fn an_agent_change_during_the_prompt_updates_the_display_copy() {
    let harness = Harness::with(&["--config", "options"], None);
    let session = SessionId::new("s1");
    let first = Arc::new(RecordingSink::default());
    harness
        .runner
        .run(
            harness.request(vec![user("m1", "switch model", UserOrigin::Human)]),
            first.clone(),
            Abort::new(),
        )
        .await
        .expect("run");
    assert_eq!(
        configs(&first.events()),
        [
            ("mock".to_owned(), "m1".to_owned()),
            ("mock".to_owned(), "m2".to_owned())
        ]
    );
    let stored = harness.store.acp_config(&session).await.unwrap();
    assert!(stored.choices.is_empty());
    assert_eq!(
        stored.offered.as_ref().unwrap()[1]["currentValue"],
        "m2",
        "the agent's value is shown"
    );
    let second = Arc::new(RecordingSink::default());
    harness
        .runner
        .run(
            harness.request(vec![user("m2", "hello", UserOrigin::Human)]),
            second.clone(),
            Abort::new(),
        )
        .await
        .expect("run");
    assert!(
        configs(&second.events()).is_empty(),
        "the same options again"
    );
    harness.release().await;
}

/// An agent without options and a session without a stored copy have nothing to show or to catalog.
#[tokio::test]
async fn an_agent_without_options_shows_nothing() {
    let harness = Harness::new();
    let sink = Arc::new(RecordingSink::default());
    harness
        .runner
        .run(
            harness.request(vec![user("m1", "hello", UserOrigin::Human)]),
            sink.clone(),
            Abort::new(),
        )
        .await
        .expect("run");
    assert!(configs(&sink.events()).is_empty());
    assert!(catalog_file(&harness).is_none());
    harness.release().await;
}
