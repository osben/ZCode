use rust_cli_kernel_api::lsp::ChangedRange;
use serde_json::json;

use super::{between, for_write, from_hunks, split_lines};

fn range(start_line: u32, end_line: u32) -> ChangedRange {
    ChangedRange {
        start_line,
        end_line,
    }
}

#[test]
fn lines_split_like_node() {
    assert_eq!(split_lines(""), vec![""]);
    assert_eq!(split_lines("a\r\nb\n"), vec!["a", "b", ""]);
}

#[test]
fn a_created_file_is_one_range() {
    assert_eq!(for_write(None, ""), range(1, 1));
    assert_eq!(for_write(None, "a\nb\n"), range(1, 3));
}

#[test]
fn an_overwrite_covers_the_differing_lines() {
    assert_eq!(for_write(Some("a\nb\nc"), "a\nX\nc"), range(2, 2));
    assert_eq!(for_write(Some("a\nc"), "a\nX\nY\nc"), range(2, 3));
    // A pure deletion marks where the lines were.
    assert_eq!(between(&["a", "b", "c"], &["a", "c"]), range(2, 2));
    assert_eq!(between(&["a", "b"], &[]), range(1, 1));
}

#[test]
fn hunks_union_their_new_sides() {
    let hunks = [
        json!({"newStart": 4, "newLines": 3}),
        json!({"newStart": 10, "newLines": 0}),
    ];
    assert_eq!(from_hunks(&hunks), Some(range(4, 10)));
    assert_eq!(from_hunks(&[json!({"newStart": 0, "newLines": 0})]), Some(range(1, 1)));
    assert_eq!(from_hunks(&[]), None);
}
