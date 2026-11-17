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
fn an_mcp_elicitation_ask_carries_the_form_questions() {
    let schema = json!({"type": "object", "properties": {
        "name": {"type": "string", "title": "Name"},
        "age": {"type": "integer"},
        "ok": {"type": "boolean", "title": "Ship?"},
        "db": {"type": "string", "enum": ["pg", "redis"], "enumNames": ["Postgres", "Redis"]},
        "skipped": {"type": "array"},
    }});
    let pending = mcp_elicitation("i3", Some(4), 10, "tu3", "srv", "Fill in", &schema);
    assert_eq!(pending["kind"], "userInput");
    assert_eq!(pending["anchorRowId"], 4);
    let payload = &pending["payload"];
    assert_eq!(payload["kind"], "userInput");
    assert_eq!(payload["freeText"], true);
    assert_eq!(payload["toolName"], "McpElicitation");
    assert_eq!(payload["toolCallId"], "tu3");
    assert_eq!(payload["prompt"], "Fill in");
    assert_eq!(
        payload["input"],
        json!({"serverName": "srv", "message": "Fill in", "requestedSchema": schema})
    );
    assert_eq!(
        payload["schema"],
        json!({"interaction": "mcp_elicitation", "serverName": "srv", "requestedSchema": schema})
    );
    // Node's mcpElicitationQuestions: one per supported property, in order; the unsupported `array` is left out.
    let shown = payload["questions"].as_array().unwrap();
    assert_eq!(shown.len(), 4);
    assert_eq!(
        shown[0],
        json!({"header": "Name", "question": "Fill in\n\nName", "options": [
            {"value": MCP_ELICITATION_FREE_TEXT_OPTION, "label": "Type your answer"}]})
    );
    assert_eq!(shown[1]["header"], "age");
    assert_eq!(
        shown[2],
        json!({"header": "Ship?", "question": "Fill in\n\nShip?", "options": [
            {"value": "true", "label": "Yes"}, {"value": "false", "label": "No"}]})
    );
    assert_eq!(
        shown[3]["options"],
        json!([{"value": "pg", "label": "Postgres"}, {"value": "redis", "label": "Redis"}])
    );
}

#[test]
fn an_mcp_elicitation_without_fields_asks_the_message_as_text() {
    let pending = mcp_elicitation("i4", None, 10, "tu4", "srv", "Anything?", &json!({}));
    assert_eq!(
        pending["payload"]["questions"],
        json!([{"header": "Answer", "question": "Anything?", "options": [
            {"value": MCP_ELICITATION_FREE_TEXT_OPTION, "label": "Type your answer"}]}])
    );
}

#[test]
fn an_mcp_answer_maps_to_the_schema_types() {
    let schema = json!({"type": "object", "properties": {
        "name": {"type": "string"},
        "age": {"type": "integer"},
        "ok": {"type": "boolean"},
        "db": {"type": "string", "enum": ["pg", "redis"]},
    }});
    let answers = content(json!({
        "answers": {"Fill in\n\nname": "Ada"},
        "answer_1": "41.7",
        "answer_2": "yes",
        "answer_3": "redis",
    }));
    assert_eq!(
        mcp_answer("Fill in", &schema, Some("accept"), Some(&answers), None),
        McpElicitationAnswer::Accept {
            content: content(json!({"name": "Ada", "age": 41, "ok": true, "db": "redis"})),
        }
    );
    // The sentinel of a free-text question, a non-number, and a missing answer are left out; "No" is false.
    let rest = content(json!({
        "answer_0": MCP_ELICITATION_FREE_TEXT_OPTION,
        "answer_1": "old",
        "answer_2": "No",
    }));
    assert_eq!(
        mcp_answer("Fill in", &schema, Some("accept"), Some(&rest), None),
        McpElicitationAnswer::Accept {
            content: content(json!({"ok": false})),
        }
    );
}

#[test]
fn an_integer_outside_i64_keeps_the_truncated_number_like_node() {
    let schema = json!({"type": "object", "properties": {"n": {"type": "integer"}}});
    let answers = content(json!({"answer_0": "1e300"}));
    let McpElicitationAnswer::Accept { content: got } =
        mcp_answer("Fill in", &schema, Some("accept"), Some(&answers), None)
    else {
        panic!("accepted");
    };
    assert_eq!(got["n"].as_f64(), Some(1e300));
    assert_eq!(got["n"].as_i64(), None);
}

#[test]
fn an_mcp_answer_with_free_text_and_no_action_is_the_first_field() {
    let schema = json!({"type": "object", "properties": {"name": {"type": "string"}}});
    assert_eq!(
        mcp_answer("Fill in", &schema, None, None, Some("  Ada  ")),
        McpElicitationAnswer::Accept {
            content: content(json!({"name": "Ada"})),
        }
    );
}

#[test]
fn an_mcp_decline_cancel_and_empty_answer() {
    let schema = json!({"type": "object", "properties": {"name": {"type": "string"}}});
    assert_eq!(
        mcp_answer("Fill in", &schema, Some("decline"), None, None),
        McpElicitationAnswer::Decline
    );
    assert_eq!(
        mcp_answer("Fill in", &schema, Some("cancel"), None, None),
        McpElicitationAnswer::Cancel
    );
    // No action, no content and no text: nothing was answered, so it declines.
    assert_eq!(
        mcp_answer("Fill in", &schema, None, None, None),
        McpElicitationAnswer::Decline
    );
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
