use super::capabilities;

/// B5 (specs/fork-rust-agent-parity.md): the App offers the selection-comment entry only when the agent says
/// a quote's `comment` / `agent` reach the model.
#[test]
fn quote_comments_are_reported() {
    assert_eq!(capabilities()["conversationQuoteComment"], true);
}
