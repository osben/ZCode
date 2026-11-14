//! Fork (F3, specs/fork-rust-node-helper.md "Lazy start"): helper-hosted servers stay pending until a session's first
//! tool snapshot or an MCP status listing asks for them, so an app-server with Office plugins does not start the
//! helper at boot.

use std::sync::Arc;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::manage::McpServerState;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use serde_json::json;

use super::*;
use crate::mcp::McpScope;
use crate::test_support::{FakeMcp, server, workspace};

fn helper_config(name: &str) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope: McpScope::Plugin,
        transport: McpTransportConfig::NodeHelper,
        options: Default::default(),
        machine: Default::default(),
    }
}

fn stdio_config(name: &str) -> McpServer {
    McpServer {
        transport: McpTransportConfig::stdio("node".to_owned(), Vec::new()),
        scope: McpScope::Project,
        ..helper_config(name)
    }
}

fn tools_server() -> Arc<crate::test_support::Handler> {
    server(json!({"tools": {}}), None, |method, _| match method {
        "tools/list" => Some(Ok(
            json!({"tools": [{"name": "make", "inputSchema": {"type": "object"}}]}),
        )),
        _ => None,
    })
}

fn rig() -> (Arc<FakeMcp>, TaskScope, McpManager) {
    let fake = Arc::new(
        FakeMcp::default()
            .with("plugin:docs:office", tools_server())
            .with("files", tools_server()),
    );
    let scope = TaskScope::root("test", |_| {});
    let manager = McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
    );
    manager.start(
        workspace(),
        vec![helper_config("plugin:docs:office"), stdio_config("files")],
    );
    (fake, scope, manager)
}

fn connected_servers(fake: &FakeMcp) -> Vec<String> {
    let mut names: Vec<String> = fake.roots().into_iter().map(|(name, _)| name).collect();
    names.sort();
    names.dedup();
    names
}

async fn settle(manager: &McpManager, name: &str) {
    let mut changes = manager.0.changed.subscribe();
    while manager
        .status()
        .iter()
        .any(|(server, status)| server == name && status.pending())
    {
        changes.changed().await.unwrap();
    }
}

#[tokio::test]
async fn a_helper_hosted_server_waits_for_the_first_tool_snapshot() {
    let (fake, _scope, manager) = rig();
    settle(&manager, "files").await;
    tokio::task::yield_now().await;
    assert_eq!(connected_servers(&fake), ["files"]);
    assert!(manager.has_pending(), "the helper-hosted server is pending");

    let (_, view) = manager.snapshot();
    assert!(
        view.pending()
            .iter()
            .any(|name| name == "plugin:docs:office"),
        "the snapshot that wakes it still shows it connecting"
    );
    settle(&manager, "plugin:docs:office").await;
    assert_eq!(connected_servers(&fake), ["files", "plugin:docs:office"]);
    assert!(manager.find("mcp__plugin_docs_office__make").is_some());

    // Woken once: later snapshots do not reconnect.
    manager.snapshot();
    manager.snapshot_where(|_| true);
    tokio::task::yield_now().await;
    assert_eq!(fake.roots().len(), 2);
}

#[tokio::test]
async fn an_mcp_status_listing_wakes_helper_hosted_servers() {
    let (fake, _scope, manager) = rig();
    let office = manager
        .server_infos()
        .into_iter()
        .find(|info| info.name == "plugin:docs:office")
        .unwrap();
    assert_eq!(office.state, McpServerState::Pending);
    settle(&manager, "plugin:docs:office").await;
    assert!(connected_servers(&fake).contains(&"plugin:docs:office".to_owned()));
}

#[tokio::test]
async fn an_incognito_snapshot_wakes_them_too() {
    let (fake, _scope, manager) = rig();
    manager.snapshot_where(|scope| scope != McpScope::Plugin);
    settle(&manager, "plugin:docs:office").await;
    assert!(connected_servers(&fake).contains(&"plugin:docs:office".to_owned()));
}

#[tokio::test]
async fn a_server_disabled_before_it_wakes_stays_disabled() {
    let (fake, _scope, manager) = rig();
    manager
        .control(
            rust_cli_kernel_api::manage::McpAction::Disable,
            &["plugin:docs:office".to_owned()],
        )
        .await;
    manager.snapshot();
    tokio::task::yield_now().await;
    assert!(!connected_servers(&fake).contains(&"plugin:docs:office".to_owned()));
    assert!(
        manager
            .status()
            .iter()
            .any(|(name, status)| name == "plugin:docs:office" && *status == McpStatus::Disabled)
    );
}
