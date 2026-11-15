//! The per-workspace layer (specs/fork-rust-workspace-plugins-mcp.md): lazy load, fail-closed
//! invalid slots, and the group lifecycle.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::mcp::McpTransportConfig;

use super::*;
use crate::mcp::workspaces::WorkspaceMcp;
use crate::mcp::{McpManager, McpSettings};
use crate::test_support::FakeMcp;

struct Fixed(Option<WorkspaceConfig>);

#[async_trait]
impl WorkspaceConfigLoader for Fixed {
    async fn load(&self, _workspace: &WorkspaceRef) -> Option<WorkspaceConfig> {
        self.0.clone()
    }
}

// WorkspaceConfig is not Clone-sensitive here; build one with a project server.
fn config_with_server(name: &str) -> WorkspaceConfig {
    WorkspaceConfig {
        plugins: PluginSources::default(),
        servers: vec![McpServer {
            name: name.to_owned(),
            scope: crate::mcp::McpScope::Project,
            transport: McpTransportConfig::stdio("node".to_owned(), Vec::new()),
            options: Default::default(),
            machine: Default::default(),
        }],
    }
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
        root: crate::EnvPath::new("/w"),
    }
}

fn files() -> Arc<rust_cli_kernel_api::testing::MemoryEnvironment> {
    Arc::new(rust_cli_kernel_api::testing::MemoryEnvironment::new(
        crate::test_support::facts(),
    ))
}

fn layer(fake: &Arc<FakeMcp>, scope: &TaskScope) -> (Arc<WorkspaceMcp>, WorkspaceLayer) {
    let process = Arc::new(McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
    ));
    let mcp = Arc::new(WorkspaceMcp::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
        None,
        process,
    ));
    let layer = WorkspaceLayer::new(files(), mcp.clone(), Vec::new(), Vec::new(), None);
    (mcp, layer)
}

fn names(mcp: &WorkspaceMcp, key: &str) -> Vec<String> {
    mcp.group(key)
        .map(|manager| {
            manager
                .server_infos()
                .into_iter()
                .map(|info| info.name)
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn a_loaded_layer_starts_the_workspace_group() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let (mcp, layer) = layer(&fake, &scope);
    layer.set_loader(Arc::new(Fixed(Some(config_with_server("project-server")))));

    layer.load(&workspace()).await;

    assert!(matches!(layer.slot("/w"), Some(super::Slot::Loaded(_))));
    assert!(
        layer.plugins_of(&workspace()).is_some(),
        "a loaded slot carries the workspace's plugin set"
    );
    assert_eq!(names(&mcp, "/w"), ["project-server"]);
}

#[tokio::test]
async fn a_broken_project_layer_is_fail_closed() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let (mcp, layer) = layer(&fake, &scope);
    layer.set_loader(Arc::new(Fixed(Some(config_with_server("first")))));
    layer.load(&workspace()).await;

    // The config turns unreadable: the group stops, the slot is Invalid, the process set stays.
    let broken = WorkspaceLayer::new(files(), mcp.clone(), Vec::new(), Vec::new(), None);
    broken.set_loader(Arc::new(Fixed(None)));
    broken.load(&workspace()).await;

    assert!(matches!(broken.slot("/w"), Some(super::Slot::Invalid)));
    assert!(broken.plugins_of(&workspace()).is_none());
    assert!(mcp.group("/w").is_none());
}

#[tokio::test]
async fn without_a_loader_nothing_loads() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let (mcp, layer) = layer(&fake, &scope);

    layer.load(&workspace()).await;

    assert!(layer.slot("/w").is_none());
    assert!(mcp.group("/w").is_none());
}
