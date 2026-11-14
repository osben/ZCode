//! Fork: Node's cancel messages by tool name (specs/fork-rust-agent-parity.md "Command hook stdin").

use super::node_cancel_message;

#[test]
fn node_cancel_messages_are_the_handlers_own() {
    // core `tool/handlers/bash.ts` and `agent.ts` `cancellation.userVisibleMessage`.
    assert_eq!(
        node_cancel_message("Bash"),
        Some("Bash was cancelled and the child process was asked to stop")
    );
    assert_eq!(
        node_cancel_message("Agent"),
        Some(
            "Agent was cancelled before the subagent returned findings or background launch completed"
        )
    );
    // Node has no Monitor handler: the pipeline sends Node's fallback.
    assert_eq!(node_cancel_message("Monitor"), None);
}
