use serde_json::json;

use super::*;

/// 随 crate 带的 schema 全部能编译（zod 用了不认识的关键字时这里失败，重新生成后要补校验器）。
#[test]
fn the_shipped_schema_compiles() {
    let inbound = Inbound::parse(INBOUND).unwrap();
    for method in [
        "v4/command",
        "v4/conversation/subscribe",
        "runtime/capabilities",
        "session/read",
    ] {
        assert!(inbound.methods.contains_key(method), "{method}");
    }
    for command in [
        "createSession",
        "sendText",
        "stop",
        "resolveInteraction",
        "setFollowupMode",
    ] {
        assert!(inbound.commands.contains_key(command), "{command}");
    }
    assert!(
        inbound
            .requires_base_revision
            .contains(&"setFollowupMode".to_owned())
    );
}

#[test]
fn method_params_follow_the_app_schema() {
    let inbound = Inbound::get();
    let workspace = json!({"workspacePath": "/w", "workspaceKey": "/w"});
    assert!(
        inbound
            .method(
                "workspace/updateOffPeakToolPolicy",
                &json!({"workspace": workspace, "enabled": true})
            )
            .is_ok()
    );
    let error = inbound
        .method(
            "workspace/updateOffPeakToolPolicy",
            &json!({"workspace": workspace, "enabled": true, "extra": 1}),
        )
        .unwrap_err();
    assert_eq!(error.code, -32602);
    // 省略 params 按 {} 校验。
    assert!(inbound.method("runtime/capabilities", &Value::Null).is_ok());
    assert!(inbound.method("not/registered", &json!(1)).is_ok());
}

#[test]
fn commands_check_the_payload_and_the_cross_field_rules() {
    let inbound = Inbound::get();
    let envelope = |kind: &str, payload: Value| {
        json!({"commandId": "c1", "clientId": "k", "sessionId": "s", "type": kind,
            "payload": payload, "issuedAt": 1})
    };
    assert!(
        inbound
            .command(&envelope("sendText", json!({"text": "hi"})))
            .is_ok()
    );
    assert!(
        inbound
            .command(&envelope("sendText", json!({"text": 1})))
            .is_err()
    );
    assert!(
        inbound
            .command(&envelope(
                "sendText",
                json!({"text": "hi", "modelExecution": {"kind": "standard"}})
            ))
            .is_err()
    );
    // CAS 命令要 baseRevision。
    assert!(
        inbound
            .command(&envelope("setFollowupMode", json!({"mode": "queue"})))
            .is_err()
    );
    let mut cas = envelope("setFollowupMode", json!({"mode": "queue"}));
    cas["baseRevision"] = json!(0);
    assert!(inbound.command(&cas).is_ok());
    assert!(
        inbound
            .command(&envelope("noSuchCommand", json!({})))
            .is_err()
    );
}

/// B4 (specs/fork-rust-agent-parity.md): an extension source must carry a pluginId and nothing else. The shipped
/// schema refuses the rest before the handler runs (the command is rejected with `proto.invalidPayload`).
#[test]
fn an_extension_source_is_checked_by_the_shipped_schema() {
    let inbound = Inbound::get();
    let envelope = |kind: &str, payload: Value| {
        json!({"commandId": "c1", "clientId": "k", "sessionId": "s", "type": kind,
            "payload": payload, "issuedAt": 1})
    };
    let valid = json!({"kind": "extension", "pluginId": "gitlab@zcode-plugins-example"});
    assert!(
        inbound
            .command(&envelope(
                "sendText",
                json!({"text": "hi", "source": valid})
            ))
            .is_ok()
    );
    assert!(
        inbound
            .command(&envelope(
                "createSession",
                json!({"workspaceId": "/w", "firstInput": {"text": "hi", "source": valid}}),
            ))
            .is_ok()
    );
    let invalid = [
        json!({"kind": "extension"}),
        json!({"kind": "extension", "pluginId": ""}),
        json!({"kind": "extension", "pluginId": "p", "toolCallId": "t"}),
    ];
    for source in invalid {
        assert!(
            inbound
                .command(&envelope(
                    "sendText",
                    json!({"text": "hi", "source": source})
                ))
                .is_err(),
            "sendText accepted {source}"
        );
        assert!(
            inbound
                .command(&envelope(
                    "createSession",
                    json!({"workspaceId": "/w", "firstInput": {"text": "hi", "source": source}}),
                ))
                .is_err(),
            "createSession accepted {source}"
        );
    }
}

/// Wave 2 (specs/fork-rust-agent-parity.md, `highspeedCardOwner`): the Host keeps `ownerKey` on `highspeedMeta`
/// only when this schema accepts the field instead of rejecting the send (`capabilities` reports the flag for
/// exactly that). A wrong-typed owner is still refused before the handler runs.
#[test]
fn highspeed_meta_owner_key_is_accepted() {
    // The `highspeedCardOwner` capability claims acceptance on every send that can carry the
    // owner (the Host strips it per command type-agnostically), so all three commands are pinned,
    // each with its own minimal payload: a regeneration dropping `ownerKey` from only one of the
    // three generated copies must fail here, not reject real sends.
    let inbound = Inbound::get();
    let envelope = |kind: &str, payload: Value| {
        // sendQueuedNow and editUserQuery are CAS commands (baseRevision/baseLogEpoch on the
        // envelope); the ownerKey acceptance itself lives in the payload schema.
        let cas = matches!(kind, "sendQueuedNow" | "editUserQuery");
        let mut envelope = json!({"commandId": "c1", "clientId": "k", "sessionId": "s", "type": kind,
            "payload": payload, "issuedAt": 1});
        if cas {
            envelope["baseRevision"] = json!("r1");
            envelope["baseLogEpoch"] = json!(1);
        }
        envelope
    };
    let owner = format!("v1:{}", "0".repeat(64));
    let meta = |owner_key: Value| {
        json!({"schemaVersion": 1, "cardId": "card", "ownerKey": owner_key, "taskId": "task",
            "provider": "zai", "model": "glm-4.7", "issuedAt": 1, "expiresAt": 2})
    };
    for (kind, base) in [
        ("sendText", json!({"text": "hi"})),
        ("sendQueuedNow", json!({"queueItemId": "q1"})),
        (
            "editUserQuery",
            json!({"target": {"rowId": 0, "entityId": "e1"}, "newText": "edited"}),
        ),
    ] {
        let mut ok_payload = base.clone();
        ok_payload["highspeedMeta"] = meta(owner.clone().into());
        assert!(
            inbound.command(&envelope(kind, ok_payload)).is_ok(),
            "{kind}: a valid ownerKey must be accepted"
        );
        let mut err_payload = base;
        err_payload["highspeedMeta"] = meta(1.into());
        assert!(
            inbound.command(&envelope(kind, err_payload)).is_err(),
            "{kind}: a wrong-typed ownerKey must be refused"
        );
    }
}

/// Wave 2 B1 (specs/fork-rust-agent-parity.md): the shipped 3.18.0 schema accepts the managed-worktree fields
/// (`createSession.cwd` / `worktreeCreation`, `forkAssistant.targetCwd`), so validation lets them through —
/// the create and fork handlers execute them (B1.1/B1.3), and `retryTurn`'s handler refuses its field
/// (`fork/row_commands.rs`). A wrong-typed half is still refused here, before the handler runs.
#[test]
fn managed_worktree_cwd_fields_are_accepted_by_the_shipped_schema() {
    let inbound = Inbound::get();
    let envelope = |kind: &str, payload: Value| {
        // forkAssistant is a CAS command (baseRevision/baseLogEpoch on the envelope).
        let mut envelope = json!({"commandId": "c1", "clientId": "k", "sessionId": "s", "type": kind,
            "payload": payload, "issuedAt": 1});
        if kind == "forkAssistant" {
            envelope["baseRevision"] = json!("r1");
            envelope["baseLogEpoch"] = json!(1);
        }
        envelope
    };
    let creation = json!({"path": "/w/.zcode-worktrees/one", "sha": "a1b2c3d4", "ref": null,
        "output": "worktree added"});
    assert!(
        inbound
            .command(&envelope(
                "createSession",
                json!({"workspaceId": "/w", "cwd": "/w/.zcode-worktrees/one",
                    "worktreeCreation": creation}),
            ))
            .is_ok()
    );
    let mut malformed = creation.clone();
    malformed["sha"] = json!(1);
    assert!(
        inbound
            .command(&envelope(
                "createSession",
                json!({"workspaceId": "/w", "cwd": "/w/.zcode-worktrees/one",
                    "worktreeCreation": malformed}),
            ))
            .is_err()
    );
    assert!(
        inbound
            .command(&envelope(
                "forkAssistant",
                json!({"target": {"rowId": 0, "entityId": "e1"},
                    "targetCwd": {"cwd": "/w/.zcode-worktrees/one", "childSessionId": "child-1",
                        "worktreeCreation": creation}}),
            ))
            .is_ok()
    );
    // The fork half's wrong-typed refusal is pinned too (the forkAssistant top-level schema has no
    // additionalProperties guard, so a loosened regeneration must fail here, not pass silently).
    let mut bad_fork = creation;
    bad_fork["sha"] = json!(1);
    assert!(
        inbound
            .command(&envelope(
                "forkAssistant",
                json!({"target": {"rowId": 0, "entityId": "e1"},
                    "targetCwd": {"cwd": "/w/.zcode-worktrees/one", "childSessionId": "child-1",
                        "worktreeCreation": bad_fork}}),
            ))
            .is_err()
    );
}

#[test]
fn reverse_request_replies_follow_the_app_schema() {
    let inbound = Inbound::get();
    let method = "interaction/requestProviderRuntimeHeaders";
    assert!(
        inbound
            .reply(
                method,
                &json!({"headersApplied": true, "requestAuth": {"apiKey": "k"}})
            )
            .is_ok()
    );
    assert!(
        inbound
            .reply(method, &json!({"headersApplied": true}))
            .is_err()
    );
    assert!(
        inbound
            .reply(
                method,
                &json!({"headersApplied": false, "errorMessage": "no"})
            )
            .is_ok()
    );
}

/// B2 (Node `command.ts` `stopSubagent`: zod `.strict()`, both ids `min(1)`): an empty id or an extra key is refused as
/// `proto.invalidPayload` before the kernel, never answered as `not_found` / `not_running`.
#[test]
fn a_stop_subagent_payload_is_strict() {
    let inbound = Inbound::get();
    let envelope = |payload: Value| {
        json!({"commandId": "c1", "clientId": "k", "sessionId": "s", "type": "stopSubagent",
            "payload": payload, "issuedAt": 1})
    };
    assert!(
        inbound
            .command(&envelope(json!({"taskId": "agent_1", "executionId": "0"})))
            .is_ok()
    );
    for payload in [
        json!({"taskId": "", "executionId": "0"}),
        json!({"taskId": "agent_1", "executionId": ""}),
        json!({"taskId": "agent_1"}),
        json!({"taskId": "agent_1", "executionId": "0", "extra": true}),
    ] {
        assert!(
            inbound.command(&envelope(payload.clone())).is_err(),
            "{payload}"
        );
    }
}

/// Gen UI widget state (specs/fork-rust-agent-parity.md "Gen UI widget state"): `sendText.genUiContext` follows Node's
/// `genUiModelContextSchema` and `genUiPathSchema`; a value Node's zod refuses refuses the command at the schema step.
#[test]
fn gen_ui_context_follows_the_node_schema() {
    let inbound = Inbound::get();
    let envelope = |context: Value| {
        json!({"commandId": "c1", "clientId": "k", "sessionId": "s", "type": "sendText",
            "payload": {"text": "hi", "genUiContext": context}, "issuedAt": 1})
    };
    let entry = |path: &str, state: Value| json!({"path": path, "state": state});
    // An empty array is a present field (the App sends it when the page has no state): accepted.
    assert!(inbound.command(&envelope(json!([]))).is_ok());
    assert!(
        inbound
            .command(&envelope(json!([entry(
                "/work/page-one.html",
                json!({"stage": "entry"})
            )])))
            .is_ok()
    );
    // A Windows absolute path is accepted like Node's `^[A-Za-z]:[\\/]`.
    assert!(
        inbound
            .command(&envelope(json!([entry(
                "C:\\work\\page-one.html",
                json!(1)
            )])))
            .is_ok()
    );
    let refused = [
        ("relative path", "work/page-one.html"),
        ("parent segment", "/work/../page-one.html"),
        ("uppercase name", "/work/Page-One.html"),
        ("wrong extension", "/work/page-one.htm"),
        ("newline", "/work/page\n-one.html"),
        ("NUL", "/work/page\u{0}-one.html"),
    ];
    for (case, path) in refused {
        assert!(
            inbound
                .command(&envelope(json!([entry(path, json!(1))])))
                .is_err(),
            "{case}"
        );
    }
    // Node: each state at most 16 KiB and the whole array at most 64 KiB of serialized JSON.
    let big_state = json!("x".repeat(17_000));
    assert!(
        inbound
            .command(&envelope(json!([entry("/w/a.html", big_state)])))
            .is_err()
    );
    let many: Vec<Value> = (0..100)
        .map(|index| entry(&format!("/w/p{index}.html"), json!("y".repeat(700))))
        .collect();
    assert!(inbound.command(&envelope(Value::Array(many))).is_err());
}
