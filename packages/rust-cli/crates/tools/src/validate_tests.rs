use serde_json::json;

use super::*;

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "file_path": {"type": "string"},
            "offset": {"type": "number"},
            "limit": {"type": "number"}
        },
        "required": ["file_path"],
        "additionalProperties": false
    })
}

#[test]
fn valid_input_passes() {
    assert_eq!(
        validate("Read", &schema(), &json!({"file_path": "a"})),
        None
    );
}

#[test]
fn a_single_missing_parameter_uses_the_singular() {
    assert_eq!(
        validate("Read", &schema(), &json!({})).unwrap(),
        "Read failed due to the following issue:\nThe required parameter `file_path` is missing"
    );
}

#[test]
fn issues_are_grouped_missing_unexpected_then_type() {
    let message = validate("Read", &schema(), &json!({"offset": "1", "extra": true})).unwrap();
    assert_eq!(
        message,
        "Read failed due to the following issues:\n\
         The required parameter `file_path` is missing\n\
         An unexpected parameter `extra` was provided\n\
         The parameter `offset` type is expected as `number` but provided as `string`"
    );
}

#[test]
fn nested_paths_use_dots_and_indexes() {
    let schema = json!({
        "type": "object",
        "properties": {
            "todos": {"type": "array", "items": {
                "type": "object",
                "properties": {"content": {"type": "string"}},
                "required": ["content"]
            }}
        }
    });
    let message = validate("TodoWrite", &schema, &json!({"todos": [{"content": 1}]})).unwrap();
    assert!(
        message.contains(
            "The parameter `todos[0].content` type is expected as `string` but provided as `number`"
        ),
        "{message}"
    );
}

#[test]
fn required_fields_with_a_default_may_be_omitted() {
    // ToolSearch 的 schema：`max_results` 有默认值，仍列在 required 里。
    let schema = json!({
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "max_results": {"default": 5, "type": "number"}
        },
        "required": ["query", "max_results"],
        "additionalProperties": false
    });
    assert_eq!(
        validate("ToolSearch", &schema, &json!({"query": "x"})),
        None
    );
    assert!(validate("ToolSearch", &schema, &json!({"max_results": 2})).is_some());
}

/// `minLength` is checked as Node's JSON-schema validator checks it: an empty string is `too_small`, printed as the
/// JSON of the issues (Node `formatToolInputValidationError`, which prints issues as JSON when no other kind is present).
#[test]
fn an_empty_string_below_min_length_is_refused_as_node_prints_it() {
    let schema = json!({
        "type": "object",
        "properties": {"description": {"type": "string", "minLength": 1}},
        "required": ["description"]
    });
    assert_eq!(
        validate("SaveWorkflow", &schema, &json!({"description": ""})).unwrap(),
        "[\n  {\n    \"origin\": \"string\",\n    \"code\": \"too_small\",\n    \"minimum\": 1,\n    \"inclusive\": true,\n    \"path\": [\n      \"description\"\n    ],\n    \"message\": \"Too small: expected string to have >=1 characters\"\n  }\n]"
    );
    assert_eq!(
        validate("SaveWorkflow", &schema, &json!({"description": "a"})),
        None
    );
}

#[test]
fn a_min_length_issue_inside_nested_objects_and_arrays_uses_the_path_segments() {
    let schema = json!({
        "type": "object",
        "properties": {"args": {"type": "array", "items": {
            "type": "object", "properties": {"note": {"type": "string", "minLength": 2}}
        }}}
    });
    let message = validate(
        "Tool",
        &schema,
        &json!({"args": [{"note": "ok"}, {"note": "x"}]}),
    )
    .unwrap();
    assert!(
        message.contains("\"path\": [\n      \"args\",\n      1,\n      \"note\"\n    ]"),
        "{message}"
    );
}

#[test]
fn a_missing_parameter_is_still_reported_in_the_text_form_without_the_min_length_issue() {
    let schema = json!({
        "type": "object",
        "properties": {"a": {"type": "string", "minLength": 1}, "b": {"type": "string"}},
        "required": ["b"]
    });
    assert_eq!(
        validate("Tool", &schema, &json!({"a": ""})).unwrap(),
        "Tool failed due to the following issue:\nThe required parameter `b` is missing"
    );
}
