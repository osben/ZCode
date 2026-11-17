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
        self.workspace_layer_host().load(workspace).await;
    }

    /// Fork (print `--continue` prewarm, Node parity): resolves the newest session row of
    /// `workspace` with cheap row reads (the same scan the headless continue path runs inside the
    /// open) and kicks that row's workspace layer load concurrently with the caller's scan and
    /// session open — Node composes its per-app config at app construction, before the core
    /// resume, so the layer work must not wait inside the open either. Nothing here awaits the
    /// load: the open's own `load` joins the in-flight one (the layer's one-load-at-a-time claim)
    /// and awaits the slot there, so the load result is awaited only when actually needed. The
    /// kernel's scope owns the task: shutdown aborts it, and a load dropped mid-read releases its
    /// claim (the layer's guard), so the workspace's next load is never stuck waiting.
    pub async fn prewarm_continue_layer(&self, workspace: &rust_cli_kernel_api::env::WorkspaceRef) {
        let Some(target) = continue_layer_target(self.ports.store.as_ref(), workspace).await else {
            return;
        };
        let layer = self.workspace_layer_host();
        drop(
            self.scope
                .spawner()
                .spawn("continue-layer-prewarm", async move {
                    layer.prewarm(&target).await
                }),
        );
    }

    /// Fork (specs/fork-rust-workspace-plugins-mcp.md, "As built: layer reload"): re-reads a
    /// workspace's plugin/MCP layer past the loaded-slot reuse — the App's committed config/trust
    /// writes go through here, so the workspace's group and plugin admission follow without a
    /// process restart.
    pub async fn reload_workspace_layer(&self, workspace: &rust_cli_kernel_api::env::WorkspaceRef) {
        self.workspace_layer_host().reload(workspace).await;
    }

    /// Fork: the layer host, for the App's admin (its trust paths reload a workspace's layer).
    pub fn workspace_layer_host(
        &self,
    ) -> std::sync::Arc<dyn rust_cli_kernel_api::workspace_key::WorkspaceLayerHost> {
        self.workspace_layer.read_unpoisoned().clone()
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

/// The workspace whose layer a `--continue` open of `workspace`'s newest row will load: the row's
/// frozen workspace exactly as the cold open computes it (node-store `meta` plus the
/// `run_in_worktree` substitution) — the row's non-empty `workspace_id` (a remote identity) else
/// the scan's own environment, and the execution worktree's path when the row has one (a fork
/// row's cold open runs in the worktree), else the row's `directory`. Fail-closed: no row, or a
/// read that failed, answers `None` and the caller prewarms nothing (the open then loads
/// serially as before — no guessed key). The scan here runs BEFORE the headless path's own scan
/// (the print entry kicks the prewarm ahead of `wait_for_extensions`); a session committed in
/// between supersedes the newest row and this target goes stale — accepted: the cost is one
/// wasted layer read plus a group for a key this run never opens, and the open still loads the
/// real target itself.
async fn continue_layer_target(
    store: &dyn rust_cli_kernel_api::store::Store,
    workspace: &rust_cli_kernel_api::env::WorkspaceRef,
) -> Option<rust_cli_kernel_api::env::WorkspaceRef> {
    use rust_cli_kernel_api::store::SessionFilter;
    // The scan the headless continue path runs: this workspace's newest session row.
    let latest = store
        .list(SessionFilter {
            workspace: workspace.clone(),
            limit: 1,
        })
        .await
        .ok()?
        .into_iter()
        .next()?
        .id;
    let row = store.session_workspace(&latest).await.ok()??;
    // A row with an execution worktree runs the session in the worktree; its group must bind that
    // root from the start (as the cold open's root substitution does). A FAILED read answers None
    // like the reads above — it must not degrade to the parent directory, which would load (and
    // start a group for) the wrong key.
    let worktree = match store.execution_worktree(&latest).await {
        Ok(worktree) => worktree,
        Err(_) => return None,
    };
    let root = match worktree {
        Some(worktree) => worktree.path,
        None => rust_cli_kernel_api::env::EnvPath::new(row.directory),
    };
    Some(rust_cli_kernel_api::env::WorkspaceRef {
        // The scan's store answers this workspace's local rows (node-store refuses a remote filter
        // environment), so the filter's environment is the local default a local row's meta reads.
        environment: row
            .identity
            .map(rust_cli_kernel_api::ids::EnvironmentId::new)
            .unwrap_or_else(|| workspace.environment.clone()),
        root,
    })
}
