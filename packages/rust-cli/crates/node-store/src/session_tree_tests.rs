//! Fork: session-tree resolution, counts and erase (Node `tests/session-tree.test.ts` and the
//! delete-side expectations of `tests/fork-usage-detached.test.ts`).

use serde_json::Value;

use rust_cli_kernel_api::store::StoreQueries;

use super::*;
use crate::fork_usage_rollup::{FORK_USAGE_BUCKET_MS, MODEL_REPLACE, TOOL_REPLACE, TURN_REPLACE};

/// The Node test family: an interactive parent with a side chat (itself with a nested
/// subagent), a subagent, a workflow child; a fork of the parent that the walk never enters;
/// and an unrelated session.
struct Family {
    store: crate::tests::TestStore,
}

const ROOT: &str = "sess_parent";
const CHAT: &str = "sess_chat";
const NESTED_SUB: &str = "sess_nested_sub";
const SUB: &str = "sess_sub";
const WF_CHILD: &str = "sess_wf_child";
const FORK: &str = "sess_fork";
const OTHER: &str = "sess_other";
const DIRECTORY: &str = "/work/family";

/// A fixed, bucket-aligned usage timestamp (2026-11-05 UTC): the store's fixed test clock
/// stays near the epoch, so the in-transaction prune keeps these buckets.
fn usage_at() -> i64 {
    let at = 1_794_009_600_000_i64;
    at - at.rem_euclid(FORK_USAGE_BUCKET_MS)
}

fn seed_session(conn: &Connection, id: &str, parent: Option<&str>, task_type: &str) {
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, path, title, version,
           task_type, time_created, time_updated)
         values (?, 'proj_x', ?, ?, ?, ?, ?, '0.1.0', ?, 1000, 1000)",
        rusqlite::params![id, parent, id, DIRECTORY, DIRECTORY, id, task_type],
    )
    .unwrap();
}

impl Family {
    async fn new() -> Self {
        let store = crate::tests::TestStore::new();
        // Opening the store applies the migrations before the raw seeding connection runs.
        StoreQueries::session_tree_ids(&store.store, vec![])
            .await
            .unwrap();
        let conn = store.connection();
        seed_session(&conn, ROOT, None, "interactive");
        seed_session(&conn, CHAT, Some(ROOT), "selection_side_chat");
        seed_session(&conn, NESTED_SUB, Some(CHAT), "subagent_child");
        seed_session(&conn, SUB, Some(ROOT), "subagent_child");
        seed_session(&conn, WF_CHILD, Some(ROOT), "workflow_child");
        seed_session(&conn, FORK, Some(ROOT), "fork");
        seed_session(&conn, OTHER, None, "interactive");
        // Two workflow runs: one per table, both attached to the workflow child.
        conn.execute(
            "insert into workflow_run (id, name, cwd, script_hash, status, parent_session_id,
               time_created, time_updated)
             values ('wf_run_1', 'wf', '/work', 'hash', 'completed', ?, 1000, 1000)",
            rusqlite::params![WF_CHILD],
        )
        .unwrap();
        conn.execute(
            "insert into dwf_run (id, caps_max_concurrency, status, parent_session_id,
               time_created, time_updated)
             values ('dwf_run_1', 1, 'completed', ?, 1000, 1000)",
            rusqlite::params![WF_CHILD],
        )
        .unwrap();
        conn.execute(
            "insert into input_history (id, project_id, session_id, text, kind, time_created)
             values ('input_1', 'proj_x', ?, 'draft', 'user', 1000)",
            rusqlite::params![CHAT],
        )
        .unwrap();
        conn.execute(
            "insert into input_history (id, project_id, session_id, text, kind, time_created)
             values ('input_2', 'proj_x', ?, 'draft', 'user', 1000)",
            rusqlite::params![OTHER],
        )
        .unwrap();
        conn.execute(
            "insert into message (id, session_id, time_created, time_updated, data)
             values ('msg_1', ?, 1000, 1000, '{}')",
            rusqlite::params![CHAT],
        )
        .unwrap();
        Self { store }
    }

    fn rows(&self, sql: &str) -> Vec<Value> {
        self.store
            .rows(sql)
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
    }

    fn scalar(&self, sql: &str) -> Value {
        self.rows(sql).into_iter().next().unwrap_or(Value::Null)
    }

    fn session_ids(&self) -> Vec<String> {
        self.rows("select id from session order by id")
            .into_iter()
            .map(|value| value.as_str().unwrap_or_default().to_owned())
            .collect()
    }
}

/// Counts over the whole family; the fork is a child of the root but never walked into.
#[tokio::test]
async fn counts_the_family_tree() {
    let family = Family::new().await;
    let counts = StoreQueries::session_tree_counts(&family.store.store, vec![ROOT.to_owned()])
        .await
        .unwrap();
    assert_eq!(counts.total, 5);
    assert_eq!(counts.side_chats, 1);
    assert_eq!(counts.subagents, 2);
    assert_eq!(counts.workflow_sessions, 1);
    assert_eq!(counts.workflow_runs, 2);
}

/// Unknown roots resolve to an empty tree with all-zero counts (Node: "missing ids zero").
#[tokio::test]
async fn missing_roots_count_zero() {
    let family = Family::new().await;
    let counts =
        StoreQueries::session_tree_counts(&family.store.store, vec!["sess_missing".to_owned()])
            .await
            .unwrap();
    assert_eq!(
        (counts.total, counts.workflow_runs),
        (0, 0),
        "a root that does not exist has no tree"
    );
}

/// Fork: the subagent children of a top-level session are walked through `subagent_child` rows only; the side chat's
/// nested subagent belongs to the side chat (its own top-level session for the agents it spawns).
#[tokio::test]
async fn lists_subagent_children_through_subagent_rows_only() {
    let family = Family::new().await;
    let conn = family.store.connection();
    let grandchild = "sess_sub_grandchild";
    seed_session(&conn, grandchild, Some(SUB), "subagent_child");
    drop(conn);
    let ids = |root: &str| {
        let store = &family.store.store;
        let root = rust_cli_kernel_api::ids::SessionId::new(root);
        async move {
            StoreQueries::subagent_child_ids(store, &root)
                .await
                .unwrap()
                .into_iter()
                .map(|id| id.as_str().to_owned())
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(ids(ROOT).await, vec![SUB.to_owned(), grandchild.to_owned()]);
    assert_eq!(ids(CHAT).await, vec![NESTED_SUB.to_owned()]);
    assert!(ids(OTHER).await.is_empty());
}

/// A root list of only unknown ids yields no ids; duplicate roots resolve once.
#[tokio::test]
async fn dedups_roots_and_lists_surviving_children() {
    let family = Family::new().await;
    let ids = StoreQueries::session_tree_ids(
        &family.store.store,
        vec![ROOT.to_owned(), ROOT.to_owned(), "sess_missing".to_owned()],
    )
    .await
    .unwrap();
    assert_eq!(ids.len(), 5, "duplicate roots resolve once");
    // The fork points at the root from outside the tree, so the root is retained.
    let surviving = StoreQueries::session_tree_ids_with_surviving_children(
        &family.store.store,
        vec![ROOT.to_owned()],
    )
    .await
    .unwrap();
    assert_eq!(surviving, vec![ROOT.to_owned()]);
}

/// Erasing the tree removes rows and input history, cascades messages, keeps the fork and the
/// unrelated session, and reports the erased root's workspace for the index announcement.
#[tokio::test]
async fn erases_the_tree_but_not_the_fork() {
    let family = Family::new().await;
    let erased = StoreQueries::erase_session_tree(&family.store.store, vec![ROOT.to_owned()])
        .await
        .unwrap();
    assert_eq!(erased.erased_ids.len(), 5);
    assert!(erased.erased_ids.contains(&ROOT.to_owned()));
    assert!(!erased.erased_ids.contains(&FORK.to_owned()));
    assert_eq!(
        erased.erased_roots,
        vec![(ROOT.to_owned(), DIRECTORY.to_owned())],
        "the erased root's workspace is read before the delete"
    );
    assert_eq!(
        family.session_ids(),
        vec![FORK.to_owned(), OTHER.to_owned()],
        "the fork and the unrelated session stay"
    );
    assert_eq!(
        family.scalar("select parent_id from session where id = 'sess_fork'"),
        Value::from(ROOT),
        "the fork keeps its (now dangling) parent reference"
    );
    assert_eq!(
        family.scalar("select count(*) from input_history where session_id = 'sess_chat'"),
        Value::from(0),
        "the tree's input history is erased"
    );
    assert_eq!(
        family.scalar("select count(*) from input_history where session_id = 'sess_other'"),
        Value::from(1),
        "other sessions keep their input history"
    );
    assert_eq!(
        family.scalar("select count(*) from message"),
        Value::from(0),
        "the FK cascade removes the tree's messages"
    );
    assert_eq!(
        family.scalar("select count(*) from workflow_run"),
        Value::from(0),
        "workflow runs of the tree are deleted before the sessions"
    );
    assert_eq!(
        family.scalar("select count(*) from dwf_run"),
        Value::from(0)
    );
}

/// Erase is idempotent: the second call finds an empty tree and changes nothing.
#[tokio::test]
async fn erase_is_idempotent() {
    let family = Family::new().await;
    StoreQueries::erase_session_tree(&family.store.store, vec![ROOT.to_owned()])
        .await
        .unwrap();
    let again = StoreQueries::erase_session_tree(&family.store.store, vec![ROOT.to_owned()])
        .await
        .unwrap();
    assert!(again.erased_ids.is_empty());
    assert_eq!(family.session_ids().len(), 2);
}

/// More roots than one id chunk (400) still erase completely.
#[tokio::test]
async fn erases_past_the_chunk_size() {
    let store = crate::tests::TestStore::new();
    StoreQueries::session_tree_ids(&store.store, vec![])
        .await
        .unwrap();
    let conn = store.connection();
    for index in 0..450 {
        let id = format!("sess_chunk_{index}");
        seed_session(&conn, &id, None, "interactive");
    }
    drop(conn);
    let roots: Vec<String> = (0..450)
        .map(|index| format!("sess_chunk_{index}"))
        .collect();
    let erased = StoreQueries::erase_session_tree(&store.store, roots)
        .await
        .unwrap();
    assert_eq!(erased.erased_ids.len(), 450);
    assert_eq!(
        store.rows("select count(*) from session")[0][0],
        Value::from(0)
    );
}

/// A failure inside the transaction leaves every row and the rollup watermark untouched.
#[tokio::test]
async fn a_failing_delete_rolls_back() {
    let family = Family::new().await;
    {
        let conn = family.store.connection();
        conn.execute(
            "create trigger fork_block_erase before delete on session
             when old.id = 'sess_parent' begin select raise(abort, 'blocked'); end",
            [],
        )
        .unwrap();
    }
    let error = StoreQueries::erase_session_tree(&family.store.store, vec![ROOT.to_owned()])
        .await
        .unwrap_err();
    assert!(
        matches!(error, StoreError::Storage { .. }),
        "the trigger surfaces as a storage error: {error:?}"
    );
    assert_eq!(family.session_ids().len(), 7, "nothing was deleted");
    assert_eq!(
        family.scalar("select count(*) from workflow_run"),
        Value::from(1),
        "the pre-delete workflow cleanup rolled back too"
    );
    assert_eq!(
        family.scalar(
            "select count(*) from sqlite_master where type = 'table' and name = 'fork_usage_meta'"
        ),
        Value::from(0),
        "the rollup schema created inside the failed transaction rolled back with it"
    );
}

/// Seed one model, turn and tool usage row per session at a bucket-aligned time.
fn seed_usage(conn: &Connection, session: &str, tokens: i64) {
    conn.execute(
        "insert into model_usage (id, logical_request_id, session_id, query_source, provider_id,
           model_id, status, started_at, input_tokens, output_tokens, computed_total_tokens)
         values (?, 'req', ?, 'app', 'provider', 'model', 'completed', ?, ?, ?, ?)",
        rusqlite::params![
            format!("mu_{session}"),
            session,
            usage_at(),
            tokens,
            tokens,
            2 * tokens
        ],
    )
    .unwrap();
    conn.execute(
        "insert into turn_usage (session_id, turn_id, status, started_at, duration_ms,
           computed_total_tokens)
         values (?, ?, 'completed', ?, 7000, ?)",
        rusqlite::params![session, format!("turn_{session}"), usage_at(), 2 * tokens],
    )
    .unwrap();
    conn.execute(
        "insert into tool_usage (id, session_id, tool_call_id, tool_name, status, started_at,
           duration_ms)
         values (?, ?, 'call_1', 'Read', 'completed', ?, 100)",
        rusqlite::params![format!("tu_{session}"), session, usage_at()],
    )
    .unwrap();
}

/// Erasing a tree preserves its usage in the rollup baselines and detaches turn identities
/// under opaque ids (Node `fork-usage-detached.test.ts`): comparable aggregates survive, the
/// session id does not.
#[tokio::test]
async fn erase_preserves_usage_in_the_rollup() {
    let store = crate::tests::TestStore::new();
    StoreQueries::session_tree_ids(&store.store, vec![])
        .await
        .unwrap();
    {
        let conn = store.connection();
        seed_session(&conn, ROOT, None, "interactive");
        seed_session(&conn, CHAT, Some(ROOT), "selection_side_chat");
        seed_session(&conn, OTHER, None, "interactive");
        seed_usage(&conn, ROOT, 100);
        seed_usage(&conn, CHAT, 50);
        seed_usage(&conn, OTHER, 25);
    }
    let sum = |sql: &str| -> Value {
        store
            .rows(sql)
            .into_iter()
            .flatten()
            .next()
            .unwrap_or(Value::Null)
    };
    let erased = StoreQueries::erase_session_tree(&store.store, vec![ROOT.to_owned()])
        .await
        .unwrap();
    assert_eq!(erased.erased_ids.len(), 2);
    // The raw rows of the erased sessions are gone (FK cascade); the survivor keeps its own.
    assert_eq!(
        sum("select count(*) from model_usage where session_id in ('sess_parent', 'sess_chat')"),
        Value::from(0)
    );
    assert_eq!(
        sum("select count(*) from model_usage where session_id = 'sess_other'"),
        Value::from(1)
    );
    // Model and tool totals survive through the protected baselines (the `*_all` views)…
    assert_eq!(
        sum("select coalesce(sum(input_tokens), 0) from fork_usage_bucket_all"),
        Value::from(175)
    );
    assert_eq!(
        sum("select coalesce(sum(request_count), 0) from fork_usage_bucket_all"),
        Value::from(3)
    );
    assert_eq!(
        sum("select coalesce(sum(call_count), 0) from fork_usage_tool_all"),
        Value::from(3)
    );
    // …and the plain bucket is gone: the survivor shares the bucket with the erased sessions, so
    // the whole bucket moves to the protected baselines (Node leaves the same state).
    assert_eq!(
        sum("select count(*) from fork_usage_bucket"),
        Value::from(0)
    );
    // Turn identities detach under opaque ids that never equal the session id.
    assert_eq!(
        sum("select coalesce(sum(turn_count), 0) from fork_usage_turn_all"),
        Value::from(3)
    );
    assert_eq!(
        sum("select count(*) from fork_usage_turn"),
        Value::from(1),
        "only the survivor keeps live turn rows"
    );
    assert_eq!(
        sum("select count(*) from fork_usage_detached_turn"),
        Value::from(2)
    );
    let opaque: Vec<Value> = store
        .rows("select opaque_session_id from fork_usage_detached_turn")
        .into_iter()
        .flatten()
        .collect();
    assert_eq!(opaque.len(), 2);
    for id in opaque {
        let id = id.as_str().unwrap_or_default();
        assert_ne!(id, ROOT);
        assert_ne!(id, CHAT);
        assert!(!id.contains(ROOT) && !id.contains(CHAT));
    }
    // The fork ledger rows landed.
    let migrations = store
        .rows("select id from schema_migration where id like '9%_fork_usage%' order by id")
        .into_iter()
        .flatten()
        .count();
    assert_eq!(migrations, 2, "both fork migrations are recorded");
}

/// The replacement SQL keeps the bucket expression and the bucket width in sync (the SQL text
/// must equal Node's interpolation of `FORK_USAGE_BUCKET_MS`).
#[test]
fn replace_sql_matches_the_bucket_constant() {
    assert!(MODEL_REPLACE.insert_sql.contains(&format!(
        "cast(m.started_at / {FORK_USAGE_BUCKET_MS} as integer)"
    )));
    assert!(TURN_REPLACE.insert_sql.contains(&format!(
        "cast(t.started_at / {FORK_USAGE_BUCKET_MS} as integer)"
    )));
    assert!(TOOL_REPLACE.insert_sql.contains(&format!(
        "cast(u.started_at / {FORK_USAGE_BUCKET_MS} as integer)"
    )));
}

/// `SESSION_TREE_CHILD_TASK_TYPES` mirrors the contract constant.
#[test]
fn child_task_types_match_node() {
    assert_eq!(
        SESSION_TREE_CHILD_TASK_TYPES,
        [
            "selection_side_chat",
            "subagent_child",
            "workflow_child",
            "nested_workflow_child"
        ]
    );
}
