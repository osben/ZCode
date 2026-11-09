//! Fork: the model of each committed assistant message reaches the view (the cold model switch divider,
//! specs/fork-rust-agent-parity.md).

use std::sync::Arc;

use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::session_api::SessionHandle;
use rust_cli_kernel_api::testing::{ScriptedModel, selection, text_response};

use crate::test_support::{Setup, finished, submit, until};

#[tokio::test]
async fn a_committed_reply_records_its_model() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["hello"])]));
    let built = Setup::new(model).build().await;
    let mut events = built.session.subscribe(None);
    built.session.send(submit("c1", "hi")).await;
    until(&mut events, finished).await;
    let view = built.session.view().await.unwrap();
    let reply = view
        .messages
        .iter()
        .find_map(|message| match message {
            Message::Assistant(assistant) => Some(assistant.id.clone()),
            _ => None,
        })
        .unwrap();
    let recorded = view.message_models.get(&reply).unwrap();
    assert_eq!(
        (recorded.provider.as_str(), recorded.model.as_str()),
        (selection().provider.as_str(), selection().model.as_str())
    );
}
