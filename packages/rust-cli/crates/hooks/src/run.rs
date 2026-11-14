//! 并发执行一次事件匹配到的 hook（docs/specs/rust-cli/hooks.md §4.3）。
//!
//! 按完成顺序收集（`FuturesUnordered`），不另起任务。

use std::sync::Arc;

use futures_util::stream::{FuturesUnordered, StreamExt};
use rust_cli_kernel_api::clock::{Clock, Ids};
use rust_cli_kernel_api::env::{OperationContext, Operations, Origin, WorkspaceRef};
use rust_cli_kernel_api::hooks::{HookContext, HookEventName, HookHttp, HookTranscripts};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::machine::{Commands, Shell};
use rust_cli_kernel_api::model::{ModelPort, ModelSelection, small_fast_model};
use rust_cli_kernel_api::side_request::Requester;
use rust_cli_kernel_api::store::ArtifactStore;
use tokio_util::sync::CancellationToken;

use crate::command::{self, CommandRun};
use crate::config::HookCommand;
use crate::http::{self, HttpPolicy};
use crate::prompt::{self, PromptRun};
use crate::result::{Executed, HookResult};
use crate::transcript::{self, NodeStdin};

/// 执行 hook 需要的端口。
#[derive(Clone)]
pub struct HookPorts {
    /// 命令 hook 在本机跑（hooks 都在本机，remote-exec.md §2）。
    pub commands: Arc<dyn Commands>,
    /// hook 输入的 `cwd`：会话的 shell cwd。
    pub shell: Arc<dyn Shell>,
    pub ids: Arc<dyn Ids>,
    /// prompt hook 的模型；没有时 prompt hook 报非阻塞错误。
    pub model: Option<Arc<dyn ModelPort>>,
    /// http hook 的出口；没有时 http hook 报非阻塞错误。
    pub http: Option<Arc<dyn HookHttp>>,
    /// 命令 hook 的操作上下文的工厂（执行环境的当前实例 + `ids`，F134：以前另带一个 `generation`）。
    pub operations: Operations,
    /// 超过 10000 字符的 hook 输出落在这里（与工具结果同一个存储，hooks.md §4.5）。
    pub artifacts: Arc<dyn ArtifactStore>,
    /// Fork: command hooks get Node's stdin and a transcript file when set (the app-server sets it;
    /// specs/fork-rust-agent-parity.md "Command hook stdin").
    pub node_stdin: Option<NodeStdinPorts>,
    /// Fork: the start time and duration of each hook run (specs/fork-rust-agent-parity.md HK-UP-01).
    pub clock: Arc<dyn Clock>,
}

/// Fork: one finished hook of a batch with its start time and duration (HK-UP-01).
pub(crate) struct Timed {
    pub index: usize,
    pub executed: Executed,
    pub started_at_ms: u64,
    pub duration_ms: u64,
}

/// Fork: what Node's command hook stdin needs.
#[derive(Clone)]
pub struct NodeStdinPorts {
    /// Each run's transcript file.
    pub transcripts: Arc<dyn HookTranscripts>,
    /// The input's `timestamp`.
    pub clock: Arc<dyn Clock>,
}

/// 一次事件的执行参数。
pub(crate) struct Batch<'a> {
    pub event: HookEventName,
    pub session: &'a SessionId,
    pub workspace: &'a WorkspaceRef,
    pub context: &'a HookContext,
    pub input: String,
    pub default_timeout_ms: u64,
    pub http: HttpPolicy<'a>,
    pub prompt_model: Option<&'a ModelSelection>,
    /// Fork: the Node stdin for command hooks; set with [`HookPorts::node_stdin`].
    pub node: Option<NodeStdin>,
}

pub(crate) fn timeout_ms(hook: &HookCommand, default: u64) -> u64 {
    match hook.timeout() {
        // 设置里是秒。
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "timeout 已校验为正数"
        )]
        Some(seconds) => (seconds * rust_cli_base::units::MS_PER_SECOND_F64) as u64,
        None => default,
    }
}

fn operation(ports: &HookPorts, batch: &Batch<'_>) -> OperationContext {
    ports.operations.next(
        batch.workspace.environment.clone(),
        match &batch.context.run {
            Some(run) => Origin::Agent {
                session: batch.session.clone(),
                run: run.clone(),
            },
            None => Origin::User {
                session: Some(batch.session.clone()),
            },
        },
    )
}

async fn execute(
    ports: &HookPorts,
    batch: &Batch<'_>,
    hook: &HookCommand,
    cancel: CancellationToken,
) -> Executed {
    let timeout = timeout_ms(hook, batch.default_timeout_ms);
    match hook {
        HookCommand::Command(command) => {
            let staged = match (&ports.node_stdin, &batch.node) {
                (Some(stdin), Some(node)) => {
                    Some(transcript::stage(ports, &stdin.transcripts, node).await)
                }
                _ => None,
            };
            let (text, transcript) = match staged {
                Some(staged) => (Some(staged.text), staged.guard),
                None => (None, None),
            };
            let run = CommandRun {
                commands: ports.commands.clone(),
                workspace: batch.workspace,
                operation: operation(ports, batch),
                hook: command,
                input: text.as_deref().unwrap_or(batch.input.as_str()),
                timeout_ms: timeout,
                transcript,
                cancel_background: ports.node_stdin.is_some(),
            };
            Executed::Raw(command::run(run, cancel).await)
        }
        HookCommand::Http(hook) => Executed::Raw(
            http::run(
                ports.http.as_deref(),
                hook,
                &batch.input,
                timeout,
                &batch.http,
                cancel,
            )
            .await,
        ),
        HookCommand::Prompt(hook) => {
            // `model` 缺省时：缺省模型经小模型槽位从会话当前的主模型得出；调用方没给时用配置的
            // 回退值（model.md §6.1、hooks.md §5.3）。
            let default_model = batch
                .context
                .selection
                .as_ref()
                .map(small_fast_model)
                .or_else(|| batch.prompt_model.cloned());
            let run = PromptRun {
                model: ports.model.as_deref(),
                requester: Requester {
                    session: batch.session.clone(),
                    run: batch.context.run.clone(),
                    agent: batch.context.agent.clone(),
                },
                default_model: default_model.as_ref(),
                hook,
                input: &batch.input,
                // prompt hook 的默认超时是 30 秒。
                timeout_ms: hook.timeout.map_or(prompt::DEFAULT_TIMEOUT_MS, |_| timeout),
                stop_event: matches!(
                    batch.event,
                    HookEventName::Stop | HookEventName::SubagentStop
                ),
            };
            Executed::Result(Box::new(prompt::run(run, cancel).await))
        }
        HookCommand::Agent(_) => Executed::Result(Box::new(HookResult::non_blocking(
            "Agent hooks are not supported yet",
        ))),
    }
}

/// 并发执行，按完成顺序返回 `(在 hooks 里的位置, 结果)`。
pub(crate) async fn run_all(
    ports: &HookPorts,
    batch: &Batch<'_>,
    hooks: &[HookCommand],
    cancel: &CancellationToken,
) -> Vec<Timed> {
    let mut running: FuturesUnordered<_> = hooks
        .iter()
        .enumerate()
        .map(|(index, hook)| {
            let cancel = cancel.clone();
            async move {
                let started_at_ms = ports.clock.now_ms();
                let executed = execute(ports, batch, hook, cancel).await;
                Timed {
                    index,
                    executed,
                    started_at_ms,
                    duration_ms: ports.clock.now_ms().saturating_sub(started_at_ms),
                }
            }
        })
        .collect();
    let mut done = Vec::with_capacity(hooks.len());
    while let Some(result) = running.next().await {
        done.push(result);
    }
    done
}
