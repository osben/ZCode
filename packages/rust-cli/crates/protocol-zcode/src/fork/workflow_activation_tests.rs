//! The on-demand activation rules (specs/fork-rust-workflow-engine.md, 9.44, W7-11; closes 54 and 318). Pure decisions:
//! the composition reads the record, the entries and the history, then does what these return.

use rust_cli_kernel_api::ids::{MessageId, ToolUseId};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, Message, StopReason, UserMessage, UserOrigin,
};

use super::{
    KIND, Source, activation_plan, entry_key, history_shows_workflow, is_workflow_command,
    on_command, on_resume, restore_plan_for,
};

/// The decision over a history, read as its fact (the snapshot path of a resume reads it the same way).
fn restore_plan(
    on_demand: bool,
    activated: bool,
    has_entry: bool,
    messages: &[Message],
) -> Option<(Source, bool)> {
    restore_plan_for(
        on_demand,
        activated,
        has_entry,
        history_shows_workflow(messages),
    )
}
use rust_cli_kernel_api::dynamic_workflow::DynamicWorkflowGate;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::FrontendRecord;
use serde_json::json;

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

#[test]
fn the_command_splits_on_javascript_whitespace_not_rust_whitespace() {
    // Node's `\s` and `trim` take U+FEFF (a BOM) and not U+0085; Rust's `is_whitespace` is the other way round.
    assert!(
        is_workflow_command("/workflow\u{FEFF}build"),
        "a BOM after the word is whitespace to Node"
    );
    assert!(
        is_workflow_command("\u{FEFF}/workflow build"),
        "a leading BOM is trimmed by Node's trim"
    );
    assert!(
        !is_workflow_command("/workflow\u{85}build"),
        "U+0085 is not whitespace to Node's \\s"
    );
}

/// A session the store holds (a row, so its records can be written: divergence 495). Made through the legacy create with
/// immediate persistence, as the Host's create does.
async fn stored_session(server: &crate::server::Server, id: &str) -> SessionId {
    let mut params = crate::fork::legacy_session::tests::automation_create(id);
    params["persistence"] = json!("immediate");
    crate::fork::legacy_session::tests::call(server, "session/create", params)
        .await
        .expect("the session is created");
    SessionId::new(id)
}

/// The activation entry rows the session holds.
async fn entry_rows(server: &crate::server::Server, session: &SessionId) -> Vec<serde_json::Value> {
    server
        .kernel
        .queries()
        .records(session, KIND)
        .await
        .expect("the records read")
        .into_iter()
        .map(|record| record.data)
        .collect()
}

#[tokio::test]
async fn a_cold_resume_activates_from_its_entry_and_leaves_the_entry_alone() {
    let (_scope, server, _kernel) = crate::fork::legacy_session::tests::server();
    let session = stored_session(&server, "ses_entry").await;
    server.record_dynamic_workflow_gate(
        &session,
        DynamicWorkflowGate {
            enabled: true,
            tools_on_demand: true,
        },
    );
    let record = FrontendRecord {
        kind: KIND.to_owned(),
        key: entry_key(&session),
        data: json!({"activated": true, "source": "command"}),
    };
    server
        .kernel
        .queries()
        .put_record(&session, &record)
        .await
        .expect("stored");
    on_resume(&server, &session).await;
    assert!(server.dynamic_workflow_activated(&session));
    assert_eq!(
        entry_rows(&server, &session).await,
        [json!({"activated": true, "source": "command"})],
        "the entry is the source of the activation and is not rewritten"
    );
}

#[tokio::test]
async fn a_cold_resume_with_no_entry_and_no_workflow_in_the_history_does_not_activate() {
    let (_scope, server, _kernel) = crate::fork::legacy_session::tests::server();
    let session = stored_session(&server, "ses_plain").await;
    server.record_dynamic_workflow_gate(
        &session,
        DynamicWorkflowGate {
            enabled: true,
            tools_on_demand: true,
        },
    );
    on_resume(&server, &session).await;
    assert!(!server.dynamic_workflow_activated(&session));
    assert!(entry_rows(&server, &session).await.is_empty());
}

#[tokio::test]
async fn a_closed_gate_never_activates_even_with_an_entry() {
    let (_scope, server, _kernel) = crate::fork::legacy_session::tests::server();
    let session = stored_session(&server, "ses_closed").await;
    server.record_dynamic_workflow_gate(
        &session,
        DynamicWorkflowGate {
            enabled: false,
            tools_on_demand: true,
        },
    );
    let record = FrontendRecord {
        kind: KIND.to_owned(),
        key: entry_key(&session),
        data: json!({"activated": true, "source": "command"}),
    };
    server
        .kernel
        .queries()
        .put_record(&session, &record)
        .await
        .expect("stored");
    on_resume(&server, &session).await;
    on_command(&server, &session).await;
    assert!(!server.dynamic_workflow_activated(&session));
}

#[tokio::test]
async fn the_command_activates_an_on_demand_session_and_writes_its_entry_once() {
    let (_scope, server, _kernel) = crate::fork::legacy_session::tests::server();
    let session = stored_session(&server, "ses_command").await;
    server.record_dynamic_workflow_gate(
        &session,
        DynamicWorkflowGate {
            enabled: true,
            tools_on_demand: true,
        },
    );
    on_command(&server, &session).await;
    on_command(&server, &session).await;
    assert!(server.dynamic_workflow_activated(&session));
    assert_eq!(
        entry_rows(&server, &session).await,
        [json!({"activated": true, "source": "command"})],
        "the second command finds the session active and writes nothing"
    );
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
        workflow_meta: None,
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
