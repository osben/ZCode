//! 连接上的共用部分：往 Host 写帧（wire v3、每个订阅自己的逻辑帧序号）、时间与随机标识。

use rust_cli_base::sync::LockUnpoisoned;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::mcp::{McpProcess, McpProcesses};
use rust_cli_kernel_api::model::ModelPort;
use rust_cli_kernel_api::provider::{CatalogModel, ModelDirectory};
use rust_cli_protocol_core::connection::Peer;
use serde_json::{Value, json};

use crate::wire::{self, Envelope, Purpose};

/// 帧的通知名。
pub const FRAME: &str = "v4/conversation/frame";

/// 写帧的一方与时间。会话投影、会话列表与工作区配置的发布者共用。
pub struct Context {
    pub peer: Peer,
    pub clock: Arc<dyn Clock>,
    ordinals: Mutex<HashMap<String, u64>>,
    counter: Mutex<u64>,
    /// 打开着的会话 → 所在的工作区（取账号凭据的反向请求要带工作区）。
    sessions: Mutex<HashMap<String, String>>,
    /// Fork: the off-peak runs of this agent (specs/fork-rust-automations.md, slice 3).
    pub(crate) off_peak: std::sync::Arc<crate::off_peak_control::OffPeakRuns>,
    /// 本进程的随机前缀（代际标识与订阅 ID 用）。
    prefix: String,
    /// Fork: the model directory the projection reads reasoning levels from (Node `listThoughtLevels`).
    models: std::sync::OnceLock<Arc<dyn ModelDirectory>>,
    /// Fork: the storage root for per-session directories (session erase); set once by the
    /// app-server. Without it the erase removes the rows and skips the files.
    storage_root: std::sync::OnceLock<std::path::PathBuf>,
    /// Fork: workspace trust from the App (`fork/workspace_trust.rs`); set once by the app-server.
    workspace_admin: std::sync::OnceLock<Arc<dyn crate::fork::WorkspaceAdmin>>,
    /// Fork (specs/fork-rust-node-helper.md, F7 PR 1): the MCP App port of the Rust-run servers, set by the entry point.
    mcp_app_host: std::sync::OnceLock<Arc<dyn rust_cli_kernel_api::mcp_app::McpAppHost>>,
    /// Fork (F7 PR 1): the Rust owner of the panels of Rust-run servers, created with the protocol server.
    mcp_ui: std::sync::OnceLock<Arc<crate::fork::mcp_ui_rust::RustMcpUi>>,
    /// Fork (F7 PR 3): the app-provided tools router, set by the entry point before assembly (the Node helper's set
    /// and, once the protocol server exists, the Rust panels' set).
    app_tools: std::sync::OnceLock<Arc<crate::fork::mcp_ui_app_tools::AppToolRouter>>,
    /// Fork: whether reverse requests wait for the Host's attach acknowledgement (specs/fork-rust-credential-cipher.md F1).
    pub(crate) attach: crate::attach::HostAttach,
    /// Fork: the Node helper that answers the JS-only method families; set once by the app-server when the Host
    /// configured a helper command (specs/fork-rust-node-helper.md).
    node_helper: std::sync::OnceLock<Arc<crate::fork::node_helper::NodeHelper>>,
    /// Fork: starts the sandbox children of dynamic workflow runs (specs/fork-rust-workflow-engine.md, 4.1); set once by
    /// the composition root when the helper command is configured. Nothing starts a run yet (gate off).
    workflow_child: std::sync::OnceLock<Arc<dyn crate::fork::workflow_child::ChildLauncher>>,
    /// Fork (specs/fork-rust-workflow-engine.md, 9.22 W7-5a-1): the child runner port the runtime reaches through
    /// kernel-api; set once by the composition root beside the launcher. Nothing calls it yet (gate off).
    workflow_runner:
        std::sync::OnceLock<Arc<dyn rust_cli_kernel_api::workflow_child::WorkflowChildRunner>>,
    /// Fork: the entry's model port for workspace model calls (`fork::workspace_model`); without it those methods
    /// stay unported.
    model_port: std::sync::OnceLock<Arc<dyn ModelPort>>,
    /// Fork: the live stdio MCP server processes (`process/childProcesses`); set once by the app-server.
    mcp_processes: std::sync::OnceLock<Arc<dyn McpProcesses>>,
    /// Fork: the language-server host behind `lsp/*` (specs/fork-rust-lsp.md); without it they answer -32000.
    language_servers: std::sync::OnceLock<Arc<dyn rust_cli_kernel_api::lsp::LanguageServers>>,
    /// Fork: the ACP agents' session config (`setExternalAgentConfigOption` and the subscribe seed); set once by the
    /// app-server when the ACP host runs. Without it the command answers `fault.command.capabilityUnsupported`.
    external_agent_configs: std::sync::OnceLock<
        Arc<dyn rust_cli_kernel_api::external_agent_config::ExternalAgentConfigs>,
    >,
}

impl Context {
    /// Fork: the model directory (the app-server sets it once at startup; without it the projection offers only the
    /// selected reasoning level).
    pub fn set_models(&self, models: Arc<dyn ModelDirectory>) {
        let _ = self.models.set(models);
    }

    /// Fork: the Node helper (set once; without it the forwarded families answer as before).
    pub fn set_node_helper(&self, helper: Arc<crate::fork::node_helper::NodeHelper>) {
        let _ = self.node_helper.set(helper);
    }

    /// Fork: the Node helper, when one is configured.
    pub fn node_helper(&self) -> Option<&Arc<crate::fork::node_helper::NodeHelper>> {
        self.node_helper.get()
    }

    /// Fork: the sandbox child launcher of workflow runs (set once; without it no run can start).
    pub fn set_workflow_child(
        &self,
        launcher: Arc<dyn crate::fork::workflow_child::ChildLauncher>,
    ) {
        let _ = self.workflow_child.set(launcher);
    }

    /// Fork: the sandbox child launcher, when the helper command is configured.
    pub fn workflow_child(&self) -> Option<&Arc<dyn crate::fork::workflow_child::ChildLauncher>> {
        self.workflow_child.get()
    }

    /// Fork (W7-5a-1): the workflow child runner port (set once; without it no run can start).
    pub fn set_workflow_runner(
        &self,
        runner: Arc<dyn rust_cli_kernel_api::workflow_child::WorkflowChildRunner>,
    ) {
        let _ = self.workflow_runner.set(runner);
    }

    /// Fork (W7-5a-1): the workflow child runner port, when the helper command is configured.
    pub fn workflow_runner(
        &self,
    ) -> Option<&Arc<dyn rust_cli_kernel_api::workflow_child::WorkflowChildRunner>> {
        self.workflow_runner.get()
    }

    /// Fork: the storage root (Node `context.deps.storageRoot`).
    pub fn set_storage_root(&self, root: std::path::PathBuf) {
        let _ = self.storage_root.set(root);
    }

    /// Fork: the workspace trust admin (Node's MCP list, MCP trust and hook trust grant).
    pub fn set_workspace_admin(&self, admin: Arc<dyn crate::fork::WorkspaceAdmin>) {
        let _ = self.workspace_admin.set(admin);
    }

    pub(crate) fn workspace_admin(&self) -> Option<Arc<dyn crate::fork::WorkspaceAdmin>> {
        self.workspace_admin.get().cloned()
    }

    /// Fork (F7 PR 1): the entry point's MCP App port (the extension layer's connections).
    pub fn set_mcp_app_host(&self, host: Arc<dyn rust_cli_kernel_api::mcp_app::McpAppHost>) {
        let _ = self.mcp_app_host.set(host);
    }

    pub(crate) fn mcp_app_host(
        &self,
    ) -> Option<&Arc<dyn rust_cli_kernel_api::mcp_app::McpAppHost>> {
        self.mcp_app_host.get()
    }

    /// Fork (F7 PR 1): the panel owner, once the protocol server exists (`lib.rs`).
    pub(crate) fn mcp_ui(&self) -> Option<&Arc<crate::fork::mcp_ui_rust::RustMcpUi>> {
        self.mcp_ui.get()
    }

    pub(crate) fn set_mcp_ui(&self, ui: Arc<crate::fork::mcp_ui_rust::RustMcpUi>) {
        if self.mcp_ui.set(ui.clone()).is_ok()
            && let Some(router) = self.app_tools.get()
        {
            router.bind_rust(ui);
        }
    }

    /// Fork (F7 PR 3): the app-provided tools router the entry point installs before assembling the kernel. When the
    /// panel owner already exists, it is bound now; otherwise the owner binds it when it is installed.
    pub fn set_app_tools_router(&self, router: Arc<crate::fork::mcp_ui_app_tools::AppToolRouter>) {
        if self.app_tools.set(router.clone()).is_ok()
            && let Some(ui) = self.mcp_ui.get()
        {
            router.bind_rust(ui.clone());
        }
    }

    /// Fork: the Host promised an attach acknowledgement (`ZCODE_HOST_ATTACH_ACK`); reverse requests wait for it.
    pub fn expect_host_attach(&self) {
        self.attach.expect();
    }

    /// Fork: the Host's attach acknowledgement arrived.
    pub(crate) fn host_attached(&self, credential_cipher: bool) {
        self.attach.attached(credential_cipher);
    }

    /// Fork: waits until reverse requests may be sent. `None` when no acknowledgement was promised; otherwise whether
    /// the Host answers credential cipher requests.
    pub(crate) async fn host_ready(&self) -> Option<bool> {
        self.attach.ready().await
    }

    /// Fork: the language-server host (the app-server sets it once at startup).
    pub fn set_language_servers(&self, host: Arc<dyn rust_cli_kernel_api::lsp::LanguageServers>) {
        let _ = self.language_servers.set(host);
    }

    /// Fork: the language-server host, when the entry point provided one.
    pub(crate) fn language_servers(
        &self,
    ) -> Option<&Arc<dyn rust_cli_kernel_api::lsp::LanguageServers>> {
        self.language_servers.get()
    }

    /// Fork: the ACP agents' session config (the app-server sets it once at startup).
    pub fn set_external_agent_configs(
        &self,
        configs: Arc<dyn rust_cli_kernel_api::external_agent_config::ExternalAgentConfigs>,
    ) {
        let _ = self.external_agent_configs.set(configs);
    }

    /// Fork: the ACP agents' session config, when the entry point runs the ACP host.
    pub(crate) fn external_agent_configs(
        &self,
    ) -> Option<&Arc<dyn rust_cli_kernel_api::external_agent_config::ExternalAgentConfigs>> {
        self.external_agent_configs.get()
    }

    /// Fork: the model port the workspace model calls use (the app-server sets it once at startup).
    pub fn set_model_port(&self, model: Arc<dyn ModelPort>) {
        let _ = self.model_port.set(model);
    }

    /// Fork: the model port, when the entry point provided one and a model directory resolves selections.
    pub(crate) fn model_port(&self) -> Option<Arc<dyn ModelPort>> {
        self.models.get()?;
        self.model_port.get().cloned()
    }

    /// Fork: the storage root, when the entry point provided one.
    pub fn storage_root(&self) -> Option<&std::path::Path> {
        self.storage_root.get().map(std::path::PathBuf::as_path)
    }

    /// Fork: the source of `process/childProcesses` (the app-server's local MCP transport).
    pub fn set_mcp_processes(&self, processes: Arc<dyn McpProcesses>) {
        let _ = self.mcp_processes.set(processes);
    }

    /// Fork: the live stdio MCP server processes, empty without a source.
    pub(crate) fn mcp_processes(&self) -> Vec<McpProcess> {
        self.mcp_processes
            .get()
            .map(|source| source.processes())
            .unwrap_or_default()
    }

    /// Fork: the selectable models, empty without a directory.
    pub(crate) async fn catalog(&self) -> Arc<[CatalogModel]> {
        match self.models.get() {
            Some(models) => models.catalog().await.models.into(),
            None => Arc::from(Vec::new()),
        }
    }

    pub fn new(peer: Peer, clock: Arc<dyn Clock>) -> Self {
        let prefix = format!(
            "{:x}-{:x}",
            clock.now_ms(),
            rust_cli_base::random::u64() & u64::from(u32::MAX)
        );
        Self {
            peer,
            clock,
            ordinals: Mutex::new(HashMap::new()),
            counter: Mutex::new(0),
            sessions: Mutex::new(HashMap::new()),
            off_peak: Default::default(),
            prefix,
            models: std::sync::OnceLock::new(),
            storage_root: std::sync::OnceLock::new(),
            workspace_admin: std::sync::OnceLock::new(),
            mcp_app_host: std::sync::OnceLock::new(),
            mcp_ui: std::sync::OnceLock::new(),
            app_tools: std::sync::OnceLock::new(),
            attach: crate::attach::HostAttach::new(),
            node_helper: std::sync::OnceLock::new(),
            workflow_child: std::sync::OnceLock::new(),
            workflow_runner: std::sync::OnceLock::new(),
            model_port: std::sync::OnceLock::new(),
            mcp_processes: std::sync::OnceLock::new(),
            language_servers: std::sync::OnceLock::new(),
            external_agent_configs: std::sync::OnceLock::new(),
        }
    }

    /// 记下一个打开着的会话所在的工作区。
    pub fn register(&self, session: &str, workspace: &str) {
        self.sessions
            .lock_unpoisoned()
            .insert(session.to_owned(), workspace.to_owned());
    }

    /// Fork: forgets a session registered only for one call (a workspace model call's requester).
    pub(crate) fn unregister(&self, session: &str) {
        self.sessions.lock_unpoisoned().remove(session);
    }

    pub fn workspace_of(&self, session: &str) -> Option<String> {
        self.sessions.lock_unpoisoned().get(session).cloned()
    }

    /// The protocol `workspace` ref of an open session (`zcodeWorkspaceRefSchema`, a local workspace: its key is its
    /// path).
    pub fn workspace_ref(&self, session: &str) -> Option<serde_json::Value> {
        self.workspace_of(session).map(
            |workspace| serde_json::json!({"workspacePath": workspace, "workspaceKey": workspace}),
        )
    }

    pub fn now(&self) -> u64 {
        self.clock.now_ms()
    }

    /// 本进程里唯一的标识：`<kind>-<进程前缀>-<n>`（代际标识、订阅 ID）。
    pub fn fresh(&self, kind: &str) -> String {
        let mut counter = self.counter.lock_unpoisoned();
        *counter += 1;
        format!("{kind}-{}-{}", self.prefix, *counter)
    }

    fn ordinal(&self, subscription: &str) -> u64 {
        let mut ordinals = self.ordinals.lock_unpoisoned();
        let ordinal = ordinals.entry(subscription.to_owned()).or_default();
        *ordinal += 1;
        *ordinal
    }

    /// 订阅结束：逻辑帧序号不再需要。
    pub fn forget(&self, subscription: &str) {
        self.ordinals.lock_unpoisoned().remove(subscription);
    }

    /// 写一个逻辑帧（`topicFrame`）：快照或一段增量。
    pub async fn frame(
        &self,
        topic: &str,
        subscription: &str,
        (from, to): (u64, u64),
        payload: Value,
        purpose: Purpose,
    ) {
        let frame = json!({
            "topic": topic,
            "subscriptionId": subscription,
            "fromSeq": from,
            "toSeq": to,
            "sentAt": self.now(),
            "payload": payload,
        });
        let envelope = Envelope {
            topic,
            subscription,
            ordinal: self.ordinal(subscription),
            purpose,
        };
        let Some(physical) = wire::encode(&frame, &envelope) else {
            tracing::warn!(
                event = "protocol.frame.too_large",
                topic,
                "a logical frame exceeded the assembly limit and was dropped"
            );
            return;
        };
        for wire in physical {
            self.peer.notify(FRAME, &wire).await;
        }
    }
}
