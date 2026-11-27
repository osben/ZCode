//! Workspace plugin trust (specs/fork-rust-plugin-workspace-trust.md, part 2): Node's declaration digest byte for
//! byte, the record store, and which project roots load.
#![allow(
    clippy::disallowed_methods,
    reason = "the tests write plugin fixtures and the trust store to temp dirs"
)]

use std::path::Path;

use rust_cli_paths::StoragePaths;
use rust_cli_platform::local::ConfigFile;
use serde_json::{Value, json};

use super::*;
use crate::config::files::project_file;

const GOLDEN: &str = include_str!("fixtures/workspace_plugin_digest_golden.json");

fn write(root: &Path, files: &serde_json::Map<String, Value>) {
    for (path, text) in files {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text.as_str().unwrap()).unwrap();
    }
}

#[tokio::test]
async fn the_digest_matches_nodes_golden_for_every_fixture() {
    let cases: Vec<Value> = serde_json::from_str(GOLDEN).unwrap();
    assert_eq!(cases.len(), 6);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let root = normalize(&workspace.path().join(case["root"].as_str().unwrap()));
        write(&root, case["files"].as_object().unwrap());

        let inspected = inspect(workspace.path(), &root)
            .await
            .unwrap_or_else(|| panic!("{name}: no manifest"));

        assert_eq!(inspected.plugin_root, case["pluginRoot"], "{name}");
        assert_eq!(
            inspected.declaration_digest, case["declarationDigest"],
            "{name}"
        );
    }
}

#[tokio::test]
async fn an_invalid_first_manifest_makes_the_plugin_unavailable() {
    let workspace = tempfile::tempdir().unwrap();
    let root = workspace.path().join("p");
    write(
        &root,
        json!({
            ".zcode-plugin/plugin.json": "{\"name\": \"Bad Name\"}",
            ".claude-plugin/plugin.json": "{\"name\": \"good\"}",
        })
        .as_object()
        .unwrap(),
    );

    assert_eq!(inspect(workspace.path(), &root).await, None);
}

struct Fixture {
    _home: tempfile::TempDir,
    workspace: tempfile::TempDir,
    paths: StoragePaths,
}

impl Fixture {
    /// A workspace with one plugin at `plugins/demo`, declared by `.zcode/config.json`.
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        write(
            &workspace.path().join("plugins/demo"),
            json!({".zcode-plugin/plugin.json": "{\"name\": \"demo\"}"})
                .as_object()
                .unwrap(),
        );
        let paths = StoragePaths::resolve(&Default::default(), home.path(), home.path());
        Self {
            _home: home,
            workspace,
            paths,
        }
    }

    fn root(&self) -> &Path {
        self.workspace.path()
    }

    fn projects(&self, dirs: Value) -> Vec<ProjectFile> {
        let root = self.root().to_string_lossy().into_owned();
        let path = self.root().join(".zcode/config.json");
        let object = json!({"plugins": {"dirs": dirs}});
        vec![project_file(
            &root,
            path.to_string_lossy().into_owned(),
            0,
            ConfigFile::Loaded(object.as_object().unwrap().clone()),
        )]
    }

    fn store(&self, text: &str) {
        let hook = self.paths.hook_trust_store(None);
        let file = hook.as_path().parent().unwrap().join(STORE_NAME);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }

    async fn digest(&self) -> String {
        inspect(self.root(), &self.root().join("plugins/demo"))
            .await
            .unwrap()
            .declaration_digest
    }

    fn identity(&self) -> String {
        self.root().to_string_lossy().into_owned()
    }

    fn record(&self, identity: &str, plugin_root: &str, digest: &str) -> String {
        json!({"schemaVersion": 1, "records": [{
            "workspaceIdentity": identity,
            "pluginRoot": plugin_root,
            "declarationDigest": digest,
            "grantedAt": "2026-11-26T10:00:00.000Z",
        }]})
        .to_string()
    }

    async fn trusted(&self, dirs: Value, user_roots: &[PathBuf]) -> Vec<PathBuf> {
        let grants = grants(&self.paths, None, &self.identity()).await;
        trusted_roots(self.root(), &self.projects(dirs), user_roots, &grants).await
    }
}

#[tokio::test]
async fn a_root_with_a_matching_record_loads() {
    let fixture = Fixture::new();
    let digest = fixture.digest().await;
    fixture.store(&fixture.record(&fixture.identity(), "plugins/demo", &digest));

    let trusted = fixture.trusted(json!(["plugins/demo"]), &[]).await;

    assert_eq!(trusted, vec![fixture.root().join("plugins/demo")]);
}

#[tokio::test]
async fn a_root_without_a_matching_record_stays_out() {
    let fixture = Fixture::new();
    let digest = fixture.digest().await;
    let stale = "0".repeat(64);
    for store in [
        None,
        Some(fixture.record(&fixture.identity(), "plugins/demo", &stale)),
        Some(fixture.record("/elsewhere", "plugins/demo", &digest)),
        Some(fixture.record(&fixture.identity(), "plugins/other", &digest)),
        Some("{not json".to_owned()),
        // Strict schema: an unknown key invalidates the whole store.
        Some(
            json!({"schemaVersion": 1, "extra": true, "records": [{
                "workspaceIdentity": fixture.identity(), "pluginRoot": "plugins/demo",
                "declarationDigest": digest, "grantedAt": "2026-11-26T10:00:00.000Z"}]})
            .to_string(),
        ),
    ] {
        if let Some(text) = &store {
            fixture.store(text);
        }

        let trusted = fixture.trusted(json!(["plugins/demo"]), &[]).await;

        assert!(trusted.is_empty(), "store {store:?} must not trust");
    }
}

#[tokio::test]
async fn a_changed_declaration_goes_back_to_pending() {
    let fixture = Fixture::new();
    let digest = fixture.digest().await;
    fixture.store(&fixture.record(&fixture.identity(), "plugins/demo", &digest));
    std::fs::write(fixture.root().join("plugins/demo/.mcp.json"), "{}").unwrap();

    assert!(
        fixture
            .trusted(json!(["plugins/demo"]), &[])
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn a_root_the_user_already_lists_is_not_added_again() {
    let fixture = Fixture::new();
    let digest = fixture.digest().await;
    fixture.store(&fixture.record(&fixture.identity(), "plugins/demo", &digest));
    let user = vec![fixture.root().join("plugins/demo")];

    assert!(
        fixture
            .trusted(json!(["./plugins/demo"]), &user)
            .await
            .is_empty()
    );
}

#[test]
fn project_roots_resolve_against_each_files_base_dir() {
    let root = "/w/repo";
    let file = |path: &str, dirs: Value| {
        project_file(
            root,
            path.to_owned(),
            0,
            ConfigFile::Loaded(
                json!({"plugins": {"dirs": dirs}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
    };
    let projects = vec![
        file("/w/.zcode/config.json", json!(["a", "/abs/b", "a"])),
        file("/w/repo/zcode.json", json!(["../c", 3, "a"])),
    ];

    assert_eq!(
        project_roots(&projects),
        vec![
            PathBuf::from("/w/a"),
            PathBuf::from("/abs/b"),
            PathBuf::from("/w/c"),
            PathBuf::from("/w/repo/a"),
        ]
    );
}

/// Both config paths (specs part 2, rule 10): the workspace layer re-read at a session open and the process assembly
/// list a trusted project dir right after the user dirs, and neither lists it before the trust record exists.
#[tokio::test]
async fn the_workspace_layer_and_the_process_assembly_load_a_trusted_project_dir() {
    use rust_cli_ext::WorkspaceConfigLoader as _;
    use rust_cli_kernel_api::env::{EnvFacts, EnvPath, WorkspaceRef};
    use rust_cli_kernel_api::ids::EnvironmentId;
    use rust_cli_kernel_api::machine::Files as FilesPort;
    use rust_cli_kernel_api::testing::MemoryEnvironment;
    use std::sync::Arc;

    let fixture = Fixture::new();
    let root = fixture.identity();
    let user_dir = fixture.root().join("user-plugin");
    let facts = EnvFacts {
        cwd: EnvPath::new(root.clone()),
        platform: "linux".to_owned(),
        os_version: "Linux".to_owned(),
        shell: "bash".to_owned(),
        is_git_repo: true,
        home: Some(EnvPath::new("/home/dev")),
        uid: None,
    };
    let user_config = json!({"plugins": {"dirs": [user_dir.to_string_lossy()]}}).to_string();
    let files: Arc<dyn FilesPort> = Arc::new(
        MemoryEnvironment::new(facts)
            .with_file(&format!("{root}/.git/HEAD"), "ref")
            .with_file(
                &format!("{root}/.zcode/config.json"),
                r#"{"plugins": {"dirs": ["plugins/demo"]}}"#,
            ),
    );
    // The user config is read from the controller's disk (`read_cli_config`), not through the Files port.
    let user_file = fixture.paths.cli_config().as_path().to_path_buf();
    std::fs::create_dir_all(user_file.parent().unwrap()).unwrap();
    std::fs::write(&user_file, &user_config).unwrap();
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(root.clone()),
    };
    let loader = crate::config::workspace_layer::Loader {
        files: files.clone(),
        controller: files.clone(),
        paths: fixture.paths.clone(),
        process_env: Default::default(),
        flag: None,
        project_is_local: true,
        process: Default::default(),
        strict: false,
    };
    let dirs = |sources: &rust_cli_ext::plugins::PluginSources| -> Vec<String> {
        sources
            .candidates
            .iter()
            .filter(|candidate| candidate.origin == rust_cli_ext::plugins::PluginOrigin::ConfigDir)
            .map(|candidate| candidate.dir.as_str().to_owned())
            .collect()
    };
    let assembled = || async {
        crate::config::assemble(&crate::config::ConfigInputs {
            files: files.as_ref(),
            workspace: &workspace,
            paths: &fixture.paths,
            process_env: &Default::default(),
            flag: None,
            project_is_local: true,
        })
        .await
    };
    let user_only = vec![user_dir.to_string_lossy().into_owned()];
    let both = vec![
        user_dir.to_string_lossy().into_owned(),
        fixture
            .root()
            .join("plugins/demo")
            .to_string_lossy()
            .into_owned(),
    ];

    let pending = loader.load(&workspace).await.unwrap();
    assert_eq!(
        dirs(&pending.plugins),
        user_only,
        "workspace layer before trust"
    );
    assert_eq!(
        dirs(&assembled().await.plugins),
        user_only,
        "assembly before trust"
    );

    let digest = fixture.digest().await;
    fixture.store(&fixture.record(&root, "plugins/demo", &digest));

    let trusted = loader.load(&workspace).await.unwrap();
    assert_eq!(dirs(&trusted.plugins), both, "workspace layer after trust");
    assert_eq!(
        dirs(&assembled().await.plugins),
        both,
        "assembly after trust"
    );
}
