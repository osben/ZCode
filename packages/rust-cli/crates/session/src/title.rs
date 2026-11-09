//! 会话标题（docs/specs/rust-cli/titles.md §2、§4）：会话 actor 是标题与标题来源的唯一 owner。
//!
//! 首条人类输入提交后：内存里的标题换成 `first_input`（node-store 在同一事务里按 Node 写好）并发
//! `TitleChanged`；满足触发条件时起一个标题任务，它只算候选标题与这次请求的用量事实，结果回到 actor 后先提交用量行
//! （工作线 F73，usage.md §2.1.1），再提交 `TitleGenerated`（存储按 Node 的来源条件写）、改内存、发事件。用户改名
//! （`Rename`）或 hook 改过标题后，候选标题丢弃（用量行照写）。

use rust_cli_base::{Task, TaskError};
use rust_cli_kernel_api::ids::{CommandId, MessageId, RunId};
use rust_cli_kernel_api::message::{ContentBlock, Message, UserOrigin};
use rust_cli_kernel_api::session_api::{Ack, KernelEvent};
use rust_cli_kernel_api::side_request::SideSource;
use rust_cli_kernel_api::store::{Fact, SessionKind, TurnAnchor};
use rust_cli_kernel_api::user_command::LocalCommandRecord;
use tokio_util::sync::CancellationToken;

use crate::actor::{Actor, accepted, rejected};
use crate::title_model::{Generated, long_enough};

/// 在跑的标题任务。
struct TitleJob {
    /// 首条输入的消息 ID。
    prompt: MessageId,
    /// 起任务时的回合锚点（首条输入与它的轮次）：用量行写在这一轮，标题晚于下一条输入回来也不变。
    turn: Option<TurnAnchor>,
    /// Fork (desktop App): the goal this first input set; the title is also its summary (Node `goalSummaryTargetID`).
    goal: Option<String>,
    /// The title is the session's (false: only a goal summary, Node `goal_summary_title`).
    session: bool,
    task: Task<Generated>,
}

/// 标题任务的结果与它的首条输入、回合锚点。
pub(crate) struct TitleDone {
    prompt: MessageId,
    turn: Option<TurnAnchor>,
    goal: Option<String>,
    session: bool,
    result: Result<Generated, TaskError>,
}

/// Fork: Node desktop titles make a first attempt plus one retry (specs/session-title-polish.md §6.2); the TUI one.
const NODE_MAX_ATTEMPTS: u8 = 2;

/// 标题生成的状态（actor 的一个字段）。
#[derive(Default)]
pub(crate) struct TitleState {
    /// Title requests this actor started (Node `sessionTitleGenerationAttempts`); a goal summary request is not one.
    attempts: u8,
    /// Fork: no more title requests (Node `sessionTitleGenerationSettled`): a generated title was stored or refused,
    /// the seed message was rewound away, or the title is custom.
    settled: bool,
    /// Fork: the stored title is still automatic (`default` / `first_input`, Node `isAutoTitlePending`); a retry needs it.
    pending: bool,
    /// Fork: the first human input this actor saw (Node `sessionTitleSeed`), the preferred retry seed.
    seed: Option<(MessageId, String)>,
    /// 标题来源是 `custom`（本会话里改过名或 hook 改过标题）。
    custom: bool,
    /// 在跑的标题任务。
    task: Option<TitleJob>,
    /// 本 actor 里改名（`Rename`、hook 的标题、起名写入）的次数：起名期间有新的改名时不写
    /// （titles.md §8.2，`superseded`）。
    renames: u64,
    /// Fork (Node desktop titles): the first-input title waiting for its turn to complete.
    deferred: Option<DeferredTitle>,
    /// Fork (Node desktop titles): no turn completed yet after a deferred title was dropped, so the next input is
    /// still the first (Node counts `turnNumber` on completed turns only).
    rearmed: bool,
}

/// Fork: Node's desktop agent always has a provider runtime-headers port, so `shouldDeferSessionTitleForRuntimeHeaders`
/// holds and the first-input title starts only after the turn completed (core `turn.ts`
/// `maybeStartDeferredSessionTitleGeneration`); a turn that does not complete gets none.
struct DeferredTitle {
    prompt: MessageId,
    text: String,
    turn: Option<TurnAnchor>,
    run: Option<RunId>,
    goal: Option<String>,
    /// The session title's request, or only a goal summary's (`SideSource::GoalSummaryTitle`).
    source: SideSource,
}

impl TitleState {
    pub(crate) fn new(pending: bool) -> Self {
        Self {
            pending,
            ..Self::default()
        }
    }

    pub(crate) fn mark_custom(&mut self) {
        self.custom = true;
        self.pending = false;
        self.renames += 1;
    }

    /// A title request runs or waits for its turn (Node `sessionTitleGenerationInFlight`).
    fn in_flight(&self) -> bool {
        self.task.is_some() || self.deferred.is_some()
    }

    pub(crate) fn renames(&self) -> u64 {
        self.renames
    }
}

/// 标题任务的结果；没有任务时一直等（actor 的 select 分支）。
pub(crate) async fn title_done(state: &mut TitleState) -> TitleDone {
    match &mut state.task {
        Some(job) => {
            let result = (&mut job.task).await;
            TitleDone {
                prompt: job.prompt.clone(),
                turn: job.turn.clone(),
                goal: job.goal.clone(),
                session: job.session,
                result,
            }
        }
        None => std::future::pending().await,
    }
}

fn human_text(message: &Message) -> Option<String> {
    let Message::User(user) = message else {
        return None;
    };
    if !matches!(user.origin, UserOrigin::Human) {
        return None;
    }
    let texts: Vec<&str> = user
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    let text = texts.join("\n");
    // 用户调用 skill 的输入是命令标签：标题按用户输入的样子（`/<名字> <参数>`，ext.md §2.7）；bash 模式的输入
    // 写成 `! 命令`（首条提示同样还原，tui-input.md §2.2）。
    Some(
        rust_cli_kernel_api::user_command::display(&text)
            .or_else(|| rust_cli_kernel_api::user_input::display(&text))
            .unwrap_or(text),
    )
}

impl Actor {
    /// 本回合的人类输入已提交（`first` 为真时它之前的活动历史里没有 user 消息）。
    pub(crate) fn after_prompt(&mut self, message: &Message, first: bool) {
        let Some(text) = human_text(message) else {
            return;
        };
        if self.meta.title.is_empty() {
            // node-store 在同一事务里写了 first_input（Node `titleFromInput`），这里用同一个函数。
            let title = rust_cli_kernel_api::title::from_input(&text);
            self.meta.title.clone_from(&title);
            self.log.append(KernelEvent::TitleChanged { title });
        }
        // Fork (desktop App): a `/goal` input that set a goal; it gets a summary title either way.
        let goal = self.goal_set_by(message.id());
        let Some(node_titles) = self.deps.titles.as_ref().map(|titles| titles.node_prompt) else {
            if let Some(target) = goal {
                self.goal_summarized(&target, None);
            }
            return;
        };
        if node_titles && goal.is_none() && self.titles.seed.is_none() && !text.trim().is_empty() {
            self.titles.seed = Some((message.id().clone(), text.clone()));
        }
        let Some((prompt, text)) =
            self.title_seed(message, text, first, node_titles, goal.is_some())
        else {
            if let Some(target) = goal {
                self.start_goal_summary(target);
            }
            return;
        };
        self.titles.rearmed = false;
        // Node starts the title of a `/goal` control turn at once (core `control-only-turn.ts`, no defer flag).
        let deferred = node_titles && crate::goal::command(&text).is_none();
        // 提交这条输入的回合（工作线 F64：标题请求与回合共用 `x-query-id`，Node 的标题沿用回合的 trace，model.md §2.4）。
        let run = self
            .running
            .as_ref()
            .and_then(|running| running.run.clone());
        let title = DeferredTitle {
            prompt,
            text,
            turn: self.turn_anchor(),
            run,
            goal,
            source: crate::title_model::SOURCE,
        };
        if deferred {
            self.titles.deferred = Some(title);
        } else {
            self.start_title(title);
        }
    }

    /// The title request this input starts, with its seed (Node `resolveSessionTitleGenerationMode`): the first input
    /// of a new session (`first`), or, for Node desktop titles, a retry while the stored title is still automatic. A
    /// retry's seed is the first input this actor saw when it is long enough, else this input.
    fn title_seed(
        &self,
        message: &Message,
        text: String,
        first: bool,
        node_titles: bool,
        goal: bool,
    ) -> Option<(MessageId, String)> {
        let titles = &self.titles;
        let max = if node_titles { NODE_MAX_ATTEMPTS } else { 1 };
        let open = !titles.custom
            && !titles.settled
            && !titles.in_flight()
            && titles.attempts < max
            && self.meta.kind == SessionKind::Interactive
            && self.meta.parent.is_none()
            && long_enough(&text);
        if !open {
            return None;
        }
        if (first || titles.rearmed) && titles.attempts == 0 {
            return Some((message.id().clone(), text));
        }
        // `/goal` inputs keep their first-turn-only behaviour (their goal summary fallback depends on it).
        if !node_titles || goal || !titles.pending {
            return None;
        }
        match &titles.seed {
            Some((prompt, seed)) if long_enough(seed) => Some((prompt.clone(), seed.clone())),
            _ => Some((message.id().clone(), text)),
        }
    }

    /// Fork (Node desktop titles): the turn ended; a completed turn starts its deferred title, any other leaves the
    /// next input eligible (Node: no request was made and `turnNumber` stays 0).
    pub(crate) fn after_turn(&mut self, completed: bool) {
        let Some(title) = self.titles.deferred.take() else {
            return;
        };
        if completed {
            self.start_title(title);
        } else {
            self.titles.rearmed = true;
        }
    }

    fn start_title(&mut self, title: DeferredTitle) {
        let Some(titles) = self.deps.titles.clone() else {
            return;
        };
        let DeferredTitle {
            prompt,
            text,
            turn,
            run,
            goal,
            source,
        } = title;
        if source == crate::title_model::SOURCE {
            // Node re-checks before the request (`resolveSessionTitleGenerationMode` after the turn,
            // `shouldSkipGeneratedTitleForFirstQueryEdit`): a rename during the deferred turn, or a seed message that was
            // rewound away, settles without a request. A goal still asks for its summary (Node writes it under a custom
            // title too).
            let stale = self.titles.custom
                || self.titles.settled
                || !self.messages.iter().any(|message| message.id() == &prompt);
            if stale && goal.is_none() {
                self.titles.settled = true;
                return;
            }
            self.titles.attempts += 1;
        }
        // 入队时冻结当前选择（Node `retainTitleModelContext`）；选择的 owner 是本 actor。
        let selection = self.selection.clone();
        let session = self.meta.id.clone();
        // 用量事实的时钟与逻辑请求 ID（工作线 F73）。
        let clock = self.deps.clock.clone();
        let request = self.deps.ids.message();
        let task = self.deps.spawner.spawn("session-title", async move {
            titles
                .generate(
                    &selection,
                    (&session, run.as_ref()),
                    &text,
                    (clock.as_ref(), request),
                    CancellationToken::new(),
                    source,
                )
                .await
        });
        self.titles.task = Some(TitleJob {
            prompt,
            turn,
            goal,
            session: source == crate::title_model::SOURCE,
            task,
        });
    }

    /// Fork (desktop App): Node `maybeStartGoalSummaryTitleGeneration`: a goal set after the first input asks the
    /// title model for its summary only (`goal_summary_title`); when that cannot start, the objective is the summary.
    fn start_goal_summary(&mut self, target: String) {
        let eligible = self.titles.task.is_none()
            && self.meta.kind == SessionKind::Interactive
            && self.meta.parent.is_none();
        let objective = self.goal_objective(&target);
        let (Some(objective), true) = (objective, eligible) else {
            self.goal_summarized(&target, None);
            return;
        };
        let prompt = self.messages.last().map(|message| message.id().clone());
        let Some(prompt) = prompt else {
            self.goal_summarized(&target, None);
            return;
        };
        let run = self
            .running
            .as_ref()
            .and_then(|running| running.run.clone());
        self.start_title(DeferredTitle {
            prompt,
            text: objective,
            turn: self.turn_anchor(),
            run,
            goal: Some(target),
            source: SideSource::GoalSummaryTitle,
        });
    }

    /// 标题任务回到 actor：先提交这次请求的用量行，候选标题仍可写时再提交、改内存、发事件。
    pub(crate) async fn on_title(&mut self, done: TitleDone) {
        self.titles.task = None;
        let TitleDone {
            prompt,
            turn,
            goal,
            session,
            result,
        } = done;
        let generated = match result {
            Ok(generated) => generated,
            Err(error) => {
                tracing::warn!(%error, "the session title task ended without a result");
                if let Some(target) = goal {
                    self.goal_summarized(&target, None);
                }
                return;
            }
        };
        // Node writes the goal summary even when the session title is custom (`goalSummaryTargetID`).
        if let Some(target) = &goal {
            self.goal_summarized(target, generated.title.clone());
        }
        // 工作线 F73（usage.md §2.1.1）：Node 在标题请求结束时就写用量行，不看标题用不用；单独一批，锚在起任务时的
        // 回合；写入失败只记日志（Node 同）。
        let usage = vec![Fact::ModelCalled {
            call: generated.call,
        }];
        if let Err(reason) = self.commit_in_turn(turn, usage).await {
            tracing::warn!(%reason, "the session title usage was not stored");
        }
        let Some(title) = generated.title.filter(|_| session) else {
            return;
        };
        // 用户先改了名，或首条输入已被回退掉（Node `isSuppressedByFirstQueryEdit`）：丢弃。
        if self.titles.custom || !self.messages.iter().any(|m| m.id() == &prompt) {
            tracing::debug!("the generated session title was discarded");
            self.titles.settled = true;
            return;
        }
        let fact = Fact::TitleGenerated {
            title: title.clone(),
            message: Some(prompt),
        };
        if let Err(reason) = self.commit(None, vec![fact]).await {
            // 存储里的来源已不允许覆盖（例如另一个进程改了名）。
            tracing::debug!(%reason, "the generated session title was not stored");
            self.titles.settled = true;
            self.titles.pending = false;
            return;
        }
        self.titles.settled = true;
        self.titles.pending = false;
        self.meta.title.clone_from(&title);
        self.log.append(KernelEvent::TitleChanged { title });
    }

    /// 用户改名（Node `setCustomSessionTitle`）：先提交，再改内存、发事件。`record` 是 TUI `/rename <名字>` 的命令记录
    /// （`Command::RenameRecorded`，titles.md §4）。
    ///
    /// 缺陷修复（MR !3465 评审 CR-01）：以前记录由 TUI 在回执之后另发，还没有会话时更是预先放进草稿，改名提交失败时
    /// 记录照样提交，模型看到不成立的“改了名”。现在空闲时记录与改名同一批，失败时两者都不在；忙时记录照
    /// `RecordLocalCommand` 留到收尾，那时改名已经成立。
    pub(crate) async fn rename(
        &mut self,
        command: CommandId,
        title: String,
        record: Option<LocalCommandRecord>,
    ) -> Ack {
        let fact = Fact::TitleChanged {
            title: title.clone(),
        };
        let (now, held) = match record {
            Some(record) if !self.busy() => (Some(record), None),
            other => (None, other),
        };
        let messages = now.map_or_else(Vec::new, |record| {
            crate::local_record::record_messages(self.deps.ids.as_ref(), &record)
        });
        let appended = match self.append(Some(command), messages, vec![fact]).await {
            Ok(appended) => appended,
            Err(reason) => return rejected(reason),
        };
        self.titles.mark_custom();
        self.meta.title.clone_from(&title);
        self.log.append(KernelEvent::TitleChanged { title });
        self.after_commit(appended).await;
        self.held_records.extend(held);
        accepted()
    }
}

#[cfg(test)]
#[path = "title_tests.rs"]
mod tests;
