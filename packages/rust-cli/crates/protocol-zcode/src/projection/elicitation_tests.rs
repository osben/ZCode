use super::*;

fn questions() -> Value {
    json!([
        {"question": "Which db?", "header": "DB", "options": [
            {"label": "Postgres", "description": "relational"}, {"label": "Redis"}]},
        {"question": "Which tags?", "header": "Tags", "multiSelect": true, "options": [
            {"label": "a"}, {"label": "b"}]},
        {"question": "No options", "header": "x", "options": []},
    ])
}

fn content(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

#[test]
fn a_question_ask_carries_the_structured_questions() {
    let pending = question("i1", Some(7), 10, "tu1", &questions());
    assert_eq!(pending["kind"], "userInput");
    assert_eq!(pending["anchorRowId"], 7);
    let payload = &pending["payload"];
    assert_eq!(payload["kind"], "userInput");
    assert_eq!(payload["toolName"], "AskUserQuestion");
    assert_eq!(payload["toolCallId"], "tu1");
    let shown = payload["questions"].as_array().unwrap();
    // Like Node, a question without options is not shown.
    assert_eq!(shown.len(), 2);
    assert_eq!(
        shown[0]["options"][0],
        json!({"value": "Postgres", "label": "Postgres", "description": "relational"})
    );
    assert_eq!(shown[1]["multiSelect"], true);
    assert!(shown[0].get("multiSelect").is_none());
}

#[test]
fn a_plan_ask_is_one_approve_question() {
    let pending = plan_approval("i2", None, 10, "tu2", "# Plan");
    let payload = &pending["payload"];
    assert_eq!(payload["schema"]["interaction"], "plan_approval");
    assert_eq!(payload["input"]["plan"], "# Plan");
    assert_eq!(payload["questions"][0]["question"], PLAN_QUESTION);
    assert_eq!(payload["questions"][0]["options"][0]["value"], "approve");
}

#[test]
fn accepted_answers_map_by_question_text_and_join_multi_select() {
    let answer = question_answer(
        &questions(),
        Some("accept"),
        Some(&content(json!({
            "answers": {"Which db?": "  my own db ", "Which tags?": ["a", " ", "b"]},
            "annotations": {"Which db?": {"notes": "n"}, "Which tags?": {}},
        }))),
    );
    let QuestionAnswer::Answered {
        answers,
        annotations,
        ..
    } = answer
    else {
        panic!("expected answered");
    };
    assert_eq!(answers["Which db?"], "my own db");
    assert_eq!(answers["Which tags?"], "a, b");
    assert_eq!(annotations.len(), 1);
    assert_eq!(annotations["Which db?"].notes.as_deref(), Some("n"));
}

#[test]
fn legacy_indexed_answers_are_read() {
    let answer = question_answer(&questions(), None, Some(&content(json!({"answer_1": "b"}))));
    let QuestionAnswer::Answered { answers, .. } = answer else {
        panic!("expected answered");
    };
    assert_eq!(answers.len(), 1);
    assert_eq!(answers["Which tags?"], "b");
}

#[test]
fn decline_and_cancel_decline_the_question() {
    let filled = content(json!({"answers": {"Which db?": "Redis"}}));
    assert_eq!(
        question_answer(&questions(), Some("decline"), Some(&filled)),
        QuestionAnswer::Declined
    );
    assert_eq!(
        question_answer(&questions(), Some("cancel"), None),
        QuestionAnswer::Declined
    );
    assert_eq!(
        question_answer(&questions(), Some("accept"), None),
        QuestionAnswer::Declined
    );
}

#[test]
fn plan_answers_approve_give_feedback_or_keep_planning() {
    let mode = PermissionMode::Default;
    let approve = content(json!({"answers": {PLAN_QUESTION: "approve"}}));
    assert_eq!(
        plan_answer(Some("accept"), Some(&approve), None, mode),
        PlanApprovalAnswer::Approve { mode }
    );
    let feedback = content(json!({"answer_0": " split step 2 "}));
    assert_eq!(
        plan_answer(Some("accept"), Some(&feedback), None, mode),
        PlanApprovalAnswer::KeepPlanning {
            feedback: Some("split step 2".into())
        }
    );
    assert_eq!(
        plan_answer(Some("decline"), Some(&approve), None, mode),
        PlanApprovalAnswer::KeepPlanning { feedback: None }
    );
    assert_eq!(
        plan_answer(
            Some("accept"),
            Some(&content(json!({"answers": {}}))),
            None,
            mode
        ),
        PlanApprovalAnswer::KeepPlanning { feedback: None }
    );
}
