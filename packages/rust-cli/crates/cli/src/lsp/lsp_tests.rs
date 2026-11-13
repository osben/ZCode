//! Fork: the app-server language-server host (specs/fork-rust-lsp.md, acceptance 1–6).
#![allow(
    clippy::disallowed_methods,
    reason = "tests prepare a temporary HOME, plugin cache and PATH"
)]

use std::path::Path;

use rust_cli_kernel_api::env::EnvFacts;
use rust_cli_kernel_api::testing::MemoryEnvironment;
use serde_json::json;

use super::installed::{candidates, process_env};
use super::preferences::{apply, parse, text};
use super::*;

/// The Node fork Vitest `lsp-preferences-sidecar.test.ts` asserts Node writes the same bytes for the same patches.
const GOLDEN: &str = include_str!("fixtures/fork_lsp_preferences.json");
const TYPESCRIPT: &str = include_str!(
    "../../../../../../apps/zcode-cli/packages/typescript-lsp-plugin/.zcode-plugin/plugin.json"
);

fn patch(enabled: Option<bool>, overrides: &[(&str, Option<bool>)]) -> LspPreferencesPatch {
    LspPreferencesPatch {
        enabled,
        diagnostics_after_edit: overrides
            .iter()
            .map(|(id, on)| ((*id).to_owned(), *on))
            .collect(),
    }
}

fn store() -> (tempfile::TempDir, PathBuf, PreferencesStore) {
    let dir = tempfile::tempdir().unwrap();
    // `cli/` does not exist yet: the first write creates it (Node `createParents`).
    let path = dir.path().join("cli").join("fork_lsp_preferences.json");
    (dir, path.clone(), PreferencesStore::new(path))
}

#[tokio::test]
async fn the_patch_sequence_writes_the_golden_sidecar() {
    let (_dir, path, store) = store();
    for step in [
        patch(None, &[("a@m/x", Some(false)), ("b@m/y", Some(true))]),
        patch(
            Some(false),
            &[
                ("a@m/x", None),
                ("q@m/\"ü\"", Some(true)),
                ("b@m/y", Some(false)),
            ],
        ),
        patch(None, &[("c@m/z", Some(false))]),
    ] {
        store.update(&step).await.unwrap();
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap(), GOLDEN);
}

#[tokio::test]
async fn no_sidecar_reads_as_the_defaults_and_creates_nothing() {
    let (_dir, path, store) = store();
    assert_eq!(store.load().await, LspPreferences::default());
    assert!(!path.exists());
}

#[tokio::test]
async fn a_node_written_sidecar_reads_back_unchanged() {
    let (_dir, path, store) = store();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, GOLDEN).unwrap();
    let loaded = store.load().await;
    assert!(!loaded.enabled);
    assert_eq!(
        serde_json::to_value(&loaded.diagnostics_after_edit).unwrap(),
        json!({"b@m/y": false, "q@m/\"ü\"": true, "c@m/z": false})
    );
    assert_eq!(text(&loaded), GOLDEN);
}

#[tokio::test]
async fn an_update_merges_onto_what_is_on_disk() {
    let (_dir, path, store) = store();
    store
        .update(&patch(None, &[("a/x", Some(false))]))
        .await
        .unwrap();
    // Another runtime wrote in between.
    std::fs::write(
        &path,
        "{\"version\":1,\"enabled\":true,\"diagnosticsAfterEdit\":{\"a/x\":false,\"n/w\":true}}",
    )
    .unwrap();
    let next = store
        .update(&patch(Some(false), &[("a/x", None), ("b/y", Some(true))]))
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&next.diagnostics_after_edit).unwrap(),
        json!({"n/w": true, "b/y": true})
    );
    assert_eq!(parse(std::fs::read(&path).unwrap().as_slice()), next);
}

#[tokio::test]
async fn invalid_sidecars_read_as_the_defaults_and_set_replaces_them() {
    for content in [
        "{not json",
        r#"{"version":2,"enabled":false,"diagnosticsAfterEdit":{}}"#,
        r#"{"version":1,"enabled":false,"diagnosticsAfterEdit":{},"extra":1}"#,
        r#"{"version":1,"enabled":false}"#,
        r#"{"version":1,"enabled":"no","diagnosticsAfterEdit":{}}"#,
        r#"{"version":1,"enabled":false,"diagnosticsAfterEdit":{"a/x":1}}"#,
        "[]",
    ] {
        let (_dir, path, store) = store();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        assert_eq!(store.load().await, LspPreferences::default(), "{content}");
        store
            .update(&patch(None, &[("a/x", Some(true))]))
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"version\": 1,\n  \"enabled\": true,\n  \"diagnosticsAfterEdit\": {\n    \"a/x\": true\n  }\n}\n",
            "{content}"
        );
    }
}

#[tokio::test]
async fn an_unreadable_sidecar_fails_set_and_stays() {
    let (_dir, path, store) = store();
    std::fs::create_dir_all(&path).unwrap();
    assert_eq!(store.load().await, LspPreferences::default());
    assert!(store.update(&patch(Some(false), &[])).await.is_err());
    assert!(path.is_dir());
}

#[test]
fn override_keys_follow_js_property_order() {
    let base = LspPreferences::default();
    let next = apply(
        base,
        &patch(None, &[("z@m/s", Some(true)), ("7", Some(false))]),
    );
    // An array-index key comes first in `JSON.stringify`.
    assert_eq!(
        text(&next),
        "{\n  \"version\": 1,\n  \"enabled\": true,\n  \"diagnosticsAfterEdit\": {\n    \"7\": false,\n    \"z@m/s\": true\n  }\n}\n"
    );
}

fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

#[test]
fn the_server_env_overrides_the_process_env() {
    let base: EnvSnapshot = vars(&[("PATH", "/usr/bin"), ("Path", "/x"), ("HOME", "/h")])
        .into_iter()
        .collect();
    assert_eq!(
        process_env(&base, &vars(&[("PATH", "/opt/bin"), ("NEW", "1")]), false),
        vars(&[
            ("PATH", "/opt/bin"),
            ("Path", "/x"),
            ("HOME", "/h"),
            ("NEW", "1")
        ])
    );
    // Windows: every case variant goes and the server's key is appended.
    assert_eq!(
        process_env(&base, &vars(&[("path", "C:\\bin")]), true),
        vars(&[("HOME", "/h"), ("path", "C:\\bin")])
    );
}

#[test]
fn candidates_follow_node_lookup() {
    let env = vars(&[("PATH", "/a::rel:/b"), ("PATHEXT", ".EXE; .Cmd ;")]);
    let paths = |command: &str, windows: bool| -> Vec<String> {
        candidates(command, &env, windows)
            .into_iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect()
    };
    assert_eq!(paths("tsls", false), ["/a/tsls", "rel/tsls", "/b/tsls"]);
    assert_eq!(paths("./bin/tsls", false), ["./bin/tsls"]);
    assert_eq!(paths("/opt/tsls", false), ["/opt/tsls"]);
    let windows_env = vars(&[
        ("Path", "C:\\a;\"C:\\Program Files\\b\";;"),
        ("PATHEXT", ".EXE;.Cmd"),
    ]);
    let windows = |command: &str| -> Vec<String> {
        candidates(command, &windows_env, true)
            .into_iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect()
    };
    assert_eq!(
        windows("tsls"),
        [
            "C:/a/tsls",
            "C:/a/tsls.exe",
            "C:/a/tsls.cmd",
            "C:/Program Files/b/tsls",
            "C:/Program Files/b/tsls.exe",
            "C:/Program Files/b/tsls.cmd"
        ]
    );
    // A name with an extension is tried as written.
    assert_eq!(
        windows("tsls.exe"),
        ["C:/a/tsls.exe", "C:/Program Files/b/tsls.exe"]
    );
    assert_eq!(
        windows("bin\\tsls"),
        ["bin/tsls", "bin/tsls.exe", "bin/tsls.cmd"]
    );
    // No PATHEXT: Node's default list.
    assert_eq!(candidates("x", &vars(&[("PATH", "C:\\a")]), true).len(), 5);
}

/// A temporary HOME with the official `typescript-lsp` plugin in the cache, the plugin manifests and project config
/// in a memory environment, and a PATH directory that may hold `typescript-language-server`.
struct Fixture {
    _home: tempfile::TempDir,
    host: Host,
    bin: PathBuf,
}

const KIT: &str = "/Users/dev/kit";

async fn fixture(project_files: &[(&str, serde_json::Value)]) -> Fixture {
    let home = tempfile::tempdir().unwrap();
    let official = home
        .path()
        .join(".zcode/cli/plugins/cache/zcode-plugins-official/typescript-lsp/0.1.0");
    std::fs::create_dir_all(&official).unwrap();
    let bin = home.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let user_config = home.path().join(".zcode/cli/config.json");
    std::fs::write(
        &user_config,
        json!({"plugins": {"options": {"kit@inline": {"flag": "--fast"}}}}).to_string(),
    )
    .unwrap();
    let facts = EnvFacts {
        cwd: EnvPath::new("/Users/dev/a"),
        platform: "darwin".to_owned(),
        os_version: "Darwin".to_owned(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    };
    let kit = json!({"name": "kit", "lspServers": {"vue": {
        "command": "${CLAUDE_PROJECT_DIR}/bin/vue-ls", "args": ["${user_config.flag}"],
        "extensionToLanguage": {".vue": "vue", ".ts": "typescript"}, "diagnostics": false
    }}});
    let env = project_files.iter().fold(
        MemoryEnvironment::new(facts)
            .with_file(
                &official.join(".zcode-plugin/plugin.json").to_string_lossy(),
                TYPESCRIPT,
            )
            .with_file(
                &format!("{KIT}/.zcode-plugin/plugin.json"),
                &kit.to_string(),
            ),
        |env, (path, value)| env.with_file(path, &value.to_string()),
    );
    let paths = StoragePaths::resolve(&Default::default(), home.path(), home.path());
    let preferences = paths.lsp_preferences(None, home.path());
    let process_env: EnvSnapshot = vars(&[("PATH", &bin.to_string_lossy())])
        .into_iter()
        .collect();
    let host = Host::new(HostInputs {
        files: Arc::new(env),
        environment: EnvironmentId::new("local"),
        paths,
        process_env,
        view_host: true,
        preferences: preferences.as_path().to_path_buf(),
    });
    Fixture {
        _home: home,
        host,
        bin,
    }
}

fn workspace(path: &str) -> LspWorkspace {
    LspWorkspace {
        path: path.to_owned(),
        identity: None,
    }
}

fn install(bin: &Path, name: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = bin.join(name);
    std::fs::write(&path, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn status_lists_the_official_typescript_server() {
    let fixture = fixture(&[]).await;
    let status = fixture
        .host
        .status(&workspace("/Users/dev/a"))
        .await
        .unwrap();
    assert!(status.enabled);
    assert_eq!(status.servers.len(), 1);
    let typescript = &status.servers[0];
    assert_eq!(
        (
            typescript.server_id.as_str(),
            typescript.plugin_id.as_str(),
            typescript.server_name.as_str(),
            typescript.command.as_str(),
            typescript.installed,
            typescript.state,
            typescript.diagnostics_mode,
            typescript.diagnostics_after_edit,
            typescript.restarts,
        ),
        (
            "typescript-lsp@zcode-plugins-official/typescript",
            "typescript-lsp@zcode-plugins-official",
            "typescript",
            "typescript-language-server",
            false,
            "not_installed",
            "unknown",
            true,
            0
        )
    );
    assert_eq!(
        typescript.extensions,
        [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]
    );
    install(&fixture.bin, "typescript-language-server");
    let status = fixture
        .host
        .status(&workspace("/Users/dev/a"))
        .await
        .unwrap();
    assert_eq!(
        (status.servers[0].installed, status.servers[0].state),
        (true, "stopped")
    );
    // The preference override wins over the manifest default.
    fixture
        .host
        .set_preferences(patch(
            Some(false),
            &[(
                "typescript-lsp@zcode-plugins-official/typescript",
                Some(false),
            )],
        ))
        .await
        .unwrap();
    let status = fixture
        .host
        .status(&workspace("/Users/dev/a"))
        .await
        .unwrap();
    assert!(!status.enabled);
    assert!(!status.servers[0].diagnostics_after_edit);
}

#[cfg(unix)]
#[tokio::test]
async fn each_workspace_resolves_its_own_plugins() {
    let fixture = fixture(&[
        (
            "/Users/dev/a/zcode.json",
            json!({"plugins": {"enabledPlugins": {"typescript-lsp@zcode-plugins-official": false}}}),
        ),
        ("/Users/dev/b/zcode.json", json!({"plugins": {"dirs": [KIT]}})),
    ])
    .await;
    // Workspace a disables the official plugin; the same process still lists it for workspace c.
    let a = fixture
        .host
        .status(&workspace("/Users/dev/a"))
        .await
        .unwrap();
    assert!(a.servers.is_empty());
    let c = fixture
        .host
        .status(&workspace("/Users/dev/c"))
        .await
        .unwrap();
    assert_eq!(c.servers.len(), 1);
    // Workspace b adds a config-dir plugin: it loads first, so it keeps `.ts` and typescript keeps the rest.
    let b = fixture
        .host
        .status(&workspace("/Users/dev/b"))
        .await
        .unwrap();
    let summary: Vec<(&str, Vec<&str>, bool)> = b
        .servers
        .iter()
        .map(|server| {
            (
                server.server_id.as_str(),
                server.extensions.iter().map(String::as_str).collect(),
                server.diagnostics_after_edit,
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("kit@inline/vue", vec![".vue", ".ts"], false),
            (
                "typescript-lsp@zcode-plugins-official/typescript",
                vec![".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
                true
            ),
        ]
    );
}

/// Node `resolve(workingDirectory)`: the requested path is normalized before config discovery and templates.
#[cfg(unix)]
#[tokio::test]
async fn the_workspace_path_is_normalized_and_options_reach_the_templates() {
    let fixture = fixture(&[(
        "/Users/dev/b/zcode.json",
        json!({"plugins": {"dirs": [KIT]}}),
    )])
    .await;
    for path in ["/Users/dev/b", "/Users/dev/b/", "/Users/dev/./b/../b//"] {
        let servers = fixture.host.servers(path).await;
        let kit = servers
            .iter()
            .find(|server| server.id == "kit@inline/vue")
            .unwrap_or_else(|| panic!("{path}: {servers:?}"));
        assert_eq!(kit.command, "/Users/dev/b/bin/vue-ls", "{path}");
        assert_eq!(kit.args, ["--fast"], "{path}");
    }
}

/// Node's store runs `load` on the update queue: a read sent after a write sees it.
#[tokio::test]
async fn a_read_after_a_write_sees_it() {
    let (_dir, _path, store) = store();
    let store = Arc::new(store);
    let writer = {
        let store = store.clone();
        tokio::spawn(async move { store.update(&patch(Some(false), &[])).await })
    };
    tokio::task::yield_now().await;
    let read = store.load().await;
    writer.await.unwrap().unwrap();
    assert!(!read.enabled);
}
