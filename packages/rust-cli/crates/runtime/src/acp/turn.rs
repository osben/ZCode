//! One ACP turn (Node `acp-external-agent-host.ts` `runTurn` and core `external-agent-turn.ts`): read the agent
//! record, acquire the session's runtime, prompt it with the newest human input, stream its message and thought
//! chunks, and commit them as assistant messages. Stop is a bounded `session/cancel`.

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use futures_util::stream::{FuturesUnordered, StreamExt as _};
use rust_cli_acp::registry::{display_name, is_auth_failure, login_command};
use rust_cli_acp::{
    AcpError, AcpErrorCode, AcpLaunch, PermissionAnswer, PermissionAsk, PromptResponse,
    RuntimeEvent,
};
use rust_cli_acp::{PlanEntry, ToolCallInfo};
use rust_cli_kernel_api::abort::{Abort, AbortReason};
use rust_cli_kernel_api::agents::{TaskRecord, TaskStatus};
use rust_cli_kernel_api::ids::{SessionId, ToolUseId};
use rust_cli_kernel_api::interaction::{Answer, PermissionAnswer as UserAnswer};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, ExternalTool, ImageSource, Message, StopReason,
    ToolResultContent, Usage, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::orchestration::{
    InteractionRequest, QueryError, QueryEvent, QueryRequest, QueryStop, RunSink,
};
use rust_cli_kernel_api::tool::ToolOutput;
use rust_cli_kernel_api::user_input::INTERRUPT_TEXTS;
use serde_json::{Value, json};

use super::AcpHost;

pub(super) async fn run(
    host: &Arc<AcpHost>,
    agent_id: String,
    request: QueryRequest,
    sink: Arc<dyn RunSink>,
    abort: Abort,
) -> Result<QueryStop, QueryError> {
    // The prompt hook messages are committed first, as in the query loop.
    if !request.prompt_hook_messages.is_empty() {
        sink.commit_messages(request.prompt_hook_messages.clone())
            .await?;
    }
    let mut turn = Turn {
        host,
        sink,
        session: request.session.clone(),
        model: request.selection.model.clone(),
        response: 0,
        segment: Vec::new(),
        rows: HashMap::new(),
        open: Vec::new(),
        halt: abort.token().child_token(),
        failed: None,
    };
    let launch = match read_launch(host, &agent_id, &request).await {
        Ok(launch) => launch,
        Err(message) => return Ok(QueryStop::ApiError { message }),
    };
    if abort.is_aborted() {
        return turn.aborted(&abort).await;
    }
    // Node: "Stop can arrive at any await of the spawn".
    let acquiring = host.acquire(request.session.clone(), launch);
    let acquired = tokio::select! {
        biased;
        () = abort.token().cancelled() => return turn.aborted(&abort).await,
        acquired = AcpHost::acquired(acquiring) => acquired,
    };
    let runtime = match acquired {
        Ok(runtime) => runtime,
        Err(_) if abort.is_aborted() => return turn.aborted(&abort).await,
        Err(error) => {
            tracing::warn!(event = "acp.start_failed", agent = %agent_id, error = %error.message, "ACP agent could not be started");
            return Ok(QueryStop::ApiError {
                message: start_failure(&agent_id, &error),
            });
        }
    };
    // The session start is read once; the context-reset divider follows with the session events (S5).
    let _ = runtime.take_session_start();
    if abort.is_aborted() {
        return turn.aborted(&abort).await;
    }
    let (mut events, guard) = runtime.bind();
    let prompt = runtime.prompt(prompt_blocks(&request.messages));
    tokio::pin!(prompt);
    // Stop, or a lost segment commit, is a bounded `session/cancel`; the prompt then settles. This future never
    // completes.
    let halt = turn.halt.clone();
    let canceller = runtime.clone();
    let cancelling = {
        let halt = halt.clone();
        async move {
            halt.cancelled().await;
            canceller.cancel().await;
            std::future::pending::<()>().await;
        }
    };
    tokio::pin!(cancelling);
    // Permission asks wait for the user beside the event stream; a stop drops them (the agent hears `cancelled`).
    let mut asks: FuturesUnordered<BoxFuture<'static, ()>> = FuturesUnordered::new();
    let mut halted = false;
    let outcome = loop {
        tokio::select! {
            biased;
            // The halt branches come first so a flood of agent updates cannot starve Stop. After the first fire the
            // withdraw branch is armed only by an ask the agent sends after Stop, withdrawn before its dialog opens.
            () = halt.cancelled(), if !halted || !asks.is_empty() => {
                halted = true;
                turn.withdraw_asks(&mut asks).await;
            }
            () = &mut cancelling => {}
            Some(event) = events.recv() => {
                if let Some(ask) = turn.on_event(event).await {
                    asks.push(ask);
                }
            }
            Some(()) = asks.next(), if !asks.is_empty() => {}
            outcome = &mut prompt => break outcome,
        }
    };
    // Updates the agent sent before its answer are already queued; later ones belong to no turn.
    for _ in 0..events.len() {
        let Ok(event) = events.try_recv() else { break };
        if let Some(ask) = turn.on_event(event).await {
            asks.push(ask);
        }
    }
    turn.withdraw_asks(&mut asks).await;
    drop(guard);
    // A lost segment or row, or a failed plan write, fails the turn like a failed commit in the query loop. The open
    // rows settle on screen; nothing more is written.
    if let Some(error) = turn.failed.take() {
        turn.settle_open_live(ENDED_FAILED).await;
        return Err(error);
    }
    match outcome {
        // Node `external-agent-turn.ts`: after Stop the turn ends interrupted whatever the agent answered.
        _ if abort.is_aborted() => {
            turn.end(outcome.as_ref().ok().and_then(usage_of), CANCELLED)
                .await?;
            turn.aborted(&abort).await
        }
        Ok(response) => {
            turn.end(usage_of(&response), ENDED_OPEN).await?;
            Ok(QueryStop::Completed)
        }
        Err(error) => {
            turn.end(None, ENDED_FAILED).await?;
            tracing::warn!(event = "acp.prompt_failed", agent = %agent_id, error = %error.message, "ACP agent turn failed");
            Ok(QueryStop::ApiError {
                message: prompt_failure(&agent_id, &error),
            })
        }
    }
}

/// Node `readEnabledLaunch`.
async fn read_launch(
    host: &AcpHost,
    agent_id: &str,
    request: &QueryRequest,
) -> Result<AcpLaunch, String> {
    let label = display_name(agent_id);
    let Some(record) = host.records.find(agent_id).await else {
        return Err(format!(
            "{label} is no longer configured. Enable it again in Settings > Model Providers."
        ));
    };
    if !record.enabled {
        return Err(format!(
            "{label} is turned off. Enable it in Settings > Model Providers to continue."
        ));
    }
    Ok(AcpLaunch {
        agent_id: agent_id.to_owned(),
        command: record.command,
        args: record.args,
        env: record.env,
        cwd: request.workspace.root.as_str().to_owned(),
    })
}

/// Node `toStartFailure`.
fn start_failure(agent_id: &str, error: &AcpError) -> String {
    if is_auth_failure(&error.message) {
        return auth_required(agent_id);
    }
    format!(
        "{} could not be started. Check that it is installed and that its launch settings are correct.",
        display_name(agent_id)
    )
}

/// Node `toPromptFailure`.
fn prompt_failure(agent_id: &str, error: &AcpError) -> String {
    if is_auth_failure(&error.message) {
        return auth_required(agent_id);
    }
    if matches!(
        error.code,
        AcpErrorCode::AgentDied | AcpErrorCode::StreamClosed
    ) {
        return format!(
            "{} stopped during the turn. Send the message again to restart it.",
            display_name(agent_id)
        );
    }
    format!(
        "{} could not complete the turn: {}",
        display_name(agent_id),
        error.message
    )
}

fn auth_required(agent_id: &str) -> String {
    format!(
        "{} requires sign-in. Run \"{}\" in a terminal, then send your message again.",
        display_name(agent_id),
        login_command(agent_id)
    )
}

/// Node `buildExternalAgentPrompt`: the newest human input's text and its images, as ACP content blocks.
fn prompt_blocks(messages: &[Message]) -> Vec<Value> {
    let input = messages.iter().rev().find_map(|message| match message {
        Message::User(user) if user.origin == UserOrigin::Human && !is_interrupt(user) => {
            Some(user)
        }
        _ => None,
    });
    let Some(input) = input else {
        return vec![json!({"type": "text", "text": ""})];
    };
    let text = input
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut blocks = vec![json!({"type": "text", "text": text})];
    blocks.extend(input.content.iter().filter_map(|block| match block {
        ContentBlock::Image {
            source: ImageSource::Base64 { media_type, data },
            ..
        } => Some(json!({"type": "image", "mimeType": media_type, "data": data})),
        _ => None,
    }));
    blocks
}

fn is_interrupt(user: &UserMessage) -> bool {
    matches!(user.content.as_slice(), [ContentBlock::Text { text }] if INTERRUPT_TEXTS.contains(&text.as_str()))
}

/// Node `toModelUsage`, folded into the stored usage (reasoning and totals have no field there).
fn usage_of(response: &PromptResponse) -> Option<Usage> {
    let usage = response.usage.as_ref()?.as_object()?;
    let count = |key: &str| usage.get(key).and_then(Value::as_u64);
    let keys = [
        "inputTokens",
        "outputTokens",
        "cachedReadTokens",
        "cachedWriteTokens",
    ];
    if keys.iter().all(|key| count(key).is_none()) {
        return None;
    }
    Some(Usage {
        input_tokens: count("inputTokens").unwrap_or_default(),
        output_tokens: count("outputTokens").unwrap_or_default(),
        cache_creation_input_tokens: count("cachedWriteTokens").unwrap_or_default(),
        cache_read_input_tokens: count("cachedReadTokens").unwrap_or_default(),
    })
}

/// Node `closeOpen` reasons for rows still open at the turn end.
const CANCELLED: &str = "Cancelled";
const ENDED_FAILED: &str = "The agent turn failed before this tool finished";
const ENDED_OPEN: &str = "The agent turn ended before this tool finished";

/// Node `EXTERNAL_AGENT_TOOL_OUTPUT_MAX_CHARS` (a JS string length: UTF-16 units) and its marker.
const OUTPUT_MAX_UNITS: usize = 32 * 1024;
const TRUNCATION_MARKER: &str = "\n… [truncated]";

/// Node `capToolOutput`, never splitting a character.
fn cap_output(text: String) -> String {
    let mut units = 0;
    for (at, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > OUTPUT_MAX_UNITS {
            return format!("{}{TRUNCATION_MARKER}", &text[..at]);
        }
    }
    text
}

/// Node `toInput`: an object as is, `null` or missing as `{}`, anything else as `{value}`.
fn to_input(raw: Option<&Value>) -> Value {
    match raw {
        None | Some(Value::Null) => json!({}),
        Some(object @ Value::Object(_)) => object.clone(),
        Some(other) => json!({"value": other}),
    }
}

/// Node `toTodoItem`.
fn todo_item(entry: &PlanEntry) -> Value {
    let content = entry.content.trim();
    let status = match entry.status.as_str() {
        status @ ("pending" | "in_progress" | "completed") => status,
        _ => "pending",
    };
    let priority = match entry.priority.as_str() {
        priority @ ("high" | "medium" | "low") => priority,
        _ => "medium",
    };
    json!({
        "content": if content.is_empty() { "Untitled step" } else { content },
        "status": status,
        "priority": priority,
    })
}

/// A todo as a Task v2 task (node-store `task_lists`: the `medium` priority is the placeholder, kept as no metadata).
fn task_of(index: usize, todo: &Value) -> TaskRecord {
    let text = |key: &str| todo[key].as_str().unwrap_or_default().to_owned();
    let priority = text("priority");
    TaskRecord {
        id: (index + 1).to_string(),
        subject: text("content"),
        description: String::new(),
        active_form: None,
        owner: None,
        status: match todo["status"].as_str() {
            Some("in_progress") => TaskStatus::InProgress,
            Some("completed") => TaskStatus::Completed,
            _ => TaskStatus::Pending,
        },
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: (priority != "medium")
            .then(|| serde_json::Map::from_iter([("priority".to_owned(), json!(priority))])),
    }
}

/// A task as Node's stored todo (`readTodos`).
fn todo_of(task: &TaskRecord) -> Value {
    let priority = task
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("priority"))
        .and_then(Value::as_str)
        .filter(|priority| ["high", "medium", "low"].contains(priority))
        .unwrap_or("medium");
    json!({"content": task.subject, "status": task.status.as_str(), "priority": priority})
}

/// Node `summarizeTodos`.
fn summarize(todos: &[Value]) -> Value {
    let count = |status: &str| todos.iter().filter(|todo| todo["status"] == status).count();
    json!({
        "total": todos.len(),
        "pending": count("pending"),
        "inProgress": count("in_progress"),
        "completed": count("completed"),
    })
}

/// One ACP tool or plan row of the turn (Node `ToolRow`).
struct Row {
    id: ToolUseId,
    /// `acp:<kind|other>` at first sight, or `TodoWrite`; never changes.
    name: String,
    title: String,
    input: Value,
    started: bool,
    finished: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Thinking,
}

/// The turn's open segment and the response counter of the live rows.
struct Turn<'a> {
    host: &'a AcpHost,
    sink: Arc<dyn RunSink>,
    session: SessionId,
    model: String,
    /// The live rows of the open segment are keyed by this response number (the projection settles them by it).
    response: usize,
    /// Text and reasoning since the last tool or plan event, one block per kind in order of first appearance.
    segment: Vec<(Kind, String)>,
    /// ACP `toolCallId` → its row, opened on first sight (rows and asks share its id).
    rows: HashMap<String, Row>,
    /// The rows not settled yet, by ACP `toolCallId`, in the order they opened.
    open: Vec<String>,
    /// Stop or a lost segment: cancels the prompt and withdraws the asks.
    halt: tokio_util::sync::CancellationToken,
    /// The first commit or plan write that failed mid-turn; nothing is written after it.
    failed: Option<QueryError>,
}

impl Turn<'_> {
    /// Applies one agent event; a permission ask comes back as the future that waits for the user.
    async fn on_event(&mut self, event: RuntimeEvent) -> Option<BoxFuture<'static, ()>> {
        match event {
            RuntimeEvent::MessageChunk(text) => self.chunk(Kind::Text, text).await,
            RuntimeEvent::ThoughtChunk(text) => self.chunk(Kind::Thinking, text).await,
            RuntimeEvent::ToolCall(info) | RuntimeEvent::ToolCallUpdate(info) => {
                self.close_segment_logged().await;
                self.tool_update(info).await;
            }
            RuntimeEvent::Plan(entries) => {
                self.close_segment_logged().await;
                self.plan(&entries).await;
            }
            RuntimeEvent::Permission { ask, reply } => {
                let row = self.ask_row(&ask.tool_call_id).await;
                return Some(self.permission(row, ask, reply));
            }
            RuntimeEvent::SessionTitle(title) => self.sink.external_title(title).await,
            RuntimeEvent::AvailableCommands(count) => {
                tracing::debug!(
                    event = "acp.commands",
                    count,
                    "ACP agent advertised commands"
                );
            }
            RuntimeEvent::Stalled { silent_ms } => {
                tracing::warn!(
                    event = "acp.stalled",
                    silent_ms,
                    "ACP agent produced no output for a while"
                );
            }
            RuntimeEvent::ConfigOptions(_) | RuntimeEvent::Resumed => {}
        }
        None
    }

    /// A tool or plan event closes the open text segment, so a row's message always follows the text before it. A
    /// failed commit halts the turn, which then fails with that error.
    async fn close_segment_logged(&mut self) {
        if self.failed.is_some() {
            self.segment.clear();
            return;
        }
        if let Err(error) = self.close_segment(None).await {
            tracing::warn!(event = "acp.segment_commit_failed", %error, "ACP text segment could not be committed");
            self.fail(error);
        }
    }

    fn fail(&mut self, error: QueryError) {
        if self.failed.is_none() {
            self.failed = Some(error);
        }
        self.halt.cancel();
    }

    /// Opens the row of an ACP tool call on first sight (Node `#createRow` + `#schedule`): its name is fixed from the
    /// kind it first came with. A known row is left as it is; `false` then. The caller shows the row.
    fn open_row(
        &mut self,
        tool_call_id: &str,
        name: Option<String>,
        title: String,
        input: Value,
    ) -> bool {
        if self.rows.contains_key(tool_call_id) {
            return false;
        }
        let row = Row {
            id: ToolUseId::new(format!("acp_{}", self.host.ids.execution())),
            name: name.unwrap_or_else(|| "acp:other".to_owned()),
            title,
            input,
            started: false,
            finished: false,
        };
        self.rows.insert(tool_call_id.to_owned(), row);
        self.open.push(tool_call_id.to_owned());
        true
    }

    /// Node `rowFor`: the row an ask anchors to, opened (`acp:other`, not started) when no update named it yet.
    async fn ask_row(&mut self, tool_call_id: &str) -> (ToolUseId, String) {
        if self.open_row(tool_call_id, None, String::new(), json!({})) {
            self.show(tool_call_id).await;
        }
        let row = &self.rows[tool_call_id];
        (row.id.clone(), row.name.clone())
    }

    /// The live row as it is now (`QueryEvent::ExternalToolRow`).
    async fn show(&self, tool_call_id: &str) {
        let Some(row) = self.rows.get(tool_call_id) else {
            return;
        };
        let _ = self
            .sink
            .emit(QueryEvent::ExternalToolRow {
                tool_use: row.id.clone(),
                name: row.name.clone(),
                title: row.title.clone(),
                input: row.input.clone(),
                running: row.started,
            })
            .await;
    }

    /// Node `ExternalAgentToolRows.apply`: a blank title keeps the last one, `rawInput` replaces the input, and a
    /// `completed` / `failed` status settles the row. An update after it settled is ignored. Each update shows the
    /// row once, so a first sight that is already running opens as running (Node's `Scheduled` + `Started`).
    async fn tool_update(&mut self, info: ToolCallInfo) {
        if !self.rows.contains_key(&info.tool_call_id) {
            let name = format!("acp:{}", info.kind.as_deref().unwrap_or("other"));
            let title = info.display_title().unwrap_or_default().to_owned();
            self.open_row(
                &info.tool_call_id,
                Some(name),
                title,
                to_input(info.input()),
            );
        }
        let Some(row) = self.rows.get_mut(&info.tool_call_id) else {
            return;
        };
        if row.finished {
            return;
        }
        if let Some(title) = info.display_title() {
            title.clone_into(&mut row.title);
        }
        if info.input().is_some() {
            row.input = to_input(info.input());
        }
        let status = info.known_status();
        if matches!(status, Some("in_progress" | "completed" | "failed")) {
            row.started = true;
        }
        self.show(&info.tool_call_id).await;
        match status {
            Some("completed") => {
                self.finish(&info.tool_call_id, false, info.output_text())
                    .await;
            }
            Some("failed") => {
                self.finish(&info.tool_call_id, true, info.output_text())
                    .await;
            }
            _ => {}
        }
    }

    /// Node `applyPlan`: a `TodoWrite` row whose todos replace the session task list; it settles at once with the
    /// old and new todos. A failed write fails the turn.
    async fn plan(&mut self, entries: &[PlanEntry]) {
        if self.failed.is_some() {
            return;
        }
        let todos: Vec<Value> = entries.iter().map(todo_item).collect();
        let key = format!("plan:{}", self.host.ids.execution());
        self.open_row(
            &key,
            Some("TodoWrite".to_owned()),
            "Plan".to_owned(),
            json!({"todos": todos}),
        );
        if let Some(row) = self.rows.get_mut(&key) {
            row.started = true;
        }
        self.show(&key).await;
        let tasks = todos
            .iter()
            .enumerate()
            .map(|(at, todo)| task_of(at, todo))
            .collect();
        let old = match self.host.plans.replace(&self.session, tasks).await {
            Ok(old) => old,
            Err(error) => {
                tracing::warn!(event = "acp.plan_write_failed", %error, "the ACP agent plan could not be stored");
                self.fail(QueryError::Store(error));
                return;
            }
        };
        let old: Vec<Value> = old.iter().map(todo_of).collect();
        let summary = summarize(&todos);
        let output = rust_cli_base::js::json::stringify(
            &json!({"oldTodos": old, "todos": todos, "summary": summary}),
        );
        self.finish(&key, false, Some(output)).await;
    }

    /// Node `#finish`: the row settles live (`ToolFinished`) and is committed as an assistant message of its own. The
    /// output is capped; a failure without text says the tool failed.
    async fn finish(&mut self, key: &str, is_error: bool, text: Option<String>) {
        let Some(block) = self.settle(key, is_error, text).await else {
            return;
        };
        if let Err(error) = self.commit_rows(vec![block], None).await {
            tracing::warn!(event = "acp.row_commit_failed", %error, "ACP tool row could not be committed");
            self.fail(error);
        }
    }

    /// Settles a row live and gives its committed block; `None` for a settled or unknown row.
    async fn settle(
        &mut self,
        key: &str,
        is_error: bool,
        text: Option<String>,
    ) -> Option<ContentBlock> {
        let row = self.rows.get_mut(key).filter(|row| !row.finished)?;
        row.finished = true;
        row.started = true;
        self.open.retain(|open| open != key);
        let mut output = cap_output(text.unwrap_or_default());
        if is_error && output.is_empty() {
            output = format!("{} failed", row.name);
        }
        let block = ExternalTool {
            id: row.id.clone(),
            name: row.name.clone(),
            title: row.title.clone(),
            input: row.input.clone(),
            output: output.clone(),
            is_error,
        };
        let _ = self
            .sink
            .emit(QueryEvent::ToolFinished {
                tool_use: block.id.clone(),
                output: ToolOutput {
                    content: vec![ToolResultContent::Text { text: output }],
                    is_error,
                    display: Value::Null,
                },
            })
            .await;
        Some(ContentBlock::ExternalTool(Box::new(block)))
    }

    /// Commits settled rows as one assistant message (nothing after a failed write).
    async fn commit_rows(
        &mut self,
        rows: Vec<ContentBlock>,
        usage: Option<Usage>,
    ) -> Result<(), QueryError> {
        if self.failed.is_some() {
            return Ok(());
        }
        let message = Message::Assistant(AssistantMessage {
            id: self.host.ids.message(),
            content: rows,
            model: self.model.clone(),
            stop_reason: Some(StopReason::EndTurn),
            usage,
        });
        self.sink.commit_message(message).await?;
        Ok(())
    }

    /// The turn end: the last segment, then the rows still open closed as errors with `reason` (Node `closeOpen`), in
    /// one message. The usage rides on the last segment, else on the closed rows, else on an empty reply.
    async fn end(&mut self, usage: Option<Usage>, reason: &str) -> Result<(), QueryError> {
        let usage = if self.segment.is_empty() {
            usage
        } else {
            self.close_segment(usage).await?;
            None
        };
        let mut closed = Vec::new();
        for key in std::mem::take(&mut self.open) {
            closed.extend(self.settle(&key, true, Some(reason.to_owned())).await);
        }
        if !closed.is_empty() {
            return self.commit_rows(closed, usage).await;
        }
        if usage.is_some() {
            return self.commit_rows(Vec::new(), usage).await;
        }
        Ok(())
    }

    /// A failing turn settles its open rows on screen only.
    async fn settle_open_live(&mut self, reason: &str) {
        for key in std::mem::take(&mut self.open) {
            let _ = self.settle(&key, true, Some(reason.to_owned())).await;
        }
    }

    /// Node `answerExternalAgentPermission`: a user-once ask (no mode or rule answers it). Allow selects the agent's
    /// `allow_once` option and deny its `reject_once`; an ask nobody answers is `cancelled`.
    fn permission(
        &mut self,
        (tool_use, tool): (ToolUseId, String),
        ask: PermissionAsk,
        reply: tokio::sync::oneshot::Sender<PermissionAnswer>,
    ) -> BoxFuture<'static, ()> {
        let message = if ask.title.trim().is_empty() {
            format!("{tool} needs your approval")
        } else {
            ask.title.clone()
        };
        let mut input = json!({"title": ask.title});
        if let Some(detail) = &ask.detail {
            input["detail"] = json!(detail);
        }
        let request = InteractionRequest::Permission {
            tool_use,
            tool,
            input,
            message,
            suggestions: Vec::new(),
            rule_seed: None,
            asked_by: None,
            machine: Default::default(),
            once: true,
            independent: false,
            origin: None,
        };
        let sink = self.sink.clone();
        Box::pin(async move {
            let answer = match sink.ask(request).await {
                Ok(answer) => match answer.answer {
                    Answer::Permission(UserAnswer::Allow { .. }) => PermissionAnswer::Selected {
                        kind: "allow_once".to_owned(),
                    },
                    Answer::Permission(UserAnswer::Deny { .. }) => PermissionAnswer::Selected {
                        kind: "reject_once".to_owned(),
                    },
                    _ => PermissionAnswer::Cancelled,
                },
                Err(_) => PermissionAnswer::Cancelled,
            };
            let _ = reply.send(answer);
        })
    }

    /// Drops the asks still waiting (their agent requests answer `cancelled`) and closes their dialogs.
    async fn withdraw_asks(&mut self, asks: &mut FuturesUnordered<BoxFuture<'static, ()>>) {
        if asks.is_empty() {
            return;
        }
        asks.clear();
        for row in self.rows.values() {
            self.sink.cancel_ask(&row.id).await;
        }
    }

    async fn chunk(&mut self, kind: Kind, text: String) {
        if text.is_empty() {
            return;
        }
        let index = match self.segment.iter().position(|(open, _)| *open == kind) {
            Some(index) => index,
            None => {
                self.segment.push((kind, String::new()));
                self.segment.len() - 1
            }
        };
        self.segment[index].1.push_str(&text);
        let delta = match kind {
            Kind::Text => BlockDelta::Text(text),
            Kind::Thinking => BlockDelta::Thinking(text),
        };
        let _ = self
            .sink
            .emit(QueryEvent::Delta {
                message: self.response,
                index,
                delta,
            })
            .await;
    }

    /// Commits the open segment as one assistant message; the next segment streams under a new response number.
    async fn close_segment(&mut self, usage: Option<Usage>) -> Result<(), QueryError> {
        if self.segment.is_empty() {
            return Ok(());
        }
        let content = std::mem::take(&mut self.segment)
            .into_iter()
            .map(|(kind, text)| match kind {
                Kind::Text => ContentBlock::Text { text },
                Kind::Thinking => ContentBlock::Thinking {
                    thinking: text,
                    signature: None,
                },
            })
            .collect();
        let message = Message::Assistant(AssistantMessage {
            id: self.host.ids.message(),
            content,
            model: self.model.clone(),
            stop_reason: Some(StopReason::EndTurn),
            usage,
        });
        self.sink.commit_message(message).await?;
        self.response += 1;
        Ok(())
    }

    /// The interrupt marker the query loop writes on a user stop (not for a submit or shutdown).
    async fn aborted(&mut self, abort: &Abort) -> Result<QueryStop, QueryError> {
        if !matches!(
            abort.reason(),
            Some(AbortReason::Submit | AbortReason::Shutdown)
        ) {
            let marker = Message::User(UserMessage {
                stall_execution: None,
                intent: None,
                id: self.host.ids.message(),
                content: vec![ContentBlock::Text {
                    text: INTERRUPT_TEXTS[0].to_owned(),
                }],
                origin: UserOrigin::Human,
            });
            self.sink.commit_message(marker).await?;
        }
        Ok(QueryStop::Aborted)
    }
}

#[cfg(test)]
#[path = "turn_tests.rs"]
mod tests;
