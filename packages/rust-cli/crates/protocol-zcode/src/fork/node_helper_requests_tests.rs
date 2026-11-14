//! Fork: the helper's requests to Rust (specs/fork-rust-node-helper.md F3, "Helper → Rust requests").

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::*;
use crate::fork::node_helper::HelperRequests;
use crate::fork::node_helper::requests::{AUTHORIZE_APP_TOOL, SAMPLE_MODEL};

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

    async fn sample_model(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        if params["request"] == json!("wait") {
            cancel.cancelled().await;
            return Err(RpcError::internal("sampling withdrawn"));
        }
        Ok(json!({"sampled": true, "cancelled": cancel.is_cancelled()}))
    }

    fn session_delta(&self, _session: &str, _delta: Value) {}
}

/// A started helper (its generation is `1`) whose requests [`Answers`] answers.
async fn helper() -> (Rig, Arc<Answers>) {
    let rig = rig(fake(&["plugins/list"], mcp_echo()), timing());
    let answers = Arc::new(Answers);
    let weak: std::sync::Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    rig.helper.set_requests(weak);
    rig.helper
        .mcp_connect(&workspace_params(), "plugin:viewer:view")
        .await
        .expect("started");
    assert!(rig.helper.with_running(1, |_| ()));
    (rig, answers)
}

fn authorize(key: &str, input: Value) -> Value {
    json!({"requestKey": key, "sessionId": "s1", "input": input})
}

#[tokio::test]
async fn a_request_reaches_its_answerer_with_a_live_cancel() {
    let (rig, _answers) = helper().await;
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
    let (rig, _answers) = helper().await;
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
async fn a_lost_helper_abandons_its_requests_and_a_late_request_starts_cancelled() {
    let (rig, _answers) = helper().await;
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
    // Another generation's loss leaves it running.
    rig.helper.requests_lost(7);
    tokio::task::yield_now().await;
    assert!(!running.is_finished());
    rig.helper.requests_lost(1);
    assert!(running.await.unwrap().is_err());
    // A request of a generation that is not running (its link dropped before the request began) starts cancelled.
    let late = rig
        .helper
        .helper_request(7, AUTHORIZE_APP_TOOL, authorize("k2", json!({})))
        .await
        .unwrap();
    assert_eq!(late["cancelled"], json!(true));
}

#[tokio::test]
async fn a_request_without_a_key_an_answerer_or_a_known_method_is_refused() {
    let (rig, _answers) = helper().await;
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

fn sample(key: &str, request: Value) -> Value {
    json!({"requestKey": key, "sessionId": "s1", "request": request})
}

/// `helper/sampleModel` goes through the same keys as `helper/authorizeAppTool`: a cancel, an early cancel and a lost
/// helper all reach it.
#[tokio::test]
async fn a_sampling_request_is_keyed_cancelled_and_lost_like_an_authorization() {
    let (rig, _answers) = helper().await;
    let answer = rig
        .helper
        .helper_request(1, SAMPLE_MODEL, sample("s1", json!({})))
        .await
        .unwrap();
    assert_eq!(answer, json!({"sampled": true, "cancelled": false}));
    let spawn = |key: &'static str| {
        let helper = rig.helper.clone();
        tokio::spawn(async move {
            helper
                .helper_request(1, SAMPLE_MODEL, sample(key, json!("wait")))
                .await
        })
    };
    let running = spawn("s2");
    while rig.helper.requests.lock().unwrap().live.is_empty() {
        tokio::task::yield_now().await;
    }
    rig.helper.cancel_request(&json!({"requestKey": "s2"}));
    assert_eq!(
        running.await.unwrap().unwrap_err().message,
        "sampling withdrawn"
    );
    rig.helper.cancel_request(&json!({"requestKey": "s3"}));
    let early = rig
        .helper
        .helper_request(1, SAMPLE_MODEL, sample("s3", json!({})))
        .await
        .unwrap();
    assert_eq!(early["cancelled"], json!(true));
    let running = spawn("s4");
    while rig.helper.requests.lock().unwrap().live.is_empty() {
        tokio::task::yield_now().await;
    }
    rig.helper.requests_lost(1);
    assert!(running.await.unwrap().is_err());
    assert!(rig.helper.requests.lock().unwrap().live.is_empty());
}
