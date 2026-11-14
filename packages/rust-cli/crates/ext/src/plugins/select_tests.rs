//! 插件来源与启用判定（ext.md §4.3、§4.4）。

use std::collections::BTreeMap;

use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use rust_cli_kernel_api::testing::MemoryEnvironment;

use super::*;
use crate::test_support::{facts, workspace};

const OFFICIAL: &str = "zcode-plugins-official";
const CACHE: &str = "/Users/dev/.zcode/cli/plugins/cache";

fn manifest(dir: &str, body: &str) -> (String, String) {
    (format!("{dir}/.zcode-plugin/plugin.json"), body.to_owned())
}

fn env(files: &[(String, String)]) -> MemoryEnvironment {
    files
        .iter()
        .fold(MemoryEnvironment::new(facts()), |env, (path, text)| {
            env.with_file(path, text)
        })
}

fn candidate(dir: &str, marketplace: &str, origin: PluginOrigin) -> PluginCandidate {
    PluginCandidate {
        dir: EnvPath::new(dir),
        marketplace: marketplace.to_owned(),
        origin,
    }
}

fn official(name: &str) -> PluginCandidate {
    candidate(
        &format!("{CACHE}/{OFFICIAL}/{name}/1.0.0"),
        OFFICIAL,
        PluginOrigin::Official,
    )
}

fn official_manifest(name: &str, extra: &str) -> (String, String) {
    manifest(
        &format!("{CACHE}/{OFFICIAL}/{name}/1.0.0"),
        &format!(r#"{{"name": "{name}"{extra}}}"#),
    )
}

fn enabled(pairs: &[(&str, bool)]) -> BTreeMap<String, bool> {
    pairs
        .iter()
        .map(|(id, on)| ((*id).to_owned(), *on))
        .collect()
}

fn names(loaded: &Loaded) -> Vec<&str> {
    loaded
        .plugins
        .0
        .iter()
        .map(|plugin| plugin.name.as_str())
        .collect()
}

fn reasons(loaded: &Loaded) -> Vec<(Option<&str>, &SkipReason)> {
    loaded
        .skipped
        .iter()
        .map(|skipped| (skipped.id.as_deref(), &skipped.reason))
        .collect()
}

#[tokio::test]
async fn enablement_follows_enabled_plugins_and_the_defaults() {
    let files = [
        manifest("/Users/dev/cfg", r#"{"name": " cfg-kit "}"#),
        (
            "/Users/dev/cfg/skills/hello/SKILL.md".to_owned(),
            "Hello\n".to_owned(),
        ),
        manifest("/Users/dev/off", r#"{"name": "off"}"#),
        manifest("/Users/dev/market-kit", r#"{"name": "market-kit"}"#),
        manifest("/Users/dev/on-kit", r#"{"name": "on-kit"}"#),
        official_manifest("skill-creator", ""),
        official_manifest("restore-legacy-sessions", ""),
        official_manifest("zcode-guide", ""),
    ];
    let sources = PluginSources {
        candidates: vec![
            candidate("/Users/dev/cfg", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/off", "inline", PluginOrigin::ConfigDir),
            official("skill-creator"),
            official("restore-legacy-sessions"),
            official("zcode-guide"),
            candidate("/Users/dev/market-kit", "market", PluginOrigin::Installed),
            candidate("/Users/dev/on-kit", "market", PluginOrigin::Installed),
        ],
        enabled_plugins: enabled(&[("off@inline", false), ("on-kit@market", true)]),
        suppressed_builtins: vec![format!("zcode-guide@{OFFICIAL}")],
        view_host: false,
        node_helper: false,
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    // 配置目录缺省启用；官方插件只有缺省名单里的启用；已安装插件要 `enabledPlugins` 打开。
    assert_eq!(names(&loaded), ["cfg-kit", "skill-creator", "on-kit"]);
    assert_eq!(
        loaded.plugins.0[0].skill_dirs,
        ["/Users/dev/cfg/skills".to_owned()]
    );
    assert_eq!(
        reasons(&loaded),
        [
            (Some("off@inline"), &SkipReason::Disabled),
            (
                Some("restore-legacy-sessions@zcode-plugins-official"),
                &SkipReason::Disabled
            ),
            (
                Some("zcode-guide@zcode-plugins-official"),
                &SkipReason::Suppressed
            ),
            (Some("market-kit@market"), &SkipReason::Disabled),
        ]
    );
}

#[tokio::test]
async fn sources_other_than_the_command_line_need_a_valid_manifest() {
    let files = [
        (
            "/Users/dev/bare/skills/x/SKILL.md".to_owned(),
            "B\n".to_owned(),
        ),
        manifest("/Users/dev/bad", r#"{"name": "Bad Name"}"#),
        (
            "/Users/dev/other/.codex-plugin/plugin.json".to_owned(),
            r#"{"name": "other-kit"}"#.to_owned(),
        ),
        (
            "/Users/dev/session/skills/y/SKILL.md".to_owned(),
            "S\n".to_owned(),
        ),
    ];
    let sources = PluginSources {
        candidates: vec![
            candidate("/Users/dev/bare", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/bad", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/other", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/missing", "inline", PluginOrigin::ConfigDir),
        ],
        ..PluginSources::default()
    };
    let session = [EnvPath::new("/Users/dev/session")];
    let loaded = load_all(&env(&files), &workspace(), &session, &sources).await;
    // `--plugin-dir` 没有 manifest 时取目录名；其余来源按 Node 必须有合法的 manifest。
    assert_eq!(names(&loaded), ["session", "other-kit"]);
    let reasons: Vec<&SkipReason> = loaded.skipped.iter().map(|s| &s.reason).collect();
    assert!(matches!(
        reasons.as_slice(),
        [
            SkipReason::ManifestMissing,
            SkipReason::ManifestInvalid(_),
            SkipReason::RootMissing
        ]
    ));
}

#[tokio::test]
async fn session_plugins_and_first_comers_win_name_conflicts() {
    let files = [
        manifest("/Users/dev/session-dup", r#"{"name": "dup"}"#),
        manifest("/Users/dev/cfg-dup", r#"{"name": "dup"}"#),
        manifest("/Users/dev/twin-a", r#"{"name": "twin"}"#),
        manifest("/Users/dev/twin-b", r#"{"name": "twin"}"#),
        manifest("/Users/dev/twin-market", r#"{"name": "twin"}"#),
    ];
    let sources = PluginSources {
        candidates: vec![
            candidate("/Users/dev/cfg-dup", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/twin-a", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/twin-b", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/twin-market", "market", PluginOrigin::Installed),
        ],
        enabled_plugins: enabled(&[("twin@market", true)]),
        ..PluginSources::default()
    };
    let session = [EnvPath::new("/Users/dev/session-dup")];
    let loaded = load_all(&env(&files), &workspace(), &session, &sources).await;
    assert_eq!(names(&loaded), ["dup", "twin"]);
    assert_eq!(loaded.plugins.0[1].dir, "/Users/dev/twin-a");
    assert_eq!(
        reasons(&loaded),
        [
            (Some("dup@inline"), &SkipReason::ShadowedBySession),
            (Some("twin@inline"), &SkipReason::DuplicateId),
            (Some("twin@market"), &SkipReason::DuplicateName),
        ]
    );
}

/// Fork (specs/fork-rust-lsp.md): the default-enabled official `typescript-lsp` declares only a language server, so it
/// claims no skill, MCP, agent or hook name and does not push out an installed plugin of the same name (Node keeps both).
#[tokio::test]
async fn an_official_plugin_without_session_components_does_not_take_its_name() {
    let lsp = r#", "lspServers": {"typescript": {"command": "tsls", "extensionToLanguage": {".ts": "typescript"}}}"#;
    let files = [
        official_manifest("typescript-lsp", lsp),
        manifest("/Users/dev/claude-ts", r#"{"name": "typescript-lsp"}"#),
        (
            "/Users/dev/claude-ts/skills/ts/SKILL.md".to_owned(),
            "---\nname: ts\ndescription: d\n---\n".to_owned(),
        ),
        manifest("/Users/dev/again", r#"{"name": "typescript-lsp"}"#),
    ];
    let sources = PluginSources {
        candidates: vec![
            official("typescript-lsp"),
            candidate(
                "/Users/dev/claude-ts",
                "claude-market",
                PluginOrigin::Installed,
            ),
            candidate("/Users/dev/again", "other-market", PluginOrigin::Installed),
        ],
        enabled_plugins: enabled(&[
            ("typescript-lsp@claude-market", true),
            ("typescript-lsp@other-market", true),
        ]),
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    let ids: Vec<&str> = loaded
        .plugins
        .0
        .iter()
        .map(|plugin| plugin.id.as_str())
        .collect();
    assert_eq!(
        ids,
        [
            "typescript-lsp@zcode-plugins-official",
            "typescript-lsp@claude-market"
        ]
    );
    // The installed copy has a skill, so it does take the name.
    assert_eq!(
        reasons(&loaded),
        [(
            Some("typescript-lsp@other-market"),
            &SkipReason::DuplicateName
        )]
    );
}

#[tokio::test]
async fn bundled_plugins_that_need_the_node_runtime_are_skipped() {
    let host_mcp = r#", "mcpServers": {"documents": {"type": "stdio", "command": "/opt/zcode/zcode", "args": ["__zcode-plugin-host", "/x/dist/mcp/server.js"]}}"#;
    let files = [
        official_manifest("browser-use", r#", "skills": "skills""#),
        official_manifest("computer-use", ""),
        official_manifest("documents", host_mcp),
        official_manifest("image-search", ""),
        (
            format!("{CACHE}/{OFFICIAL}/image-search/1.0.0/.mcp.json"),
            r#"{"mcpServers": {"image_search": {"type": "http", "url": "${ZCODE_BASE_URL}/mcp", "auth": {"type": "zcode_official", "provider": "jwt_token"}}}}"#.to_owned(),
        ),
        official_manifest("visualize", ""),
        official_manifest("android-emulator", host_mcp),
        official_manifest("skill-creator", ""),
        manifest(
            "/Users/dev/third",
            &format!(r#"{{"name": "third"{host_mcp}}}"#),
        ),
    ];
    let sources = PluginSources {
        candidates: vec![
            official("browser-use"),
            official("computer-use"),
            official("documents"),
            official("image-search"),
            official("visualize"),
            official("android-emulator"),
            official("skill-creator"),
            candidate("/Users/dev/third", "market", PluginOrigin::Installed),
        ],
        enabled_plugins: enabled(&[
            ("computer-use@zcode-plugins-official", true),
            ("third@market", true),
        ]),
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    // 只判定官方市场的插件：第三方插件里同样的参数照常加载。
    assert_eq!(names(&loaded), ["skill-creator", "third"]);
    assert_eq!(
        reasons(&loaded),
        [
            (
                Some("browser-use@zcode-plugins-official"),
                &SkipReason::NodeRuntime(NodeDependency::NodeRepl)
            ),
            (
                Some("computer-use@zcode-plugins-official"),
                &SkipReason::NodeRuntime(NodeDependency::NodeRepl)
            ),
            (
                Some("documents@zcode-plugins-official"),
                &SkipReason::NodeRuntime(NodeDependency::PluginHost)
            ),
            (
                Some("image-search@zcode-plugins-official"),
                &SkipReason::NodeRuntime(NodeDependency::OfficialAuth)
            ),
            (
                Some("visualize@zcode-plugins-official"),
                &SkipReason::NodeRuntime(NodeDependency::ViewHost)
            ),
            // 未启用的插件只记“未启用”，不判定 Node 依赖。
            (
                Some("android-emulator@zcode-plugins-official"),
                &SkipReason::Disabled
            ),
        ]
    );
}

/// Fork: on the desktop surface (`view_host`) `visualize` loads, like Node's protocol entry; the other Node
/// dependencies are still skipped.
#[tokio::test]
async fn visualize_loads_with_the_desktop_view_host() {
    let files = [
        official_manifest("visualize", ""),
        official_manifest("computer-use", ""),
    ];
    let sources = PluginSources {
        candidates: vec![official("visualize"), official("computer-use")],
        enabled_plugins: enabled(&[("computer-use@zcode-plugins-official", true)]),
        view_host: true,
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    assert_eq!(names(&loaded), ["visualize"]);
    assert_eq!(
        reasons(&loaded),
        [(
            Some("computer-use@zcode-plugins-official"),
            &SkipReason::NodeRuntime(NodeDependency::NodeRepl)
        )]
    );
}

#[tokio::test]
async fn a_component_less_official_plugin_loads_after_a_same_named_one() {
    let lsp = r#", "lspServers": {"typescript": {"command": "tsls", "extensionToLanguage": {".ts": "typescript"}}}"#;
    let skill = "---\nname: s\ndescription: d\n---\n".to_owned();
    let files = [
        manifest("/Users/dev/cfg-ts", r#"{"name": "typescript-lsp"}"#),
        (
            "/Users/dev/cfg-ts/skills/s/SKILL.md".to_owned(),
            skill.clone(),
        ),
        manifest("/Users/dev/cfg-review", r#"{"name": "review"}"#),
        (
            "/Users/dev/cfg-review/skills/s/SKILL.md".to_owned(),
            skill.clone(),
        ),
        official_manifest("typescript-lsp", lsp),
        official_manifest("review", ""),
        (
            format!("{CACHE}/{OFFICIAL}/review/1.0.0/skills/s/SKILL.md"),
            skill,
        ),
    ];
    let sources = PluginSources {
        candidates: vec![
            candidate("/Users/dev/cfg-ts", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/cfg-review", "inline", PluginOrigin::ConfigDir),
            official("typescript-lsp"),
            official("review"),
        ],
        enabled_plugins: enabled(&[("review@zcode-plugins-official", true)]),
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    let ids: Vec<&str> = loaded
        .plugins
        .0
        .iter()
        .map(|plugin| plugin.id.as_str())
        .collect();
    // Node dedupes by full id only, so the built-in language server still loads next to a config-dir plugin of
    // the same name. An official plugin with a skill does claim the name and stays out.
    assert_eq!(
        ids,
        [
            "typescript-lsp@inline",
            "review@inline",
            "typescript-lsp@zcode-plugins-official"
        ]
    );
    assert_eq!(
        reasons(&loaded),
        [(
            Some("review@zcode-plugins-official"),
            &SkipReason::DuplicateName
        )]
    );
}

fn transports<'a>(loaded: &'a Loaded, plugin: &str) -> Vec<(&'a str, &'a McpTransportConfig)> {
    loaded
        .plugins
        .0
        .iter()
        .filter(|candidate| candidate.name == plugin)
        .flat_map(|candidate| candidate.mcp_servers.iter())
        .map(|server| (server.name.as_str(), &server.transport))
        .collect()
}

const APP_SERVER: &str =
    r#""mcpServers": {"view": {"type": "stdio", "command": "node", "args": ["server.mjs"]}}"#;

/// Fork (specs/fork-rust-node-helper.md F3): with a helper, the PluginHost official plugins load and every MCP server
/// of a helper-hosted plugin is served by the helper; the other Node dependencies stay skipped.
#[tokio::test]
async fn plugin_host_plugins_load_with_a_node_helper() {
    let host_mcp = r#", "mcpServers": {"documents": {"type": "stdio", "command": "/opt/zcode/zcode", "args": ["__zcode-plugin-host", "/x/dist/mcp/server.js"]}, "extra": {"type": "stdio", "command": "node", "args": ["extra.js"]}}"#;
    let files = [
        official_manifest("documents", host_mcp),
        official_manifest("browser-use", ""),
        official_manifest("image-search", ""),
        (
            format!("{CACHE}/{OFFICIAL}/image-search/1.0.0/.mcp.json"),
            r#"{"mcpServers": {"image_search": {"type": "http", "url": "https://x/mcp", "auth": {"type": "zcode_official"}}}}"#.to_owned(),
        ),
    ];
    let sources = PluginSources {
        candidates: vec![
            official("documents"),
            official("browser-use"),
            official("image-search"),
        ],
        node_helper: true,
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    assert_eq!(names(&loaded), ["documents"]);
    assert_eq!(
        transports(&loaded, "documents"),
        [
            (
                "plugin:documents:documents",
                &McpTransportConfig::NodeHelper
            ),
            ("plugin:documents:extra", &McpTransportConfig::NodeHelper),
        ]
    );
    assert_eq!(
        reasons(&loaded),
        [
            (
                Some("browser-use@zcode-plugins-official"),
                &SkipReason::NodeRuntime(NodeDependency::NodeRepl)
            ),
            (
                Some("image-search@zcode-plugins-official"),
                &SkipReason::NodeRuntime(NodeDependency::OfficialAuth)
            ),
        ]
    );
}

/// Fork (F3: OfficialAuth stays skipped): a PluginHost plugin with an official-auth server stays skipped with a
/// helper, whatever the order of its servers, and says so.
#[tokio::test]
async fn a_plugin_host_plugin_with_an_auth_server_stays_skipped_with_a_node_helper() {
    let mixed = r#", "mcpServers": {"a_host": {"type": "stdio", "command": "/opt/zcode/zcode", "args": ["__zcode-plugin-host", "/x/dist/mcp/server.js"]}, "b_auth": {"type": "http", "url": "https://x/mcp", "auth": {"type": "zcode_official"}}}"#;
    let files = [official_manifest("documents", mixed)];
    let sources = PluginSources {
        candidates: vec![official("documents")],
        node_helper: true,
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    assert!(names(&loaded).is_empty());
    assert_eq!(
        reasons(&loaded),
        [(
            Some("documents@zcode-plugins-official"),
            &SkipReason::NodeRuntime(NodeDependency::OfficialAuth)
        )]
    );
}

/// Fork (F3): a plugin that declares an MCP App entry point (a non-empty `ui.surfaces`, or a `composer.mention` slot
/// with a `target.tool`) is helper-hosted when a helper is configured, from any source; without a helper, or without
/// such an entry point, its servers stay Rust's own.
#[tokio::test]
async fn mcp_app_plugins_are_helper_hosted_with_a_node_helper() {
    let files = [
        manifest(
            "/Users/dev/viewer",
            &format!(
                r#"{{"name": "viewer", {APP_SERVER}, "ui": {{"surfaces": [{{"id": "panel"}}]}}}}"#
            ),
        ),
        manifest(
            "/Users/dev/mention",
            &format!(
                r#"{{"name": "mention", {APP_SERVER}, "slots": {{"composer.mention": [{{"id": "docs", "target": {{"tool": "search"}}}}]}}}}"#
            ),
        ),
        manifest(
            "/Users/dev/plain",
            &format!(
                r#"{{"name": "plain", {APP_SERVER}, "ui": {{"surfaces": []}}, "slots": {{"composer.mention": [{{"id": "x", "target": {{"command": "c"}}}}]}}}}"#
            ),
        ),
        manifest(
            "/Users/dev/session-app",
            &format!(
                r#"{{"name": "session-app", {APP_SERVER}, "ui": {{"surfaces": [{{"id": "s"}}]}}}}"#
            ),
        ),
    ];
    let candidates = vec![
        candidate("/Users/dev/viewer", "inline", PluginOrigin::ConfigDir),
        candidate("/Users/dev/mention", "inline", PluginOrigin::ConfigDir),
        candidate("/Users/dev/plain", "inline", PluginOrigin::ConfigDir),
    ];
    let session = [EnvPath::new("/Users/dev/session-app")];
    let helper = PluginSources {
        candidates: candidates.clone(),
        node_helper: true,
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &session, &helper).await;
    assert_eq!(
        names(&loaded),
        ["session-app", "viewer", "mention", "plain"]
    );
    for plugin in ["session-app", "viewer", "mention"] {
        let found = transports(&loaded, plugin);
        assert_eq!(found.len(), 1, "{plugin}");
        assert_eq!(found[0].1, &McpTransportConfig::NodeHelper, "{plugin}");
    }
    assert!(matches!(
        transports(&loaded, "plain")[0].1,
        McpTransportConfig::Stdio { .. }
    ));

    let without = PluginSources {
        candidates,
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &session, &without).await;
    for plugin in ["session-app", "viewer", "mention", "plain"] {
        assert!(
            matches!(
                transports(&loaded, plugin)[0].1,
                McpTransportConfig::Stdio { .. }
            ),
            "{plugin}"
        );
    }
}
