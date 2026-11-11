//! 首条输入的临时标题（Node `titleFromInput`）。
use super::*;

#[test]
fn a_stored_source_shows_like_nodes_normalized_one() {
    assert_eq!(Source::stored("custom").shown(), "custom");
    assert_eq!(Source::stored("default").shown(), "default");
    assert_eq!(Source::stored("first_input").shown(), "generated");
    assert_eq!(Source::stored("generated").shown(), "generated");
    assert_eq!(Source::stored("odd"), Source::Generated);
    assert_eq!(Source::derived(""), Source::Default);
    assert_eq!(Source::derived("t"), Source::Generated);
}

#[test]
fn first_input_titles_follow_node() {
    assert_eq!(from_input("  fix   the\n\tbug  "), "fix the bug");
    assert_eq!(from_input(" \n "), "Untitled session");
    let long = "a".repeat(61);
    assert_eq!(from_input(&long), format!("{}...", "a".repeat(57)));
    assert_eq!(from_input(&"b".repeat(60)), "b".repeat(60));
}
