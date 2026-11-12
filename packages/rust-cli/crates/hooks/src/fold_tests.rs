//! 工具类事件的合并（spec §4.3、§6）。

use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::testing::SequentialIds;
use serde_json::json;

use super::*;
use crate::result::Blocking;

fn fold<'a>(ids: &'a SequentialIds, event: &'a str, hook_name: &'a str) -> Fold<'a> {
    Fold {
        ids,
        event,
        hook_name,
    }
}

fn decided(behavior: Behavior, reason: Option<&str>, input: Option<Value>) -> HookResult {
    HookResult {
        behavior: Some(behavior),
        reason: reason.map(str::to_owned),
        updated_input: input,
        ..HookResult::default()
    }
}

fn blocking(error: &str) -> HookResult {
    HookResult::blocking(error.to_owned(), "g".to_owned())
}

fn text(message: &Message) -> String {
    match message {
        Message::Attachment(attachment) => attachment.text.clone(),
        other => format!("{other:?}"),
    }
}

#[test]
fn pre_tool_use_precedence_and_texts() {
    let ids = SequentialIds::default();
    let f = fold(&ids, "PreToolUse", "PreToolUse:Bash");
    // deny 优先；之后的 allow 不交出。
    let out = pre_tool_use(
        &f,
        &[
            decided(Behavior::Deny, None, None),
            decided(Behavior::Allow, None, None),
        ],
    );
    assert_eq!(
        out.decision,
        Some(PermissionDecision::Deny {
            message: "Hook PreToolUse:Bash denied this tool".to_owned()
        })
    );
    // ask 盖过 allow，带上 ask 的 updatedInput。
    let out = pre_tool_use(
        &f,
        &[
            decided(Behavior::Allow, None, Some(json!({"command": "a"}))),
            decided(Behavior::Ask, Some("check"), Some(json!({"command": "b"}))),
        ],
    );
    assert_eq!(
        out.decision,
        Some(PermissionDecision::ask("check", Vec::new()))
    );
    assert_eq!(out.updated_input, Some(json!({"command": "b"})));
    let out = pre_tool_use(&f, &[decided(Behavior::Ask, None, None)]);
    assert_eq!(
        out.decision,
        Some(PermissionDecision::ask(
            "Hook PreToolUse:Bash asked for confirmation for this tool",
            Vec::new()
        ))
    );
    // 退出码 2 的阻塞：PreToolUse 的拒绝文本。
    let out = pre_tool_use(&f, &[blocking("[g]: nope")]);
    assert_eq!(
        out.decision,
        Some(PermissionDecision::Deny {
            message: "PreToolUse:Bash hook error: [g]: nope".to_owned()
        })
    );
    // JSON deny：保留阻塞文本。
    let json_deny = HookResult {
        blocking: Some(Blocking {
            error: "no rm".to_owned(),
            command: "g".to_owned(),
        }),
        ..decided(Behavior::Deny, Some("no rm"), None)
    };
    let out = pre_tool_use(&f, &[json_deny]);
    assert_eq!(
        out.decision,
        Some(PermissionDecision::Deny {
            message: "PreToolUse:Bash hook error: no rm".to_owned()
        })
    );
}

#[test]
fn pre_tool_use_passthrough_context_and_stop() {
    let ids = SequentialIds::default();
    let f = fold(&ids, "PreToolUse", "PreToolUse:Bash");
    let out = pre_tool_use(
        &f,
        &[
            HookResult {
                updated_input: Some(json!({"command": "x"})),
                additional_context: Some("one".to_owned()),
                ..HookResult::default()
            },
            HookResult {
                additional_context: Some("two".to_owned()),
                prevent: true,
                ..HookResult::default()
            },
        ],
    );
    assert_eq!(out.decision, None);
    assert_eq!(out.updated_input, Some(json!({"command": "x"})));
    assert_eq!(out.messages.len(), 2, "每个 hook 一条附加上下文");
    assert!(text(&out.messages[1]).contains("PreToolUse:Bash hook additional context: two"));
    assert!(out.prevent_continuation);
    assert_eq!(out.after_result.len(), 1);
    assert!(
        text(&out.after_result[0])
            .contains("PreToolUse:Bash hook stopped continuation: Execution stopped by hook")
    );
}

/// Node uses only a PostToolUse hook's context: `continue: false` does not stop the turn (`shouldPreventContinuation`
/// covers PreToolUse, PermissionRequest and UserPromptSubmit only); later results still apply.
#[test]
fn post_tool_use_ignores_continue_false() {
    let ids = SequentialIds::default();
    let f = fold(&ids, "PostToolUse", "PostToolUse:Bash");
    let out = post_tool_use(
        &f,
        &[
            HookResult {
                updated_tool_output: Some(json!("new")),
                ..blocking("[g]: bad")
            },
            HookResult {
                prevent: true,
                stop_reason: Some("enough".to_owned()),
                ..HookResult::default()
            },
            HookResult {
                additional_context: Some("kept".to_owned()),
                ..HookResult::default()
            },
        ],
    );
    assert_eq!(out.updated_tool_output, Some(json!("new")));
    assert!(
        text(&out.messages[0])
            .contains("PostToolUse:Bash hook blocking error from command: \"g\": [g]: bad")
    );
    assert!(!out.prevent_continuation);
    assert_eq!(out.stop_reason, None);
    assert_eq!(out.additional_context, ["kept"]);
    assert!(
        out.messages
            .iter()
            .all(|message| !text(message).contains("stopped continuation"))
    );
}

#[test]
fn failure_and_permission_request() {
    let ids = SequentialIds::default();
    let f = fold(&ids, "PostToolUseFailure", "PostToolUseFailure:Bash");
    let out = post_tool_use_failure(
        &f,
        &[HookResult {
            additional_context: Some("retry with -f".to_owned()),
            ..blocking("[g]: x")
        }],
    );
    assert_eq!(out.messages.len(), 2);
    let deny = HookResult {
        permission_request: Some(PermissionRequestDecision::Deny { message: None }),
        ..HookResult::default()
    };
    let allow = HookResult {
        permission_request: Some(PermissionRequestDecision::Allow {
            updated_input: Some(json!({"a": 1})),
        }),
        ..HookResult::default()
    };
    // The last decision wins (Node `mergeHookRunResult`: `target.permissionRequestResult = next`); a deny without a
    // message gets Node's `decision.message ?? "Denied by PermissionRequest hook"`.
    let out = permission_request(&[allow.clone(), deny]);
    assert_eq!(
        out.decision,
        Some(PermissionDecision::Deny {
            message: "Denied by PermissionRequest hook".to_owned()
        })
    );
    let out = permission_request(&[HookResult::default(), allow]);
    assert_eq!(
        out.decision,
        Some(PermissionDecision::Allow {
            updated_input: None
        })
    );
    assert_eq!(out.updated_input, Some(json!({"a": 1})));
    assert!(
        permission_denied(&[HookResult {
            retry: true,
            ..HookResult::default()
        }])
        .retry
    );
}

/// #422 review P2-2: `continue: false` denies before any decision is read; the last stopping hook's `stopReason` wins
/// (Node `mergeHookRunResult` replaces it), with Node's default text when it has none.
#[test]
fn a_stopping_permission_request_hook_denies() {
    let allow = HookResult {
        permission_request: Some(PermissionRequestDecision::Allow {
            updated_input: Some(json!({"a": 1})),
        }),
        ..HookResult::default()
    };
    let stop = |reason: Option<&str>| HookResult {
        prevent: true,
        stop_reason: reason.map(str::to_owned),
        ..HookResult::default()
    };
    let out = permission_request(&[allow.clone(), stop(Some("first")), stop(Some("last"))]);
    assert_eq!(
        out.decision,
        Some(PermissionDecision::Deny {
            message: "last".to_owned()
        })
    );
    assert_eq!(out.updated_input, None);
    let out = permission_request(&[stop(Some("first")), stop(None), allow]);
    assert_eq!(
        out.decision,
        Some(PermissionDecision::Deny {
            message: "Denied by PermissionRequest hook".to_owned()
        })
    );
}

/// A PermissionRequest hook's JSON output, read as the engine reads it.
fn processed(output: Value) -> HookResult {
    crate::output::process(
        output.as_object().expect("an object"),
        "g",
        "PermissionRequest",
    )
    .expect("valid output")
}

fn specific(decision: Value) -> HookResult {
    processed(
        json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}),
    )
}

fn deny_with(message: &str) -> Option<PermissionDecision> {
    Some(PermissionDecision::Deny {
        message: message.to_owned(),
    })
}

/// Node `processHookOutput`: top-level `decision: "block"` and `continue: false` set `preventContinuation`, which
/// stops a PermissionRequest with `stopReason` (`block`: `stopReason ?? reason ?? systemMessage`; `continue: false`:
/// `stopReason ?? reason`); exit code 2 stops it with the blocking text. A stop wins over any decision; the last
/// stopping hook gives the text, Node's default when it has none. `approve` without a decision allows.
#[test]
fn permission_request_reads_block_exit_two_and_approve() {
    let block = |extra: Value| {
        let mut output = json!({"decision": "block"});
        output
            .as_object_mut()
            .expect("an object")
            .extend(extra.as_object().expect("an object").clone());
        processed(output)
    };
    let cases = [
        (
            json!({"stopReason": "s", "reason": "r", "systemMessage": "m"}),
            "s",
        ),
        (json!({"reason": "r", "systemMessage": "m"}), "r"),
        (json!({"systemMessage": "m"}), "m"),
        (json!({}), "Denied by PermissionRequest hook"),
    ];
    for (extra, text) in cases {
        assert_eq!(
            permission_request(&[block(extra)]).decision,
            deny_with(text)
        );
    }
    assert_eq!(
        permission_request(&[processed(json!({"continue": false, "reason": "r"}))]).decision,
        deny_with("r")
    );
    let allow = specific(json!({"behavior": "allow", "updatedInput": {"a": 1}}));
    let out = permission_request(&[blocking("[g]: no"), allow.clone()]);
    assert_eq!(out.decision, deny_with("[g]: no"));
    assert_eq!(out.updated_input, None);
    let out = permission_request(&[block(json!({"reason": "r"})), allow]);
    assert_eq!(out.decision, deny_with("r"));
    assert_eq!(
        permission_request(&[blocking("[g]: first"), block(json!({"stopReason": "last"}))])
            .decision,
        deny_with("last")
    );
    let approve = processed(json!({"decision": "approve"}));
    assert_eq!(
        permission_request(std::slice::from_ref(&approve)).decision,
        Some(PermissionDecision::Allow {
            updated_input: None
        })
    );
    // A decision wins over `approve`.
    let denied = specific(json!({"behavior": "deny", "message": "no"}));
    assert_eq!(
        permission_request(&[approve, denied]).decision,
        deny_with("no")
    );
}

/// #423 review P1-2: a `hookSpecificOutput` deny is only a decision (Node sets `permissionRequestResult`, not
/// `preventContinuation`), so a later allow wins; an empty message is kept (`decision.message ?? …`).
#[test]
fn a_hook_specific_deny_is_a_decision_not_a_stop() {
    let deny = specific(json!({"behavior": "deny", "message": "no"}));
    let allow = specific(json!({"behavior": "allow"}));
    assert_eq!(
        permission_request(&[deny.clone(), allow.clone()]).decision,
        Some(PermissionDecision::Allow {
            updated_input: None
        })
    );
    assert_eq!(
        permission_request(&[allow.clone(), deny]).decision,
        deny_with("no")
    );
    assert_eq!(
        permission_request(&[
            allow.clone(),
            specific(json!({"behavior": "deny", "message": ""}))
        ])
        .decision,
        deny_with("")
    );
    assert_eq!(
        permission_request(&[allow, specific(json!({"behavior": "deny"}))]).decision,
        deny_with("Denied by PermissionRequest hook")
    );
}
