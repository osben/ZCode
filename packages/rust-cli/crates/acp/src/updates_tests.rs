use serde_json::json;

use super::*;

#[test]
fn tool_updates_carry_input_and_text_output() {
    let Some(RuntimeEvent::ToolCallUpdate(info)) = map_update(&json!({
        "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
        "rawInput": {"path": "a.txt"},
        "content": [
            {"type": "content", "content": {"type": "text", "text": "body"}},
            {"type": "diff", "path": "b.rs", "newText": "fn main() {}"},
            {"type": "terminal", "terminalId": "x"}
        ]
    })) else {
        panic!("tool update");
    };
    assert_eq!(info.display_title(), None);
    assert_eq!(info.known_status(), Some("completed"));
    assert_eq!(info.input(), Some(&json!({"path": "a.txt"})));
    assert_eq!(
        info.output_text().as_deref(),
        Some("body\nb.rs\nfn main() {}")
    );
}

#[test]
fn non_text_chunks_and_unknown_updates_are_not_surfaced() {
    assert!(
        map_update(&json!({"sessionUpdate": "agent_message_chunk",
        "content": {"type": "image", "data": ""}}))
        .is_none()
    );
    assert!(map_update(&json!({"sessionUpdate": "usage_update", "used": 1, "size": 2})).is_none());
    assert!(map_update(&json!({"sessionUpdate": "session_info_update"})).is_none());
}

#[test]
fn permission_answers_map_to_the_option_of_that_kind() {
    let params = json!({
        "sessionId": "s",
        "toolCall": {"toolCallId": "perm", "title": "Run the tests",
                     "content": [{"type": "content", "content": {"type": "text", "text": ""}},
                                 {"type": "content", "content": {"type": "text", "text": "pnpm test"}}]},
        "options": [
            {"optionId": "opt-allow", "name": "Allow once", "kind": "allow_once"},
            {"optionId": "opt-reject", "name": "Reject", "kind": "reject_once"}
        ]
    });
    let ask = permission_ask(&params, "1:perm:1".to_owned());
    assert_eq!(ask.detail.as_deref(), Some("pnpm test"));
    assert_eq!(ask.options.len(), 2);
    assert_eq!(
        permission_response(
            &params,
            &PermissionAnswer::Selected {
                kind: "reject_once".to_owned()
            }
        ),
        json!({"outcome": {"outcome": "selected", "optionId": "opt-reject"}})
    );
    assert_eq!(
        permission_response(
            &params,
            &PermissionAnswer::Selected {
                kind: "allow_always".to_owned()
            }
        ),
        json!({"outcome": {"outcome": "cancelled"}})
    );
}

#[test]
fn tool_updates_without_a_tool_call_id_are_dropped() {
    // The ACP SDK rejects these on the Node side (`toolCallId` is required), so no row or ask can merge under "".
    for kind in ["tool_call", "tool_call_update"] {
        assert!(
            map_update(&json!({"sessionUpdate": kind, "title": "t"})).is_none(),
            "{kind}"
        );
        assert!(
            map_update(&json!({"sessionUpdate": kind, "toolCallId": 7, "title": "t"})).is_none(),
            "{kind}"
        );
    }
}
