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
use crate::wire::Purpose;

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
}

/// 锁里算好、锁外写出的东西：（订阅、区间、payload）与变了的会话列表行。
struct Outgoing {
    frames: Vec<(String, (u64, u64), Value)>,
    summary: Option<Value>,
}

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
        let epoch = context.fresh("epoch");
        context.register(view.meta.id.as_str(), view.meta.workspace.root.as_str());
        Self {
            session: view.meta.id.as_str().to_owned(),
            workspace: view.meta.workspace.root.as_str().to_owned(),
            created_at: view.meta.created_at_ms,
            handle,
            state: Mutex::new(State {
                projection: Projection::from_view(view, followup, levels).with_catalog(catalog),
                log: TopicLog::new(epoch),
                summary: None,
                preparation: None,
                skip_through: view.last_seq,
            }),
            context,
            topics,
            rebuilds: tokio::sync::watch::Sender::new(0),
        }
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
    ) -> Option<crate::projection::RowTarget> {
        self.state().projection.row_target(row_id, entity, action)
    }

    /// Fork: the `v4/conversation/plans` catalog with the topic position it was read at.
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
        let row = self.summary_of(state);
        let mut comparable = row.clone();
        comparable["lastActivityAt"] = json!(0);
        let summary = (state.summary.as_ref() != Some(&comparable)).then(|| {
            state.summary = Some(comparable);
            row
        });
        Outgoing { frames, summary }
    }

    async fn write(&self, outgoing: Outgoing) {
        let topic = self.topic();
        for (subscription, range, payload) in outgoing.frames {
            self.context
                .frame(&topic, &subscription, range, payload, Purpose::Online)
                .await;
        }
        if let Some(row) = outgoing.summary {
            self.topics.upsert(&self.workspace, row);
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
        let deltas = state.projection.apply(&event, now);
        state.log.record(deltas);
    }

    async fn flush(&self) {
        let outgoing = {
            let mut state = self.state();
            self.collect(&mut state)
        };
        self.write(outgoing).await;
    }
}
