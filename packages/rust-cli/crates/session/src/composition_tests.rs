//! The session's composition record follows the model it was measured for: a model change drops it and moves the revision
//! (kernel-api `context_composition`, spec "Rust port, step 2"). Node reads the model from the selection, so a model
//! change makes the last request's composition describe a model that is no longer selected.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use rust_cli_kernel_api::context_composition::{CompositionRecord, CompositionStore};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::{ModelError, ModelEvent, ModelPort, ModelRequest, ModelSelection};
use rust_cli_kernel_api::session_api::{Ack, Command, KernelEvent, SessionHandle};
use rust_cli_kernel_api::testing::selection;
use tokio_util::sync::CancellationToken;

use crate::test_support::{Setup, envelope};

/// A model that never answers: these tests only send commands.
struct Silent;

#[async_trait]
impl ModelPort for Silent {
    fn stream(
        &self,
        _request: ModelRequest,
        _cancel: CancellationToken,
    ) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        futures_util::stream::pending().boxed()
    }
}

/// The record of a request sent to the session's default model (`testing::selection`: "fixture" / "scripted").
fn measured() -> CompositionRecord {
    CompositionRecord {
        provider_id: "fixture".to_owned(),
        model_id: "scripted".to_owned(),
        measured_at_ms: 0,
        estimated_tokens: 10,
        categories: Vec::new(),
        provider_usage: None,
    }
}

/// Seeds a record, sends `SetModel`, waits for `ModelChanged`, and returns the revision and whether a record is kept.
async fn set_model(
    setup: Setup,
    store: &Arc<CompositionStore>,
    chosen: ModelSelection,
) -> (u64, bool) {
    let session_id = SessionId::new("sess_1");
    store.record(&session_id, measured());
    let built = setup.build().await;
    let mut events = built.session.subscribe(None);
    let ack = built
        .session
        .send(envelope(
            "cmd_model",
            Command::SetModel { selection: chosen },
        ))
        .await;
    assert!(matches!(ack, Ack::Accepted { .. }), "{ack:?}");
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .unwrap()
            .unwrap()
            .event;
        if matches!(event, KernelEvent::ModelChanged { .. }) {
            break;
        }
    }
    let kept = store.snapshot(&session_id).1.is_some();
    (store.revision(&session_id), kept)
}

/// A model change drops the measured record and the revision goes up (1 seeded, 2 after the invalidation).
#[tokio::test]
async fn a_model_change_drops_the_measured_composition() {
    let setup = Setup::new(Arc::new(Silent));
    let store = setup.compositions.clone();
    let chosen = ModelSelection::new("fixture".to_owned(), "other".to_owned());
    let (revision, kept) = set_model(setup, &store, chosen).await;
    assert_eq!((revision, kept), (2, false));
}

/// Choosing the model that is already selected changes nothing: the record stays and the revision does not move.
#[tokio::test]
async fn choosing_the_selected_model_keeps_the_composition() {
    let setup = Setup::new(Arc::new(Silent));
    let store = setup.compositions.clone();
    let (revision, kept) = set_model(setup, &store, selection()).await;
    assert_eq!((revision, kept), (1, true));
}
