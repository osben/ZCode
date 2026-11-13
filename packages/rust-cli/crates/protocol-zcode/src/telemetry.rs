//! Fork: the App's conversation telemetry facts (Node `conversation-telemetry-facts.ts`
//! `ConversationTelemetryFactNormalizer`; specs/fork-rust-agent-parity.md, "Conversation telemetry facts").
//!
//! One [`Telemetry`] per open session turns the kernel's live events into `v4/telemetry/event` facts. The Host
//! validates them with a strict schema, so every fact carries only the schema's fields: an extra field drops it.
//! The kernel has no per-request model events, so `model.request.status` is synthesized per model response (the
//! first stream delta starts it, the stored assistant message completes it).

use std::collections::{HashMap, HashSet};

use rust_cli_kernel_api::hooks::queued_command;
use rust_cli_kernel_api::message::{ContentBlock, Message, ToolResultContent, UserOrigin};
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::session_api::{KernelEvent, TurnOutcome};
use rust_cli_kernel_api::tool_names;
use serde_json::{Map, Value, json};

/// The notification method (Node `V4_NOTIFICATIONS.conversationTelemetryFact`).
pub const FACT: &str = "v4/telemetry/event";

/// Whose facts these are: the open session itself, or a subagent child read through the parent's feed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Main,
    Child,
}

/// The model identity a request fact carries (Node `CompletedModelRequestIdentity`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Provider {
    pub provider: String,
    pub model: String,
    pub kind: Option<String>,
    pub host: Option<String>,
}

/// A subagent row of the projection, as the `subagent.lifecycle` facts need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentLink {
    pub agent: String,
    pub agent_type: Option<String>,
    pub child: String,
    pub parent_tool: String,
    pub background: bool,
    /// The row status (`running`, `success`, `failed`, `cancelled`).
    pub status: String,
    pub turn: Option<String>,
}

/// What a fact needs from its event besides the event itself.
pub struct Observed<'a> {
    /// Keeps event IDs of facts that come from outside the kernel event stream (the subagent table) apart from
    /// those of kernel events with the same number; empty for kernel events, `"{turnId}-"` for a child run's
    /// events (a child's runs restart their numbering).
    pub scope: &'a str,
    pub seq: u64,
    pub now: u64,
    pub provider: &'a Provider,
    /// Fork: the `automationId` the Host sent with the input a `TurnStarted { command }` opens (sendText, remembered
    /// with the input by the projection); None for every other event.
    pub automation: Option<&'a str>,
}

#[derive(Debug, Default)]
struct Request {
    response: u32,
    id: String,
    started_at: u64,
    channels: HashSet<&'static str>,
}

#[derive(Debug, Default)]
struct Turn {
    id: String,
    command: String,
    started_at: u64,
    /// A turn opened without a command: `turn.started` waits for its first message to learn the wake source.
    held: Option<(u64, u64)>,
    background_source: Option<String>,
    /// The automation that dispatched the turn's input (main turns opened by a command only).
    automation: Option<String>,
    /// A background subagent's notification reached the model in this turn (a wake, or merged into the running turn).
    consumed_subagent: bool,
    request: Option<Request>,
    tokens: u64,
    tool_calls: u32,
}

#[derive(Debug, Default)]
struct Tool {
    name: String,
    started_at: Option<u64>,
}

pub struct Telemetry {
    session: String,
    role: Role,
    turn: Option<Turn>,
    tools: HashMap<String, Tool>,
    /// The subagent statuses already reported, by agent, with the turn of the last `spawned`.
    subagents: HashMap<String, (String, Option<String>)>,
    /// Facts per kernel seq, for distinct event IDs when one event yields several facts.
    emitted: (u64, u32),
}

impl Telemetry {
    pub fn new(session: &str, role: Role) -> Self {
        Self {
            session: session.to_owned(),
            role,
            turn: None,
            tools: HashMap::new(),
            subagents: HashMap::new(),
            emitted: (0, 0),
        }
    }

    /// The facts of one kernel event.
    pub fn observe(&mut self, event: &KernelEvent, at: &Observed<'_>) -> Vec<Value> {
        let mut out = Vec::new();
        match event {
            KernelEvent::TurnStarted { turn, command } => {
                self.turn = Some(Turn {
                    id: turn.as_str().to_owned(),
                    command: command
                        .as_ref()
                        .map_or_else(uuid_v7_now(at.now), |command| command.as_str().to_owned()),
                    started_at: at.now,
                    held: (command.is_none() && self.role == Role::Main)
                        .then_some((at.seq, at.now)),
                    automation: (self.role == Role::Main && command.is_some())
                        .then(|| at.automation.map(str::to_owned))
                        .flatten(),
                    ..Turn::default()
                });
                self.tools.clear();
                if command.is_some() || self.role == Role::Child {
                    self.turn_started(at, &mut out);
                }
            }
            KernelEvent::MessageDone { message } => match message {
                Message::User(user) => {
                    if let UserOrigin::Meta { .. } | UserOrigin::Human = user.origin
                        && let Some(turn) = &mut self.turn
                    {
                        let metas =
                            notification_metas(user.content.iter().filter_map(
                                |block| match block {
                                    ContentBlock::Text { text } => Some(text.as_str()),
                                    _ => None,
                                },
                            ));
                        turn.consumed_subagent |= subagent_result_consumed(&metas);
                        if turn.held.is_some() {
                            turn.background_source = background_source(&metas);
                        }
                    }
                    self.release_held(at, &mut out);
                }
                // A notification that arrives while the turn runs is merged at the tool boundary as a
                // `queued_command` attachment, not a user message; Node still counts it as consumed.
                Message::Attachment(attachment)
                    if attachment.source == queued_command::SOURCE
                        && attachment.data[queued_command::MODE_KEY]
                            == queued_command::TASK_NOTIFICATION =>
                {
                    if let Some(turn) = &mut self.turn {
                        let metas = notification_metas([attachment.text.as_str()]);
                        turn.consumed_subagent |= subagent_result_consumed(&metas);
                    }
                }
                Message::Assistant(assistant) => {
                    self.release_held(at, &mut out);
                    let response = self
                        .turn
                        .as_ref()
                        .and_then(|turn| turn.request.as_ref())
                        .map_or(0, |request| request.response);
                    self.request_started(response, at, &mut out);
                    let Some(request) = self.turn.as_mut().and_then(|turn| turn.request.take())
                    else {
                        return out;
                    };
                    out.push(self.request_status(
                        &request.id,
                        "model_request_completed",
                        Some(at.now.saturating_sub(request.started_at)),
                        at,
                    ));
                    if let Some(usage) = assistant.usage {
                        let input = usage.input_tokens
                            + usage.cache_creation_input_tokens
                            + usage.cache_read_input_tokens;
                        let total = input + usage.output_tokens;
                        if let Some(turn) = &mut self.turn {
                            turn.tokens += total;
                        }
                        let mut fact = self.base("usage.delta", at);
                        fact.insert("requestId".into(), json!(request.id));
                        self.identity(&mut fact, at.provider);
                        fact.insert("inputTokens".into(), json!(input));
                        fact.insert("outputTokens".into(), json!(usage.output_tokens));
                        fact.insert("totalTokens".into(), json!(total));
                        fact.insert("reasoningTokens".into(), json!(0));
                        fact.insert(
                            "cacheReadTokens".into(),
                            json!(usage.cache_read_input_tokens),
                        );
                        fact.insert(
                            "cacheWriteTokens".into(),
                            json!(usage.cache_creation_input_tokens),
                        );
                        out.push(Value::Object(fact));
                    }
                }
                Message::Attachment(_) | Message::System(_) => {}
            },
            KernelEvent::StreamDelta {
                response, delta, ..
            } => {
                self.release_held(at, &mut out);
                self.request_started(*response, at, &mut out);
                let channel = match delta {
                    BlockDelta::Text(text) => Some(("text", text)),
                    BlockDelta::Thinking(text) => Some(("thought", text)),
                    BlockDelta::Signature(_) | BlockDelta::InputJson(_) => None,
                };
                if let Some((channel, text)) = channel {
                    let first = self
                        .turn
                        .as_mut()
                        .and_then(|turn| turn.request.as_mut())
                        .is_some_and(|request| request.channels.insert(channel));
                    let mut fact = self.base("stream.chunk", at);
                    fact.insert("channel".into(), json!(channel));
                    fact.insert("chunkLength".into(), json!(text.chars().count()));
                    fact.insert("firstChunk".into(), json!(first));
                    out.push(Value::Object(fact));
                }
            }
            KernelEvent::ToolInputStarted {
                response,
                tool_use,
                name,
                ..
            } => {
                self.release_held(at, &mut out);
                self.request_started(*response, at, &mut out);
                self.tool_scheduled(tool_use.as_str(), name, at, &mut out);
            }
            KernelEvent::ToolStarted { tool_use, name, .. } => {
                self.release_held(at, &mut out);
                self.tool_scheduled(tool_use.as_str(), name, at, &mut out);
                if let Some(tool) = self.tools.get_mut(tool_use.as_str()) {
                    tool.started_at = Some(at.now);
                }
                if let Some(turn) = &mut self.turn {
                    turn.tool_calls += 1;
                }
                out.push(self.tool_fact(tool_use.as_str(), "started", None, None, at));
            }
            KernelEvent::ToolDone { tool_use, output } => {
                let Some(tool) = self.tools.get(tool_use.as_str()) else {
                    return out;
                };
                let duration = tool
                    .started_at
                    .map(|started| at.now.saturating_sub(started));
                // Fork: Node `cronCreateAutomationId`: a completed CronCreate names the automation it created.
                let created = (!output.is_error && tool.name == tool_names::CRON_CREATE)
                    .then(|| created_automation(&output.content))
                    .flatten();
                let (phase, error) = if output.is_error {
                    let message = rust_cli_kernel_api::message::text_of(&output.content);
                    ("failed", Some(message))
                } else {
                    ("completed", None)
                };
                let mut fact = self.tool_fact(tool_use.as_str(), phase, duration, error, at);
                if let (Some(created), Some(fact)) = (created, fact.as_object_mut()) {
                    fact.insert("automationId".into(), json!(created));
                }
                out.push(fact);
            }
            KernelEvent::TurnFinished { outcome, .. } => {
                self.release_held(at, &mut out);
                let Some(turn) = self.turn.take() else {
                    return out;
                };
                let (status, result) = match outcome {
                    TurnOutcome::Success
                    | TurnOutcome::HookStopped
                    | TurnOutcome::StopHookPrevented => ("success", "success"),
                    TurnOutcome::Interrupted => ("interrupted", "cancelled"),
                    TurnOutcome::Failed { .. } => ("failed", "error"),
                };
                let mut fact = self.turn_base("turn.terminal", &turn, at);
                fact.insert("status".into(), json!(status));
                fact.insert("resultType".into(), json!(result));
                fact.insert(
                    "durationMs".into(),
                    json!(at.now.saturating_sub(turn.started_at)),
                );
                fact.insert("tokenCount".into(), json!(turn.tokens));
                fact.insert("toolCallCount".into(), json!(turn.tool_calls));
                match outcome {
                    TurnOutcome::Interrupted => {
                        fact.insert("errorCode".into(), json!("USER_INTERRUPT"));
                        fact.insert("errorMessage".into(), json!("User stopped generation"));
                    }
                    TurnOutcome::Failed { message, .. } => {
                        fact.insert("errorMessage".into(), json!(message));
                    }
                    _ => {}
                }
                if turn.consumed_subagent {
                    fact.insert("backgroundSubagentResultConsumed".into(), json!(true));
                }
                out.push(Value::Object(fact));
                self.tools.clear();
            }
            _ => {}
        }
        out
    }

    /// The `subagent.lifecycle` facts of the projection's subagent rows: a new row is `spawned`, a row that left
    /// `running` is `stopped`, a settled row that runs again (a `SendMessage` resume) is `spawned` again, like Node's
    /// resumed run. Returns the children that were just spawned (their runs are read next).
    pub fn subagents(
        &mut self,
        links: &[SubagentLink],
        at: &Observed<'_>,
        out: &mut Vec<Value>,
    ) -> Vec<String> {
        let mut spawned = Vec::new();
        for link in links {
            let previous = self.subagents.get(&link.agent).cloned();
            let running = link.status == "running";
            let phase = match previous.as_ref().map(|(status, _)| status.as_str()) {
                None => Some("spawned"),
                Some("running") if !running => Some("stopped"),
                Some(previous) if running && previous != "running" => Some("spawned"),
                _ => None,
            };
            let Some(phase) = phase else {
                continue;
            };
            let current_turn = self.turn.as_ref().map(|turn| turn.id.clone());
            let spawn_turn = if phase == "spawned" {
                current_turn.or_else(|| link.turn.clone())
            } else {
                previous.and_then(|(_, turn)| turn)
            };
            self.subagents.insert(
                link.agent.clone(),
                (link.status.clone(), spawn_turn.clone()),
            );
            if phase == "spawned" {
                if !running {
                    // A row first seen already settled (a reopened session) reports nothing.
                    continue;
                }
                spawned.push(link.child.clone());
            }
            let mut fact = self.base("subagent.lifecycle", at);
            if phase == "stopped" {
                // Node reports the stop under the turn of its spawn (the launching turn, or the resuming turn of a
                // resumed run), without a command (it may land in a later turn).
                fact.remove("sourceCommandId");
                fact.remove("turnId");
                if let Some(turn) = spawn_turn.or_else(|| link.turn.clone()) {
                    fact.insert("turnId".into(), json!(turn));
                }
            }
            fact.insert("phase".into(), json!(phase));
            fact.insert("agentId".into(), json!(link.agent));
            if let Some(agent_type) = &link.agent_type {
                fact.insert("agentType".into(), json!(agent_type));
            }
            fact.insert("childSessionId".into(), json!(link.child));
            // The schema requires a non-empty call ID when present; a nested agent has none.
            if !link.parent_tool.is_empty() {
                fact.insert("parentToolCallId".into(), json!(link.parent_tool));
            }
            fact.insert("background".into(), json!(link.background));
            let status = match link.status.as_str() {
                "running" => "running",
                "success" => "completed",
                "cancelled" => "killed",
                other => other,
            };
            fact.insert("status".into(), json!(status));
            out.push(Value::Object(fact));
        }
        spawned
    }

    fn release_held(&mut self, at: &Observed<'_>, out: &mut Vec<Value>) {
        let Some((seq, started)) = self.turn.as_mut().and_then(|turn| turn.held.take()) else {
            return;
        };
        let at = Observed {
            scope: at.scope,
            seq,
            now: started,
            provider: at.provider,
            automation: None,
        };
        // The held fact keeps the seq of its TurnStarted; its index must not collide with facts already emitted for
        // that seq (none: it was held).
        self.turn_started(&at, out);
    }

    fn turn_started(&mut self, at: &Observed<'_>, out: &mut Vec<Value>) {
        let mut fact = self.base("turn.started", at);
        if !at.provider.model.is_empty() {
            fact.insert("modelName".into(), json!(at.provider.model));
            fact.insert("modelProvider".into(), json!(at.provider.provider));
        }
        match self.role {
            Role::Child => {
                fact.insert("inputSource".into(), json!("subagent"));
            }
            Role::Main => {
                if let Some(turn) = &self.turn
                    && let Some(automation) = &turn.automation
                {
                    automation_admission(&mut fact, &turn.command, automation);
                }
                if let Some(source) = self
                    .turn
                    .as_ref()
                    .and_then(|turn| turn.background_source.as_deref())
                {
                    fact.insert("inputSource".into(), json!("background_task"));
                    fact.insert("backgroundSource".into(), json!(source));
                }
            }
        }
        out.push(Value::Object(fact));
    }

    fn request_started(&mut self, response: u32, at: &Observed<'_>, out: &mut Vec<Value>) {
        let Some(turn) = &mut self.turn else {
            return;
        };
        if turn
            .request
            .as_ref()
            .is_some_and(|request| request.response == response)
        {
            return;
        }
        let id = uuid_v7(at.now);
        turn.request = Some(Request {
            response,
            id: id.clone(),
            started_at: at.now,
            channels: HashSet::new(),
        });
        out.push(self.request_status(&id, "model_request_started", None, at));
    }

    fn request_status(
        &mut self,
        id: &str,
        status: &str,
        duration: Option<u64>,
        at: &Observed<'_>,
    ) -> Value {
        let mut fact = self.base("model.request.status", at);
        fact.insert("requestId".into(), json!(id));
        fact.insert("status".into(), json!(status));
        fact.insert("providerId".into(), json!(at.provider.provider));
        fact.insert("modelId".into(), json!(at.provider.model));
        if let Some(kind) = &at.provider.kind {
            fact.insert("providerKind".into(), json!(kind));
        }
        if let Some(host) = &at.provider.host {
            fact.insert("providerHostname".into(), json!(host));
        }
        fact.insert("transport".into(), json!("sse"));
        let source = match self.role {
            Role::Main => "main_turn",
            Role::Child => "subagent",
        };
        fact.insert("querySource".into(), json!(source));
        if let Some(command) = self.turn.as_ref().map(|turn| turn.command.clone())
            && self.role == Role::Main
        {
            fact.insert("queryId".into(), json!(command));
        }
        fact.insert("attempt".into(), json!(1));
        fact.insert("maxAttempts".into(), json!(1));
        if let Some(duration) = duration {
            fact.insert("durationMs".into(), json!(duration));
        }
        Value::Object(fact)
    }

    fn identity(&self, fact: &mut Map<String, Value>, provider: &Provider) {
        fact.insert("providerId".into(), json!(provider.provider));
        fact.insert("modelId".into(), json!(provider.model));
        if let Some(kind) = &provider.kind {
            fact.insert("providerKind".into(), json!(kind));
        }
        if let Some(host) = &provider.host {
            fact.insert("providerHostname".into(), json!(host));
        }
    }

    fn tool_scheduled(&mut self, tool: &str, name: &str, at: &Observed<'_>, out: &mut Vec<Value>) {
        if self.tools.contains_key(tool) {
            return;
        }
        self.tools.insert(
            tool.to_owned(),
            Tool {
                name: name.to_owned(),
                started_at: None,
            },
        );
        out.push(self.tool_fact(tool, "scheduled", None, None, at));
    }

    fn tool_fact(
        &mut self,
        tool: &str,
        phase: &str,
        duration: Option<u64>,
        error: Option<String>,
        at: &Observed<'_>,
    ) -> Value {
        let mut fact = self.base("tool.lifecycle", at);
        fact.insert("phase".into(), json!(phase));
        fact.insert("toolCallId".into(), json!(tool));
        if let Some(tool) = self.tools.get(tool) {
            fact.insert("toolName".into(), json!(tool.name));
        }
        if let Some(duration) = duration {
            fact.insert("durationMs".into(), json!(duration));
        }
        if let Some(error) = error {
            fact.insert("errorMessage".into(), json!(error));
        }
        Value::Object(fact)
    }

    fn base(&mut self, kind: &str, at: &Observed<'_>) -> Map<String, Value> {
        let mut fact = self.fact_base(kind, at);
        if let Some(turn) = &self.turn {
            if self.role == Role::Main {
                fact.insert("sourceCommandId".into(), json!(turn.command));
            }
            fact.insert("turnId".into(), json!(turn.id));
        }
        fact
    }

    fn turn_base(&mut self, kind: &str, turn: &Turn, at: &Observed<'_>) -> Map<String, Value> {
        let mut fact = self.fact_base(kind, at);
        if self.role == Role::Main {
            fact.insert("sourceCommandId".into(), json!(turn.command));
        }
        fact.insert("turnId".into(), json!(turn.id));
        fact
    }

    fn fact_base(&mut self, kind: &str, at: &Observed<'_>) -> Map<String, Value> {
        let index = if self.emitted.0 == at.seq {
            self.emitted.1 += 1;
            self.emitted.1
        } else {
            self.emitted = (at.seq, 0);
            0
        };
        let mut fact = Map::new();
        fact.insert("version".into(), json!(1));
        fact.insert(
            "eventId".into(),
            json!(format!("{}:{}{}:{index}", self.session, at.scope, at.seq)),
        );
        fact.insert("eventSeq".into(), json!(at.seq));
        fact.insert("occurredAt".into(), json!(at.now));
        fact.insert("sessionId".into(), json!(self.session));
        fact.insert("kind".into(), json!(kind));
        fact
    }
}

/// Fork: the `automation.automationId` of a CronCreate output (its text is the JSON the tool answered).
fn created_automation(content: &[ToolResultContent]) -> Option<String> {
    let text = rust_cli_kernel_api::message::text_of(content);
    let value: Value = serde_json::from_str(&text).ok()?;
    value["automation"]["automationId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

/// Fork: Node `automationAdmission`: an automation turn names its automation, and the trigger (and scheduled time)
/// its command reads as when the command is that automation's run id (`parseAutomationRunId`:
/// `<automationId>:manual:<id>` or `<automationId>:<scheduledAt>`). The Host's telemetry seeds the run's
/// `agent_step` / `message_completion` from these fields, since a run gets no renderer send acknowledgement.
fn automation_admission(fact: &mut Map<String, Value>, command: &str, automation: &str) {
    fact.insert("automationId".into(), json!(automation));
    let Some((prefix, rest)) = command.split_once(':') else {
        return;
    };
    if prefix.is_empty() || prefix != automation {
        return;
    }
    if let Some(id) = rest.strip_prefix("manual:") {
        if !id.is_empty() {
            fact.insert("taskTrigger".into(), json!("manual"));
        }
        return;
    }
    // `Number.isSafeInteger(n) && n > 0`: plain decimal digits only (Node's `Number()` also reads forms such as
    // `1e12`, which run ids never carry).
    const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
    if !rest.is_empty()
        && rest.bytes().all(|byte| byte.is_ascii_digit())
        && let Ok(at) = rest.parse::<u64>()
        && (1..=MAX_SAFE_INTEGER).contains(&at)
    {
        fact.insert("taskTrigger".into(), json!("schedule"));
        fact.insert("scheduledAt".into(), json!(at));
    }
}

/// The `origin_meta` of each task notification block in a message, in order.
fn notification_metas<'a>(texts: impl IntoIterator<Item = &'a str>) -> Vec<Value> {
    texts
        .into_iter()
        .flat_map(|text| text.split("<task-notification>").skip(1))
        .filter_map(rust_cli_kernel_api::background_origin::origin_meta)
        .collect()
}

/// Node `backgroundSubagentResultConsumed` (runtime-command-queue.ts): the batch carries a subagent's result. A stall
/// reminder carries `backgroundSource: "subagent"` too, but it is not a result, so it does not count.
fn subagent_result_consumed(metas: &[Value]) -> bool {
    metas
        .iter()
        .any(|meta| meta["backgroundSource"] == "subagent" && meta.get("subagentStall").is_none())
}

/// The `backgroundSource` a turn's results share, resolved as Node's
/// `resolveBackgroundTaskNotificationSource`. A stall reminder is not a result, so it is skipped; the
/// source is reported only when every remaining result names the same one. A mixed or missing source
/// yields `None`, so the order of notifications cannot change the turn's cause.
fn background_source(metas: &[Value]) -> Option<String> {
    let sources: Vec<Option<&str>> = metas
        .iter()
        .filter(|meta| meta.get("subagentStall").is_none())
        .map(|meta| meta["backgroundSource"].as_str())
        .collect();
    let first = (*sources.first()?)?;
    sources
        .iter()
        .all(|source| *source == Some(first))
        .then(|| first.to_owned())
}

fn uuid_v7_now(now: u64) -> impl FnOnce() -> String {
    move || uuid_v7(now)
}

/// A UUID v7 (RFC 9562): 48 bits of Unix milliseconds, then random bits with the version and variant set.
pub fn uuid_v7(now_ms: u64) -> String {
    let high = rust_cli_base::random::u64();
    let low = rust_cli_base::random::u64();
    let time = now_ms & 0xFFFF_FFFF_FFFF;
    let version_rand = 0x7000 | (high & 0x0FFF);
    let variant = 0x8000_0000_0000_0000 | (low & 0x3FFF_FFFF_FFFF_FFFF);
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        time >> 16,
        time & 0xFFFF,
        version_rand,
        variant >> 48,
        variant & 0xFFFF_FFFF_FFFF
    )
}

#[cfg(test)]
#[path = "telemetry_tests.rs"]
pub(crate) mod tests;
