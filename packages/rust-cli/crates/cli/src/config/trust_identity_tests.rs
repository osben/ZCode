//! The managed worktree trust identity (specs/fork-rust-managed-worktree-trust-identity.md) on a hand-built layout:
//! the Host's `<data>/.zcode/worktrees/<bucket>/<name>` checkout of `<tmp>/src/repo`, with git's admin files.
#![allow(
    clippy::disallowed_methods,
    reason = "the tests build the worktree layout in a temp dir"
)]

use std::fs;
use std::path::{Path, PathBuf};

use rust_cli_paths::StoragePaths;

use super::*;

struct Layout {
    _tmp: tempfile::TempDir,
    paths: StoragePaths,
    source: PathBuf,
    worktree: PathBuf,
    admin: PathBuf,
}

impl Layout {
    fn new() -> Self {
        Self::with_bucket("ab12")
    }

    fn with_bucket(bucket: &str) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        // macOS temp dirs live under a symlink (`/var` -> `/private/var`); Node compares real paths.
        let base = fs::canonicalize(tmp.path()).unwrap();
        let data = base.join("data");
        let source = base.join("src/repo");
        let admin = source.join(".git/worktrees/repo");
        let worktree = data.join(".zcode/worktrees").join(bucket).join("repo");
        fs::create_dir_all(&admin).unwrap();
        fs::create_dir_all(worktree.join("pkg")).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", admin.display()),
        )
        .unwrap();
        fs::write(
            admin.join("gitdir"),
            format!("{}\n", worktree.join(".git").display()),
        )
        .unwrap();
        fs::write(admin.join("commondir"), "../..\n").unwrap();
        let paths =
            StoragePaths::resolve(&Default::default(), &base, &base).with_data_base_dir(&data);
        Self {
            _tmp: tmp,
            paths,
            source,
            worktree,
            admin,
        }
    }

    async fn resolve(&self, root: &Path) -> String {
        resolve(&self.paths, &root.to_string_lossy(), true).await
    }

    fn unchanged(&self, root: &Path) -> String {
        root.to_string_lossy().into_owned()
    }
}

#[tokio::test]
async fn a_managed_worktree_and_its_subdirectory_map_to_the_source() {
    let layout = Layout::new();

    assert_eq!(
        layout.resolve(&layout.worktree).await,
        layout.source.to_string_lossy()
    );
    assert_eq!(
        layout.resolve(&layout.worktree.join("pkg")).await,
        layout.source.join("pkg").to_string_lossy()
    );
}

#[tokio::test]
async fn relative_git_pointers_and_crlf_map_too() {
    let layout = Layout::new();
    fs::write(
        layout.worktree.join(".git"),
        "gitdir: ../../../../../src/repo/.git/worktrees/repo\r\n",
    )
    .unwrap();
    fs::write(
        layout.admin.join("gitdir"),
        "../../../../../data/.zcode/worktrees/ab12/repo/.git\r\n",
    )
    .unwrap();

    assert_eq!(
        layout.resolve(&layout.worktree).await,
        layout.source.to_string_lossy()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlinked_managed_root_maps() {
    let layout = Layout::new();
    let data = layout
        .paths
        .managed_worktrees()
        .as_path()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let link = data.parent().unwrap().join("data-link");
    std::os::unix::fs::symlink(&data, &link).unwrap();
    let paths = StoragePaths::resolve(&Default::default(), &link, &link).with_data_base_dir(&link);
    let via_link = link.join(".zcode/worktrees/ab12/repo");

    assert_eq!(
        resolve(&paths, &via_link.to_string_lossy(), true).await,
        layout.source.to_string_lossy()
    );
}

#[tokio::test]
async fn a_remote_workspace_or_a_path_outside_the_managed_root_is_unchanged() {
    let layout = Layout::new();
    let root = layout.worktree.to_string_lossy().into_owned();

    assert_eq!(resolve(&layout.paths, &root, false).await, root);
    assert_eq!(
        layout.resolve(&layout.source).await,
        layout.unchanged(&layout.source)
    );
    let gone = layout.worktree.parent().unwrap().join("missing");
    assert_eq!(layout.resolve(&gone).await, layout.unchanged(&gone));
}

#[tokio::test]
async fn a_bucket_that_is_not_four_lowercase_hex_is_unchanged() {
    for bucket in ["AB12", "ab1", "ab123", "zz12"] {
        let layout = Layout::with_bucket(bucket);

        assert_eq!(
            layout.resolve(&layout.worktree).await,
            layout.unchanged(&layout.worktree),
            "{bucket}"
        );
    }
}

#[tokio::test]
async fn each_failed_git_check_keeps_the_worktree_path() {
    type Break = fn(&Layout);
    let cases: [(&str, Break); 7] = [
        ("`.git` is a directory", |l| {
            fs::remove_file(l.worktree.join(".git")).unwrap();
            fs::create_dir(l.worktree.join(".git")).unwrap();
        }),
        ("no `gitdir:` prefix", |l| {
            fs::write(l.worktree.join(".git"), format!("{}\n", l.admin.display())).unwrap();
        }),
        ("the admin dir's parent is not `worktrees`", |l| {
            let other = l.source.join(".git/elsewhere/repo");
            fs::create_dir_all(&other).unwrap();
            fs::copy(l.admin.join("gitdir"), other.join("gitdir")).unwrap();
            fs::write(other.join("commondir"), "../..\n").unwrap();
            fs::write(
                l.worktree.join(".git"),
                format!("gitdir: {}\n", other.display()),
            )
            .unwrap();
        }),
        ("the backlink names another checkout", |l| {
            let other = l.worktree.parent().unwrap().join("other");
            fs::create_dir_all(&other).unwrap();
            fs::write(other.join(".git"), "gitdir: x\n").unwrap();
            fs::write(
                l.admin.join("gitdir"),
                format!("{}\n", other.join(".git").display()),
            )
            .unwrap();
        }),
        ("`commondir` names another dir", |l| {
            fs::write(l.admin.join("commondir"), "..\n").unwrap();
        }),
        ("no `commondir`", |l| {
            fs::remove_file(l.admin.join("commondir")).unwrap();
        }),
        ("the common dir is not `<source>/.git` (bare)", |l| {
            // `<tmp>/bare.git/worktrees/repo`: the common dir's parent has no `.git` directory.
            let bare = l.source.parent().unwrap().join("bare.git");
            let admin = bare.join("worktrees/repo");
            fs::create_dir_all(&admin).unwrap();
            fs::copy(l.admin.join("gitdir"), admin.join("gitdir")).unwrap();
            fs::write(admin.join("commondir"), "../..\n").unwrap();
            fs::write(
                l.worktree.join(".git"),
                format!("gitdir: {}\n", admin.display()),
            )
            .unwrap();
        }),
    ];
    for (name, break_it) in cases {
        let layout = Layout::new();
        break_it(&layout);

        assert_eq!(
            layout.resolve(&layout.worktree).await,
            layout.unchanged(&layout.worktree),
            "{name}"
        );
    }
}

/// Hook trust (rule 6): a hook trusted in the source is admitted in the worktree, and the worktree's own key (used by
/// the App review's and `zcode hooks trust`'s grants) is the source path.
#[tokio::test]
async fn a_hook_trusted_in_the_source_is_admitted_in_the_worktree() {
    use rust_cli_platform::local::{ConfigFile, TrustRecord};
    use serde_json::{Map, json};

    use super::super::files::{ProjectFile, project_file};
    use super::super::trust::WorkspaceHooks;

    let layout = Layout::new();
    let hooks = json!({"enabled": true, "events": {
        "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "check.sh"}]}]
    }});
    let files = |root: &Path| -> Vec<ProjectFile> {
        let mut object = Map::new();
        object.insert("hooks".into(), hooks.clone());
        let root = root.to_string_lossy().into_owned();
        vec![project_file(
            &root,
            format!("{root}/zcode.json"),
            0,
            ConfigFile::Loaded(object),
        )]
    };
    let inspect = |root: PathBuf| {
        let files = files(&root);
        let paths = layout.paths.clone();
        async move {
            let root = root.to_string_lossy().into_owned();
            WorkspaceHooks::inspect(
                &root,
                None,
                &files,
                &paths,
                super::super::hook_scripts::Scripts::Local,
                &mut Vec::new(),
            )
            .await
        }
    };

    let source = inspect(layout.source.clone()).await;
    let worktree = inspect(layout.worktree.clone()).await;
    assert_eq!(worktree.identity, source.identity);
    assert_eq!(worktree.entries()[0].digest, source.entries()[0].digest);
    assert!(worktree.admitted().is_empty());

    source
        .store
        .grant(vec![TrustRecord {
            workspace_identity: source.identity.clone(),
            hook_declaration_digest: source.entries()[0].digest.clone(),
            granted_at: "2026-11-27T08:00:00.000Z".to_owned(),
            last_used_at: None,
            bundle_digest_at_grant: None,
            event_at_grant: "PreToolUse".to_owned(),
            display_command_at_grant: "check.sh".to_owned(),
            source_path_at_grant: "zcode.json".to_owned(),
            source_discovery_order_at_grant: None,
            matcher_at_grant: None,
            matcher_index_at_grant: None,
            hook_index_at_grant: None,
            app_version_at_grant: None,
        }])
        .await
        .unwrap();

    assert_eq!(inspect(layout.worktree.clone()).await.admitted().len(), 1);
    // A remote workspace never reads the local source's records.
    let root = layout.worktree.to_string_lossy().into_owned();
    let workspace = rust_cli_kernel_api::env::WorkspaceRef {
        environment: rust_cli_kernel_api::ids::EnvironmentId::new("ssh-box"),
        root: rust_cli_kernel_api::env::EnvPath::new(root.clone()),
    };
    let remote = WorkspaceHooks::inspect(
        &root,
        None,
        &files(&layout.worktree),
        &layout.paths,
        super::super::hook_scripts::Scripts::Port {
            files: &NoFiles,
            workspace: &workspace,
        },
        &mut Vec::new(),
    )
    .await;
    assert!(remote.admitted().is_empty());
}

/// Plugin trust (rule 5): a plugin trusted under the source path loads in the worktree's process assembly, with the
/// worktree's own plugin dir.
#[tokio::test]
async fn a_plugin_trusted_in_the_source_loads_in_the_worktree() {
    use std::sync::Arc;

    use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
    use rust_cli_kernel_api::ids::EnvironmentId;
    use rust_cli_kernel_api::machine::Files as FilesPort;
    use serde_json::json;

    let layout = Layout::new();
    for root in [&layout.source, &layout.worktree] {
        let plugin = root.join("plugins/demo/.zcode-plugin");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("plugin.json"), r#"{"name": "demo"}"#).unwrap();
        fs::create_dir_all(root.join(".zcode")).unwrap();
        fs::write(
            root.join(".zcode/config.json"),
            r#"{"plugins": {"dirs": ["plugins/demo"]}}"#,
        )
        .unwrap();
    }
    let digest = super::super::workspace_plugins::inspect(
        &layout.source,
        &layout.source.join("plugins/demo"),
    )
    .await
    .unwrap()
    .declaration_digest;
    let hook_store = layout.paths.hook_trust_store(None);
    let store = hook_store
        .as_path()
        .parent()
        .unwrap()
        .join("workspace-plugin-trust-v1.json");
    fs::create_dir_all(store.parent().unwrap()).unwrap();
    fs::write(
        &store,
        json!({"schemaVersion": 1, "records": [{
            "workspaceIdentity": layout.source.to_string_lossy(),
            "pluginRoot": "plugins/demo",
            "declarationDigest": digest,
            "grantedAt": "2026-11-27T08:00:00.000Z",
        }]})
        .to_string(),
    )
    .unwrap();

    let files: Arc<dyn FilesPort> = Arc::new(rust_cli_env_local::LocalEnvironment::new(None));
    let root = layout.worktree.to_string_lossy().into_owned();
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new(rust_cli_node_store::LOCAL_ENVIRONMENT),
        root: EnvPath::new(root.clone()),
    };
    let assembled = crate::config::assemble(&crate::config::ConfigInputs {
        files: files.as_ref(),
        workspace: &workspace,
        paths: &layout.paths,
        process_env: &Default::default(),
        flag: None,
        project_is_local: true,
    })
    .await;
    let dirs: Vec<String> = assembled
        .plugins
        .candidates
        .iter()
        .filter(|candidate| candidate.origin == rust_cli_ext::plugins::PluginOrigin::ConfigDir)
        .map(|candidate| candidate.dir.as_str().to_owned())
        .collect();

    assert_eq!(
        dirs,
        vec![
            layout
                .worktree
                .join("plugins/demo")
                .to_string_lossy()
                .into_owned()
        ]
    );
}

/// A remote environment's files that are never read: the declarations above name no entry script.
struct NoFiles;

#[async_trait::async_trait]
impl rust_cli_kernel_api::machine::Files for NoFiles {
    async fn read_file(
        &self,
        _workspace: &rust_cli_kernel_api::env::WorkspaceRef,
        _request: rust_cli_kernel_api::env::ReadFile,
    ) -> Result<rust_cli_kernel_api::env::FileContent, rust_cli_kernel_api::env::EnvError> {
        unreachable!("no entry script is read")
    }

    async fn write_file(
        &self,
        _workspace: &rust_cli_kernel_api::env::WorkspaceRef,
        _context: rust_cli_kernel_api::env::OperationContext,
        _request: rust_cli_kernel_api::env::WriteFile,
    ) -> Result<rust_cli_kernel_api::env::WriteReceipt, rust_cli_kernel_api::env::EnvError> {
        unreachable!("nothing is written")
    }
}
