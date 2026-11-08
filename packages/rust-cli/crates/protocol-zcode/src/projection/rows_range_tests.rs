use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::SessionView;
use rust_cli_kernel_api::store::{SessionKind, SessionMeta};
use rust_cli_kernel_api::testing::selection;
use serde_json::{Map, json};

use super::super::WINDOW_ROWS;
use super::super::state::Followup;
use super::*;
use serde_json::Value;

fn projection(rows: Vec<Value>) -> Projection {
    let view = SessionView::new(
        SessionMeta {
            id: SessionId::new("session_1"),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            title: String::new(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
        },
        Vec::new(),
        selection(),
        PermissionMode::Default,
    );
    let mut projection = Projection::from_view(&view, Followup::Queue, Vec::new());
    projection.rows = rows
        .into_iter()
        .map(|row| row.as_object().cloned().unwrap_or_else(Map::new))
        .collect();
    projection
}

fn rows(count: u64) -> Vec<Value> {
    (1..=count)
        .map(|id| json!({"rowId": id * 2, "kind": "message"}))
        .collect()
}

fn ids(rows: &[Value]) -> Vec<u64> {
    rows.iter()
        .map(|row| row["rowId"].as_u64().unwrap())
        .collect()
}

#[test]
fn without_a_cursor_the_page_ends_at_the_tail() {
    let (page, more) = projection(rows(5)).rows_range(None, 2);
    assert_eq!(ids(&page), vec![8, 10]);
    assert!(more);
}

#[test]
fn a_cursor_returns_the_rows_before_it_ascending() {
    let (page, more) = projection(rows(5)).rows_range(Some(7), 10);
    assert_eq!(ids(&page), vec![2, 4, 6]);
    assert!(!more);
}

#[test]
fn the_limit_is_clamped_like_node() {
    let projection = projection(rows(250));
    assert_eq!(projection.rows_range(None, 0).0.len(), 1);
    assert_eq!(projection.rows_range(None, 1000).0.len(), MAX_LIMIT);
}

#[test]
fn the_snapshot_carries_only_the_tail_window_with_the_full_count() {
    let projection = projection(rows(70));
    let snapshot = projection.snapshot(1, "epoch");
    assert_eq!(
        snapshot["rows"]["window"].as_array().unwrap().len(),
        WINDOW_ROWS
    );
    assert_eq!(snapshot["rows"]["totalCount"], 70);
    assert_eq!(snapshot["rows"]["firstRowId"], 2);
    assert_eq!(WINDOW_ROWS, 60);
}
