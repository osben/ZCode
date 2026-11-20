//! Tests of the `v4/conversation/workflowRuns` params (Node `v4ConversationWorkflowRunsParamsSchema`, strict).

use serde_json::json;

use super::{DEFAULT_LIMIT, SessionRunsParams, parse};

#[test]
fn the_session_and_workspace_are_required_and_the_default_limit_is_16() {
    assert_eq!(
        parse(&json!({"workspace": {"kind": "local"}, "sessionId": "ses_p"})),
        Ok(SessionRunsParams {
            session_id: "ses_p".to_owned(),
            limit: DEFAULT_LIMIT,
        })
    );
    assert_eq!(DEFAULT_LIMIT, 16);
    assert_eq!(
        parse(&json!({"sessionId": "ses_p"}))
            .expect_err("no workspace")
            .code,
        -32602
    );
    assert_eq!(
        parse(&json!({"workspace": {}, "sessionId": ""}))
            .expect_err("empty session")
            .code,
        -32602
    );
}

#[test]
fn a_limit_is_a_positive_integer_up_to_64() {
    let with = |limit: serde_json::Value| {
        parse(&json!({"workspace": {}, "sessionId": "ses_p", "limit": limit}))
    };
    assert_eq!(with(json!(1)).map(|p| p.limit), Ok(1));
    assert_eq!(with(json!(64)).map(|p| p.limit), Ok(64));
    assert_eq!(
        with(json!(2.0)).map(|p| p.limit),
        Ok(2),
        "2.0 is an integer in JSON"
    );
    for bad in [
        json!(0),
        json!(65),
        json!(-1),
        json!(1.5),
        json!("8"),
        json!(null),
    ] {
        assert_eq!(
            with(bad.clone()).expect_err("refused").code,
            -32602,
            "{bad}"
        );
    }
}

#[test]
fn an_unknown_key_is_refused_like_a_strict_schema() {
    assert_eq!(
        parse(&json!({"workspace": {}, "sessionId": "ses_p", "extra": 1}))
            .expect_err("strict")
            .code,
        -32602
    );
    assert_eq!(parse(&json!([])).expect_err("not an object").code, -32602);
}
