//! W7-7c: the model-visible workflow notices (Node `workflow-notification-copy.ts`). The texts are Node's, byte for byte
//! for the parts that do not depend on the run's label.

use super::*;

#[test]
fn a_stall_notice_names_the_minutes_the_reason_and_the_fan_out() {
    let text = stall(&Stall {
        run_label: "dwfrun-7",
        run_id: "dwfrun-7",
        since_ms: 1_200_000,
        reason: Some("rate_limit"),
        cap: Some(4),
    });
    let expected = "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated workflow event, NOT a message from the user.\nDo NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\n\n<workflow-stall>\n  <run-id>dwfrun-7</run-id>\n  <run>dwfrun-7</run>\n  <since-ms>1200000</since-ms>\n  <dominant-reason>rate_limit</dominant-reason>\n  <cap>4</cap>\n</workflow-stall>\n\nWorkflow run dwfrun-7 (dwfrun-7) has not completed a model request in 20 minutes; the provider keeps answering rate_limit and the run is retrying with backoff (current fan-out 4).\nIt is still running and needs nothing from you. Tell the user if they are waiting on it; they can stop it from the run card. Do not cancel or rebuild it on your own.";
    assert_eq!(text, expected);
}

#[test]
fn a_stall_notice_without_a_reason_says_the_provider_keeps_failing() {
    let text = stall(&Stall {
        run_label: "run",
        run_id: "dwfrun-1",
        since_ms: 10,
        reason: None,
        cap: None,
    });
    assert!(
        text.contains(
            "has not completed a model request in 1 minutes; the provider keeps failing requests and the run is retrying with backoff."
        ),
        "{text}"
    );
    assert!(!text.contains("<dominant-reason>"));
    assert!(!text.contains("<cap>"));
}

#[test]
fn an_escalation_notice_carries_the_next_step_with_the_question_id() {
    let text = escalation(&Escalation {
        run_label: "dwfrun-7",
        run_id: "dwfrun-7",
        qid: "dwfq-1-1",
        actor: "scout@3",
        question: "Which branch?",
        context: Some("tried main"),
    });
    assert!(
        text.contains(
            "<workflow-escalation>\n  <run-id>dwfrun-7</run-id>\n  <run>dwfrun-7</run>\n  <question-id>dwfq-1-1</question-id>\n  <subagent>scout@3</subagent>\n  <question>Which branch?</question>\n  <context>tried main</context>\n</workflow-escalation>"
        ),
        "{text}"
    );
    assert!(
        text.contains(
            "Subagent scout@3 in workflow run dwfrun-7 (dwfrun-7) escalated a blocking question and is parked on that call waiting for your answer.\nNext step: call ResolveWorkflowQuestion with question_id=\"dwfq-1-1\" and your answer.\n"
        ),
        "{text}"
    );
}

#[test]
fn escaping_covers_the_five_xml_characters_node_escapes() {
    assert_eq!(escape_xml("a<b>&'\"c"), "a&lt;b&gt;&amp;&apos;&quot;c");
}

#[test]
fn a_notice_over_the_task_notification_limit_is_cut_and_marked() {
    let long = "x".repeat(TASK_NOTIFICATION_MAX_UNITS + 10);
    let text = truncate_task_notification(&long);
    assert!(text.ends_with("\n[truncated]"));
    assert_eq!(
        text.len(),
        TASK_NOTIFICATION_MAX_UNITS + "\n[truncated]".len()
    );
}

#[test]
fn a_blocked_notice_lists_the_open_decisions_and_the_next_steps() {
    let questions = [BlockedQuestion {
        qid: "dwfq-1-1".into(),
        subagent: "scout@3".into(),
        question: "Which branch?".into(),
        context: None,
        waited_ms: 20 * 60_000,
    }];
    let holes = [BlockedHole {
        site_id: "h1".into(),
        name: "fill".into(),
        type_name: "string".into(),
        line: Some(12),
        waited_ms: 0,
    }];
    let text = blocked(&Blocked {
        run_label: "dwfrun-7",
        run_id: "dwfrun-7",
        ordinal: 1,
        total: 2,
        questions: &questions,
        holes: &holes,
        draft_path: Some("/d/draft.ts"),
    });
    assert!(text.contains("<reminder>1 of 2</reminder>"), "{text}");
    assert!(
        text.contains("<open-questions count=\"1\" shown=\"1\">"),
        "{text}"
    );
    assert!(
        text.contains(
            "<hole id=\"h1\" name=\"fill\" type=\"string\" line=\"12\" waited-ms=\"0\"/>"
        ),
        "{text}"
    );
    assert!(
        text.contains(
            "is still waiting on you: 1 question and 1 hole are open, the oldest for 20 minutes"
        ),
        "{text}"
    );
    assert!(
        text.contains("call ResolveWorkflowQuestion with its id as question_id and your answer."),
        "{text}"
    );
    assert!(
        text.contains("read the draft at /d/draft.ts for the context"),
        "{text}"
    );
    assert!(
        text.ends_with(
            "Either way the parked branches keep waiting; nothing times out on their behalf."
        ),
        "{text}"
    );
}
