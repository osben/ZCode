//! rewind（docs/specs/rust-cli/session-lifecycle.md §5）：对话回退是一次存储提交；代码回退是
//! 执行环境的 token 事务，在后台工作里跑，结果回到 actor 后才提交事实、发事件、回复命令。

use std::sync::Arc;

use rust_cli_kernel_api::env::Origin;
use rust_cli_kernel_api::env_rewind::{RestoreFile, RewindPlan, RewindPrepare};
use rust_cli_kernel_api::ids::{CommandId, MachineName, MessageId, OperationId};
use rust_cli_kernel_api::machine::{Checkpoints, not_connected};
use rust_cli_kernel_api::session_api::{
    Ack, CommandResult, KernelEvent, RewindOption, RewindPreview, RewindSafeFile, RewindScope,
    RewindUnsafeFile, RewindUnsafeReason, RewoundFile,
};
use rust_cli_kernel_api::store::{ArtifactStore, Fact, RevertCursor, WorkspaceCheckpoint};
use tokio::sync::oneshot;

use crate::actor::{Actor, Job, JobDone, rejected};
use crate::rewind_machines::{self, Group};
use crate::rewind_plan::{self, Artifact};

/// 选择器的快照：可选的 user 消息与每一回合的 checkpoint（读 artifact 在调用方做）。
pub(crate) struct Snapshot {
    options: Vec<(MessageId, Vec<WorkspaceCheckpoint>, bool)>,
}

/// Fork: a dry-run preview of a code rewind (Node's file rewind preview): the per-machine groups a
/// rewind to the target would run, picked by the actor exactly like [`Actor::rewind`] would; the
/// artifact reads and the hash check happen in the caller's task.
pub(crate) struct Preview {
    groups: Vec<Group>,
}

/// 代码回退事务的结果，回到 actor 后提交。
pub(crate) struct Finished {
    command: CommandId,
    target: MessageId,
    scope: RewindScope,
    reply: oneshot::Sender<Ack>,
    /// 每台机器的 token（提交之后释放）。
    tokens: Vec<(Arc<dyn Checkpoints>, OperationId)>,
    /// 撤销成功的 checkpoint（R3：跨机器时一台 apply 失败，成功的那几台也要记下）。
    restored: Vec<String>,
    result: Result<Vec<RewoundFile>, String>,
}

/// Fork: the per-turn summary rewind's transaction result ([`Command::RewindTurnFiles`]), back at
/// the actor to be committed. Unlike [`Finished`] it never cuts the conversation, and the settled
/// event is [`KernelEvent::TurnFilesReverted`].
pub(crate) struct TurnRewound {
    command: CommandId,
    turn_input: MessageId,
    reply: oneshot::Sender<Ack>,
    /// The per-machine tokens (released after the commit).
    tokens: Vec<(Arc<dyn Checkpoints>, OperationId)>,
    /// The checkpoints the restore undid.
    restored: Vec<String>,
    result: Result<Vec<RewoundFile>, String>,
}

async fn read(
    store: &dyn ArtifactStore,
    checkpoint: &WorkspaceCheckpoint,
) -> Result<Artifact, String> {
    let bytes = store
        .get(&checkpoint.snapshot)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

/// 每条可选消息这一回合的改动（列表每行的摘要）；artifact 读不出的回合按没有改动显示。
///
/// 远端执行 F98（remote-exec.md §25.4.5，Docker 试用 L8）：改动按 checkpoint 的机器分开算（两台机器上的同名文件不合在
/// 一起），远端的带机器名；再按路径排（只有本机时与原来相同）。
pub(crate) async fn options(store: &dyn ArtifactStore, snapshot: Snapshot) -> Vec<RewindOption> {
    let mut out = Vec::new();
    for (message, turn, code) in snapshot.options {
        let mut machines: Vec<(MachineName, Vec<Artifact>)> = Vec::new();
        for checkpoint in &turn {
            let Ok(artifact) = read(store, checkpoint).await else {
                continue;
            };
            match machines.iter_mut().find(|(m, _)| *m == checkpoint.machine) {
                Some((_, artifacts)) => artifacts.push(artifact),
                None => machines.push((checkpoint.machine.clone(), vec![artifact])),
            }
        }
        let mut files: Vec<_> = machines
            .into_iter()
            .flat_map(|(machine, artifacts)| {
                rewind_plan::changes(&artifacts)
                    .into_iter()
                    .map(move |change| rust_cli_kernel_api::session_api::FileChange {
                        machine: machine.clone(),
                        ..change
                    })
            })
            .collect();
        // 同一路径主 env 在前、额外机器按名字（`remote()` 的 None 排在前面）。
        files.sort_by(|a, b| (&a.path, a.machine.remote()).cmp(&(&b.path, b.machine.remote())));
        out.push(RewindOption {
            message,
            files,
            code,
        });
    }
    out
}

/// One planned path with the checkpoint statistics the preview reports for it.
struct Planned {
    restore: RestoreFile,
    operations: u32,
    tools: Vec<String>,
}

/// Fork: what the code rewind would do, computed without changing anything (Node's file rewind
/// preview): the same plan and the same hash check as the rewind, but the prepared token is
/// released without applying and no fact is committed. Checkpoints whose artifact cannot be
/// fetched or parsed are reported by their artifact id (their file list is unknown); a path the
/// plan cannot use is reported per path as `UnsupportedCheckpoint`.
pub(crate) async fn preview(
    store: &dyn ArtifactStore,
    snapshot: Preview,
) -> Result<RewindPreview, String> {
    let Preview { groups } = snapshot;
    let mut out = RewindPreview::default();
    for group in &groups {
        // Checkpoints first: a snapshot the store cannot produce is gone; bytes that do not parse
        // are unreadable. Such a checkpoint keeps running the preview of the readable ones.
        let mut artifacts: Vec<Artifact> = Vec::new();
        for checkpoint in &group.checkpoints {
            let unread = |reason: RewindUnsafeReason, message: String| RewindUnsafeFile {
                path: checkpoint.snapshot.id.to_string(),
                reason,
                operation_count: 1,
                tool_names: Vec::new(),
                current_hash: None,
                expected_hash: None,
                message: Some(message),
            };
            match store.get(&checkpoint.snapshot).await {
                Ok(bytes) => match serde_json::from_slice::<Artifact>(&bytes) {
                    Ok(artifact) => artifacts.push(artifact),
                    Err(error) => out.unsafe_files.push(unread(
                        RewindUnsafeReason::CheckpointUnreadable,
                        error.to_string(),
                    )),
                },
                Err(error) => out.unsafe_files.push(unread(
                    RewindUnsafeReason::CheckpointMissing,
                    error.to_string(),
                )),
            }
        }
        // Per path: how many checkpoint operations touched it and which tools wrote it (older
        // artifacts record no tool name; those report none).
        let mut stats: Vec<(String, u32, Vec<String>)> = Vec::new();
        for artifact in &artifacts {
            for file in &artifact.files {
                let tool = artifact.tool_name.clone();
                match stats.iter_mut().find(|(path, _, _)| path == &file.path) {
                    Some((_, operations, tools)) => {
                        *operations += 1;
                        if let Some(tool) = tool.filter(|tool| !tools.contains(tool)) {
                            tools.push(tool);
                        }
                    }
                    None => stats.push((file.path.clone(), 1, tool.into_iter().collect())),
                }
            }
        }
        // plan() simulates each path independently, so planning one path's entries alone gives the
        // same result for it as the rewind's whole-group plan; an error names this path.
        let mut planned: Vec<Planned> = Vec::new();
        for (path, operations, tools) in &stats {
            let entries: Vec<Artifact> = artifacts
                .iter()
                // plan() reads only the contents; the hunks are irrelevant here.
                .map(|artifact| Artifact {
                    files: artifact
                        .files
                        .iter()
                        .filter(|file| &file.path == path)
                        .cloned()
                        .collect(),
                    tool_name: artifact.tool_name.clone(),
                })
                .filter(|artifact| !artifact.files.is_empty())
                .collect();
            match rewind_plan::plan(&entries) {
                // plan() returns exactly one restore per distinct path.
                Ok(files) => planned.extend(files.into_iter().map(|restore| Planned {
                    restore,
                    operations: *operations,
                    tools: tools.clone(),
                })),
                Err(message) => out.unsafe_files.push(RewindUnsafeFile {
                    path: path.clone(),
                    reason: RewindUnsafeReason::UnsupportedCheckpoint,
                    operation_count: *operations,
                    tool_names: tools.clone(),
                    current_hash: None,
                    expected_hash: None,
                    message: Some(message),
                }),
            }
        }
        if planned.is_empty() {
            continue;
        }
        // Dry-run the rewind's hash check: prepare registers the token only when every file
        // matches; finish then releases it without applying (releasing a token that was never
        // registered is a no-op in the execution environments).
        let files: Vec<RestoreFile> = planned.iter().map(|item| item.restore.clone()).collect();
        let checked = group
            .port
            .rewind_prepare(
                &group.workspace,
                group.context.clone(),
                RewindPrepare { files },
            )
            .await
            .map_err(|error| error.to_string())?;
        if let Err(error) = group.port.rewind_finish(group.token()).await {
            tracing::warn!(%error, "rewind preview token was not released");
        }
        let conflicts = match checked {
            RewindPlan::Conflicts { files } => files,
            _ => Vec::new(),
        };
        for item in planned {
            // Clone out of the conflict list: the matching entry is moved into the report.
            let found = conflicts
                .iter()
                .find(|conflict| conflict.path.as_str() == item.restore.path.as_str())
                .cloned();
            let path = item.restore.path.as_str().to_owned();
            let expected = item.restore.expected.clone();
            match found {
                None => out.safe.push(RewindSafeFile {
                    path,
                    delete: item.restore.restore.is_none(),
                    operation_count: item.operations,
                    tool_names: item.tools,
                }),
                // A conflict with a message means the current content could not be read.
                Some(conflict) => out.unsafe_files.push(RewindUnsafeFile {
                    path,
                    reason: if conflict.message.is_some() {
                        RewindUnsafeReason::FileReadFailed
                    } else {
                        RewindUnsafeReason::ExternalModified
                    },
                    operation_count: item.operations,
                    tool_names: item.tools,
                    current_hash: conflict.current,
                    expected_hash: expected,
                    message: conflict.message,
                }),
            }
        }
    }
    out.safe.sort_by(|a, b| a.path.cmp(&b.path));
    out.unsafe_files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// 回执里恢复的文件：各台机器的，按分组的顺序（本机在前，R3）。
fn rewound_files(groups: &[rewind_machines::Restored]) -> Vec<RewoundFile> {
    groups
        .iter()
        .flat_map(|(machine, files)| {
            files.iter().map(|file| RewoundFile {
                path: file.path.clone(),
                action: file.action,
                machine: machine.clone(),
            })
        })
        .collect()
}

impl Actor {
    pub(crate) fn rewind_snapshot(&self) -> Snapshot {
        let options = self
            .messages
            .iter()
            .filter_map(rewind_plan::selectable)
            .map(|user| {
                let turn = self
                    .checkpoints
                    .iter()
                    .filter(|c| c.prompt == user.id)
                    .cloned()
                    .collect();
                let code =
                    !rewind_plan::checkpoints_from(&self.messages, &self.checkpoints, &user.id)
                        .is_empty();
                (user.id.clone(), turn, code)
            })
            .collect();
        Snapshot { options }
    }

    /// Fork: the machine groups a dry-run preview of a code rewind to `target` would check (Node's
    /// file rewind preview): the same checkpoint selection and grouping as [`Actor::rewind`] with
    /// `RewindScope::Code`; nothing is prepared or applied here. When the target is not selectable
    /// or a remote machine is not connected, `Err` carries the same reason the rewind would give.
    pub(crate) fn rewind_preview(&self, target: &MessageId) -> Result<Preview, String> {
        if self.busy() {
            return Err("a turn is running; rewind after it finishes".to_owned());
        }
        let Some(anchor) = rewind_plan::rewind_anchor(&self.messages, target) else {
            return Err(format!("{target} is not a message to rewind to"));
        };
        let undo: Vec<WorkspaceCheckpoint> =
            rewind_plan::checkpoints_from(&self.messages, &self.checkpoints, anchor)
                .into_iter()
                .cloned()
                .collect();
        self.rewind_preview_of(undo)
    }

    /// Fork: the machine groups a dry-run preview of restoring exactly these checkpoints would
    /// check (shared by the whole-range preview and the per-turn one).
    fn rewind_preview_of(&self, undo: Vec<WorkspaceCheckpoint>) -> Result<Preview, String> {
        self.rewind_groups(undo).map(|groups| Preview { groups })
    }

    /// Fork: like [`Actor::rewind_preview`], but over only the checkpoints of the turn opened by
    /// `turn_input` (the App's per-turn `fileRewindPreview`): the planning and the hash check are
    /// the same [`rewind::preview`], the selection is the turn's own writes.
    pub(crate) fn turn_rewind_preview(&self, turn_input: &MessageId) -> Result<Preview, String> {
        if self.busy() {
            return Err("a turn is running; rewind after it finishes".to_owned());
        }
        if !self
            .messages
            .iter()
            .any(|m| m.id() == turn_input && rewind_plan::selectable(m).is_some())
        {
            return Err(format!("{turn_input} is not a message to rewind to"));
        }
        let undo: Vec<WorkspaceCheckpoint> =
            crate::turn_files::turn_checkpoints(&self.checkpoints, turn_input)
                .into_iter()
                .cloned()
                .collect();
        if undo.is_empty() {
            return Err("there are no code changes to restore".to_owned());
        }
        self.rewind_preview_of(undo)
    }

    pub(crate) async fn rewind(
        &mut self,
        command: CommandId,
        target: MessageId,
        scope: RewindScope,
        reply: oneshot::Sender<Ack>,
    ) {
        if self.busy() {
            let _ = reply.send(rejected("a turn is running; rewind after it finishes"));
            return;
        }
        // Fork: a guided steer is a target too; its files are undone from the turn's opener.
        let Some(anchor) = rewind_plan::rewind_anchor(&self.messages, &target) else {
            let _ = reply.send(rejected(format!("{target} is not a message to rewind to")));
            return;
        };
        let undo: Vec<WorkspaceCheckpoint> =
            rewind_plan::checkpoints_from(&self.messages, &self.checkpoints, anchor)
                .into_iter()
                .cloned()
                .collect();
        let code = matches!(scope, RewindScope::Code | RewindScope::Both);
        if !code || (undo.is_empty() && scope == RewindScope::Both) {
            let ack = match self
                .rewind_conversation(Some(command), &target, Vec::new())
                .await
            {
                Ok(removed) => Ack::Accepted {
                    result: CommandResult::Rewound {
                        restored: Vec::new(),
                        removed,
                    },
                },
                Err(reason) => rejected(reason),
            };
            let _ = reply.send(ack);
            return;
        }
        if undo.is_empty() {
            let _ = reply.send(rejected("there are no code changes to restore"));
            return;
        }
        // 按机器分组（R3，remote-exec.md §20.7.5）：本机在前，远端按名字；远端没连上就整体拒绝。
        let groups = match self.rewind_groups(undo) {
            Ok(groups) => groups,
            Err(reason) => {
                let _ = reply.send(rejected(reason));
                return;
            }
        };
        let tokens = groups
            .iter()
            .map(|group| (group.port.clone(), group.token().clone()))
            .collect();
        let store = self.deps.artifacts.clone();
        let task = self.deps.spawner.spawn("rewind-code", async move {
            let outcome = rewind_machines::restore(store.as_ref(), &groups).await;
            JobDone::Rewind(Box::new(Finished {
                command,
                target,
                scope,
                reply,
                tokens,
                restored: outcome.restored,
                result: outcome.result.map(|done| rewound_files(&done)),
            }))
        });
        self.job = Some(Job { task, cancel: None });
    }

    /// Fork: [`Command::RewindTurnFiles`] — restore only the turn's own checkpoints (the App's
    /// per-turn summary rewind, Node `applyFileRewind`); the conversation is not cut. The guards
    /// match the rewind: a busy session rejects, and the turn must still have unrestored
    /// checkpoints. The reply waits for the transaction, like [`Actor::rewind`].
    pub(crate) async fn rewind_turn_files(
        &mut self,
        command: CommandId,
        target: MessageId,
        reply: oneshot::Sender<Ack>,
    ) {
        if self.busy() {
            let _ = reply.send(rejected("a turn is running; rewind after it finishes"));
            return;
        }
        if !self
            .messages
            .iter()
            .any(|m| m.id() == &target && rewind_plan::selectable(m).is_some())
        {
            let _ = reply.send(rejected(format!("{target} is not a message to rewind to")));
            return;
        }
        let undo: Vec<WorkspaceCheckpoint> =
            crate::turn_files::turn_checkpoints(&self.checkpoints, &target)
                .into_iter()
                .cloned()
                .collect();
        if undo.is_empty() {
            let _ = reply.send(rejected("there are no code changes to restore"));
            return;
        }
        let groups = match self.rewind_groups(undo) {
            Ok(groups) => groups,
            Err(reason) => {
                let _ = reply.send(rejected(reason));
                return;
            }
        };
        let tokens = groups
            .iter()
            .map(|group| (group.port.clone(), group.token().clone()))
            .collect();
        let store = self.deps.artifacts.clone();
        let task = self.deps.spawner.spawn("rewind-turn-files", async move {
            let outcome = rewind_machines::restore(store.as_ref(), &groups).await;
            JobDone::TurnFilesRewound(Box::new(TurnRewound {
                command,
                turn_input: target,
                reply,
                tokens,
                restored: outcome.restored,
                result: outcome.result.map(|done| rewound_files(&done)),
            }))
        });
        self.job = Some(Job { task, cancel: None });
    }

    /// Fork: the per-turn summary rewind's transaction ended: commit the restored checkpoints
    /// (with the turn's reverted marker, so a cold open keeps the header), flip the turn's
    /// summary to reverted, reply (`removed: 0` — the conversation is not cut), then release the
    /// tokens.
    pub(crate) async fn finish_turn_rewind(&mut self, finished: TurnRewound) {
        let TurnRewound {
            command,
            turn_input,
            reply,
            tokens,
            restored: checkpoints,
            result,
        } = finished;
        let ack = match result {
            // Same partial-success rule as the rewind: machines that applied are recorded.
            Err(reason) if !checkpoints.is_empty() => {
                let mut facts = vec![Fact::CheckpointsRestored {
                    checkpoints: checkpoints.clone(),
                }];
                facts.extend(self.reverted_entries(&checkpoints));
                if self.commit(Some(command), facts).await.is_ok() {
                    self.checkpoints_restored(&checkpoints);
                }
                rejected(reason)
            }
            Err(reason) => rejected(reason),
            Ok(restored) => {
                let mut facts = vec![Fact::CheckpointsRestored {
                    checkpoints: checkpoints.clone(),
                }];
                facts.extend(self.reverted_entries(&checkpoints));
                match self.commit(Some(command), facts).await {
                    Ok(()) => {
                        self.checkpoints_restored(&checkpoints);
                        tracing::info!(
                            event = "session.turn_files_rewound",
                            turn = %turn_input,
                            files = restored.len(),
                            "per-turn summary rewind committed"
                        );
                        Ack::Accepted {
                            result: CommandResult::Rewound {
                                restored,
                                removed: 0,
                            },
                        }
                    }
                    Err(error) => rejected(error),
                }
            }
        };
        let _ = reply.send(ack);
        drop(self.deps.spawner.spawn("rewind-finish", async move {
            for (port, token) in tokens {
                if let Err(error) = port.rewind_finish(&token).await {
                    tracing::warn!(%error, "rewind token was not released");
                }
            }
        }));
        self.start_next().await;
    }

    /// Drop the restored checkpoints from the session's list and flip every turn that was left
    /// without checkpoints to reverted (its summary stays for the view, now `reverted`).
    fn checkpoints_restored(&mut self, restored: &[String]) {
        let prompts = self.fully_restored(restored);
        self.checkpoints.retain(|c| !restored.contains(&c.id));
        for prompt in prompts {
            self.turn_files_reverted(&prompt);
        }
    }

    /// 事务结束：先提交（撤销的 checkpoint、对话游标），再改内存、发事件、回复，最后释放 token。
    pub(crate) async fn finish_rewind(&mut self, finished: Finished) {
        let Finished {
            command,
            target,
            scope,
            reply,
            tokens,
            restored: checkpoints,
            result,
        } = finished;
        let ack = match result {
            // 跨机器时一台 apply 失败：成功的那几台已经改回，记下它们（不动对话），再拒绝（R3）。
            Err(reason) if !checkpoints.is_empty() => {
                let mut facts = vec![Fact::CheckpointsRestored {
                    checkpoints: checkpoints.clone(),
                }];
                facts.extend(self.reverted_entries(&checkpoints));
                if self.commit(Some(command), facts).await.is_ok() {
                    self.checkpoints_restored(&checkpoints);
                }
                rejected(reason)
            }
            Err(reason) => rejected(reason),
            Ok(restored) => {
                let mut facts = vec![Fact::CheckpointsRestored {
                    checkpoints: checkpoints.clone(),
                }];
                facts.extend(self.reverted_entries(&checkpoints));
                let committed = if scope == RewindScope::Both {
                    self.rewind_conversation(Some(command), &target, facts)
                        .await
                } else {
                    self.commit(Some(command), facts)
                        .await
                        .map(|()| 0)
                        .map_err(|error| error.to_string())
                };
                match committed {
                    Ok(removed) => {
                        self.checkpoints_restored(&checkpoints);
                        Ack::Accepted {
                            result: CommandResult::Rewound { restored, removed },
                        }
                    }
                    Err(reason) => rejected(reason),
                }
            }
        };
        let _ = reply.send(ack);
        drop(self.deps.spawner.spawn("rewind-finish", async move {
            for (port, token) in tokens {
                if let Err(error) = port.rewind_finish(&token).await {
                    tracing::warn!(%error, "rewind token was not released");
                }
            }
        }));
        self.start_next().await;
    }

    /// esc 撤回刚发的输入（`Command::RestoreCancelled`，修复线 F38，spec §5.5）。判断与回退在
    /// actor 的一次处理里：TUI 判断时内核可能已经开了排队的回合或通知的回合，这里看到的才是唯一的事实。回执带回
    /// 这条输入（前端放回输入框；`HistoryRewritten` 之后的视图里已经没有它）。
    pub(crate) async fn restore_cancelled(&mut self, command: CommandId) -> Ack {
        if self.busy() {
            return rejected("a turn is running");
        }
        if self.inbox.has_inputs() {
            return rejected("inputs are queued");
        }
        let Some(index) = self
            .messages
            .iter()
            .rposition(|m| rewind_plan::selectable(m).is_some())
        else {
            return rejected("there is no input to restore");
        };
        if rewind_plan::answered(&self.messages[index + 1..]) {
            return rejected("the input was answered");
        }
        let message = self.messages[index].clone();
        match self
            .rewind_conversation(Some(command), message.id(), Vec::new())
            .await
        {
            Ok(removed) => Ack::Accepted {
                result: CommandResult::Restored {
                    message: Box::new(message),
                    removed,
                },
            },
            Err(reason) => rejected(reason),
        }
    }

    /// 要撤销的 checkpoint 按机器分组：本机在前，远端按名字；每组一个 token、那台机器的端口与工作区。
    fn rewind_groups(&self, undo: Vec<WorkspaceCheckpoint>) -> Result<Vec<Group>, String> {
        let mut names: Vec<MachineName> = Vec::new();
        for checkpoint in &undo {
            if !names.contains(&checkpoint.machine) {
                names.push(checkpoint.machine.clone());
            }
        }
        // 主 env 在前，额外机器按名字（`remote()` 的 None 排在前面）。
        names.sort_by(|a, b| a.remote().cmp(&b.remote()));
        let mut groups = Vec::new();
        for machine in names {
            let (port, workspace) = match machine.remote() {
                None => (
                    self.deps.machines.primary_machine().checkpoints().clone(),
                    self.meta.workspace.clone(),
                ),
                Some(name) => match self.deps.machines.remote(&machine) {
                    Some((env, workspace)) => (env.checkpoints().clone(), workspace),
                    None => {
                        return Err(format!("Cannot restore code: {}", not_connected(name)));
                    }
                },
            };
            let context = self.deps.operations.next(
                workspace.environment.clone(),
                Origin::User {
                    session: Some(self.meta.id.clone()),
                },
            );
            let checkpoints = undo
                .iter()
                .filter(|c| c.machine == machine)
                .cloned()
                .collect();
            groups.push(Group {
                machine,
                checkpoints,
                port,
                workspace,
                context,
            });
        }
        Ok(groups)
    }

    /// 历史截到 target 之前（`session.revert` 单游标）；`extra` 与游标在同一批提交。返回去掉的消息数。
    async fn rewind_conversation(
        &mut self,
        command: Option<CommandId>,
        target: &MessageId,
        extra: Vec<Fact>,
    ) -> Result<usize, String> {
        let index = self
            .messages
            .iter()
            .position(|m| m.id() == target)
            .ok_or_else(|| format!("{target} is not in the conversation"))?;
        let cut_after = self
            .messages
            .last()
            .map(|m| m.id().clone())
            .unwrap_or_else(|| target.clone());
        let generation = self.generation + 1;
        let cursor = RevertCursor {
            target: target.clone(),
            kept: self.messages[..index]
                .iter()
                .map(|m| m.id().clone())
                .collect(),
            cut_after,
            generation,
        };
        let mut facts = extra;
        facts.push(Fact::RevertSet { cursor });
        // 回执的拒绝原因是给前端的文字：存储的错误在这里按原文写进去。
        self.commit(command, facts)
            .await
            .map_err(|error| error.to_string())?;
        let removed = self.messages.len() - index;
        self.messages.truncate(index);
        self.generation = generation;
        self.log
            .append(KernelEvent::HistoryRewritten { generation });
        Ok(removed)
    }
}

#[cfg(test)]
#[path = "rewind_tests.rs"]
pub(crate) mod tests;

// Fork: tests for the dry-run preview (Node's file rewind preview).
#[cfg(test)]
#[path = "rewind_preview_tests.rs"]
mod preview_tests;

#[cfg(test)]
#[path = "restore_cancelled_tests.rs"]
mod restore_cancelled_tests;
