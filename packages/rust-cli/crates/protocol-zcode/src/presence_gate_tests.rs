use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::testing::MemoryStore;
use rust_cli_protocol_core::rpc::codes;
use serde_json::json;

use super::*;

#[test]
fn session_ids_are_collected_like_node() {
    let ids = |params: Value| -> Vec<String> {
        let mut ids: Vec<String> = session_ids(&params)
            .into_iter()
            .map(|id| id.as_str().to_owned())
            .collect();
        ids.sort();
        ids
    };
    assert_eq!(ids(json!({"sessionId": "s1"})), ["s1"]);
    assert_eq!(ids(json!({"topic": "conversation/s2"})), ["s2"]);
    assert_eq!(
        ids(json!({"commands": [{"sessionId": "s3"}, {"sessionId": ""}, {"other": 1}, 7]})),
        ["s3"]
    );
    assert_eq!(
        ids(
            json!({"sessionId": "s1", "topic": "conversation/s1", "commands": [{"sessionId": "s1"}]})
        ),
        ["s1"]
    );
    assert!(ids(json!({"sessionId": "", "topic": "conversation/"})).is_empty());
    assert!(ids(json!({"topic": "sessions-index"})).is_empty());
    assert!(ids(json!(null)).is_empty());
    assert!(ids(json!({"sessionId": 5})).is_empty());
}

#[tokio::test]
async fn a_purged_session_is_refused_with_node_error() {
    let store = MemoryStore::default();
    store.start_purge(&SessionId::new("s1"));
    let refused = check(
        &store,
        "v4/command",
        &json!({"commands": [{"sessionId": "s1"}]}),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, codes::INTERNAL_ERROR);
    assert_eq!(refused.code, -32603);
    assert_eq!(refused.message, "session-data.deleting");
    assert!(
        check(
            &store,
            "v4/conversation/subscribe",
            &json!({"topic": "conversation/s1"})
        )
        .await
        .is_err()
    );
    assert_eq!(
        check(
            &store,
            "v4/conversation/rowsRange",
            &json!({"sessionId": "s2"})
        )
        .await,
        Ok(())
    );
    for method in [
        "v4/storage/sessionData/deletionPreview",
        "v4/storage/sessionData/deletionExecute",
    ] {
        assert_eq!(
            check(&store, method, &json!({"sessionId": "s1"})).await,
            Ok(())
        );
    }
}
