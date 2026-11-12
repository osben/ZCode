use super::capabilities;

/// B5 (specs/fork-rust-agent-parity.md): the App offers the selection-comment entry only when the agent says
/// a quote's `comment` / `agent` reach the model.
#[test]
fn quote_comments_are_reported() {
    assert_eq!(capabilities()["conversationQuoteComment"], true);
}

/// B4 (specs/fork-rust-agent-parity.md): the Host sends extension-originated input only to agents that report it.
#[test]
fn extension_input_source_is_reported() {
    assert_eq!(capabilities()["extensionInputSource"], true);
}
