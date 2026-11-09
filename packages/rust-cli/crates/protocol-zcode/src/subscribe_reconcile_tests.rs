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
