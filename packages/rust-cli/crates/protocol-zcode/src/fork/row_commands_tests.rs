use rust_cli_kernel_api::conversation_quote::{Quote, compose};
use rust_cli_kernel_api::message::ContentBlock;
use serde_json::json;

use super::*;

fn quote(text: &str) -> Quote {
    Quote {
        text: text.to_owned(),
        path: None,
        sender_name: None,
        sender_id: None,
        message_id: None,
        sent_at: None,
        comment: None,
        agent: None,
    }
}

fn edit(extra: serde_json::Value) -> EditPayload {
    let mut body = json!({"target": {"rowId": 3, "entityId": "msg_u1"}, "newText": "edited"});
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(body).unwrap()
}

fn envelope() -> Envelope {
    serde_json::from_value(json!({
        "commandId": "c9",
        "clientId": "client",
        "sessionId": "s",
        "type": "editUserQuery",
        "inputOrigin": "desktop",
    }))
    .unwrap()
}

fn stored_intent(extra: serde_json::Value) -> InputIntent {
    let mut fields = json!({
        "conversationQuotes": [{"text": "kept"}],
        "sourceCommandId": "c1",
        "queueItemId": "queue_c1",
        "clientId": "old",
        "kind": "sendText",
        "text": "original",
        "mode": "default",
        "admissionSeq": 1,
        "admittedAt": 10,
        "requestedDelivery": "queue",
        "admittedDelivery": "queue",
    });
    fields
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(fields).unwrap()
}

/// Node `canonical-intent-replay.ts`: the payload parses absent, `[]` and quotes apart.
#[test]
fn an_edit_payload_keeps_absent_and_empty_quotes_apart() {
    assert_eq!(edit(json!({})).conversation_quotes, None);
    assert_eq!(
        edit(json!({"conversationQuotes": []})).conversation_quotes,
        Some(Vec::new())
    );
    assert_eq!(
        edit(json!({"conversationQuotes": [{"text": "new", "unknownKey": 1}]})).conversation_quotes,
        Some(vec![quote("new")])
    );
}

/// Node `inputIntentMetadataFromCanonical`: the edited input's intent with the new command, text and admission;
/// `payload.conversationQuotes ?? the stored quotes`; the stored command as provenance.
#[test]
fn an_edit_replays_the_stored_intent() {
    let stored = stored_intent(json!({}));
    let replayed = replayed_intent((7, 99), &envelope(), Some(&stored), "edited", None, None);
    assert_eq!(
        serde_json::to_value(&replayed).unwrap(),
        json!({
            "inputOrigin": "desktop",
            "conversationQuotes": [{"text": "kept"}],
            "sourceCommandId": "c9",
            "queueItemId": "queue_c9",
            "clientId": "client",
            "kind": "sendText",
            "text": "edited",
            "mode": "default",
            "admissionSeq": 7,
            "admittedAt": 99,
            "requestedDelivery": "queue",
            "admittedDelivery": "queue",
            "provenance": {"sourceCommandId": "c1", "queueItemId": "queue_c1", "clientId": "old"},
        })
    );
    let cleared = replayed_intent((7, 99), &envelope(), Some(&stored), "", Some(&[]), None);
    assert_eq!(cleared.quotes(), Some(Vec::new()));
    let new = [quote("new")];
    let replaced = replayed_intent((7, 99), &envelope(), Some(&stored), "", Some(&new), None);
    assert_eq!(replaced.quotes(), Some(new.to_vec()));
    // An input stored without an intent (TUI) gets Node's defaults.
    let fresh = replayed_intent((1, 5), &envelope(), None, "x", None, None);
    assert_eq!(fresh.quotes(), None);
    assert_eq!(fresh.str("requestedDelivery"), Some("startNow"));
    assert!(fresh.get("provenance").is_none());
}

/// A bot message's text has instructions after the quote block (Node `withConversationQuotes(…, botGroupSource)`);
/// its quotes still come from the intent, and Node's replay drops the bot source.
#[test]
fn a_bot_message_edit_keeps_the_quotes_from_the_intent() {
    let stored = stored_intent(json!({"botGroupSource": {"groupId": "g"}}));
    let replayed = replayed_intent((2, 3), &envelope(), Some(&stored), "edited", None, None);
    assert_eq!(replayed.quotes(), Some(vec![quote("kept")]));
    assert!(replayed.get("botGroupSource").is_none());
    let block = compose("", &[quote("kept")]);
    let bot = Stored {
        content: vec![ContentBlock::Text {
            text: format!("original\n\n{block}\n\nBot instructions"),
        }],
        intent: Some(stored),
    };
    // Retry submits the intent's text: the session adds the block once.
    assert_eq!(
        bot.typed(),
        [ContentBlock::Text {
            text: "original".into()
        }]
    );
}

/// Retry submits the typed text again; the session adds the block from the intent.
#[test]
fn a_retry_strips_only_the_intents_own_block() {
    let stored = stored_intent(json!({}));
    let quoted = Stored {
        content: vec![ContentBlock::Text {
            text: stored.compose("original"),
        }],
        intent: Some(stored),
    };
    assert_eq!(
        quoted.typed(),
        [ContentBlock::Text {
            text: "original".into()
        }]
    );
    // Quotes alone: the intent's text is empty.
    let stored = stored_intent(json!({"text": ""}));
    let alone = Stored {
        content: vec![ContentBlock::Text {
            text: stored.compose(""),
        }],
        intent: Some(stored),
    };
    assert_eq!(alone.typed(), []);
}

/// Node `fork-edit-retry.ts`: quotes alone are an input, so an edit that clears the text but keeps them is accepted.
#[test]
fn quotes_alone_are_an_edited_input() {
    let quoted = stored_intent(json!({}));
    assert!(is_input(&[], &quoted));
    let empty = stored_intent(json!({"conversationQuotes": []}));
    assert!(!is_input(
        &[ContentBlock::Text { text: "  ".into() }],
        &empty
    ));
}

/// Node `retryTurn` submits `editTarget.intent.text`: a slash input's stored content is its expansion (the stored part's
/// `metadata.modelInput`), but the retry types `/greet Ada` again, so the hook, the new intent and the row read it.
#[test]
fn a_retry_types_the_intents_text_again() {
    let stored = stored_intent(json!({"text": "/greet Ada"}));
    let tags = rust_cli_kernel_api::user_command::command_tags("greet", "Ada");
    let command = Stored {
        content: vec![ContentBlock::Text {
            text: stored.compose(&format!("{tags}\nHello, Ada")),
        }],
        intent: Some(stored),
    };
    assert_eq!(
        command.typed(),
        [ContentBlock::Text {
            text: "/greet Ada".into()
        }]
    );
    // Without an intent (TUI) the stored text is the input.
    let plain = Stored {
        content: vec![ContentBlock::Text {
            text: "hello".into(),
        }],
        intent: None,
    };
    assert_eq!(
        plain.typed(),
        [ContentBlock::Text {
            text: "hello".into()
        }]
    );
}

/// Node `buildCanonicalIntent` carries the stored `genUiContext`; it passes no `inputOrigin`, `sharedContextRefs` or
/// `source`, so the replay's origin is the envelope's alone.
#[test]
fn a_replay_carries_gen_ui_context_and_takes_the_envelopes_origin() {
    let stored = stored_intent(
        json!({"genUiContext": {"surface": "card"}, "inputOrigin": "mobile",
        "sharedContextRefs": [{"id": "r"}], "source": "share"}),
    );
    let replayed = replayed_intent((2, 3), &envelope(), Some(&stored), "x", None, None);
    assert_eq!(
        replayed.get("genUiContext"),
        Some(&json!({"surface": "card"}))
    );
    assert_eq!(replayed.str("inputOrigin"), Some("desktop"));
    assert!(replayed.get("sharedContextRefs").is_none() && replayed.get("source").is_none());
    let mut bare = envelope();
    bare.input_origin = None;
    let replayed = replayed_intent((2, 3), &bare, Some(&stored), "x", None, None);
    assert_eq!(replayed.get("inputOrigin"), None);
}

/// B1.3 (specs/fork-rust-agent-parity.md): `retryTurn` keeps the managed-worktree guard (#478) — the field
/// riding on a retry is an ungated sender (a retry creates no session), so it is refused instead of dropped;
/// `forkAssistant` parses and executes its own typed shape now.
#[test]
fn a_retry_turn_target_cwd_is_refused_instead_of_dropped() {
    let plain: TargetPayload = serde_json::from_value(json!({
        "target": {"rowId": 3, "entityId": "msg_u1"}
    }))
    .unwrap();
    assert!(refuse_target_cwd(&envelope(), &plain, 7).is_none());
    let worktree: TargetPayload = serde_json::from_value(json!({
        "target": {"rowId": 3, "entityId": "msg_u1"},
        "targetCwd": {
            "cwd": "/w/.zcode-worktrees/one",
            "childSessionId": "child-1",
            "worktreeCreation": {
                "path": "/w/.zcode-worktrees/one", "sha": "a1b2c3d4", "ref": null, "output": ""
            }
        }
    }))
    .unwrap();
    let ack = refuse_target_cwd(&envelope(), &worktree, 7).expect("targetCwd is refused");
    assert_eq!(ack.status, Status::Rejected);
    assert_eq!(ack.reason_code.as_deref(), Some("proto.invalidPayload"));
    assert_eq!(
        ack.message.as_deref(),
        Some("targetCwd is not supported by this agent")
    );
}

/// B1.3: `forkAssistant.targetCwd` parses like Node's `forkTargetCwdSchema` (strict, every field required):
/// a present `null` is not an absent field, an unknown key inside it refuses, whitespace-only `cwd` /
/// `childSessionId` refuse with the field named, and a padded value trims before use
/// (`z.string().trim().min(1)`).
#[test]
fn a_fork_target_cwd_parses_typed_like_node() {
    let plain: ForkPayload = serde_json::from_value(json!({
        "target": {"rowId": 3, "entityId": "msg_a1"}
    }))
    .unwrap();
    assert!(plain.target_cwd.is_none());
    let worktree: ForkPayload = serde_json::from_value(json!({
        "target": {"rowId": 3, "entityId": "msg_a1"},
        "targetCwd": {
            "cwd": " /w/.zcode-worktrees/one ",
            "childSessionId": " child-1 ",
            "worktreeCreation": {
                "path": "/w/.zcode-worktrees/one", "sha": "a1b2c3d4", "ref": null, "output": ""
            }
        }
    }))
    .unwrap();
    let target = worktree.target_cwd.as_ref().expect("targetCwd parses");
    assert_eq!(target.cwd, "/w/.zcode-worktrees/one");
    assert_eq!(target.child_session_id, "child-1");
    assert_eq!(target.worktree_creation.path, "/w/.zcode-worktrees/one");
    // A present null is refused, not read as absent (Node's `.optional()` takes undefined only).
    let null_cwd: Result<ForkPayload, _> = serde_json::from_value(json!({
        "target": {"rowId": 3, "entityId": "msg_a1"}, "targetCwd": null
    }));
    assert!(null_cwd.is_err());
    // Strict: an unknown key inside the target refuses, never silently drops.
    let unknown: Result<ForkPayload, _> = serde_json::from_value(json!({
        "target": {"rowId": 3, "entityId": "msg_a1"},
        "targetCwd": {
            "cwd": "/w/.zcode-worktrees/one", "childSessionId": "child-1",
            "worktreeCreation": {
                "path": "/w/.zcode-worktrees/one", "sha": "a1b2c3d4", "ref": null, "output": ""
            },
            "branchName": "feat/b1"
        }
    }));
    assert!(unknown.is_err());
    // Every field is required: a target without the child id refuses.
    let no_child: Result<ForkPayload, _> = serde_json::from_value(json!({
        "target": {"rowId": 3, "entityId": "msg_a1"},
        "targetCwd": {
            "cwd": "/w/.zcode-worktrees/one",
            "worktreeCreation": {
                "path": "/w/.zcode-worktrees/one", "sha": "a1b2c3d4", "ref": null, "output": ""
            }
        }
    }));
    assert!(no_child.is_err());
    // Whitespace-only refuses with the field named.
    let blank_cwd: Result<ForkPayload, _> = serde_json::from_value(json!({
        "target": {"rowId": 3, "entityId": "msg_a1"},
        "targetCwd": {
            "cwd": "   ", "childSessionId": "child-1",
            "worktreeCreation": {
                "path": "/w/.zcode-worktrees/one", "sha": "a1b2c3d4", "ref": null, "output": ""
            }
        }
    }));
    assert!(
        blank_cwd
            .unwrap_err()
            .to_string()
            .contains("targetCwd.cwd must be a non-empty string")
    );
    let blank_child: Result<ForkPayload, _> = serde_json::from_value(json!({
        "target": {"rowId": 3, "entityId": "msg_a1"},
        "targetCwd": {
            "cwd": "/w/.zcode-worktrees/one", "childSessionId": "  ",
            "worktreeCreation": {
                "path": "/w/.zcode-worktrees/one", "sha": "a1b2c3d4", "ref": null, "output": ""
            }
        }
    }));
    assert!(
        blank_child
            .unwrap_err()
            .to_string()
            .contains("targetCwd.childSessionId must be a non-empty string")
    );
}
