use rust_cli_kernel_api::provider::{CatalogModel, WireProtocol};

use super::effort_of;

fn model(default: Option<&str>) -> CatalogModel {
    CatalogModel {
        provider: "acme".to_owned(),
        provider_name: "Acme".to_owned(),
        model: "acme-1".to_owned(),
        protocol: WireProtocol::AnthropicMessages,
        reasoning_levels: vec!["low".to_owned(), "medium".to_owned(), "high".to_owned()],
        default_reasoning_level: default.map(str::to_owned),
        context_window: 1,
        max_output_tokens: 1,
        capabilities: Default::default(),
        connection: None,
        host: None,
    }
}

/// 9.67 (closes 925): the picker shows the level the user set when the model has it, else the model's default level
/// (the configured one, or the last).
#[test]
fn the_picker_falls_back_to_the_configured_default_level_before_the_last() {
    assert_eq!(effort_of(&model(Some("medium")), "none"), "medium");
    assert_eq!(effort_of(&model(None), "none"), "high");
    assert_eq!(effort_of(&model(Some("medium")), "low"), "low");
}
