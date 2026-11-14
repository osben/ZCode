//! skill、MCP 与插件的入口配置（docs/specs/rust-cli/ext.md §1、§6）；清单来源的合并见 listings.rs。
//! 插件的 agent 与 hooks 在这里转成 agents 与 hooks 的类型（ext.md §4）。

use std::sync::Arc;

use rust_cli_agents::PluginAgentFile;
use rust_cli_ext::Plugins;
use rust_cli_hooks::PluginHooks;
use rust_cli_kernel_api::automation::AutomationPort;
use rust_cli_kernel_api::cron_store::CronStore;
use rust_cli_kernel_api::lsp::CodeIntelligence;
use rust_cli_kernel_api::topic_resource::TopicResources;

pub use rust_cli_ext::ExtConfig;

/// 入口层给内核的扩展配置：配置快照与持久定时任务的存储。MCP 传输在机器上（`MachineEnv::mcp()`，经 `Ports` 的注册表，
/// remote-exec.md §15.8.1）。
#[derive(Clone)]
pub struct Extensions {
    pub config: ExtConfig,
    /// 持久定时任务的存储（入口给本地的 `LocalCronStore`，第二阶段在 App 下换成 App 的实现；tools-more.md
    /// §16.2）。随任务表一起建好（F11，审查 R1-13：原来内核建好后再经 `with_cron_store` 装上）；None 时没有
    /// 持久任务（测试、嵌入）。`-p` 也给：CronCreate `durable: true` 照常写文件，只是不调度。
    pub cron_store: Option<Arc<dyn CronStore>>,
    /// 本机跨会话通信（docs/specs/rust-cli/cross-session.md §2.4）：入口给本地的 `LocalPeers`；缺省关闭。
    pub peers: rust_cli_session::PeerDeps,
    /// `-p` 的输入是 stream-json（不是单次的 print 会话，headless.md §6.1，修复线 F39）：Bash 后台命令的
    /// 缺省期限是 1800000。
    pub streaming_input: bool,
    /// Monitor 开着（工作线 F83，tools-more.md §19.1）：注册 Monitor，Bash 与 CronCreate 的描述随之变，Bash 拦前台的
    /// 长 `sleep`。产品缺省开，由入口给（只给测试用的变量关掉，Windows 上要有 Git Bash）；这里缺省关（测试与嵌入）。
    pub monitor: bool,
    /// Fork: the Node desktop agent's semantics (plan mode boundary `PolicyGate::with_node_plan_mode`, one queued input per
    /// turn); the app-server turns it on.
    pub node_desktop: bool,
    /// Fork: the desktop Host's automation store (specs/fork-rust-automations.md, slice 2). When set, the Cron tools
    /// are Node's five sending to it instead of this process's cron, the local cron gets no store whatever `cron_store`
    /// says (nothing fires twice), and `/loop` is hidden (`ExtConfig::host_automations` is derived from it);
    /// ScheduleWakeup is unchanged.
    pub automation: Option<Arc<dyn AutomationPort>>,
    /// Fork: the Host's topic resources (specs/fork-rust-topic-resource.md); `Some` registers `ReadTopicResource`. Only
    /// the app-server gives it.
    pub topic_resources: Option<Arc<dyn TopicResources>>,
    /// Fork: ACP external agents (the app-server gives it; specs/fork-rust-agent-parity.md "ACP external agents").
    /// None: an `acp:` selection runs on the query loop like any provider.
    pub acp: Option<crate::acp::AcpSetup>,
    /// Fork: the language-server runtime (specs/fork-rust-lsp.md "Runtime"): Read, Edit and Write report to it and the
    /// context builder asks it for the post-edit diagnostics. Only the app-server gives it.
    pub code_intelligence: Option<Arc<dyn CodeIntelligence>>,
    /// Fork: command hooks get Node's stdin and a transcript file (specs/fork-rust-agent-parity.md "Command hook
    /// stdin"). Only the app-server gives it.
    pub hook_transcripts: Option<Arc<dyn rust_cli_kernel_api::hooks::HookTranscripts>>,
}

impl Extensions {
    /// 没有 MCP、没有插件；skill 照常从执行环境发现。
    pub fn none() -> Self {
        Self {
            config: ExtConfig::default(),
            cron_store: None,
            peers: rust_cli_session::PeerDeps::off(),
            streaming_input: false,
            monitor: false,
            node_desktop: false,
            automation: None,
            topic_resources: None,
            acp: None,
            code_intelligence: None,
            hook_transcripts: None,
        }
    }
}

/// 插件里的 agent 文件与 hooks（ext.md §4）；hooks 里的坏项跳过并记警告（hooks.md D1）。
pub(crate) fn plugin_parts(plugins: &Plugins) -> (Vec<PluginAgentFile>, Vec<PluginHooks>) {
    let agents = plugins
        .0
        .iter()
        .flat_map(|plugin| {
            plugin.agent_files.iter().map(|file| PluginAgentFile {
                plugin: plugin.name.clone(),
                root: plugin.dir.clone(),
                path: file.path.clone(),
                namespace: file.namespace.clone(),
            })
        })
        .collect();
    let hooks = plugins
        .0
        .iter()
        .filter(|plugin| !plugin.hooks.is_empty())
        .map(|plugin| {
            let (hooks, warnings) =
                PluginHooks::from_json(&plugin.name, &plugin.dir, &plugin.hooks);
            for warning in warnings {
                tracing::warn!(warning, "plugin hooks");
            }
            hooks
        })
        .collect();
    (agents, hooks)
}

#[cfg(test)]
#[path = "ext_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "ext_lsp_tests.rs"]
mod lsp_tests;
