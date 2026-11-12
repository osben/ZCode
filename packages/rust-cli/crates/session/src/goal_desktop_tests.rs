use super::{Budget, continuation};

const BUDGET: Budget = Budget {
    time_used_seconds: 12,
    tokens_used: 34,
};

#[test]
fn the_first_continuation_names_the_escaped_objective_and_the_budget() {
    let text = continuation("ship <it> & test", &BUDGET, None);
    assert!(text.starts_with(
        "<system-reminder>\nContinue working toward the active session goal.\n\nThe objective"
    ));
    assert!(
        text.contains("<untrusted_objective>\nship &lt;it&gt; &amp; test\n</untrusted_objective>")
    );
    assert!(text.contains("- Time spent pursuing goal: 12 seconds\n- Tokens used: 34\n- Token budget: none\n- Tokens remaining: unbounded"));
    assert!(text.ends_with(
        "update the goal status only if every requirement is complete.\n</system-reminder>"
    ));
}

#[test]
fn a_not_met_evaluation_leads_with_the_next_action() {
    let text = continuation("goal", &BUDGET, Some(("tests fail", " fix the test ")));
    assert!(text.starts_with(
        "<system-reminder>\nContinue working toward the active session goal. fix the test\n\nCompletion verifier result:\nReason: tests fail\nNext action: fix the test\n"
    ));
}

#[test]
fn an_empty_next_action_is_the_plain_continuation() {
    let text = continuation("goal", &BUDGET, Some(("why", "  ")));
    assert!(!text.contains("Completion verifier result:"));
}
