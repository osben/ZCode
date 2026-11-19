//! Fork: the helper's requests to Rust (specs/fork-rust-node-helper.md F3, "Helper → Rust requests").

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::*;
use crate::fork::node_helper::HelperRequests;
use crate::fork::node_helper::requests::{
    AUTHORIZE_APP_TOOL, BROWSER_EXECUTE, BROWSER_LIST, ELICITATION, SAMPLE_MODEL,
};

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

    /// F3b(c) PR 2: a question whose message says `wait` waits for its cancel, and answers `cancel` once withdrawn.
    async fn elicitation(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        if params["message"] == json!("wait") {
            cancel.cancelled().await;
            return Ok(json!({"action": "cancel"}));
        }
        Ok(json!({"action": "accept", "content": {"name": "Ada"}, "params": params}))
    }

    fn session_delta(&self, _session: &str, _delta: Value) {}

    async fn browser_request(&self, _method: &str, params: Value) -> Result<Value, RpcError> {
        // Only the helper's cancel ends a waiting browser request (the test below), so it never answers here.
        if params["sessionId"] == json!("hang") {
            std::future::pending::<()>().await;
        }
        Ok(params)
    }

    async fn session_workspace(&self, _session: &str) -> Option<Value> {
        Some(json!({"workspacePath": "/w"}))
    }
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

/// F4b: a browser request is answered by the browser relay, and a helper cancel abandons one that is still waiting.
#[tokio::test]
async fn a_browser_request_is_answered_and_a_cancel_abandons_it() {
    let (rig, _answers) = helper().await;
    let answer = rig
        .helper
        .helper_request(
            1,
            BROWSER_LIST,
            json!({"requestKey": "b1", "sessionId": "s1"}),
        )
        .await
        .unwrap();
    // The answerer sees the request's params; the relay, not this layer, removes requestKey.
    assert_eq!(answer["requestKey"], json!("b1"));
    assert!(rig.helper.requests.lock().unwrap().live.is_empty());

    let running = {
        let helper = rig.helper.clone();
        tokio::spawn(async move {
            helper
                .helper_request(
                    1,
                    BROWSER_EXECUTE,
                    json!({"requestKey": "b2", "sessionId": "hang"}),
                )
                .await
        })
    };
    while rig.helper.requests.lock().unwrap().live.is_empty() {
        tokio::task::yield_now().await;
    }
    rig.helper.cancel_request(&json!({"requestKey": "b2"}));
    // The unavailable error carries a code suffix; the text names the abandoned request.
    assert!(
        running
            .await
            .unwrap()
            .unwrap_err()
            .message
            .starts_with("the browser request was abandoned")
    );
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

fn elicit(key: &str, message: &str) -> Value {
    json!({
        "requestKey": key,
        "sessionId": "s1",
        "serverName": "plugin:calc:app",
        "toolUseId": "toolu_1",
        "message": message,
        "requestedSchema": {"type": "object"},
    })
}

/// F3b(c) PR 2: a helper-hosted server's question reaches the answerer with its params, and is answered by it.
#[tokio::test]
async fn a_helper_elicitation_is_answered_by_the_answerer() {
    let (rig, _answers) = helper().await;
    let answer = rig
        .helper
        .helper_request(1, ELICITATION, elicit("e1", "Name?"))
        .await
        .unwrap();
    assert_eq!(answer["action"], json!("accept"));
    assert_eq!(answer["content"], json!({"name": "Ada"}));
    assert_eq!(answer["params"]["toolUseId"], json!("toolu_1"));
    assert!(rig.helper.requests.lock().unwrap().live.is_empty());
}

/// F3b(c) PR 2: the helper's abandon of a question (its call ended) fires the question's cancel, and the answerer
/// answers `cancel`.
#[tokio::test]
async fn a_helper_abandon_withdraws_a_running_elicitation() {
    let (rig, _answers) = helper().await;
    let running = {
        let helper = rig.helper.clone();
        tokio::spawn(async move {
            helper
                .helper_request(1, ELICITATION, elicit("e2", "wait"))
                .await
        })
    };
    while rig.helper.requests.lock().unwrap().live.is_empty() {
        tokio::task::yield_now().await;
    }
    rig.helper.cancel_request(&json!({"requestKey": "e2"}));
    assert_eq!(running.await.unwrap().unwrap(), json!({"action": "cancel"}));
}

/// F3b(c) PR 2: a question without the request key is refused, as the other helper requests are.
#[tokio::test]
async fn a_helper_elicitation_without_a_key_is_refused() {
    let (rig, _answers) = helper().await;
    let mut params = elicit("unused", "Name?");
    params.as_object_mut().unwrap().remove("requestKey");
    let error = rig
        .helper
        .helper_request(1, ELICITATION, params)
        .await
        .unwrap_err();
    assert_eq!(error.message, "requestKey is required");
}
