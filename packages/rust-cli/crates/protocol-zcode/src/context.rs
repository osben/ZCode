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
    /// 本进程的随机前缀（代际标识与订阅 ID 用）。
    prefix: String,
    /// Fork: the model directory the projection reads reasoning levels from (Node `listThoughtLevels`).
    models: std::sync::OnceLock<Arc<dyn ModelDirectory>>,
    /// Fork: the storage root for per-session directories (session erase); set once by the
    /// app-server. Without it the erase removes the rows and skips the files.
    storage_root: std::sync::OnceLock<std::path::PathBuf>,
    /// Fork: workspace trust from the App (`fork/workspace_trust.rs`); set once by the app-server.
    workspace_admin: std::sync::OnceLock<Arc<dyn crate::fork::WorkspaceAdmin>>,
    /// Fork: whether reverse requests wait for the Host's attach acknowledgement (specs/fork-rust-credential-cipher.md F1).
    pub(crate) attach: crate::attach::HostAttach,
    /// Fork: the Node helper that answers the JS-only method families; set once by the app-server when the Host
    /// configured a helper command (specs/fork-rust-node-helper.md).
    node_helper: std::sync::OnceLock<Arc<crate::fork::node_helper::NodeHelper>>,
    /// Fork: the entry's model port for workspace model calls (`fork::workspace_model`); without it those methods
    /// stay unported.
    model_port: std::sync::OnceLock<Arc<dyn ModelPort>>,
    /// Fork: the live stdio MCP server processes (`process/childProcesses`); set once by the app-server.
    mcp_processes: std::sync::OnceLock<Arc<dyn McpProcesses>>,
    /// Fork: the language-server host behind `lsp/*` (specs/fork-rust-lsp.md); without it they answer -32000.
    language_servers: std::sync::OnceLock<Arc<dyn rust_cli_kernel_api::lsp::LanguageServers>>,
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
            prefix,
            models: std::sync::OnceLock::new(),
            storage_root: std::sync::OnceLock::new(),
            workspace_admin: std::sync::OnceLock::new(),
            attach: crate::attach::HostAttach::new(),
            node_helper: std::sync::OnceLock::new(),
            model_port: std::sync::OnceLock::new(),
            mcp_processes: std::sync::OnceLock::new(),
            language_servers: std::sync::OnceLock::new(),
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
