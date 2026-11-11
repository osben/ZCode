//! 会话投影（docs/specs/rust-cli/app-protocol.md §6.1）：内核事件 → App 的行与状态。纯计算：`(投影, 事件) → (投影',
//! 增量)`，从 [`SessionView`] 能重建（[`cold`]），所以不是第二份事实。revision 只来自事件（会话 actor 是 owner，G1）。
//!
//! 行：turnHeader（回合）、userInput（真人输入）、assistantText、reasoning、toolCall；其余事件只改状态或忽略（P1）。

mod actions;
mod background_result;
mod background_shells;
mod bash_progress;
mod cold;
pub mod elicitation;
mod goal_verify;
mod kinds;
mod markers;
mod model_change;
mod plans;
mod rows;
pub(crate) mod rows_range;
pub mod state;
mod subagent_rows;

use std::collections::HashMap;

use rust_cli_kernel_api::message::{
    CompactTrigger, ContentBlock, Usage, text_of as text_of_result,
};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    FileChange, KernelEvent, QueuedInput, QueuedKind, SequencedEvent, SessionView, TurnOutcome,
};
use serde_json::{Map, Value, json};

pub use actions::{RowAction, RowTarget, TargetMiss};
use kinds::{RowKind, ToolStatus};
use state::{ActiveWork, Followup, LastError, Phase};

/// Node's `PROTOCOL_V4_LIMITS.snapshotTailWindowRows`: the snapshot's row window; older rows come from `rowsRange`.
const WINDOW_ROWS: usize = 60;

/// sendText 带来的输入的事实（行与队列项要用）。
#[derive(Debug, Clone, PartialEq)]
pub struct InputMeta {
    pub client: String,
    pub origin: Option<String>,
    pub text: String,
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
    /// Fork: every checkpoint of the turn was restored (`KernelEvent::TurnFilesReverted`); the
    /// header shows `state: "reverted"` and stops offering the rewind-files action.
    reverted: bool,
    /// Fork: the message that opened the turn (`KernelEvent::FileChanges::turn_input`); the
    /// per-turn file queries' kernel anchor when the turn has no typed user row.
    anchor: Option<String>,
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
    /// Fork: `originMeta` of each notification that opened this turn, in arrival order
    /// (background_result.rs); `None` for one the UI does not title.
    notified: Vec<Option<Value>>,
    /// Fork: the output tokens of the turn's model responses so far (`None` before the first one).
    output_tokens: Option<u64>,
    /// Fork: the turn makes no model call (`KernelEvent::TurnControlOnly`, Node `executionKind: "controlOnly"`).
    control_only: bool,
    /// Fork: the text and reasoning rows of the turn's latest assistant message when it was stored without a stop
    /// reason (a reply cut off by Stop, `finish_aborted`). An interrupted turn closes them `interrupted`, like Node's
    /// `closeStreamingRows`.
    unstopped: Vec<String>,
    /// Fork: tool rows whose result is the rejection text (`REJECT_MESSAGE`, an error result). An interrupted turn
    /// settles them `cancelled` without output, like Node's `ToolCancelled` (the query answers a call cut off by Stop
    /// with that text).
    rejected: Vec<String>,
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
    /// Fork: where `title` came from (the view's, then each `TitleChanged`), for the meta and the summary.
    title_source: rust_cli_kernel_api::title::Source,
    selection: ModelSelection,
    mode: PermissionMode,
    plan: bool,
    /// Fork: the last full-access grant (`config.permissionGrant`), the composer's one-shot
    /// adoption key; protocol memory like Node's runtime `lastPermissionGrantId`.
    permission_grant: Option<String>,
    /// Fork: the last plan tool transition (`config.planTransition`: call id, plan switch).
    plan_transition: Option<(String, bool)>,
    /// Fork: the desktop goal (snapshot `goal`), from the view and `KernelEvent::GoalChanged`.
    goal: Option<rust_cli_kernel_api::goal::GoalState>,
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
    /// user stop held it (specs/stop-queue-hold.md), `error` after a failed turn held it.
    pause_reason: Option<&'static str>,
    created_at: u64,
    /// Fork: a compaction is running (row actions are withheld, like Node's `compact` active work).
    compacting: bool,
    /// Fork: the running turn is a manual `/compact`; its failure does not pause the queue (Node pauses on a
    /// main turn error only).
    compact_turn: bool,
    /// Fork: compaction markers so far; the running one is `compact:<count>` (projection/markers.rs).
    compactions: u64,
    /// Fork: the provider and model of the last started turn (Node `lastTurnModel`, projection/model_change.rs).
    last_turn_model: Option<(String, String)>,
    /// Fork: a subagent child session whose first turn has not started; it gets the source-less "Using" marker
    /// (Node `lastTurnModel` `sourceLess`, projection/model_change.rs).
    initial_model_marker: bool,
    /// Fork: the parent of a forked session, for its fork divider (projection/markers.rs).
    fork_parent: Option<String>,
    /// Fork: the start time of the running goal completion verification (projection/goal_verify.rs).
    goal_verifier: Option<u64>,
    /// Fork: the last verification request failed (Node's phase `error` with `sessionEnded: false`).
    goal_verifier_failed: bool,
    /// Fork: the model directory; `thoughtLevels` are the selected model's levels in it (Node `listThoughtLevels`).
    catalog: std::sync::Arc<[rust_cli_kernel_api::provider::CatalogModel]>,
    /// Fork: file changes per turn (`KernelEvent::FileChanges`): feed the turn header's `fileChanges` summary and
    /// the `canRewindFiles` action (`projection/actions.rs`).
    turn_file_changes: HashMap<String, TurnFileChanges>,
    /// Fork: subagent rows and the snapshot `subagents` manifest (projection/subagent_rows.rs).
    subagents: subagent_rows::Subagents,
    shells: background_shells::Shells,
    /// Fork: the tool call each streaming `tool_use` block opened (turn, response, block index), so its `InputJson`
    /// deltas append to that row's `inputText` (Node `tool_input_delta`, projection/rows.rs).
    streaming_tools: HashMap<(String, u32, usize), rows::StreamingTool>,
    /// Fork: per user message id, what each of its attachments reads from (the stored `file` parts), for
    /// `v4/conversation/attachmentRead` / `attachmentStat` (attachments.rs).
    attachment_sources: HashMap<String, Vec<AttachmentSource>>,
}

/// Fork: one attachment of a `userInput` row as its stored `file` part has it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentSource {
    /// The part's MIME ([`rust_cli_kernel_api::prompt_attachment::part_mime`]).
    pub mime: String,
    /// The artifact or path a read opens ([`rust_cli_kernel_api::prompt_attachment::part_source`]).
    pub source: Option<String>,
}

/// user 与 assistant 消息里的文字块，以换行接起来（`session/read` 的旧快照也用它）。
pub(crate) fn text_of(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            ContentBlock::Image { .. }
            | ContentBlock::Video { .. }
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

/// Node's queued goal text: the typed `/goal X`, or `/goal ` before the objective when the text lost its command.
fn queued_goal_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.starts_with("/goal") {
        trimmed.to_owned()
    } else {
        format!("/goal {trimmed}")
    }
}

fn turn_key(turn: &str) -> String {
    format!("turn:{turn}")
}

/// Fork: the turn header's `fileChanges` JSON (`turnHeaderRowSchema.fileChanges`): totals over the
/// per-path counts and the turn's restore state.
fn summary_json(changes: &TurnFileChanges) -> Value {
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
        "state": if changes.reverted { "reverted" } else { "active" },
    })
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
            .permission_grant
            .clone_from(&self.permission_grant);
        projection.plan_transition.clone_from(&self.plan_transition);
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
            title_source: view
                .title_source
                .unwrap_or_else(|| rust_cli_kernel_api::title::Source::derived(&view.meta.title)),
            selection: view.selection.clone(),
            mode: view.mode,
            plan: view.plan,
            permission_grant: None,
            plan_transition: None,
            goal: view.goal.clone(),
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
            compact_turn: false,
            compactions: 0,
            last_turn_model: None,
            initial_model_marker: view.meta.kind
                == rust_cli_kernel_api::store::SessionKind::Subagent,
            fork_parent: view
                .meta
                .parent
                .as_ref()
                .filter(|_| view.meta.kind == rust_cli_kernel_api::store::SessionKind::Fork)
                .map(|parent| parent.as_str().to_owned()),
            streaming_tools: HashMap::new(),
            goal_verifier: None,
            goal_verifier_failed: false,
            catalog: std::sync::Arc::from(Vec::new()),
            auto_drain: true,
            pause_reason: None,
            turn_file_changes: HashMap::new(),
            subagents: subagent_rows::Subagents::default(),
            shells: background_shells::Shells::default(),
            attachment_sources: HashMap::new(),
        };
        cold::rows(&mut projection, view);
        projection.adopt_turn_files(view);
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

    pub fn title_source(&self) -> rust_cli_kernel_api::title::Source {
        self.title_source
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

    /// Fork: the MIME of an attachment ref a `userInput` row of this session carries (`attachmentRead` serves only these),
    /// and whether that chip marks text material (a `sourceKind`, which only a live row carries).
    pub fn attachment_mime(&self, reference: &str) -> Option<(String, bool)> {
        self.rows.iter().find_map(|row| {
            row.get("attachments")?
                .as_array()?
                .iter()
                .find_map(|attachment| {
                    (attachment["ref"] == reference || attachment["previewRef"] == reference).then(
                        || {
                            (
                                attachment["mime"].as_str().unwrap_or_default().to_owned(),
                                attachment.get("sourceKind").is_some(),
                            )
                        },
                    )
                })
        })
    }

    /// Fork: the first attachment of a `userInput` row whose `ref` or `previewRef` is `reference` (Node
    /// `resolveReadableMediaAttachment` without a row target): its chip MIME and its stored source.
    pub fn attachment_source(&self, reference: &str) -> Option<AttachmentSource> {
        self.rows.iter().find_map(|row| {
            if RowKind::of(row) != Some(RowKind::UserInput) {
                return None;
            }
            let index = row
                .get("attachments")?
                .as_array()?
                .iter()
                .position(|chip| chip["ref"] == reference || chip["previewRef"] == reference)?;
            self.attachment_sources
                .get(row["entityId"].as_str()?)?
                .get(index)
                .cloned()
        })
    }

    /// Fork: the attachment at `index` of the `userInput` row `(row_id, entity)` when the App's `reference` is its
    /// `ref` or `previewRef` (Node `conversationAttachmentRead` / `conversationAttachmentStat` authorisation): its chip
    /// MIME and its stored source.
    pub fn row_attachment(
        &self,
        row_id: u64,
        entity: &str,
        index: usize,
        reference: &str,
    ) -> Option<AttachmentSource> {
        self.row_chip(row_id, entity, index, reference)?;
        self.attachment_sources
            .get(entity)
            .and_then(|sources| sources.get(index))
            .cloned()
    }

    /// Fork: the chip at `index` of the `userInput` row `(row_id, entity)` when the App's `reference` is its `ref` or
    /// `previewRef` (Node `resolveReadableMediaAttachment` with a row target): its MIME and whether it marks text
    /// material, as [`Self::attachment_mime`].
    pub fn row_chip_mime(
        &self,
        row_id: u64,
        entity: &str,
        index: usize,
        reference: &str,
    ) -> Option<(String, bool)> {
        let chip = self.row_chip(row_id, entity, index, reference)?;
        Some((
            chip["mime"].as_str().unwrap_or_default().to_owned(),
            chip.get("sourceKind").is_some(),
        ))
    }

    fn row_chip(&self, row_id: u64, entity: &str, index: usize, reference: &str) -> Option<&Value> {
        let row = self
            .rows
            .iter()
            .find(|row| row["rowId"].as_u64() == Some(row_id) && row["entityId"] == entity)?;
        if RowKind::of(row) != Some(RowKind::UserInput) {
            return None;
        }
        let chip = row.get("attachments")?.as_array()?.get(index)?;
        (chip["ref"] == reference || chip["previewRef"] == reference).then_some(chip)
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
            self.goal_verifier.is_some(),
        )
    }

    /// Fork: the model, permission mode and plan switch the projection shows, so a switch command can
    /// answer `config.unchanged` the way Node does.
    pub fn current_config(&self) -> (ModelSelection, PermissionMode, bool) {
        (self.selection.clone(), self.mode, self.plan)
    }

    fn config(&self) -> Value {
        let mut config = state::config(
            &self.selection,
            self.mode,
            self.plan,
            self.followup,
            &self.thought_levels(),
        );
        if let Some(interaction) = &self.permission_grant {
            config["permissionGrant"] = json!({"interactionId": interaction});
        }
        if let Some((tool_call, enabled)) = &self.plan_transition {
            config["planTransition"] = json!({"toolCallId": tool_call, "planEnabled": enabled});
        }
        config
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

    /// Fork: the directory entry of `selection` (a subagent run's own model, crate::telemetry).
    pub(crate) fn catalog_entry_for(
        &self,
        selection: &ModelSelection,
    ) -> Option<&rust_cli_kernel_api::provider::CatalogModel> {
        self.catalog
            .iter()
            .find(|entry| rust_cli_kernel_api::model_name::is_entry(selection, entry))
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
        let mut control = state::control(
            self.phase,
            self.active.as_ref(),
            self.error.as_ref(),
            self.goal_verifier,
        );
        if self.goal_verifier_failed && self.phase == Phase::Error {
            control["sessionEnded"] = json!(false);
        }
        control
    }

    /// Fork: the session actions for the current phase, compaction and goal.
    fn availability(&self) -> Value {
        let goal = self.goal_json();
        state::availability(self.phase, self.compacting, goal["status"].as_str())
    }

    /// Fork: the snapshot `goal` (Node `goalStateSchema`).
    fn goal_json(&self) -> Value {
        let Some(goal) = &self.goal else {
            return Value::Null;
        };
        let status = serde_json::to_value(goal.status).unwrap_or(Value::Null);
        json!({
            "targetId": goal.target,
            "objective": goal.objective,
            "summaryTitle": goal.summary_title,
            "timeUsedSeconds": goal.time_used_seconds,
            "activeRunStartedAtMs": goal.active_run_started_at_ms,
            "status": status,
            "iteration": goal.iteration,
            "verifications": self.verifications_json(goal),
            "iterations": [],
        })
    }

    /// 回合的开始、结束等改变阶段的事件：control、availability 与 inputRouting 一起换。
    fn phase_patch(&self, patch: &mut Map<String, Value>) {
        patch.insert("control".into(), self.control());
        patch.insert("availability".into(), self.availability());
        patch.insert("inputRouting".into(), self.input_routing());
    }

    /// 一个事件 → 增量（`row.*` 与 `state.updated`）。`now` 是行的时间。
    pub fn apply(&mut self, event: &SequencedEvent, now: u64) -> Vec<Value> {
        let mut out = Vec::new();
        let mut patch = Map::new();
        let seq = event.seq;
        match &event.event {
            KernelEvent::TurnStarted { turn, command } => {
                self.goal_verifier_failed = false;
                self.compact_turn = false;
                let selection = Some(self.selection.clone());
                self.start_turn(
                    turn.as_str(),
                    command.as_ref().map(|c| c.as_str().to_owned()),
                    selection,
                    now,
                    seq,
                    &mut out,
                );
                self.phase_patch(&mut patch);
            }
            KernelEvent::TurnControlOnly { turn } => self.control_only(turn.as_str(), &mut out),
            KernelEvent::MessageDone { message } => self.message(message, now, seq, &mut out),
            KernelEvent::StreamDelta {
                turn,
                response,
                index,
                delta,
            } => self.stream(turn.as_str(), *response, *index, delta, now, seq, &mut out),
            KernelEvent::ToolInputStarted {
                turn,
                response,
                index,
                tool_use,
                name,
            } => self.streaming_tool_row(
                turn.as_str(),
                *response,
                *index,
                tool_use.as_str(),
                name,
                now,
                seq,
                &mut out,
            ),
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
                        // Fork: a row opened while the input streamed gets the final input (Node's scheduled call).
                        if ToolStatus::of(row) == Some(ToolStatus::InputStreaming) {
                            row.insert("inputText".into(), json!(input.to_string()));
                            row.insert("input".into(), input.clone());
                        }
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
                self.remember_shell_title(tool_use.as_str(), &text);
                // Fork: Node's `buildToolOutput` carries the result display on the row output (all
                // kinds but `node_repl_images`; the App drops kinds it does not know), so the desktop
                // renders Bash's `bash_output` window (specs/fork-rust-agent-parity.md).
                let mut settled = json!({"text": text});
                if !output.display.is_null() && output.display["kind"] != "node_repl_images" {
                    settled["display"] = output.display.clone();
                }
                // Fork: a plan-mode policy denial is Node's `PermissionDenied` (`settlePermission(.., "cancelled")`):
                // the row is cancelled without output, not a failed tool. The stored result carries only its text,
                // so the cold read settles it by the same text.
                let plan_denied =
                    output.is_error && text == rust_cli_kernel_api::tool::PLAN_MODE_READ_ONLY;
                let status = if self.denied.remove(tool_use.as_str()) || plan_denied {
                    ToolStatus::Cancelled
                } else if output.is_error {
                    ToolStatus::Error
                } else {
                    ToolStatus::Success
                };
                if status == ToolStatus::Error
                    && text == rust_cli_kernel_api::tool::REJECT_MESSAGE
                    && let Some(turn) = self.turn.as_mut()
                {
                    turn.rejected.push(tool_key(tool_use.as_str()));
                }
                self.upsert(
                    &tool_key(tool_use.as_str()),
                    |row| {
                        row.insert("status".into(), json!(status.as_str()));
                        if !plan_denied {
                            row.insert("output".into(), settled);
                            row.insert("endedAt".into(), json!(now));
                        }
                        row.remove("approvalInteractionId");
                    },
                    &mut out,
                );
                let child = match status {
                    ToolStatus::Cancelled => "cancelled",
                    ToolStatus::Error => "failed",
                    _ => "success",
                };
                self.subagent_result(
                    tool_use.as_str(),
                    &output.display,
                    child,
                    now,
                    seq,
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
                // Fork: a compaction still running when its turn ends was stopped with it; Node settles its
                // marker as `cancelled` (an interrupted compaction) and drops the compact work.
                if self.compacting {
                    self.compacting = false;
                    let status = if matches!(outcome, TurnOutcome::Interrupted) {
                        "cancelled"
                    } else {
                        "failed"
                    };
                    self.compact_settled(status, &mut out);
                    patch.insert("availability".into(), self.availability());
                }
                // Fork: the session actor held the waiting inputs after a failed main turn (Node `onTurnError`).
                let paused = matches!(outcome, TurnOutcome::Failed { .. })
                    && !std::mem::take(&mut self.compact_turn)
                    && self.auto_drain
                    && self.has_queue();
                self.finish_turn(turn.as_str(), outcome, usage.as_ref(), now, &mut out);
                self.phase_patch(&mut patch);
                if paused {
                    self.auto_drain = false;
                    self.pause_reason = Some("error");
                    patch.insert("queue".into(), self.queue_state());
                    patch.insert("inputRouting".into(), self.input_routing());
                }
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
                window_tokens,
            } => {
                self.context = Some(rust_cli_kernel_api::compaction::ContextOccupancy {
                    used_tokens: *used_tokens,
                    max_tokens: *max_tokens,
                    compact_at: *compact_at,
                    window_tokens: *window_tokens,
                });
                patch.insert("usage".into(), state::usage(self.context, &self.total));
            }
            KernelEvent::TitleChanged { title, source } => {
                // Node `onSessionTitleUpdated`: once custom, an automatic title does not replace it.
                let custom = rust_cli_kernel_api::title::Source::Custom;
                if self.title_source != custom || source.shown() != "generated" {
                    self.title.clone_from(title);
                    self.title_source = *source;
                    patch.insert("meta".into(), state::meta(&self.title, self.title_source));
                }
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
            KernelEvent::PermissionGranted { interaction } => {
                self.permission_grant = Some(interaction.clone());
                patch.insert("config".into(), self.config());
            }
            KernelEvent::PlanTransition { tool_call, enabled } => {
                self.plan_transition = Some((tool_call.clone(), *enabled));
                patch.insert("config".into(), self.config());
            }
            KernelEvent::GoalVerification { verification, .. } => {
                self.goal_verification(verification, now, seq, &mut out);
                self.phase_patch(&mut patch);
            }
            KernelEvent::GoalChanged { goal } => {
                self.goal.clone_from(goal);
                patch.insert("goal".into(), self.goal_json());
                patch.insert("availability".into(), self.availability());
            }
            // Fork: only the row actions follow a compaction (specs/fork-rust-agent-parity.md).
            KernelEvent::CompactStarted { trigger } => {
                self.compacting = true;
                self.compact_turn |= matches!(trigger, CompactTrigger::Manual);
                self.compact_started(*trigger, now, seq, &mut out);
                patch.insert("availability".into(), self.availability());
            }
            KernelEvent::CompactDone { .. } => {
                self.compacting = false;
                self.compact_settled("success", &mut out);
                patch.insert("availability".into(), self.availability());
            }
            KernelEvent::CompactFailed { .. } => {
                self.compacting = false;
                self.compact_settled("failed", &mut out);
                patch.insert("availability".into(), self.availability());
            }
            KernelEvent::CompactSkipped { trigger } => {
                // A `/compact` announces its marker first; a skipped one settles it as `noop`.
                if self.compacting {
                    self.compacting = false;
                    self.compact_settled("noop", &mut out);
                    patch.insert("availability".into(), self.availability());
                } else {
                    self.compact_skipped(*trigger, now, seq, &mut out);
                }
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
                turn_input,
            } => self.file_changes(
                turn.as_str(),
                files,
                *rewindable,
                turn_input.as_ref().map(|input| input.as_str().to_owned()),
                &mut out,
            ),
            KernelEvent::BackgroundWork { work, status } => self.remember_ended(work, *status),
            KernelEvent::TurnFilesReverted { turn_input } => {
                self.turn_files_reverted(turn_input.as_str(), &mut out);
            }
            KernelEvent::ToolProgress { tool_use, progress } => {
                self.bash_progress(tool_use.as_str(), &progress.data, &mut out);
                self.subagent_progress(tool_use.as_str(), &progress.data, now, seq, &mut out);
            }
            // 不改 App 的行与状态的事件（P1）。显式列出：内核加了事件时这里编译失败，要当场决定投不投（审查 E9）。
            KernelEvent::SessionCreated { .. }
            | KernelEvent::ContextNotice { .. }
            | KernelEvent::OutputSpeed { .. }
            | KernelEvent::TasksChanged { .. }
            | KernelEvent::HistoryRewritten { .. }
            | KernelEvent::ScheduledFire { .. }
            | KernelEvent::SystemNotice { .. }
            | KernelEvent::WorkspaceChanged { .. }
            | KernelEvent::PeerHeldChanged { .. }
            | KernelEvent::TurnDuration(_)
            | KernelEvent::ModelNotice { .. } => {}
        }
        if let Some(manifest) = self.materialize_subagents() {
            patch.insert("subagents".into(), manifest);
        }
        // Fork: row actions follow every change except streamed text (specs/fork-rust-agent-parity.md).
        let structural = !patch.is_empty()
            || out.iter().any(|delta| delta["op"] != "row.delta")
            || matches!(
                event.event,
                KernelEvent::CompactStarted { .. }
                    | KernelEvent::CompactDone { .. }
                    | KernelEvent::CompactFailed { .. }
                    | KernelEvent::CompactSkipped { .. }
            );
        if structural {
            self.refresh_actions(&mut out);
        }
        self.clear_settled_output_previews(&mut out);
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
        selection: Option<ModelSelection>,
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
            notified: Vec::new(),
            output_tokens: None,
            control_only: false,
            unstopped: Vec::new(),
            rejected: Vec::new(),
        });
        self.model_change(turn, selection, now, seq, out);
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

    /// Fork: Node's `/goal X` control turn: its header carries `executionKind: "controlOnly"`, which the App shows
    /// without a work footer.
    fn control_only(&mut self, turn: &str, out: &mut Vec<Value>) {
        let Some(live) = self.turn.as_mut().filter(|live| live.id == turn) else {
            return;
        };
        live.control_only = true;
        self.upsert(
            &turn_key(turn),
            |row| {
                row.insert("executionKind".into(), json!("controlOnly"));
            },
            out,
        );
    }

    fn finish_turn(
        &mut self,
        turn: &str,
        outcome: &TurnOutcome,
        usage: Option<&Usage>,
        now: u64,
        out: &mut Vec<Value>,
    ) {
        // A control turn made no request: the usage the kernel reports is an earlier response's.
        let control_only = self.turn.as_ref().is_some_and(|live| live.control_only);
        let usage = usage.filter(|_| !control_only);
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
            TurnOutcome::Failed { message, code } => {
                self.error = Some(LastError {
                    message: message.clone(),
                    code: code.clone(),
                    at: now,
                });
                ("failed", "failed", Phase::Error)
            }
        };
        self.phase = phase;
        self.active = None;
        let started = self.turn.as_ref().map_or(now, |turn| turn.started_at);
        let summed = self.turn.as_ref().and_then(|turn| turn.output_tokens);
        let (keys, unstopped, rejected) = self
            .turn
            .take()
            .map(|turn| (turn.keys, turn.unstopped, turn.rejected))
            .unwrap_or_default();
        if row_state == "interrupted" {
            for key in &rejected {
                self.upsert(
                    key,
                    |row| {
                        if ToolStatus::of(row) == Some(ToolStatus::Error) {
                            row.insert("status".into(), json!(ToolStatus::Cancelled.as_str()));
                            row.remove("output");
                            row.remove("error");
                        }
                    },
                    out,
                );
            }
        }
        for key in &keys {
            // Fork: a stopped turn's cut-off reply settled `complete` on commit; Node closes it `interrupted`.
            let cut_off = row_state == "interrupted" && unstopped.contains(key);
            self.upsert(
                key,
                |row| match RowKind::of(row) {
                    Some(RowKind::AssistantText) => {
                        if row["state"] == "streaming" || cut_off {
                            row.insert("state".into(), json!(row_state));
                        }
                    }
                    Some(RowKind::Reasoning) => {
                        if row["state"] == "streaming" || cut_off {
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
                    Some(RowKind::Subagent) => Self::settle_open_subagent(row, now),
                    Some(RowKind::TurnHeader | RowKind::UserInput | RowKind::TimelineMarker)
                    | None => {}
                },
                out,
            );
        }
        let output_tokens = summed.or_else(|| usage.map(|usage| usage.output_tokens));
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
        anchor: Option<String>,
        out: &mut Vec<Value>,
    ) {
        let summary = {
            let changes = self.turn_file_changes.entry(turn.to_owned()).or_default();
            changes.rewindable |= rewindable;
            if changes.anchor.is_none() {
                changes.anchor = anchor;
            }
            for file in files {
                let counts = changes.files.entry(file.path.clone()).or_insert((0, 0));
                counts.0 = counts.0.saturating_add(file.additions);
                counts.1 = counts.1.saturating_add(file.deletions);
            }
            if changes.files.is_empty() {
                return;
            }
            summary_json(changes)
        };
        self.upsert(
            &turn_key(turn),
            |row| {
                row.insert("fileChanges".into(), summary);
            },
            out,
        );
    }

    /// Fork: the turn header's `fileChanges` JSON of one turn's merged counts.
    fn summary_of(&self, turn: &str) -> Option<Value> {
        self.turn_file_changes.get(turn).map(summary_json)
    }

    /// Fork: the turn's checkpoints were all restored (`KernelEvent::TurnFilesReverted`): the turn
    /// header's `fileChanges` state flips to `reverted`, and the next actions recompute drops
    /// `canRewindFiles` (it is offered only for `state: "active"`).
    fn turn_files_reverted(&mut self, turn_input: &str, out: &mut Vec<Value>) {
        let turn = self
            .rows
            .iter()
            .find_map(|row| {
                (RowKind::of(row) == Some(RowKind::UserInput)
                    && row["origin"] == "realUser"
                    && row["entityId"] == turn_input)
                    .then(|| row["turnId"].as_str().map(str::to_owned))
                    .flatten()
            })
            .or_else(|| {
                self.turn_file_changes
                    .iter()
                    .find(|(_, changes)| changes.anchor.as_deref() == Some(turn_input))
                    .map(|(turn, _)| turn.clone())
            });
        let Some(turn) = turn else {
            return;
        };
        if let Some(changes) = self.turn_file_changes.get_mut(&turn) {
            changes.reverted = true;
        }
        let recomputed = self.summary_of(&turn);
        self.upsert(
            &turn_key(&turn),
            |row| match recomputed {
                Some(summary) => {
                    row.insert("fileChanges".into(), summary);
                }
                None => {
                    if let Some(summary) = row.get_mut("fileChanges").and_then(Value::as_object_mut)
                    {
                        summary.insert("state".into(), json!("reverted"));
                    }
                }
            },
            out,
        );
    }

    /// Fork: the finished turns' file summaries from the session view (a cold open, or the rebuild
    /// after a history rewrite): the kernel keeps them per typed user message; the rows need them
    /// on the turn headers, keyed by the turn ids the cold rows were built with.
    fn adopt_turn_files(&mut self, view: &SessionView) {
        for (prompt, facts) in &view.turn_files {
            let Some(turn) = self.rows.iter().find_map(|row| {
                (RowKind::of(row) == Some(RowKind::UserInput)
                    && row["origin"] == "realUser"
                    && row["entityId"] == prompt.as_str())
                .then(|| row["turnId"].as_str().map(str::to_owned))
                .flatten()
            }) else {
                continue;
            };
            let entry = self.turn_file_changes.entry(turn.clone()).or_default();
            entry.rewindable = facts.rewindable;
            entry.reverted = facts.reverted;
            for file in &facts.files {
                let counts = entry.files.entry(file.path.clone()).or_insert((0, 0));
                counts.0 = counts.0.saturating_add(file.additions);
                counts.1 = counts.1.saturating_add(file.deletions);
            }
            if entry.files.is_empty() {
                continue;
            }
            let summary = summary_json(entry);
            let mut out = Vec::new();
            self.upsert(
                &turn_key(&turn),
                |row| {
                    row.insert("fileChanges".into(), summary);
                },
                &mut out,
            );
        }
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
                let goal_text = queued_goal_text(&item.text);
                // Fork: kind and the frozen execution state come from the kernel's item (one owner).
                let (kind, text) = match item.kind {
                    QueuedKind::Text => ("sendText", item.text.as_str()),
                    // Node's queue item shows the typed `/goal X` (publisher `displayText`).
                    QueuedKind::Goal => ("sendGoalCommand", goal_text.as_str()),
                    QueuedKind::Compact => ("compact", "/compact"),
                };
                let mut value = json!({
                    "sourceCommandId": command,
                    "queueItemId": format!("queue_{command}"),
                    "clientId": meta.map_or("unknown", |meta| meta.client.as_str()),
                    "kind": kind,
                    "text": text,
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
                if let Some(origin) = meta.and_then(|meta| meta.origin.as_ref()) {
                    value["inputOrigin"] = json!(origin);
                }
                if let Some(execution) = &item.execution {
                    if let Some(selection) = &execution.selection {
                        value["modelSelection"] = state::selection(selection);
                    }
                    value["mode"] = json!(state::mode_name(execution.state.mode));
                    value["planEnabled"] = json!(execution.state.plan);
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
            "availability": self.availability(),
            "inputRouting": self.input_routing(),
            "meta": state::meta(&self.title, self.title_source),
            "config": self.config(),
            "modelTransition": null,
            "usage": state::usage(self.context, &self.total),
            "queue": self.queue_state(),
            "pendingInteractions": self.pending,
            "pendingCommands": [],
            "backgroundWorks": self.background_works_value(),
            "subagents": self.subagents.manifest.to_value(),
            "goal": self.goal_json(),
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
