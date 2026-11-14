//! Fork: `config.externalAgentConfig` from events and the cold-open seed (specs/fork-rust-agent-parity.md "ACP
//! external agents", rule 13).
use rust_cli_kernel_api::external_agent_config::{
    ExternalAgentConfigOption, ExternalAgentConfigValue,
};
use rust_cli_kernel_api::session_api::KernelEvent;
use serde_json::{Value, json};

use super::Feed;

fn model(current: &str) -> Vec<ExternalAgentConfigOption> {
    vec![ExternalAgentConfigOption {
        id: "model".into(),
        name: "Model".into(),
        description: None,
        category: Some("model".into()),
        current_value: current.into(),
        options: ["m1", "m2"]
            .iter()
            .map(|value| ExternalAgentConfigValue {
                value: (*value).into(),
                name: value.to_uppercase(),
                description: None,
                group: None,
            })
            .collect(),
    }]
}

fn event(current: &str) -> KernelEvent {
    KernelEvent::ExternalAgentConfig {
        agent: "mock".into(),
        options: model(current),
    }
}

/// The `config` patches among the deltas.
fn config_patches(deltas: &[Value]) -> Vec<Value> {
    deltas
        .iter()
        .filter(|delta| delta["op"] == "state.updated")
        .filter_map(|delta| delta["patch"].get("config").cloned())
        .collect()
}

fn shown(feed: &Feed) -> Value {
    feed.projection.snapshot(feed.seq, "epoch")["config"]["externalAgentConfig"].clone()
}

/// The event sets `{agentId, options}` in the canonical shape; the same state again patches nothing.
#[test]
fn an_event_sets_the_agent_selects_once() {
    let mut feed = Feed::new();
    assert_eq!(shown(&feed), Value::Null, "absent until a seed or an event");
    let patches = config_patches(&feed.apply(event("m1")));
    assert_eq!(patches.len(), 1);
    assert_eq!(
        patches[0]["externalAgentConfig"],
        json!({"agentId": "mock", "options": [{"id": "model", "name": "Model", "description": null,
            "category": "model", "currentValue": "m1", "options": [
                {"value": "m1", "name": "M1", "description": null, "group": null},
                {"value": "m2", "name": "M2", "description": null, "group": null}]}]})
    );
    assert!(config_patches(&feed.apply(event("m1"))).is_empty());
    let changed = config_patches(&feed.apply(event("m2")));
    assert_eq!(
        changed[0]["externalAgentConfig"]["options"][0]["currentValue"],
        "m2"
    );
}

/// The seed shows the stored copy without a delta; an event wins over it, and a later seed never overrides an event.
#[test]
fn the_seed_never_overrides_an_event() {
    let mut feed = Feed::new();
    feed.projection
        .seed_external_agent_config("mock", &model("m2"));
    assert_eq!(shown(&feed)["options"][0]["currentValue"], "m2");
    // An event equal to the seed is no change.
    assert!(config_patches(&feed.apply(event("m2"))).is_empty());
    feed.apply(event("m1"));
    feed.projection
        .seed_external_agent_config("mock", &model("m2"));
    assert_eq!(shown(&feed)["options"][0]["currentValue"], "m1");
}

/// A rebuilt history (rewind, edit, retry) keeps the selects: they are session state, not history.
#[test]
fn a_rebuild_keeps_the_selects() {
    let mut feed = Feed::new();
    feed.apply(event("m2"));
    let rebuilt = feed.projection.rebuilt(&super::view(Vec::new()));
    assert_eq!(
        rebuilt.snapshot(1, "epoch")["config"]["externalAgentConfig"]["options"][0]["currentValue"],
        "m2"
    );
}
