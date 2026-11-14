//! hooks：事件、matcher 与 command / http / prompt / agent 四类执行（docs/specs/rust-cli/hooks.md）。
//!
//! 输入输出 JSON 见 spec §3、§4；配置是入口层组装的带版本快照（[`HooksConfig`]），
//! 本 crate 不读文件。进程经执行环境端口、网络经 [`HookHttp`] 端口、模型经 [`ModelPort`]、大输出经
//! [`ArtifactStore`]，hook 不直接做 IO。事件专属的处理（反馈文本、attachment 渲染）在这里完成，结果放进
//! [`HookOutcome`]，调用方按字段提交消息、改变流程（spec §6、§7）。
//!
//! | 模块 | 内容 |
//! | --- | --- |
//! | [`config`] | 设置解析与快照 |
//! | `effective` / `plugin` | 来源合并、插件 hooks |
//! | [`node_config`] | Node 配置文件的 `hooks` 段（config.md） |
//! | [`workspace_digest`] | 项目 hooks 的信任 digest（与 Node 逐字节一致） |
//! | `matcher` | match query、matcher、去重与 `if` 条件 |
//! | `input` | 输入 JSON |
//! | `output` / `interpret` | 输出解析、退出码语义 |
//! | `command` / `http` / `prompt` | 执行器 |
//! | `run` | 并发执行 |
//! | `fold` / `fold_session` | 按事件合并成 [`HookOutcome`] |
//! | `persist` | 超过 10000 字符的输出落盘（经 ArtifactStore） |
//! | `texts` | 模型可见的文本 |
//!
//! [`HookHttp`]: rust_cli_kernel_api::hooks::HookHttp
//! [`ModelPort`]: rust_cli_kernel_api::model::ModelPort
//! [`ArtifactStore`]: rust_cli_kernel_api::store::ArtifactStore

mod command;
pub mod config;
mod consts;
mod effective;
mod fold;
mod fold_session;
mod http;
mod input;
mod interpret;
mod listing;
mod mask;
mod matcher;
pub mod node_config;
mod on_error;
mod output;
mod persist;
mod plugin;
mod projects;
mod prompt;
mod records;
mod result;
mod run;
mod texts;
mod transcript;
pub mod workspace_digest;

#[cfg(test)]
mod test_support;

use rust_cli_base::sync::RwLockUnpoisoned;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use rust_cli_base::units;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::hooks::{
    HookEvent, HookEventName, HookOutcome, HookRunner, StopCondition, StopVerdict,
};
use rust_cli_kernel_api::model::small_fast_model;
use rust_cli_kernel_api::side_request::Requester;
use tokio_util::sync::CancellationToken;

pub use config::{HookSource, HooksConfig, HooksSettings};
pub use plugin::PluginHooks;
pub use projects::{ProjectEntry, ProjectEpoch, ProjectHookLoader, ProjectHookSlots, project_key};
pub use run::{HookPorts, NodeStdinPorts};

use crate::config::{HookCommand, HookOrigin};
use crate::effective::Effective;
use crate::fold::Fold;
use crate::http::HttpPolicy;
use crate::run::Batch;

/// 默认超时：UserPromptSubmit 与模型切换 30 秒、SessionEnd 1.5 秒、其他事件 10 分钟。
const PROMPT_TIMEOUT_MS: u64 = 30 * units::MS_PER_SECOND;
const SESSION_END_TIMEOUT_MS: u64 = 1_500;
const DEFAULT_TIMEOUT_MS: u64 = 10 * units::MS_PER_MINUTE;

/// 默认超时（其他事件 10 分钟；UserPromptSubmit 30 秒；SessionEnd 1.5 秒；模型切换 30 秒）。
fn default_timeout_ms(event: HookEventName) -> u64 {
    match event {
        HookEventName::UserPromptSubmit
        | HookEventName::PreModelSwitch
        | HookEventName::PostModelSwitch => PROMPT_TIMEOUT_MS,
        HookEventName::SessionEnd => SESSION_END_TIMEOUT_MS,
        _ => DEFAULT_TIMEOUT_MS,
    }
}

/// 只给出每个 hook 结果、不折叠成消息的事件（“外部”路径）。
fn outside(event: HookEventName) -> bool {
    use HookEventName as E;
    matches!(
        event,
        E::Notification
            | E::SessionEnd
            | E::StopFailure
            | E::PreCompact
            | E::PostCompact
            | E::ConfigChange
            | E::DirectoryAdded
            | E::Elicitation
            | E::ElicitationResult
            | E::CwdChanged
            | E::FileChanged
            | E::InstructionsLoaded
            | E::WorktreeCreate
            | E::WorktreeRemove
    )
}

pub(crate) struct Loaded {
    config: HooksConfig,
    /// 插件的 hooks（与设置快照分开登记，hooks.md §2.2）。
    plugins: Vec<PluginHooks>,
    effective: Effective,
    /// Fork: the settings hooks alone, for an incognito session without plugins.
    without_plugins: Effective,
}

/// hook 引擎：持有当前快照，实现 [`HookRunner`]。
pub struct HookEngine {
    ports: HookPorts,
    /// The process snapshot and the workspaces' project entries (`projects.rs`).
    state: RwLock<projects::State>,
    /// Fork: the sessions' incognito profiles (specs/fork-rust-agent-parity.md, "Incognito sessions").
    incognito: rust_cli_kernel_api::incognito::IncognitoProfiles,
}

impl HookEngine {
    /// 没有任何 hook 的引擎；配置由入口层经 [`HookEngine::replace`] 交进来。
    pub fn new(ports: HookPorts) -> Self {
        Self::with_config(ports, HooksConfig::default())
    }

    pub fn with_config(ports: HookPorts, config: HooksConfig) -> Self {
        Self {
            ports,
            state: RwLock::new(projects::State::new(load(config, Vec::new()))),
            incognito: Default::default(),
        }
    }

    /// Fork: read the sessions' incognito profiles; without hooks a session runs none, without plugins it runs
    /// only the settings hooks.
    #[must_use]
    pub fn with_incognito(
        mut self,
        profiles: rust_cli_kernel_api::incognito::IncognitoProfiles,
    ) -> Self {
        self.incognito = profiles;
        self
    }

    /// 换上新的快照；正在运行的事件用旧快照。插件 hooks
    /// 保留。
    pub fn replace(&self, config: HooksConfig) {
        let mut state = self.state.write_unpoisoned();
        let plugins = state.process.plugins.clone();
        state.set_process(load(config, plugins));
    }

    /// 登记插件的 hooks（runtime 在插件加载后调用，hooks.md §2.2）；设置快照保留。读改写在同一把
    /// 写锁里，与 [`HookEngine::replace`] 不会互相冲掉。
    pub fn register_plugins(&self, plugins: Vec<PluginHooks>) {
        let mut state = self.state.write_unpoisoned();
        let config = state.process.config.clone();
        state.set_process(load(config, plugins));
    }

    /// The process snapshot (user, `--settings` and plugin hooks).
    fn process(&self) -> Arc<Loaded> {
        self.state.read_unpoisoned().process.clone()
    }

    /// hook 输入的 `cwd`：调用方给出的，或会话的 shell cwd，再没有时是工作区根。
    async fn cwd(&self, event: &HookEvent) -> String {
        if let Some(cwd) = &event.context.cwd {
            return cwd.as_str().to_owned();
        }
        self.ports
            .shell
            .shell_state(&event.workspace, &event.session)
            .await
            .map_or_else(
                |_| event.workspace.root.as_str().to_owned(),
                |state| state.cwd.as_str().to_owned(),
            )
    }
}

pub(crate) fn load(config: HooksConfig, plugins: Vec<PluginHooks>) -> Loaded {
    let effective = config.effective_with(&plugins);
    let without_plugins = config.effective_with(&[]);
    Loaded {
        config,
        plugins,
        effective,
        without_plugins,
    }
}

impl HookEngine {
    /// Fork: the dispatch's id and a record per hook, in config order (specs/fork-rust-agent-parity.md HK-UP-01). The
    /// ids are taken after the fold, so the ids the fold and the commands take do not move.
    fn with_runs(
        &self,
        mut outcome: HookOutcome,
        done: &[run::Timed],
        hooks: &[HookCommand],
        origins: &[HookOrigin],
        results: Option<&[result::HookResult]>,
    ) -> HookOutcome {
        outcome.invocation = Some(format!("hookinv_{}", self.ports.ids.execution()));
        outcome.runs = done
            .iter()
            .enumerate()
            .map(|(at, timed)| {
                records::record(records::Ran {
                    run: format!("hookrun_{}", self.ports.ids.execution()),
                    index: u32::try_from(timed.index).unwrap_or(u32::MAX),
                    hook: &hooks[timed.index],
                    origin: &origins[timed.index],
                    executed: &timed.executed,
                    result: results.and_then(|results| results.get(at)),
                    started_at_ms: timed.started_at_ms,
                    duration_ms: timed.duration_ms,
                })
            })
            .collect();
        outcome
    }
}

#[async_trait]
impl HookRunner for HookEngine {
    async fn run(&self, event: HookEvent, cancel: CancellationToken) -> HookOutcome {
        let profile = self.incognito.get(&event.session);
        if !self.process().config.trusted
            || cancel.is_cancelled()
            || profile.as_ref().is_some_and(|profile| !profile.hooks)
        {
            return HookOutcome::default();
        }
        // Fork: the event's own workspace entry (`projects.rs`), assembled first when it has none yet.
        let loaded = self.snapshot_for(&event).await;
        if !loaded.config.trusted || cancel.is_cancelled() {
            return HookOutcome::default();
        }
        let effective = match profile {
            Some(profile) if !profile.plugins => &loaded.without_plugins,
            _ => &loaded.effective,
        };
        let Some(matchers) = effective.matchers.get(&event.name) else {
            return HookOutcome::default();
        };
        let (hooks, origins): (Vec<HookCommand>, Vec<HookOrigin>) =
            matcher::select(event.name, matchers, &event.payload)
                .into_iter()
                .unzip();
        if hooks.is_empty() {
            return HookOutcome::default();
        }
        let query = matcher::match_query(event.name, &event.payload).filter(|q| !q.is_empty());
        let hook_name = input::hook_name(event.name.as_str(), query.as_deref());
        let cwd = self.cwd(&event).await;
        let input = input::build(&event, &cwd).to_string();
        // Only command hooks read the Node stdin (HTTP and prompt hooks keep the Claude Code input).
        let node = self
            .ports
            .node_stdin
            .as_ref()
            .filter(|_| {
                hooks
                    .iter()
                    .any(|hook| matches!(hook, HookCommand::Command(_)))
            })
            .map(|stdin| transcript::NodeStdin {
                input: input::node_compatible(&event, &cwd, stdin.clock.now_ms()),
                transcript: input::transcript_text(&event),
            });
        let batch = Batch {
            event: event.name,
            session: &event.session,
            workspace: &event.workspace,
            context: &event.context,
            input,
            default_timeout_ms: default_timeout_ms(event.name),
            http: HttpPolicy {
                allowed_urls: effective.allowed_urls.as_deref(),
                allowed_env_vars: effective.allowed_env_vars.as_deref(),
                env: loaded.config.env.vars(),
            },
            prompt_model: loaded.config.prompt_model.as_ref(),
            node,
        };
        let mut done = run::run_all(&self.ports, &batch, &hooks, &cancel).await;
        // Node runs the hooks of one event one by one in config order (`runner.ts`) and folds each result as it
        // comes (`mergeHookRunResult`: last `updatedInput`, last reason, last decision). The concurrent run finishes
        // in any order, so every fold reads the results in config order.
        done.sort_by_key(|timed| timed.index);
        let event_name = event.name.as_str();
        if outside(event.name) {
            let summaries: Vec<_> = done
                .iter()
                .map(|timed| {
                    interpret::outside(timed.executed.clone(), &hooks[timed.index].display())
                })
                .collect();
            let outcome = fold_session::outside(event.name, &summaries);
            return self.with_runs(outcome, &done, &hooks, &origins, None);
        }
        let mut results: Vec<_> = done
            .iter()
            .map(|timed| {
                let (index, executed) = (timed.index, timed.executed.clone());
                let hook = &hooks[index];
                let display = hook.display();
                // Node 配置的 `onError: "deny"`（修复线 F68）：PreToolUse 的这个 hook 出错时拦下工具。
                if event.name == HookEventName::PreToolUse && hook.denies_on_error() {
                    let timeout = run::timeout_ms(hook, batch.default_timeout_ms);
                    let result = interpret::repl(executed.clone(), &display, event_name);
                    return on_error::deny(&executed, result, &display, timeout);
                }
                interpret::repl(executed, &display, event_name)
            })
            .collect();
        // 超过 10000 字符的输出先落盘、换成预览，再折叠（hooks.md §4.5，修复线 F15）。
        persist::results(
            self.ports.artifacts.as_ref(),
            &event.session,
            event.name,
            &mut results,
        )
        .await;
        let fold = Fold {
            ids: self.ports.ids.as_ref(),
            event: event_name,
            hook_name: &hook_name,
        };
        use HookEventName as E;
        let outcome = match event.name {
            E::PreToolUse => fold::pre_tool_use(&fold, &results),
            E::PostToolUse => fold::post_tool_use(&fold, &results),
            E::PostToolUseFailure => fold::post_tool_use_failure(&fold, &results),
            E::PermissionRequest => fold::permission_request(&results),
            E::PermissionDenied => fold::permission_denied(&results),
            E::Stop | E::SubagentStop => fold_session::stop(&fold, &results),
            E::UserPromptSubmit => fold_session::user_prompt_submit(
                &fold,
                &results,
                fold_session::prompt_of(&event.payload),
            ),
            E::SessionStart | E::SubagentStart => fold_session::session_start(&fold, &results),
            _ => fold_session::generic(&fold, &results),
        };
        self.with_runs(outcome, &done, &hooks, &origins, Some(&results))
    }

    /// `/goal` 的停止条件（会话级 Stop prompt hook，docs/specs/rust-cli/goal.md §5）：不看配置与信任，
    /// 模型同 prompt hook 的缺省（小模型槽位），超时 30 秒。
    async fn evaluate_stop_condition(
        &self,
        request: StopCondition,
        cancel: CancellationToken,
    ) -> StopVerdict {
        let loaded = self.process();
        let default_model = request
            .event
            .context
            .selection
            .as_ref()
            .map(small_fast_model)
            .or_else(|| loaded.config.prompt_model.clone());
        let input = input::build(&request.event, &self.cwd(&request.event).await).to_string();
        let run = prompt::StopRun {
            model: self.ports.model.as_deref(),
            requester: Requester {
                session: request.event.session.clone(),
                run: request.event.context.run.clone(),
                agent: request.event.context.agent.clone(),
            },
            default_model: default_model.as_ref(),
            ids: self.ports.ids.as_ref(),
            condition: &request.condition,
            input: &input,
            transcript: request.transcript,
            timeout_ms: prompt::DEFAULT_TIMEOUT_MS,
        };
        prompt::evaluate(run, cancel).await
    }

    /// 快照里有这个事件的 matcher（不看 match query）；会话据此决定要不要进入等待
    /// （docs/specs/rust-cli/session-lifecycle.md §3.2）。
    fn has_hooks(&self, event: HookEventName, workspace: &WorkspaceRef) -> bool {
        let state = self.state.read_unpoisoned();
        if !state.process.config.trusted {
            return false;
        }
        if state.unknown(event, workspace) {
            return true;
        }
        state
            .snapshot(workspace)
            .effective
            .matchers
            .get(&event)
            .is_some_and(|matchers| !matchers.is_empty())
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "on_error_tests.rs"]
mod on_error_tests;
