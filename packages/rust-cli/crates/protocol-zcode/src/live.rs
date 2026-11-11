//! 打开着的会话：会话桥的接收方。每个会话一份投影与一个 `conversation/<sessionId>` 主题；内核事件 → 投影 → 增量，
//! 窗口到期时发给已经开始的订阅者；会话列表的行变了时更新会话列表。
//!
//! 投影与主题日志在一把锁里，只在计算时短暂持有；发帧的工作（事件、窗口、首帧、协议配置的变化）都在会话的泵任务里按
//! 顺序做（protocol-core 的会话桥），所以首帧之后的增量只给一次，首帧与增量不交错。

use rust_cli_base::sync::LockUnpoisoned;
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use rust_cli_kernel_api::session_api::{KernelEvent, SequencedEvent, SessionHandle, SessionView};
use rust_cli_protocol_core::delivery::TopicLog;
use rust_cli_protocol_core::sessions::SessionSink;
use serde_json::{Value, json};

use crate::context::Context;
use crate::index::{Summary, Topics};
use crate::projection::state::{Followup, Phase};
use crate::projection::{InputMeta, Projection};
use crate::telemetry::{Observed, Provider, Role, Telemetry};
use crate::wire::Purpose;

/// Fork: the session ID prefix of a subagent's child session (node-store `NodeIds::subagent`).
const SUBAGENT_SESSION_PREFIX: &str = "sess_subagent_";

/// Fork: whether a session's summary goes to the sessions index. A subagent's child session is not a task: Node's
/// cold list skips `subagent_child` and its gateway publishes no index row for it, so the sidebar lists only the parent.
pub(crate) fn listed_in_sessions_index(kind: rust_cli_kernel_api::store::SessionKind) -> bool {
    kind != rust_cli_kernel_api::store::SessionKind::Subagent
}

/// Fork: the selected model as the telemetry facts name it (crate::telemetry).
fn provider_of(projection: &Projection) -> Provider {
    use rust_cli_kernel_api::provider::WireProtocol;
    let (selection, _, _) = projection.current_config();
    let entry = projection.catalog_entry();
    Provider {
        provider: selection.provider,
        model: selection.model,
        kind: entry.map(|entry| {
            match entry.protocol {
                WireProtocol::AnthropicMessages => "anthropic",
                WireProtocol::OpenAiChatCompletions => "openai-compatible",
                WireProtocol::OpenAiResponses => "openai-responses",
            }
            .to_owned()
        }),
        host: entry.and_then(|entry| entry.host.clone()),
    }
}

pub const CONVERSATION_PREFIX: &str = "conversation/";

struct State {
    projection: Projection,
    log: TopicLog<Value>,
    /// 最后一次发出去的会话列表行（活动时间记成 0，不参与比较）。
    summary: Option<Value>,
    /// Fork: `submissionPreparation` while a durable first submission is still preparing.
    preparation: Option<Value>,
    /// Fork: events up to this seq are already in the view the projection was rebuilt from.
    skip_through: u64,
    /// Fork: the subagent table watcher ([`Live::watch_subagents`]).
    watcher: Option<rust_cli_base::Task<()>>,
    /// Fork: an event that can change the background ledger was projected; the next flush re-reads it.
    shells_dirty: bool,
    /// Fork: the conversation telemetry facts (crate::telemetry); None for a subagent's child session, whose facts
    /// the parent reports from the child's live run.
    telemetry: Option<Telemetry>,
    /// Fork: the telemetry of the subagent children whose live runs are read, with their own fact counters.
    children: std::collections::HashMap<String, (Telemetry, u64, rust_cli_base::Task<()>)>,
    /// Fork: facts waiting for the next write, in order.
    facts: Vec<Value>,
}

/// 锁里算好、锁外写出的东西：（订阅、区间、payload）与变了的会话列表行。
struct Outgoing {
    frames: Vec<(String, (u64, u64), Value)>,
    summary: Option<Value>,
    facts: Vec<Value>,
}

/// Fork: starts reading a subagent child's live run for the parent's telemetry (set by the server, which owns the
/// spawner); None when the kernel keeps no live run for it.
pub(crate) type ChildWatch = dyn Fn(&str) -> Option<rust_cli_base::Task<()>> + Send + Sync;

pub struct Live {
    context: Arc<Context>,
    topics: Arc<Topics>,
    session: String,
    workspace: String,
    created_at: u64,
    /// Fork: reads the view again after the history is rewritten.
    handle: Arc<dyn SessionHandle>,
    state: Mutex<State>,
    /// Fork: counts finished rebuilds, so a command that rewrites the history can wait for the projection to be
    /// rebuilt before it submits more input (see [`Self::rebuilds`]).
    rebuilds: tokio::sync::watch::Sender<u64>,
    /// Fork: the queue items a `sendQueuedNow` is promoting (Node `reserveQueueItem`): a second promotion of the
    /// same item is refused instead of preempting the turn the first one started.
    promotions: crate::reservations::Reservations,
    /// Fork: see [`ChildWatch`].
    child_watch: std::sync::OnceLock<Box<ChildWatch>>,
    /// Fork: the summary goes to the sessions index ([`listed_in_sessions_index`]).
    indexed: bool,
}

impl Live {
    pub fn new(
        context: Arc<Context>,
        topics: Arc<Topics>,
        handle: Arc<dyn SessionHandle>,
        view: &SessionView,
        followup: Followup,
        catalog: Arc<[rust_cli_kernel_api::provider::CatalogModel]>,
    ) -> Self {
        let levels = view.selection.reasoning.iter().cloned().collect();
        // A subagent's child session (`sess_subagent_<agentId>`) is reported by its parent.
        let telemetry = (!view.meta.id.as_str().starts_with(SUBAGENT_SESSION_PREFIX))
            .then(|| Telemetry::new(view.meta.id.as_str(), Role::Main));
        let epoch = context.fresh("epoch");
        context.register(view.meta.id.as_str(), view.meta.workspace.root.as_str());
        Self {
            session: view.meta.id.as_str().to_owned(),
            workspace: view.meta.workspace.root.as_str().to_owned(),
            created_at: view.meta.created_at_ms,
            handle,
            state: Mutex::new(State {
                projection: Projection::from_view(view, followup, levels).with_catalog(catalog),
                log: TopicLog::with_base(epoch, view.last_seq),
                summary: None,
                preparation: None,
                skip_through: view.last_seq,
                watcher: None,
                shells_dirty: false,
                telemetry,
                children: std::collections::HashMap::new(),
                facts: Vec::new(),
            }),
            context,
            topics,
            rebuilds: tokio::sync::watch::Sender::new(0),
            promotions: crate::reservations::Reservations::default(),
            child_watch: std::sync::OnceLock::new(),
            indexed: listed_in_sessions_index(view.meta.kind),
        }
    }

    /// Fork: see [`ChildWatch`]; set once when the server opens the session.
    pub(crate) fn set_child_watch(&self, watch: Box<ChildWatch>) {
        let _ = self.child_watch.set(watch);
    }

    /// Fork: the session handle (the server's child watch reads subagent runs through it).
    pub(crate) fn handle(&self) -> &Arc<dyn SessionHandle> {
        &self.handle
    }

    /// Fork: one event of a subagent child's live run, reported as the child's telemetry facts. In the session's
    /// pump task, after the parent's own facts of the same moment.
    pub(crate) async fn child_event(&self, child: &str, event: KernelEvent) {
        let now = self.context.now();
        let outgoing = {
            let mut state = self.state();
            let provider = provider_of(&state.projection);
            let Some((telemetry, seq, _)) = state.children.get_mut(child) else {
                return;
            };
            *seq += 1;
            let facts = telemetry.observe(
                &event,
                &Observed {
                    scope: "",
                    seq: *seq,
                    now,
                    provider: &provider,
                },
            );
            if matches!(event, KernelEvent::TurnFinished { .. }) {
                state.children.remove(child);
            }
            state.facts.extend(facts);
            Outgoing {
                frames: Vec::new(),
                summary: None,
                facts: std::mem::take(&mut state.facts),
            }
        };
        self.write(outgoing).await;
    }

    /// Fork: the subagent facts of the projection's rows; returns the children whose runs to read.
    fn subagent_facts(state: &mut State, scope: &'static str, seq: u64, now: u64) -> Vec<String> {
        let links = state.projection.subagent_links();
        let provider = provider_of(&state.projection);
        let Some(telemetry) = &mut state.telemetry else {
            return Vec::new();
        };
        let mut facts = Vec::new();
        let spawned = telemetry.subagents(
            &links,
            &Observed {
                scope,
                seq,
                now,
                provider: &provider,
            },
            &mut facts,
        );
        state.facts.extend(facts);
        spawned
    }

    /// Fork: starts reading the runs of the children just spawned.
    fn watch_children(&self, spawned: Vec<String>) {
        let Some(watch) = self.child_watch.get() else {
            return;
        };
        for child in spawned {
            let Some(task) = watch(&child) else {
                continue;
            };
            let mut state = self.state();
            if let Some((_, _, previous)) = state.children.insert(
                child.clone(),
                (Telemetry::new(&child, Role::Child), 0, task),
            ) {
                previous.abort();
            }
        }
    }

    /// Fork: reserves a queue item for one promotion; `None` while another promotion holds it.
    pub fn reserve_promotion(&self, item: &str) -> Option<crate::reservations::Reservation<'_>> {
        self.promotions.reserve(item)
    }

    /// Fork: a receiver of the rebuild count. The rebuild reads the session view when the pump reaches
    /// `HistoryRewritten` and skips every event the view already holds; input submitted before that read lands in
    /// the view only once its turn ends, so its turn's events would be skipped and its rows never shown. Commands
    /// that rewind and then submit wait for the next rebuild between the two.
    pub fn rebuilds(&self) -> tokio::sync::watch::Receiver<u64> {
        self.rebuilds.subscribe()
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock_unpoisoned()
    }

    /// The current snapshot, for tests.
    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> Value {
        let state = self.state();
        state.projection.snapshot(0, state.log.epoch())
    }

    pub fn topic(&self) -> String {
        format!("{CONVERSATION_PREFIX}{}", self.session)
    }

    /// 登记订阅（还没有首帧），返回主题的代际标识。
    pub fn subscribe(&self, subscription: &str, connection: &str) -> String {
        let mut state = self.state();
        if let Some(replaced) = state.log.subscribe(subscription, connection) {
            self.context.forget(&replaced);
        }
        state.log.epoch().to_owned()
    }

    /// 发首帧（当前的快照）。在会话的泵任务里调用（`Bridged::run`）。
    pub async fn start(&self, subscription: &str, purpose: Purpose) {
        let (range, payload) = {
            let mut state = self.state();
            let Some(seq) = state.log.start(subscription) else {
                return;
            };
            let mut snapshot = state.projection.snapshot(seq, state.log.epoch());
            if let Some(preparation) = &state.preparation {
                snapshot["meta"]["submissionPreparation"] = preparation.clone();
            }
            ((0, seq), json!({"kind": "snapshot", "snapshot": snapshot}))
        };
        self.context
            .frame(&self.topic(), subscription, range, payload, purpose)
            .await;
    }

    /// 重新同步：订阅回到“还没有首帧”。订阅不在时返回 None，否则给代际标识。
    pub fn restart(&self, subscription: &str) -> Option<String> {
        let mut state = self.state();
        state
            .log
            .restart(subscription)
            .then(|| state.log.epoch().to_owned())
    }

    pub fn unsubscribe(&self, subscription: &str) -> bool {
        let removed = self.state().log.unsubscribe(subscription);
        if removed {
            self.context.forget(subscription);
        }
        removed
    }

    pub fn drop_connection(&self, connection: &str) {
        let gone = self.state().log.drop_connection(connection);
        for subscription in gone {
            self.context.forget(&subscription);
        }
    }

    pub fn remember_input(&self, command: &str, meta: InputMeta) {
        self.state().projection.remember_input(command, meta);
    }

    /// Fork: see [`Projection::attachment_mime`].
    pub fn attachment_mime(&self, reference: &str) -> Option<String> {
        self.state().projection.attachment_mime(reference)
    }

    /// 用户拒绝了这个工具调用：之后它的结果投成 cancelled（与 Node 相同）。
    pub fn deny(&self, tool_use: &rust_cli_kernel_api::ids::ToolUseId) {
        self.state().projection.deny(tool_use.as_str());
    }

    /// Fork: see [`crate::projection::Projection::current_config`].
    pub fn current_config(
        &self,
    ) -> (
        rust_cli_kernel_api::model::ModelSelection,
        rust_cli_kernel_api::permission::PermissionMode,
        bool,
    ) {
        self.state().projection.current_config()
    }

    /// Fork: see [`Projection::row_target`].
    pub fn row_target(
        &self,
        row_id: u64,
        entity: &str,
        action: crate::projection::RowAction,
    ) -> Result<crate::projection::RowTarget, crate::projection::TargetMiss> {
        self.state().projection.row_target(row_id, entity, action)
    }

    /// Fork: see [`Projection::fork_target`].
    pub fn fork_target(
        &self,
        row_id: u64,
        entity: &str,
    ) -> Result<String, crate::projection::TargetMiss> {
        self.state().projection.fork_target(row_id, entity)
    }

    /// Fork: the `v4/conversation/plans` catalog with the topic position it was read at.
    /// Fork: the terminal status the notification of background command `task` reported.
    pub fn notified_status(&self, task: &str) -> Option<String> {
        self.state()
            .projection
            .notified_status(task)
            .map(str::to_owned)
    }

    /// Fork: the output file the notification of background command `task` named.
    pub fn notified_output(&self, task: &str) -> Option<String> {
        self.state()
            .projection
            .notified_output(task)
            .map(str::to_owned)
    }

    pub fn plans(&self) -> Value {
        let state = self.state();
        json!({"plans": state.projection.plans(), "atSeq": state.log.seq(),
            "atLogEpoch": state.log.epoch()})
    }

    /// Fork: one `v4/conversation/rowsRange` page with the topic position it was read at.
    pub fn rows_range(&self, before: Option<u64>, limit: usize) -> Value {
        let state = self.state();
        let (rows, more) = state.projection.rows_range(before, limit);
        crate::projection::rows_range::result(
            rows,
            more,
            state.log.seq(),
            state.projection.revision(),
            state.log.epoch(),
        )
    }

    pub fn followup(&self) -> Followup {
        self.state().projection.followup()
    }

    /// 投影的阶段与 revision（命令裁决的读数；revision 来自会话 actor）。
    pub fn status(&self) -> (Phase, u64) {
        let state = self.state();
        (state.projection.phase(), state.projection.revision())
    }

    /// 协议保存的配置变了：记一组增量并发出。在会话的泵任务里调用。
    pub async fn set_followup(&self, followup: Followup) {
        let outgoing = {
            let mut state = self.state();
            let delta = state.projection.set_followup(followup);
            state.log.record(vec![delta]);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// Fork: see [`crate::projection::Projection::auto_drain`].
    pub fn auto_drain(&self) -> bool {
        self.state().projection.auto_drain()
    }

    /// Fork: see [`crate::projection::Projection::has_queue`].
    pub fn has_queue(&self) -> bool {
        self.state().projection.has_queue()
    }

    /// Fork: a user stop held the queue: record the queue patch and send it.
    pub async fn hold_for_stop(&self) {
        let outgoing = {
            let mut state = self.state();
            let delta = state.projection.hold_for_stop();
            state.log.record(vec![delta]);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// Fork: `setAutoDrain` was accepted: record the queue patch and send it.
    pub async fn set_auto_drain(&self, auto_drain: bool) {
        let outgoing = {
            let mut state = self.state();
            let delta = state.projection.set_auto_drain(auto_drain);
            state.log.record(vec![delta]);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    /// Fork: the kernel's subagent table changed: settle ended children and publish the `subagents` manifest
    /// (projection/subagent_rows.rs). In the session's pump task, so it is ordered with the session's events.
    pub async fn subagents_changed(&self) {
        let entries = match self.handle.subagents().await {
            Ok(entries) => entries,
            Err(error) => {
                tracing::debug!(event = "protocol.subagents.read_failed", error = %error, "reading the subagent table failed");
                return;
            }
        };
        let now = self.context.now();
        let (outgoing, spawned) = {
            let mut state = self.state();
            let deltas = state.projection.subagent_table(&entries, now);
            if deltas.is_empty() {
                return;
            }
            state.log.record(deltas);
            let seq = state.log.seq();
            let spawned = Self::subagent_facts(&mut state, "table-", seq, now);
            (self.collect(&mut state), spawned)
        };
        self.watch_children(spawned);
        self.write(outgoing).await;
    }

    /// Fork: re-read the kernel's background ledger and publish the running shell commands as
    /// `backgroundWorks` (projection/background_shells.rs). In the session's pump task.
    pub async fn shells_changed(&self) {
        let outgoing = {
            let deltas = self.shell_deltas().await;
            if deltas.is_empty() {
                return;
            }
            let mut state = self.state();
            state.log.record(deltas);
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }

    async fn shell_deltas(&self) -> Vec<Value> {
        let entries = match self.handle.background_tasks().await {
            Ok(entries) => entries,
            Err(error) => {
                tracing::debug!(event = "protocol.background.read_failed", error = %error, "reading the background tasks failed");
                return Vec::new();
            }
        };
        let now = self.context.now();
        self.state().projection.shell_table(&entries, now)
    }

    /// Fork: the watcher of the kernel's subagent table; it ends with this session.
    pub fn watch_subagents(&self, watcher: rust_cli_base::Task<()>) {
        if let Some(previous) = self.state().watcher.replace(watcher) {
            previous.abort();
        }
    }

    /// 会话列表的当前行。
    pub fn summary(&self) -> Value {
        let state = self.state();
        self.summary_of(&state)
    }

    fn summary_of(&self, state: &State) -> Value {
        let reply = state.projection.last_reply();
        let mut row = Summary {
            session: &self.session,
            workspace: &self.workspace,
            title: state.projection.title(),
            phase: state.projection.phase(),
            created_at: self.created_at,
            activity_at: self.context.now(),
            last_reply: reply.as_deref(),
            permissions: state.projection.pending_permissions(),
        }
        .to_value();
        if let Some(preparation) = &state.preparation {
            row["submissionPreparation"] = preparation.clone();
            row["phase"] = json!("draft");
            row["sessionEnded"] = json!(false);
        }
        row
    }

    /// Fork: set the `submissionPreparation` the snapshot and the sessions-index row carry. Called before the
    /// first subscription starts (reservation or cold open), so no frame needs resending.
    pub fn set_preparation(&self, preparation: Option<Value>) {
        self.state().preparation = preparation;
    }

    /// Fork: the first submission was admitted. Meta has no delta op, so every started subscription gets a fresh
    /// snapshot without `submissionPreparation`, and the sessions-index row drops it. In the session's pump task.
    pub async fn complete_preparation(&self) {
        let started: Vec<String> = {
            let mut state = self.state();
            if state.preparation.take().is_none() {
                return;
            }
            // The ids are collected first: restarting needs `state.log` mutably.
            #[allow(clippy::needless_collect)]
            let ids: Vec<String> = state
                .log
                .subscribers()
                .iter()
                .map(|subscriber| subscriber.subscription.clone())
                .collect();
            ids.into_iter().filter(|id| state.log.restart(id)).collect()
        };
        for subscription in started {
            self.start(&subscription, Purpose::Recovery).await;
        }
        self.publish_summary().await;
    }

    /// Fork: the history was rewritten (rewind, edit, retry). Like the TUI, the projection is rebuilt from a fresh
    /// view; every started subscription gets a new snapshot, and events already in that view are skipped. In the
    /// session's pump task, so no event of this session is projected meanwhile.
    async fn rebuild(&self) {
        let view = match self.handle.view().await {
            Ok(view) => view,
            Err(error) => {
                tracing::warn!(event = "protocol.projection.rebuild_failed", error = %error, "reading the rewritten session failed");
                self.rebuilds.send_modify(|count| *count += 1);
                return;
            }
        };
        let started: Vec<String> = {
            let mut state = self.state();
            state.projection = state.projection.rebuilt(&view);
            state.skip_through = view.last_seq;
            // The ids are collected first: restarting needs `state.log` mutably.
            #[allow(clippy::needless_collect)]
            let ids: Vec<String> = state
                .log
                .subscribers()
                .iter()
                .map(|subscriber| subscriber.subscription.clone())
                .collect();
            ids.into_iter().filter(|id| state.log.restart(id)).collect()
        };
        for subscription in started {
            self.start(&subscription, Purpose::Recovery).await;
        }
        self.publish_summary().await;
        // Fork: the rebuilt projection starts without background works; re-read both tables.
        self.subagents_changed().await;
        self.shells_changed().await;
        self.rebuilds.send_modify(|count| *count += 1);
    }

    /// 待发的增量与变了的会话列表行（阶段、标题、待回答的询问或预览变了才发，活动时间不算）。
    fn collect(&self, state: &mut State) -> Outgoing {
        let frames = state
            .log
            .flush()
            .into_iter()
            .map(|batch| {
                (
                    batch.subscription,
                    (batch.from, batch.to),
                    json!({"kind": "deltas", "deltas": batch.deltas}),
                )
            })
            .collect();
        let facts = std::mem::take(&mut state.facts);
        let row = self.summary_of(state);
        let mut comparable = row.clone();
        comparable["lastActivityAt"] = json!(0);
        let summary = (state.summary.as_ref() != Some(&comparable)).then(|| {
            state.summary = Some(comparable);
            row
        });
        Outgoing {
            frames,
            summary,
            facts,
        }
    }

    async fn write(&self, outgoing: Outgoing) {
        let topic = self.topic();
        for (subscription, range, payload) in outgoing.frames {
            self.context
                .frame(&topic, &subscription, range, payload, Purpose::Online)
                .await;
        }
        if let Some(row) = outgoing.summary
            && self.indexed
        {
            self.topics.upsert(&self.workspace, row);
        }
        for fact in outgoing.facts {
            self.context
                .peer
                .notify(crate::telemetry::FACT, &fact)
                .await;
        }
    }

    /// 把当前的会话列表行发出去（建会话之后，列表马上看得到）。在会话的泵任务里调用。
    pub async fn publish_summary(&self) {
        let outgoing = {
            let mut state = self.state();
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        for (_, (_, _, task)) in self.state().children.drain() {
            task.abort();
        }
        if let Some(watcher) = self.state().watcher.take() {
            watcher.abort();
        }
    }
}

/// Fork: forwards the kernel's subagent table changes to the session's pump task while the session is open.
pub(crate) async fn watch_subagents(
    mut changes: futures_util::stream::BoxStream<'static, ()>,
    live: std::sync::Weak<rust_cli_protocol_core::sessions::Bridged<Live>>,
) {
    use futures_util::StreamExt;
    while changes.next().await.is_some() {
        let Some(bridged) = live.upgrade() else {
            return;
        };
        let sink = bridged.sink.clone();
        bridged.run(Box::pin(async move { sink.subagents_changed().await }));
    }
}

/// Fork: reads a subagent child's live run into the parent's telemetry (`Live::child_event`), in the parent's pump
/// task so the child's facts follow the parent's `spawned`. Ends with the run, or when the parent closes.
pub(crate) async fn read_child_run(
    feed: rust_cli_kernel_api::agents::ChildLiveFeed,
    child: String,
    live: std::sync::Weak<rust_cli_protocol_core::sessions::Bridged<Live>>,
) {
    use futures_util::StreamExt;
    use rust_cli_kernel_api::agents::ChildLive;
    let turn =
        rust_cli_kernel_api::ids::TurnId::new(format!("turn_{}", crate::telemetry::uuid_v7(0)));
    let mut events = futures_util::stream::iter(feed.replay).chain(feed.live);
    let mut started = false;
    while let Some(event) = events.next().await {
        let event = match event {
            ChildLive::Started if !started => {
                started = true;
                KernelEvent::TurnStarted {
                    turn: turn.clone(),
                    command: None,
                }
            }
            ChildLive::Started => continue,
            ChildLive::Event(event) => event.into_kernel_event(turn.clone()),
            ChildLive::Committed(message) => KernelEvent::MessageDone { message },
            ChildLive::Finished(outcome) => KernelEvent::TurnFinished {
                turn: turn.clone(),
                outcome,
                usage: None,
            },
        };
        let finished = matches!(event, KernelEvent::TurnFinished { .. });
        let Some(bridged) = live.upgrade() else {
            return;
        };
        let sink = bridged.sink.clone();
        let child = child.clone();
        bridged.run(Box::pin(
            async move { sink.child_event(&child, event).await },
        ));
        if finished {
            return;
        }
    }
}

#[async_trait]
impl SessionSink for Live {
    async fn event(&self, event: SequencedEvent) {
        if event.seq <= self.state().skip_through {
            return;
        }
        if matches!(event.event, KernelEvent::HistoryRewritten { .. }) {
            self.rebuild().await;
            return;
        }
        let now = self.context.now();
        let mut state = self.state();
        // Fork: a Bash result (a command went to the background), a background notification (one ended) or a
        // turn end can change the background ledger.
        if matches!(
            event.event,
            KernelEvent::ToolDone { .. }
                | KernelEvent::BackgroundWork { .. }
                | KernelEvent::TurnFinished { .. }
        ) {
            state.shells_dirty = true;
        }
        let deltas = state.projection.apply(&event, now);
        state.log.record(deltas);
        let provider = provider_of(&state.projection);
        if let Some(telemetry) = &mut state.telemetry {
            let facts = telemetry.observe(
                &event.event,
                &Observed {
                    scope: "",
                    seq: event.seq,
                    now,
                    provider: &provider,
                },
            );
            state.facts.extend(facts);
        }
        let spawned = Self::subagent_facts(&mut state, "", event.seq, now);
        drop(state);
        self.watch_children(spawned);
    }

    async fn flush(&self) {
        let refresh = std::mem::take(&mut self.state().shells_dirty);
        if refresh {
            let deltas = self.shell_deltas().await;
            self.state().log.record(deltas);
        }
        let outgoing = {
            let mut state = self.state();
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }
}
