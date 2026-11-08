//! 会话投影（docs/specs/rust-cli/app-protocol.md §6.1）：内核事件 → App 的行与状态。纯计算：`(投影, 事件) → (投影',
//! 增量)`，从 [`SessionView`] 能重建（[`cold`]），所以不是第二份事实。revision 只来自事件（会话 actor 是 owner，G1）。
//!
//! 行：turnHeader（回合）、userInput（真人输入）、assistantText、reasoning、toolCall；其余事件只改状态或忽略（P1）。

mod actions;
mod cold;
pub mod elicitation;
mod kinds;
mod markers;
mod plans;
mod rows;
pub mod state;

use std::collections::HashMap;

use rust_cli_kernel_api::message::{ContentBlock, Usage, text_of as text_of_result};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    FileChange, KernelEvent, QueuedInput, SequencedEvent, SessionView, TurnOutcome,
};
use serde_json::{Map, Value, json};

pub use actions::{RowAction, RowTarget};
use kinds::{RowKind, ToolStatus};
use state::{ActiveWork, Followup, LastError, Phase};

/// 快照里最多带的行（尾部窗口）。
const WINDOW_ROWS: usize = 200;

/// sendText 带来的输入的事实（行与队列项要用）。
#[derive(Debug, Clone, PartialEq)]
pub struct InputMeta {
    pub client: String,
    pub origin: Option<String>,
    pub text: String,
    pub selection: Option<Value>,
    pub mode: Option<String>,
    pub plan: Option<bool>,
    pub admitted_at: u64,
    pub requested: &'static str,
    pub admitted: &'static str,
    /// Fork: the `attachments` refs sent with the input; only the queue shows them (a stored input's row reads its
    /// file parts).
    pub attachments: Vec<Value>,
}

/// Fork: a turn's file changes merged across the turn's `KernelEvent::FileChanges` batches (Node derives the
/// header summary from one ModelComplete; the kernel reports one event per checkpoint batch). Counts are summed
/// per path so a path seen again is counted once, like Node's per-turn `fileChanges`.
#[derive(Debug, Clone, Default)]
struct TurnFileChanges {
    /// path → summed (additions, deletions).
    files: HashMap<String, (u64, u64)>,
    /// Any of the turn's batches said its checkpoints can be rewound.
    rewindable: bool,
}

/// 一个回合里的行。
#[derive(Debug, Clone)]
struct Turn {
    id: String,
    command: Option<String>,
    started_at: u64,
    /// 当前模型响应的序号（流式增量带来；assistant 消息落定时用它找行）。
    response: Option<u32>,
    keys: Vec<String>,
}

/// 一个会话的投影。
#[derive(Debug, Clone)]
pub struct Projection {
    session: String,
    rows: Vec<Map<String, Value>>,
    index: HashMap<String, usize>,
    next_row: u64,
    revision: u64,
    phase: Phase,
    active: Option<ActiveWork>,
    error: Option<LastError>,
    executions: u64,
    title: String,
    selection: ModelSelection,
    mode: PermissionMode,
    plan: bool,
    followup: Followup,
    levels: Vec<String>,
    context: Option<rust_cli_kernel_api::compaction::ContextOccupancy>,
    total: Usage,
    queue: Vec<QueuedInput>,
    pending: Vec<Value>,
    turn: Option<Turn>,
    inputs: HashMap<String, InputMeta>,
    /// 用户拒绝了的工具调用：结果投成 cancelled。
    denied: std::collections::HashSet<String>,
    /// Fork: the queue drains on its own (`setAutoDrain`); the kernel's hold is set by the same command.
    auto_drain: bool,
    /// Fork: why the queue is paused (`queue.pauseReason`): `manual` after `setAutoDrain(false)`, `stopped` after a
    /// user stop held it (specs/stop-queue-hold.md).
    pause_reason: Option<&'static str>,
    created_at: u64,
    /// Fork: a compaction is running (row actions are withheld, like Node's `compact` active work).
    compacting: bool,
    /// Fork: compaction markers so far; the running one is `compact:<count>` (projection/markers.rs).
    compactions: u64,
    /// Fork: the model directory; `thoughtLevels` are the selected model's levels in it (Node `listThoughtLevels`).
    catalog: std::sync::Arc<[rust_cli_kernel_api::provider::CatalogModel]>,
    /// Fork: file changes per turn (`KernelEvent::FileChanges`): feed the turn header's `fileChanges` summary and
    /// the `canRewindFiles` action (`projection/actions.rs`).
    turn_file_changes: HashMap<String, TurnFileChanges>,
}

/// user 与 assistant 消息里的文字块，以换行接起来（`session/read` 的旧快照也用它）。
pub(crate) fn text_of(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            ContentBlock::Image { .. }
            | ContentBlock::Thinking { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolUse { .. }
            | ContentBlock::ToolResult { .. }
            | ContentBlock::ServerToolUse { .. }
            | ContentBlock::WebSearchToolResult { .. }
            | ContentBlock::File { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn turn_key(turn: &str) -> String {
    format!("turn:{turn}")
}

fn block_key(kind: RowKind, turn: &str, response: u32, index: usize) -> String {
    format!("{}:{turn}:{response}:{index}", kind.as_str())
}

fn tool_key(tool_use: &str) -> String {
    format!("tool:{tool_use}")
}

impl Projection {
    /// 从视图建投影（冷打开或第一次订阅）。`followup` 与 `levels` 是协议自己保存的配置（不在内核里）。
    pub fn from_view(view: &SessionView, followup: Followup, levels: Vec<String>) -> Self {
        Self::from_view_at(view, followup, levels, 1)
    }

    /// Fork: the projection of a rewritten history (rewind, edit, retry). Keeps what the protocol remembers outside the
    /// kernel (follow-up mode, levels, input facts, denials) and keeps row ids increasing.
    pub fn rebuilt(&self, view: &SessionView) -> Self {
        let mut projection =
            Self::from_view_at(view, self.followup, self.levels.clone(), self.next_row);
        projection.inputs.clone_from(&self.inputs);
        projection.denied.clone_from(&self.denied);
        projection.catalog = self.catalog.clone();
        projection.auto_drain = self.auto_drain;
        projection.pause_reason = self.pause_reason;
        projection
    }

    fn from_view_at(
        view: &SessionView,
        followup: Followup,
        levels: Vec<String>,
        first_row: u64,
    ) -> Self {
        let mut projection = Self {
            session: view.meta.id.as_str().to_owned(),
            rows: Vec::new(),
            index: HashMap::new(),
            next_row: first_row,
            revision: view.revision,
            phase: Phase::Draft,
            active: None,
            error: None,
            executions: 0,
            title: view.meta.title.clone(),
            selection: view.selection.clone(),
            mode: view.mode,
            plan: view.plan,
            followup,
            levels,
            context: view.context_usage,
            total: Usage::default(),
            queue: view.queue.clone(),
            pending: Vec::new(),
            turn: None,
            inputs: HashMap::new(),
            denied: std::collections::HashSet::new(),
            created_at: view.meta.created_at_ms,
            compacting: false,
            compactions: 0,
            catalog: std::sync::Arc::from(Vec::new()),
            auto_drain: true,
            pause_reason: None,
            turn_file_changes: HashMap::new(),
        };
        cold::rows(&mut projection, view);
        for (interaction, request) in &view.pending {
            projection.ask(interaction.as_str(), request, view.meta.created_at_ms);
        }
        projection.refresh_actions(&mut Vec::new());
        projection
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn followup(&self) -> Followup {
        self.followup
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    /// 最后一条 assistant 正文（会话列表的预览）。
    pub fn last_reply(&self) -> Option<String> {
        self.rows.iter().rev().find_map(|row| {
            (RowKind::of(row) == Some(RowKind::AssistantText))
                .then(|| row["text"].as_str().map(str::to_owned))
                .flatten()
        })
    }

    pub fn pending_permissions(&self) -> usize {
        self.pending.len()
    }

    /// 用户拒绝了这个工具调用（resolveInteraction 的裁决在内核事件之前）：结果投成 cancelled（与 Node 相同）。
    pub fn deny(&mut self, tool_use: &str) {
        self.denied.insert(tool_use.to_owned());
    }

    /// Fork: the MIME of an attachment ref a `userInput` row of this session carries (`attachmentRead` serves only these).
    pub fn attachment_mime(&self, reference: &str) -> Option<String> {
        self.rows.iter().find_map(|row| {
            row.get("attachments")?
                .as_array()?
                .iter()
                .find_map(|attachment| {
                    (attachment["ref"] == reference || attachment["previewRef"] == reference)
                        .then(|| attachment["mime"].as_str().unwrap_or_default().to_owned())
                })
        })
    }

    /// 记下 sendText 的事实（行与队列项要用）。
    pub fn remember_input(&mut self, command: &str, meta: InputMeta) {
        self.inputs.insert(command.to_owned(), meta);
    }

    /// 协议自己保存的配置变了（setFollowupMode）：返回 `state.updated`。
    pub fn set_followup(&mut self, followup: Followup) -> Value {
        self.followup = followup;
        json!({"op": "state.updated", "patch": {
            "config": self.config(),
            "inputRouting": self.input_routing(),
        }})
    }

    /// Fork: whether the queue drains on its own (`queue.autoDrain`).
    pub fn auto_drain(&self) -> bool {
        self.auto_drain
    }

    /// Fork: `setAutoDrain` was accepted: returns the `state.updated` for the queue.
    pub fn set_auto_drain(&mut self, auto_drain: bool) -> Value {
        self.auto_drain = auto_drain;
        self.pause_reason = (!auto_drain).then_some("manual");
        self.queue_patch()
    }

    /// Fork: whether queued inputs wait behind the running turn (a stop would hold them).
    pub fn has_queue(&self) -> bool {
        self.queue_state()["items"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    }

    /// Fork: a user stop cancelled the turn and held the queue (Node's cancelled `TurnComplete` without the preserve
    /// intent: `autoDrain: false`, `pauseReason: "stopped"`).
    pub fn hold_for_stop(&mut self) -> Value {
        self.auto_drain = false;
        self.pause_reason = Some("stopped");
        self.queue_patch()
    }

    /// The queue and the input routing derived from it change together (Node's `queuePatch`).
    fn queue_patch(&self) -> Value {
        json!({"op": "state.updated", "patch": {
            "queue": self.queue_state(),
            "inputRouting": self.input_routing(),
        }})
    }

    fn input_routing(&self) -> Value {
        state::input_routing(
            self.phase,
            self.followup,
            !self.auto_drain && self.has_queue(),
        )
    }

    /// Fork: the model, permission mode and plan switch the projection shows, so a switch command can
    /// answer `config.unchanged` the way Node does.
    pub fn current_config(&self) -> (ModelSelection, PermissionMode, bool) {
        (self.selection.clone(), self.mode, self.plan)
    }

    fn config(&self) -> Value {
        state::config(
            &self.selection,
            self.mode,
            self.plan,
            self.followup,
            &self.thought_levels(),
        )
    }

    /// Fork: uses the model directory for `thoughtLevels` from now on.
    #[must_use]
    pub fn with_catalog(
        mut self,
        catalog: std::sync::Arc<[rust_cli_kernel_api::provider::CatalogModel]>,
    ) -> Self {
        self.catalog = catalog;
        self
    }

    /// Fork: the selected model's levels in the directory, like Node `listThoughtLevels`; a model the directory does
    /// not list keeps the protocol's own levels.
    fn thought_levels(&self) -> Vec<String> {
        self.catalog
            .iter()
            .find(|entry| rust_cli_kernel_api::model_name::is_entry(&self.selection, entry))
            .map_or_else(
                || self.levels.clone(),
                |entry| entry.reasoning_levels.clone(),
            )
    }

    fn base(
        &self,
        key_turn: &str,
        entity: &str,
        kind: RowKind,
        now: u64,
        seq: u64,
    ) -> Map<String, Value> {
        let mut row = Map::new();
        row.insert("rowId".into(), json!(self.next_row));
        row.insert("turnId".into(), json!(key_turn));
        row.insert("entityId".into(), json!(entity));
        row.insert("productTurnId".into(), json!(key_turn));
        row.insert("visibility".into(), json!("visible"));
        row.insert("createdAt".into(), json!(now));
        row.insert("createdAtSeq".into(), json!(seq));
        row.insert("kind".into(), json!(kind.as_str()));
        row
    }

    fn append(&mut self, key: String, row: Map<String, Value>, out: &mut Vec<Value>) {
        self.next_row += 1;
        out.push(json!({"op": "row.appended", "row": row}));
        self.index.insert(key.clone(), self.rows.len());
        self.rows.push(row);
        if let Some(turn) = &mut self.turn {
            turn.keys.push(key);
        }
    }

    fn upsert(
        &mut self,
        key: &str,
        change: impl FnOnce(&mut Map<String, Value>),
        out: &mut Vec<Value>,
    ) {
        let Some(&at) = self.index.get(key) else {
            return;
        };
        let row = &mut self.rows[at];
        let before = row.clone();
        change(row);
        if *row != before {
            out.push(json!({"op": "row.upserted", "row": row.clone()}));
        }
    }

    fn row_id(&self, key: &str) -> Option<u64> {
        self.index
            .get(key)
            .and_then(|at| self.rows[*at]["rowId"].as_u64())
    }

    fn control(&self) -> Value {
        state::control(self.phase, self.active.as_ref(), self.error.as_ref())
    }

    /// 回合的开始、结束等改变阶段的事件：control、availability 与 inputRouting 一起换。
    fn phase_patch(&self, patch: &mut Map<String, Value>) {
        patch.insert("control".into(), self.control());
        patch.insert("availability".into(), state::availability());
        patch.insert("inputRouting".into(), self.input_routing());
    }

    /// 一个事件 → 增量（`row.*` 与 `state.updated`）。`now` 是行的时间。
    pub fn apply(&mut self, event: &SequencedEvent, now: u64) -> Vec<Value> {
        let mut out = Vec::new();
        let mut patch = Map::new();
        let seq = event.seq;
        match &event.event {
            KernelEvent::TurnStarted { turn, command } => {
                self.start_turn(
                    turn.as_str(),
                    command.as_ref().map(|c| c.as_str().to_owned()),
                    now,
                    seq,
                    &mut out,
                );
                self.phase_patch(&mut patch);
            }
            KernelEvent::MessageDone { message } => self.message(message, now, seq, &mut out),
            KernelEvent::StreamDelta {
                turn,
                response,
                index,
                delta,
            } => self.stream(turn.as_str(), *response, *index, delta, now, seq, &mut out),
            KernelEvent::ToolStarted {
                tool_use,
                name,
                input,
            } => {
                let key = tool_key(tool_use.as_str());
                if !self.index.contains_key(&key) {
                    self.tool_row(tool_use.as_str(), name, input, now, seq, &mut out);
                }
                self.upsert(
                    &key,
                    |row| {
                        if ToolStatus::of(row) != Some(ToolStatus::PendingApproval) {
                            row.insert("status".into(), json!(ToolStatus::Running.as_str()));
                        }
                        row.entry("startedAt").or_insert(json!(now));
                    },
                    &mut out,
                );
            }
            KernelEvent::ToolDone { tool_use, output } => {
                let text = text_of_result(&output.content);
                let status = if self.denied.remove(tool_use.as_str()) {
                    ToolStatus::Cancelled
                } else if output.is_error {
                    ToolStatus::Error
                } else {
                    ToolStatus::Success
                };
                self.upsert(
                    &tool_key(tool_use.as_str()),
                    |row| {
                        row.insert("status".into(), json!(status.as_str()));
                        row.insert("output".into(), json!({"text": text}));
                        row.insert("endedAt".into(), json!(now));
                        row.remove("approvalInteractionId");
                    },
                    &mut out,
                );
            }
            KernelEvent::InteractionAsked {
                interaction,
                request,
            } => {
                if let Some(tool) = self.ask(interaction.as_str(), request, now) {
                    let id = interaction.as_str().to_owned();
                    self.upsert(
                        &tool_key(&tool),
                        |row| {
                            row.insert(
                                "status".into(),
                                json!(ToolStatus::PendingApproval.as_str()),
                            );
                            row.insert("approvalInteractionId".into(), json!(id));
                        },
                        &mut out,
                    );
                    patch.insert("pendingInteractions".into(), json!(self.pending));
                }
            }
            KernelEvent::InteractionResolved { interaction } => {
                let before = self.pending.len();
                let tool = self
                    .pending
                    .iter()
                    .find(|pending| pending["interactionId"] == interaction.as_str())
                    .and_then(|pending| {
                        pending["payload"]["toolCallId"].as_str().map(str::to_owned)
                    });
                self.pending
                    .retain(|pending| pending["interactionId"] != interaction.as_str());
                if self.pending.len() != before {
                    patch.insert("pendingInteractions".into(), json!(self.pending));
                }
                if let Some(tool) = tool {
                    self.upsert(
                        &tool_key(&tool),
                        |row| {
                            if ToolStatus::of(row) == Some(ToolStatus::PendingApproval) {
                                row.insert("status".into(), json!(ToolStatus::Running.as_str()));
                            }
                        },
                        &mut out,
                    );
                }
            }
            KernelEvent::TurnFinished {
                turn,
                outcome,
                usage,
            } => {
                self.finish_turn(turn.as_str(), outcome, usage.as_ref(), now, &mut out);
                self.phase_patch(&mut patch);
                patch.insert("usage".into(), state::usage(self.context, &self.total));
                if !self.pending.is_empty() {
                    self.pending.clear();
                    patch.insert("pendingInteractions".into(), json!([]));
                }
            }
            KernelEvent::ContextUsage {
                used_tokens,
                max_tokens,
                compact_at,
            } => {
                self.context = Some(rust_cli_kernel_api::compaction::ContextOccupancy {
                    used_tokens: *used_tokens,
                    max_tokens: *max_tokens,
                    compact_at: *compact_at,
                });
                patch.insert("usage".into(), state::usage(self.context, &self.total));
            }
            KernelEvent::TitleChanged { title } => {
                self.title.clone_from(title);
                patch.insert("meta".into(), state::meta(&self.title, true));
            }
            KernelEvent::ModelChanged { selection } => {
                self.selection = selection.clone();
                patch.insert("config".into(), self.config());
            }
            KernelEvent::ModeChanged { mode } => {
                self.mode = *mode;
                patch.insert("config".into(), self.config());
            }
            KernelEvent::PlanChanged { enabled } => {
                self.plan = *enabled;
                patch.insert("config".into(), self.config());
            }
            // Fork: only the row actions follow a compaction (specs/fork-rust-agent-parity.md).
            KernelEvent::CompactStarted { trigger } => {
                self.compacting = true;
                self.compact_started(*trigger, now, seq, &mut out);
            }
            KernelEvent::CompactDone { .. } => {
                self.compacting = false;
                self.compact_settled("success", &mut out);
            }
            KernelEvent::CompactFailed { .. } => {
                self.compacting = false;
                self.compact_settled("failed", &mut out);
            }
            KernelEvent::QueueChanged { items } => {
                // 立即开跑的输入（空闲时提交）在内核里也经过队列：不投成排队项；投出的值没变时不发。
                let before = self.queue_state();
                self.queue.clone_from(items);
                let after = self.queue_state();
                if after != before {
                    patch.insert("queue".into(), after);
                    patch.insert("inputRouting".into(), self.input_routing());
                }
            }
            KernelEvent::FileChanges {
                turn,
                files,
                rewindable,
            } => self.file_changes(turn.as_str(), files, *rewindable, &mut out),
            // 不改 App 的行与状态的事件（P1）。显式列出：内核加了事件时这里编译失败，要当场决定投不投（审查 E9）。
            KernelEvent::SessionCreated { .. }
            | KernelEvent::ToolProgress { .. }
            | KernelEvent::ContextNotice { .. }
            | KernelEvent::OutputSpeed { .. }
            | KernelEvent::TasksChanged { .. }
            | KernelEvent::BackgroundWork { .. }
            | KernelEvent::HistoryRewritten { .. }
            | KernelEvent::ScheduledFire { .. }
            | KernelEvent::SystemNotice { .. }
            | KernelEvent::WorkspaceChanged { .. }
            | KernelEvent::PeerHeldChanged { .. }
            | KernelEvent::TurnDuration(_)
            | KernelEvent::ModelNotice { .. } => {}
        }
        // Fork: row actions follow every change except streamed text (specs/fork-rust-agent-parity.md).
        let structural = !patch.is_empty()
            || out.iter().any(|delta| delta["op"] != "row.delta")
            || matches!(
                event.event,
                KernelEvent::CompactStarted { .. }
                    | KernelEvent::CompactDone { .. }
                    | KernelEvent::CompactFailed { .. }
            );
        if structural {
            self.refresh_actions(&mut out);
        }
        if event.revision != self.revision {
            self.revision = event.revision;
            patch.insert("revision".into(), json!(self.revision));
        }
        if !patch.is_empty() {
            out.push(json!({"op": "state.updated", "patch": patch}));
        }
        out
    }

    fn start_turn(
        &mut self,
        turn: &str,
        command: Option<String>,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        self.executions += 1;
        self.phase = Phase::Running;
        self.error = None;
        self.active = Some(ActiveWork {
            execution: format!("runtime_command_{}", self.executions),
            command: command.clone(),
            started_at: now,
        });
        self.turn = Some(Turn {
            id: turn.to_owned(),
            command: command.clone(),
            started_at: now,
            response: None,
            keys: Vec::new(),
        });
        let mut row = self.base(turn, turn, RowKind::TurnHeader, now, seq);
        row.insert("origin".into(), json!(RowKind::UserInput.as_str()));
        row.insert("executionKind".into(), json!("agent"));
        if let Some(command) = &command {
            row.insert("sourceCommandId".into(), json!(command));
        }
        row.insert("state".into(), json!("running"));
        row.insert("startedAt".into(), json!(now));
        self.append(turn_key(turn), row, out);
    }

    fn finish_turn(
        &mut self,
        turn: &str,
        outcome: &TurnOutcome,
        usage: Option<&Usage>,
        now: u64,
        out: &mut Vec<Value>,
    ) {
        if let Some(usage) = usage {
            self.total += *usage;
        }
        let (header, row_state, phase) = match outcome {
            // 工具的 hook 要求停止、Stop hook 阻止继续都不是失败，按成功结束投影（query.md §3，工作线 F131、F134）。
            TurnOutcome::Success | TurnOutcome::HookStopped | TurnOutcome::StopHookPrevented => {
                ("completedSuccess", "complete", Phase::CompletedSuccess)
            }
            TurnOutcome::Interrupted => (
                "completedInterrupted",
                "interrupted",
                Phase::CompletedInterrupted,
            ),
            TurnOutcome::Failed { message } => {
                self.error = Some(LastError {
                    message: message.clone(),
                    at: now,
                });
                ("failed", "failed", Phase::Error)
            }
        };
        self.phase = phase;
        self.active = None;
        let started = self.turn.as_ref().map_or(now, |turn| turn.started_at);
        let keys = self.turn.take().map(|turn| turn.keys).unwrap_or_default();
        for key in &keys {
            self.upsert(
                key,
                |row| match RowKind::of(row) {
                    Some(RowKind::AssistantText) => {
                        if row["state"] == "streaming" {
                            row.insert("state".into(), json!(row_state));
                        }
                    }
                    Some(RowKind::Reasoning) => {
                        if row["state"] == "streaming" {
                            let reasoning = if row_state == "failed" {
                                "interrupted"
                            } else {
                                row_state
                            };
                            row.insert("state".into(), json!(reasoning));
                        }
                    }
                    Some(RowKind::ToolCall) => {
                        if ToolStatus::of(row).is_some_and(ToolStatus::is_open) {
                            row.insert("status".into(), json!(ToolStatus::Cancelled.as_str()));
                            row.remove("approvalInteractionId");
                            row.insert("endedAt".into(), json!(now));
                        }
                    }
                    Some(RowKind::TurnHeader | RowKind::UserInput | RowKind::TimelineMarker)
                    | None => {}
                },
                out,
            );
        }
        let output_tokens = usage.map(|usage| usage.output_tokens);
        self.upsert(
            &turn_key(turn),
            |row| {
                row.insert("state".into(), json!(header));
                row.insert("endedAt".into(), json!(now));
                row.insert("activeMs".into(), json!(now.saturating_sub(started)));
                if let Some(tokens) = output_tokens {
                    row.insert("outputTokens".into(), json!(tokens));
                }
            },
            out,
        );
    }

    /// Fork: a checkpoint batch's file changes land on the turn header as the `fileChanges` summary
    /// (`turnHeaderRowSchema.fileChanges`; Node puts it there from ModelComplete). Counts are summed per path
    /// across the turn's batches and a path is counted once; an empty batch publishes nothing.
    fn file_changes(
        &mut self,
        turn: &str,
        files: &[FileChange],
        rewindable: bool,
        out: &mut Vec<Value>,
    ) {
        let summary = {
            let changes = self.turn_file_changes.entry(turn.to_owned()).or_default();
            changes.rewindable |= rewindable;
            for file in files {
                let counts = changes.files.entry(file.path.clone()).or_insert((0, 0));
                counts.0 = counts.0.saturating_add(file.additions);
                counts.1 = counts.1.saturating_add(file.deletions);
            }
            if changes.files.is_empty() {
                return;
            }
            let (additions, deletions) = changes
                .files
                .values()
                .fold((0, 0), |(add, del), (file_add, file_del)| {
                    (add + file_add, del + file_del)
                });
            json!({
                "additions": additions,
                "deletions": deletions,
                "files": changes.files.len(),
                "state": "active",
            })
        };
        self.upsert(
            &turn_key(turn),
            |row| {
                row.insert("fileChanges".into(), summary);
            },
            out,
        );
    }

    /// 队列（`queueStateSchema`）：内核的排队输入加上 sendText 时记下的事实。
    fn queue_state(&self) -> Value {
        let items: Vec<Value> = self
            .queue
            .iter()
            .filter(|item| {
                self.inputs
                    .get(item.command.as_str())
                    .is_none_or(|meta| meta.admitted != "startNow")
            })
            .map(|item| {
                let command = item.command.as_str();
                let meta = self.inputs.get(command);
                let mut value = json!({
                    "sourceCommandId": command,
                    "queueItemId": format!("queue_{command}"),
                    "clientId": meta.map_or("unknown", |meta| meta.client.as_str()),
                    "kind": "sendText",
                    "text": item.text,
                    // Fork: a queued input is not stored yet; its chips are the refs it was sent with.
                    "attachments": meta.map_or_else(Vec::new, |meta| meta.attachments.clone()),
                    "delivery": {
                        "requested": meta.map_or("queue", |meta| meta.requested),
                        "admitted": meta.map_or("queue", |meta| meta.admitted),
                    },
                    "order": {"admissionSeq": 0},
                    "steer": {"state": "notRequested"},
                    "dispatch": {"state": "queued"},
                    "admittedAt": meta.map_or(self.created_at, |meta| meta.admitted_at),
                });
                if let Some(meta) = meta {
                    if let Some(origin) = &meta.origin {
                        value["inputOrigin"] = json!(origin);
                    }
                    if let Some(selection) = &meta.selection {
                        value["modelSelection"] = selection.clone();
                    }
                    if let Some(mode) = &meta.mode {
                        value["mode"] = json!(mode);
                    }
                    if let Some(plan) = meta.plan {
                        value["planEnabled"] = json!(plan);
                    }
                }
                value
            })
            .collect();
        let mut queue = json!({"items": items, "autoDrain": self.auto_drain});
        if let Some(reason) = self.pause_reason.filter(|_| !self.auto_drain) {
            queue["pauseReason"] = json!(reason);
        }
        queue
    }

    /// 快照（`conversationSnapshotSchema`）：`seq` 是主题的序号，`epoch` 是主题的代际标识。
    pub fn snapshot(&self, seq: u64, epoch: &str) -> Value {
        let start = self.rows.len().saturating_sub(WINDOW_ROWS);
        json!({
            "protocolVersion": 1,
            "sessionId": self.session,
            "logEpoch": epoch,
            "seq": seq,
            "revision": self.revision,
            "control": self.control(),
            "availability": state::availability(),
            "inputRouting": self.input_routing(),
            "meta": state::meta(&self.title, true),
            "config": self.config(),
            "modelTransition": null,
            "usage": state::usage(self.context, &self.total),
            "queue": self.queue_state(),
            "pendingInteractions": self.pending,
            "pendingCommands": [],
            "backgroundWorks": [],
            "subagents": {"revision": 0, "childSessionIds": [], "running": [], "endedTotal": 0},
            "goal": null,
            "plan": null,
            "workspaceHookAdmission": null,
            "rows": {
                "window": &self.rows[start..],
                "totalCount": self.rows.len(),
                "firstRowId": self.rows.first().map(|row| row["rowId"].clone()),
            },
        })
    }
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "file_changes_tests.rs"]
mod file_changes_tests;
