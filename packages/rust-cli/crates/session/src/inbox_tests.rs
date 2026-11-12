//! 输入调度的投影（inbox.rs）：一条输入只存一份，排队的输入与 next 通道都按到达顺序。

use rust_cli_kernel_api::ids::{CommandId, MessageId};
use rust_cli_kernel_api::session_api::{Delivery, QueuedInput};

use super::*;
use crate::peers::PeerItem;
use rust_cli_kernel_api::input_intent::InputIntent;
use rust_cli_kernel_api::message::ContentBlock;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::{ExecutionState, PermissionMode};
use rust_cli_kernel_api::session_api::{
    InputExecution, QUEUE_EDIT_LOCK_LOST, QUEUE_ITEM_EDIT_LOCKED, QUEUE_ITEM_MISSING,
    QUEUE_ITEM_NOT_EDITABLE, QueueEditLock, QueuedAttachments, QueuedEdit,
};
use serde_json::json;

fn input(command: &str, text: &str, delivery: Delivery) -> QueuedInput {
    QueuedInput {
        edit_lock: None,
        intent: None,
        command: CommandId::new(command),
        text: text.to_owned(),
        delivery,
        kind: Default::default(),
        execution: None,
    }
}

fn event(text: &str) -> Waiting {
    Waiting::MonitorEvent(text.to_owned())
}

fn receipt(key: &str) -> Waiting {
    Waiting::Peer(PeerItem::Receipt {
        status: rust_cli_kernel_api::peers::ReceiptStatus::Held,
        msg_ids: vec![key.to_owned()],
        text: key.to_owned(),
        passive: true,
    })
}

fn commands(inbox: &Inbox) -> Vec<String> {
    inbox
        .queued()
        .iter()
        .map(|input| input.command.as_str().to_owned())
        .collect()
}

fn lane(inbox: &Inbox) -> Vec<String> {
    inbox
        .lane()
        .map(|item| match item {
            LaneItem::Input(queued) => queued.input.command.as_str().to_owned(),
            LaneItem::Notice(notice) => notice.waiting.text(),
        })
        .collect()
}

#[test]
fn inputs_and_the_lane_are_projections_in_arrival_order() {
    let mut inbox = Inbox::default();
    inbox.push_input(input("q1", "later", Delivery::Queue), InputKind::Text);
    inbox.push_notice(event("n1"));
    inbox.push_input(input("s1", "steer", Delivery::Steer), InputKind::Text);
    inbox.push_first(input("start", "first", Delivery::Queue));
    assert_eq!(commands(&inbox), ["start", "q1", "s1"]);
    assert_eq!(lane(&inbox), ["start", "n1", "s1"]);
    // 去掉一条输入，两个投影里一起没了。
    assert!(
        inbox
            .remove_input(&CommandId::new("s1"), Left::Cancelled("user_removed"))
            .is_some()
    );
    assert_eq!(commands(&inbox), ["start", "q1"]);
    assert_eq!(lane(&inbox), ["start", "n1"]);
    // SessionStart 的首条输入在通道里。
    assert!(inbox.has_lane_input());
    // Fork: the ledger journal has the submitted inputs only, never the SessionStart input.
    let journal: Vec<String> = inbox
        .take_journal()
        .into_iter()
        .map(|change| match change {
            LedgerChange::Admitted(input) => {
                format!("admitted {} {:?}", input.command.as_str(), input.delivery)
            }
            LedgerChange::Promoted(command) => format!("promoted {}", command.as_str()),
            LedgerChange::Cancelled(command, reason) => {
                format!("cancelled {} {reason}", command.as_str())
            }
        })
        .collect();
    assert_eq!(
        journal,
        [
            "admitted q1 Queue",
            "admitted s1 Guide",
            "cancelled s1 user_removed"
        ]
    );
    let Some(Item::Input(start)) = inbox.pop_lane_front() else {
        panic!("the SessionStart input heads the lane");
    };
    assert_eq!(start.input.command.as_str(), "start");
    assert!(inbox.pop_later().is_some());
    assert_eq!(
        inbox.take_journal(),
        [LedgerChange::Promoted(CommandId::new("q1"))]
    );
}

#[test]
fn a_batch_takes_steered_inputs_first_then_later_ones_and_stops_at_a_notice() {
    let mut inbox = Inbox::default();
    inbox.push_input(input("q1", "later one", Delivery::Queue), InputKind::Text);
    inbox.push_input(input("s1", "steer one", Delivery::Steer), InputKind::Text);
    inbox.push_notice(event("n1"));
    inbox.push_input(input("q2", "later two", Delivery::Queue), InputKind::Text);
    let first = inbox.take_batched().unwrap();
    assert_eq!(first.input.command.as_str(), "s1");
    // 通道头是通知：不成批。
    assert!(inbox.take_batched().is_none());
    assert!(matches!(inbox.pop_lane_front(), Some(Item::Notice(_))));
    // 通道空了：later 输入按顺序。
    assert_eq!(inbox.take_batched().unwrap().input.command.as_str(), "q1");
    assert_eq!(inbox.take_batched().unwrap().input.command.as_str(), "q2");
    assert!(inbox.take_batched().is_none());
}

#[test]
fn a_batch_stops_at_slash_commands_mentions_and_bash() {
    for (text, kind) in [
        ("/compact", InputKind::Text),
        ("look at @a.txt", InputKind::Text),
        ("!ls", InputKind::Bash("ls".to_owned())),
    ] {
        let mut inbox = Inbox::default();
        inbox.push_input(input("q1", text, Delivery::Queue), kind);
        assert!(inbox.take_batched().is_none(), "{text}");
        assert!(inbox.has_inputs());
    }
}

#[test]
fn passive_notices_at_the_head_are_set_aside_and_put_back_in_order() {
    let mut inbox = Inbox::default();
    inbox.push_notice(receipt("r1"));
    inbox.push_notice(receipt("r2"));
    inbox.push_input(input("s1", "steer", Delivery::Steer), InputKind::Text);
    let passive = inbox.take_passive_prefix();
    assert_eq!(passive.len(), 2);
    assert_eq!(lane(&inbox), ["s1"]);
    inbox.restore_front(passive);
    assert_eq!(lane(&inbox), ["r1", "r2", "s1"]);
}

#[test]
fn a_held_input_keeps_its_hook_result() {
    let mut inbox = Inbox::default();
    inbox.push_input(input("s1", "steer", Delivery::Steer), InputKind::Text);
    inbox.hold(&CommandId::new("s1"), None);
    let Some(LaneItem::Input(queued)) = inbox.lane_front() else {
        panic!("the held input stays in the lane");
    };
    assert!(matches!(queued.screening, Screening::Held(None)));
}

/// 交给主循环的通知按 attachment 的消息 ID 取走（只在内存的身份），不按文字：同样文字的两条只取走交出去的那一条。
#[test]
fn an_absorbed_notice_is_taken_by_its_attachment_id() {
    let mut inbox = Inbox::default();
    inbox.push_notice(event("same line"));
    inbox.push_notice(event("same line"));
    let keys: Vec<NoticeKey> = inbox
        .lane()
        .map(|item| match item {
            LaneItem::Notice(notice) => notice.key,
            LaneItem::Input(_) => panic!("only notices"),
        })
        .collect();
    assert_ne!(keys[0], keys[1]);
    inbox.absorbing(keys[1], MessageId::new("msg_9"));
    assert!(inbox.take_absorbed(&MessageId::new("msg_1")).is_none());
    assert!(inbox.take_absorbed(&MessageId::new("msg_9")).is_some());
    let left: Vec<NoticeKey> = inbox
        .lane()
        .map(|item| match item {
            LaneItem::Notice(notice) => notice.key,
            LaneItem::Input(_) => panic!("only notices"),
        })
        .collect();
    assert_eq!(left, [keys[0]]);
}

fn lock_of(editor: &str) -> QueueEditLock {
    QueueEditLock {
        editor_id: editor.to_owned(),
        client_id: "client".to_owned(),
        input_origin: None,
    }
}

#[test]
fn a_locked_input_stops_the_batch_before_it() {
    let mut inbox = Inbox::default();
    inbox.push_input(input("c1", "first", Delivery::Queue), InputKind::Text);
    inbox.push_input(input("c2", "second", Delivery::Queue), InputKind::Text);
    inbox.push_input(input("c3", "third", Delivery::Queue), InputKind::Text);
    assert_eq!(inbox.lock(&CommandId::new("c2"), lock_of("ed")), Ok(true));
    // The head is not locked, so it starts; the batch stops before the locked second input.
    assert!(!inbox.head_locked());
    let head = inbox.pop_later().unwrap();
    assert_eq!(head.input.text, "first");
    assert!(inbox.take_batched().is_none());
    // Now the locked input is the next thing to start: the drain must stop before it.
    assert!(inbox.head_locked());
    assert_eq!(
        commands(&inbox),
        ["c2", "c3"],
        "the locked input and the one behind it stay queued"
    );
    // Releasing it puts the batch back.
    assert!(inbox.release(&CommandId::new("c2")));
    assert!(!inbox.head_locked());
    assert_eq!(inbox.take_batched().unwrap().input.text, "second");
}

#[test]
fn a_lock_is_idempotent_for_its_editor_and_refused_for_another() {
    let mut inbox = Inbox::default();
    inbox.push_input(input("c1", "first", Delivery::Queue), InputKind::Text);
    let command = CommandId::new("c1");
    assert_eq!(inbox.lock(&command, lock_of("ed1")), Ok(true));
    assert_eq!(inbox.lock(&command, lock_of("ed1")), Ok(false));
    assert_eq!(
        inbox.lock(&command, lock_of("ed2")),
        Err(QUEUE_ITEM_EDIT_LOCKED)
    );
    assert_eq!(
        inbox.lock(&CommandId::new("gone"), lock_of("ed1")),
        Err(QUEUE_ITEM_MISSING)
    );
}

#[test]
fn a_compaction_is_neither_lockable_nor_editable() {
    let mut inbox = Inbox::default();
    inbox.push_input(input("c1", "/compact", Delivery::Queue), InputKind::Compact);
    let command = CommandId::new("c1");
    assert_eq!(
        inbox.lock(&command, lock_of("ed1")),
        Err(QUEUE_ITEM_NOT_EDITABLE)
    );
    let edit = QueuedEdit {
        text: Some("changed".to_owned()),
        ..QueuedEdit::default()
    };
    assert_eq!(
        inbox.edit(&command, None, &edit, ExecutionState::default()),
        Err(QUEUE_ITEM_NOT_EDITABLE)
    );
}

#[test]
fn a_full_payload_edit_resolves_against_the_items_own_state() {
    let mut inbox = Inbox::default();
    let mut queued = input("c1", "plan this", Delivery::Queue);
    queued.intent = Some(Box::new(InputIntent::from_fields(
        json!({"text": "plan this", "highspeed": {"cardId": "card"}})
            .as_object()
            .unwrap()
            .clone(),
    )));
    inbox.push_input(queued, InputKind::Text);
    let command = CommandId::new("c1");
    let current = ExecutionState {
        mode: PermissionMode::Default,
        plan: false,
    };
    // A text-only edit keeps the frozen Highspeed card: the model did not change.
    let text_only = QueuedEdit {
        text: Some("changed".to_owned()),
        ..QueuedEdit::default()
    };
    assert_eq!(inbox.edit(&command, None, &text_only, current), Ok(false));
    let after_text = inbox.queued().remove(0);
    assert_eq!(after_text.text, "changed");
    assert!(after_text.intent.unwrap().get("highspeed").is_some());
    assert_eq!(
        after_text.execution, None,
        "no mode or model named: no frozen state"
    );
    // A model change drops it, and mode and plan resolve against the session's state (Node resolveExecutionState).
    let full = QueuedEdit {
        conversation_quotes: Some(json!([])),
        model_selection: Some(ModelSelection::new(
            "provider".to_owned(),
            "model-2".to_owned(),
        )),
        mode: Some("edit".to_owned()),
        plan_enabled: Some(true),
        ..QueuedEdit::default()
    };
    assert_eq!(inbox.edit(&command, None, &full, current), Ok(false));
    let edited = inbox.queued().remove(0);
    assert_eq!(
        edited.execution,
        Some(InputExecution {
            state: ExecutionState {
                mode: PermissionMode::AcceptEdits,
                plan: true,
            },
            selection: Some(ModelSelection::new(
                "provider".to_owned(),
                "model-2".to_owned()
            )),
        })
    );
    let intent = edited.intent.unwrap();
    assert!(intent.get("highspeed").is_none());
    assert_eq!(intent.get("conversationQuotes"), Some(&json!([])));
    assert_eq!(intent.text(), Some("changed"));
}

#[test]
fn an_edit_with_an_editor_releases_its_lock_and_a_lost_lock_is_refused() {
    let mut inbox = Inbox::default();
    inbox.push_input(input("c1", "first", Delivery::Queue), InputKind::Text);
    let command = CommandId::new("c1");
    let edit = QueuedEdit {
        text: Some("changed".to_owned()),
        ..QueuedEdit::default()
    };
    let current = ExecutionState::default();
    assert_eq!(inbox.lock(&command, lock_of("ed1")), Ok(true));
    assert_eq!(
        inbox.edit(&command, Some("ed2"), &edit, current),
        Err(QUEUE_EDIT_LOCK_LOST)
    );
    assert_eq!(inbox.edit(&command, Some("ed1"), &edit, current), Ok(true));
    assert!(inbox.edit_lock_of(&command).is_none());
    assert_eq!(
        inbox.edit(&command, Some("ed1"), &edit, current),
        Err(QUEUE_EDIT_LOCK_LOST)
    );
}

fn intent_of(fields: serde_json::Value) -> Option<Box<InputIntent>> {
    Some(Box::new(InputIntent::from_fields(
        fields.as_object().unwrap().clone(),
    )))
}

fn plan_state() -> ExecutionState {
    ExecutionState {
        mode: PermissionMode::Default,
        plan: true,
    }
}

#[test]
fn an_edit_writes_model_mode_and_plan_on_the_intent() {
    // Node `editedIntent`: the drained intent (stored on the user message) carries the edited config, not the
    // admitted one.
    let mut inbox = Inbox::default();
    let mut queued = input("c1", "go", Delivery::Queue);
    queued.intent = intent_of(json!({
        "text": "go",
        "modelSelection": {"providerId": "p", "modelId": "m1"},
        "mode": "build",
        "planEnabled": false,
        "clientId": "app"
    }));
    inbox.push_input(queued, InputKind::Text);
    let raw = json!({"providerId": "p", "modelId": "m2", "options": {"reasoningLevel": "high"}});
    let edit = QueuedEdit {
        model_selection: Some(ModelSelection::new("p", "m2")),
        intent_model_selection: Some(raw.clone()),
        mode: Some("edit".to_owned()),
        plan_enabled: Some(true),
        ..QueuedEdit::default()
    };
    assert_eq!(
        inbox.edit(
            &CommandId::new("c1"),
            None,
            &edit,
            ExecutionState::default()
        ),
        Ok(false)
    );
    let intent = inbox.queued().remove(0).intent.unwrap();
    assert_eq!(
        intent.get("modelSelection"),
        Some(&raw),
        "stored as the App sent it"
    );
    assert_eq!(intent.str("mode"), Some("edit"));
    assert_eq!(intent.get("planEnabled"), Some(&json!(true)));
    assert_eq!(intent.str("clientId"), Some("app"), "other fields stay");
}

#[test]
fn a_mode_only_edit_keeps_the_intents_plan() {
    // Node resolves the edited intent when the item starts: `{mode: "edit", planEnabled: true}` keeps plan on.
    let mut inbox = Inbox::default();
    let mut queued = input("c1", "go", Delivery::Queue);
    queued.intent = intent_of(json!({"text": "go", "mode": "build", "planEnabled": true}));
    queued.execution = Some(InputExecution {
        state: plan_state(),
        selection: None,
    });
    inbox.push_input(queued, InputKind::Text);
    let edit = QueuedEdit {
        mode: Some("edit".to_owned()),
        ..QueuedEdit::default()
    };
    assert_eq!(
        inbox.edit(
            &CommandId::new("c1"),
            None,
            &edit,
            ExecutionState::default()
        ),
        Ok(false)
    );
    let edited = inbox.queued().remove(0);
    assert_eq!(
        edited.execution.unwrap().state,
        ExecutionState {
            mode: PermissionMode::AcceptEdits,
            plan: true
        }
    );
    let intent = edited.intent.unwrap();
    assert_eq!(intent.str("mode"), Some("edit"));
    assert_eq!(intent.get("planEnabled"), Some(&json!(true)));
}

#[test]
fn a_mode_only_edit_with_no_plan_anywhere_turns_plan_off_like_node() {
    // Node `resolveExecutionState({mode: "edit"})`: a known mode with no planEnabled turns plan off.
    let mut inbox = Inbox::default();
    let mut queued = input("c1", "go", Delivery::Queue);
    queued.intent = intent_of(json!({"text": "go"}));
    queued.execution = Some(InputExecution {
        state: plan_state(),
        selection: None,
    });
    inbox.push_input(queued, InputKind::Text);
    let edit = QueuedEdit {
        mode: Some("edit".to_owned()),
        ..QueuedEdit::default()
    };
    inbox
        .edit(
            &CommandId::new("c1"),
            None,
            &edit,
            ExecutionState::default(),
        )
        .unwrap();
    let edited = inbox.queued().remove(0);
    assert!(!edited.execution.unwrap().state.plan);
    assert!(edited.intent.unwrap().get("planEnabled").is_none());
}

#[test]
fn a_model_change_is_judged_against_the_intents_raw_selection() {
    let mut inbox = Inbox::default();
    let mut queued = input("c1", "go", Delivery::Queue);
    let raw = json!({"providerId": "p", "modelId": "m1"});
    queued.intent =
        intent_of(json!({"text": "go", "modelSelection": raw, "highspeed": {"cardId": "x"}}));
    inbox.push_input(queued, InputKind::Text);
    // The same selection sent again is not a model change, even though the item had no frozen selection.
    let same = QueuedEdit {
        model_selection: Some(ModelSelection::new("p", "m1")),
        intent_model_selection: Some(raw),
        ..QueuedEdit::default()
    };
    inbox
        .edit(
            &CommandId::new("c1"),
            None,
            &same,
            ExecutionState::default(),
        )
        .unwrap();
    assert!(
        inbox.queued()[0]
            .intent
            .as_ref()
            .unwrap()
            .get("highspeed")
            .is_some()
    );
}

fn attachments(refs: serde_json::Value, content: Vec<ContentBlock>) -> QueuedAttachments {
    QueuedAttachments { refs, content }
}

fn material() -> ContentBlock {
    ContentBlock::Text {
        text: "<file a.txt>".to_owned(),
    }
}

#[test]
fn an_attachment_edit_reaches_the_turn_and_the_intent() {
    let mut inbox = Inbox::default();
    let mut queued = input("c1", "look", Delivery::Queue);
    queued.intent = intent_of(json!({"text": "look"}));
    inbox.push_input(queued, InputKind::Text);
    let refs = json!([{"ref": "a.txt", "kind": "file"}]);
    let edit = QueuedEdit {
        attachments: Some(attachments(refs.clone(), vec![material()])),
        ..QueuedEdit::default()
    };
    inbox
        .edit(
            &CommandId::new("c1"),
            None,
            &edit,
            ExecutionState::default(),
        )
        .unwrap();
    assert_eq!(
        inbox.queued()[0]
            .intent
            .as_ref()
            .unwrap()
            .get("attachmentRefs"),
        Some(&refs)
    );
    // A text edit replaces the typed text block and keeps the attachment.
    let text = QueuedEdit {
        text: Some("look again".to_owned()),
        ..QueuedEdit::default()
    };
    inbox
        .edit(
            &CommandId::new("c1"),
            None,
            &text,
            ExecutionState::default(),
        )
        .unwrap();
    let head = inbox.pop_later().unwrap();
    match head.kind {
        InputKind::Content(content) => assert_eq!(
            content,
            vec![
                ContentBlock::Text {
                    text: "look again".to_owned()
                },
                material()
            ]
        ),
        other => panic!("expected content, got {other:?}"),
    }
}

#[test]
fn clearing_the_attachments_makes_a_text_input_again() {
    let mut inbox = Inbox::default();
    let mut queued = input("c1", "look", Delivery::Queue);
    queued.intent = intent_of(json!({"text": "look", "attachmentRefs": [{"ref": "a.txt"}]}));
    inbox.push_input(
        queued,
        InputKind::Content(vec![
            ContentBlock::Text {
                text: "look".to_owned(),
            },
            material(),
        ]),
    );
    let edit = QueuedEdit {
        attachments: Some(attachments(json!([]), Vec::new())),
        ..QueuedEdit::default()
    };
    inbox
        .edit(
            &CommandId::new("c1"),
            None,
            &edit,
            ExecutionState::default(),
        )
        .unwrap();
    assert_eq!(
        inbox.queued()[0]
            .intent
            .as_ref()
            .unwrap()
            .get("attachmentRefs"),
        Some(&json!([])),
        "`[]` is stored, as Node keeps a truthy empty list"
    );
    assert!(matches!(inbox.pop_later().unwrap().kind, InputKind::Text));
}

#[test]
fn a_text_edit_of_a_content_input_without_typed_text_adds_the_text_block() {
    let mut inbox = Inbox::default();
    inbox.push_input(
        input("c1", "", Delivery::Queue),
        InputKind::Content(vec![material()]),
    );
    let edit = QueuedEdit {
        text: Some("now with words".to_owned()),
        ..QueuedEdit::default()
    };
    inbox
        .edit(
            &CommandId::new("c1"),
            None,
            &edit,
            ExecutionState::default(),
        )
        .unwrap();
    match inbox.pop_later().unwrap().kind {
        InputKind::Content(content) => assert_eq!(
            content,
            vec![
                ContentBlock::Text {
                    text: "now with words".to_owned()
                },
                material()
            ]
        ),
        other => panic!("expected content, got {other:?}"),
    }
}

#[test]
fn full_access_rewrites_the_intents_mode() {
    // Node's grant rewrites the queued intents' mode (`item.intent = {...item.intent, mode}`).
    let mut inbox = Inbox::default();
    let mut queued = input("c1", "go", Delivery::Queue);
    queued.intent = intent_of(json!({"text": "go", "mode": "build"}));
    queued.execution = Some(InputExecution {
        state: ExecutionState::default(),
        selection: None,
    });
    inbox.push_input(queued, InputKind::Text);
    assert!(inbox.set_queued_mode(PermissionMode::BypassPermissions));
    let intent = inbox.queued().remove(0).intent.unwrap();
    assert_eq!(
        intent.str("mode"),
        Some(PermissionMode::BypassPermissions.node_name())
    );
}
