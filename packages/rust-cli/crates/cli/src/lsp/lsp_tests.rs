//! Fork: the app-server language-server host (specs/fork-rust-lsp.md, acceptance 1–6).
#![allow(
    clippy::disallowed_methods,
    reason = "tests prepare a temporary HOME, plugin cache and PATH"
)]

use std::path::Path;

use rust_cli_kernel_api::env::EnvFacts;
use rust_cli_kernel_api::testing::MemoryEnvironment;
use serde_json::json;

use super::installed::candidates;
use super::preferences::{apply, parse, text};
use super::runtime::pool::tests::{FakeProcess, fake_launcher};
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
    launched: tokio::sync::mpsc::UnboundedReceiver<FakeProcess>,
}

const KIT: &str = "/Users/dev/kit";

async fn fixture(project_files: &[(&str, serde_json::Value)]) -> Fixture {
    fixture_with(project_files, None).await
}

async fn fixture_with(
    project_files: &[(&str, serde_json::Value)],
    store: Option<Arc<dyn StoreQueries>>,
) -> Fixture {
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
    let (launcher, launched) = fake_launcher();
    let host = Host::new(HostInputs {
        files: Arc::new(env),
        environment: EnvironmentId::new("local"),
        paths,
        process_env,
        view_host: true,
        preferences: preferences.as_path().to_path_buf(),
        launcher,
        store,
    });
    Fixture {
        _home: home,
        host,
        bin,
        launched,
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

/// The snapshot is published inside the store's turn: a read that started before a write can never publish its older
/// value after the write published its own.
#[tokio::test]
async fn a_read_publishes_its_snapshot_before_a_write_can_run() {
    let (_dir, _path, store) = store();
    let mut published = None;
    let read = store
        .load_and(|prefs| {
            // A write waits for the turn this read still holds.
            assert!(store.turn_held());
            published = Some(prefs.clone());
        })
        .await;
    assert!(!store.turn_held());
    assert_eq!(published, Some(read));
    let mut written = None;
    let next = store
        .update_and(&patch(Some(false), &[]), |prefs| {
            assert!(store.turn_held());
            written = Some(prefs.clone());
        })
        .await
        .unwrap();
    assert_eq!(written, Some(next));
}

fn reference(path: &str) -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(path),
    }
}

async fn state_of(host: &Host, workspace: &LspWorkspace) -> (&'static str, &'static str) {
    let status = host.status(workspace).await.unwrap();
    (status.servers[0].state, status.servers[0].diagnostics_mode)
}

/// Acceptance 4–6 through the host: status overlays the pool entry of the same key, an edit's pull diagnostics reach
/// the next request, and turning code intelligence off stops the server.
#[cfg(unix)]
#[tokio::test]
async fn the_host_runs_a_server_for_a_session_and_stops_it_when_disabled() {
    let mut fixture = fixture(&[]).await;
    install(&fixture.bin, "typescript-language-server");
    let session = SessionId::new("s1");
    let root = reference("/Users/dev/a");
    let here = workspace("/Users/dev/a");
    let elsewhere = LspWorkspace {
        path: "/Users/dev/a".to_owned(),
        identity: Some("remote:other".to_owned()),
    };
    // Nothing mutated: no runtime is even created.
    assert_eq!(fixture.host.edit_diagnostics(&session).await, None);
    fixture
        .host
        .prewarm(&session, &root, "/Users/dev/a/x.ts")
        .await;
    let mut process = fixture.launched.recv().await.unwrap();
    assert_eq!(process.launch.command, "typescript-language-server");
    assert_eq!(
        state_of(&fixture.host, &here).await,
        ("starting", "unknown")
    );
    assert_eq!(
        state_of(&fixture.host, &elsewhere).await,
        ("stopped", "unknown")
    );
    process.initialize(json!({"diagnosticProvider": {}})).await;
    for _ in 0..500 {
        if state_of(&fixture.host, &here).await.0 == "ready" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    assert_eq!(state_of(&fixture.host, &here).await, ("ready", "pull"));

    let mutation = FileMutation {
        path: "/Users/dev/a/x.ts".to_owned(),
        kind: rust_cli_kernel_api::lsp::FileMutationKind::Created,
        content: Some("let x: number = 'a'\n".to_owned()),
        changed_range: Some(rust_cli_kernel_api::lsp::ChangedRange {
            start_line: 1,
            end_line: 1,
        }),
    };
    fixture.host.file_mutated(&session, &root, mutation).await;
    let open = process.expect("textDocument/didOpen").await;
    assert_eq!(open["params"]["textDocument"]["languageId"], "typescript");
    let pull = process.expect("textDocument/diagnostic").await;
    process
        .reply(
            &pull,
            json!({"kind": "full", "items": [{
                "range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 5}},
                "severity": 1, "message": "Type 'string' is not assignable to type 'number'.", "code": 2322,
                "source": "ts",
            }]}),
        )
        .await;
    assert_eq!(
        fixture.host.edit_diagnostics(&session).await.as_deref(),
        Some(
            "Found 1 new diagnostic issues in 1 files\nx.ts:1:5 error Type 'string' is not assignable to type 'number'. [ts 2322]"
        )
    );
    assert_eq!(fixture.host.edit_diagnostics(&session).await, None);

    // Turning code intelligence off stops the server gracefully.
    let disable = fixture.host.set_preferences(patch(Some(false), &[]));
    let server = async {
        let shutdown = process.expect("shutdown").await;
        process.reply(&shutdown, serde_json::Value::Null).await;
        process.expect("exit").await;
        process.exit("exited (code 0, signal none)");
    };
    let (prefs, ()) = tokio::join!(disable, server);
    assert!(!prefs.unwrap().enabled);
    assert_eq!(state_of(&fixture.host, &here).await, ("stopped", "unknown"));
    // Disabled: a mutation is not tracked and starts nothing.
    fixture
        .host
        .file_mutated(
            &session,
            &root,
            FileMutation {
                path: "/Users/dev/a/y.ts".to_owned(),
                kind: rust_cli_kernel_api::lsp::FileMutationKind::Created,
                content: Some(String::new()),
                changed_range: None,
            },
        )
        .await;
    assert_eq!(fixture.host.edit_diagnostics(&session).await, None);
    assert!(fixture.launched.try_recv().is_err());
    fixture.host.session_closed(&session);
}

/// D2 "When the tool is offered": enabled and a declared server installed. Like Node (the runtime's construction and
/// `applyLspPreferences`), the fact is computed once per session and workspace and again by each preference write; a
/// later run only settles it.
#[cfg(unix)]
#[tokio::test]
async fn the_tool_is_offered_while_enabled_with_an_installed_server() {
    let fixture = fixture(&[]).await;
    let session = SessionId::new("s1");
    let root = reference("/Users/dev/a");
    assert!(!fixture.host.tool_offered(&session), "never computed");
    fixture.host.settle_tool(&session, &root).await;
    assert!(!fixture.host.tool_offered(&session), "nothing installed");

    install(&fixture.bin, "typescript-language-server");
    fixture.host.settle_tool(&session, &root).await;
    assert!(
        !fixture.host.tool_offered(&session),
        "a run does not probe the install again"
    );

    fixture
        .host
        .set_preferences(patch(Some(false), &[]))
        .await
        .unwrap();
    assert!(!fixture.host.tool_offered(&session), "hidden at once");
    fixture
        .host
        .set_preferences(patch(Some(true), &[]))
        .await
        .unwrap();
    assert!(
        fixture.host.tool_offered(&session),
        "the write recomputed it"
    );

    fixture.host.session_closed(&session);
    assert!(
        !fixture.host.tool_offered(&session),
        "dropped with the session"
    );
}

/// A server uninstalled mid-session keeps the tool (Node computes availability only at construction and on a
/// preference write); its queries answer `lsp_server_not_installed`. A move to another workspace computes it anew.
#[cfg(unix)]
#[tokio::test]
async fn an_uninstall_mid_session_keeps_the_tool_and_queries_report_it() {
    let fixture = fixture(&[]).await;
    install(&fixture.bin, "typescript-language-server");
    let session = SessionId::new("s1");
    let root = reference("/Users/dev/a");
    fixture.host.settle_tool(&session, &root).await;
    assert!(fixture.host.tool_offered(&session));

    std::fs::remove_file(fixture.bin.join("typescript-language-server")).unwrap();
    fixture.host.settle_tool(&session, &root).await;
    assert!(fixture.host.tool_offered(&session), "still offered");
    let error = fixture
        .host
        .query(
            &session,
            &root,
            hover("/Users/dev/a/x.ts"),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "lsp_server_not_installed");

    fixture
        .host
        .settle_tool(&session, &reference("/Users/dev/b"))
        .await;
    assert!(
        !fixture.host.tool_offered(&session),
        "another workspace is computed anew"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_workspace_without_declared_servers_is_not_offered_and_has_no_server_for_a_file() {
    let fixture = fixture(&[(
        "/Users/dev/a/zcode.json",
        json!({"plugins": {"enabledPlugins": {"typescript-lsp@zcode-plugins-official": false}}}),
    )])
    .await;
    install(&fixture.bin, "typescript-language-server");
    let session = SessionId::new("s1");
    let root = reference("/Users/dev/a");
    fixture.host.settle_tool(&session, &root).await;
    assert!(!fixture.host.tool_offered(&session));
    let error = fixture
        .host
        .query(
            &session,
            &root,
            rust_cli_kernel_api::lsp::LspQuery {
                operation: rust_cli_kernel_api::lsp::LspOperation::Hover,
                file_path: "/Users/dev/a/x.ts".to_owned(),
                line: Some(1.0),
                character: Some(1.0),
                symbol: None,
                query: None,
                include_declaration: None,
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (error.code.as_str(), error.message.as_str()),
        (
            "lsp_no_server_for_file",
            "No language server is configured for hover on this file type"
        )
    );
}

/// A store whose every session is listed under one workspace key (Node `workspaceID ?? directory`).
struct KeyStore(&'static str);

#[async_trait::async_trait]
impl StoreQueries for KeyStore {
    async fn metering(
        &self,
        _session: &SessionId,
    ) -> Result<
        rust_cli_kernel_api::metering::SessionMetering,
        rust_cli_kernel_api::store::StoreError,
    > {
        unreachable!()
    }

    async fn request_stats(
        &self,
        _session: &SessionId,
    ) -> Result<rust_cli_kernel_api::metering::RequestStats, rust_cli_kernel_api::store::StoreError>
    {
        unreachable!()
    }

    async fn activity(
        &self,
        _query: rust_cli_kernel_api::metering::ActivityQuery,
    ) -> Result<rust_cli_kernel_api::metering::ActivityStats, rust_cli_kernel_api::store::StoreError>
    {
        unreachable!()
    }

    async fn put_record(
        &self,
        _session: &SessionId,
        _record: &rust_cli_kernel_api::store::FrontendRecord,
    ) -> Result<(), rust_cli_kernel_api::store::StoreError> {
        unreachable!()
    }

    async fn records(
        &self,
        _session: &SessionId,
        _kind: &str,
    ) -> Result<
        Vec<rust_cli_kernel_api::store::FrontendRecord>,
        rust_cli_kernel_api::store::StoreError,
    > {
        unreachable!()
    }

    async fn session_workspace_key(
        &self,
        _session: &SessionId,
    ) -> Result<Option<String>, rust_cli_kernel_api::store::StoreError> {
        Ok(Some(self.0.to_owned()))
    }
}

fn hover(file_path: &str) -> rust_cli_kernel_api::lsp::LspQuery {
    rust_cli_kernel_api::lsp::LspQuery {
        operation: rust_cli_kernel_api::lsp::LspOperation::Hover,
        file_path: file_path.to_owned(),
        line: Some(1.0),
        character: Some(1.0),
        symbol: None,
        query: None,
        include_declaration: None,
    }
}

/// Node `create-app.ts` passes no servers for a remote workspace identity, so its runtime has no `LspService`: the
/// tool is not offered and a query finds no server, even with one installed on this machine.
#[cfg(unix)]
#[tokio::test]
async fn a_remote_workspace_identity_has_no_language_servers() {
    for identity in [
        "remote:ssh:host:22:dev:/Users/dev/a",
        "remote:server:srv-1:/Users/dev/a",
    ] {
        let fixture = fixture_with(&[], Some(Arc::new(KeyStore(identity)))).await;
        install(&fixture.bin, "typescript-language-server");
        let session = SessionId::new("s1");
        let root = reference("/Users/dev/a");
        fixture.host.settle_tool(&session, &root).await;
        assert!(!fixture.host.tool_offered(&session), "{identity}");
        let error = fixture
            .host
            .query(
                &session,
                &root,
                hover("/Users/dev/a/x.ts"),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "lsp_no_server_for_file", "{identity}");
    }
}

/// A local identity (here a malformed remote one, which Node's parser rejects) keeps the servers.
#[cfg(unix)]
#[tokio::test]
async fn a_local_workspace_identity_keeps_its_language_servers() {
    let fixture = fixture_with(&[], Some(Arc::new(KeyStore("remote:ssh:host:22:dev:rel")))).await;
    install(&fixture.bin, "typescript-language-server");
    let session = SessionId::new("s1");
    fixture
        .host
        .settle_tool(&session, &reference("/Users/dev/a"))
        .await;
    assert!(fixture.host.tool_offered(&session));
}

/// The host serves its own machine only: a workspace in another environment gets no runtime.
#[cfg(unix)]
#[tokio::test]
async fn a_workspace_in_another_environment_has_no_language_servers() {
    let fixture = fixture(&[]).await;
    install(&fixture.bin, "typescript-language-server");
    let session = SessionId::new("s1");
    let root = WorkspaceRef {
        environment: EnvironmentId::new("ssh:host"),
        root: EnvPath::new("/Users/dev/a"),
    };
    fixture.host.settle_tool(&session, &root).await;
    assert!(!fixture.host.tool_offered(&session));
    let error = fixture
        .host
        .query(
            &session,
            &root,
            hover("/Users/dev/a/x.ts"),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "lsp_no_server_for_file");
}
