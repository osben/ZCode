use super::capabilities;

/// B5 (specs/fork-rust-agent-parity.md): the App offers the selection-comment entry only when the agent says
/// a quote's `comment` / `agent` reach the model.
#[test]
fn quote_comments_are_reported() {
    assert_eq!(capabilities(false)["conversationQuoteComment"], true);
}

/// B4 (specs/fork-rust-agent-parity.md): the Host sends extension-originated input only to agents that report it.
#[test]
fn extension_input_source_is_reported() {
    assert_eq!(capabilities(false)["extensionInputSource"], true);
}

/// F1 (specs/fork-rust-node-helper.md): the plugin summary is reported only while a Node helper is configured.
#[test]
fn plugin_extension_summary_follows_the_node_helper() {
    assert_eq!(capabilities(true)["pluginExtensionSummary"], true);
    assert_eq!(capabilities(false)["pluginExtensionSummary"], false);
    assert!(capabilities(true).get("pluginDiscoveryUi").is_none());
}

/// ACP rule 2 (specs/fork-rust-agent-parity.md): the Host admits `acp:` commands only where the agent reports it.
#[test]
fn external_agent_turns_are_reported_on_macos_only() {
    assert_eq!(
        capabilities()["externalAgentTurns"],
        cfg!(target_os = "macos")
    );
}
