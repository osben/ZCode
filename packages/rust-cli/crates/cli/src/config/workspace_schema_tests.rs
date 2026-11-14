use serde_json::json;

use super::check;

#[test]
fn nodes_workspace_hooks_schema_is_accepted() {
    let value = json!({
        "enabled": true,
        "timeoutMs": 1500,
        "maxOutputBytes": 10.5,
        "events": {
            "UserPromptSubmit": [{"hooks": [
                {"type": "command", "command": "echo", "enabled": false, "async": true, "shell": true,
                 "timeout": 2, "timeoutMs": 3, "statusMessage": "s", "onError": "deny", "kept": {"any": 1}}
            ]}],
            "PreToolUse": [{"matcher": "Bash", "hooks": [
                {"type": "process", "command": "node", "args": ["a.js"], "shell": "zsh-ignored", "onError": "allow"}
            ]}],
            "PreCompact": [{"hooks": [{"type": "command", "command": "a", "shell": "bash"}]}],
            "PostCompact": [],
            "SessionEnd": [{"hooks": [{"type": "process", "command": "b"}]}]
        }
    });
    assert_eq!(check(&value), Ok(()));
    assert_eq!(check(&json!({})), Ok(()));
}

#[test]
fn what_nodes_strict_schema_rejects_is_rejected() {
    let hook = json!({"type": "command", "command": "a"});
    let with_event = |name: &str, matchers: serde_json::Value| json!({"events": {name: matchers}});
    let rejected = [
        json!(null),
        json!([]),
        json!({"extra": 1}),
        json!({"enabled": null}),
        json!({"enabled": "yes"}),
        json!({"timeoutMs": 0}),
        json!({"maxOutputBytes": -1}),
        json!({"events": []}),
        json!({"events": {"UserPromptSubmit": null}}),
        with_event("Notification", json!([{"hooks": [hook]}])),
        with_event("UserPromptSubmit", json!({})),
        with_event("UserPromptSubmit", json!([5])),
        with_event("UserPromptSubmit", json!([{"hooks": []}])),
        with_event(
            "UserPromptSubmit",
            json!([{"matcher": "", "hooks": [hook]}]),
        ),
        with_event("UserPromptSubmit", json!([{"matcher": 5, "hooks": [hook]}])),
        with_event("UserPromptSubmit", json!([{"hooks": [hook], "note": 1}])),
        with_event("UserPromptSubmit", json!([{}])),
        with_event(
            "UserPromptSubmit",
            json!([{"hooks": [{"type": "http", "command": "a"}]}]),
        ),
        with_event("UserPromptSubmit", json!([{"hooks": [{"command": "a"}]}])),
        with_event(
            "UserPromptSubmit",
            json!([{"hooks": [{"type": "command"}]}]),
        ),
        with_event(
            "UserPromptSubmit",
            json!([{"hooks": [{"type": "command", "command": ""}]}]),
        ),
        with_event(
            "UserPromptSubmit",
            json!([{"hooks": [{"type": "command", "command": "a", "shell": false}]}]),
        ),
        with_event(
            "UserPromptSubmit",
            json!([{"hooks": [{"type": "command", "command": "a", "shell": ""}]}]),
        ),
        with_event(
            "UserPromptSubmit",
            json!([{"hooks": [{"type": "command", "command": "a", "async": 1}]}]),
        ),
        with_event(
            "UserPromptSubmit",
            json!([{"hooks": [{"type": "command", "command": "a", "timeout": 0}]}]),
        ),
        with_event(
            "UserPromptSubmit",
            json!([{"hooks": [{"type": "command", "command": "a", "statusMessage": ""}]}]),
        ),
        with_event(
            "UserPromptSubmit",
            json!([{"hooks": [{"type": "command", "command": "a", "onError": "maybe"}]}]),
        ),
        with_event(
            "UserPromptSubmit",
            json!([{"hooks": [{"type": "process", "command": "a", "args": [1]}]}]),
        ),
        with_event(
            "UserPromptSubmit",
            json!([{"hooks": [{"type": "process", "command": "a", "timeoutMs": "1"}]}]),
        ),
        with_event(
            "UserPromptSubmit",
            json!([{"hooks": [{"type": "process", "command": "a", "enabled": null}]}]),
        ),
    ];
    for value in rejected {
        assert!(check(&value).is_err(), "{value}");
    }
}
