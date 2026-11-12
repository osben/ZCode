//! Fork: the session actor writes Node's `session_input` ledger (specs/fork-rust-agent-parity.md, Input ledger).

use rust_cli_kernel_api::store::{AdmittedInput, InputDelivery};

use super::*;
use crate::test_support::Setup;

fn queued(id: &str, text: &str, delivery: Delivery) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command: Command::Submit {
            text: text.to_owned(),
            attachments: Vec::new(),
            delivery,
        },
    }
}

fn ledger(store: &MemoryStore) -> Vec<Fact> {
    store
        .facts(&SessionId::new("sess_1"))
        .into_iter()
        .filter(|fact| {
            matches!(
                fact,
                Fact::InputAdmitted { .. }
                    | Fact::InputPromoted { .. }
                    | Fact::InputCancelled { .. }
                    | Fact::InputsResumed { .. }
            )
        })
        .collect()
}

fn admitted(command: &str, text: &str, delivery: InputDelivery) -> Fact {
    Fact::InputAdmitted {
        input: AdmittedInput {
            command: CommandId::new(command),
            kind: "sendText".to_owned(),
            delivery,
            text: text.to_owned(),
        },
    }
}

#[tokio::test]
async fn queued_inputs_are_admitted_and_leave_the_ledger_promoted_or_cancelled() {
    let scope = TaskScope::root("test", |_| {});
    let (store, _model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session.send(submit("c1", "ask me")).await;
    let interaction = asked(&mut events).await;
    session
        .send(queued("c2", "after this turn", Delivery::Queue))
        .await;
    session.send(queued("c3", "also b", Delivery::Steer)).await;
    session
        .send(CommandEnvelope {
            id: CommandId::new("c4"),
            command: Command::Dequeue {
                command: CommandId::new("c2"),
            },
        })
        .await;
    session.send(answer("c5", interaction)).await;
    until_finished(&mut events, 1).await;
    // The view round-trips through the actor: the iteration that settled the steer has written its journal.
    session.view().await.unwrap();
    assert_eq!(
        ledger(&store),
        [
            admitted("c2", "after this turn", InputDelivery::Queue),
            admitted("c3", "also b", InputDelivery::Guide),
            Fact::InputCancelled {
                command: CommandId::new("c2"),
                reason: "user_removed".to_owned(),
            },
            Fact::InputPromoted {
                command: CommandId::new("c3"),
            },
        ]
    );
}

#[tokio::test]
async fn an_input_submitted_while_idle_has_no_ledger_row() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["hi"])]));
    let built = Setup::new(model).build().await;
    let mut events = built.session.subscribe(None);
    built.session.send(submit("c1", "hi")).await;
    crate::test_support::until(&mut events, crate::test_support::finished).await;
    assert!(ledger(&built.store).is_empty());
}

#[tokio::test]
async fn a_session_opened_from_the_store_sweeps_its_ledger_once() {
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let mut setup = Setup::new(model);
    setup.start = StartSource::Resume;
    let built = setup.build().await;
    built.session.view().await.unwrap();
    assert_eq!(
        ledger(&built.store),
        [Fact::InputsResumed {
            transcript: Vec::new()
        }]
    );
}
