//! Fork: the collation weights of the permanent-deletion ordering (Node `localeCompare`, see `session_deletion.rs`).

use std::cmp::Ordering;

use super::{locale_compare, primary_weight};

/// An uppercase letter weighs what its lowercase letter weighs, whichever caller lowercases first: `'A' - 'a'`
/// underflows the `u32` arithmetic otherwise (a panic in debug builds).
#[test]
fn an_uppercase_letter_has_the_weight_of_its_lowercase_letter() {
    assert_eq!(primary_weight('A'), primary_weight('a'));
    assert_eq!(primary_weight('Z'), primary_weight('z'));
}

#[test]
fn letters_order_by_base_then_accent_then_case() {
    assert_eq!(locale_compare("fork", "Fork"), Ordering::Less);
    assert_eq!(locale_compare("é", "e"), Ordering::Greater);
    assert_eq!(locale_compare("a", "B"), Ordering::Less);
}

/// W7-6: a session of the tree with a live workflow run is busy, and the answer follows the tree's order.
#[test]
fn a_tree_session_with_a_live_run_is_busy_in_tree_order() {
    use crate::ids::SessionId;
    let tree = vec![
        "ses_root".to_owned(),
        "ses_child".to_owned(),
        "ses_other".to_owned(),
    ];
    let live = vec![SessionId::new("ses_child"), SessionId::new("ses_outside")];
    assert_eq!(
        super::live_run_busy_ids(&tree, &live),
        vec!["ses_child".to_owned()]
    );
}

/// W7-6 review: with two busy sessions, the answer follows the tree's order, not the order of the live list.
#[test]
fn busy_sessions_follow_the_tree_order_when_the_live_order_differs() {
    use crate::ids::SessionId;
    let tree = vec!["ses_b".to_owned(), "ses_x".to_owned(), "ses_a".to_owned()];
    let live = vec![SessionId::new("ses_a"), SessionId::new("ses_b")];
    assert_eq!(
        super::live_run_busy_ids(&tree, &live),
        vec!["ses_b".to_owned(), "ses_a".to_owned()]
    );
}

/// W7-6: no live run means no busy session, whatever the tree.
#[test]
fn no_live_run_means_no_busy_session() {
    assert!(super::live_run_busy_ids(&["ses_root".to_owned()], &[]).is_empty());
}
