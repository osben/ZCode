//! Fork: the app-provided tool overlay of the Node helper (specs/fork-rust-node-helper.md F3b(b)).

use super::*;
use rust_cli_kernel_api::app_tool::AppToolHost;
use rust_cli_kernel_api::ids::SessionId;

fn listed(name: &str) -> Value {
    json!({
        "name": name,
        "modelName": name,
        "serverName": "calc",
        "pluginId": "calc",
        "toolName": "pick",
        "inputSchema": {"type": "object"},
        "readOnlyHint": true,
    })
}

/// The agent's answers a helper session open needs: every session lives in one workspace.
struct Agent;

#[async_trait]
impl HelperRequests for Agent {
    async fn authorize_app_tool(
        &self,
        _params: Value,
        _cancel: tokio_util::sync::CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    async fn sample_model(
        &self,
        _params: Value,
        _cancel: tokio_util::sync::CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    fn session_delta(&self, _session: &str, _delta: Value) {}

    async fn session_workspace(&self, _session: &str) -> Option<Value> {
        Some(json!({"workspacePath": "/home/ZCodeProject"}))
    }

    async fn session_execution_directory(&self, _session: &str) -> Option<String> {
        None
    }

    async fn session_root(&self, _session: &str) -> Option<String> {
        None
    }

    async fn session_parent(&self, _session: &str) -> Option<String> {
        None
    }
}

static AGENT: std::sync::LazyLock<Arc<Agent>> = std::sync::LazyLock::new(|| Arc::new(Agent));

/// The rig with the agent's answers installed, so a call can open its helper session.
fn answering(rig: Rig) -> Rig {
    let answers: Weak<dyn HelperRequests> = Arc::downgrade(&*AGENT) as _;
    rig.helper.set_requests(answers);
    // A session open needs the plugin catalog loaded, even an empty one.
    rig.helper.set_catalog(HelperCatalog {
        plugin_ids: Vec::new(),
        helper_plugins: Vec::new(),
        servers: Vec::new(),
    });
    rig
}

async fn started() -> Rig {
    let rig = answering(rig(fake(&["plugins/list"], echo()), timing()));
    forward_ok(&rig.helper, "plugins/list", json!({})).await;
    rig
}

#[tokio::test]
async fn replace_is_answered_with_the_registered_names_and_a_duplicate_keeps_the_first() {
    let rig = started().await;
    let answer = rig
        .helper
        .helper_request(
            1,
            "helper/appTools/replace",
            json!({"sessionId": "s1", "tools": [listed("app__calc__a"), listed("app__calc__a"), listed("app__calc__b")]}),
        )
        .await
        .expect("answered, not method not found");
    assert_eq!(
        answer,
        json!({"registered": ["app__calc__a", "app__calc__b"]})
    );
}

#[tokio::test]
async fn the_overlay_is_listed_for_its_session_only() {
    let rig = started().await;
    rig.helper
        .helper_request(
            1,
            "helper/appTools/replace",
            json!({"sessionId": "s1", "tools": [listed("app__calc__a")]}),
        )
        .await
        .expect("answered");
    let mine = rig.helper.app_tools(&SessionId::new("s1"));
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].model_name, "app__calc__a");
    assert_eq!(mine[0].server_name, "calc");
    assert!(mine[0].read_only);
    assert!(rig.helper.app_tools(&SessionId::new("s2")).is_empty());
}

#[tokio::test]
async fn a_replace_takes_the_whole_set_of_its_session() {
    let rig = started().await;
    for tools in [
        json!([listed("app__calc__a")]),
        json!([listed("app__calc__b")]),
    ] {
        rig.helper
            .helper_request(
                1,
                "helper/appTools/replace",
                json!({"sessionId": "s1", "tools": tools}),
            )
            .await
            .expect("answered");
    }
    let names: Vec<String> = rig
        .helper
        .app_tools(&SessionId::new("s1"))
        .into_iter()
        .map(|tool| tool.model_name)
        .collect();
    assert_eq!(names, vec!["app__calc__b".to_owned()]);
}

#[tokio::test]
async fn a_lost_process_takes_its_app_tools_with_it() {
    let rig = started().await;
    rig.helper
        .helper_request(
            1,
            "helper/appTools/replace",
            json!({"sessionId": "s1", "tools": [listed("app__calc__a")]}),
        )
        .await
        .expect("answered");
    rig.helper.app_tools_lost(1);
    assert!(rig.helper.app_tools(&SessionId::new("s1")).is_empty());
}

/// The params of every message of `method` the fake helper received (requests and notifications).
fn received_of(fake: &Fake, method: &str) -> Vec<Value> {
    fake.received
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| name == method)
        .map(|(_, params)| params.clone())
        .collect()
}

fn notified(fake: &Fake, method: &str) -> usize {
    fake.notified
        .lock()
        .unwrap()
        .iter()
        .filter(|name| name.as_str() == method)
        .count()
}

async fn eventually(mut done: impl FnMut() -> bool) {
    for _ in 0..300 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the condition never held");
}

/// One model call of `app__calc__a` in session `s1`.
async fn call_app(helper: &NodeHelper, tool_call: &str) -> Result<Value, String> {
    AppToolHost::call(
        helper,
        &SessionId::new("s1"),
        "run_1",
        tool_call,
        "app__calc__a",
        json!({}),
    )
    .await
}

async fn replace(rig: &Rig, session: &str, tools: Vec<Value>) {
    rig.helper
        .helper_request(
            1,
            "helper/appTools/replace",
            json!({"sessionId": session, "tools": tools}),
        )
        .await
        .expect("answered");
}

#[tokio::test]
async fn a_call_reaches_the_helper_through_the_node_helper() {
    let rig = started().await;
    replace(&rig, "s1", vec![listed("app__calc__a")]).await;
    let answer = AppToolHost::call(
        rig.helper.as_ref(),
        &SessionId::new("s1"),
        "run_1",
        "tc_1",
        "app__calc__a",
        json!({"x": 1}),
    )
    .await
    .expect("the helper answers the call");
    assert_eq!(answer["toolCallId"], json!("tc_1"));
    assert_eq!(
        received_of(&rig.fake, "helper/appTools/call"),
        vec![json!({
            "sessionId": "s1",
            "turnId": "run_1",
            "toolCallId": "tc_1",
            "name": "app__calc__a",
            "input": {"x": 1},
        })]
    );
}

#[tokio::test]
async fn a_cancel_is_sent_as_a_notification_to_a_running_helper() {
    let rig = started().await;
    AppToolHost::cancel(rig.helper.as_ref(), &SessionId::new("s1"), "tc_1").await;
    eventually(|| notified(&rig.fake, "helper/appTools/cancel") == 1).await;
    assert_eq!(
        received_of(&rig.fake, "helper/appTools/cancel"),
        vec![json!({"sessionId": "s1", "toolCallId": "tc_1"})]
    );
}

#[tokio::test]
async fn a_cancel_opens_no_helper_session() {
    let rig = started().await;
    AppToolHost::cancel(rig.helper.as_ref(), &SessionId::new("s1"), "tc_1").await;
    eventually(|| notified(&rig.fake, "helper/appTools/cancel") == 1).await;
    assert!(received_of(&rig.fake, "helper/session/open").is_empty());
}

#[tokio::test]
async fn a_cancel_with_no_running_helper_starts_none() {
    let rig = rig(fake(&["plugins/list"], echo()), timing());
    AppToolHost::cancel(rig.helper.as_ref(), &SessionId::new("s1"), "tc_1").await;
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_call_after_its_helper_crashed_starts_no_helper() {
    let crash_first_call = behaviour(|index, method, params| {
        if index == 0 && method == "helper/appTools/call" {
            Act::Crash
        } else {
            Act::Reply {
                notes: Vec::new(),
                result: params.clone(),
            }
        }
    });
    let rig = answering(rig(fake(&["plugins/list"], crash_first_call), timing()));
    forward_ok(&rig.helper, "plugins/list", json!({})).await;
    replace(&rig, "s1", vec![listed("app__calc__a")]).await;
    assert!(
        call_app(&rig.helper, "tc_1").await.is_err(),
        "the helper crashed under the call"
    );
    eventually(|| rig.helper.app_tools(&SessionId::new("s1")).is_empty()).await;
    assert!(call_app(&rig.helper, "tc_2").await.is_err());
    assert_eq!(
        rig.fake.launches.load(Ordering::SeqCst),
        1,
        "a call whose helper is gone starts none"
    );
}

#[tokio::test]
async fn a_replace_of_a_process_that_is_gone_keeps_no_set() {
    let rig = started().await;
    rig.helper
        .helper_request(
            99,
            "helper/appTools/replace",
            json!({"sessionId": "s1", "tools": [listed("app__calc__a")]}),
        )
        .await
        .expect("answered");
    assert_eq!(rig.helper.app_tool_sets(), 0);
}

#[tokio::test]
async fn a_malformed_entry_is_left_out_and_the_rest_of_the_set_is_applied() {
    let rig = started().await;
    let malformed = json!({"modelName": "app__calc__bad", "toolName": "pick"});
    let answer = rig
        .helper
        .helper_request(
            1,
            "helper/appTools/replace",
            json!({
                "sessionId": "s1",
                "tools": [listed("app__calc__a"), malformed, listed("app__calc__b")],
            }),
        )
        .await
        .expect("answered");
    assert_eq!(
        answer,
        json!({"registered": ["app__calc__a", "app__calc__b"]})
    );
}

#[tokio::test]
async fn a_call_the_helper_never_answers_is_cancelled_in_the_helper() {
    let hang_the_call = behaviour(|_, method, params| {
        if method == "helper/appTools/call" {
            Act::Hang
        } else {
            Act::Reply {
                notes: Vec::new(),
                result: params.clone(),
            }
        }
    });
    let mut timing = timing();
    timing.default_request = Duration::from_millis(200);
    let rig = answering(rig(fake(&["plugins/list"], hang_the_call), timing));
    forward_ok(&rig.helper, "plugins/list", json!({})).await;
    replace(&rig, "s1", vec![listed("app__calc__a")]).await;
    assert!(call_app(&rig.helper, "tc_1").await.is_err());
    eventually(|| notified(&rig.fake, "helper/appTools/cancel") == 1).await;
    assert_eq!(
        received_of(&rig.fake, "helper/appTools/cancel")[0]["toolCallId"],
        json!("tc_1")
    );
}
