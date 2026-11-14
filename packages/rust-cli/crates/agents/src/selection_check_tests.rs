use super::*;
use rust_cli_kernel_api::provider::CatalogModel;

fn entry(provider: &str, model: &str, levels: &[&str]) -> CatalogModel {
    CatalogModel {
        provider: provider.to_owned(),
        provider_name: provider.to_owned(),
        model: model.to_owned(),
        protocol: rust_cli_kernel_api::provider::WireProtocol::OpenAiChatCompletions,
        reasoning_levels: levels.iter().map(|level| (*level).to_owned()).collect(),
        context_window: 200_000,
        max_output_tokens: 32_000,
        capabilities: Default::default(),
        connection: None,
        host: None,
    }
}

fn catalog() -> ModelCatalog {
    ModelCatalog {
        revision: 1,
        models: vec![entry("custom-openai", "gpt-x", &["low", "high"])],
        default: None,
    }
}

fn selection(provider: &str, model: &str, reasoning: Option<&str>) -> ModelSelection {
    ModelSelection {
        reasoning: reasoning.map(str::to_owned),
        ..ModelSelection::new(provider, model)
    }
}

/// Node `resolveEffectiveModelSelection`: provider, then model, then the reasoning level.
#[test]
fn the_issue_follows_node_order() {
    let catalog = catalog();
    for (wanted, reason) in [
        (
            selection("gone", "gpt-x", Some("low")),
            Some("provider-not-found"),
        ),
        (
            selection("custom-openai", "gpt-y", Some("low")),
            Some("model-not-found"),
        ),
        (
            selection("custom-openai", "gpt-x", None),
            Some("reasoning-level-missing"),
        ),
        (
            selection("custom-openai", "gpt-x", Some("max")),
            Some("reasoning-level-not-supported"),
        ),
        (selection("custom-openai", "gpt-x", Some("high")), None),
    ] {
        assert_eq!(issue(&catalog, &wanted), reason, "{wanted:?}");
    }
}

/// A catalog entry with an account connection still matches a selection without one (the platform picks it).
#[test]
fn the_connection_is_not_matched() {
    let mut catalog = catalog();
    catalog.models[0].connection = Some(rust_cli_kernel_api::provider::CatalogConnection {
        id: rust_cli_kernel_api::model::ModelConnection {
            product_id: "p".to_owned(),
            organization_id: "o".to_owned(),
            project_id: "team-1".to_owned(),
        },
        vendor: "Z.AI".to_owned(),
        name: "Team".to_owned(),
    });
    assert_eq!(
        issue(&catalog, &selection("custom-openai", "gpt-x", Some("low"))),
        None
    );
}

#[test]
fn the_refusal_is_nodes_text() {
    assert_eq!(
        refusal(
            "model-not-found",
            &selection("custom-openai", "gpt-y", Some("low"))
        ),
        "Cannot start subagent: Model unavailable / 模型不存在或不可用 [reason=model-not-found; selection=custom-openai/gpt-y]"
    );
}
