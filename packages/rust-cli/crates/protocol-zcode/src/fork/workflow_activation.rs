//! Fork: on-demand activation of the workflow tools (specs/fork-rust-workflow-engine.md, 9.44, W7-11; closes divergences 54
//! and 318). Node `dynamic-workflow-activation.ts` (DWG-09, DWG-10): an on-demand session gets its ten workflow tools when it
//! first needs them, and the activation is add-only. Two sources are ported: the `/workflow` command (on send) and the cold
//! restore (the entry, else the history). The run-control source (a Resume or a saved workflow started from the hub) is not
//! ported (divergence 497).
//!
//! The decisions are pure ([`restore_plan`], [`activation_plan`], [`is_workflow_command`], [`history_shows_workflow`]); the
//! wrappers at the bottom read the record and the store, then do what the decisions say.

use rust_cli_kernel_api::dynamic_workflow::resolve_gate;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::{ContentBlock, Message};
use rust_cli_kernel_api::store::FrontendRecord;
use rust_cli_kernel_api::tool_names::DYNAMIC_WORKFLOW_TOOLS;
use serde_json::json;

use crate::server::Server;

/// The session entry's type, as Node writes it (`SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION`). It is written as a frontend
/// record (raw type, key = Node's entry id), so Node reads the same row.
pub const KIND: &str = "runtime/dynamic_workflow_activation";

/// Where an activation came from, recorded in the entry's data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// The user's `/workflow` command.
    Command,
    /// A cold restore that found the entry.
    ResumeEntry,
    /// A cold restore that found a workflow in the history.
    ResumeHistory,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::ResumeEntry => "resume_entry",
            Self::ResumeHistory => "resume_history",
        }
    }
}

/// The entry's id (Node `${sessionId}:runtime-dynamic-workflow-activation`).
pub fn entry_key(session: &SessionId) -> String {
    format!("{}:runtime-dynamic-workflow-activation", session.as_str())
}

/// JavaScript's `\s` (the WhiteSpace and LineTerminator sets), which Node's text pattern and `String.prototype.trim` both
/// use. Rust's `char::is_whitespace` differs: it misses U+FEFF and includes U+0085.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Node `WORKFLOW_COMMAND_TEXT_PATTERN` (`/^\/workflow(?:\s|$)/i`) on the text trimmed as JavaScript trims it: the word
/// alone, or followed by a JavaScript whitespace character.
pub fn is_workflow_command(text: &str) -> bool {
    let trimmed = text.trim_matches(is_js_space);
    let Some(head) = trimmed.get(..9) else {
        return false;
    };
    head.eq_ignore_ascii_case("/workflow") && trimmed[9..].chars().next().is_none_or(is_js_space)
}

/// Node `persistedMessagesShowDynamicWorkflow`: a user text that is the command, or an assistant call to one of the ten
/// tools. The assistant's own text does not count.
pub fn history_shows_workflow(messages: &[Message]) -> bool {
    messages.iter().any(|message| match message {
        Message::User(user) => user.content.iter().any(|block| {
            matches!(block, ContentBlock::Text { text } if is_workflow_command(text))
        }),
        Message::Assistant(assistant) => assistant.content.iter().any(|block| {
            matches!(block, ContentBlock::ToolUse { name, .. } if DYNAMIC_WORKFLOW_TOOLS.contains(&name.as_str()))
        }),
        _ => false,
    })
}

/// Node `restoreDynamicWorkflowActivationOnResume`: the source of a cold restore, and whether the entry is written back.
/// Only an on-demand session that is not active yet has anything to restore. The entry wins over the history; a history
/// hit is written back once so the next restore need not scan. `history_shows` is the history's workflow fact (the cold
/// open reads it from the view it loads; the legacy snapshot read passes its own).
pub fn restore_plan_for(
    on_demand: bool,
    activated: bool,
    has_entry: bool,
    history_shows: bool,
) -> Option<(Source, bool)> {
    if !on_demand || activated {
        return None;
    }
    if has_entry {
        Some((Source::ResumeEntry, false))
    } else if history_shows {
        Some((Source::ResumeHistory, true))
    } else {
        None
    }
}

/// Node `activateDynamicWorkflowTools` for the command: an on-demand session that is not active yet activates. An
/// alwaysOn session is active at birth and never activates here.
pub fn activation_plan(on_demand: bool, activated: bool) -> bool {
    on_demand && !activated
}

/// A createSession `firstInput` that is the `/workflow` command activates the new or prepared session, as a sent command
/// does (divergence 494). It runs once the session's gate is recorded, so the activation reads the session's own gate.
pub(crate) async fn on_first_input(server: &Server, session: &SessionId, text: Option<&str>) {
    if text.is_some_and(is_workflow_command) {
        on_command(server, session).await;
    }
}

/// The `/workflow` command reached the session: activate its tools and write the entry (best effort).
pub(crate) async fn on_command(server: &Server, session: &SessionId) {
    if !activation_plan(
        on_demand(server, session),
        server.dynamic_workflow_activated(session),
    ) {
        return;
    }
    if server.activate_dynamic_workflow(session) {
        write_entry(server, session, Source::Command).await;
    }
}

/// Node `restoreDynamicWorkflowActivationOnResume`: a cold-loaded session activates from its entry, else from its history.
/// Runs after the record is rebuilt, so the gate it reads is the session's.
pub(crate) async fn on_resume(server: &Server, session: &SessionId) {
    restore(server, session, None).await;
}

/// The restore behind both entry points. `history` is the history's workflow fact when the caller already loaded the
/// history (the cold open does); `None` reads the session snapshot, and only when there is no entry to decide first.
async fn restore(server: &Server, session: &SessionId, history: Option<bool>) {
    let on_demand = on_demand(server, session);
    let activated = server.dynamic_workflow_activated(session);
    if !on_demand || activated {
        return;
    }
    let has_entry = match server.kernel.queries().records(session, KIND).await {
        Ok(records) => !records.is_empty(),
        Err(error) => {
            tracing::warn!(
                event = "dynamic_workflow.activation_entry_read_failed",
                error = %error,
                "the dynamic workflow activation entry could not be read; the history decides"
            );
            false
        }
    };
    let history_shows = match history {
        Some(shows) => shows,
        None if has_entry => false,
        None => match server.kernel.session_snapshot(session).await {
            Ok(view) => history_shows_workflow(&view.messages),
            Err(error) => {
                tracing::warn!(
                    event = "dynamic_workflow.activation_history_read_failed",
                    error = %error,
                    "the session history could not be read; the activation cannot see a workflow in it"
                );
                false
            }
        },
    };
    let Some((source, write)) = restore_plan_for(on_demand, activated, has_entry, history_shows)
    else {
        return;
    };
    // A session forgotten while the restore read the store is not activated (no record), so no entry is written for it.
    if server.activate_dynamic_workflow(session) && write {
        write_entry(server, session, source).await;
    }
}

/// Fork (W7-14, 9.47, closes 496): every cold open of a session, on the v4 path as on the legacy resume. The gate record is
/// rebuilt from the Host's cached fact when the process has none for the session (Node's cold recovery builds the runtime
/// config from the preferences alone), then the on-demand activation is restored. A record the create or a resume wrote in
/// this process is kept: a create's own open must keep the gate its params made. `history_shows` is the workflow fact of the
/// history the open loaded, so the open reads no snapshot of its own.
pub(crate) async fn on_cold_open(server: &Server, session: &SessionId, history_shows: bool) {
    if server.dynamic_workflow_gate(session).is_none() {
        let gate = resolve_gate(None, None, &server.dynamic_workflow_preferences());
        server.record_dynamic_workflow_gate(session, gate);
    }
    restore(server, session, Some(history_shows)).await;
}

/// Whether the session's record is on-demand and open (the only sessions activation changes).
fn on_demand(server: &Server, session: &SessionId) -> bool {
    server
        .dynamic_workflow_gate(session)
        .is_some_and(|gate| gate.enabled && gate.tools_on_demand)
}

/// Writes the entry. A session row that is not stored yet refuses the write; the history restore covers that case, as
/// Node's backfill does on first persistence (divergence 495), so the refusal is logged and not raised.
async fn write_entry(server: &Server, session: &SessionId, source: Source) {
    let record = FrontendRecord {
        kind: KIND.to_owned(),
        key: entry_key(session),
        data: json!({"activated": true, "source": source.as_str()}),
    };
    if let Err(error) = server.kernel.queries().put_record(session, &record).await {
        tracing::warn!(
            event = "dynamic_workflow.activation_entry_write_failed",
            error = %error,
            "the dynamic workflow activation entry was not written"
        );
    }
}

#[cfg(test)]
#[path = "workflow_activation_tests.rs"]
mod tests;
