//! Fork: the helper's requests to Rust (specs/fork-rust-node-helper.md F3, "Helper → Rust requests").

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::*;
use crate::fork::node_helper::HelperRequests;
use crate::fork::node_helper::requests::AUTHORIZE_APP_TOOL;

/// Answers with its params; a request whose input says `wait` waits for its cancel and then fails.
struct Answers;

#[async_trait]
impl HelperRequests for Answers {
    async fn authorize_app_tool(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        if params["input"] == json!("wait") {
            cancel.cancelled().await;
            return Err(RpcError::internal("withdrawn"));
        }
        Ok(json!({"cancelled": cancel.is_cancelled(), "params": params}))
    }
}

fn helper() -> (Rig, Arc<Answers>) {
    let rig = rig(fake(&[], mcp_echo()), timing());
    let answers = Arc::new(Answers);
    let weak: std::sync::Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    rig.helper.set_requests(weak);
    (rig, answers)
}

fn authorize(key: &str, input: Value) -> Value {
    json!({"requestKey": key, "sessionId": "s1", "input": input})
}

#[tokio::test]
async fn a_request_reaches_its_answerer_with_a_live_cancel() {
    let (rig, _answers) = helper();
    let answer = rig
        .helper
        .helper_request(1, AUTHORIZE_APP_TOOL, authorize("k1", json!({})))
        .await
        .unwrap();
    assert_eq!(answer["cancelled"], json!(false));
    assert_eq!(answer["params"]["requestKey"], json!("k1"));
    assert!(rig.helper.requests.lock().unwrap().live.is_empty());
}

#[tokio::test]
async fn a_cancel_fires_the_running_request_and_an_early_cancel_is_remembered() {
    let (rig, _answers) = helper();
    let running = {
        let helper = rig.helper.clone();
        tokio::spawn(async move {
            helper
                .helper_request(1, AUTHORIZE_APP_TOOL, authorize("k1", json!("wait")))
                .await
        })
    };
    while rig.helper.requests.lock().unwrap().live.is_empty() {
        tokio::task::yield_now().await;
    }
    rig.helper.cancel_request(&json!({"requestKey": "k1"}));
    assert_eq!(running.await.unwrap().unwrap_err().message, "withdrawn");
    // The cancel overtook its request: the request starts cancelled.
    rig.helper.cancel_request(&json!({"requestKey": "k2"}));
    let answer = rig
        .helper
        .helper_request(1, AUTHORIZE_APP_TOOL, authorize("k2", json!({})))
        .await
        .unwrap();
    assert_eq!(answer["cancelled"], json!(true));
    // Each tombstone is used once.
    let answer = rig
        .helper
        .helper_request(1, AUTHORIZE_APP_TOOL, authorize("k2", json!({})))
        .await
        .unwrap();
    assert_eq!(answer["cancelled"], json!(false));
}

#[tokio::test]
async fn a_lost_helper_abandons_only_its_generations_requests() {
    let (rig, _answers) = helper();
    let spawn = |generation: u64, key: &'static str| {
        let helper = rig.helper.clone();
        tokio::spawn(async move {
            helper
                .helper_request(
                    generation,
                    AUTHORIZE_APP_TOOL,
                    authorize(key, json!("wait")),
                )
                .await
        })
    };
    let (old, new) = (spawn(1, "old"), spawn(2, "new"));
    while rig.helper.requests.lock().unwrap().live.len() < 2 {
        tokio::task::yield_now().await;
    }
    rig.helper.requests_lost(1);
    assert!(old.await.unwrap().is_err());
    assert!(!new.is_finished());
    rig.helper.requests_lost(2);
    assert!(new.await.unwrap().is_err());
}

#[tokio::test]
async fn a_request_without_a_key_an_answerer_or_a_known_method_is_refused() {
    let (rig, _answers) = helper();
    let error = rig
        .helper
        .helper_request(1, AUTHORIZE_APP_TOOL, json!({"sessionId": "s1"}))
        .await
        .unwrap_err();
    assert_eq!(
        error.code,
        rust_cli_protocol_core::rpc::codes::INVALID_PARAMS
    );
    let error = rig
        .helper
        .helper_request(1, "helper/unknown", authorize("k1", json!({})))
        .await
        .unwrap_err();
    assert_eq!(
        error.code,
        rust_cli_protocol_core::rpc::codes::METHOD_NOT_FOUND
    );
    let bare = rig_without_answers();
    expect_unavailable(
        &bare
            .helper
            .helper_request(1, AUTHORIZE_APP_TOOL, authorize("k1", json!({})))
            .await
            .unwrap_err(),
    );
}

fn rig_without_answers() -> Rig {
    rig(fake(&[], mcp_echo()), timing())
}
