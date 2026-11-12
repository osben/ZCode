//! 后台通知的执行环境替身：测试推入终态通知，会话订阅、ack；`shell_state.background` 是推入后
//! 还没有 ack 的任务（与 env-local 相同：ack 之前都算后台工作）。

use rust_cli_base::sync::LockUnpoisoned;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::stream::{self, BoxStream, StreamExt};
use tokio::sync::{mpsc, watch};

use crate::controller_services::Fetch;
use crate::env::{
    CommandEvent, EnvError, EnvFacts, EnvPath, FileContent, OperationContext, Outcome, ReadFile,
    StartCommand, WorkspaceRef, WriteFile, WriteReceipt,
};
use crate::env_shell::{BackgroundInfo, BackgroundStop, BackgroundTask, ShellNotice, ShellState};
use crate::ids::{OperationId, SessionId, ShellTaskId};
use crate::machine::Git;
use crate::machine::{Background, Checkpoints, Commands, EnvInfo, Files, Pdf, Search, Shell};

pub struct NoticeEnvironment {
    sender: mpsc::UnboundedSender<ShellNotice>,
    receiver: Mutex<Option<mpsc::UnboundedReceiver<ShellNotice>>>,
    pushed: Arc<Mutex<Vec<ShellNotice>>>,
    acked: Arc<Mutex<Vec<u64>>>,
    /// 还在跑的命令，与它还要经过几次状态查询才结束。
    running: Mutex<Vec<(ShellNotice, usize)>>,
    /// 用 [`Self::run_in`] 登记的命令所在的会话：`background_command` 只在这个会话里认它（缺省哪个会话都认）。
    sessions: Mutex<Vec<(ShellTaskId, SessionId)>>,
    /// `close_session` 的调用（会话与 `forget`），按顺序。
    closed: Mutex<Vec<(SessionId, bool)>>,
    /// Fork: the sessions that subscribed to notices, in order (one forwarder per child session).
    subscribed: Mutex<Vec<SessionId>>,
    /// Fork: notice streams handed out and not yet dropped.
    live: Arc<AtomicUsize>,
    /// Fork: [`Self::replaying`] — every subscription replays the pushed notices that are not acknowledged, like the
    /// env-local ledger, so a subscriber that stops and a later one both see a pending notice.
    replay: bool,
    /// Fork: bumped on each pushed notice and each ack (wakes replaying subscriptions).
    changed: watch::Sender<u64>,
    /// Fork: notices pushed with [`Self::finish_in`]: a replaying subscription of another session skips them.
    owners: Arc<Mutex<Vec<(u64, SessionId)>>>,
    /// Fork: acks wait while this is false ([`Self::hold_acks`]).
    acks_open: watch::Sender<bool>,
    /// Fork: acks that started (including held ones).
    acks_started: AtomicUsize,
}

impl Default for NoticeEnvironment {
    fn default() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self {
            sender,
            receiver: Mutex::new(Some(receiver)),
            pushed: Arc::default(),
            acked: Arc::default(),
            running: Mutex::default(),
            sessions: Mutex::default(),
            closed: Mutex::default(),
            subscribed: Mutex::default(),
            live: Arc::default(),
            replay: false,
            changed: watch::channel(0).0,
            owners: Arc::default(),
            acks_open: watch::channel(true).0,
            acks_started: AtomicUsize::new(0),
        }
    }
}

/// Fork: drops with its notice stream (counts live subscriptions).
struct Live(Arc<AtomicUsize>);

impl Live {
    fn new(count: &Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        Self(count.clone())
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl NoticeEnvironment {
    /// Fork: a ledger-like environment: each subscription replays the pushed notices not yet acknowledged, then
    /// follows new ones; any number of subscribers.
    pub fn replaying() -> Self {
        Self {
            replay: true,
            ..Self::default()
        }
    }

    /// 一条后台命令结束：记为未 ack，并送给订阅方。
    pub fn finish(&self, notice: ShellNotice) {
        self.pushed.lock_unpoisoned().push(notice.clone());
        let _ = self.sender.send(notice);
        self.changed.send_modify(|count| *count += 1);
    }

    /// Fork: a command of `session` ended; a replaying subscription of another session does not see it.
    pub fn finish_in(&self, session: SessionId, notice: ShellNotice) {
        self.owners.lock_unpoisoned().push((notice.seq, session));
        self.finish(notice);
    }

    /// Fork: acks wait until [`Self::release_acks`] (a subscriber is then between delivering and acknowledging).
    pub fn hold_acks(&self) {
        self.acks_open.send_replace(false);
    }

    pub fn release_acks(&self) {
        self.acks_open.send_replace(true);
    }

    /// Fork: acks that started, including ones still held.
    pub fn acks_started(&self) -> usize {
        self.acks_started.load(Ordering::SeqCst)
    }

    /// Fork: notice streams handed out and not yet dropped.
    pub fn live_subscriptions(&self) -> usize {
        self.live.load(Ordering::SeqCst)
    }

    /// 一条后台命令在跑；第 `checks` 次 `shell_state` 报告它之后立即结束（模拟"刚查完就结束"的时序）。
    pub fn finish_after_checks(&self, notice: ShellNotice, checks: usize) {
        self.running.lock_unpoisoned().push((notice, checks));
    }

    /// 一条在 `session` 里一直跑的命令（TaskStop 按会话找它；`shell_state` 仍不分会话）。
    pub fn run_in(&self, session: SessionId, notice: ShellNotice) {
        self.sessions
            .lock_unpoisoned()
            .push((notice.task.clone(), session));
        self.finish_after_checks(notice, usize::MAX);
    }

    pub fn acked(&self) -> Vec<u64> {
        self.acked.lock_unpoisoned().clone()
    }

    /// Fork: the sessions that subscribed to notices, in order.
    pub fn subscribed(&self) -> Vec<SessionId> {
        self.subscribed.lock_unpoisoned().clone()
    }

    /// 收到的 `close_session`（会话与 `forget`），按顺序。
    pub fn closed(&self) -> Vec<(SessionId, bool)> {
        self.closed.lock_unpoisoned().clone()
    }
}

/// 一条成功结束的后台命令通知。
pub fn shell_notice(seq: u64, task: &str) -> ShellNotice {
    ShellNotice {
        seq,
        operation: OperationId::new(format!("op_{task}")),
        task: ShellTaskId::new(task),
        tool_use: None,
        description: format!("Run {task}"),
        output: EnvPath::new(format!("/tmp/{task}.output")),
        outcome: Outcome::Completed,
        exit_code: Some(0),
        kind: Default::default(),
        output_bytes: 0,
    }
}

fn unused() -> EnvError {
    EnvError::Unsupported {
        what: "notice test environment".to_owned(),
    }
}

#[async_trait]
impl EnvInfo for NoticeEnvironment {
    async fn facts(&self, _workspace: &WorkspaceRef) -> Result<EnvFacts, EnvError> {
        Err(unused())
    }
}

#[async_trait]
impl Files for NoticeEnvironment {
    async fn read_file(
        &self,
        _workspace: &WorkspaceRef,
        _request: ReadFile,
    ) -> Result<FileContent, EnvError> {
        Err(unused())
    }

    async fn write_file(
        &self,
        _workspace: &WorkspaceRef,
        _context: OperationContext,
        _request: WriteFile,
    ) -> Result<WriteReceipt, EnvError> {
        Err(unused())
    }
}

#[async_trait]
impl Commands for NoticeEnvironment {
    async fn start_command(
        &self,
        _workspace: &WorkspaceRef,
        _context: OperationContext,
        _request: StartCommand,
    ) -> Result<BoxStream<'static, Result<CommandEvent, EnvError>>, EnvError> {
        Err(unused())
    }

    fn watch_command(
        &self,
        _operation: OperationId,
        _cursor: u64,
    ) -> BoxStream<'static, Result<CommandEvent, EnvError>> {
        stream::iter([Err(unused())]).boxed()
    }

    async fn cancel(&self, _operation: OperationId) -> Result<(), EnvError> {
        Err(unused())
    }

    async fn close_session(&self, session: &SessionId, forget: bool) -> Result<(), EnvError> {
        self.closed
            .lock_unpoisoned()
            .push((session.clone(), forget));
        Ok(())
    }
}

#[async_trait]
impl Shell for NoticeEnvironment {
    async fn shell_state(
        &self,
        workspace: &WorkspaceRef,
        _session: &SessionId,
    ) -> Result<ShellState, EnvError> {
        let acked = self.acked();
        let mut finished = Vec::new();
        let background = {
            let mut running = self.running.lock_unpoisoned();
            let background = running
                .iter()
                .map(|(notice, _)| notice)
                .chain(self.pushed.lock_unpoisoned().iter())
                .filter(|notice| !acked.contains(&notice.seq))
                .map(|notice| notice.task.clone())
                .collect();
            running.retain_mut(|(notice, checks)| {
                *checks = checks.saturating_sub(1);
                if *checks == 0 {
                    finished.push(notice.clone());
                }
                *checks > 0
            });
            background
        };
        for notice in finished {
            self.finish(notice);
        }
        Ok(ShellState {
            cwd: workspace.root.clone(),
            outputs: None,
            background,
        })
    }

    /// 只支持一个订阅方（会话 actor）。
    fn shell_notices(
        &self,
        session: &SessionId,
        _after: u64,
    ) -> BoxStream<'static, Result<ShellNotice, EnvError>> {
        self.subscribed.lock_unpoisoned().push(session.clone());
        let live = Live::new(&self.live);
        if self.replay {
            return replay(
                Ledger {
                    pushed: self.pushed.clone(),
                    acked: self.acked.clone(),
                    owners: self.owners.clone(),
                    session: session.clone(),
                },
                self.changed.subscribe(),
                live,
            );
        }
        match self.receiver.lock_unpoisoned().take() {
            Some(mut receiver) => stream::poll_fn(move |cx| {
                let _live = &live;
                receiver.poll_recv(cx)
            })
            .map(Ok)
            .boxed(),
            None => stream::iter([Err(unused())]).boxed(),
        }
    }

    async fn ack_shell_notice(&self, _session: &SessionId, seq: u64) -> Result<(), EnvError> {
        self.acks_started.fetch_add(1, Ordering::SeqCst);
        let mut open = self.acks_open.subscribe();
        let _ = open.wait_for(|open| *open).await;
        self.acked.lock_unpoisoned().push(seq);
        self.changed.send_modify(|count| *count += 1);
        Ok(())
    }
}

/// Fork: what a replaying subscription reads.
struct Ledger {
    pushed: Arc<Mutex<Vec<ShellNotice>>>,
    acked: Arc<Mutex<Vec<u64>>>,
    owners: Arc<Mutex<Vec<(u64, SessionId)>>>,
    session: SessionId,
}

impl Ledger {
    /// The first notice from `next` on that is not acknowledged and not another session's, with its index.
    fn next(&self, next: usize) -> Option<(usize, ShellNotice)> {
        let pushed = self.pushed.lock_unpoisoned();
        let acked = self.acked.lock_unpoisoned();
        let owners = self.owners.lock_unpoisoned();
        pushed
            .iter()
            .enumerate()
            .skip(next)
            .find(|(_, notice)| {
                !acked.contains(&notice.seq)
                    && owners
                        .iter()
                        .all(|(seq, owner)| *seq != notice.seq || *owner == self.session)
            })
            .map(|(index, notice)| (index, notice.clone()))
    }
}

/// Fork: the replaying subscription: pushed notices in order, skipping acknowledged ones and other sessions' ones.
fn replay(
    ledger: Ledger,
    changed: watch::Receiver<u64>,
    live: Live,
) -> BoxStream<'static, Result<ShellNotice, EnvError>> {
    let ledger = Arc::new(ledger);
    stream::unfold(
        (0_usize, changed, live),
        move |(next, mut changed, live)| {
            let ledger = ledger.clone();
            async move {
                loop {
                    changed.borrow_and_update();
                    if let Some((index, notice)) = ledger.next(next) {
                        return Some((Ok(notice), (index + 1, changed, live)));
                    }
                    if changed.changed().await.is_err() {
                        return None;
                    }
                }
            }
        },
    )
    .boxed()
}

impl Search for NoticeEnvironment {}
/// 在跑的命令（`finish_after_checks` 登记的）能查、能停：停掉的不发终态通知，也不再算后台工作（同 env-local）。
#[async_trait]
impl Background for NoticeEnvironment {
    async fn background_command(
        &self,
        request: BackgroundTask,
    ) -> Result<Option<BackgroundInfo>, EnvError> {
        let elsewhere = self
            .sessions
            .lock_unpoisoned()
            .iter()
            .any(|(task, session)| *task == request.task && *session != request.session);
        if elsewhere {
            return Ok(None);
        }
        let running = self.running.lock_unpoisoned();
        Ok(running
            .iter()
            .find(|(notice, _)| notice.task == request.task)
            .map(|(notice, _)| BackgroundInfo {
                command: notice.description.clone(),
                ..BackgroundInfo::default()
            }))
    }

    async fn stop_background_command(
        &self,
        _context: OperationContext,
        request: BackgroundTask,
    ) -> Result<BackgroundStop, EnvError> {
        let mut running = self.running.lock_unpoisoned();
        let Some(index) = running
            .iter()
            .position(|(notice, _)| notice.task == request.task)
        else {
            return Ok(BackgroundStop::NotFound);
        };
        let (notice, _) = running.remove(index);
        Ok(BackgroundStop::Stopped {
            command: notice.description,
        })
    }
}
impl Checkpoints for NoticeEnvironment {}
impl Pdf for NoticeEnvironment {}
impl Git for NoticeEnvironment {}
impl Fetch for NoticeEnvironment {}
