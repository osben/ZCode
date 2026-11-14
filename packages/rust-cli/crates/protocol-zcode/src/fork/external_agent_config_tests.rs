use std::collections::BTreeMap;

use rust_cli_kernel_api::external_agent_config::{
    ExternalAgentConfigOption, ExternalAgentConfigValue,
};

use super::overlay;

fn option(id: &str, current: &str, values: &[&str]) -> ExternalAgentConfigOption {
    ExternalAgentConfigOption {
        id: id.into(),
        name: id.into(),
        description: None,
        category: None,
        current_value: current.into(),
        options: values
            .iter()
            .map(|value| ExternalAgentConfigValue {
                value: (*value).into(),
                name: (*value).into(),
                description: None,
                group: None,
            })
            .collect(),
    }
}

/// Node's overlay: a chosen value the option offers becomes its current value; a value it does not offer, and an
/// option without a choice, stay as offered.
#[test]
fn the_overlay_shows_the_offered_choices_only() {
    let offered = vec![
        option("model", "m1", &["m1", "m2"]),
        option("mode", "agent", &["agent", "plan"]),
        option("effort", "low", &["low"]),
    ];
    let chosen = BTreeMap::from([
        ("model".to_owned(), "m2".to_owned()),
        ("mode".to_owned(), "gone".to_owned()),
    ]);
    let shown = overlay(offered, &chosen);
    let current: Vec<&str> = shown
        .iter()
        .map(|option| option.current_value.as_str())
        .collect();
    assert_eq!(current, ["m2", "agent", "low"]);
}
