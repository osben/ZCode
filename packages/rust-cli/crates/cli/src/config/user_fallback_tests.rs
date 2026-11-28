//! The user MCP fallback `~/.agents/mcp.json` (Node `dynamic-mcp-config.ts`): when it applies, its scope and its
//! precedence in the merge.
#![allow(
    clippy::disallowed_methods,
    reason = "the test prepares files in a temporary HOME"
)]

use rust_cli_kernel_api::env::{EnvFacts, EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::testing::MemoryEnvironment;
use serde_json::json;

use super::*;
use crate::config::{ConfigInputs, assemble};

const ROOT: &str = "/Users/dev/repo";

fn object(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

#[test]
fn it_applies_only_when_the_user_config_declares_no_valid_server() {
    assert!(applies(None));
    assert!(applies(Some(&object(json!({"permission": {}})))));
    assert!(applies(Some(&object(json!({"mcp": {"servers": {}}})))));
    // Every entry is invalid: the schema skips them, so the map is empty and the fallback is read.
    assert!(applies(Some(&object(
        json!({"mcp": {"servers": {"bad": {"type": "nope"}}}})
    ))));
    assert!(!applies(Some(&object(
        json!({"mcp": {"servers": {"a": {"command": "node"}}}})
    ))));
    // A disabled entry is still an entry.
    assert!(!applies(Some(&object(
        json!({"mcp": {"servers": {"a": {"command": "node", "enabled": false}}}})
    ))));
}

#[test]
fn a_file_without_a_server_table_gives_no_layer() {
    let path = "/home/dev/.agents/mcp.json";
    assert_eq!(from_file(path, ConfigFile::Missing), None);
    assert_eq!(
        from_file(
            path,
            ConfigFile::Invalid {
                reason: "x".to_owned()
            }
        ),
        None
    );
    for body in [
        json!({}),
        json!({"mcpServers": {}}),
        json!({"mcpServers": []}),
    ] {
        assert_eq!(
            from_file(path, ConfigFile::Loaded(object(body.clone()))),
            None,
            "{body}"
        );
    }
    let layer = from_file(
        path,
        ConfigFile::Loaded(object(json!({"mcpServers": {"a": {"command": "node"}}}))),
    )
    .unwrap();
    assert_eq!(
        Value::Object(layer.object),
        json!({"mcp": {"servers": {"a": {"command": "node"}}}})
    );
}

#[test]
fn fallback_paths_are_told_apart_from_config_files() {
    assert!(is_fallback_path("/Users/dev/repo/.agents/mcp.json"));
    assert!(is_fallback_path("C:\\Users\\dev\\.agents\\mcp.json"));
    assert!(!is_fallback_path("/Users/dev/.zcode/cli/config.json"));
    assert!(!is_fallback_path("/Users/dev/repo/.zcode/mcp.json"));
    assert!(!is_fallback_path("/Users/dev/repo/agents/mcp.json"));
}

fn env(files: &[(&str, Value)]) -> MemoryEnvironment {
    let facts = EnvFacts {
        cwd: EnvPath::new(ROOT),
        platform: "linux".to_owned(),
        os_version: "Linux".to_owned(),
        shell: "bash".to_owned(),
        is_git_repo: true,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    };
    files
        .iter()
        .fold(MemoryEnvironment::new(facts), |env, (path, value)| {
            env.with_file(path, &value.to_string())
        })
        .with_file("/Users/dev/repo/.git/HEAD", "ref")
}

/// A temporary HOME with the user config and `~/.agents/mcp.json` (each optional).
async fn snapshot(
    user: Option<Value>,
    agents: Option<Value>,
    files: &[(&str, Value)],
) -> crate::config::ConfigSnapshot {
    let dir = tempfile::tempdir().unwrap();
    for (path, value) in [
        (".zcode/cli/config.json", user),
        (".agents/mcp.json", agents),
    ] {
        if let Some(value) = value {
            let file = dir.path().join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, value.to_string()).unwrap();
        }
    }
    let paths = StoragePaths::resolve(&Default::default(), dir.path(), dir.path());
    let env = env(files);
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(ROOT),
    };
    assemble(&ConfigInputs {
        files: &env,
        workspace: &workspace,
        paths: &paths,
        process_env: &rust_cli_base::secret::EnvSnapshot::default(),
        flag: None,
        project_is_local: true,
    })
    .await
}

fn names(snapshot: &crate::config::ConfigSnapshot) -> Vec<(&str, McpScope)> {
    snapshot
        .mcp_servers
        .iter()
        .map(|server| (server.name.as_str(), server.scope))
        .collect()
}

#[tokio::test]
async fn the_home_fallback_joins_as_a_user_server_without_a_grant() {
    let agents = json!({"mcpServers": {
        "mine": {"command": "tool", "cwd": "rel"},
        "off": {"command": "x", "enabled": false},
    }});
    let snapshot = snapshot(None, Some(agents), &[]).await;
    assert_eq!(names(&snapshot), [("mine", McpScope::User)]);
    assert_eq!(snapshot.mcp_disabled.len(), 1);
    let origin = &snapshot.mcp_origins["mine"];
    assert!(origin.user && origin.fallback);
    assert!(origin.path.ends_with(".agents/mcp.json"));
    // A user server keeps its `cwd`; only project servers resolve it against their file.
    let rust_cli_kernel_api::mcp::McpTransportConfig::Stdio { cwd, .. } =
        &snapshot.mcp_servers[0].transport
    else {
        panic!("stdio");
    };
    assert_eq!(cwd.as_deref(), Some("rel"));
}

#[tokio::test]
async fn the_home_fallback_is_ignored_when_the_user_config_declares_a_server() {
    let user = json!({"mcp": {"servers": {"cfg": {"command": "c"}}}});
    let agents = json!({"mcpServers": {"mine": {"command": "tool"}}});
    let snapshot = snapshot(Some(user), Some(agents), &[]).await;
    assert_eq!(names(&snapshot), [("cfg", McpScope::User)]);
}

#[tokio::test]
async fn the_home_fallback_shadows_a_project_server_of_the_same_name() {
    let project = json!({"mcp": {"servers": {"same": {"command": "project-tool"}}}});
    let agents = json!({"mcpServers": {"same": {"command": "home-tool"}}});
    let snapshot = snapshot(
        None,
        Some(agents),
        &[("/Users/dev/repo/.zcode/config.json", project)],
    )
    .await;
    assert_eq!(names(&snapshot), [("same", McpScope::User)]);
    assert!(snapshot.mcp_origins["same"].user);
}

#[tokio::test]
async fn a_broken_home_fallback_yields_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(".agents/mcp.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "not json").unwrap();
    let paths = StoragePaths::resolve(&Default::default(), dir.path(), dir.path());
    assert_eq!(read(&paths, None).await, None);
}
