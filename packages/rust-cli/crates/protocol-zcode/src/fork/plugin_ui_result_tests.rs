//! Fork: which rows become a `v4/plugin-ui/tool-result` (specs/fork-rust-plugin-ui-tool-result.md, rule 6).
use serde_json::{Map, Value, json};

use super::of_row;

fn row(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

fn ui_row() -> Value {
    json!({
        "kind": "toolCall", "toolCallId": "toolu_1", "status": "success",
        "input": {"file": "a.md"},
        "display": {"kind": "mcp_tool", "serverName": "viewer", "toolName": "open",
                    "ui": {"pluginId": "viewer@market", "resourceUri": "ui://viewer/editor.html"}},
    })
}

#[test]
fn a_successful_ui_row_is_the_nodes_payload() {
    let params = of_row("sess_1", &row(ui_row())).unwrap();
    assert_eq!(
        params,
        json!({
            "sessionId": "sess_1", "toolCallId": "toolu_1", "serverName": "viewer",
            "ui": {"pluginId": "viewer@market", "resourceUri": "ui://viewer/editor.html"},
            "input": {"file": "a.md"},
        })
    );
}

#[test]
fn input_is_sent_only_when_it_is_a_plain_object() {
    for input in [json!([1]), json!("text"), json!(null)] {
        let mut value = ui_row();
        value["input"] = input;
        let params = of_row("sess_1", &row(value)).unwrap();
        assert!(params.get("input").is_none(), "{params}");
    }
    let mut value = ui_row();
    value.as_object_mut().unwrap().remove("input");
    assert!(
        of_row("sess_1", &row(value))
            .unwrap()
            .get("input")
            .is_none()
    );
}

#[test]
fn other_rows_send_nothing() {
    for status in ["error", "cancelled", "running", "pendingApproval"] {
        let mut value = ui_row();
        value["status"] = json!(status);
        assert!(of_row("sess_1", &row(value)).is_none(), "{status}");
    }
    let mut value = ui_row();
    value["kind"] = json!("message");
    assert!(of_row("sess_1", &row(value)).is_none());
    let mut value = ui_row();
    value["display"]["ui"]["isError"] = json!(true);
    assert!(of_row("sess_1", &row(value)).is_none(), "an isError result");
    let mut value = ui_row();
    value["display"]["ui"] = Value::Null;
    assert!(of_row("sess_1", &row(value)).is_none(), "no ui");
    let mut value = ui_row();
    value["display"]["kind"] = json!("task_output");
    assert!(
        of_row("sess_1", &row(value)).is_none(),
        "another display kind"
    );
    let mut value = ui_row();
    value["display"]["serverName"] = json!("");
    assert!(of_row("sess_1", &row(value)).is_none(), "an empty server");
    let mut value = ui_row();
    value.as_object_mut().unwrap().remove("display");
    assert!(of_row("sess_1", &row(value)).is_none(), "no display");
    assert!(of_row("", &row(ui_row())).is_none(), "an empty session id");
}
