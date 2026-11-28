//! `/mcp enable/disable` 写哪个文件（tui-manage.md §6.1）。
#![expect(
    clippy::disallowed_methods,
    reason = "测试准备与读取临时目录里的用户级配置"
)]

use rust_cli_kernel_api::env::{EnvFacts, ReadFile};
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::testing::{MemoryEnvironment, SequentialIds};

use super::*;

fn files(origins: &[(&str, &str, bool)], env: Arc<MemoryEnvironment>) -> McpConfigFiles {
    McpConfigFiles {
        origins: origins
            .iter()
            .map(|(name, path, user)| {
                (
                    (*name).to_owned(),
                    McpOrigin {
                        path: (*path).to_owned(),
                        user: *user,
                        fallback: path.ends_with(".agents/mcp.json"),
                    },
                )
            })
            .collect(),
        files: env,
        ids: Arc::new(SequentialIds::default()),
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/Users/dev/project"),
        },
    }
}

fn env() -> Arc<MemoryEnvironment> {
    Arc::new(
        MemoryEnvironment::new(EnvFacts {
            cwd: EnvPath::new("/Users/dev/project"),
            platform: "darwin".into(),
            os_version: "x".into(),
            shell: "zsh".into(),
            is_git_repo: false,
            home: Some(EnvPath::new("/Users/dev")),
            uid: None,
        })
        .with_file(
            "/Users/dev/project/zcode.json",
            r#"{"mcp":{"servers":{"repo":{"command":"r"}}}}"#,
        ),
    )
}

#[tokio::test]
async fn user_and_project_servers_go_to_their_own_files() {
    let home = tempfile::tempdir().unwrap();
    let paths = StoragePaths::resolve(&Default::default(), home.path(), home.path());
    let user_file = home.path().join(".zcode/cli/config.json");
    std::fs::create_dir_all(user_file.parent().unwrap()).unwrap();
    std::fs::write(&user_file, r#"{"mcp":{"servers":{"docs":{"url":"u"}}}}"#).unwrap();
    let env = env();
    let files = files(
        &[
            ("docs", "user", true),
            ("repo", "/Users/dev/project/zcode.json", false),
        ],
        env.clone(),
    );
    let written = files.save(&paths, "docs", false).await.unwrap();
    assert_eq!(written, Some(user_file.display().to_string()));
    assert!(
        std::fs::read_to_string(&user_file)
            .unwrap()
            .contains("\"enabled\": false")
    );
    let written = files.save(&paths, "repo", false).await.unwrap();
    assert_eq!(written.as_deref(), Some("/Users/dev/project/zcode.json"));
    let project = env
        .read_file(
            &files.workspace,
            ReadFile {
                path: EnvPath::new("/Users/dev/project/zcode.json"),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        String::from_utf8(project.bytes).unwrap(),
        "{\n  \"mcp\": {\n    \"servers\": {\n      \"repo\": {\n        \"command\": \"r\",\n        \"enabled\": false\n      }\n    }\n  }\n}\n"
    );
    // 不在配置文件里的（`--mcp-config`、插件）：只改本次运行。
    assert_eq!(files.save(&paths, "plugin", true).await.unwrap(), None);
}

#[tokio::test]
async fn a_fallback_server_is_toggled_in_the_agents_file() {
    let paths_home = tempfile::tempdir().unwrap();
    let paths = StoragePaths::resolve(&Default::default(), paths_home.path(), paths_home.path());
    let env = Arc::new(
        MemoryEnvironment::new(EnvFacts {
            cwd: EnvPath::new("/Users/dev/project"),
            platform: "darwin".into(),
            os_version: "x".into(),
            shell: "zsh".into(),
            is_git_repo: false,
            home: Some(EnvPath::new("/Users/dev")),
            uid: None,
        })
        .with_file(
            "/Users/dev/project/.agents/mcp.json",
            r#"{"mcpServers":{"legacy":{"command":"r"}}}"#,
        ),
    );
    let files = files(
        &[("legacy", "/Users/dev/project/.agents/mcp.json", false)],
        env.clone(),
    );
    let written = files.save(&paths, "legacy", false).await.unwrap();
    assert_eq!(
        written.as_deref(),
        Some("/Users/dev/project/.agents/mcp.json")
    );
    let read = env
        .read_file(
            &files.workspace,
            ReadFile {
                path: EnvPath::new("/Users/dev/project/.agents/mcp.json"),
            },
        )
        .await
        .unwrap();
    assert!(
        String::from_utf8(read.bytes.to_vec())
            .unwrap()
            .contains("\"enabled\": false")
    );
}

/// A server of the user fallback `~/.agents/mcp.json` is a user server whose table is `mcpServers`: the toggle writes
/// that file, never `~/.zcode/cli/config.json`.
#[tokio::test]
async fn a_user_fallback_server_is_toggled_in_the_home_agents_file() {
    let home = tempfile::tempdir().unwrap();
    let paths = StoragePaths::resolve(&Default::default(), home.path(), home.path());
    let agents = home.path().join(".agents/mcp.json");
    std::fs::create_dir_all(agents.parent().unwrap()).unwrap();
    std::fs::write(&agents, r#"{"mcpServers":{"mine":{"command":"r"}}}"#).unwrap();
    let files = files(&[("mine", &agents.display().to_string(), true)], env());
    let written = files.save(&paths, "mine", false).await.unwrap();
    assert_eq!(written, Some(agents.display().to_string()));
    let text = std::fs::read_to_string(&agents).unwrap();
    assert!(text.contains("\"enabled\": false"), "{text}");
    assert!(!home.path().join(".zcode/cli/config.json").exists());
}
