#![allow(
    clippy::disallowed_methods,
    reason = "the test writes the Host's sidecar file the way the Host would, outside rust-cli-fs"
)]

use serde_json::{Value, json};

use super::AgentRecords;

fn agent(id: &str) -> Value {
    json!({"agentId": id, "providerName": "Mock", "enabled": true, "command": "mock", "args": []})
}

async fn find_in(file: Value, agent_id: &str) -> bool {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fork_acp_agents.json");
    tokio::fs::write(&path, file.to_string()).await.unwrap();
    AgentRecords { file: path }.find(agent_id).await.is_some()
}

#[tokio::test]
async fn a_valid_file_finds_the_agent() {
    assert!(
        find_in(
            json!({"schemaVersion": 1, "agents": [agent("mock")]}),
            "mock"
        )
        .await
    );
    let mut with_env = agent("mock");
    with_env["env"] = json!({"HOME": "/home/u", "_X1": "y"});
    assert!(find_in(json!({"schemaVersion": 1, "agents": [with_env]}), "mock").await);
}

#[tokio::test]
async fn a_missing_or_unreadable_file_has_no_agents() {
    let dir = tempfile::tempdir().unwrap();
    let missing = AgentRecords {
        file: dir.path().join("absent.json"),
    };
    assert!(missing.find("mock").await.is_none());
    let path = dir.path().join("broken.json");
    tokio::fs::write(&path, "{not json").await.unwrap();
    assert!(AgentRecords { file: path }.find("mock").await.is_none());
}

/// Node `forkAcpAgentsFileSchema` is strict: any invalid part makes the whole file read as empty.
#[tokio::test]
async fn an_invalid_file_is_read_as_empty_like_the_node_schema() {
    let mut unknown_field = agent("mock");
    unknown_field["extra"] = json!(true);
    let mut blank_name = agent("mock");
    blank_name["providerName"] = json!("");
    let mut bad_env_key = agent("mock");
    bad_env_key["env"] = json!({"1BAD": "x"});
    let cases = [
        (
            "schema version 2",
            json!({"schemaVersion": 2, "agents": [agent("mock")]}),
        ),
        (
            "unknown file field",
            json!({"schemaVersion": 1, "agents": [agent("mock")], "x": 1}),
        ),
        (
            "unknown agent field",
            json!({"schemaVersion": 1, "agents": [unknown_field]}),
        ),
        (
            "empty provider name",
            json!({"schemaVersion": 1, "agents": [blank_name]}),
        ),
        (
            "env key pattern",
            json!({"schemaVersion": 1, "agents": [bad_env_key]}),
        ),
        (
            "agent id with a space",
            json!({"schemaVersion": 1, "agents": [agent("mo ck"), agent("mock")]}),
        ),
        (
            "empty agent id",
            json!({"schemaVersion": 1, "agents": [agent(""), agent("mock")]}),
        ),
        (
            "duplicate agent ids",
            json!({"schemaVersion": 1, "agents": [agent("mock"), agent("mock")]}),
        ),
    ];
    for (name, file) in cases {
        assert!(!find_in(file, "mock").await, "{name}");
    }
}
