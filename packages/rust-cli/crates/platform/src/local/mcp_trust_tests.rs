//! Workspace MCP trust records: the Node format, decide under the lock, fail-closed parsing.
#![allow(
    clippy::disallowed_methods,
    reason = "tests read back the written file"
)]
use super::*;

const D1: &str = "177736e2ee5a13cc08c0576241bdf310a4068df9827856e0f9b9559e7d5a4051";
const D2: &str = "12cfc9a259d5de1dfa724d8bcef747b740d0b2a0782a7e8b3ea7e8445da79cd0";
/// Bytes Node wrote after granting alpha and gamma and revoking alpha
/// (`scripts/fork-rust-agent/mcp-trust-golden.mts`).
const NODE_TEXT: &str = r#"{"schemaVersion":1,"records":[{"workspaceIdentity":"/ws","serverName":"gamma","declarationDigest":"177736e2ee5a13cc08c0576241bdf310a4068df9827856e0f9b9559e7d5a4051","grantedAt":"2026-11-13T17:12:31.379Z"}]}"#;

fn record(name: &str, digest: &str) -> McpTrustRecord {
    McpTrustRecord {
        workspace_identity: "/ws".to_owned(),
        server_name: name.to_owned(),
        declaration_digest: digest.to_owned(),
        granted_at: "2026-11-13T17:12:31.379Z".to_owned(),
    }
}

fn store(dir: &std::path::Path) -> McpTrustStore {
    let paths = rust_cli_paths::StoragePaths::resolve(&Default::default(), dir, dir);
    McpTrustStore::beside(&paths.hook_trust_store(None))
}

#[tokio::test]
async fn the_store_sits_beside_the_hook_trust_store() {
    let dir = tempfile::tempdir().unwrap();
    let paths = rust_cli_paths::StoragePaths::resolve(&Default::default(), dir.path(), dir.path());
    let hook = paths.hook_trust_store(None);
    assert_eq!(
        store(dir.path()).path(),
        hook.as_path().parent().unwrap().join(MCP_TRUST_STORE)
    );
}

#[tokio::test]
async fn decide_writes_the_bytes_node_writes() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    assert_eq!(store.load().await, McpTrustLoad::Missing);
    store
        .decide(async || StillDeclared::Yes, record("alpha", D2), true)
        .await
        .unwrap();
    store
        .decide(async || StillDeclared::Yes, record("gamma", D1), true)
        .await
        .unwrap();
    store
        .decide(async || StillDeclared::Yes, record("alpha", D2), false)
        .await
        .unwrap();
    let text = std::fs::read_to_string(store.path()).unwrap();
    assert_eq!(text, NODE_TEXT);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(store.path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[tokio::test]
async fn a_node_written_store_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    std::fs::create_dir_all(store.path().parent().unwrap()).unwrap();
    std::fs::write(store.path(), NODE_TEXT).unwrap();
    let load = store.load().await;
    assert!(load.trusts("/ws", "gamma", D1));
    assert!(!load.trusts("/ws", "gamma", D2));
    assert!(!load.trusts("/other", "gamma", D1));
}

#[tokio::test]
async fn a_regrant_replaces_the_record_and_keeps_others() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    store
        .decide(async || StillDeclared::Yes, record("gamma", D1), true)
        .await
        .unwrap();
    store
        .decide(async || StillDeclared::Yes, record("alpha", D2), true)
        .await
        .unwrap();
    store
        .decide(async || StillDeclared::Yes, record("gamma", D1), true)
        .await
        .unwrap();
    let names: Vec<_> = store
        .load()
        .await
        .records()
        .iter()
        .map(|r| r.server_name.clone())
        .collect();
    assert_eq!(names, ["alpha", "gamma"]);
}

#[tokio::test]
async fn a_changed_declaration_refuses_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let result = store
        .decide(async || StillDeclared::Changed, record("gamma", D1), true)
        .await;
    assert!(matches!(result, Err(McpTrustError::Changed)));
    assert_eq!(store.load().await, McpTrustLoad::Missing);
}

#[tokio::test]
async fn a_corrupt_store_is_untrusted_and_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    std::fs::create_dir_all(store.path().parent().unwrap()).unwrap();
    for text in [
        "{",
        r#"{"schemaVersion":2,"records":[]}"#,
        r#"{"schemaVersion":1,"records":[],"extra":1}"#,
        r#"{"schemaVersion":1,"records":[{"workspaceIdentity":"/ws","serverName":"g","declarationDigest":"XYZ","grantedAt":"2026-11-13T17:12:31.379Z"}]}"#,
        r#"{"schemaVersion":1,"records":[{"workspaceIdentity":"/ws","serverName":"g","declarationDigest":"177736e2ee5a13cc08c0576241bdf310a4068df9827856e0f9b9559e7d5a4051","grantedAt":"yesterday"}]}"#,
    ] {
        std::fs::write(store.path(), text).unwrap();
        assert_eq!(store.load().await, McpTrustLoad::Corrupt, "{text}");
        let result = store
            .decide(async || StillDeclared::Yes, record("gamma", D1), true)
            .await;
        assert!(matches!(result, Err(McpTrustError::Corrupt)), "{text}");
        assert_eq!(std::fs::read_to_string(store.path()).unwrap(), text);
    }
}

#[tokio::test]
async fn an_unreadable_workspace_refuses_as_unavailable_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let result = store
        .decide(
            async || StillDeclared::Unavailable,
            record("gamma", D1),
            true,
        )
        .await;
    assert!(matches!(result, Err(McpTrustError::Unavailable)));
    assert_eq!(
        result.unwrap_err().to_string(),
        "workspace_mcp_trust_unavailable"
    );
    assert_eq!(store.load().await, McpTrustLoad::Missing);
}

#[tokio::test]
async fn an_invalid_record_is_refused_so_the_store_stays_readable() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let mut bad = record("gamma", D1);
    bad.granted_at = "yesterday".to_owned();
    let result = store.decide(async || StillDeclared::Yes, bad, true).await;
    assert!(matches!(result, Err(McpTrustError::Invalid)));
    assert_eq!(store.load().await, McpTrustLoad::Missing);
}

#[tokio::test]
async fn a_float_schema_version_is_node_s_literal_one() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    std::fs::create_dir_all(store.path().parent().unwrap()).unwrap();
    std::fs::write(
        store.path(),
        NODE_TEXT.replace(r#""schemaVersion":1"#, r#""schemaVersion":1.0"#),
    )
    .unwrap();
    assert!(store.load().await.trusts("/ws", "gamma", D1));
}

#[cfg(unix)]
#[tokio::test]
async fn the_first_decision_creates_a_private_security_directory() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    store
        .decide(async || StillDeclared::Yes, record("gamma", D1), true)
        .await
        .unwrap();
    let mode = std::fs::metadata(store.path().parent().unwrap())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o700);
}
