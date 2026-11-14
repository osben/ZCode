//! Fork: in-place queue editing (`Command::EditQueued` / `ReorderQueued` / `HoldQueue`, Node
//! `editQueueItem` / `reorderQueueItem` / `setAutoDrain`, specs/fork-rust-agent-parity.md): an edit
//! keeps the input's place and changes what the model receives, a reorder moves before the anchor or
//! to the end, and a held queue stops the drain at turn end until it is released.

use super::*;
use crate::lane::ALREADY_SENT;

/// The request indices whose messages contain this text (empty when it never went out).
fn requests_with(model: &ScriptedModel, text: &str) -> Vec<usize> {
    model
        .requests()
        .iter()
        .enumerate()
        .filter(|(_, request)| format!("{:?}", request.messages).contains(text))
        .map(|(at, _)| at)
        .collect()
}

fn edit(id: &str, command: &str, text: &str) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command: Command::EditQueued {
            command: CommandId::new(command),
            edit: rust_cli_kernel_api::session_api::QueuedEdit {
                text: Some(text.to_owned()),
                ..Default::default()
            },
        },
    }
}

fn reorder(id: &str, command: &str, before: Option<&str>) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command: Command::ReorderQueued {
            command: CommandId::new(command),
            before: before.map(CommandId::new),
        },
    }
}

fn hold(id: &str, held: bool) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command: Command::HoldQueue { held },
    }
}

/// The queued texts in order (the queue view is the projection of the inbox's inputs).
async fn queue_texts(session: &Session) -> Vec<String> {
    session
        .view()
        .await
        .unwrap()
        .queue
        .into_iter()
        .map(|input| input.text)
        .collect()
}

#[tokio::test]
async fn an_edited_input_keeps_its_place_and_sends_the_new_text() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session.send(submit("c1", "ask me")).await;
    let interaction = asked(&mut events).await;
    session.send(submit("c2", "alpha")).await;
    session.send(submit("c3", "beta")).await;
    // Edit the second queued input: the position is kept, the text replaced.
    assert_eq!(
        session.send(edit("c4", "c3", "CHANGED")).await,
        Ack::Accepted {
            result: rust_cli_kernel_api::session_api::CommandResult::Done
        }
    );
    assert_eq!(queue_texts(&session).await, ["alpha", "CHANGED"]);
    assert!(matches!(
        session.send(edit("c5", "c2", "ALPHA")).await,
        Ack::Accepted { .. }
    ));
    assert_eq!(queue_texts(&session).await, ["ALPHA", "CHANGED"]);
    session.send(answer("c6", interaction)).await;
    // The first turn ends, the queued inputs (the head with the batched second one) run after it.
    until_finished(&mut events, 2).await;
    assert!(!requests_with(&model, "ALPHA").is_empty());
    assert!(!requests_with(&model, "CHANGED").is_empty());
    // The original texts went nowhere: not to the model, not into the conversation.
    assert!(requests_with(&model, "alpha").is_empty());
    assert!(requests_with(&model, "beta").is_empty());
    let messages = session.view().await.unwrap().messages;
    assert!(!format!("{messages:?}").contains("alpha"));
    assert!(!format!("{messages:?}").contains("beta"));
    assert!(queue_texts(&session).await.is_empty());
}

#[tokio::test]
async fn an_input_that_already_went_out_cannot_be_edited() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, _model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    // An input submitted while idle starts its turn at once, it never enters the queue.
    session.send(submit("c1", "ask me")).await;
    asked(&mut events).await;
    assert_eq!(
        session.send(edit("c2", "c1", "new text")).await,
        Ack::Rejected {
            reason: rust_cli_kernel_api::session_api::QUEUE_ITEM_MISSING.to_owned()
        }
    );
    // No queued input carries this command id: the same rejection.
    assert_eq!(
        session.send(edit("c3", "nope", "new text")).await,
        Ack::Rejected {
            reason: rust_cli_kernel_api::session_api::QUEUE_ITEM_MISSING.to_owned()
        }
    );
}

#[tokio::test]
async fn a_reorder_moves_before_the_anchor_and_to_the_end() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session.send(submit("c1", "ask me")).await;
    let interaction = asked(&mut events).await;
    session.send(submit("c2", "alpha")).await;
    session.send(submit("c3", "beta")).await;
    session.send(submit("c4", "gamma")).await;
    // Before another queued input …
    assert!(matches!(
        session.send(reorder("c5", "c4", Some("c2"))).await,
        Ack::Accepted { .. }
    ));
    assert_eq!(queue_texts(&session).await, ["gamma", "alpha", "beta"]);
    // … and to the end (before is None).
    assert!(matches!(
        session.send(reorder("c6", "c2", None)).await,
        Ack::Accepted { .. }
    ));
    assert_eq!(queue_texts(&session).await, ["gamma", "beta", "alpha"]);
    // An anchor that is not queued any more (or never was) changes nothing and is rejected.
    assert_eq!(
        session.send(reorder("c7", "c3", Some("missing"))).await,
        Ack::Rejected {
            reason: ALREADY_SENT.to_owned()
        }
    );
    assert_eq!(
        session.send(reorder("c8", "missing", None)).await,
        Ack::Rejected {
            reason: ALREADY_SENT.to_owned()
        }
    );
    assert_eq!(queue_texts(&session).await, ["gamma", "beta", "alpha"]);
    session.send(answer("c9", interaction)).await;
    // The drain after the first turn starts the reordered head (with the rest batched into it).
    until_finished(&mut events, 2).await;
    assert_eq!(requests_with(&model, "gamma"), [2]);
    assert!(queue_texts(&session).await.is_empty());
}

#[tokio::test]
async fn holding_stops_the_drain_and_releasing_starts_the_head() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session.send(submit("c1", "ask me")).await;
    let interaction = asked(&mut events).await;
    session.send(submit("c2", "first held")).await;
    session.send(submit("c3", "second held")).await;
    assert!(matches!(
        session.send(hold("c4", true)).await,
        Ack::Accepted { .. }
    ));
    session.send(answer("c5", interaction)).await;
    until_finished(&mut events, 1).await;
    // The finished turn did not start the next queued input: the queue is intact, the session is idle
    // and the model saw only the first turn's two requests.
    assert_eq!(queue_texts(&session).await, ["first held", "second held"]);
    assert_eq!(model.requests().len(), 2);
    assert!(!session.view().await.unwrap().running);
    // Releasing while idle starts the head of the queue, like a turn end would (the plain second
    // input is batched into the same turn, so one turn takes both).
    assert!(matches!(
        session.send(hold("c6", false)).await,
        Ack::Accepted { .. }
    ));
    // The scripted model can finish the started turn before the next view, so only the drained queue is
    // checked here, not `running`.
    assert!(queue_texts(&session).await.is_empty());
    until_finished(&mut events, 1).await;
    assert!(!requests_with(&model, "first held").is_empty());
    assert!(!requests_with(&model, "second held").is_empty());
    assert!(queue_texts(&session).await.is_empty());
}

/// Fork: the composer edit lock (Node `lockQueueItemEdit` / `releaseQueueItemEdit`, specs/fork-rust-agent-parity.md
/// "A1 and A2"). Lock, release and edit are the actor's; the protocol's reservation is not part of these tests.
mod edit_lock {
    use super::*;
    use rust_cli_kernel_api::session_api::{
        QUEUE_EDIT_LOCK_LOST, QUEUE_EDIT_LOCK_MISSING, QUEUE_ITEM_EDIT_LOCKED, QUEUE_ITEM_MISSING,
        QueueEditLock, QueuedEdit,
    };

    fn lock_by(id: &str, command: &str, editor: &str) -> CommandEnvelope {
        CommandEnvelope {
            id: CommandId::new(id),
            command: Command::LockQueuedEdit {
                command: CommandId::new(command),
                lock: QueueEditLock {
                    editor_id: editor.to_owned(),
                    client_id: "client-desk".to_owned(),
                    input_origin: Some("desktop".to_owned()),
                },
            },
        }
    }

    fn release(id: &str, command: &str) -> CommandEnvelope {
        CommandEnvelope {
            id: CommandId::new(id),
            command: Command::ReleaseQueuedEdit {
                command: CommandId::new(command),
            },
        }
    }

    fn edit_with(id: &str, command: &str, editor: Option<&str>, text: &str) -> CommandEnvelope {
        CommandEnvelope {
            id: CommandId::new(id),
            command: Command::EditQueued {
                command: CommandId::new(command),
                edit: QueuedEdit {
                    editor_id: editor.map(str::to_owned),
                    text: Some(text.to_owned()),
                    ..QueuedEdit::default()
                },
            },
        }
    }

    fn dequeue(id: &str, command: &str) -> CommandEnvelope {
        CommandEnvelope {
            id: CommandId::new(id),
            command: Command::Dequeue {
                command: CommandId::new(command),
            },
        }
    }

    fn clear(id: &str, command: &str) -> CommandEnvelope {
        CommandEnvelope {
            id: CommandId::new(id),
            command: Command::ClearQueued {
                command: CommandId::new(command),
            },
        }
    }

    fn rejected(reason: &str) -> Ack {
        Ack::Rejected {
            reason: reason.to_owned(),
        }
    }

    fn accepted() -> Ack {
        Ack::Accepted {
            result: rust_cli_kernel_api::session_api::CommandResult::Done,
        }
    }

    /// The lock of a queued input, as the view shows it.
    async fn lock_of(session: &Session, command: &str) -> Option<QueueEditLock> {
        session
            .view()
            .await
            .unwrap()
            .queue
            .into_iter()
            .find(|input| input.command.as_str() == command)
            .and_then(|input| input.edit_lock)
    }

    #[tokio::test]
    async fn a_lock_is_idempotent_for_its_editor_and_refused_for_another() {
        let scope = TaskScope::root("test", |_| {});
        let (_store, _model, session) = asking_session(&scope).await;
        let mut events = session.subscribe(Some(0));
        session.send(submit("c1", "ask me")).await;
        let interaction = asked(&mut events).await;
        session.send(submit("c2", "alpha")).await;
        assert_eq!(session.send(lock_by("l1", "c2", "ed1")).await, accepted());
        // The same editor again: accepted, and the first lock keeps its client and origin.
        assert_eq!(session.send(lock_by("l2", "c2", "ed1")).await, accepted());
        let lock = lock_of(&session, "c2").await.unwrap();
        assert_eq!(lock.editor_id, "ed1");
        assert_eq!(lock.client_id, "client-desk");
        assert_eq!(lock.input_origin.as_deref(), Some("desktop"));
        // Another editor: refused, the lock stays with the first one.
        assert_eq!(
            session.send(lock_by("l3", "c2", "ed2")).await,
            rejected(QUEUE_ITEM_EDIT_LOCKED)
        );
        assert_eq!(lock_of(&session, "c2").await.unwrap().editor_id, "ed1");
        // Not queued (never was, or already went out): the noop reason.
        assert_eq!(
            session.send(lock_by("l4", "missing", "ed1")).await,
            rejected(QUEUE_ITEM_MISSING)
        );
        session.send(answer("c9", interaction)).await;
        until_finished(&mut events, 1).await;
    }

    #[tokio::test]
    async fn an_edit_needs_the_lock_of_its_editor_and_releases_it() {
        let scope = TaskScope::root("test", |_| {});
        let (_store, _model, session) = asking_session(&scope).await;
        let mut events = session.subscribe(Some(0));
        session.send(submit("c1", "ask me")).await;
        let interaction = asked(&mut events).await;
        session.send(submit("c2", "alpha")).await;
        session.send(lock_by("l1", "c2", "ed1")).await;
        // Without an editor a locked input is refused; with another editor the lock is lost.
        assert_eq!(
            session.send(edit_with("e1", "c2", None, "no")).await,
            rejected(QUEUE_ITEM_EDIT_LOCKED)
        );
        assert_eq!(
            session.send(edit_with("e2", "c2", Some("ed2"), "no")).await,
            rejected(QUEUE_EDIT_LOCK_LOST)
        );
        assert_eq!(queue_texts(&session).await, ["alpha"]);
        // The holder's edit applies and releases the lock.
        assert_eq!(
            session
                .send(edit_with("e3", "c2", Some("ed1"), "CHANGED"))
                .await,
            accepted()
        );
        assert_eq!(queue_texts(&session).await, ["CHANGED"]);
        assert!(lock_of(&session, "c2").await.is_none());
        // Released already: a release is the noop reason, and an edit with an editor is a lost lock.
        assert_eq!(
            session.send(release("r1", "c2")).await,
            rejected(QUEUE_EDIT_LOCK_MISSING)
        );
        assert_eq!(
            session
                .send(edit_with("e4", "c2", Some("ed1"), "again"))
                .await,
            rejected(QUEUE_EDIT_LOCK_LOST)
        );
        // An edit without an editor and without a lock is the plain edit.
        assert_eq!(
            session.send(edit_with("e5", "c2", None, "plain")).await,
            accepted()
        );
        assert_eq!(queue_texts(&session).await, ["plain"]);
        // A missing input is the noop reason (no editor), the lock-lost reason with one.
        assert_eq!(
            session.send(edit_with("e6", "nope", None, "x")).await,
            rejected(QUEUE_ITEM_MISSING)
        );
        session.send(answer("c9", interaction)).await;
        until_finished(&mut events, 2).await;
    }

    #[tokio::test]
    async fn a_locked_head_stops_the_drain_and_a_release_starts_it() {
        let scope = TaskScope::root("test", |_| {});
        let (_store, model, session) = asking_session(&scope).await;
        let mut events = session.subscribe(Some(0));
        session.send(submit("c1", "ask me")).await;
        let interaction = asked(&mut events).await;
        session.send(submit("c2", "first locked")).await;
        session.send(submit("c3", "second plain")).await;
        session.send(lock_by("l1", "c2", "ed1")).await;
        session.send(answer("c4", interaction)).await;
        until_finished(&mut events, 1).await;
        // The finished turn did not start the locked head: no turn, nothing paused, both inputs still queued.
        assert_eq!(
            queue_texts(&session).await,
            ["first locked", "second plain"]
        );
        assert_eq!(model.requests().len(), 2);
        assert!(!session.view().await.unwrap().running);
        // Releasing while idle starts the head as a turn end would (the plain input batches into it).
        assert_eq!(session.send(release("r1", "c2")).await, accepted());
        assert!(queue_texts(&session).await.is_empty());
        until_finished(&mut events, 1).await;
        assert!(!requests_with(&model, "first locked").is_empty());
        assert!(!requests_with(&model, "second plain").is_empty());
    }

    #[tokio::test]
    async fn a_locked_input_is_not_removed_or_moved_but_clear_removes_it_with_its_lock() {
        let scope = TaskScope::root("test", |_| {});
        let (_store, _model, session) = asking_session(&scope).await;
        let mut events = session.subscribe(Some(0));
        session.send(submit("c1", "ask me")).await;
        let interaction = asked(&mut events).await;
        session.send(submit("c2", "alpha")).await;
        session.send(submit("c3", "beta")).await;
        session.send(lock_by("l1", "c3", "ed1")).await;
        assert_eq!(
            session.send(dequeue("d1", "c3")).await,
            rejected(QUEUE_ITEM_EDIT_LOCKED)
        );
        assert_eq!(
            session.send(reorder("o1", "c3", Some("c2"))).await,
            rejected(QUEUE_ITEM_EDIT_LOCKED)
        );
        assert_eq!(queue_texts(&session).await, ["alpha", "beta"]);
        // Moving another input in front of the locked one is fine: only the locked input itself is refused.
        assert!(matches!(
            session.send(reorder("o2", "c2", Some("c3"))).await,
            Ack::Accepted { .. }
        ));
        assert_eq!(queue_texts(&session).await, ["alpha", "beta"]);
        // Clear-all removes the locked input and its lock together.
        assert_eq!(session.send(clear("k1", "c3")).await, accepted());
        assert_eq!(queue_texts(&session).await, ["alpha"]);
        assert!(lock_of(&session, "c2").await.is_none());
        session.send(answer("c9", interaction)).await;
        until_finished(&mut events, 2).await;
    }
}
