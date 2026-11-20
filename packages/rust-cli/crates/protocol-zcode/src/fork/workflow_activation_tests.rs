//! The on-demand activation rules (specs/fork-rust-workflow-engine.md, 9.44, W7-11; closes 54 and 318). Pure decisions:
//! the composition reads the record, the entries and the history, then does what these return.

use rust_cli_kernel_api::ids::{MessageId, ToolUseId};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, Message, StopReason, UserMessage, UserOrigin,
};

use super::{
    Source, activation_plan, entry_key, history_shows_workflow, is_workflow_command, restore_plan,
};
use rust_cli_kernel_api::ids::SessionId;

#[test]
fn the_workflow_command_is_the_word_alone_or_followed_by_space_case_insensitively() {
    assert!(is_workflow_command("/workflow"));
    assert!(is_workflow_command("/workflow build a report"));
    assert!(is_workflow_command("  /WORKFLOW\nnext line"));
    assert!(is_workflow_command("/Workflow x"));
    assert!(
        !is_workflow_command("/workflowx"),
        "a longer word is not the command"
    );
    assert!(
        !is_workflow_command("please /workflow"),
        "the command must lead the text"
    );
    assert!(!is_workflow_command("/work"));
}

fn user_text(text: &str) -> Message {
    Message::User(UserMessage {
        id: MessageId::new("msg_u"),
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        origin: UserOrigin::Human,
        intent: None,
        stall_execution: None,
        epilogue_start: None,
    })
}

fn assistant(content: Vec<ContentBlock>) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new("msg_a"),
        content,
        model: "model".to_owned(),
        stop_reason: Some(StopReason::EndTurn),
        usage: None,
    })
}

fn tool_use(name: &str) -> ContentBlock {
    ContentBlock::ToolUse {
        id: ToolUseId::new("tu_1"),
        name: name.to_owned(),
        input: serde_json::json!({}),
    }
}

#[test]
fn history_shows_a_workflow_by_its_command_or_by_a_call_to_one_of_the_ten_tools() {
    assert!(history_shows_workflow(&[user_text("/workflow x")]));
    assert!(history_shows_workflow(&[assistant(vec![tool_use(
        "CreateWorkflow"
    )])]));
    assert!(history_shows_workflow(&[assistant(vec![tool_use(
        "ListWorkflowRuns"
    )])]));
}

#[test]
fn history_without_a_workflow_shows_none() {
    assert!(!history_shows_workflow(&[user_text("hello")]));
    assert!(!history_shows_workflow(&[assistant(vec![tool_use(
        "Bash"
    )])]));
    assert!(
        !history_shows_workflow(&[assistant(vec![ContentBlock::Text {
            text: "/workflow".to_owned(),
        }])]),
        "the assistant's own text is not the command"
    );
}

#[test]
fn an_always_on_or_activated_session_never_needs_a_restore() {
    let messages = [user_text("/workflow x")];
    assert_eq!(
        restore_plan(false, false, true, &messages),
        None,
        "alwaysOn: no entry, no backfill"
    );
    assert_eq!(
        restore_plan(true, true, false, &messages),
        None,
        "already active"
    );
}

#[test]
fn a_restore_reads_the_entry_first_and_backfills_from_history_once() {
    // The entry is the shortcut: it activates without a write.
    assert_eq!(
        restore_plan(true, false, true, &[]),
        Some((Source::ResumeEntry, false))
    );
    // With no entry, the history decides, and the entry is written back so the next restore need not rescan.
    assert_eq!(
        restore_plan(true, false, false, &[user_text("/workflow x")]),
        Some((Source::ResumeHistory, true))
    );
    // Neither: the session never had a workflow, so nothing is activated and nothing is written.
    assert_eq!(
        restore_plan(true, false, false, &[user_text("hello")]),
        None
    );
}

#[test]
fn a_command_activates_only_an_on_demand_session_that_is_not_active_yet() {
    assert!(activation_plan(true, false));
    assert!(!activation_plan(true, true), "already active");
    assert!(
        !activation_plan(false, false),
        "alwaysOn is active at birth"
    );
}

#[test]
fn the_entry_is_keyed_as_node_keys_it() {
    assert_eq!(
        entry_key(&SessionId::new("ses_a")),
        "ses_a:runtime-dynamic-workflow-activation"
    );
    assert_eq!(Source::Command.as_str(), "command");
    assert_eq!(Source::ResumeEntry.as_str(), "resume_entry");
    assert_eq!(Source::ResumeHistory.as_str(), "resume_history");
}
