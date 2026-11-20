//! W8d (9.51): the terminal notice of a settled run. The text is Node's `formatLocalWorkflowTaskNotification`; the payload is
//! Node's `workflowNotification` terminal branch.

use rust_cli_workflow::model::{Caps, RunRow, RunStatus, StopReason};
use serde_json::{Value, json};

use super::terminal_notice;

fn row(status: RunStatus) -> RunRow {
    RunRow {
        run_id: "dwfrun-1".into(),
        parent_session_id: Some("sess-parent".into()),
        cwd: None,
        name: Some("Audit".into()),
        tool_call_id: Some("toolu_1".into()),
        script_text: None,
        script_hash: None,
        args: None,
        resumed_from: None,
        caps: Caps::default(),
        spent_tokens: 0.0,
        status,
        stop_reason: None,
        superseded_by: None,
        failure: None,
        result: None,
    }
}

#[test]
fn a_completed_run_posts_its_result_to_the_parent_with_the_terminal_payload() {
    let mut settled = row(RunStatus::Completed);
    settled.result = Some(json!({"n": 2}));
    let notice = terminal_notice(&settled).expect("a completed run has a notice");
    assert_eq!(notice.parent_session_id, "sess-parent");
    assert!(notice.text.starts_with(
        "<task-notification>\n<task-id>dwfrun-1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>"
    ));
    assert!(notice.text.contains("<result>{&quot;n&quot;:2}</result>"));
    assert_eq!(
        notice.workflow,
        json!({"workflowNotification": {"kind": "terminal", "status": "completed", "summary": "Audit", "result": "{\"n\":2}", "resultForm": "json"}})
    );
}

#[test]
fn an_errored_run_carries_its_message_as_the_error_in_text_and_payload() {
    let mut settled = row(RunStatus::Errored);
    settled.failure = Some(json!({"code": "Script", "message": "boom"}));
    let notice = terminal_notice(&settled).expect("an errored run has a notice");
    assert!(notice.text.contains("<error>boom</error>"));
    assert_eq!(
        notice.workflow["workflowNotification"]["error"],
        json!("boom")
    );
}

#[test]
fn a_quota_provider_stop_is_a_block_and_says_the_run_resumes_by_itself() {
    let mut settled = row(RunStatus::Stopped);
    settled.stop_reason = Some(StopReason::Provider);
    settled.failure = Some(json!({
        "code": "ProviderStop",
        "message": "usage cap reached",
        "providerStop": {
            "kind": "quota",
            "providerId": "chatgpt",
            "subagent": "scout",
            "resetAt": 1_800_000_000_000u64,
            "providerCode": "usage_limit"
        }
    }));
    let notice = terminal_notice(&settled).expect("a provider stop has a notice");
    assert!(notice.text.contains("<error>\n"));
    assert!(notice.text.contains("chatgpt"));
    assert!(
        notice
            .text
            .contains("The run resumes by itself after the usage cap resets")
    );
    // The payload keeps the raw message, not the copy table's block (Node `error: snapshot.error`).
    assert_eq!(
        notice.workflow["workflowNotification"]["error"],
        json!("usage cap reached")
    );
}

#[test]
fn a_superseded_run_posts_nothing() {
    let mut settled = row(RunStatus::Stopped);
    settled.stop_reason = Some(StopReason::Superseded);
    assert_eq!(terminal_notice(&settled), None);
}

#[test]
fn a_run_that_is_not_terminal_posts_nothing() {
    assert_eq!(terminal_notice(&row(RunStatus::Running)), None);
    assert_eq!(terminal_notice(&row(RunStatus::Pending)), None);
}

#[test]
fn a_run_without_a_parent_session_posts_nothing_and_an_unnamed_run_is_titled_by_its_id() {
    let mut orphan = row(RunStatus::Completed);
    orphan.parent_session_id = None;
    assert_eq!(terminal_notice(&orphan), None);

    let mut unnamed = row(RunStatus::Completed);
    unnamed.name = None;
    let notice = terminal_notice(&unnamed).expect("an unnamed completed run has a notice");
    assert!(
        notice
            .text
            .contains("<summary>Workflow &quot;dwfrun-1&quot; completed.</summary>")
    );
    assert_eq!(
        notice.workflow,
        json!({"workflowNotification": {"kind": "terminal", "status": "completed", "summary": "dwfrun-1"}}),
    );
    let _: Value = notice.workflow;
}
