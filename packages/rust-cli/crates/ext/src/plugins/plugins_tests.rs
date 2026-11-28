//! 插件目录与 manifest（ext.md §4）。

use rust_cli_kernel_api::mcp::McpTransportConfig;
use rust_cli_kernel_api::testing::MemoryEnvironment;

use super::*;
use crate::test_support::{facts, workspace};

#[tokio::test]
async fn manifest_components_and_mcp_servers() {
    let root = "/Users/dev/plugins/kit";
    let env = MemoryEnvironment::new(facts())
        .with_file(&format!("{root}/.claude-plugin/plugin.json"), r#"{"name": "toolkit", "skills": "./extra", "agents": ["./agents/reviewer.md", "./more.md"], "hooks": {"Stop": []}, "mcpServers": {"db": {"command": "${CLAUDE_PLUGIN_ROOT}/bin/db", "args": ["--root", "${ZCODE_PLUGIN_ROOT}"]}}}"#)
        .with_file(&format!("{root}/skills/deploy/SKILL.md"), "---\ndescription: Deploy\n---\n")
        .with_file(&format!("{root}/extra/lint/SKILL.md"), "---\ndescription: Lint\n---\n")
        .with_file(&format!("{root}/agents/reviewer.md"), "---\nname: reviewer\n---\n")
        .with_file(&format!("{root}/agents/team/lead.md"), "Lead\n")
        .with_file(&format!("{root}/more.md"), "More\n")
        .with_file(&format!("{root}/hooks/hooks.json"), r#"{"hooks": {"Stop": []}}"#)
        .with_file(&format!("{root}/.mcp.json"), r#"{"mcpServers": {"web": {"type": "http", "url": "https://mcp.example.com"}}}"#)
        .with_file("/Users/dev/plugins/bare/skills/x/SKILL.md", "B\n");
    let dirs = [
        EnvPath::new(root),
        EnvPath::new("/Users/dev/plugins/bare"),
        EnvPath::new("/Users/dev/plugins/missing"),
    ];
    let plugins = load_all(&env, &workspace(), &dirs, &PluginSources::default())
        .await
        .plugins;
    assert_eq!(plugins.0.len(), 2);
    let kit = &plugins.0[0];
    assert_eq!(kit.name, "toolkit");
    assert_eq!(
        kit.skill_dirs,
        [format!("{root}/skills"), format!("{root}/extra")]
    );
    // 子目录是命名空间；manifest 再次列出的同一文件只取一次。
    let agents: Vec<(String, Vec<String>)> = kit
        .agent_files
        .iter()
        .map(|file| (file.path.clone(), file.namespace.clone()))
        .collect();
    assert_eq!(
        agents,
        [
            (format!("{root}/agents/reviewer.md"), Vec::new()),
            (
                format!("{root}/agents/team/lead.md"),
                vec!["team".to_owned()]
            ),
            (format!("{root}/more.md"), Vec::new()),
        ]
    );
    // 内联的 manifest hooks 包成文件的 `{"hooks": …}` 形状。
    assert_eq!(
        kit.hooks,
        [
            serde_json::json!({"hooks": {"Stop": []}}),
            serde_json::json!({"hooks": {"Stop": []}})
        ]
    );
    let names: Vec<&str> = kit
        .mcp_servers
        .iter()
        .map(|server| server.name.as_str())
        .collect();
    assert_eq!(names, ["plugin:toolkit:web", "plugin:toolkit:db"]);
    let McpTransportConfig::Stdio { command, args, .. } = &kit.mcp_servers[1].transport else {
        panic!("db is stdio");
    };
    assert_eq!(command, &format!("{root}/bin/db"));
    assert_eq!(args, &["--root".to_owned(), root.to_owned()]);
    assert_eq!(plugins.0[1].name, "bare");
    plugin_stdio_servers_get_the_node_variables(kit, root).await;
    let roots: Vec<String> = plugins
        .skill_roots()
        .iter()
        .map(|root| format!("{}:{}", root.plugin, root.dir))
        .collect();
    assert_eq!(
        roots,
        [
            format!("toolkit:{root}/skills"),
            format!("toolkit:{root}/extra"),
            "bare:/Users/dev/plugins/bare/skills".to_owned()
        ]
    );
}

/// 插件的 stdio MCP 服务器的环境（修复线 F42，config.md §2.5.1）：按 Node（`adapters/src/plugins/mcp.ts`）给插件目录与
/// 项目目录，两套名字；HTTP 服务器没有环境。
async fn plugin_stdio_servers_get_the_node_variables(kit: &Plugin, root: &str) {
    let McpTransportConfig::Stdio { env, .. } = &kit.mcp_servers[1].transport else {
        panic!("db is stdio");
    };
    let project = workspace().root.as_str().to_owned();
    for (name, value) in [
        ("CLAUDE_PLUGIN_ROOT", root),
        ("ZCODE_PLUGIN_ROOT", root),
        ("CLAUDE_PROJECT_DIR", project.as_str()),
        ("ZCODE_PROJECT_DIR", project.as_str()),
    ] {
        assert_eq!(env.get(name).map(String::as_str), Some(value), "{name}");
    }
}

/// 配置里的 `env` 优先（Node 先放缺省再展开配置的 `env`）。
#[tokio::test]
async fn configured_env_wins_over_the_provided_variables() {
    let root = "/Users/dev/plugins/own";
    let env = MemoryEnvironment::new(facts()).with_file(
        &format!("{root}/.claude-plugin/plugin.json"),
        r#"{"name": "own", "mcpServers": {"db": {"command": "db", "env": {"CLAUDE_PROJECT_DIR": "/elsewhere", "TOKEN": "x"}}}}"#,
    );
    let plugins = load_all(
        &env,
        &workspace(),
        &[EnvPath::new(root)],
        &PluginSources::default(),
    )
    .await
    .plugins;
    let McpTransportConfig::Stdio { env, .. } = &plugins.0[0].mcp_servers[0].transport else {
        panic!("db is stdio");
    };
    assert_eq!(env["CLAUDE_PROJECT_DIR"], "/elsewhere");
    assert_eq!(env["TOKEN"], "x");
    assert_eq!(env["ZCODE_PLUGIN_ROOT"], root);
}

/// Fork (Node 对齐，`adapters/src/plugins/template.ts` 的 `resolveTemplate`）：插件 MCP 的 `env` 值里的 `${NAME}` 除
/// 插件目录与项目目录的专用名字外，合法环境变量名从入口给的进程环境展开（Node 的敏感位 `allowSensitive` 路径）；
/// 环境里没有的名字保持原样并记 missing（本工程对插件表既有约定，不像 Node 抛错）。
#[tokio::test]
async fn plugin_env_values_expand_process_environment_references() {
    let root = "/Users/dev/plugins/secrets";
    let env = MemoryEnvironment::new(facts()).with_file(
        &format!("{root}/.claude-plugin/plugin.json"),
        r#"{"name": "secrets", "mcpServers": {"verify": {"command": "node", "args": ["server.mjs"], "env": {"E2E_PLUGIN_SECRET": "${E2E_PLUGIN_SECRET}", "PROJECT": "${ZCODE_PROJECT_DIR}", "ABSENT": "${E2E_ABSENT}"}}}}"#,
    );
    let sources = PluginSources {
        env: [("E2E_PLUGIN_SECRET".to_owned(), "s3cret".to_owned())]
            .into_iter()
            .collect(),
        ..PluginSources::default()
    };
    let plugins = load_all(&env, &workspace(), &[EnvPath::new(root)], &sources)
        .await
        .plugins;
    let McpTransportConfig::Stdio { env, .. } = &plugins.0[0].mcp_servers[0].transport else {
        panic!("verify is stdio");
    };
    assert_eq!(env["E2E_PLUGIN_SECRET"], "s3cret");
    assert_eq!(
        env["PROJECT"],
        workspace().root.as_str(),
        "the project directory names resolve like the plugin root ones"
    );
    assert_eq!(env["ABSENT"], "${E2E_ABSENT}");
}

/// Fork (Node 对齐，`adapters/src/plugins/template.ts` 的 `allowSensitive` 之分)：普通位（command、args、url）只解析
/// 插件目录、项目目录与 `ZCODE_` 前缀的名字，进程环境里的其它名字（秘密）保持原样——Node 的 `mcp.ts` 把这些字段
/// 走 `allowSensitive: false`，秘密只在 `env` 与 `headers` 的值里展开。
#[tokio::test]
async fn plugin_plain_fields_keep_sensitive_names_literal() {
    let root = "/Users/dev/plugins/secret-args";
    let env = MemoryEnvironment::new(facts()).with_file(
        &format!("{root}/.claude-plugin/plugin.json"),
        r#"{"name": "secret-args", "mcpServers": {
            "verify": {"command": "node", "args": ["${ZCODE_PLUGIN_ROOT}/server.mjs", "--token", "${E2E_PLUGIN_SECRET}"], "env": {"E2E_PLUGIN_SECRET": "${E2E_PLUGIN_SECRET}"}},
            "web": {"type": "http", "url": "https://mcp.example.com/${E2E_PLUGIN_SECRET}", "headers": {"authorization": "Bearer ${E2E_PLUGIN_SECRET}"}}
        }}"#,
    );
    let sources = PluginSources {
        env: [("E2E_PLUGIN_SECRET".to_owned(), "s3cret".to_owned())]
            .into_iter()
            .collect(),
        ..PluginSources::default()
    };
    let plugins = load_all(&env, &workspace(), &[EnvPath::new(root)], &sources)
        .await
        .plugins;
    let verify = &plugins.0[0].mcp_servers[0];
    assert_eq!(verify.name, "plugin:secret-args:verify");
    let McpTransportConfig::Stdio { args, env, .. } = &verify.transport else {
        panic!("verify is stdio");
    };
    assert_eq!(args[0], format!("{root}/server.mjs"));
    assert_eq!(args[1], "--token");
    assert_eq!(args[2], "${E2E_PLUGIN_SECRET}");
    assert_eq!(env["E2E_PLUGIN_SECRET"], "s3cret");
    let web = &plugins.0[0].mcp_servers[1];
    let McpTransportConfig::Http { url, headers } = &web.transport else {
        panic!("web is http");
    };
    assert_eq!(url, "https://mcp.example.com/${E2E_PLUGIN_SECRET}");
    assert_eq!(headers["authorization"], "Bearer s3cret");
}

/// Fork (specs/fork-rust-plugin-ui-tool-result.md, rule 4): a plugin's server maps to the plugin's id, not its name.
#[test]
fn each_declared_server_maps_to_its_plugins_id() {
    let server = |name: &str| McpServer {
        name: name.to_owned(),
        scope: crate::mcp::McpScope::Plugin,
        transport: McpTransportConfig::stdio("node".to_owned(), Vec::new()),
        options: Default::default(),
        oauth: None,
        machine: Default::default(),
    };
    let plugin = |id: &str, name: &str, servers: Vec<McpServer>| Plugin {
        id: id.to_owned(),
        name: name.to_owned(),
        dir: "/p".to_owned(),
        manifest: serde_json::Value::Null,
        skill_dirs: Vec::new(),
        mcp_servers: servers,
        agent_files: Vec::new(),
        hooks: Vec::new(),
    };
    let plugins = Plugins(vec![
        plugin(
            "viewer@market",
            "viewer",
            vec![server("plugin:viewer:docs")],
        ),
        plugin("other@inline", "other", Vec::new()),
    ]);
    assert_eq!(
        plugins.mcp_plugin_ids(),
        [("plugin:viewer:docs".to_owned(), "viewer@market".to_owned())]
    );
}

/// Fork: only the plugin with Node's official Computer Use id flags its skill roots (a plugin that borrows the name
/// does not).
#[test]
fn only_the_official_computer_use_plugin_flags_its_skill_roots() {
    let plugin = |id: &str, dir: &str| Plugin {
        id: id.to_owned(),
        name: "computer-use".to_owned(),
        dir: dir.to_owned(),
        manifest: Value::Null,
        skill_dirs: vec![format!("{dir}/skills")],
        mcp_servers: Vec::new(),
        agent_files: Vec::new(),
        hooks: Vec::new(),
    };
    let plugins = Plugins(vec![
        plugin("computer-use@zcode-plugins-official", "/p/official"),
        plugin("computer-use@elsewhere", "/p/other"),
        plugin("computer-use@inline", "/p/inline"),
    ]);
    let flags: Vec<bool> = plugins
        .skill_roots()
        .iter()
        .map(|root| root.official_cua)
        .collect();
    assert_eq!(flags, [true, false, false]);
}
