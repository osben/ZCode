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
            text: text.to_owned(),
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
            reason: ALREADY_SENT.to_owned()
        }
    );
    // No queued input carries this command id: the same rejection.
    assert_eq!(
        session.send(edit("c3", "nope", "new text")).await,
        Ack::Rejected {
            reason: ALREADY_SENT.to_owned()
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
