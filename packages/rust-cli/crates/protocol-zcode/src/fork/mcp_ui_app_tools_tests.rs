//! Fork (F7 PR 3): the pure rules of the app-tool mailbox (Node `appTools.ts` naming and the descriptor, argument and
//! outcome limits). The stateful rules (claim, resolve, lifetimes, the route) are in `mcp_ui_route_tests.rs`.

use serde_json::json;

use super::{
    model_name, outcome_of as outcome_of_for_test, parse_descriptor as parse_descriptor_for_test,
};

#[test]
fn the_model_name_is_app_server_tool_with_each_unit_outside_the_safe_set_replaced() {
    assert_eq!(model_name("files", "read"), "app__files__read");
    assert_eq!(
        model_name("plugin:example:widget", "do thing"),
        "app__plugin_example_widget__do_thing"
    );
    // Runs of underscores collapse, and an empty part is `unknown`.
    assert_eq!(model_name("a___b", "x"), "app__a_b__x");
    assert_eq!(model_name("", "x"), "app__unknown__x");
    // A non-BMP character is two UTF-16 units, so it becomes two underscores that collapse to one (Node), and the
    // separator after the server part is the second `__` of the name.
    assert_eq!(model_name("s😀", "x"), "app__s___x");
}

#[test]
fn a_descriptor_keeps_its_hints_and_refuses_what_the_schema_refuses() {
    let ok = parse_descriptor_for_test(&json!({
        "name": "read",
        "title": "Read",
        "inputSchema": {"type": "object"},
        "annotations": {"readOnlyHint": true, "destructiveHint": false},
    }))
    .expect("a valid descriptor");
    assert!(ok.read_only && !ok.destructive && !ok.idempotent);

    assert!(
        parse_descriptor_for_test(&json!({"name": "", "inputSchema": {"type": "object"}})).is_err()
    );
    let long = "n".repeat(129);
    assert!(
        parse_descriptor_for_test(&json!({"name": long, "inputSchema": {"type": "object"}}))
            .is_err()
    );
    assert!(
        parse_descriptor_for_test(&json!({"name": "a", "inputSchema": {"type": "array"}})).is_err()
    );
    assert!(
        parse_descriptor_for_test(&json!({
            "name": "a",
            "inputSchema": {"type": "object"},
            "annotations": {"readOnlyHint": "yes"},
        }))
        .is_err()
    );
}

#[test]
fn a_resolve_carries_exactly_one_of_a_result_with_content_or_an_error() {
    assert!(outcome_of_for_test(&json!({"result": {"content": []}})).is_ok());
    assert!(outcome_of_for_test(&json!({"result": {"text": "no content array"}})).is_err());
    assert!(outcome_of_for_test(&json!({})).is_err());
    assert!(
        outcome_of_for_test(&json!({"result": {"content": []}, "error": {"message": "x"}}))
            .is_err()
    );
    assert_eq!(
        outcome_of_for_test(&json!({"error": {"message": ""}}))
            .unwrap()
            .unwrap_err(),
        "App tool failed"
    );
    let oversized =
        json!({"result": {"content": [{"type": "text", "text": "x".repeat(10 * 1024 * 1024)}]}});
    assert_eq!(
        outcome_of_for_test(&oversized).unwrap().unwrap_err(),
        "App tool result exceeds 10485760 bytes"
    );
}
