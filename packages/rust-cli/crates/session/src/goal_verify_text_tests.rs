use super::{Facts, parse, prompt};

#[test]
fn the_prompt_is_node_text_with_the_escaped_objective_and_state() {
    let text = prompt(&Facts {
        objective: "ship <it> & test",
        status: "active",
        tokens_used: 34,
        time_used_seconds: 12,
    });
    assert!(text.starts_with("Verify whether the active session goal is actually complete.\n\nThis is a verification request only."));
    assert!(text.contains("<untrusted_objective>\nship &lt;it&gt; &amp; test\n</untrusted_objective>\n\nGoal state:\n- Status before verification: active\n- Tokens used: 34\n- Token budget: none\n- Time used: 12 seconds\n\nUse the conversation context"));
    assert!(text.ends_with("When passing, nextAction may be an empty string."));
}

#[test]
fn replies_parse_like_node() {
    let verdict =
        parse(r#"{"passed": false, "reason": " tests fail ", "nextAction": " run them "}"#);
    assert_eq!(
        (
            verdict.passed,
            verdict.reason.as_str(),
            verdict.next_action.as_deref()
        ),
        (false, "tests fail", Some("run them"))
    );
    // Only the boolean true passes; an empty reason takes Node's fallback; an empty next action is absent.
    let verdict = parse(r#"Here: {"passed": "true", "reason": "", "nextAction": ""} done"#);
    assert!(!verdict.passed);
    assert_eq!(
        verdict.reason,
        "The completion verifier could not confirm that every goal requirement is complete."
    );
    assert_eq!(verdict.next_action, None);
    // A Markdown fence and a JSON string.
    assert!(parse("```json\n{\"passed\": true, \"reason\": \"ok\"}\n```").passed);
    let encoded = serde_json::to_string("{\"passed\": true, \"reason\": \"ok\"}").unwrap();
    assert!(parse(&encoded).passed);
}

#[test]
fn a_reply_that_is_not_json_fails_open() {
    let verdict = parse("I think it is done");
    assert!(verdict.passed);
    assert_eq!(
        verdict.reason,
        "The completion verifier did not return valid JSON."
    );
    assert!(parse("[1, 2]").passed);
}
