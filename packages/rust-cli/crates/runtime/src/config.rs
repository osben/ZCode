//! 入口层组装的配置快照交给内核（docs/specs/rust-cli/config.md §3）：整份替换，内核不读文件。

use rust_cli_base::sync::RwLockUnpoisoned;
use rust_cli_hooks::HooksConfig;
use rust_cli_kernel_api::permission::PermissionRules;
use rust_cli_session::TitleModel;

use crate::LocalKernel;

impl LocalKernel {
    /// 打开会话标题的生成（TUI；`-p` 不生成，Node 相同，docs/specs/rust-cli/titles.md §2）。在建会话之前
    /// 调用：之后开的会话 actor 才带上它。
    #[must_use]
    pub fn with_titles(mut self, titles: TitleModel) -> Self {
        self.titles = Some(titles);
        self
    }

    /// 换上入口层从配置文件组装的 hooks 快照（hooks.md §2.2）；正在运行的事件用旧快照。
    pub fn replace_hooks(&self, config: HooksConfig) {
        self.hooks.replace(config);
    }

    /// Fork: swaps a workspace's project hook entry (specs/fork-rust-agent-parity.md, "Per-workspace hook snapshots").
    pub fn put_project_hooks(&self, key: &str, entry: rust_cli_hooks::ProjectEntry) {
        self.hooks.put_project(key, entry);
    }

    /// Fork: the engine's ordered writes of workspace entries, for the App's trust rebuilds.
    pub fn project_hook_slots(&self) -> std::sync::Arc<dyn rust_cli_hooks::ProjectHookSlots> {
        self.hooks.clone()
    }

    /// Fork (specs/fork-rust-workspace-plugins-mcp.md): loads (or reuses) a workspace's plugin/MCP
    /// layer; the print entry prewarms a resumed session's workspace with it before its startup
    /// wait, so the group's alwaysLoad servers are covered by that (cancellable) wait.
    pub async fn load_workspace_layer(&self, workspace: &rust_cli_kernel_api::env::WorkspaceRef) {
        let layer = self
            .workspace_layer
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        layer.load(workspace).await;
    }

    /// Fork: the cli loader that assembles a workspace's plugin/MCP layer
    /// (specs/fork-rust-workspace-plugins-mcp.md); forwarded to the ext layer.
    pub fn set_workspace_config_loader(
        &self,
        loader: std::sync::Arc<dyn rust_cli_ext::WorkspaceConfigLoader>,
    ) {
        self.ext.workspace_layer().set_loader(loader);
    }

    pub fn set_workspace_layer(
        &self,
        layer: std::sync::Arc<dyn rust_cli_kernel_api::workspace_key::WorkspaceLayerHost>,
    ) {
        *self.workspace_layer.write_unpoisoned() = layer;
    }

    pub fn set_project_hook_loader(
        &self,
        loader: std::sync::Arc<dyn rust_cli_hooks::ProjectHookLoader>,
    ) {
        self.hooks.set_project_loader(loader);
    }

    /// 换上入口层从命令行与配置组装的权限规则快照（shell-permissions.md §5）；之后的判决用新快照。
    pub fn replace_permission_rules(&self, rules: PermissionRules) {
        self.gate.replace_rules(rules);
    }
}
