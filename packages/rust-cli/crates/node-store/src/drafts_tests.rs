//! Fork: deferred drafts, one test per row of the Store-method table in
//! specs/fork-agent-runtime-selection.md "Draft prewarm in Rust mode".
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, OwnerEpoch, SessionId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::{ExecutionState, PermissionMode};
use rust_cli_kernel_api::store::{
    Fact, FrontendRecord, LocalSettings, SessionFilter, SessionFork, SessionKind, SessionMeta,
    SessionStore, StoreError, StoreQueries,
};
use serde_json::json;

use crate::tests::{FIXTURE_VERSION, TestStore, batch, fixed_ids, meta, user};
use crate::{LOCAL_ENVIRONMENT, NodeStore};

const ID: &str = "sess_draft";

fn sid() -> SessionId {
    SessionId::new(ID)
}

/// A test store with deferral on (the app-server's store).
fn deferring() -> TestStore {
    let mut t = TestStore::new();
    t.store = NodeStore::new(t.store.paths().clone(), fixed_ids(&t.source))
        .with_version(FIXTURE_VERSION)
        .with_deferred_drafts();
    t
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new(LOCAL_ENVIRONMENT),
        root: EnvPath::new("/w"),
    }
}

fn picked() -> ModelSelection {
    ModelSelection::new("p", "picked")
}

/// What a prewarm commits: the create batch, a model change and a mode change.
async fn configure(t: &TestStore) {
    let facts = vec![
        Fact::ModelSelected {
            selection: ModelSelection::new("p", "first"),
        },
        Fact::ExecutionChanged {
            state: ExecutionState::from_parts(PermissionMode::Default, false),
        },
    ];
    t.store.commit(&sid(), batch(None, facts)).await.unwrap();
    t.source.at(2000);
    let facts = vec![Fact::ModelSelected {
        selection: picked(),
    }];
    t.store
        .commit(&sid(), batch(Some("cmd_model"), facts))
        .await
        .unwrap();
    t.source.at(3000);
    let facts = vec![
        Fact::ExecutionChanged {
            state: ExecutionState::from_parts(PermissionMode::AcceptEdits, false),
        },
        Fact::ProjectModeSet {
            mode: PermissionMode::AcceptEdits,
        },
    ];
    t.store
        .commit(&sid(), batch(Some("cmd_mode"), facts))
        .await
        .unwrap();
}

fn command_fact(key: &str) -> FrontendRecord {
    FrontendRecord {
        kind: "v4/command_fact".into(),
        key: key.into(),
        data: json!({"key": key}),
    }
}

fn session_rows(t: &TestStore) -> usize {
    t.rows(&format!("select id from session where id = '{ID}'"))
        .len()
}

fn entry_rows(t: &TestStore) -> usize {
    t.rows(&format!(
        "select id from session_entry where session_id = '{ID}'"
    ))
    .len()
}

fn not_found<T: std::fmt::Debug>(result: Result<T, StoreError>) -> bool {
    matches!(result, Err(StoreError::NotFound { .. }))
}

#[tokio::test]
async fn create_and_config_batches_write_no_row() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    configure(&t).await;
    t.store
        .put_record(&sid(), &command_fact("a"))
        .await
        .unwrap();
    assert_eq!(session_rows(&t), 0);
    assert_eq!(entry_rows(&t), 0);
    assert!(t.store.is_draft(&sid()).await.unwrap());
    // Reads see no row, like Node `getSession` for a deferred record.
    assert!(not_found(t.store.load(&sid()).await));
    assert!(
        t.store
            .list(SessionFilter {
                workspace: workspace(),
                limit: 10
            })
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(t.store.reconcile_row(&sid()).await.unwrap(), None);
}

#[tokio::test]
async fn the_project_mode_of_a_draft_is_written_at_once() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    configure(&t).await;
    assert_eq!(
        t.store.project_mode(&workspace()).await.unwrap(),
        Some(PermissionMode::AcceptEdits)
    );
    // A newer project mode from elsewhere survives the draft's materialization.
    let other = "sess_other";
    t.store
        .create(SessionMeta {
            kind: SessionKind::Fork,
            ..meta(other, "/w", "")
        })
        .await
        .unwrap();
    let facts = vec![Fact::ProjectModeSet {
        mode: PermissionMode::Plan,
    }];
    t.store
        .commit(&SessionId::new(other), batch(None, facts))
        .await
        .unwrap();
    t.store
        .commit(&sid(), batch(Some("cmd_send"), vec![user("m1", "hi")]))
        .await
        .unwrap();
    assert_eq!(
        t.store.project_mode(&workspace()).await.unwrap(),
        Some(PermissionMode::Plan)
    );
}

#[tokio::test]
async fn the_first_real_commit_materializes_with_the_buffered_config() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    configure(&t).await;
    t.store
        .put_record(&sid(), &command_fact("a"))
        .await
        .unwrap();
    t.source.at(4000);
    t.store
        .commit(&sid(), batch(Some("cmd_send"), vec![user("m1", "hi")]))
        .await
        .unwrap();
    assert!(!t.store.is_draft(&sid()).await.unwrap());
    assert_eq!(session_rows(&t), 1);
    let loaded = t.store.load(&sid()).await.unwrap();
    assert_eq!(loaded.model, Some(picked()));
    assert_eq!(loaded.mode, Some(PermissionMode::AcceptEdits));
    assert_eq!(loaded.messages.len(), 1);
    // The row keeps the draft's creation time; buffered writes keep their own times.
    assert_eq!(
        t.rows(&format!(
            "select time_created from session where id = '{ID}'"
        )),
        vec![vec![json!(1000)]]
    );
    assert_eq!(
        t.rows(&format!(
            "select time_created from session_entry where session_id = '{ID}' and id = 'a'"
        )),
        vec![vec![json!(3000)]]
    );
    assert_eq!(
        t.store.records(&sid(), "v4/command_fact").await.unwrap(),
        vec![command_fact("a")]
    );
}

#[tokio::test]
async fn command_facts_are_buffered_and_read_back() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    t.store
        .put_record(&sid(), &command_fact("a"))
        .await
        .unwrap();
    let mut replaced = command_fact("a");
    replaced.data = json!({"replaced": true});
    t.store.put_record(&sid(), &replaced).await.unwrap();
    t.store
        .put_record(&sid(), &command_fact("b"))
        .await
        .unwrap();
    assert_eq!(session_rows(&t), 0);
    assert_eq!(
        t.store.records(&sid(), "v4/command_fact").await.unwrap(),
        vec![replaced, command_fact("b")]
    );
    assert!(t.store.records(&sid(), "other").await.unwrap().is_empty());
}

#[tokio::test]
async fn the_reservation_marker_materializes_the_draft() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    configure(&t).await;
    let marker = FrontendRecord {
        kind: "v4/fork_submission_preparation".into(),
        key: format!("v4/fork_submission_preparation:{ID}"),
        data: json!({"submissionId": "sub_1", "status": "preparing"}),
    };
    t.store.put_record(&sid(), &marker).await.unwrap();
    assert_eq!(session_rows(&t), 1);
    assert_eq!(
        t.store
            .records(&sid(), "v4/fork_submission_preparation")
            .await
            .unwrap(),
        vec![marker]
    );
    assert_eq!(t.store.load(&sid()).await.unwrap().model, Some(picked()));
}

#[tokio::test]
async fn rename_materializes_then_renames() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    t.store.rename(&sid(), "Named").await.unwrap();
    assert_eq!(
        t.rows(&format!("select title from session where id = '{ID}'")),
        vec![vec![json!("Named")]]
    );
}

#[tokio::test]
async fn delete_drops_the_draft_and_late_writes_stay_out() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    configure(&t).await;
    t.store.delete(&sid()).await.unwrap();
    // Idempotent, like a retried deleteSession.
    t.store.delete(&sid()).await.unwrap();
    assert!(!t.store.is_draft(&sid()).await.unwrap());
    // The closing actor's in-flight commit and record find nothing to write into.
    assert!(not_found(
        t.store
            .commit(&sid(), batch(None, vec![user("m1", "late")]))
            .await
    ));
    assert!(not_found(
        t.store.put_record(&sid(), &command_fact("late")).await
    ));
    assert!(not_found(t.store.rename(&sid(), "late").await));
    assert_eq!(session_rows(&t), 0);
    assert_eq!(entry_rows(&t), 0);
}

#[tokio::test]
async fn a_new_create_of_a_dropped_id_is_a_new_draft() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    t.store.delete(&sid()).await.unwrap();
    // A re-prewarm or retried reservation with the same explicit id.
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    assert!(t.store.is_draft(&sid()).await.unwrap());
    t.store
        .commit(&sid(), batch(None, vec![user("m1", "hi")]))
        .await
        .unwrap();
    assert_eq!(session_rows(&t), 1);
}

#[tokio::test]
async fn discard_draft_is_an_atomic_check_and_drop() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    assert!(t.store.discard_draft(&sid()).await.unwrap());
    assert!(!t.store.discard_draft(&sid()).await.unwrap());
    // A materialized session is not a draft.
    t.store.create(meta("sess_sent", "/w", "")).await.unwrap();
    let sent = SessionId::new("sess_sent");
    t.store
        .commit(&sent, batch(None, vec![user("m1", "hi")]))
        .await
        .unwrap();
    assert!(!t.store.discard_draft(&sent).await.unwrap());
    assert_eq!(
        t.rows("select time_deleted from session where id = 'sess_sent'"),
        vec![vec![serde_json::Value::Null]]
    );
}

#[tokio::test]
async fn erasing_a_tree_drops_draft_roots() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    t.store
        .erase_session_tree(vec![ID.to_owned()])
        .await
        .unwrap();
    assert!(!t.store.is_draft(&sid()).await.unwrap());
    assert!(not_found(
        t.store
            .commit(&sid(), batch(None, vec![user("m1", "late")]))
            .await
    ));
    assert_eq!(session_rows(&t), 0);
}

#[tokio::test]
async fn forking_a_draft_is_not_found_and_keeps_it_a_draft() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    let fork = SessionFork {
        parent: sid(),
        child: SessionId::new("sess_child"),
        created_at_ms: 1000,
        through: MessageId::new("m1"),
        selection: picked(),
        mode: PermissionMode::Default,
        plan: false,
    };
    assert!(t.store.fork(fork).await.is_err());
    assert!(t.store.is_draft(&sid()).await.unwrap());
    assert_eq!(t.rows("select id from session").len(), 0);
}

#[tokio::test]
async fn subagents_and_forks_are_written_at_create() {
    let t = deferring();
    t.store
        .create(SessionMeta {
            kind: SessionKind::Subagent,
            parent: Some(SessionId::new("sess_parent")),
            ..meta("sess_sub", "/w", "")
        })
        .await
        .unwrap();
    t.store
        .create(SessionMeta {
            kind: SessionKind::Fork,
            ..meta("sess_fork", "/w", "")
        })
        .await
        .unwrap();
    assert_eq!(t.rows("select id from session order by id").len(), 2);
}

#[tokio::test]
async fn without_deferral_create_writes_the_row() {
    let t = TestStore::new();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    assert_eq!(session_rows(&t), 1);
    assert!(!t.store.is_draft(&sid()).await.unwrap());
    assert!(!t.store.discard_draft(&sid()).await.unwrap());
}

#[tokio::test]
async fn a_stale_owner_is_refused_for_a_draft() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    let mut stale = batch(None, vec![user("m1", "hi")]);
    stale.owner_epoch = OwnerEpoch(7);
    assert!(matches!(
        t.store.commit(&sid(), stale).await,
        Err(StoreError::StaleOwner { .. })
    ));
    assert!(t.store.is_draft(&sid()).await.unwrap());
}

#[tokio::test]
async fn a_restarted_store_forgets_the_draft() {
    let t = deferring();
    t.store.create(meta(ID, "/w", "")).await.unwrap();
    configure(&t).await;
    let fresh = NodeStore::new(t.store.paths().clone(), fixed_ids(&t.source))
        .with_version(FIXTURE_VERSION)
        .with_deferred_drafts();
    assert!(!fresh.is_draft(&sid()).await.unwrap());
    assert!(not_found(fresh.load(&sid()).await));
    assert_eq!(session_rows(&t), 0);
}
