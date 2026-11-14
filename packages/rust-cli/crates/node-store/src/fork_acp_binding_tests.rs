//! fork_acp_binding: Node's tables and semantics; a database without the tables holds no binding and refuses writes.

use std::collections::BTreeMap;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::{AcpSessionBinding, StoreQueries};
use serde_json::json;

use super::*;
use crate::tests::TestStore;

/// The Node agent's fork migrations 9003, 9004 and 9005, with the DDL text Node runs (zcode-rs does not migrate them).
fn node_tables(conn: &Connection) {
    conn.execute_batch(
        "
  create table if not exists fork_acp_session_binding (
    session_id text primary key,
    agent_id text not null,
    acp_session_id text not null,
    cwd text not null,
    launch_key text not null,
    updated_at integer not null
  );
",
    )
    .unwrap();
    conn.execute_batch(
        "
      alter table fork_acp_session_binding
        add column config_options text;

      alter table fork_acp_session_binding
        add column config_choices text;
    ",
    )
    .unwrap();
    conn.execute_batch(
        "
  create table if not exists fork_acp_session_choice (
    session_id text primary key,
    agent_id text not null,
    config_choices text not null,
    updated_at integer not null
  );
",
    )
    .unwrap();
}

/// Opens the database through the store, so the migrations ran before the Node tables are added.
async fn ready(t: &TestStore) {
    t.store.acp_config(&SessionId::new("sess_1")).await.unwrap();
}

fn binding(agent: &str) -> AcpSessionBinding {
    AcpSessionBinding {
        agent_id: agent.to_owned(),
        acp_session_id: "acp-1".to_owned(),
        cwd: "/w".to_owned(),
        launch_key: "digest".to_owned(),
    }
}

fn choices(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(id, value)| ((*id).to_owned(), (*value).to_owned()))
        .collect()
}

fn options() -> serde_json::Value {
    json!([{
        "id": "model",
        "name": "Model",
        "description": null,
        "category": "model",
        "currentValue": "fast",
        "options": [{ "value": "fast", "name": "Fast", "description": null, "group": null }]
    }])
}

fn pending_rows(conn: &Connection) -> i64 {
    conn.query_row("select count(*) from fork_acp_session_choice", [], |row| {
        row.get(0)
    })
    .unwrap()
}

fn binding_rows(conn: &Connection) -> i64 {
    conn.query_row("select count(*) from fork_acp_session_binding", [], |row| {
        row.get(0)
    })
    .unwrap()
}

fn stored_choices_text(conn: &Connection) -> Option<String> {
    conn.query_row(
        "select config_choices from fork_acp_session_binding where session_id = 'sess_1'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

#[tokio::test]
async fn the_binding_is_written_read_and_cleared() {
    let t = TestStore::new();
    ready(&t).await;
    node_tables(&t.connection());
    let id = SessionId::new("sess_1");
    assert_eq!(t.store.acp_binding(&id).await.unwrap(), None);

    t.store
        .set_acp_binding(&id, &binding("claude"))
        .await
        .unwrap();
    assert_eq!(
        t.store.acp_binding(&id).await.unwrap(),
        Some(binding("claude"))
    );
    let config = t.store.acp_config(&id).await.unwrap();
    assert_eq!(config.agent_id.as_deref(), Some("claude"));
    assert_eq!(config.offered, None);
    assert!(config.choices.is_empty());

    // A second write replaces the columns and keeps the row.
    let mut moved = binding("claude");
    moved.acp_session_id = "acp-2".to_owned();
    t.store.set_acp_binding(&id, &moved).await.unwrap();
    assert_eq!(t.store.acp_binding(&id).await.unwrap(), Some(moved));

    t.store.clear_acp_binding(&id).await.unwrap();
    assert_eq!(t.store.acp_binding(&id).await.unwrap(), None);
    t.store.clear_acp_binding(&id).await.unwrap();
    assert_eq!(binding_rows(&t.connection()), 0);
}

#[tokio::test]
async fn a_pending_choice_moves_into_the_binding_of_the_same_agent() {
    let t = TestStore::new();
    ready(&t).await;
    let conn = t.connection();
    node_tables(&conn);
    let id = SessionId::new("sess_1");

    // Before the first turn the choice is pending: readConfig reports it under the pending agent.
    t.store
        .set_acp_choice(&id, "claude", "model", "fast")
        .await
        .unwrap();
    let pending = t.store.acp_config(&id).await.unwrap();
    assert_eq!(pending.agent_id.as_deref(), Some("claude"));
    assert_eq!(pending.offered, None);
    assert_eq!(pending.choices, choices(&[("model", "fast")]));
    assert_eq!(pending_rows(&conn), 1);

    // The binding write moves it: the row is gone and the choice is in config_choices.
    t.store
        .set_acp_binding(&id, &binding("claude"))
        .await
        .unwrap();
    assert_eq!(pending_rows(&conn), 0);
    assert_eq!(
        stored_choices_text(&conn).as_deref(),
        Some("{\"model\":\"fast\"}")
    );
    let bound = t.store.acp_config(&id).await.unwrap();
    assert_eq!(bound.agent_id.as_deref(), Some("claude"));
    assert_eq!(bound.choices, choices(&[("model", "fast")]));

    // Offered options are display copy of the binding; a later choice keeps the earlier ones.
    t.store.set_acp_offered(&id, &options()).await.unwrap();
    t.store
        .set_acp_choice(&id, "claude", "mode", "plan")
        .await
        .unwrap();
    let config = t.store.acp_config(&id).await.unwrap();
    assert_eq!(config.offered, Some(options()));
    assert_eq!(
        config.choices,
        choices(&[("model", "fast"), ("mode", "plan")])
    );
    assert_eq!(pending_rows(&conn), 0);
}

#[tokio::test]
async fn a_pending_choice_of_another_agent_is_dropped_by_the_binding_write() {
    let t = TestStore::new();
    ready(&t).await;
    let conn = t.connection();
    node_tables(&conn);
    let id = SessionId::new("sess_1");

    t.store
        .set_acp_choice(&id, "claude", "model", "fast")
        .await
        .unwrap();
    t.store
        .set_acp_binding(&id, &binding("opencode"))
        .await
        .unwrap();
    assert_eq!(pending_rows(&conn), 0);
    assert_eq!(stored_choices_text(&conn), None);
    let config = t.store.acp_config(&id).await.unwrap();
    assert_eq!(config.agent_id.as_deref(), Some("opencode"));
    assert!(config.choices.is_empty());
}

#[tokio::test]
async fn a_choice_for_a_binding_of_another_agent_is_refused() {
    let t = TestStore::new();
    ready(&t).await;
    let conn = t.connection();
    node_tables(&conn);
    let id = SessionId::new("sess_1");

    t.store
        .set_acp_binding(&id, &binding("claude"))
        .await
        .unwrap();
    t.store
        .set_acp_choice(&id, "claude", "model", "fast")
        .await
        .unwrap();
    let refused = t
        .store
        .set_acp_choice(&id, "opencode", "model", "slow")
        .await;
    assert!(matches!(refused, Err(StoreError::Storage { .. })));
    assert_eq!(pending_rows(&conn), 0);
    assert_eq!(
        t.store.acp_config(&id).await.unwrap().choices,
        choices(&[("model", "fast")])
    );
}

#[tokio::test]
async fn the_offered_options_are_replaced_only_on_an_existing_binding() {
    let t = TestStore::new();
    ready(&t).await;
    let conn = t.connection();
    node_tables(&conn);
    let id = SessionId::new("sess_1");

    // No row: a no-op, not an upsert.
    t.store.set_acp_offered(&id, &options()).await.unwrap();
    assert_eq!(binding_rows(&conn), 0);

    t.store
        .set_acp_binding(&id, &binding("claude"))
        .await
        .unwrap();
    t.store.set_acp_offered(&id, &options()).await.unwrap();
    assert_eq!(
        t.store.acp_config(&id).await.unwrap().offered,
        Some(options())
    );

    // A stored value that is not a config option list reads as absent.
    conn.execute(
        "update fork_acp_session_binding set config_options = '{\"bad\":1}' where session_id = 'sess_1'",
        [],
    )
    .unwrap();
    assert_eq!(t.store.acp_config(&id).await.unwrap().offered, None);
}

#[tokio::test]
async fn a_database_without_the_tables_reads_empty_and_refuses_writes() {
    let t = TestStore::new();
    ready(&t).await;
    let id = SessionId::new("sess_1");

    assert_eq!(t.store.acp_binding(&id).await.unwrap(), None);
    assert_eq!(
        t.store.acp_config(&id).await.unwrap(),
        AcpSessionConfig::default()
    );
    assert!(matches!(
        t.store.set_acp_binding(&id, &binding("claude")).await,
        Err(StoreError::Unsupported { .. })
    ));
    assert!(matches!(
        t.store.set_acp_offered(&id, &options()).await,
        Err(StoreError::Unsupported { .. })
    ));
    assert!(matches!(
        t.store.set_acp_choice(&id, "claude", "model", "fast").await,
        Err(StoreError::Unsupported { .. })
    ));
    t.store.clear_acp_binding(&id).await.unwrap();
}
