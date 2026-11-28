//! Node's `model-reference.test.ts` and `workflow-script-models.test.ts`, ported (9.63).

use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::provider::{CatalogModel, ModelCatalog, WireProtocol};
use rust_cli_kernel_api::workflow_analysis::ModelReference;
use serde_json::{Map, Value, json};

use super::*;

fn entry(provider: &str, model: &str) -> CatalogEntry {
    CatalogEntry {
        provider: provider.to_owned(),
        model: model.to_owned(),
        provider_label: None,
        reasoning_levels: Vec::new(),
        default_level: None,
        context_window: None,
        current: false,
        disabled_reason: None,
    }
}

fn current(mut entry: CatalogEntry) -> CatalogEntry {
    entry.current = true;
    entry
}

fn disabled(mut entry: CatalogEntry, reason: &str) -> CatalogEntry {
    entry.disabled_reason = Some(reason.to_owned());
    entry
}

fn ok(text: &str, entries: &[CatalogEntry]) -> Resolved {
    resolve(text, entries).unwrap_or_else(|refusal| panic!("expected a resolution: {refusal:?}"))
}

fn refused(text: &str, entries: &[CatalogEntry]) -> Refusal {
    match resolve(text, entries) {
        Ok(resolved) => panic!("expected a failure, got {resolved:?}"),
        Err(refusal) => refusal,
    }
}

#[test]
fn a_qualified_reference_matches_exactly_even_when_the_bare_name_is_elsewhere() {
    let entries = [entry("zhipu", "glm-4.6"), entry("openai", "glm-4.6")];
    let resolved = ok("openai/glm-4.6", &entries);
    assert_eq!(resolved.canonical, "openai/glm-4.6");
    assert_eq!(resolved.selection, ModelSelection::new("openai", "glm-4.6"));
}

#[test]
fn a_bare_name_resolves_under_the_session_provider() {
    let entries = [
        current(entry("zhipu", "glm-4.6")),
        entry("zhipu", "glm-4.6-flash"),
    ];
    assert_eq!(
        ok("glm-4.6-flash", &entries).canonical,
        "zhipu/glm-4.6-flash"
    );
}

#[test]
fn a_bare_name_only_under_another_provider_is_other_provider() {
    let entries = [
        current(entry("team", "glm-5.3")),
        entry("personal", "glm-5.3-flash"),
    ];
    let failed = refused("glm-5.3-flash", &entries);
    assert_eq!(failed.reason, RefusalReason::OtherProvider);
    assert!(
        failed.message.contains("session's provider (team)"),
        "{}",
        failed.message
    );
    assert!(failed.message.contains("personal/glm-5.3-flash"));
    assert!(failed.message.contains("ask the user first"));
    // A qualified reference crosses providers.
    assert_eq!(
        ok("personal/glm-5.3-flash", &entries).canonical,
        "personal/glm-5.3-flash"
    );
}

#[test]
fn a_disabled_entry_under_the_session_provider_does_not_move_a_bare_name() {
    let entries = [
        current(entry("team", "glm-5.3")),
        disabled(entry("team", "glm-5.3-flash"), "no key"),
        entry("personal", "glm-5.3-flash"),
    ];
    assert_eq!(
        refused("glm-5.3-flash", &entries).reason,
        RefusalReason::OtherProvider
    );
}

#[test]
fn without_a_current_entry_a_unique_bare_name_wins_and_several_are_ambiguous() {
    let entries = [entry("zhipu", "glm-4.6"), entry("openai", "gpt-5")];
    assert_eq!(ok("gpt-5", &entries).canonical, "openai/gpt-5");
    let entries = [entry("zhipu", "glm-4.6"), entry("openrouter", "glm-4.6")];
    let failed = refused("glm-4.6", &entries);
    assert_eq!(failed.reason, RefusalReason::Ambiguous);
    assert_eq!(
        failed.message,
        "`glm-4.6` is configured under more than one provider:\nzhipu/glm-4.6\nopenrouter/glm-4.6\n\nPass the full `providerId/modelId` of the one you want."
    );
}

#[test]
fn the_session_entry_wins_a_bare_name_under_several_providers() {
    let entries = [
        entry("zhipu", "glm-4.6"),
        current(entry("bigmodel", "glm-4.6")),
        entry("openrouter", "glm-4.6"),
    ];
    assert_eq!(ok("glm-4.6", &entries).canonical, "bigmodel/glm-4.6");
}

#[test]
fn matching_ignores_case_and_the_canonical_form_keeps_the_registry_spelling() {
    let entries = [entry("BigModel", "GLM-4.6")];
    assert_eq!(
        ok("bigmodel/glm-4.6", &entries).canonical,
        "BigModel/GLM-4.6"
    );
    assert_eq!(ok("GLM-4.6", &entries).canonical, "BigModel/GLM-4.6");
    assert_eq!(ok("  glm-4.6  ", &entries).canonical, "BigModel/GLM-4.6");
}

#[test]
fn only_disabled_matches_are_refused_with_their_reasons() {
    let entries = [disabled(entry("zhipu", "glm-4.6"), "no API key configured")];
    let failed = refused("glm-4.6", &entries);
    assert_eq!(failed.reason, RefusalReason::Disabled);
    assert_eq!(
        failed.message,
        "`glm-4.6` matches a model that cannot be used on this host:\nzhipu/glm-4.6 — no API key configured\n\nResolve that with the user, or call ListModels and pick another id."
    );
    let entries = [
        disabled(entry("zhipu", "glm-4.6"), "disabled by policy"),
        entry("bigmodel", "glm-4.6"),
    ];
    assert_eq!(ok("glm-4.6", &entries).canonical, "bigmodel/glm-4.6");
}

#[test]
fn not_found_lists_the_usable_ids_and_marks_the_current_one() {
    let entries = [
        current(entry("zhipu", "glm-4.6")),
        entry("openai", "gpt-5"),
        disabled(entry("x", "y"), "off"),
    ];
    let failed = refused("gemini-3", &entries);
    assert_eq!(failed.reason, RefusalReason::NotFound);
    assert_eq!(
        failed.message,
        "No configured model matches `gemini-3`. Available models:\nzhipu/glm-4.6 [current]\nopenai/gpt-5\n\nPass one of these ids, or call ListModels."
    );
    assert_eq!(
        refused("gpt-5", &[]).message,
        "No configured model matches `gpt-5`. No models are configured on this host.\n\nPass one of these ids, or call ListModels."
    );
}

#[test]
fn not_found_caps_the_list_at_forty_lines() {
    let entries: Vec<CatalogEntry> = (0..60)
        .map(|index| entry("p", &format!("m-{index}")))
        .collect();
    let failed = refused("nope", &entries);
    let listed = failed
        .message
        .lines()
        .filter(|line| line.starts_with("p/m-"))
        .count();
    assert_eq!(listed, 40);
    assert!(failed.message.contains("… and 20 more."));
}

fn leveled() -> CatalogEntry {
    let mut entry = entry("bigmodel", "glm-4.6");
    entry.reasoning_levels = vec!["low".into(), "medium".into(), "high".into()];
    entry.default_level = Some("high".into());
    entry
}

#[test]
fn a_level_suffix_is_kept_in_the_registry_spelling() {
    let resolved = ok("bigmodel/glm-4.6$LOW", &[leveled()]);
    assert_eq!(resolved.canonical, "bigmodel/glm-4.6$low");
    assert_eq!(resolved.selection.reasoning.as_deref(), Some("low"));
    assert_eq!(
        ok("glm-4.6$medium", &[leveled()]).canonical,
        "bigmodel/glm-4.6$medium"
    );
    // No suffix: the registry default.
    assert_eq!(
        ok("glm-4.6", &[leveled()]).canonical,
        "bigmodel/glm-4.6$high"
    );
}

#[test]
fn an_unknown_level_names_the_model_levels_and_the_default() {
    let failed = refused("glm-4.6$ultra", &[leveled()]);
    assert_eq!(failed.reason, RefusalReason::ReasoningLevelUnknown);
    assert_eq!(
        failed.message,
        "`ultra` is not a reasoning level of bigmodel/glm-4.6. Its levels are: low, medium, high. Omit the suffix to use high."
    );
    let failed = refused("gpt-5$high", &[entry("openai", "gpt-5")]);
    assert_eq!(
        failed.message,
        "`high` is not a reasoning level of openai/gpt-5. openai/gpt-5 has no reasoning levels — drop the `$` suffix."
    );
}

#[test]
fn a_model_without_levels_or_without_a_default_carries_no_level() {
    let resolved = ok("gpt-5", &[entry("openai", "gpt-5")]);
    assert_eq!(resolved.canonical, "openai/gpt-5");
    assert_eq!(resolved.selection.reasoning, None);
    let mut no_default = entry("openai", "o5");
    no_default.reasoning_levels = vec!["low".into(), "high".into()];
    assert_eq!(ok("o5", &[no_default]).selection.reasoning, None);
}

#[test]
fn the_subagent_model_sentence_appears_only_with_a_model() {
    assert_eq!(describe_subagent_model(None), "");
    assert_eq!(
        describe_subagent_model(Some("bigmodel/glm-4.6$high")),
        " Subagents run on bigmodel/glm-4.6$high (the main agent stays on the session model)."
    );
}

fn model(provider: &str, model: &str, levels: &[&str]) -> CatalogModel {
    CatalogModel {
        provider: provider.to_owned(),
        provider_name: String::new(),
        model: model.to_owned(),
        protocol: WireProtocol::AnthropicMessages,
        reasoning_levels: levels.iter().map(|level| (*level).to_owned()).collect(),
        default_reasoning_level: None,
        context_window: 1,
        max_output_tokens: 1,
        capabilities: Default::default(),
        connection: None,
        host: None,
    }
}

#[test]
fn the_catalog_entries_mark_the_session_model_and_default_to_the_last_level() {
    let catalog = ModelCatalog {
        revision: 1,
        models: vec![
            model("deepseek", "deepseek-v4-flash", &[]),
            model("deepseek", "deepseek-v4-pro", &["low", "high"]),
        ],
        default: None,
    };
    let entries = catalog_entries(
        &catalog,
        Some(&ModelSelection::new("deepseek", "deepseek-v4-flash")),
    );
    assert!(entries[0].current);
    assert!(!entries[1].current);
    assert_eq!(entries[1].default_level.as_deref(), Some("high"));
    assert_eq!(entries[0].default_level, None);
    assert_eq!(
        ok("deepseek-v4-pro", &entries).canonical,
        "deepseek/deepseek-v4-pro$high"
    );
}

/// 9.65 (closes 917): Node `reasoning.default ?? reasoning.values.at(-1)`: the configured default wins over the last
/// level, so a bare name runs on it.
#[test]
fn the_configured_default_level_wins_over_the_last_level() {
    let mut configured = model("deepseek", "deepseek-v4-pro", &["low", "medium", "high"]);
    configured.default_reasoning_level = Some("medium".to_owned());
    let catalog = ModelCatalog {
        revision: 1,
        models: vec![configured],
        default: None,
    };
    let entries = catalog_entries(&catalog, None);
    assert_eq!(entries[0].default_level.as_deref(), Some("medium"));
    assert_eq!(
        ok("deepseek-v4-pro", &entries).canonical,
        "deepseek/deepseek-v4-pro$medium"
    );
}

fn reference(name: &str, line: i64) -> ModelReference {
    ModelReference {
        name: name.to_owned(),
        line,
        column: 3,
    }
}

#[test]
fn the_script_models_bind_by_name_and_the_unbound_ones_are_9011_once_each() {
    let entries = [
        current(entry("deepseek", "deepseek-v4-pro")),
        entry("deepseek", "deepseek-v4-flash"),
    ];
    let references = [
        reference("deepseek-v4-flash", 1),
        reference("gone", 2),
        reference("gone", 5),
    ];
    let bindings = script_bindings(&references, Some(&entries), None);
    assert_eq!(
        Value::Object(bindings.clone()),
        json!({"deepseek-v4-flash": "deepseek/deepseek-v4-flash"})
    );
    assert!(!all_bound(&references, &bindings));
    let diagnostics = unbound_diagnostics(&references, &bindings, Some(&entries), None);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, 9011);
    assert_eq!(diagnostics[0].line, 2);
    assert!(
        diagnostics[0]
            .message
            .starts_with("The model \"gone\" named in the script cannot be used: No configured model matches `gone`."),
        "{}",
        diagnostics[0].message
    );
    assert_eq!(
        describe_script_bindings(&bindings),
        " Models named in the script: \"deepseek-v4-flash\" = deepseek/deepseek-v4-flash."
    );
}

#[test]
fn without_a_catalog_no_script_model_binds() {
    let references = [reference("deepseek-v4-flash", 1)];
    let bindings = script_bindings(&references, None, None);
    assert!(bindings.is_empty());
    let diagnostics = unbound_diagnostics(&references, &bindings, None, None);
    assert_eq!(diagnostics[0].message, SCRIPT_MODELS_UNAVAILABLE);
}

#[test]
fn an_inherited_binding_resolves_the_model_the_predecessor_bound() {
    let entries = [entry("a", "m1"), entry("b", "m1")];
    let mut inherited = Map::new();
    inherited.insert("fast".into(), json!("b/m1"));
    let references = [reference("fast", 1)];
    let bindings = script_bindings(&references, Some(&entries), Some(&inherited));
    assert_eq!(Value::Object(bindings), json!({"fast": "b/m1"}));
    inherited.insert("fast".into(), json!("c/m1"));
    let diagnostics =
        unbound_diagnostics(&references, &Map::new(), Some(&entries), Some(&inherited));
    assert!(
        diagnostics[0]
            .message
            .starts_with("\"fast\" keeps the model the amended run bound it to, c/m1, which cannot be used now. No configured model matches `c/m1`."),
        "{}",
        diagnostics[0].message
    );
}
