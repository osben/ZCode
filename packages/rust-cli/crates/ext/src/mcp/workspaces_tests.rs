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
        oauth: None,
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
    mcp.start(
        "/work/a",
        workspace(),
        vec![server_config("two"), server_config("three")],
    );

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

/// A session recorded in the workspace `root`, as the kernel records it at the open.
fn session_in(
    sessions: &rust_cli_kernel_api::workspace_key::SessionWorkspaces,
    id: &str,
    root: &str,
) -> rust_cli_kernel_api::ids::SessionId {
    let session = rust_cli_kernel_api::ids::SessionId::new(id);
    sessions.record(
        &session,
        WorkspaceRef {
            root: rust_cli_kernel_api::env::EnvPath::new(root),
            ..workspace()
        },
    );
    session
}

#[tokio::test]
async fn an_open_session_keeps_its_group_when_the_workspace_group_is_replaced() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let mcp = groups(&fake, &scope);
    let sessions = rust_cli_kernel_api::workspace_key::SessionWorkspaces::default();
    let a = session_in(&sessions, "a", "/work/a");

    mcp.start("/work/a", workspace(), vec![server_config("one")]);
    assert_eq!(names(&mcp.for_session(&sessions, &a)), ["one"]);

    // A newly trusted server joins the sessions that open later (Node builds a pool per session).
    mcp.start(
        "/work/a",
        workspace(),
        vec![server_config("one"), server_config("trusted")],
    );
    let b = session_in(&sessions, "b", "/work/a");
    assert_eq!(names(&mcp.for_session(&sessions, &a)), ["one"]);
    assert_eq!(names(&mcp.for_session(&sessions, &b)), ["one", "trusted"]);

    // A stopped group (a read that turned invalid) also stays with the session that holds it.
    let held = mcp.for_session(&sessions, &b);
    mcp.stop("/work/a");
    assert!(Arc::ptr_eq(&mcp.for_session(&sessions, &b), &held));
    assert_eq!(names(&held), ["one", "trusted"]);
}

#[tokio::test]
async fn a_retired_group_shuts_down_after_its_last_session_closes() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let mcp = groups(&fake, &scope);
    let sessions = rust_cli_kernel_api::workspace_key::SessionWorkspaces::default();
    let a = session_in(&sessions, "a", "/work/a");
    let b = session_in(&sessions, "b", "/work/a");

    mcp.start("/work/a", workspace(), vec![server_config("old")]);
    let old = mcp.for_session(&sessions, &a);
    mcp.for_session(&sessions, &b);
    mcp.start("/work/a", workspace(), vec![server_config("new")]);

    mcp.release(&a);
    assert_eq!(names(&old), ["old"], "b still holds the old group");
    mcp.release(&b);
    assert!(
        names(&old).is_empty(),
        "the last pin shut the old group down"
    );

    // The current group never shuts down on a release.
    let c = session_in(&sessions, "c", "/work/a");
    let current = mcp.for_session(&sessions, &c);
    mcp.release(&c);
    assert_eq!(names(&current), ["new"]);
    // A reopened session pins the group that is current then.
    assert!(Arc::ptr_eq(&mcp.for_session(&sessions, &a), &current));
}

#[tokio::test]
async fn an_unpinned_group_shuts_down_when_replaced() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let mcp = groups(&fake, &scope);
    let sessions = rust_cli_kernel_api::workspace_key::SessionWorkspaces::default();

    mcp.start("/work/a", workspace(), vec![server_config("old")]);
    let old = mcp.group("/work/a").unwrap();
    mcp.start("/work/a", workspace(), vec![server_config("new")]);
    assert!(names(&old).is_empty());

    // A session without a workspace group reads the process group and pins nothing.
    let other = session_in(&sessions, "other", "/work/b");
    assert!(Arc::ptr_eq(
        &mcp.for_session(&sessions, &other),
        mcp.process()
    ));
    mcp.release(&other);
}

/// `process/childProcesses` reports a server of an official-marketplace plugin as built in (Node registers it with
/// `source.kind: "builtin"`): any group's plugin id decides, a mixed answer and an unknown name do not qualify.
#[tokio::test]
async fn an_official_plugin_server_is_known_across_groups() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let mcp = groups(&fake, &scope);
    let official = rust_cli_base::names::OFFICIAL_MARKETPLACE;
    let id = |plugin: &str, marketplace: &str| {
        (
            format!("plugin:{plugin}:k"),
            format!("{plugin}@{marketplace}"),
        )
    };

    mcp.start_with_plugins(PROCESS, workspace(), Vec::new(), vec![id("docs", official)]);
    mcp.start_with_plugins(
        "/work/a",
        workspace(),
        Vec::new(),
        vec![id("local", "my-market"), id("shared", official)],
    );
    mcp.start_with_plugins(
        "/work/b",
        workspace(),
        Vec::new(),
        vec![id("shared", "my-market")],
    );

    assert!(mcp.official_plugin_server("plugin:docs:k"));
    assert!(!mcp.official_plugin_server("plugin:local:k"));
    assert!(!mcp.official_plugin_server("plugin:shared:k"));
    assert!(!mcp.official_plugin_server("github"));
}
