//! W8d (9.51): the terminal notice of a settled run. The text is Node's `formatLocalWorkflowTaskNotification`; the payload is
//! Node's `workflowNotification` terminal branch.

use rust_cli_workflow::model::{Caps, RunRow, RunStatus, StopReason};
use serde_json::json;

use super::terminal_notice as terminal_notice_with;
use rust_cli_workflow::quota_resume::quota_resume_at;

/// The notice of a run whose quota resume the module would arm (`quota_resume_at`), as the service decides it.
fn terminal_notice(row: &RunRow) -> Option<super::TerminalNotice> {
    terminal_notice_with(row, quota_resume_at(row).is_some())
}

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
    // Node `formatIncomingMessage(.., "task_notification")`: the background-task preamble, then the envelope (9.61).
    let envelope = notice
        .text
        .strip_prefix(rust_cli_prompts::agents::notification_preamble())
        .expect("the terminal notice opens with the background-task preamble");
    assert!(envelope.starts_with(
        "<task-notification>\n<task-id>dwfrun-1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>"
    ));
    assert!(
        notice
            .text
            .contains("<result>{\n  &quot;n&quot;: 2\n}</result>")
    );
    assert_eq!(
        notice.workflow,
        json!({"workflowNotification": {"kind": "terminal", "status": "completed", "summary": "Audit", "result": "{\n  \"n\": 2\n}", "resultForm": "json"}})
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
}

/// Fork (9.61): the completion card's time cell reads `durationMs` (Node `workflowNotificationDurationMs`, this
/// incarnation's settled-at minus started-at). An unknown duration leaves the key out, never 0.
#[test]
fn the_terminal_payload_carries_the_runs_wall_clock_duration() {
    let mut settled = row(RunStatus::Completed);
    settled.result = Some(json!("done"));
    let notice = super::with_duration(
        terminal_notice(&settled).expect("a completed run has a notice"),
        super::run_duration_ms(1_000, Some(3_500)),
    );
    assert_eq!(notice.workflow["workflowNotification"]["durationMs"], 2_500);
    let unknown = super::with_duration(
        terminal_notice(&settled).expect("a completed run has a notice"),
        super::run_duration_ms(0, Some(3_500)),
    );
    assert!(
        unknown.workflow["workflowNotification"]
            .get("durationMs")
            .is_none()
    );
    assert_eq!(super::run_duration_ms(4_000, Some(3_500)), None);
    assert_eq!(super::run_duration_ms(1_000, None), None);
}

#[test]
fn the_terminal_payload_carries_the_runs_artifact_chips_primary_first_and_bounded() {
    let base = terminal_notice(&row(RunStatus::Completed)).expect("a completed run posts");
    let mut published = vec![
        json!({"id": "notes", "kind": "markdown", "version": 2, "title": " E2E notes ", "contentType": "text/markdown", "bytes": 40}),
        json!({"id": "odd", "kind": "video", "version": 1}),
        json!({"id": "board", "kind": "board", "version": 1, "primary": true, "description": " the board "}),
    ];
    for index in 0..8 {
        published.push(json!({"id": format!("f{index}"), "kind": "file", "version": 1}));
    }
    let notice = super::with_artifacts(base.clone(), Some(&json!(published)));
    let meta = &notice.workflow["workflowNotification"];
    let chips = meta["artifacts"].as_array().expect("chips");
    assert_eq!(chips.len(), 8);
    assert_eq!(
        chips[0],
        json!({"id": "board", "kind": "board", "version": 1, "primary": true, "description": "the board"})
    );
    assert_eq!(
        chips[1],
        json!({"id": "notes", "kind": "markdown", "version": 2, "title": "E2E notes", "contentType": "text/markdown"})
    );
    assert_eq!(chips[2]["id"], "f0");
    assert_eq!(meta["artifactsTruncated"], true);

    let two = super::with_artifacts(
        base.clone(),
        Some(
            &json!([{"id": "a", "kind": "file", "version": 1}, {"id": "b", "kind": "file", "version": 3}]),
        ),
    );
    assert_eq!(
        two.workflow["workflowNotification"]["artifacts"]
            .as_array()
            .map(Vec::len),
        Some(2)
    );
    assert!(
        two.workflow["workflowNotification"]
            .get("artifactsTruncated")
            .is_none()
    );

    let none = super::with_artifacts(base.clone(), Some(&json!([])));
    assert_eq!(none, base);
    assert_eq!(super::with_artifacts(base.clone(), None), base);
}
