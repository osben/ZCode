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

async fn started() -> Rig {
    let rig = rig(fake(&["plugins/list"], echo()), timing());
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
