//! Review (ocr on #596): the edge branches of the blocked reminder and the arithmetic at the top of the range. The expected
//! texts are Node's `formatWorkflowBlockedNotification` (`runtime-task/workflow-notification-copy.ts`) for the same input.

use super::*;

fn question(qid: &str, question: &str, waited_ms: u64) -> BlockedQuestion {
    BlockedQuestion {
        qid: qid.into(),
        subagent: "scout@3".into(),
        question: question.into(),
        context: None,
        waited_ms,
    }
}

#[test]
fn a_final_hole_reminder_without_a_draft_matches_node_text() {
    let holes = [BlockedHole {
        site_id: "h1".into(),
        name: "fill".into(),
        type_name: "string".into(),
        line: None,
        waited_ms: 0,
    }];
    let text = blocked(&Blocked {
        run_label: "dwfrun-7",
        run_id: "dwfrun-7",
        ordinal: 2,
        total: 2,
        questions: &[],
        holes: &holes,
        draft_path: None,
    });
    let expected = [
        "[SYSTEM NOTIFICATION - NOT USER INPUT]",
        "This is an automated workflow event, NOT a message from the user.",
        "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
        "",
        "<workflow-blocked>",
        "  <run-id>dwfrun-7</run-id>",
        "  <run>dwfrun-7</run>",
        "  <reminder>2 of 2</reminder>",
        "  <open-holes count=\"1\" shown=\"1\">",
        "    <hole id=\"h1\" name=\"fill\" type=\"string\" waited-ms=\"0\"/>",
        "  </open-holes>",
        "</workflow-blocked>",
        "",
        "Workflow run dwfrun-7 (dwfrun-7) is still waiting on you: 1 hole is open, for 1 minutes, and you have not acted on it since your last turn ended.",
        "Next step for each hole: read the run's script with GetWorkflowRun (run_id=\"dwfrun-7\") for the context, write only the statements of the hole's function returning its type, and call FillWorkflowHole with run_id=\"dwfrun-7\" and its id as hole_id and the body as `script`.",
        "If a decision needs the user, tell the user exactly what you need from them and end your turn; do not guess an answer to make the reminders stop.",
        "This is the last reminder: nothing further is sent until the user writes or this run's open decisions change.",
        "Either way the parked branches keep waiting; nothing times out on their behalf.",
    ]
    .join("\n");
    assert_eq!(text, expected);
}

#[test]
fn a_reminder_that_is_not_the_last_says_one_more_follows() {
    let questions = [question("q1", "why?", 0)];
    let text = blocked(&Blocked {
        run_label: "r",
        run_id: "r",
        ordinal: 1,
        total: 2,
        questions: &questions,
        holes: &[],
        draft_path: None,
    });
    assert!(
        text.contains("One more reminder follows if nothing changes.\n"),
        "{text}"
    );
    assert!(!text.contains("This is the last reminder"), "{text}");
}

#[test]
fn more_than_eight_open_questions_list_eight_and_point_at_get_workflow_run() {
    let questions: Vec<BlockedQuestion> = (0..9)
        .map(|index| question(&format!("q{index}"), "x", 0))
        .collect();
    let text = blocked(&Blocked {
        run_label: "dwfrun-7",
        run_id: "dwfrun-7",
        ordinal: 1,
        total: 1,
        questions: &questions,
        holes: &[],
        draft_path: None,
    });
    assert!(
        text.contains("<open-questions count=\"9\" shown=\"8\">"),
        "{text}"
    );
    assert!(
        text.contains("<question id=\"q7\""),
        "the eighth is listed: {text}"
    );
    assert!(
        !text.contains("<question id=\"q8\""),
        "the ninth is not listed: {text}"
    );
    assert!(
        text.contains("GetWorkflowRun lists the ones not shown here (run_id=\"dwfrun-7\")."),
        "{text}"
    );
    assert!(text.contains("9 questions are open"), "{text}");
}

#[test]
fn a_question_text_over_two_thousand_units_is_cut_and_ends_in_an_ellipsis() {
    let long = "a".repeat(2_500);
    let questions = [question("q1", &long, 0)];
    let text = blocked(&Blocked {
        run_label: "r",
        run_id: "r",
        ordinal: 1,
        total: 1,
        questions: &questions,
        holes: &[],
        draft_path: None,
    });
    let cut = format!("{}…", "a".repeat(1_999));
    assert!(text.contains(&format!("<text>{cut}</text>")), "{text}");
}

#[test]
fn a_question_text_of_exactly_two_thousand_units_is_not_cut() {
    let exact = "a".repeat(2_000);
    let questions = [question("q1", &exact, 0)];
    let text = blocked(&Blocked {
        run_label: "r",
        run_id: "r",
        ordinal: 1,
        total: 1,
        questions: &questions,
        holes: &[],
        draft_path: None,
    });
    assert!(text.contains(&format!("<text>{exact}</text>")), "{text}");
}

/// Node cuts at UTF-16 unit 1999 and so splits the astral character at the boundary (a lone surrogate). A Rust string
/// cannot hold a lone surrogate, so the cut keeps the whole characters before it: divergence 365 of 9.38.
#[test]
fn a_cut_that_would_split_an_astral_character_keeps_the_character_whole() {
    let text_in = format!("{}😀b", "a".repeat(1_998));
    let questions = [question("q1", &text_in, 0)];
    let text = blocked(&Blocked {
        run_label: "r",
        run_id: "r",
        ordinal: 1,
        total: 1,
        questions: &questions,
        holes: &[],
        draft_path: None,
    });
    let expected = format!("<text>{}…</text>", "a".repeat(1_998));
    assert!(text.contains(&expected), "{text}");
}

#[test]
fn a_stall_at_the_top_of_the_range_does_not_overflow_its_minutes() {
    let text = stall(&Stall {
        run_label: "r",
        run_id: "r",
        since_ms: u64::MAX,
        reason: None,
        cap: None,
    });
    assert!(
        text.contains("has not completed a model request in 307445734561825 minutes;"),
        "{text}"
    );
}

#[test]
fn a_blocked_notice_at_the_top_of_the_range_does_not_overflow_its_minutes() {
    let questions = [question("q1", "x", u64::MAX)];
    let text = blocked(&Blocked {
        run_label: "r",
        run_id: "r",
        ordinal: 1,
        total: 1,
        questions: &questions,
        holes: &[],
        draft_path: None,
    });
    assert!(text.contains("for 307445734561825 minutes,"), "{text}");
}
