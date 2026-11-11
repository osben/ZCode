//! `v4/sessionsIndex/reconcile` from the stored row (Node `reconcileSessions`).

use serde_json::{Value, json};

use super::stored_entry;

fn row(deleted: Option<u64>) -> Value {
    json!({
        "directory": "/work/a",
        "workspaceId": null,
        "title": "Fix the bug",
        "titleSource": "first_input",
        "timeCreated": 1_000,
        "timeUpdated": 3_000,
        "timeTitleUpdated": 2_000,
        "timeDeleted": deleted,
        "lastOutcome": "completed",
    })
}

#[test]
fn a_soft_deleted_row_exists_and_is_deleted() {
    let entry = stored_entry("sess_1", "/work/a", Some(&row(Some(4_000))), None);
    assert_eq!(
        entry,
        json!({
            "sessionId": "sess_1",
            "exists": true,
            "deleted": true,
            "title": "Fix the bug",
            "titleSource": "generated",
            "titleUpdatedAt": 2_000,
            "createdAt": 1_000,
            "updatedAt": 3_000,
            "lastOutcome": "completed",
        })
    );
    let kept = stored_entry("sess_1", "/work/a", Some(&row(None)), None);
    assert_eq!(kept["deleted"], json!(false));
    assert_eq!(kept["exists"], json!(true));
}

#[test]
fn a_missing_or_foreign_row_does_not_exist() {
    let missing = json!({"sessionId": "sess_1", "exists": false, "deleted": false});
    assert_eq!(stored_entry("sess_1", "/work/a", None, None), missing);
    // A live draft prewarm has no row yet: Node's `getSession` misses it too.
    assert_eq!(
        stored_entry("sess_1", "/work/a", None, Some(&json!({"phase": "draft"}))),
        missing
    );
    assert_eq!(
        stored_entry("sess_1", "/work/b", Some(&row(Some(4_000))), None),
        missing
    );
    let mut foreign = row(None);
    foreign["workspaceId"] = json!("other");
    assert_eq!(
        stored_entry("sess_1", "/work/a", Some(&foreign), None),
        missing
    );
    foreign["workspaceId"] = json!("/work/a");
    assert_eq!(
        stored_entry("sess_1", "/work/a", Some(&foreign), None)["exists"],
        json!(true)
    );
}

#[test]
fn a_live_session_keeps_its_projection_and_takes_the_stored_delete() {
    let live = json!({
        "title": "Live title",
        "titleSource": "generated",
        "createdAt": 1_000,
        "lastActivityAt": 9_000,
    });
    let entry = stored_entry("sess_1", "/work/a", Some(&row(Some(4_000))), Some(&live));
    assert_eq!(entry["title"], json!("Live title"));
    assert_eq!(entry["updatedAt"], json!(9_000));
    assert_eq!(entry["titleUpdatedAt"], json!(2_000));
    assert_eq!(entry["deleted"], json!(true));
    assert!(entry.get("lastOutcome").is_none());
}

#[test]
fn title_sources_normalize_like_node() {
    for (stored, wire) in [
        (json!("custom"), "custom"),
        (json!("default"), "default"),
        (json!("generated"), "generated"),
        (json!(null), "generated"),
    ] {
        let mut stored_row = row(None);
        stored_row["titleSource"] = stored;
        let entry = stored_entry("sess_1", "/work/a", Some(&stored_row), None);
        assert_eq!(entry["titleSource"], json!(wire));
    }
}

/// Fork: a cold sessions-index row carries the stored creation time and the persisted outcome, so the
/// Host's CLI-facts mirror does not overwrite them with the last update and a synthetic `completed`.
#[test]
fn a_cold_row_reports_the_stored_creation_and_outcome() {
    use rust_cli_kernel_api::ids::SessionId;
    use rust_cli_kernel_api::panels::WorkspaceSession;
    use rust_cli_kernel_api::store::SessionSummary;

    let session = |outcome: Option<&str>, created_at_ms: u64| WorkspaceSession {
        summary: SessionSummary {
            id: SessionId::new("sess_1"),
            title: "Fix the bug".to_owned(),
            updated_at_ms: 3_000,
            created_at_ms,
            last_outcome: outcome.map(str::to_owned),
            parent: None,
            title_source: None,
        },
        activity: None,
        last_reply: None,
    };
    let failed = super::cold_row("/work/a", &session(Some("error"), 1_000));
    assert_eq!(failed["createdAt"], json!(1_000));
    assert_eq!(failed["lastActivityAt"], json!(3_000));
    assert_eq!(failed["lastOutcome"], json!("error"));
    assert_eq!(failed["phase"], json!("error"));
    let interrupted = super::cold_row("/work/a", &session(Some("interrupted"), 1_000));
    assert_eq!(interrupted["lastOutcome"], json!("interrupted"));
    let unfinished = super::cold_row("/work/a", &session(None, 0));
    assert!(unfinished.get("lastOutcome").is_none());
    assert_eq!(unfinished["createdAt"], json!(3_000));
}

/// Fork: a stored fork carries its parent like Node's cold summary, so the Host admits it into the parent's project.
#[test]
fn a_cold_fork_row_carries_its_parent() {
    use rust_cli_kernel_api::ids::SessionId;
    use rust_cli_kernel_api::panels::WorkspaceSession;
    use rust_cli_kernel_api::store::SessionSummary;

    let session = |parent: Option<&str>| WorkspaceSession {
        summary: SessionSummary {
            id: SessionId::new("sess_2"),
            title: "Forked".to_owned(),
            updated_at_ms: 3_000,
            created_at_ms: 1_000,
            last_outcome: None,
            parent: parent.map(SessionId::new),
            title_source: None,
        },
        activity: None,
        last_reply: None,
    };
    let fork = super::cold_row("/work/a", &session(Some("sess_1")));
    assert_eq!(fork["parentSessionId"], json!("sess_1"));
    let root = super::cold_row("/work/a", &session(None));
    assert!(root.get("parentSessionId").is_none());
}

/// Fork: a cold row reports the stored title source the way Node's cold summary normalizes it
/// (`normalizeStoredTitleSource`), not one guessed from the title: a persisted untouched prewarm is
/// "New session" with `default`, a renamed session is `custom`.
#[test]
fn a_cold_row_reports_the_stored_title_source() {
    use rust_cli_kernel_api::ids::SessionId;
    use rust_cli_kernel_api::panels::WorkspaceSession;
    use rust_cli_kernel_api::store::SessionSummary;

    let session = |title: &str, source: Option<&str>| WorkspaceSession {
        summary: SessionSummary {
            id: SessionId::new("sess_1"),
            title: title.to_owned(),
            updated_at_ms: 3_000,
            created_at_ms: 1_000,
            last_outcome: None,
            parent: None,
            title_source: source.map(str::to_owned),
        },
        activity: None,
        last_reply: None,
    };
    let source =
        |title, stored| super::cold_row("/work/a", &session(title, stored))["titleSource"].clone();
    assert_eq!(source("New session", Some("default")), json!("default"));
    assert_eq!(source("Renamed", Some("custom")), json!("custom"));
    assert_eq!(
        source("Fix the bug", Some("first_input")),
        json!("generated")
    );
    // A row without a stored source (an open session the store has no row for) keeps the derived one.
    assert_eq!(source("", None), json!("default"));
}
