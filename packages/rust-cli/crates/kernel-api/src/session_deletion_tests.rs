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
