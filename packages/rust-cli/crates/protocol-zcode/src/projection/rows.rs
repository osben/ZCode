//! 行的增量（[`Projection`] 的一部分，从 mod.rs 拆出：800 行上限）：流式正文与思考、落定的消息、工具调用行与权限询问。

use rust_cli_kernel_api::input_intent::InputIntent;
use rust_cli_kernel_api::message::{ContentBlock, Message, UserOrigin};
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::user_input::INTERRUPT_TEXTS;
use serde_json::{Value, json};

use super::{Projection, RowKind, ToolStatus, block_key, state, text_of, tool_key};

/// Fork: Node publishes the streaming input of Write and Edit at most once a second
/// (`ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS`, `isZCodeFileStreamingToolInputPreviewTool`).
const FILE_PREVIEW_INTERVAL_MS: u64 = 1_000;

/// Fork: a tool call whose input is streaming (Node `fileToolInputPreviewByCallId` for the throttled tools).
#[derive(Debug, Clone)]
pub(super) struct StreamingTool {
    tool_use: String,
    /// Write or Edit: deltas are published at most every [`FILE_PREVIEW_INTERVAL_MS`].
    throttled: bool,
    published_at: Option<u64>,
    pending: String,
}

/// A background task notification (the session's notification turns and the agents' completion notices).
pub(super) fn is_task_notification(origin: &UserOrigin) -> bool {
    matches!(origin, UserOrigin::Meta { source }
        if source == rust_cli_kernel_api::hooks::queued_command::TASK_NOTIFICATION)
}

impl Projection {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn stream(
        &mut self,
        turn: &str,
        response: u32,
        index: usize,
        delta: &BlockDelta,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let (kind, text) = match delta {
            BlockDelta::Text(text) => (RowKind::AssistantText, text),
            BlockDelta::Thinking(text) => (RowKind::Reasoning, text),
            BlockDelta::InputJson(text) => {
                self.streaming_tool_input(turn, response, index, text, now, out);
                return;
            }
            BlockDelta::Signature(_) => return,
        };
        if let Some(current) = &mut self.turn {
            current.response = Some(response);
        }
        let key = block_key(kind, turn, response, index);
        if !self.index.contains_key(&key) {
            let entity = format!("{turn}:{response}:{index}");
            let mut row = self.base(turn, &entity, kind, now, seq);
            row.insert("text".into(), json!(""));
            row.insert("state".into(), json!("streaming"));
            self.append(key.clone(), row, out);
        }
        let Some(&at) = self.index.get(&key) else {
            return;
        };
        let row = &mut self.rows[at];
        let joined = format!("{}{text}", row["text"].as_str().unwrap_or_default());
        row.insert("text".into(), json!(joined));
        let row_id = row["rowId"].clone();
        out.push(json!({"op": "row.delta", "rowId": row_id, "path": "text", "append": text}));
    }

    pub(super) fn message(&mut self, message: &Message, now: u64, seq: u64, out: &mut Vec<Value>) {
        match message {
            // 用户中断后补的那条消息只给模型看（Node 不显示）。
            Message::User(user)
                if user.origin == UserOrigin::Human
                    && !INTERRUPT_TEXTS.contains(&text_of(&user.content).as_str()) =>
            {
                let Some(turn) = self.turn.clone() else {
                    return;
                };
                let key = format!("user:{}", user.id.as_str());
                if self.index.contains_key(&key) {
                    return;
                }
                let mut row = self.base(&turn.id, user.id.as_str(), RowKind::UserInput, now, seq);
                // Fork: the typed text and the quotes come from the input intent only (Node `intent.text` and
                // `conversationQuotes`); a text that merely ends with a quote block is shown as is.
                let intent = user.intent.as_deref();
                let text = intent
                    .filter(|intent| intent.shows_intent_text())
                    .and_then(|intent| intent.text())
                    .map_or_else(|| text_of(&user.content), str::to_owned);
                if let Some(quotes) = intent.and_then(InputIntent::quotes) {
                    row.insert("conversationQuotes".into(), json!(quotes));
                }
                // B4: the structured source comes from the intent only; body text never sets it.
                if let Some(source) = intent.and_then(InputIntent::source) {
                    row.insert("source".into(), source.clone());
                }
                // Fork: rows stored before attachments were file parts kept the reminders in the model text.
                let shown = rust_cli_kernel_api::prompt_attachment::display(&text).unwrap_or(text);
                // Fork: a slash command row shows what the user typed (`/goal <objective>`), like Node.
                let shown = rust_cli_kernel_api::user_command::display(&shown).unwrap_or(shown);
                row.insert("text".into(), json!(shown));
                // Fork: chips come from the stored attachments (live and cold alike), never from the input facts.
                let chips: Vec<Value> = user
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::File { file } => {
                            Some(rust_cli_kernel_api::prompt_attachment::chip(file))
                        }
                        _ => None,
                    })
                    .collect();
                if !chips.is_empty() {
                    row.insert("attachments".into(), Value::Array(chips));
                    let sources = user
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::File { file } => Some(super::AttachmentSource {
                                mime: rust_cli_kernel_api::prompt_attachment::part_mime(file),
                                source: rust_cli_kernel_api::prompt_attachment::part_source(file),
                            }),
                            _ => None,
                        })
                        .collect();
                    self.attachment_sources
                        .insert(user.id.as_str().to_owned(), sources);
                }
                row.insert("origin".into(), json!("realUser"));
                if let Some(command) = &turn.command {
                    row.insert("sourceCommandId".into(), json!(command));
                    row.insert("rootSourceCommandId".into(), json!(command));
                    if let Some(meta) = self.inputs.get(command) {
                        if let Some(origin) = &meta.origin {
                            row.insert("inputOrigin".into(), json!(origin));
                        }
                        row.insert("clientId".into(), json!(meta.client));
                    }
                }
                self.append(key, row, out);
            }
            // Fork: a notification that opened the turn titles its header (background_result.rs).
            Message::User(user) if is_task_notification(&user.origin) => {
                let text = text_of(&user.content);
                self.remember_notified(&text);
                self.background_result(&user.content, user.stall_execution.as_deref(), out);
                self.settle_notified_tools(&text, now, out);
            }
            Message::Assistant(assistant) => {
                // Fork: the turn header sums the output tokens of every model response in the turn, like Node's
                // ModelComplete projection; a turn's last response alone undercounts a turn with tool calls.
                if let (Some(usage), Some(turn)) = (assistant.usage, self.turn.as_mut()) {
                    let tokens = *turn.output_tokens.get_or_insert(0) + usage.output_tokens;
                    turn.output_tokens = Some(tokens);
                    let key = super::turn_key(&turn.id.clone());
                    self.upsert(
                        &key,
                        |row| {
                            row.insert("outputTokens".into(), json!(tokens));
                        },
                        out,
                    );
                }
                let Some(turn) = self.turn.clone() else {
                    return;
                };
                if let Some(live) = self.turn.as_mut() {
                    live.unstopped.clear();
                }
                let response = turn.response.unwrap_or(u32::MAX);
                for (index, block) in assistant.content.iter().enumerate() {
                    match block {
                        ContentBlock::Text { text } => {
                            self.settle_block(
                                RowKind::AssistantText,
                                &turn.id,
                                response,
                                index,
                                text,
                                assistant,
                                now,
                                seq,
                                out,
                            );
                        }
                        ContentBlock::Thinking { thinking, .. } => {
                            self.settle_block(
                                RowKind::Reasoning,
                                &turn.id,
                                response,
                                index,
                                thinking,
                                assistant,
                                now,
                                seq,
                                out,
                            );
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            if !self.index.contains_key(&tool_key(id.as_str())) {
                                self.tool_row(id.as_str(), name, input, now, seq, out);
                            }
                            let message_id = assistant.id.as_str().to_owned();
                            self.upsert(
                                &tool_key(id.as_str()),
                                |row| {
                                    // Fork: the committed call finalizes a row opened while its input streamed
                                    // (Node `finalizeStreamingToolInput`); it is `running` like a row opened here.
                                    if ToolStatus::of(row) == Some(ToolStatus::InputStreaming) {
                                        row.insert("inputText".into(), json!(input.to_string()));
                                        row.insert("input".into(), input.clone());
                                        row.insert(
                                            "status".into(),
                                            json!(ToolStatus::Running.as_str()),
                                        );
                                    }
                                    row.insert("assistantResponseId".into(), json!(message_id));
                                },
                                out,
                            );
                        }
                        // 不投成行的块（P1）。
                        ContentBlock::Image { .. }
                        | ContentBlock::Video { .. }
                        | ContentBlock::RedactedThinking { .. }
                        | ContentBlock::ToolResult { .. }
                        | ContentBlock::ServerToolUse { .. }
                        | ContentBlock::WebSearchToolResult { .. }
                        | ContentBlock::File { .. } => {}
                    }
                }
                if let Some(current) = &mut self.turn {
                    current.response = None;
                }
            }
            // Fork: a steer absorbed into the running turn is a guided user row inside it (Node's drained guide row).
            Message::Attachment(attachment) => {
                // Fork: a notification absorbed at a tool boundary (`queued_command`, `task-notification` mode) records
                // the statuses and output files it reports for the detail pane. It does not settle tool rows: Node
                // applies notification blocks only to a turn they open (`onTurnStarted`).
                if attachment.source == rust_cli_kernel_api::hooks::queued_command::SOURCE
                    && attachment.data[rust_cli_kernel_api::hooks::queued_command::MODE_KEY]
                        == rust_cli_kernel_api::hooks::queued_command::TASK_NOTIFICATION
                {
                    self.remember_notified(&attachment.text);
                    return;
                }
                if attachment.source == super::markers::FORK_NOTICE_SOURCE {
                    self.fork_notice(&attachment.data, now, seq, out);
                    return;
                }
                let Some((prompt, command)) =
                    rust_cli_kernel_api::hooks::queued_command::guided(attachment)
                else {
                    return;
                };
                let Some(turn) = self.turn.clone() else {
                    return;
                };
                let key = format!("user:{}", attachment.id.as_str());
                if self.index.contains_key(&key) {
                    return;
                }
                let command = command.unwrap_or(attachment.id.as_str()).to_owned();
                let mut row = self.base(
                    &turn.id,
                    attachment.id.as_str(),
                    RowKind::UserInput,
                    now,
                    seq,
                );
                // Fork: the steer's typed text and quotes come from the intent it carries.
                let intent = rust_cli_kernel_api::hooks::queued_command::intent(attachment);
                let text = intent
                    .as_ref()
                    .filter(|intent| intent.shows_intent_text())
                    .and_then(|intent| intent.text())
                    .unwrap_or(prompt);
                row.insert("text".into(), json!(text));
                if let Some(quotes) = intent.as_ref().and_then(InputIntent::quotes) {
                    row.insert("conversationQuotes".into(), json!(quotes));
                }
                if let Some(source) = intent.as_ref().and_then(InputIntent::source) {
                    row.insert("source".into(), source.clone());
                }
                row.insert("origin".into(), json!("realUser"));
                row.insert("guided".into(), json!(true));
                row.insert("sourceCommandId".into(), json!(command));
                row.insert("rootSourceCommandId".into(), json!(command));
                if let Some(meta) = self.inputs.get(&command) {
                    if let Some(origin) = &meta.origin {
                        row.insert("inputOrigin".into(), json!(origin));
                    }
                    row.insert("clientId".into(), json!(meta.client));
                }
                self.append(key, row, out);
            }
            // 工具结果、meta 输入与中断标记（user）与 system 消息不投成行（P1）。
            Message::User(_) | Message::System(_) => {}
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn settle_block(
        &mut self,
        kind: RowKind,
        turn: &str,
        response: u32,
        index: usize,
        text: &str,
        assistant: &rust_cli_kernel_api::message::AssistantMessage,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        if text.is_empty() {
            return;
        }
        let key = block_key(kind, turn, response, index);
        if !self.index.contains_key(&key) {
            let mut row = self.base(
                turn,
                &format!("{}:{index}", assistant.id.as_str()),
                kind,
                now,
                seq,
            );
            row.insert("text".into(), json!(text));
            row.insert("state".into(), json!("streaming"));
            self.append(key.clone(), row, out);
        }
        let (message_id, model) = (assistant.id.as_str().to_owned(), assistant.model.clone());
        if assistant.stop_reason.is_none()
            && let Some(live) = self.turn.as_mut()
        {
            live.unstopped.push(key.clone());
        }
        let assistant_text = kind == RowKind::AssistantText;
        self.upsert(
            &key,
            |row| {
                row.insert("text".into(), json!(text));
                row.insert("state".into(), json!("complete"));
                row.insert("assistantResponseId".into(), json!(message_id));
                if assistant_text {
                    row.insert("model".into(), json!(model));
                }
            },
            out,
        );
    }

    pub(super) fn tool_row(
        &mut self,
        tool_use: &str,
        name: &str,
        input: &Value,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let turn = self
            .turn
            .as_ref()
            .map_or_else(|| self.session.clone(), |turn| turn.id.clone());
        let mut row = self.base(&turn, tool_use, RowKind::ToolCall, now, seq);
        row.insert("toolCallId".into(), json!(tool_use));
        row.insert("toolName".into(), json!(name));
        row.insert("status".into(), json!(ToolStatus::Running.as_str()));
        row.insert("inputText".into(), json!(input.to_string()));
        row.insert("input".into(), input.clone());
        self.append(tool_key(tool_use), row, out);
    }

    /// Fork: Node `openToolRow` (`tool_input_start`): the model started a tool call; the row shows it while the input
    /// streams (status `inputStreaming`, empty `inputText`). A call that already has a row keeps it.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn streaming_tool_row(
        &mut self,
        turn: &str,
        response: u32,
        index: usize,
        tool_use: &str,
        name: &str,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let key = tool_key(tool_use);
        if self.index.contains_key(&key) {
            return;
        }
        if let Some(current) = &mut self.turn {
            current.response = Some(response);
        }
        let throttled = matches!(name.trim().to_lowercase().as_str(), "write" | "edit");
        // Blocks of earlier turns are settled.
        self.streaming_tools.retain(|(at, _, _), _| at == turn);
        self.streaming_tools.insert(
            (turn.to_owned(), response, index),
            StreamingTool {
                tool_use: tool_use.to_owned(),
                throttled,
                published_at: None,
                pending: String::new(),
            },
        );
        let mut row = self.base(turn, tool_use, RowKind::ToolCall, now, seq);
        row.insert("toolCallId".into(), json!(tool_use));
        row.insert("toolName".into(), json!(name));
        row.insert("status".into(), json!(ToolStatus::InputStreaming.as_str()));
        row.insert("inputText".into(), json!(""));
        self.append(key, row, out);
    }

    /// Fork: Node `appendStreamingToolInput`: an input delta of a streaming tool call, while its row has no final
    /// input yet. Write and Edit publish at most once per [`FILE_PREVIEW_INTERVAL_MS`]; the rest waits for the next
    /// publication or for the committed call, which sets the whole input.
    fn streaming_tool_input(
        &mut self,
        turn: &str,
        response: u32,
        index: usize,
        text: &str,
        now: u64,
        out: &mut Vec<Value>,
    ) {
        let Some(streaming) = self
            .streaming_tools
            .get_mut(&(turn.to_owned(), response, index))
        else {
            return;
        };
        let Some(&at) = self.index.get(&tool_key(&streaming.tool_use)) else {
            return;
        };
        let row = &mut self.rows[at];
        if ToolStatus::of(row) != Some(ToolStatus::InputStreaming) || row.contains_key("input") {
            return;
        }
        let text = if streaming.throttled {
            streaming.pending.push_str(text);
            if streaming
                .published_at
                .is_some_and(|at| now.saturating_sub(at) < FILE_PREVIEW_INTERVAL_MS)
            {
                return;
            }
            streaming.published_at = Some(now);
            std::mem::take(&mut streaming.pending)
        } else {
            text.to_owned()
        };
        let joined = format!("{}{text}", row["inputText"].as_str().unwrap_or_default());
        row.insert("inputText".into(), json!(joined));
        let row_id = row["rowId"].clone();
        out.push(json!({"op": "row.delta", "rowId": row_id, "path": "inputText", "append": text}));
    }

    /// 登记一个询问。返回它所属的工具调用。
    /// Fork: questions and plan approvals are `userInput` interactions (projection/elicitation.rs).
    pub(super) fn ask(
        &mut self,
        interaction: &str,
        request: &InteractionRequest,
        now: u64,
    ) -> Option<String> {
        let tool_use = request.tool_use().as_str().to_owned();
        let anchor = self.row_id(&tool_key(&tool_use));
        let pending = match request {
            InteractionRequest::Permission {
                tool,
                input,
                message,
                once,
                independent,
                origin,
                ..
            } => {
                let mut payload = json!({
                    "kind": "permission",
                    "toolCallId": tool_use,
                    "toolName": tool,
                    "summary": message,
                    "detail": input,
                    "freeText": true,
                    "options": if *once || *independent {
                        // Node `approvalMode: "user-once"` and `optionsPolicy: "no-always-allow"`: only allow once /
                        // deny.
                        state::single_use_permission_options()
                    } else {
                        state::permission_options()
                    },
                });
                // Fork (B3, Node `product-projection.ts`): only the session's own ask that is no independent
                // confirmation offers a permission mode switch. A once-ask (guarded already) can only switch to full
                // access; any other offers guarded or full access, with the full access option for older clients.
                if origin.is_none() && !*independent {
                    if *once {
                        payload["modeSwitch"] = json!("fullAccessOnly");
                    } else {
                        payload["modeSwitch"] = json!("choose");
                        payload["fullAccessOption"] = state::full_access_option();
                    }
                }
                json!({
                    "interactionId": interaction,
                    "kind": "permission",
                    "anchorRowId": anchor,
                    "createdAt": now,
                    "payload": payload,
                })
            }
            InteractionRequest::Question { questions, .. } => {
                super::elicitation::question(interaction, anchor, now, &tool_use, questions)
            }
            InteractionRequest::PlanApproval { plan, .. } => {
                super::elicitation::plan_approval(interaction, anchor, now, &tool_use, plan)
            }
        };
        let mut pending = pending;
        if let Some(origin) = request.origin() {
            pending["payload"]["origin"] = ask_origin(origin);
        }
        self.pending.push(pending);
        Some(tool_use)
    }
}

/// Fork: the subagent a delegated ask came from (Node `buildSubagentInteractionOrigin`).
fn ask_origin(origin: &rust_cli_kernel_api::orchestration::AskOrigin) -> Value {
    let mut value = json!({
        "kind": "subagent",
        "agentId": origin.agent.as_str(),
        "agentType": origin.agent_type,
        "childSessionId": origin.child_session.as_str(),
        "description": origin.description,
        "parentSessionId": origin.parent_session.as_str(),
    });
    if let Some(tool_use) = &origin.parent_tool_use {
        value["parentToolCallId"] = json!(tool_use.as_str());
    }
    value
}
