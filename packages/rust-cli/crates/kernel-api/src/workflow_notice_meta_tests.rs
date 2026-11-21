//! W8d: the workflow notice payloads (Node `workflowNotification` and `workflowBlocked`).

use super::*;

#[test]
fn a_stopped_terminal_payload_carries_its_stop_reason_and_a_completed_one_does_not() {
    let stopped = terminal(&TerminalPayload {
        status: "stopped",
        stop_reason: Some("user"),
        subject: "Audit",
        result: None,
        result_is_prose: false,
        error: None,
    });
    assert_eq!(
        stopped,
        json!({"workflowNotification": {"kind": "terminal", "status": "stopped", "stopReason": "user", "summary": "Audit"}})
    );

    let completed = terminal(&TerminalPayload {
        status: "completed",
        stop_reason: Some("user"),
        subject: "Audit",
        result: Some("done"),
        result_is_prose: true,
        error: None,
    });
    assert_eq!(
        completed,
        json!({"workflowNotification": {"kind": "terminal", "status": "completed", "summary": "Audit", "result": "done", "resultForm": "prose"}})
    );
}

#[test]
fn a_terminal_result_over_4000_units_is_cut_and_marked_truncated() {
    let long = "a".repeat(4_001);
    let meta = terminal(&TerminalPayload {
        status: "completed",
        stop_reason: None,
        subject: "Audit",
        result: Some(&long),
        result_is_prose: false,
        error: Some(&"e".repeat(2_500)),
    });
    let payload = &meta["workflowNotification"];
    assert_eq!(payload["result"].as_str().map(str::len), Some(4_000));
    assert_eq!(payload["resultTruncated"], json!(true));
    assert_eq!(payload["resultForm"], json!("json"));
    assert_eq!(payload["error"].as_str().map(str::len), Some(2_000));
}

#[test]
fn the_bound_counts_utf16_units_and_never_splits_a_character() {
    // A character outside the BMP takes two units: 1999 units of "a" plus one such character is 2001 units.
    let text = format!("{}{}", "a".repeat(1_999), '\u{1F600}');
    assert_eq!(bound_units(&text, 2_000), "a".repeat(1_999));
}

#[test]
fn an_escalation_payload_carries_the_question_and_an_ask_time_only_when_finite() {
    let with_time = escalation(
        "q-1",
        "Scout",
        "Which file?",
        Some("ctx"),
        Some(1_700_000_000_000),
    );
    assert_eq!(
        with_time,
        json!({"workflowNotification": {"kind": "escalation", "qid": "q-1", "actor": "Scout", "question": "Which file?", "context": "ctx", "askedAt": 1_700_000_000_000u64}})
    );
    let without = escalation("q-1", "Scout", "Which file?", None, None);
    assert_eq!(
        without,
        json!({"workflowNotification": {"kind": "escalation", "qid": "q-1", "actor": "Scout", "question": "Which file?"}})
    );
}

#[test]
fn a_hole_payload_carries_the_ordinal_the_text_does_not() {
    let meta = hole(&HolePayload {
        site_id: "site-3",
        ordinal: 4,
        name: "plan",
        type_name: "Plan",
        prompt: Some("write it"),
        draft_path: None,
        line: Some(12),
        before: Some("scan"),
        after: None,
        reached_at: None,
    });
    assert_eq!(
        meta,
        json!({"workflowNotification": {"kind": "hole", "siteId": "site-3", "ordinal": 4, "name": "plan", "type": "Plan", "prompt": "write it", "line": 12, "before": "scan"}})
    );
}

#[test]
fn a_stall_payload_carries_its_time_and_cap_and_bounds_the_reason() {
    let meta = stall(1_200_000, Some(&"r".repeat(70)), Some(4));
    assert_eq!(meta["workflowNotification"]["sinceMs"], json!(1_200_000));
    assert_eq!(meta["workflowNotification"]["cap"], json!(4));
    assert_eq!(
        meta["workflowNotification"]["reason"]
            .as_str()
            .map(str::len),
        Some(64)
    );
}

#[test]
fn a_blocked_payload_uses_its_own_key_with_the_counts_and_the_longest_wait() {
    assert_eq!(
        blocked(2, 1, 900_000),
        json!({"workflowBlocked": {"questions": 2, "holes": 1, "sinceMs": 900_000}})
    );
}

#[test]
fn a_run_notice_takes_its_base_from_the_text_and_its_payload_from_the_fragment() {
    use crate::background_origin::origin_meta_for;

    let escalation_text = "[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<workflow-escalation>\n  <run-id>dwfrun-7</run-id>\n  <run>Audit</run>\n  <question-id>q-1</question-id>\n</workflow-escalation>";
    let fragment = escalation("q-1", "Scout", "Which file?", None, None);
    assert_eq!(
        origin_meta_for(escalation_text, None, Some(&fragment)),
        Some(json!({
            "backgroundSource": "workflow",
            "title": "Audit",
            "workId": "dwfrun-7",
            "workflowNotification": {"kind": "escalation", "qid": "q-1", "actor": "Scout", "question": "Which file?"},
        }))
    );
    // Without a fragment the base alone is the meta (a batch, or a message that is not one notice).
    assert_eq!(
        origin_meta_for(escalation_text, None, None),
        Some(json!({"backgroundSource": "workflow", "title": "Audit", "workId": "dwfrun-7"}))
    );
}

#[test]
fn a_terminal_run_notification_is_titled_by_its_description_and_keyed_by_its_task_id() {
    use crate::background_origin::origin_meta;

    let text = "<task-notification>\n<task-id>dwfrun-9</task-id>\n<status>completed</status>\n<description>Nightly &quot;sweep&quot;</description>\n<summary>Workflow &quot;Nightly &quot;sweep&quot;&quot; completed.</summary>\n</task-notification>";
    assert_eq!(
        origin_meta(text),
        Some(
            json!({"backgroundSource": "workflow", "title": "Nightly \"sweep\"", "workId": "dwfrun-9"})
        )
    );
}

#[test]
fn a_payload_is_not_grafted_onto_another_sources_meta() {
    use crate::background_origin::origin_meta_for;
    let subagent = "<task-notification><task-id>agent_1</task-id><summary>Agent \"Check\" completed</summary></task-notification>";
    let meta = origin_meta_for(subagent, None, Some(&blocked(1, 0, 5))).expect("the subagent meta");
    assert_eq!(meta["backgroundSource"], "subagent");
    assert!(meta.get("workflowBlocked").is_none(), "{meta}");
}

#[test]
fn a_terminal_block_parses_the_same_after_telemetry_splits_off_its_marker() {
    use crate::background_origin::origin_meta;
    let whole = "<task-notification>\n<task-id>dwfrun-9</task-id>\n<status>completed</status>\n<description>Audit</description>\n<summary>Workflow &quot;Audit&quot; completed.</summary>\n</task-notification>";
    let split = whole.trim_start_matches("<task-notification>");
    assert!(origin_meta(split).is_some());
    assert_eq!(origin_meta(split), origin_meta(whole));
}

/// 9.56: the stored shape maps back to the stall execution and the payload fragment, and nothing else.
#[test]
fn a_stored_origin_meta_replays_its_execution_and_its_payload_and_nothing_else() {
    let stored = json!({
        "backgroundSource": "workflow",
        "title": "Audit",
        "workId": "dwfrun-7",
        "workflowNotification": {"kind": "hole", "siteId": "site-3", "ordinal": 4},
        "workflowBlocked": {"questions": 1, "holes": 0, "sinceMs": 5},
        "subagentStall": {"noProgressForMs": 900000, "lastProgressAt": 1, "executionId": "3"},
    });
    let (execution, workflow) = replay_from_origin_meta(&stored);
    assert_eq!(execution.as_deref(), Some("3"));
    assert_eq!(
        workflow,
        Some(json!({
            "workflowNotification": {"kind": "hole", "siteId": "site-3", "ordinal": 4},
            "workflowBlocked": {"questions": 1, "holes": 0, "sinceMs": 5},
        }))
    );
}

/// 9.56: a non-string execution or a non-object payload replays as absent, and a meta with neither replays nothing.
#[test]
fn a_non_string_execution_or_a_non_object_payload_replays_as_absent() {
    let stored = json!({
        "backgroundSource": "workflow",
        "workflowNotification": "not an object",
        "subagentStall": {"executionId": 3},
    });
    assert_eq!(replay_from_origin_meta(&stored), (None, None));
    assert_eq!(
        replay_from_origin_meta(&json!({"title": "Plain"})),
        (None, None)
    );
}
