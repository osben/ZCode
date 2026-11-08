//! reconcile_row: soft-deleted rows stay readable (Node `getSession`), missing rows are `None`.

use rust_cli_kernel_api::ids::SessionId;

use super::*;
use crate::tests::{TestStore, started};

#[tokio::test]
async fn a_soft_deleted_row_is_still_read_with_its_deleted_time() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let before = row(&t.connection(), "sess_1").unwrap().unwrap();
    assert!(before["timeDeleted"].is_null());
    assert!(before["directory"].is_string());
    assert!(before["workspaceId"].is_null());

    let mut conn = t.connection();
    crate::query::delete(&mut conn, &SessionId::new("sess_1"), 42_000).unwrap();
    let after = row(&conn, "sess_1").unwrap().unwrap();
    assert_eq!(after["timeDeleted"], json!(42_000));
    assert_eq!(after["title"], before["title"]);
}

#[tokio::test]
async fn an_unknown_session_has_no_row() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    assert_eq!(row(&t.connection(), "sess_none").unwrap(), None);
}
