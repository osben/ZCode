//! W8b (9.49): the hole notice's text against Node `formatWorkflowHoleNotification` (`workflow-notification-copy.ts`).
//! The expected texts are Node's template, line by line.

use super::{Hole, hole};

const BANNER: [&str; 4] = [
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated workflow event, NOT a message from the user.",
    "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    "",
];

fn full<'a>() -> Hole<'a> {
    Hole {
        run_label: "Refactor",
        run_id: "dwfrun-7",
        hole_id: "scout",
        name: "Plan",
        type_name: "Plan",
        prompt: Some("Draft the plan"),
        draft_path: Some("/w/run.js"),
        line: Some(12),
        before: Some("survey"),
        after: Some("write"),
    }
}

fn expected_tail(where_clause: &str, next_step: &str) -> String {
    let mut lines: Vec<String> = vec!["</workflow-hole>".into()];
    lines.push(String::new());
    lines.push(format!(
        "Workflow run Refactor (dwfrun-7) reached the hole \"Plan\" (scout){where_clause} and is waiting for you to write its body."
    ));
    lines.push(next_step.to_owned());
    lines.push("The body is compiled where the hole stands and sees every binding declared before it; it must return a value of type `Plan` — or, when the next step is not known yet, do one step and end with a new tail hole of the same type named for the next step (`return await hole<Plan>(\"…\", …)`); the last fill returns. Write only the statements — not the hole call, not an arrow, not the script around it.".into());
    lines.push("Only this branch of the script is parked — every other subagent and the rest of the control flow keep going. So do not drop what you are doing, but do not leave it unfilled either: nothing times out on its behalf.".into());
    lines.push("If this notification is ever lost, GetWorkflowRun lists the holes this run is still waiting at.".into());
    lines.join("\n")
}

#[test]
fn a_hole_between_two_phases_with_a_draft_matches_node_text() {
    let text = hole(&full());
    let mut head: Vec<String> = BANNER.iter().map(|line| (*line).to_owned()).collect();
    head.extend(
        [
            "<workflow-hole>",
            "  <run-id>dwfrun-7</run-id>",
            "  <run>Refactor</run>",
            "  <hole-id>scout</hole-id>",
            "  <name>Plan</name>",
            "  <type>Plan</type>",
            "  <prompt>Draft the plan</prompt>",
            "  <draft>/w/run.js</draft>",
            "  <line>12</line>",
            "  <before>survey</before>",
            "  <after>write</after>",
        ]
        .map(str::to_owned),
    );
    let expected = format!(
        "{}\n{}",
        head.join("\n"),
        expected_tail(
            " between phases \"survey\" and \"write\"",
            "Next step: Read the draft at /w/run.js (the hole is on line 12) for the context, write the statements of the hole's function, and call FillWorkflowHole with run_id=\"dwfrun-7\" and hole_id=\"scout\" and the body as `script`.",
        )
    );
    assert_eq!(text, expected);
}

#[test]
fn without_a_draft_the_next_step_points_at_get_workflow_run() {
    let mut input = full();
    input.draft_path = None;
    input.line = None;
    let text = hole(&input);
    assert!(
        text.contains("Next step: Read the run's script with GetWorkflowRun for the context, write the statements"),
        "{text}"
    );
    assert!(!text.contains("<draft>"), "{text}");
    assert!(!text.contains("<line>"), "{text}");
}

#[test]
fn only_a_before_phase_or_only_an_after_phase_is_named_as_such() {
    let mut before_only = full();
    before_only.after = None;
    let text = hole(&before_only);
    assert!(
        text.contains("reached the hole \"Plan\" (scout) after phase \"survey\" and is waiting"),
        "{text}"
    );

    let mut after_only = full();
    after_only.before = None;
    let text = hole(&after_only);
    assert!(
        text.contains("reached the hole \"Plan\" (scout) before phase \"write\" and is waiting"),
        "{text}"
    );
    assert!(!text.contains("<before>"), "{text}");
}

#[test]
fn an_empty_prompt_is_omitted_and_markup_in_the_text_is_escaped() {
    let mut input = full();
    input.prompt = Some("");
    input.name = "<x>";
    let text = hole(&input);
    assert!(!text.contains("<prompt>"), "{text}");
    assert!(text.contains("  <name>&lt;x&gt;</name>"), "{text}");
}

#[test]
fn a_hole_text_over_the_task_notification_limit_is_cut_and_marked() {
    let mut input = full();
    let long = "a".repeat(130_000);
    input.prompt = Some(long.as_str());
    let text = hole(&input);
    assert!(text.ends_with("\n[truncated]"), "truncated text is marked");
    assert!(text.chars().count() < 121_000, "cut at the limit");
}
