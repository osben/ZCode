//! The workspace layer loader (specs/fork-rust-workspace-plugins-mcp.md): project `mcp.servers`
//! under the session's workspace, name shadowing against the user config, per-file cwd resolution,
//! and the plugin enablement overlay through the LSP path's `plugin_view`.

use rust_cli_kernel_api::env::EnvFacts;
use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::machine::Files as FilesPort;
use rust_cli_kernel_api::testing::MemoryEnvironment;
use rust_cli_paths::StoragePaths;
use std::sync::Arc;

use super::*;

fn env(files: &[(&str, &str)]) -> MemoryEnvironment {
    let facts = EnvFacts {
        cwd: EnvPath::new("/Users/dev/repo"),
        platform: "linux".to_owned(),
        os_version: "Linux".to_owned(),
        shell: "bash".to_owned(),
        is_git_repo: true,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    };
    files
        .iter()
        .fold(MemoryEnvironment::new(facts), |env, (path, text)| {
            env.with_file(path, text)
        })
}

fn loader(files: MemoryEnvironment, user_config: &str) -> Loader {
    let home = std::path::Path::new("/Users/dev");
    let paths = StoragePaths::resolve(&Default::default(), home, home);
    let files: Arc<dyn FilesPort> = Arc::new(files.with_file(
        &paths.cli_config().as_path().display().to_string(),
        user_config,
    ));
    Loader {
        files: files.clone(),
        controller: files,
        paths,
        process_env: Default::default(),
        flag: None,
        project_is_local: true,
        process: PluginSources::default(),
        strict: false,
    }
}

fn workspace(root: &str) -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(root),
    }
}

#[tokio::test]
async fn unadmitted_project_servers_are_dropped_the_overlay_still_loads() {
    // No trust records exist for this workspace, so its project servers wait for a grant — the
    // same admission as the process assembly (`config::assemble`). The plugin enablement overlay
    // is independent of MCP trust and still loads. The granted path (a trust record in the store)
    // needs a store fixture; the store read goes to the controller's real disk, so a positive test
    // arrives with the trust-store test harness follow-up.
    let loader = loader(
        env(&[
            ("/Users/dev/repo/.git/HEAD", "ref"),
            (
                "/Users/dev/repo/.zcode/config.json",
                r#"{"mcp": {"servers": {
                    "project-server": {"type": "stdio", "command": "node", "args": ["s.js"], "cwd": "tools"},
                    "second": {"type": "stdio", "command": "node", "args": ["p.js"]}
                }},"plugins": {"enabledPlugins": {"demo-plugin@official": true}}}"#,
            ),
        ]),
        "{}",
    );

    let config = loader.load(&workspace("/Users/dev/repo")).await.unwrap();

    assert!(
        config.servers.is_empty(),
        "unadmitted project servers must not connect"
    );
    assert_eq!(
        config.plugins.enabled_plugins.get("demo-plugin@official"),
        Some(&true),
        "the project layer's enabledPlugins overlays the view"
    );
}

#[tokio::test]
async fn a_workspace_without_project_config_loads_empty() {
    let loader = loader(
        env(&[]),
        r#"{"mcp": {"servers": {"user-server": {"type": "stdio", "command": "node", "args": []}}}}"#,
    );

    let config = loader.load(&workspace("/Users/dev/repo")).await.unwrap();

    assert!(config.servers.is_empty());
}
