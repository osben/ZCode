//! `zcode app-server --stdio [--surface desktop]`（docs/specs/rust-cli/app-protocol.md §3.7、§10）：App 的 Host 经 stdio
//! 拉起的协议前端。参数照 Host 现在给 Node 的（`ZA:zcodeAgentProcessManager.ts` 的 `applyPresentationSurfaceToCommand`）。
//!
//! 组装与 `-p`、交互界面共用（[`crate::assemble`]，规格是 `Controller::app`：交互形态的提示词与工具；不问工作区信任、不生成
//! 标题、不连远端机器、不登记跨会话通信、只接受本地主 env、root 下的 bypass 照 Node 不拒绝）；区别只在注入的东西：平台层的
//! 账号凭据来源经 Host（G8），前端是 `protocol-zcode`。写者先起；读完配置、库的位置定了之后报 `startup/storageState` 的
//! `checking`（Host 要求拉起后 30 s 内有首帧），接着查会话库（打不开时报 `failed`），建好内核、开始连接 MCP 之后报 `ready`。

use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::store::{SessionFilter, SessionStore};
use rust_cli_kernel_api::workflow_run::WorkflowRunHost;
use rust_cli_kernel_api::workflow_snippet::{LateSnippetPort, WorkflowSnippetPort};
use rust_cli_node_store::LOCAL_ENVIRONMENT;
use rust_cli_protocol_core::connection::{self, Options};
use rust_cli_protocol_zcode::{
    Context, Defaults, HOST_ATTACH_ACK_ENV, HostAutomations, HostCredentialCipher, HostHeaders,
    HostOffPeak, HostSubagentConfig, HostTopicResources, NetworkCapture, Startup,
};

use crate::assemble::{self, Controller};
use crate::frontends::app_workspace::{AppWorkspace, ProcessConfig};
use crate::frontends::node_helper;
use crate::frontends::workflow_gating;
use crate::frontends::workflow_service;
use crate::process::{ControllerRun, Start};

/// 退出时等进程级任务收尾的上限（存活的上限，不用来同步状态）。
const SCOPE_CLOSE_GRACE: Duration = Duration::from_secs(2);

/// 子命令的参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Parsed {
    /// `--surface`（Host 给 `desktop`）。Fork: `desktop` turns on Node's "ZCode Desktop Context" system section
    /// (specs/fork-rust-agent-parity.md); the Host omits it when its rollout is off.
    pub(crate) surface: Option<String>,
}
/// `app-server` 子命令；不是它时为 None。只认 `--stdio` 与 `--surface`。
pub(crate) fn parse(args: &[String]) -> Option<Result<Parsed, String>> {
    let (first, rest) = args.split_first()?;
    if first != "app-server" {
        return None;
    }
    let mut stdio = false;
    let mut surface = None;
    let mut rest = rest.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--stdio" => stdio = true,
            "--surface" => match rest.next() {
                Some(value) => surface = Some(value.clone()),
                None => {
                    return Some(Err(
                        "error: option '--surface <surface>' argument missing".into()
                    ));
                }
            },
            other => match other.strip_prefix("--surface=") {
                Some(value) => surface = Some(value.to_owned()),
                None => return Some(Err(format!("error: unknown option '{other}'"))),
            },
        }
    }
    if !stdio {
        return Some(Err("error: app-server needs --stdio".to_owned()));
    }
    Some(Ok(Parsed { surface }))
}

/// 会话库的不透明 ID：库路径的散列（固定的键，同一个库总是同一个 ID；不带路径）。
fn database_id(path: &std::path::Path) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    format!("session-db-{:016x}", hasher.finish())
}

pub(crate) async fn run(parsed: Parsed) -> Result<u8> {
    // 日志只写文件：stdout 是协议（logging.md §6）。
    let run = ControllerRun::begin(Start {
        mode: "app-server",
        surface: Some(parsed.surface.as_deref().unwrap_or("none")),
    })?;
    let scope = TaskScope::root("app-server", |panic| {
        tracing::error!(event = "task.panic", scope = %panic.scope, task = panic.task, message = %panic.message, "a task panicked");
    });
    let (peer, writer) =
        connection::start(tokio::io::stdout(), &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, run.clock.clone()));
    // Fork: the Network panel capture exists before the reader starts (specs/fork-rust-network-capture.md).
    let capture = Arc::new(NetworkCapture::new(
        context.peer.clone(),
        run.clock.clone(),
        scope.spawner(),
        std::process::id(),
    ));
    let desktop_context = parsed.surface.as_deref() == Some("desktop");
    let result = serve(&run, context, &capture, scope.spawner(), desktop_context).await;
    // Node `disconnectClient`: the capture stops with the connection.
    capture.set(None);
    // 写者写完队列里剩下的帧再退出。
    drop(writer);
    let _ = scope.close(SCOPE_CLOSE_GRACE).await;
    run.finish(result.map(|()| 0)).await
}

async fn serve(
    run: &ControllerRun,
    context: Arc<Context>,
    capture: &Arc<NetworkCapture>,
    spawner: rust_cli_base::Spawner,
    desktop_context: bool,
) -> Result<()> {
    let ControllerRun {
        facts,
        paths,
        clock,
        stop,
        model_io,
        ..
    } = run;
    // 凭据加解密委托 Host（Main 持有密钥）：standalone 不经这里（specs/fork-rust-credential-cipher.md）。
    // 读者在组装之前就开始（specs/fork-rust-credential-cipher.md，启动死锁）：组装里的凭据加解密要它送来回复；对端的
    // 请求在内核装好之前等待。
    let (deferred, install) = rust_cli_protocol_core::connection::Deferred::new();
    // Fork: a Host that promises `process/hostAttached` gets no reverse request before it listens; the gate handles
    // the acknowledgement in front of `Deferred` (specs/fork-rust-credential-cipher.md F1).
    if facts.process.env.text(HOST_ATTACH_ACK_ENV) == Some("1") {
        context.expect_host_attach();
    }
    let reader = spawner.spawn(
        "app-server-reader",
        rust_cli_protocol_zcode::serve_attached(
            tokio::io::BufReader::new(tokio::io::stdin()),
            context.clone(),
            // Fork: the capture control is applied in arrival order while the kernel is still being assembled.
            rust_cli_protocol_zcode::with_network_capture(deferred, capture.clone()),
            spawner.clone(),
            Options::default(),
        ),
    );
    // Fork: the Node helper for the JS-only method families, when the Host set its command (Rust mode only). Installed
    // before assembly: its helper-hosted MCP servers are routed through the same helper (F3).
    let node_helper = node_helper::install(
        &context,
        facts.process.env.raw(node_helper::COMMAND_ENV),
        &facts.process.temp,
        &spawner,
    );
    let mut spec = Controller::app(
        Arc::new(HostHeaders::new(context.clone())),
        Arc::new(HostCredentialCipher::new(context.clone())),
        Arc::new(HostAutomations::new(context.clone())),
        // Fork: every observed request of this process reaches the capture (MCP is built unobserved), from the moment
        // the egress exists.
        Arc::new(CaptureObserver(capture.clone())),
        Arc::new(HostTopicResources::new(context.clone(), spawner.clone())),
        Arc::new(HostSubagentConfig::new(context.clone())),
        desktop_context,
    );
    // Fork (F7 PR 3, specs/fork-rust-node-helper.md): the app-provided tools of the panels of Rust-run servers and of the
    // Node helper's servers, composed by name. The Rust side binds when the protocol server is built.
    let app_tools = rust_cli_protocol_zcode::AppToolRouter::new(
        node_helper
            .clone()
            .map(|helper| helper as Arc<dyn rust_cli_kernel_api::app_tool::AppToolHost>),
    );
    context.set_app_tools_router(app_tools.clone());
    spec.app_tools = Some(app_tools);
    // Fork (W7-7a, 9.36): the workflow gate source, over the table the protocol server records into (divergence 56), and
    // the tools wired in this build. The gate stays closed for every session the Host does not open it for.
    // Fork (W7-9, 9.40; W7-8d, 9.39): the run tools and CreateWorkflow reach the run sessions the run service sets below,
    // once it is built. One late slot serves both.
    let run_sessions = Arc::new(rust_cli_kernel_api::workflow_run::LateRunSessions::default());
    // Fork (W7-11, 9.44, closes 411): EvalWorkflowSnippet is offered when the helper and its child launcher exist (the same
    // joint condition the port is set on below, so the tool is never advertised with a port that is never set). The port
    // itself is set once the workspace environment is opened (the gate is built before that).
    let snippet_slot = Arc::new(LateSnippetPort::default());
    let snippets = node_helper
        .as_ref()
        .filter(|_| context.workflow_child().is_some())
        .map(|_| snippet_slot.clone() as Arc<dyn WorkflowSnippetPort>);
    spec.dynamic_workflow = Some(workflow_gating::gating(
        context.dynamic_workflow_gates().clone(),
        node_helper.as_ref(),
        &facts.process.home,
        run_sessions.clone(),
        snippets,
    ));
    spec.node_helper = node_helper;
    // Fork: the Host's off-peak store (specs/fork-rust-automations.md, slice 3).
    spec.off_peak = Some(Arc::new(HostOffPeak::new(context.clone())));
    let opened = assemble::open(&spec, facts, (paths, clock)).await?;
    // Fork: the process entry releases this store's session runtime presence after the runtime has shut down
    // (specs/fork-rust-agent-parity.md "Session runtime presence on the shared database").
    crate::process::release_presence_at_exit(opened.store.clone());
    // 修复（F133，modularity.md §7 的 P5）：以前 ID 取读配置之前的缺省库路径、在开端口之前就报 `checking`，配置或环境变量
    // 改了 `storage.sessionDbPath` 时 ID 不是实际打开的库。ID 又不能在首帧之后改（Host 丢掉 ID 变了的帧，app-protocol.md
    // §4.2），所以首帧等库的位置定了再发：ID 取会话库所用的同一份存储位置。
    let state = Startup::new(
        context.clone(),
        database_id(opened.paths.database().as_path()),
    );
    state.checking().await;
    // 会话库：打开一次（node-store 在打开连接时校验迁移）；失败时报 failed，不再往下组装。
    if let Err(error) = opened
        .store
        .list(SessionFilter {
            workspace: opened.workspace.clone(),
            limit: 1,
        })
        .await
    {
        tracing::warn!(event = "app.storage.failed", error = %error, "opening the session database failed");
        state.failed("open_failed").await;
        anyhow::bail!("opening the session database failed: {error}");
    }
    // Fork: the projection's reasoning levels come from the model directory (specs/fork-rust-agent-parity.md).
    if let Some(directory) = opened.directory.clone() {
        context.set_models(directory);
    }
    // Fork: session erase resolves per-session directories under `<storageRoot>/cli`.
    context.set_storage_root(opened.paths.root().as_path().to_path_buf());
    // Fork: the Host's resource sampler reads the live stdio MCP servers (`process/childProcesses`).
    context.set_mcp_processes(opened.mcp.clone());
    // Fork: one language-server host per process, shared by all workspaces (specs/fork-rust-lsp.md "Owners"). The
    // sidecar's root follows the startup config's `storage.dir`, as Node's protocol entry resolves it once.
    let preferences = paths.lsp_preferences(
        opened.config.storage.dir.as_deref(),
        std::path::Path::new(opened.workspace.root.as_str()),
    );
    let ledger =
        rust_cli_proc::ledger::Ledger::open(rust_cli_proc::private::user_dir(&facts.process.temp));
    let language_servers = Arc::new(crate::lsp::Host::new(crate::lsp::HostInputs {
        files: opened.primary.files().clone(),
        environment: opened.workspace.environment.clone(),
        paths: paths.clone(),
        process_env: facts.process.env.clone(),
        view_host: desktop_context,
        preferences: preferences.as_path().to_path_buf(),
        launcher: Arc::new(crate::lsp::LedgerLauncher::new(ledger)),
        store: Some(opened.store.clone()),
    }));
    context.set_language_servers(language_servers.clone());
    // The same host is the sessions' code intelligence: Read prewarms, Write and Edit report mutations.
    spec.code_intelligence = Some(language_servers);
    let ported = assemble::ports(&spec, facts, opened, (clock, model_io)).await?;
    // Fork: workspace model calls (Git commit message, connectivity probe) go through the entry's model port.
    context.set_model_port(ported.ports.model.clone());
    let built = assemble::kernel(&spec, facts, ported, clock).await?;
    // Fork (W8a, 9.48): a TaskStop or the user's stop of a workflow run reaches the run sessions the service sets below.
    // The agents hold the same late slot the run tools hold, so one run path serves the stop.
    if !built
        .kernel
        .workflow_agents()
        .set_run_sessions(run_sessions.clone())
    {
        tracing::warn!(
            event = "workflow.run.stop_sessions_set_twice",
            "the run stop sessions were set twice; the first one stays"
        );
    }
    // Fork (specs/fork-rust-node-helper.md, F7 PR 1): the panels of the servers Rust runs read their connections
    // through the kernel's extension layer, the one that owns the connections the model calls use.
    context.set_mcp_app_host(built.kernel.mcp_app_host());
    // Fork: workspace trust from the App (specs/fork-rust-agent-parity.md, "Workspace MCP trust"): set before the
    // handler is installed, so the first request already sees it.
    let opened = &built.opened;
    context.set_workspace_admin(Arc::new(
        AppWorkspace::new(
            (opened.primary.files().clone(), paths.clone()),
            ProcessConfig {
                process_env: facts.process.env.clone(),
            },
            built.kernel.project_hook_slots(),
            built.kernel.workspace_layer_host(),
            (opened.primary.mcp().clone(), spawner.clone(), clock.clone()),
            Arc::new(crate::config::workspace_layer::Loader {
                files: opened.primary.files().clone(),
                controller: opened.env.clone(),
                paths: opened.paths.clone(),
                process_env: facts.process.env.clone(),
                flag: None,
                project_is_local: opened.deployment.primary_is_local(),
                process: opened.config.plugins.clone(),
                strict: false,
            }),
        )
        .with_mcp_oauth(
            opened.platform.mcp_oauth_store(),
            opened.platform.mcp_oauth_runtime(),
        ),
    ));
    // Fork: the ACP agents' session config behind `setExternalAgentConfigOption` and the subscribe seed.
    if let Some(configs) = built.kernel.external_agent_configs() {
        context.set_external_agent_configs(configs);
    }
    // Fork (9.30): the workflow run service, over the kernel's residency ledger and the helper's child runner. A run
    // starts only through an open session gate (9.54), so building it opens no database and starts no child.
    let workflow_handle = tokio::runtime::Handle::current();
    // Fork (9.44, closes 412): the sessions' blocked-run reminder clocks. Built before the run service, since the progress
    // host takes them; their run source is set once the service exists (below).
    let reminders = Arc::new(rust_cli_protocol_zcode::WorkflowReminders::new(
        context.dynamic_workflow_gates().clone(),
        Arc::new(rust_cli_protocol_zcode::TokioTimers::new(
            workflow_handle.clone(),
            clock.clone(),
        )),
        Arc::new(rust_cli_protocol_zcode::SignalNotices::new(
            built.kernel.workflow_agents().signals(),
        )),
    ));
    context.set_workflow_reminders(reminders.clone());
    let workflow_service = workflow_service::build(
        context.workflow_runner().cloned(),
        built.kernel.workflow_residency(),
        opened.paths.database().as_path(),
        opened.workspace.root.as_str(),
        built.kernel.workflow_agents(),
        built.kernel.workflow_bindings(workflow_handle.clone()),
        workflow_handle,
        // Fork (9.34): the run progress goes to the parent session's open stream; the journal is the record. Fork (9.38):
        // the parent's model gets the run's escalation and stall notices through the same agents' signal channel.
        Arc::new(
            rust_cli_protocol_zcode::WorkflowProgressHost::new(Arc::new(
                rust_cli_protocol_zcode::BridgeDelivery::new(Arc::downgrade(&context)),
            ))
            .with_notices(Arc::new(rust_cli_protocol_zcode::SignalNotices::new(
                built.kernel.workflow_agents().signals(),
            )))
            .with_reminders(reminders.clone()),
        ),
        // Fork (9.37): the quota resume reads each parent's recorded gate (9.36).
        context.dynamic_workflow_gates().clone(),
        // Fork (9.61): the runs' world reads and artifact publishes reach the workspace's environment and the kernel's
        // artifact store, each read rooted at its run's cwd.
        rust_cli_runtime::workflow_owner::RunWorld {
            roots: Arc::new(rust_cli_env_local::world_ports::WorldRoots::new(
                opened.env.clone(),
                tokio::runtime::Handle::current(),
            )),
            fs: Arc::new(rust_cli_env_local::world_ports::WorldFs),
            store: rust_cli_kernel_api::session_api::Kernel::artifacts(built.kernel.as_ref()).map(
                |store| {
                    Arc::new(rust_cli_env_local::world_ports::StoreAdapter::new(
                        store,
                        tokio::runtime::Handle::current(),
                    ))
                        as Arc<dyn rust_cli_workflow::artifact_publish::ArtifactStorePort>
                },
            ),
        },
    );
    // Fork (W7-11, 9.44, closes 411): the snippet service over the helper's runner and the workspace's environment. Each
    // snippet reads under its own cwd (9.41), so the roots port is the environment's, not the process's.
    if let (Some(helper), Some(launcher)) =
        (spec.node_helper.clone(), context.workflow_child().cloned())
    {
        let runner = rust_cli_protocol_zcode::ProtocolSnippetRunner::new(
            helper,
            launcher,
            spawner.clone(),
            facts.process.temp.join("workflow-runs"),
        );
        let reads = rust_cli_env_local::world_ports::WorldRoots::new(
            opened.env.clone(),
            tokio::runtime::Handle::current(),
        );
        let service = rust_cli_runtime::workflow_snippet::SnippetService::new(
            Arc::new(runner),
            Arc::new(reads),
        );
        if !snippet_slot.set(Arc::new(service)) {
            tracing::warn!(
                event = "workflow.snippet.set_twice",
                "the snippet port was set twice; the first one stays"
            );
        }
    }
    // Fork (9.29, W7-5c): the per-session run reads (`workflowRuns`, the run list) answer from the service too.
    // One wrapper of the service, coerced to each trait object the composition holds (the run sessions and the host).
    // Fork (W9a, 9.53): the hub's start resolves saved workflows in the user's home and checks the script with the helper
    // (the analyzer CreateWorkflow uses). Without a helper the start is unsupported, as the tools are.
    if let (Some(service), Some(helper)) = (&workflow_service, spec.node_helper.as_ref()) {
        let analyzer = Arc::new(
            rust_cli_protocol_zcode::workflow_compile::HelperWorkflowAnalyzer::new(helper.clone()),
        );
        // A refused second set is logged by the run service itself (workflow.run.saved_start_set_twice).
        let _ = service.configure_saved_start(facts.process.home.to_path_buf(), analyzer);
    }
    let workflow_service = workflow_service.map(Arc::new);
    // Fork (9.51, W8d): a settled run posts its terminal notice to the parent session's model, through the agents' channel.
    if let Some(service) = &workflow_service {
        service.configure_terminal_notices(built.kernel.workflow_agents().signals());
    }
    // Fork (9.44): the reminder clocks read each session's runs from the service's memory.
    if let Some(service) = &workflow_service
        && !reminders.set_runs(Arc::new(workflow_service::ServiceRunDecisions(
            Arc::downgrade(service),
        )))
    {
        tracing::warn!(
            event = "workflow.reminder.runs_set_twice",
            "the reminder run source was set twice; the first one stays"
        );
    }
    if let Some(service) = &workflow_service {
        let sessions: Arc<dyn rust_cli_kernel_api::workflow_run::DynamicWorkflowRunSessions> =
            service.clone();
        if !run_sessions.set(sessions.clone()) {
            tracing::warn!(
                event = "workflow.run.sessions_set_twice",
                "the run sessions were set twice; the first one stays"
            );
        }
        context.set_dynamic_workflow_runs(sessions);
    }
    let workflow_runs: Option<Arc<dyn WorkflowRunHost>> =
        workflow_service.map(|service| service as Arc<dyn WorkflowRunHost>);
    if let Some(runs) = &workflow_runs {
        context.set_workflow_runs(runs.clone());
    }
    state.ready().await;
    let defaults = Defaults {
        // App 模式组装时已等缺省模型定下（`Controller::app` 的 `wait_model`；performance.md §12.3 只改 TUI）。Shared, so
        // a degraded default revised later reaches new sessions (fork spec `fork-rust-credential-cipher.md` F3).
        selection: built.selection.clone(),
        mode: built.mode,
        environment: EnvironmentId::new(LOCAL_ENVIRONMENT),
    };
    install.install(rust_cli_protocol_zcode::handler(
        context,
        built.kernel.clone(),
        defaults,
        spawner,
    ));
    // 读到 Host 关掉输入或收到退出信号时结束（Host 回收整棵进程树）。
    // The outcome is kept, not `?`-ed: the drain below runs on every exit, including a failed reader.
    let outcome: anyhow::Result<()> = tokio::select! {
        result = reader => result
            .map_err(|error| anyhow::anyhow!("reading the protocol input: {error}"))
            .and_then(|read| read.map_err(anyhow::Error::from)),
        () = stop.token.cancelled() => Ok(()),
    };
    // Fork (9.30): the run service stops its live runs and closes their parent sessions first, so the drain below only
    // finds sessions the runs did not release. Each failure is logged; the process exits either way.
    if let Some(runs) = &workflow_runs {
        for message in runs.close().await {
            tracing::error!(event = "app.shutdown.run_close_failed", error = %message, "a workflow run did not close at shutdown");
        }
    }
    // Fork (W7-6): shutdown drains the sessions that still hold a live workflow run, with one bound. A session that does
    // not close is logged; the process exits either way.
    for message in
        rust_cli_kernel_api::session_api::Kernel::drain_live_runs(built.kernel.as_ref()).await
    {
        tracing::error!(event = "app.shutdown.drain_failed", error = %message, "a session with a live run did not close at shutdown");
    }
    outcome
}

/// Fork: the egress observer that feeds the Network panel capture.
struct CaptureObserver(Arc<NetworkCapture>);

impl rust_cli_net::RequestObserver for CaptureObserver {
    fn request(&self, method: &str, url: &str) {
        self.0.record(method, url);
    }
}

#[cfg(test)]
#[path = "app_server_tests.rs"]
mod tests;
