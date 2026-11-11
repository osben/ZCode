//! Fork: incognito sessions in the shared row (specs/fork-rust-agent-parity.md, "Incognito sessions"):
//! `fork_incognito` is written once in Node's JSON shape, read back with Node's fail-closed rule, copied by a fork,
//! and an incognito create on a database without the column fails instead of writing a normal row.
use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, SessionId};
use rust_cli_kernel_api::incognito::IncognitoProfile;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::store::{SessionFilter, SessionFork, SessionStore};
use serde_json::json;

use crate::LOCAL_ENVIRONMENT;
use crate::tests::{TestStore, batch, meta, selection, user};

/// Node's `JSON.stringify` of a profile that keeps only MCP.
const NODE_MCP_ONLY: &str = r#"{"projectInstructions":false,"skills":false,"hooks":false,"plugins":false,"mcp":true,"customAgents":false,"memory":false,"outputStyle":false,"systemPromptOverrides":false,"identity":false,"harness":false,"environment":false,"automationTools":false}"#;

fn mcp_only() -> IncognitoProfile {
    IncognitoProfile {
        mcp: true,
        ..IncognitoProfile::LOCKDOWN
    }
}

/// Node's fork migration `9001_fork_session_incognito` (storage preparation runs it before `zcode-rs` starts).
async fn with_column(t: &TestStore) {
    t.store.create(meta("sess_0", "/w", "")).await.unwrap();
    t.connection()
        .execute_batch("alter table session add column fork_incognito text;")
        .unwrap();
}

fn stored(t: &TestStore, id: &str) -> serde_json::Value {
    t.rows(&format!(
        "select fork_incognito from session where id = '{id}'"
    ))[0][0]
        .clone()
}

fn filter() -> SessionFilter {
    SessionFilter {
        workspace: WorkspaceRef {
            environment: EnvironmentId::new(LOCAL_ENVIRONMENT),
            root: EnvPath::new("/w"),
        },
        limit: 10,
    }
}

#[tokio::test]
async fn an_incognito_create_writes_nodes_shape_once_and_reads_back() {
    let t = TestStore::new();
    with_column(&t).await;
    let mut incognito = meta("sess_1", "/w", "");
    incognito.incognito = Some(mcp_only());
    t.store.create(incognito.clone()).await.unwrap();
    assert_eq!(stored(&t, "sess_1"), json!(NODE_MCP_ONLY));
    assert_eq!(stored(&t, "sess_0"), json!(null));

    // A repeated create (a reservation repeat, a reconcile) never replaces or clears the stored profile.
    let mut other = incognito.clone();
    other.incognito = Some(IncognitoProfile::LOCKDOWN);
    t.store.create(other).await.unwrap();
    t.store.create(meta("sess_1", "/w", "")).await.unwrap();
    assert_eq!(stored(&t, "sess_1"), json!(NODE_MCP_ONLY));

    let loaded = t.store.load(&SessionId::new("sess_1")).await.unwrap();
    assert_eq!(loaded.meta.incognito, Some(mcp_only()));
    let normal = t.store.load(&SessionId::new("sess_0")).await.unwrap();
    assert_eq!(normal.meta.incognito, None);
    let listed = t.store.list(filter()).await.unwrap();
    let flag = |id: &str| {
        listed
            .iter()
            .find(|row| row.id.as_str() == id)
            .unwrap()
            .incognito
    };
    assert!(flag("sess_1"));
    assert!(!flag("sess_0"));
}

#[tokio::test]
async fn a_node_row_this_build_cannot_parse_reads_as_lockdown() {
    let t = TestStore::new();
    with_column(&t).await;
    t.connection()
        .execute(
            "update session set fork_incognito = ?1 where id = 'sess_0'",
            [r#"{"version":2,"mcp":true}"#],
        )
        .unwrap();
    let loaded = t.store.load(&SessionId::new("sess_0")).await.unwrap();
    assert_eq!(loaded.meta.incognito, Some(IncognitoProfile::LOCKDOWN));
}

/// A value that is not text (here a BLOB) reads as lockdown like Node, instead of failing the load and the list.
#[tokio::test]
async fn a_non_text_value_reads_as_lockdown_and_keeps_the_list() {
    let t = TestStore::new();
    with_column(&t).await;
    t.store.create(meta("sess_1", "/w", "")).await.unwrap();
    t.connection()
        .execute(
            "update session set fork_incognito = x'7b7d' where id = 'sess_0'",
            [],
        )
        .unwrap();
    let loaded = t.store.load(&SessionId::new("sess_0")).await.unwrap();
    assert_eq!(loaded.meta.incognito, Some(IncognitoProfile::LOCKDOWN));
    let listed = t.store.list(filter()).await.unwrap();
    assert_eq!(listed.len(), 2);
    assert!(
        listed
            .iter()
            .any(|row| row.id.as_str() == "sess_0" && row.incognito)
    );
    assert!(
        listed
            .iter()
            .any(|row| row.id.as_str() == "sess_1" && !row.incognito)
    );
}

#[tokio::test]
async fn a_fork_keeps_the_source_profile() {
    let t = TestStore::new();
    with_column(&t).await;
    let mut incognito = meta("sess_1", "/w", "");
    incognito.incognito = Some(mcp_only());
    t.store.create(incognito).await.unwrap();
    t.store
        .commit(
            &SessionId::new("sess_1"),
            batch(None, vec![user("msg_1_u1", "first")]),
        )
        .await
        .unwrap();
    t.store
        .fork(SessionFork {
            parent: SessionId::new("sess_1"),
            child: SessionId::new("sess_2"),
            created_at_ms: 2000,
            through: MessageId::new("msg_1_u1"),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
        })
        .await
        .unwrap();
    assert_eq!(stored(&t, "sess_2"), json!(NODE_MCP_ONLY));
}

#[tokio::test]
async fn without_the_column_normal_sessions_work_and_an_incognito_create_fails() {
    let t = TestStore::new();
    t.store.create(meta("sess_0", "/w", "")).await.unwrap();
    assert_eq!(
        t.store
            .load(&SessionId::new("sess_0"))
            .await
            .unwrap()
            .meta
            .incognito,
        None
    );
    let mut incognito = meta("sess_1", "/w", "");
    incognito.incognito = Some(mcp_only());
    assert!(t.store.create(incognito).await.is_err());
    assert!(
        t.rows("select id from session where id = 'sess_1'")
            .is_empty()
    );
}
