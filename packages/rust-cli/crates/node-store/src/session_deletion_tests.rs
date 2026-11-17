//! Fork: the permanent-deletion store (Node `adapters/tests/session-store-permanent-deletion.test.ts`).
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_deletion::DeletionBegin;
use rust_cli_kernel_api::store::{SessionKind, SessionMeta, SessionStore, StoreQueries};

use crate::tests::{TestStore, meta};

const UPSTREAM_0025: &str =
    rust_cli_base::include_lf!("fixtures/0025_session_permanent_deletion.sql");

fn sid(id: &str) -> SessionId {
    SessionId::new(id)
}

/// Node `setup()`: `root`, its subagent `child` and an independent `fork`, in a database a Node build migrated.
async fn tree() -> TestStore {
    let store = TestStore::new();
    store
        .store
        .create(meta("root", "/work/example", "root"))
        .await
        .unwrap();
    store
        .store
        .create(child("child", "root", SessionKind::Subagent))
        .await
        .unwrap();
    store
        .store
        .create(child("fork", "root", SessionKind::Fork))
        .await
        .unwrap();
    store.connection().execute_batch(UPSTREAM_0025).unwrap();
    store
}

fn child(id: &str, parent: &str, kind: SessionKind) -> SessionMeta {
    let mut session = meta(id, "/work/example", id);
    session.kind = kind;
    session.parent = Some(sid(parent));
    session
}

fn session_rows(store: &TestStore, id: &str) -> i64 {
    store.rows(&format!("select count(*) from session where id='{id}'"))[0][0]
        .as_i64()
        .unwrap()
}

#[tokio::test]
async fn inspect_lists_the_owned_tree_and_leaves_the_fork_out() {
    let store = tree().await;
    let snapshot = store
        .store
        .inspect_session_deletion(&sid("root"))
        .await
        .unwrap();
    let mut ids = snapshot.session_ids.clone();
    ids.sort();
    assert_eq!(ids, ["child", "root"]);
    let forks: Vec<&str> = snapshot
        .forks
        .iter()
        .map(|fork| fork.session_id.as_str())
        .collect();
    assert_eq!(forks, ["fork"]);
    assert!(!snapshot.deleting && !snapshot.completed && !snapshot.foreign_runtime);
}

#[tokio::test]
async fn begin_fences_new_runtimes_and_complete_erases_the_tree_but_keeps_the_fork() {
    let store = tree().await;
    let snapshot = store
        .store
        .inspect_session_deletion(&sid("root"))
        .await
        .unwrap();
    let begun = store
        .store
        .begin_session_deletion(&sid("root"), &snapshot.revision, "operation", &[])
        .await
        .unwrap();
    assert_eq!(begun, DeletionBegin::Admitted);

    let refused = store
        .store
        .register_runtime(&sid("root"))
        .await
        .err()
        .unwrap();
    assert!(
        refused.to_string().contains("session-data.deleting"),
        "{refused}"
    );

    store
        .store
        .complete_session_deletion(&sid("root"))
        .await
        .unwrap();
    assert_eq!(session_rows(&store, "root"), 0);
    assert_eq!(session_rows(&store, "child"), 0);
    assert_eq!(session_rows(&store, "fork"), 1);

    let recreated = store
        .store
        .create(meta("root", "/work/example", "root"))
        .await
        .err()
        .unwrap();
    assert!(
        recreated.to_string().contains("session-data.deleting"),
        "{recreated}"
    );
    // A repeated complete is harmless: the purge rows are already `deleted`.
    store
        .store
        .complete_session_deletion(&sid("root"))
        .await
        .unwrap();
}

#[tokio::test]
async fn begin_refuses_a_plan_whose_tree_changed_after_the_preview() {
    let store = tree().await;
    let snapshot = store
        .store
        .inspect_session_deletion(&sid("root"))
        .await
        .unwrap();
    store
        .store
        .create(child("newchild", "root", SessionKind::Subagent))
        .await
        .unwrap();
    let begun = store
        .store
        .begin_session_deletion(&sid("root"), &snapshot.revision, "operation", &[])
        .await
        .unwrap();
    assert_eq!(begun, DeletionBegin::Changed);
    assert_eq!(session_rows(&store, "root"), 1);
}

#[tokio::test]
async fn begin_refuses_while_another_live_process_holds_a_session_of_the_tree() {
    let store = tree().await;
    // This test process is alive, so its pid counts as a live foreign runtime (Node `process.kill(pid, 0)`).
    store
        .connection()
        .execute(
            "insert into session_runtime_presence(session_id,owner_id,process_id) values('child','other:1',?1)",
            [std::process::id()],
        )
        .unwrap();
    let snapshot = store
        .store
        .inspect_session_deletion(&sid("root"))
        .await
        .unwrap();
    assert!(snapshot.foreign_runtime);
    let begun = store
        .store
        .begin_session_deletion(&sid("root"), &snapshot.revision, "operation", &[])
        .await
        .unwrap();
    assert_eq!(begun, DeletionBegin::Running);
    assert_eq!(session_rows(&store, "root"), 1);
}

#[tokio::test]
async fn inspect_reports_the_runtime_this_process_holds() {
    let store = tree().await;
    let _guard = store.store.register_runtime(&sid("root")).await.unwrap();
    let snapshot = store
        .store
        .inspect_session_deletion(&sid("root"))
        .await
        .unwrap();
    assert_eq!(snapshot.local_runtime_ids, ["root"]);
    assert!(!snapshot.foreign_runtime);
}

#[tokio::test]
async fn an_unknown_root_has_no_sessions_and_a_stable_revision() {
    let store = tree().await;
    let first = store
        .store
        .inspect_session_deletion(&sid("missing"))
        .await
        .unwrap();
    let second = store
        .store
        .inspect_session_deletion(&sid("missing"))
        .await
        .unwrap();
    assert!(first.session_ids.is_empty());
    assert_eq!(first.revision, second.revision);
}

/// Node's `zcode-artifact://(<session>)/(<artifact>)` regex: the first match per URI, percent-decoded, with a
/// session that stops at `/`, `"`, `\` or whitespace, and an artifact that also stops at `?` and `#`.
#[test]
fn artifact_uris_are_parsed_like_node_regex() {
    let body = r#"{"src":"zcode-artifact://root/art%201?x=1","again":"zcode-artifact://other%2Fid/a-2\""}"#;
    let found = super::artifact_references(body).unwrap();
    assert_eq!(
        found,
        [
            ("root".to_owned(), "art 1".to_owned()),
            ("other/id".to_owned(), "a-2".to_owned())
        ]
    );
    assert!(
        super::artifact_references("zcode-artifact://root")
            .unwrap()
            .is_empty()
    );
    assert!(
        super::artifact_references("zcode-artifact:///x")
            .unwrap()
            .is_empty()
    );
    assert!(super::artifact_references("zcode-artifact://a%zz/b").is_err());
}

/// ICU root order for the identifier charset: punctuation, then digits, then letters, case-insensitive first.
#[test]
fn collation_matches_icu_root_order_for_identifiers() {
    use std::cmp::Ordering::{Greater, Less};
    assert_eq!(super::collate("a_b", "a-b"), Less);
    assert_eq!(super::collate("a-b", "a.b"), Less);
    assert_eq!(super::collate("a/b", "a1"), Less);
    assert_eq!(super::collate("a1", "aa"), Less);
    assert_eq!(super::collate("ab", "Ab"), Less);
    assert_eq!(super::collate("Ab", "ac"), Less);
    assert_eq!(super::collate("ab", "ab-c"), Less);
    assert_eq!(super::collate("ab-c", "abc"), Less);
    assert_eq!(super::collate("b", "A"), Greater);
}
