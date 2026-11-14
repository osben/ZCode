//! Fork: a workspace's project hook entry against real config files and the shared trust store.
#![allow(
    clippy::disallowed_methods,
    reason = "the test prepares and corrupts the trust store in a temporary HOME"
)]

use rust_cli_hooks::HookSource;
use rust_cli_kernel_api::env::{EnvFacts, EnvPath};
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::testing::MemoryEnvironment;
use serde_json::{Value, json};

use super::*;
use crate::commands::hooks_trust::{self, TrustContext};
use crate::config::{ConfigInputs, assemble};

const ROOT: &str = "/Users/dev/repo";
const CONFIG: &str = "/Users/dev/repo/.zcode/config.json";
const ZCODE_JSON: &str = "/Users/dev/repo/zcode.json";

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
    files.iter().fold(
        MemoryEnvironment::new(facts).with_file("/Users/dev/repo/.git/HEAD", "ref"),
        |env, (path, value)| env.with_file(path, &value.to_string()),
    )
}

fn home() -> (tempfile::TempDir, StoragePaths) {
    let dir = tempfile::tempdir().unwrap();
    let paths = StoragePaths::resolve(&Default::default(), dir.path(), dir.path());
    (dir, paths)
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(ROOT),
    }
}

fn command(name: &str) -> Value {
    json!({"type": "command", "command": name})
}

/// Grants every declaration the strict discovery finds (`zcode hooks trust grant --all-current`).
async fn grant_all(env: &MemoryEnvironment, paths: &StoragePaths) {
    let context = TrustContext {
        files: env,
        paths,
        cwd: ROOT,
        version: "test",
        now_ms: 0,
    };
    let (hooks, _, _) = hooks_trust::inspect_review(&context, ROOT.to_owned(), None).await;
    let all: Vec<usize> = (0..hooks.entries().len()).collect();
    assert!(!all.is_empty());
    hooks
        .store
        .grant(hooks_trust::records(&hooks, &all, &context))
        .await
        .unwrap();
}

/// `(source, event, command)` of every admitted hook, in order.
fn admitted(entry: &ProjectEntry) -> Vec<(HookSource, &'static str, String)> {
    let ProjectEntry::Admitted(sources) = entry else {
        panic!("an admitted entry: {entry:?}");
    };
    sources
        .iter()
        .flat_map(|(source, settings)| {
            settings.hooks.iter().flat_map(move |(event, matchers)| {
                matchers.iter().flat_map(move |matcher| {
                    matcher
                        .hooks
                        .iter()
                        .map(move |hook| (*source, event.as_str(), hook.display()))
                })
            })
        })
        .collect()
}

#[tokio::test]
async fn the_entry_holds_the_trusted_and_enabled_project_declarations() {
    let (_home, paths) = home();
    let env = env(&[(
        CONFIG,
        json!({"hooks": {"enabled": true, "events": {
            "UserPromptSubmit": [{"hooks": [command("echo hi"), {"type": "command", "command": "off", "enabled": false}]}],
            "PreCompact": [{"hooks": [command("compact.sh")]}]
        }}}),
    )]);
    let before = entry(&env, &paths, &workspace(), None).await;
    assert!(admitted(&before).is_empty(), "nothing is trusted yet");
    grant_all(&env, &paths).await;
    let after = entry(&env, &paths, &workspace(), None).await;
    assert_eq!(
        admitted(&after),
        [
            (
                HookSource::Project,
                "UserPromptSubmit",
                "echo hi".to_owned()
            ),
            (HookSource::Project, "PreCompact", "compact.sh".to_owned()),
        ]
    );
}

#[tokio::test]
async fn a_file_node_cannot_load_adds_nothing_and_the_others_still_count() {
    let (_home, paths) = home();
    let env = env(&[
        (
            ZCODE_JSON,
            json!({"hooks": {"enabled": true, "extra": 1, "events": {"Stop": [{"hooks": [command("bad.sh")]}]}}}),
        ),
        (
            CONFIG,
            json!({"hooks": {"enabled": true, "events": {"Stop": [{"hooks": [command("good.sh")]}]}}}),
        ),
    ]);
    grant_all(&env, &paths).await;
    let entry = entry(&env, &paths, &workspace(), None).await;
    assert_eq!(
        admitted(&entry),
        [(HookSource::Project, "Stop", "good.sh".to_owned())]
    );
}

#[tokio::test]
async fn a_corrupt_trust_store_admits_nothing() {
    let (_home, paths) = home();
    let env = env(&[(
        CONFIG,
        json!({"hooks": {"enabled": true, "events": {"Stop": [{"hooks": [command("good.sh")]}]}}}),
    )]);
    grant_all(&env, &paths).await;
    assert_eq!(
        admitted(&entry(&env, &paths, &workspace(), None).await).len(),
        1
    );
    std::fs::write(paths.hook_trust_store(None).as_path(), "{").unwrap();
    assert!(admitted(&entry(&env, &paths, &workspace(), None).await).is_empty());
}

#[tokio::test]
async fn the_process_snapshot_keeps_the_project_hooks_apart() {
    let (_home, paths) = home();
    let env = env(&[(
        CONFIG,
        json!({"hooks": {"enabled": true, "events": {"Stop": [{"hooks": [command("good.sh")]}]}}}),
    )]);
    grant_all(&env, &paths).await;
    let inputs = ConfigInputs {
        files: &env,
        workspace: &workspace(),
        paths: &paths,
        process_env: &rust_cli_base::secret::EnvSnapshot::default(),
        flag: None,
        project_is_local: true,
    };
    let snapshot = assemble(&inputs).await;
    // The root's project hooks are its own entry; a session in another workspace never sees them.
    assert!(
        snapshot
            .hooks
            .sources
            .iter()
            .all(|(source, _)| *source == HookSource::User),
        "{:?}",
        snapshot.hooks.sources
    );
    assert_eq!(
        admitted(&snapshot.project_hooks),
        [(HookSource::Project, "Stop", "good.sh".to_owned())]
    );
    assert_eq!(
        snapshot.project_hooks,
        entry(&env, &paths, &workspace(), None).await
    );
}
