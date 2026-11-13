//! Fork: plugin language-server declarations (specs/fork-rust-lsp.md "Declarations", acceptance 5 and 7).

use rust_cli_base::secret::EnvSnapshot;
use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::testing::MemoryEnvironment;
use serde_json::{Map, Value, json};

use super::super::template::{VariableContext, sanitize_plugin_id};
use super::super::{PluginCandidate, PluginOrigin, PluginSources, load_all};
use super::*;
use crate::test_support::{facts, workspace};

const OFFICIAL: &str = "zcode-plugins-official";
const CACHE: &str = "/Users/dev/.zcode/cli/plugins/cache";
const KIT: &str = "/Users/dev/plugins/kit";
const DATA: &str = "/Users/dev/.zcode/cli/plugins/data";

fn manifest_path(dir: &str) -> String {
    format!("{dir}/.zcode-plugin/plugin.json")
}

/// The manifest is `{"name": …, "lspServers": <spec>}` (`spec` omitted when `None`).
async fn plugin_with(files: &[(&str, &str)], spec: Option<Value>) -> (MemoryEnvironment, Plugin) {
    let mut manifest = json!({"name": "kit"});
    if let Some(spec) = spec {
        manifest["lspServers"] = spec;
    }
    let env = files.iter().fold(
        MemoryEnvironment::new(facts()).with_file(&manifest_path(KIT), &manifest.to_string()),
        |env, (path, text)| env.with_file(&format!("{KIT}/{path}"), text),
    );
    let mut plugins = load_all(
        &env,
        &workspace(),
        &[EnvPath::new(KIT)],
        &PluginSources::default(),
    )
    .await
    .plugins;
    let plugin = plugins.0.remove(0);
    (env, plugin)
}

async fn names(files: &[(&str, &str)], spec: Option<Value>) -> Vec<String> {
    let (env, plugin) = plugin_with(files, spec).await;
    declared(&env, &workspace(), &plugin)
        .await
        .into_iter()
        .map(|(name, _)| name)
        .collect()
}

fn server(command: &str, extensions: &[&str]) -> Value {
    let map: Map<String, Value> = extensions
        .iter()
        .map(|extension| ((*extension).to_owned(), json!("lang")))
        .collect();
    json!({"command": command, "extensionToLanguage": map})
}

#[tokio::test]
async fn the_official_typescript_plugin_declares_its_server_by_default() {
    let dir = format!("{CACHE}/{OFFICIAL}/typescript-lsp/0.1.0");
    let manifest = include_str!(
        "../../../../../../apps/zcode-cli/packages/typescript-lsp-plugin/.zcode-plugin/plugin.json"
    );
    let env = MemoryEnvironment::new(facts()).with_file(&manifest_path(&dir), manifest);
    let sources = PluginSources {
        candidates: vec![PluginCandidate {
            dir: EnvPath::new(&dir),
            marketplace: OFFICIAL.to_owned(),
            origin: PluginOrigin::Official,
        }],
        ..PluginSources::default()
    };
    let plugins = load_all(&env, &workspace(), &[], &sources).await.plugins;
    let plugin = &plugins.0[0];
    assert_eq!(plugin.id, "typescript-lsp@zcode-plugins-official");
    let definitions = declared(&env, &workspace(), plugin).await;
    let process_env = EnvSnapshot::default();
    let options = Map::new();
    let context = VariableContext {
        plugin,
        data_path: format!("{DATA}/{}", sanitize_plugin_id(&plugin.id)),
        env: &process_env,
        options: &options,
        working_directory: workspace().root.as_str().to_owned(),
    };
    let servers = resolve(&definitions, &context);
    assert_eq!(servers.len(), 1);
    let typescript = &servers[0];
    assert_eq!(
        typescript.id,
        "typescript-lsp@zcode-plugins-official/typescript"
    );
    assert_eq!(typescript.command, "typescript-language-server");
    assert_eq!(typescript.args, ["--stdio"]);
    let extensions: Vec<&str> = typescript
        .extension_to_language
        .iter()
        .map(|(extension, _)| extension.as_str())
        .collect();
    assert_eq!(
        extensions,
        [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]
    );
    assert_eq!(
        typescript.initialization_options,
        Some(json!({"tsserver": {"useSyntaxServer": "never"}}))
    );
    assert_eq!(
        (
            typescript.startup_timeout_ms,
            typescript.shutdown_timeout_ms,
            typescript.request_timeout_ms,
            typescript.restart_on_crash,
            typescript.max_restarts,
            typescript.diagnostics_after_edit,
            typescript.workspace_folder.clone(),
        ),
        (30_000, 5_000, 60_000, true, 3, true, None)
    );
    // The six identity variables, in Node's order.
    let keys: Vec<&str> = typescript.env.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(
        keys,
        [
            "CLAUDE_PROJECT_DIR",
            "ZCODE_PLUGIN_DATA",
            "ZCODE_PLUGIN_ROOT",
            "ZCODE_PROJECT_DIR",
            "CLAUDE_PLUGIN_DATA",
            "CLAUDE_PLUGIN_ROOT"
        ]
    );
    assert_eq!(
        typescript.env[1].1,
        format!("{DATA}/typescript-lsp@zcode-plugins-official")
    );
}

#[tokio::test]
async fn the_manifest_overrides_the_default_file_by_name_in_place() {
    let file = json!({"a": server("a", &[".a"]), "b": server("b-file", &[".b"])}).to_string();
    let (env, plugin) = plugin_with(
        &[(".lsp.json", &file)],
        Some(json!({"c": server("c", &[".c"]), "b": server("b-manifest", &[".b"])})),
    )
    .await;
    let found: Vec<(String, String)> = declared(&env, &workspace(), &plugin)
        .await
        .into_iter()
        .map(|(name, config)| (name, config.command))
        .collect();
    assert_eq!(
        found,
        [
            ("a".to_owned(), "a".to_owned()),
            ("b".to_owned(), "b-manifest".to_owned()),
            ("c".to_owned(), "c".to_owned())
        ]
    );
}

#[tokio::test]
async fn paths_arrays_and_the_wrapper_are_accepted() {
    let wrapped = json!({"lspServers": {"w": server("w", &[".w"])}}).to_string();
    let bare = json!({"p": server("p", &[".p"])}).to_string();
    // The default file may use the wrapper too.
    assert_eq!(names(&[(".lsp.json", &wrapped)], None).await, ["w"]);
    // A path, then an inline map; later entries win.
    assert_eq!(
        names(
            &[("config/servers.json", &bare), ("more.json", &wrapped)],
            Some(json!(["./config/servers.json", "more.json", {"i": server("i", &[".i"])}]))
        )
        .await,
        ["p", "w", "i"]
    );
    // The inline map may also be wrapped.
    assert_eq!(
        names(
            &[],
            Some(json!({"lspServers": {"x": server("x", &[".x"])}}))
        )
        .await,
        ["x"]
    );
}

#[tokio::test]
async fn escaping_missing_and_malformed_sources_contribute_nothing() {
    assert!(names(&[], Some(json!("../outside.json"))).await.is_empty());
    assert!(
        names(&[], Some(json!("/abs/servers.json")))
            .await
            .is_empty()
    );
    assert!(names(&[], Some(json!("missing.json"))).await.is_empty());
    assert!(
        names(&[("bad.json", "{not json")], Some(json!("bad.json")))
            .await
            .is_empty()
    );
    assert!(names(&[(".lsp.json", "[]")], None).await.is_empty());
    assert!(names(&[], Some(json!(7))).await.is_empty());
    // A bad source does not hide a good one next to it.
    assert_eq!(
        names(
            &[],
            Some(json!(["../outside.json", {"ok": server("ok", &[".ok"])}]))
        )
        .await,
        ["ok"]
    );
}

#[test]
fn validation_follows_the_strict_node_schema() {
    let base = server("ls", &[".ts"]);
    let with = |key: &str, value: Value| {
        let mut config = base.clone();
        config[key] = value;
        config
    };
    let invalid = [
        json!({"extensionToLanguage": {".ts": "ts"}}),
        with("command", json!("")),
        with("extensionToLanguage", json!({})),
        with("extensionToLanguage", json!({"ts": "ts"})),
        with("extensionToLanguage", json!({".": "ts"})),
        with("extensionToLanguage", json!({".t s": "ts"})),
        with("extensionToLanguage", json!({".t\u{a0}s": "ts"})),
        with("extensionToLanguage", json!({".a/b": "ts"})),
        with("extensionToLanguage", json!({".ts": ""})),
        with("args", json!(["ok", 1])),
        with("transport", json!("tcp")),
        with("env", json!({"A": 1})),
        with("workspaceFolder", json!("")),
        with("startupTimeout", json!(0)),
        with("shutdownTimeout", json!(1.5)),
        with("requestTimeout", json!(-1)),
        with("restartOnCrash", json!("yes")),
        with("maxRestarts", json!(-1)),
        with("diagnostics", json!(1)),
        with("unknown", json!(true)),
        json!("ls"),
    ];
    for config in invalid {
        assert!(validate(&config).is_err(), "{config} should be refused");
    }
    let full = json!({
        "command": "ls", "extensionToLanguage": {".ts": "typescript", ".vue": "vue"},
        "args": ["--stdio"], "transport": "socket", "env": {"A": "1"},
        "initializationOptions": null, "settings": {"x": 1}, "workspaceFolder": "sub",
        "startupTimeout": 1, "shutdownTimeout": 2.0, "requestTimeout": 3,
        "restartOnCrash": false, "maxRestarts": 0, "diagnostics": false
    });
    let config = validate(&full).expect("valid");
    assert_eq!(config.transport.as_deref(), Some("socket"));
    assert_eq!(config.shutdown_timeout, Some(2));
    assert_eq!(config.max_restarts, Some(0));
    // A present `null` is still a present key (zod `unknown().optional()`).
    assert_eq!(config.initialization_options, Some(Value::Null));
    assert_eq!(
        config.extension_to_language,
        [
            (".ts".to_owned(), "typescript".to_owned()),
            (".vue".to_owned(), "vue".to_owned())
        ]
    );
}

#[tokio::test]
async fn an_invalid_server_is_skipped_and_its_siblings_stay() {
    assert_eq!(
        names(
            &[],
            Some(json!({"bad": {"command": ""}, "good": server("good", &[".g"])}))
        )
        .await,
        ["good"]
    );
}

fn context<'a>(
    plugin: &'a Plugin,
    env: &'a EnvSnapshot,
    options: &'a Map<String, Value>,
) -> VariableContext<'a> {
    VariableContext {
        plugin,
        data_path: format!("{DATA}/kit@inline"),
        env,
        options,
        working_directory: "/Users/dev/work".to_owned(),
    }
}

#[tokio::test]
async fn templates_expand_with_node_rules() {
    let user_config = json!({
        "port": {"type": "number", "default": 1},
        "token": {"type": "string", "sensitive": true},
        "mode": {"type": "string", "default": "fast"}
    });
    let spec = json!({
        "ok": {
            "command": "${CLAUDE_PLUGIN_ROOT}/bin/ls",
            "args": ["--port=${user_config.port}", "${user_config.mode}", "${HOME}", "${ZCODE_LEVEL}", "${", "${}"],
            "env": {"TOKEN": "${user_config.token}", "HOME_DIR": "${HOME}", "ZCODE_PLUGIN_ROOT": "override"},
            "workspaceFolder": "${CLAUDE_PROJECT_DIR}/packages/app",
            "extensionToLanguage": {".x": "x"}
        },
        "secret-in-args": {"command": "ls", "args": ["${user_config.token}"], "extensionToLanguage": {".y": "y"}},
        "missing-zcode": {"command": "${ZCODE_MISSING}", "extensionToLanguage": {".z": "z"}},
        "session": {"command": "ls", "args": ["${ZCODE_SESSION_ID}"], "extensionToLanguage": {".s": "s"}},
        "outside": {"command": "ls", "workspaceFolder": "../other", "extensionToLanguage": {".o": "o"}},
        "root": {"command": "ls", "workspaceFolder": "${ZCODE_PROJECT_DIR}", "extensionToLanguage": {".r": "r"}}
    });
    let manifest = json!({"name": "kit", "userConfig": user_config, "lspServers": spec});
    let fs = MemoryEnvironment::new(facts()).with_file(&manifest_path(KIT), &manifest.to_string());
    let plugin = load_all(
        &fs,
        &workspace(),
        &[EnvPath::new(KIT)],
        &PluginSources::default(),
    )
    .await
    .plugins
    .0
    .remove(0);
    let definitions = declared(&fs, &workspace(), &plugin).await;
    let env: EnvSnapshot = [("HOME", "/Users/dev"), ("ZCODE_LEVEL", "2")]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect();
    let options: Map<String, Value> = json!({"port": 8080.0, "token": "s3cret"})
        .as_object()
        .cloned()
        .unwrap_or_default();
    let servers = resolve(&definitions, &context(&plugin, &env, &options));
    let ids: Vec<&str> = servers
        .iter()
        .map(|server| server.server_name.as_str())
        .collect();
    assert_eq!(ids, ["ok", "root"]);
    let ok = &servers[0];
    assert_eq!(ok.id, "kit@inline/ok");
    assert_eq!(ok.command, format!("{KIT}/bin/ls"));
    assert_eq!(
        ok.args,
        ["--port=8080", "fast", "${HOME}", "2", "${", "${}"]
    );
    let env_of = |key: &str| {
        ok.env
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };
    assert_eq!(env_of("TOKEN"), Some("s3cret"));
    assert_eq!(env_of("HOME_DIR"), Some("/Users/dev"));
    // A redeclared identity variable keeps its slot and takes the server's value.
    assert_eq!(
        ok.env[2],
        ("ZCODE_PLUGIN_ROOT".to_owned(), "override".to_owned())
    );
    assert_eq!(ok.env.len(), 8);
    assert_eq!(ok.workspace_folder.as_deref(), Some("packages/app"));
    assert_eq!(servers[1].workspace_folder, None);
}

#[tokio::test]
async fn a_missing_user_config_value_skips_the_server() {
    let spec =
        json!({"needs": {"command": "${user_config.absent}", "extensionToLanguage": {".n": "n"}}});
    let (env, plugin) = plugin_with(&[], Some(spec)).await;
    let definitions = declared(&env, &workspace(), &plugin).await;
    let process_env = EnvSnapshot::default();
    let options = Map::new();
    assert!(resolve(&definitions, &context(&plugin, &process_env, &options)).is_empty());
}

fn resolved(id: &str, extensions: &[&str]) -> ResolvedLspServer {
    ResolvedLspServer {
        id: id.to_owned(),
        plugin_id: id.split('/').next().unwrap_or_default().to_owned(),
        server_name: id.split('/').nth(1).unwrap_or_default().to_owned(),
        command: "ls".to_owned(),
        args: Vec::new(),
        env: Vec::new(),
        extension_to_language: extensions
            .iter()
            .map(|extension| ((*extension).to_owned(), "lang".to_owned()))
            .collect(),
        initialization_options: None,
        settings: None,
        workspace_folder: None,
        startup_timeout_ms: DEFAULT_STARTUP_TIMEOUT_MS,
        shutdown_timeout_ms: DEFAULT_SHUTDOWN_TIMEOUT_MS,
        request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
        restart_on_crash: true,
        max_restarts: DEFAULT_MAX_RESTARTS,
        diagnostics_after_edit: true,
    }
}

#[test]
fn the_first_server_keeps_a_shared_extension() {
    let kept = resolve_conflicts(vec![
        resolved("a@m/one", &[".ts", ".js"]),
        resolved("b@m/two", &[".ts", ".vue"]),
        resolved("c@m/three", &[".ts", ".js"]),
        resolved("d@m/four", &[".md"]),
    ]);
    let summary: Vec<(String, Vec<String>)> = kept
        .iter()
        .map(|server| {
            (
                server.id.clone(),
                server
                    .extension_to_language
                    .iter()
                    .map(|(extension, _)| extension.clone())
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            (
                "a@m/one".to_owned(),
                vec![".ts".to_owned(), ".js".to_owned()]
            ),
            ("b@m/two".to_owned(), vec![".vue".to_owned()]),
            ("d@m/four".to_owned(), vec![".md".to_owned()]),
        ]
    );
}
