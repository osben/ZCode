#![allow(
    clippy::disallowed_methods,
    reason = "tests write and read the catalog file directly"
)]

use rust_cli_kernel_api::external_agent_config::{
    ExternalAgentConfigOption, ExternalAgentConfigValue,
};

use super::{AgentCatalog, CATALOG_FILE};

fn option(current: &str) -> ExternalAgentConfigOption {
    ExternalAgentConfigOption {
        id: "model".into(),
        name: "Model".into(),
        description: None,
        category: Some("model".into()),
        current_value: current.into(),
        options: vec![ExternalAgentConfigValue {
            value: "m1".into(),
            name: "Model 1".into(),
            description: Some("fast".into()),
            group: None,
        }],
    }
}

fn catalog(dir: &tempfile::TempDir) -> AgentCatalog {
    AgentCatalog::beside(&dir.path().join("fork_acp_agents.json"))
}

/// What Node's `JSON.stringify(encodeForkAcpAgentCatalogFile(agents), null, 2)` writes for one agent.
const NODE_FILE: &str = r#"{
  "schemaVersion": 1,
  "agents": [
    {
      "agentId": "mock",
      "capturedAt": 1700000000000,
      "options": [
        {
          "id": "model",
          "name": "Model",
          "description": null,
          "category": "model",
          "currentValue": "m1",
          "options": [
            {
              "value": "m1",
              "name": "Model 1",
              "description": "fast",
              "group": null
            }
          ]
        }
      ]
    }
  ]
}"#;

#[tokio::test]
async fn a_write_is_byte_identical_to_node() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = catalog(&dir);
    assert!(
        catalog
            .write("mock", &[option("m1")], 1_700_000_000_000)
            .await
            .unwrap()
    );
    let written = std::fs::read_to_string(dir.path().join(CATALOG_FILE)).unwrap();
    assert_eq!(written, NODE_FILE);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.path().join(CATALOG_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

/// Node's file reads back; an agent never run has no entry.
#[tokio::test]
async fn a_node_file_reads_per_agent() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(CATALOG_FILE), NODE_FILE).unwrap();
    let catalog = catalog(&dir);
    assert_eq!(catalog.read_agent("mock").await, Some(vec![option("m1")]));
    assert_eq!(catalog.read_agent("other").await, None);
}

/// Equal options are no write (`capturedAt` is not compared); a changed agent is replaced and moves last.
#[tokio::test]
async fn equal_options_skip_and_a_change_replaces_the_entry() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = catalog(&dir);
    assert!(catalog.write("mock", &[option("m1")], 1).await.unwrap());
    assert!(catalog.write("other", &[option("m1")], 2).await.unwrap());
    let before = std::fs::read_to_string(dir.path().join(CATALOG_FILE)).unwrap();
    assert!(!catalog.write("mock", &[option("m1")], 3).await.unwrap());
    assert_eq!(
        std::fs::read_to_string(dir.path().join(CATALOG_FILE)).unwrap(),
        before
    );
    assert!(catalog.write("mock", &[option("m2")], 4).await.unwrap());
    let file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join(CATALOG_FILE)).unwrap())
            .unwrap();
    let agents: Vec<&str> = file["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|agent| agent["agentId"].as_str().unwrap())
        .collect();
    assert_eq!(agents, ["other", "mock"]);
    assert_eq!(file["agents"][1]["capturedAt"], 4);
    assert_eq!(catalog.read_agent("mock").await, Some(vec![option("m2")]));
}

/// Reads are tolerant: a file that is not a version 1 catalog reads as empty and the next write replaces it; an
/// invalid entry and a later duplicate are dropped.
#[tokio::test]
async fn reads_are_tolerant() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(CATALOG_FILE);
    let catalog = catalog(&dir);
    std::fs::write(&file, "{not json").unwrap();
    assert_eq!(catalog.read_agent("mock").await, None);
    std::fs::write(&file, r#"{"schemaVersion": 2, "agents": []}"#).unwrap();
    assert_eq!(catalog.read_agent("mock").await, None);
    assert!(catalog.write("mock", &[option("m1")], 1).await.unwrap());
    assert_eq!(catalog.read_agent("mock").await, Some(vec![option("m1")]));

    let entry = |agent: &str, current: &str| serde_json::json!({"agentId": agent, "capturedAt": 1, "options": [option(current)]});
    let mixed = serde_json::json!({"schemaVersion": 1, "agents": [
        {"agentId": "has space", "capturedAt": 1, "options": []},
        {"agentId": "bad", "capturedAt": -1, "options": []},
        {"agentId": "noid", "capturedAt": 1, "options": [{"id": "", "name": "x", "description": null,
            "category": null, "currentValue": "a", "options": []}]},
        entry("mock", "first"),
        entry("mock", "second"),
    ]});
    std::fs::write(&file, mixed.to_string()).unwrap();
    assert_eq!(catalog.read_agent("has space").await, None);
    assert_eq!(catalog.read_agent("bad").await, None);
    assert_eq!(catalog.read_agent("noid").await, None);
    assert_eq!(
        catalog.read_agent("mock").await,
        Some(vec![option("first")])
    );
}
