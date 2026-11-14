//! The App's hook review against the real config files and trust store (specs/fork-rust-agent-parity.md, "Workspace
//! hook review flow"): stored trust, grants and revocations, and the configured toggle.
#![allow(
    clippy::disallowed_methods,
    reason = "the test reads and rewrites the trust store in a temporary HOME"
)]

use rust_cli_kernel_api::env::WritePrecondition;

use super::super::tests::{Fixture, ROOT, fixture_text, target};
use super::*;

/// Key order, a float and a non-ASCII text, which the rewrite keeps as `JSON.stringify(raw, null, 2)` does.
pub(super) const PROJECT: &str = r#"{"zeta": 1.5, "hooks": {"enabled": true, "events": {"UserPromptSubmit": [{"hooks": [
    {"type": "command", "command": "echo hi", "statusMessage": "héllo"},
    {"type": "process", "command": "node", "args": ["check.js", "--fast"]}
]}]}}, "alpha": {"2": "b", "1": "a"}}"#;

pub(super) const PROJECT_PATH: &str = "/Users/dev/repo/.zcode/config.json";

pub(super) async fn bundle(fixture: &Fixture) -> ReviewBundle {
    match fixture.admin.review_bundle(&target(ROOT)).await {
        ReviewLookup::Bundle(bundle) => bundle,
        other => panic!("a reviewable bundle: {other:?}"),
    }
}

pub(super) fn ids(bundle: &ReviewBundle) -> Vec<String> {
    bundle
        .items
        .iter()
        .map(|item| item.review_item_id.clone())
        .collect()
}

fn stored(bundle: &ReviewBundle) -> Vec<StoredTrust> {
    bundle.items.iter().map(|item| item.stored).collect()
}

async fn project(fixture: &Fixture) -> Vec<u8> {
    let workspace = fixture.admin.process.workspace.clone();
    fixture
        .admin
        .files
        .read_file(
            &workspace,
            ReadFile {
                path: EnvPath::new(PROJECT_PATH),
            },
        )
        .await
        .unwrap()
        .bytes
}

async fn write_project(fixture: &Fixture, text: &str) {
    let workspace = fixture.admin.process.workspace.clone();
    let context = OperationContext::new(
        workspace.environment.clone(),
        Generation::new("test"),
        OperationId::new("test-write"),
        Origin::User { session: None },
    );
    fixture
        .admin
        .files
        .put_file(
            &workspace,
            context,
            PutFile {
                path: EnvPath::new(PROJECT_PATH),
                bytes: text.as_bytes().to_vec(),
                precondition: WritePrecondition::Any,
                create_parents: false,
            },
        )
        .await
        .unwrap();
}

fn store_file(fixture: &Fixture) -> std::path::PathBuf {
    fixture
        .admin
        .paths
        .hook_trust_store(None)
        .as_path()
        .to_path_buf()
}

#[tokio::test]
async fn the_bundle_lists_every_declaration_with_nodes_display_fields() {
    let fixture = fixture_text(PROJECT, json!({}));
    let bundle = bundle(&fixture).await;
    assert_eq!(bundle.identity, ROOT);
    assert!(!bundle.store_corrupt);
    assert_eq!(
        bundle.sources,
        vec![ReviewSource {
            path: PROJECT_PATH.to_owned(),
            display_path: ".zcode/config.json".to_owned(),
            editable: true,
        }]
    );
    let [command, process] = bundle.items.as_slice() else {
        panic!("two declarations: {:?}", bundle.items);
    };
    assert_eq!(command.event, "UserPromptSubmit");
    assert_eq!(command.matcher, None);
    assert_eq!(command.kind, "command");
    assert_eq!(command.display_command, "echo hi");
    assert_eq!(command.source_path, ".zcode/config.json");
    assert_eq!(command.resolved_timeout_ms, 60_000);
    assert!(command.resolved_max_output_bytes > 0);
    assert!(command.configured_enabled && command.editable);
    assert_eq!(command.stored, StoredTrust::Untrusted);
    assert_eq!(process.kind, "process");
    assert_eq!(process.display_command, "node check.js --fast");
    assert_ne!(command.digest, process.digest);
}

#[tokio::test]
async fn nothing_is_reviewable_without_declarations_or_with_an_unreadable_config() {
    let empty = fixture_text(r#"{"zeta": 1}"#, json!({}));
    assert_eq!(
        empty.admin.review_bundle(&target(ROOT)).await,
        ReviewLookup::Nothing
    );
    let fixture = fixture_text(PROJECT, json!({}));
    std::fs::write(
        fixture._home.path().join(".zcode/cli/config.json"),
        "{ not json",
    )
    .unwrap();
    assert_eq!(
        fixture.admin.review_bundle(&target(ROOT)).await,
        ReviewLookup::Unreadable
    );
}

#[tokio::test]
async fn a_grant_writes_nodes_records_and_rebuilds_the_process_hooks() {
    let fixture = fixture_text(PROJECT, json!({}));
    let review = bundle(&fixture).await;
    let mismatch = fixture
        .admin
        .review_grant(&target(ROOT), &"0".repeat(64), &ids(&review)[..1])
        .await;
    assert_eq!(mismatch, Err(codes::SNAPSHOT_MISMATCH));
    let unknown = fixture
        .admin
        .review_grant(&target(ROOT), &review.bundle_digest, &["nope".to_owned()])
        .await;
    assert_eq!(unknown, Err(codes::SNAPSHOT_MISMATCH));
    assert!(!store_file(&fixture).exists(), "a refusal writes nothing");
    assert!(fixture.hooks.lock().unwrap().is_empty());

    fixture
        .admin
        .review_grant(&target(ROOT), &review.bundle_digest, &ids(&review)[..1])
        .await
        .unwrap();
    assert_eq!(fixture.hooks.lock().unwrap().len(), 1);
    let after = bundle(&fixture).await;
    assert_eq!(
        stored(&after),
        vec![StoredTrust::Trusted, StoredTrust::Untrusted]
    );
    let file: Value =
        serde_json::from_slice(&std::fs::read(store_file(&fixture)).unwrap()).unwrap();
    let record = &file["records"][0];
    assert_eq!(record["workspaceIdentity"], ROOT);
    assert_eq!(record["hookDeclarationDigest"], review.items[0].digest);
    assert_eq!(record["bundleDigestAtGrant"], review.bundle_digest);
    assert_eq!(record["eventAtGrant"], "UserPromptSubmit");
    assert_eq!(record["hookIndexAtGrant"], 0);

    // A store that cannot be read is never overwritten.
    std::fs::write(store_file(&fixture), "{ corrupt").unwrap();
    assert!(bundle(&fixture).await.store_corrupt);
    let corrupt = fixture
        .admin
        .review_grant(&target(ROOT), &review.bundle_digest, &ids(&review)[1..])
        .await;
    assert_eq!(corrupt, Err(codes::TRUST_STORE_CORRUPT));
    assert_eq!(
        std::fs::read_to_string(store_file(&fixture)).unwrap(),
        "{ corrupt"
    );
}

#[tokio::test]
async fn a_changed_declaration_with_a_record_for_its_slot_is_stale() {
    let fixture = fixture_text(PROJECT, json!({}));
    let review = bundle(&fixture).await;
    fixture
        .admin
        .review_grant(&target(ROOT), &review.bundle_digest, &ids(&review)[..1])
        .await
        .unwrap();
    write_project(&fixture, &PROJECT.replace("echo hi", "echo changed")).await;
    let changed = bundle(&fixture).await;
    assert_eq!(
        stored(&changed),
        vec![StoredTrust::StaleSlot, StoredTrust::Untrusted]
    );
    // A record without one of the slot fields names no slot (Node requires all of them).
    let path = store_file(&fixture);
    let mut file: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    file["records"][0]
        .as_object_mut()
        .unwrap()
        .remove("hookIndexAtGrant");
    std::fs::write(&path, file.to_string()).unwrap();
    assert_eq!(
        stored(&bundle(&fixture).await),
        vec![StoredTrust::Untrusted, StoredTrust::Untrusted]
    );
}

#[tokio::test]
async fn a_revoke_removes_the_records_and_rebuilds_the_process_hooks() {
    let fixture = fixture_text(PROJECT, json!({}));
    let review = bundle(&fixture).await;
    fixture
        .admin
        .review_grant(&target(ROOT), &review.bundle_digest, &ids(&review))
        .await
        .unwrap();
    fixture
        .admin
        .review_revoke(&target(ROOT), &[review.items[1].digest.clone()])
        .await
        .unwrap();
    assert_eq!(fixture.hooks.lock().unwrap().len(), 2);
    assert_eq!(
        stored(&bundle(&fixture).await),
        vec![StoredTrust::Trusted, StoredTrust::Untrusted]
    );
}

/// An unreadable user config could name another trust store: the revoke writes nothing.
#[tokio::test]
async fn an_unreadable_config_refuses_a_revoke() {
    let fixture = fixture_text(PROJECT, json!({}));
    let review = bundle(&fixture).await;
    fixture
        .admin
        .review_grant(&target(ROOT), &review.bundle_digest, &ids(&review))
        .await
        .unwrap();
    let before = std::fs::read(store_file(&fixture)).unwrap();
    std::fs::write(
        fixture._home.path().join(".zcode/cli/config.json"),
        "{ not json",
    )
    .unwrap();
    let answer = fixture
        .admin
        .review_revoke(&target(ROOT), &[review.items[0].digest.clone()])
        .await;
    assert_eq!(answer, Err(codes::SNAPSHOT_MISMATCH));
    assert_eq!(std::fs::read(store_file(&fixture)).unwrap(), before);
}

#[tokio::test]
async fn another_workspace_leaves_the_process_hooks_alone() {
    let fixture = fixture_text(PROJECT, json!({}));
    fixture
        .admin
        .rebuild_own_hooks(&Target::new("/Users/dev/other", None))
        .await;
    assert!(fixture.hooks.lock().unwrap().is_empty());
    fixture
        .admin
        .rebuild_own_hooks(&Target::new(ROOT, None))
        .await;
    assert_eq!(fixture.hooks.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_toggle_rewrites_only_enabled_as_node_writes_the_config() {
    let fixture = fixture_text(PROJECT, json!({}));
    let review = bundle(&fixture).await;
    fixture
        .admin
        .review_toggle(
            &target(ROOT),
            &review.bundle_digest,
            &review.items[1].review_item_id,
            false,
        )
        .await
        .unwrap();
    let mut expected: Value = serde_json::from_str(PROJECT).unwrap();
    expected["hooks"]["events"]["UserPromptSubmit"][0]["hooks"][1]["enabled"] = json!(false);
    let written = String::from_utf8(project(&fixture).await).unwrap();
    assert_eq!(written, format!("{}\n", node_pretty(&expected)));
    assert!(
        written.starts_with("{\n  \"zeta\": 1.5,\n  \"hooks\": {"),
        "{written}"
    );
    assert!(written.contains("\"héllo\""));
    assert!(written.contains("\"alpha\": {\n    \"1\": \"a\",\n    \"2\": \"b\"\n  }"));
    let after = bundle(&fixture).await;
    assert!(after.items[0].configured_enabled);
    assert!(!after.items[1].configured_enabled);
    assert_eq!(fixture.hooks.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_toggle_is_refused_like_node() {
    let fixture = fixture_text(PROJECT, json!({}));
    let review = bundle(&fixture).await;
    let id = review.items[0].review_item_id.clone();
    let changed = fixture
        .admin
        .review_toggle(&target(ROOT), &"0".repeat(64), &id, false)
        .await;
    assert_eq!(changed, Err(ToggleError::Rejected(codes::BUNDLE_CHANGED)));
    let unknown = fixture
        .admin
        .review_toggle(&target(ROOT), &review.bundle_digest, "nope", false)
        .await;
    assert_eq!(
        unknown,
        Err(ToggleError::Rejected(codes::SNAPSHOT_MISMATCH))
    );
    assert_eq!(project(&fixture).await, PROJECT.as_bytes());

    write_project(&fixture, "{ not json").await;
    let unreadable = fixture
        .admin
        .review_toggle(&target(ROOT), &review.bundle_digest, &id, false)
        .await;
    assert_eq!(
        unreadable,
        Err(ToggleError::Rejected(codes::CONFIG_UNREADABLE))
    );
    assert_eq!(project(&fixture).await, b"{ not json");
    assert!(fixture.hooks.lock().unwrap().is_empty());
}

/// The re-check of the declaration read for the write: a different command, or one at another position, is not the
/// reviewed declaration.
#[tokio::test]
async fn the_write_checks_the_declaration_it_rewrites() {
    let fixture = fixture_text(PROJECT, json!({}));
    let trust = Target::new(ROOT, None);
    let (hooks, _, sources) = fixture.admin.review_hooks(&trust).await;
    let entry = &hooks.entries()[0];
    let raw: Value = serde_json::from_str(PROJECT).unwrap();
    assert!(declared_as_reviewed(&raw, entry, &sources[0], &hooks));
    let edited: Value = serde_json::from_str(&PROJECT.replace("echo hi", "echo other")).unwrap();
    assert!(!declared_as_reviewed(&edited, entry, &sources[0], &hooks));
    let mut moved = raw;
    moved["hooks"]["events"]["UserPromptSubmit"][0]["hooks"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert!(!declared_as_reviewed(&moved, entry, &sources[0], &hooks));
}

/// Node parses the hooks object with its strict schema before a toggle and refuses one it rejects
/// (`workspace-hook-mutation.ts` `safeParse`), so its indices are raw positions. Rust's lenient parse skips the
/// malformed matcher, which shifts the indices: the toggle must refuse rather than write onto another declaration.
#[tokio::test]
async fn a_config_nodes_strict_schema_rejects_is_skipped_and_never_toggled() {
    // Node `readWorkspaceHookProjectSources` parses `hooks` with the strict `workspaceHooksConfigSchema` and reports
    // a failure as a read error, so its toggle answers `workspace_hooks_config_unreadable`. The lenient parse would
    // skip the bad entry, shift the indices and write onto another declaration.
    let configs = [
        // A matcher with an empty `hooks` list (`.min(1)`): toggling `y` would write onto `x`.
        r#"{"hooks": {"events": {"UserPromptSubmit": [
    {"matcher": "A", "hooks": []},
    {"matcher": "B", "hooks": [{"type": "command", "command": "x"}]},
    {"matcher": "C", "hooks": [{"type": "command", "command": "y"}, {"type": "command", "command": "z"}]}
]}}}"#,
        // A matcher that is not a non-empty string.
        r#"{"hooks": {"events": {"UserPromptSubmit": [
    {"matcher": 5, "hooks": [{"type": "command", "command": "a"}]},
    {"matcher": "Bash", "hooks": [{"type": "command", "command": "b"}]}
]}}}"#,
        // Unknown keys at the root, the matcher and the events (`.strict()`).
        r#"{"hooks": {"extra": true, "events": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "a"}]}]}}}"#,
        r#"{"hooks": {"events": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "a"}], "note": 1}]}}}"#,
        r#"{"hooks": {"events": {"Notification": [{"hooks": [{"type": "command", "command": "a"}]}],
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "b"}]}]}}}"#,
    ];
    for text in configs {
        let fixture = fixture_text(text, json!({}));
        // The startup snapshot skips the file (Node `config-factory.ts` `hookCandidates`), leaving no declarations.
        assert_eq!(
            fixture.admin.review_bundle(&target(ROOT)).await,
            ReviewLookup::Nothing,
            "{text}"
        );
        let answer = fixture
            .admin
            .review_toggle(&target(ROOT), "any", "any", false)
            .await;
        assert_eq!(
            answer,
            Err(ToggleError::Rejected(codes::CONFIG_UNREADABLE)),
            "{text}"
        );
        assert_eq!(project(&fixture).await, text.as_bytes());
        assert!(fixture.hooks.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn the_review_skips_only_the_file_node_cannot_load() {
    // Node's session snapshot is built from the loaded project files only (`config-factory.ts`, `hookCandidates`):
    // a file its strict schema rejects is skipped and the other files are reviewed. Its toggle still rebuilds from
    // every file and refuses (`rebuildSnapshot`, `workspace_hooks_config_unreadable`).
    let fixture = fixture_text(PROJECT, json!({}));
    let workspace = fixture.admin.process.workspace.clone();
    let context = OperationContext::new(
        workspace.environment.clone(),
        Generation::new("test"),
        OperationId::new("test-write-zcode-json"),
        Origin::User { session: None },
    );
    fixture
        .admin
        .files
        .put_file(
            &workspace,
            context,
            PutFile {
                path: EnvPath::new("/Users/dev/repo/zcode.json"),
                bytes: br#"{"hooks": {"extra": 1, "events": {"Stop": [{"hooks": [{"type": "command", "command": "bad"}]}]}}}"#.to_vec(),
                precondition: WritePrecondition::Any,
                create_parents: false,
            },
        )
        .await
        .unwrap();
    let review = bundle(&fixture).await;
    let commands: Vec<&str> = review
        .items
        .iter()
        .map(|item| item.display_command.as_str())
        .collect();
    assert_eq!(commands, ["echo hi", "node check.js --fast"]);
    assert!(
        review
            .sources
            .iter()
            .all(|source| source.path == PROJECT_PATH),
        "{:?}",
        review.sources
    );
    let answer = fixture
        .admin
        .review_toggle(
            &target(ROOT),
            &review.bundle_digest,
            &review.items[0].review_item_id,
            false,
        )
        .await;
    assert_eq!(answer, Err(ToggleError::Rejected(codes::CONFIG_UNREADABLE)));
    assert_eq!(project(&fixture).await, PROJECT.as_bytes());
}

#[tokio::test]
async fn a_config_that_breaks_the_schema_between_the_review_and_the_write_is_a_mismatch() {
    // Node `writeWorkspaceHookConfiguredToggle` re-reads the file and throws `mismatch()` when its strict schema no
    // longer accepts `hooks` (`workspace-hook-mutation.ts`).
    let fixture = fixture_text(PROJECT, json!({}));
    let trust = AppWorkspace::trust_target(&target(ROOT));
    let (hooks, unreadable, sources) = fixture.admin.review_hooks(&trust).await;
    assert!(!unreadable.any());
    let id = hooks.entries()[0].review_item_id.clone();
    let broken = PROJECT.replacen(
        r#""hooks": {"enabled": true,"#,
        r#""hooks": {"enabled": true, "extra": 1,"#,
        1,
    );
    assert_ne!(broken, PROJECT);
    write_project(&fixture, &broken).await;
    let answer = fixture
        .admin
        .write_toggle(&trust, &hooks, &sources, &id, false)
        .await;
    assert_eq!(answer, Err(codes::SNAPSHOT_MISMATCH));
    assert_eq!(project(&fixture).await, broken.as_bytes());
}

#[test]
fn the_display_path_is_relative_to_the_folder_of_dot_zcode() {
    assert_eq!(
        display_path("/Users/dev/repo/.zcode/config.json"),
        ".zcode/config.json"
    );
    assert_eq!(display_path("/Users/dev/repo/zcode.json"), "zcode.json");
    assert_eq!(
        display_path("C:\\repo\\.zcode\\config.json"),
        ".zcode\\config.json"
    );
}
