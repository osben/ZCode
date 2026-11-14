//! The workspace groups of the shared task runtime (specs/fork-rust-workspace-plugins-mcp.md):
//! group creation, replacement and stop, and the process group's independence.

use std::sync::Arc;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::mcp::McpTransportConfig;

use super::*;
use crate::mcp::McpScope;
use crate::test_support::{FakeMcp, workspace};

fn server_config(name: &str) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope: McpScope::Project,
        transport: McpTransportConfig::stdio("node".to_owned(), Vec::new()),
        options: Default::default(),
        machine: Default::default(),
    }
}

fn groups(fake: &Arc<FakeMcp>, scope: &TaskScope) -> WorkspaceMcp {
    let process = Arc::new(McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
    ));
    WorkspaceMcp::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
        None,
        process,
    )
}

fn names(manager: &McpManager) -> Vec<String> {
    manager
        .server_infos()
        .into_iter()
        .map(|info| info.name)
        .collect()
}

#[tokio::test]
async fn a_workspace_group_holds_its_own_servers() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let mcp = groups(&fake, &scope);

    mcp.start(PROCESS, workspace(), vec![server_config("user-server")]);
    mcp.start("/work/a", workspace(), vec![server_config("project-of-a")]);

    assert_eq!(names(&mcp.group("/work/a").unwrap()), ["project-of-a"]);
    assert!(mcp.group("/work/b").is_none());
    // The process group keeps its own set; same names never collide across groups.
    assert_eq!(names(mcp.process()), ["user-server"]);
}

#[tokio::test]
async fn restarting_a_group_replaces_its_servers() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let mcp = groups(&fake, &scope);

    mcp.start("/work/a", workspace(), vec![server_config("one")]);
    mcp.start("/work/a", workspace(), vec![server_config("two"), server_config("three")]);

    assert_eq!(names(&mcp.group("/work/a").unwrap()), ["three", "two"]);
}

#[tokio::test]
async fn stopping_a_group_removes_it_the_process_stays() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let mcp = groups(&fake, &scope);

    mcp.start(PROCESS, workspace(), vec![server_config("user-server")]);
    mcp.start("/work/a", workspace(), vec![server_config("one")]);
    mcp.stop("/work/a");

    assert!(mcp.group("/work/a").is_none());
    assert_eq!(names(mcp.process()), ["user-server"]);
    // Stopping the process group is a no-op (it lives with the process).
    mcp.stop(PROCESS);
    assert_eq!(names(mcp.process()), ["user-server"]);
}
