//! 项目 hooks 的信任（config.md §4、§5）：digest 与 Node 对拍、准入与 `-p` 的提示。
use rust_cli_hooks::config::HookCommand;
use rust_cli_kernel_api::hooks::HookEventName;
use rust_cli_platform::local::{ConfigFile, TrustRecord};
use serde_json::json;

use super::super::files::project_file;
use super::*;

const FIXTURE: &str = include_str!("../../tests/fixtures/workspace-hooks.json");
const GOLDEN: &str = include_str!("../../tests/fixtures/workspace-hooks-golden.json");

fn file_with(root: &str, path: &str, order: usize, hooks: &Value) -> ProjectFile {
    let mut object = Map::new();
    object.insert("hooks".into(), hooks.clone());
    project_file(root, path.to_owned(), order, ConfigFile::Loaded(object))
}

#[test]
fn digests_match_the_node_golden() {
    let cases: Vec<Value> = serde_json::from_str(FIXTURE).unwrap();
    let golden: Vec<Value> = serde_json::from_str(GOLDEN).unwrap();
    assert_eq!(cases.len(), golden.len());
    for (case, expected) in cases.iter().zip(&golden) {
        let root = case["workspacePath"].as_str().unwrap();
        let files: Vec<ProjectFile> = case["sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|source| {
                file_with(
                    root,
                    source["path"].as_str().unwrap(),
                    usize::try_from(source["discoveryOrder"].as_u64().unwrap()).unwrap(),
                    &source["hooks"],
                )
            })
            .collect();
        let user = match &case["userHooks"] {
            Value::Null => NodeHooks::default(),
            value => NodeHooks::from_json(value).0,
        };
        let mut warnings = Vec::new();
        let found = candidates(&files, &mut warnings);
        assert!(warnings.is_empty(), "{warnings:?}");
        let root_config = workspace_digest::runtime_root(
            std::iter::once(&user).chain(found.iter().map(|(_, hooks)| hooks)),
        );
        let digest_sources = sources(root, &found);
        // The fixture gives states by review item id, as Node takes them; the digest reads them by script path.
        let unread =
            workspace_digest::bundle(&digest_sources, &root_config, &Default::default()).unwrap();
        let states: workspace_digest::ScriptStates = unread
            .entries
            .iter()
            .filter_map(|entry| {
                let given = &case["scriptStates"][&entry.review_item_id];
                let state = match given["kind"].as_str()? {
                    "file" => ScriptState::File(given["sha256"].as_str()?.to_owned()),
                    "missing" => ScriptState::Missing,
                    _ => ScriptState::Unverifiable,
                };
                Some((entry.script.as_ref()?.path.clone(), state))
            })
            .collect();
        let bundle = workspace_digest::bundle(&digest_sources, &root_config, &states).unwrap();
        let name = case["name"].as_str().unwrap();
        assert_eq!(bundle.bundle_digest, expected["bundleDigest"], "{name}");
        let actual: Vec<Value> = bundle
            .entries
            .iter()
            .map(|entry| {
                let mut value = json!({
                    "reviewItemId": entry.review_item_id,
                    "sourceRelativePath": entry.source_relative_path,
                    "resolvedTimeoutMs": entry.resolved_timeout_ms,
                    "configuredEnabled": entry.configured_enabled,
                    "editable": entry.editable,
                });
                if let Some(script) = &entry.script {
                    let state = match &script.state {
                        ScriptState::File(sha256) => json!({"kind": "file", "sha256": sha256}),
                        ScriptState::Missing => json!({"kind": "missing"}),
                        ScriptState::Unverifiable => json!({"kind": "unverifiable"}),
                    };
                    value["scriptEntry"] = json!({"path": script.path, "state": state});
                }
                value["hookDeclarationDigest"] = json!(entry.digest);
                value
            })
            .collect();
        // 数字按值比较（Node 的 2500 与这里的 2500.0）。
        let normalize = |values: &[Value]| -> Vec<String> {
            values
                .iter()
                .map(rust_cli_base::js::json::stringify)
                .collect()
        };
        assert_eq!(
            normalize(&actual),
            normalize(expected["hooks"].as_array().unwrap()),
            "{name}"
        );
    }
}

#[test]
fn a_file_nodes_strict_schema_rejects_is_dropped_whole() {
    // Node's project loader parses the whole file through its strict schema (`loadFileConfig`,
    // `workspaceHooksConfigSchema.parse`); a failure marks the file not loaded, so none of its hooks is a candidate.
    let root = "/Users/dev/repo";
    let hook = |command: &str| json!({"type": "command", "command": command});
    let rejected = [
        json!({"extra": 1, "events": {"Stop": [{"hooks": [hook("a")]}]}}),
        json!({"events": {"Stop": [{"hooks": []}, {"hooks": [hook("a")]}]}}),
        json!({"events": {"Notification": [{"hooks": [hook("n")]}], "Stop": [{"hooks": [hook("a")]}]}}),
        json!({"events": {"Stop": [{"matcher": 5, "hooks": [hook("a")]}, {"hooks": [hook("b")]}]}}),
    ];
    for bad in rejected {
        let files = vec![
            file_with(root, "/Users/dev/repo/zcode.json", 0, &bad),
            file_with(
                root,
                "/Users/dev/repo/.zcode/config.json",
                1,
                &json!({"events": {"PreToolUse": [{"hooks": [hook("good")]}]}}),
            ),
        ];
        let mut warnings = Vec::new();
        let found = candidates(&files, &mut warnings);
        let paths: Vec<&str> = found.iter().map(|(file, _)| file.path.as_str()).collect();
        assert_eq!(paths, ["/Users/dev/repo/.zcode/config.json"], "{bad}");
        assert!(!warnings.is_empty(), "{bad}");
    }
}

#[test]
fn compaction_and_session_end_hooks_are_candidates() {
    let root = "/Users/dev/repo";
    let hooks = json!({"events": {
        "PreCompact": [{"hooks": [{"type": "command", "command": "a"}]}],
        "PostCompact": [{"hooks": [{"type": "command", "command": "b"}]}],
        "SessionEnd": [{"hooks": [{"type": "command", "command": "c"}]}]
    }});
    let files = vec![file_with(root, "/Users/dev/repo/zcode.json", 0, &hooks)];
    let mut warnings = Vec::new();
    let found = candidates(&files, &mut warnings);
    assert!(warnings.is_empty(), "{warnings:?}");
    let events: Vec<&str> = found[0]
        .1
        .events
        .iter()
        .map(|(event, _)| event.as_str())
        .collect();
    assert_eq!(events.len(), 3, "{events:?}");
}

fn record(identity: &str, digest: &str) -> TrustRecord {
    TrustRecord {
        workspace_identity: identity.to_owned(),
        hook_declaration_digest: digest.to_owned(),
        granted_at: "2026-10-17T08:00:00.000Z".to_owned(),
        last_used_at: None,
        bundle_digest_at_grant: None,
        event_at_grant: "PreToolUse".to_owned(),
        display_command_at_grant: "x".to_owned(),
        source_path_at_grant: "zcode.json".to_owned(),
        source_discovery_order_at_grant: None,
        matcher_at_grant: None,
        matcher_index_at_grant: None,
        hook_index_at_grant: None,
        app_version_at_grant: None,
    }
}

#[tokio::test]
async fn only_trusted_enabled_declarations_run_and_the_rest_are_pending() {
    let home = tempfile::tempdir().unwrap();
    let paths = StoragePaths::resolve(&Default::default(), home.path(), home.path());
    let root = "/Users/dev/repo";
    let hooks = json!({"enabled": true, "events": {
        "PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": "trusted.sh"},
            {"type": "command", "command": "pending.sh"}
        ]}]
    }});
    // An event outside Node's ten drops the whole file (`a_file_nodes_strict_schema_rejects_is_dropped_whole`).
    let files = vec![file_with(root, "/Users/dev/repo/zcode.json", 0, &hooks)];
    let mut warnings = Vec::new();
    let first =
        WorkspaceHooks::inspect(root, None, &files, &paths, Scripts::Local, &mut warnings).await;
    assert!(warnings.is_empty(), "{warnings:?}");
    assert!(first.admitted().is_empty());
    let trusted = first.entries()[0].digest.clone();
    first
        .store
        .grant(vec![
            record(root, &trusted),
            record("/Users/dev/other", &first.entries()[1].digest),
        ])
        .await
        .unwrap();
    let again =
        WorkspaceHooks::inspect(root, None, &files, &paths, Scripts::Local, &mut Vec::new()).await;
    let admitted = again.admitted();
    assert_eq!(admitted.len(), 1);
    let (source, settings) = &admitted[0];
    assert_eq!(*source, HookSource::Project);
    let (event, matchers) = &settings.hooks[0];
    assert_eq!(*event, HookEventName::PreToolUse);
    assert_eq!(matchers[0].matcher.as_deref(), Some("Bash"));
    assert_eq!(matchers[0].hooks.len(), 1);
    assert!(matches!(
        &matchers[0].hooks[0],
        HookCommand::Command(command) if command.command == "trusted.sh" && command.timeout == Some(60.0)
    ));
    let pending = again.pending().unwrap();
    assert_eq!(pending.digests, [again.entries()[1].digest.clone()]);
    let bundle = again.bundle.as_ref().unwrap().bundle_digest.clone();
    assert_eq!(
        pending.notice(),
        format!(
            "Workspace Hooks skipped: workspace_hooks_pending_trust\nworkspace: /Users/dev/repo\n\
             bundle: {bundle}\npending digest: {}\n\
             Review with: zcode hooks trust review --workspace \"/Users/dev/repo\"\n",
            pending.digests[0]
        )
    );
}

#[tokio::test]
async fn the_user_storage_dir_moves_the_trust_store() {
    let home = tempfile::tempdir().unwrap();
    let paths = StoragePaths::resolve(&Default::default(), home.path(), home.path());
    let user = json!({"storage": {"dir": "elsewhere"}});
    let hooks = WorkspaceHooks::inspect(
        "/w",
        user.as_object(),
        &[],
        &paths,
        Scripts::Local,
        &mut Vec::new(),
    )
    .await;
    assert_eq!(
        hooks.store.path().as_path(),
        home.path()
            .join("elsewhere/security/workspace-hook-trust-v1.json")
    );
    assert!(hooks.bundle.is_none());
    assert!(hooks.pending().is_none());
}

#[tokio::test]
#[allow(
    clippy::disallowed_methods,
    reason = "the test writes and rewrites an entry script in a temporary workspace"
)]
async fn an_unavailable_entry_script_is_neither_admitted_nor_pending() {
    // D24: the script's content is part of the digest; a missing one can be neither trusted nor run, whatever the
    // records say, and the admitted hook carries the trusted content for the re-check before each run.
    let home = tempfile::tempdir().unwrap();
    let paths = StoragePaths::resolve(&Default::default(), home.path(), home.path());
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path().to_str().unwrap().to_owned();
    std::fs::write(repo.path().join("here.sh"), b"exit 0\n").unwrap();
    let hooks = json!({"enabled": true, "events": {
        "PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": "./here.sh"},
            {"type": "command", "command": "./gone.sh"}
        ]}]
    }});
    let files = vec![file_with(&root, &format!("{root}/zcode.json"), 0, &hooks)];
    let inspect = || async {
        WorkspaceHooks::inspect(&root, None, &files, &paths, Scripts::Local, &mut Vec::new()).await
    };
    let first = inspect().await;
    let [here, gone] = first.entries() else {
        panic!("two entries")
    };
    assert_eq!(
        here.script.as_ref().unwrap().state,
        ScriptState::File(rust_cli_base::hash::sha256_hex(b"exit 0\n"))
    );
    assert!(gone.script_unavailable());
    assert_eq!(
        first.pending().unwrap().digests,
        std::slice::from_ref(&here.digest)
    );
    first
        .store
        .grant(vec![
            record(&root, &here.digest),
            record(&root, &gone.digest),
        ])
        .await
        .unwrap();

    let second = inspect().await;
    assert!(second.pending().is_none());
    let admitted = second.admitted();
    let commands: Vec<_> = admitted[0].1.hooks[0].1[0]
        .hooks
        .iter()
        .map(|hook| match hook {
            HookCommand::Command(command) => (command.command.clone(), command.script.clone()),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(
        commands,
        [(
            "./here.sh".to_owned(),
            Some(rust_cli_hooks::script_entry::ScriptCheck {
                path: "here.sh".to_owned(),
                sha256: rust_cli_base::hash::sha256_hex(b"exit 0\n"),
            })
        )]
    );

    // A changed script is a new declaration: the record no longer matches, so it is pending again.
    std::fs::write(repo.path().join("here.sh"), b"exit 1\n").unwrap();
    let third = inspect().await;
    assert!(third.admitted().is_empty());
    assert_eq!(third.pending().unwrap().digests.len(), 1);
}
