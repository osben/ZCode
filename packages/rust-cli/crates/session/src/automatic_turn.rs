//! Fork: the turns a session opens by itself (specs/fork-rust-agent-parity.md "ACP external agents", rule 11). An ACP
//! agent runs only interactive chat turns, so its runner refuses these with Node's `externalAgentTurnRefusal` words.

use rust_cli_kernel_api::message::{Message, UserOrigin};

/// What an automatically opened run is, in Node's words (`automation turns`, `background results`, `runtime
/// continuations`), read from the user message that opened it (the last message of the run's input). `None` for
/// every run that a human input opened.
pub fn automatic_turn_subject(messages: &[Message]) -> Option<&'static str> {
    let Some(Message::User(user)) = messages.last() else {
        return None;
    };
    let UserOrigin::Meta { source } = &user.origin else {
        return None;
    };
    match source.as_str() {
        crate::cron::CRON_SOURCE => Some("automation turns"),
        crate::notices::NOTICE_SOURCE | crate::peers::PEER_SOURCE => Some("background results"),
        rust_cli_kernel_api::goal::CONTINUATION_SOURCE => Some("runtime continuations"),
        _ => None,
    }
}

#[cfg(test)]
#[path = "automatic_turn_tests.rs"]
mod tests;
