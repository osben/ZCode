//! Fork (specs/fork-rust-workflow-engine.md 9.63): the model a workflow names, resolved against the host's catalog (Node
//! `core/src/tool/handlers/model-reference.ts`, `workflow-script-models.ts`, and the catalog port of
//! `bootstrap/src/app/model-catalog-port.ts`).
//!
//! `subagent_model` and the models a script's personas name resolve by specificity: a qualified `provider/model` matches
//! exactly; a bare model name resolves under the session's provider; a bare name found only under another provider is
//! refused, so a bare name never moves the subagents to another provider. Without a session entry, a unique bare name
//! wins and several are ambiguous. Comparison ignores case and surrounding space; the canonical form is
//! `provider/model[$level]` in the registry's spelling. The failure texts are Node's: they enter the model's context.

use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::provider::{ModelCatalog, ModelDirectory};
use rust_cli_kernel_api::workflow_analysis::{ModelReference, WorkflowDiagnostic};
use serde_json::{Map, Value};

/// Node `MODEL_UNRESOLVED_CODE`: a model a script names that the host cannot resolve.
pub const MODEL_UNRESOLVED_CODE: i64 = 9011;
/// Node `SUBAGENT_MODEL_UNAVAILABLE`: the host has no catalog.
pub const SUBAGENT_MODEL_UNAVAILABLE: &str =
    "This host cannot choose a subagent model; omit subagent_model.";
/// Node `SCRIPT_MODELS_UNAVAILABLE`.
pub const SCRIPT_MODELS_UNAVAILABLE: &str = "This host cannot choose models; remove `model` from the personas (the subagents then run on the run's subagent model).";
/// Node `MODEL_REFERENCE_CANDIDATE_LINES`.
const CANDIDATE_LINES: usize = 40;

/// One model of the catalog as the resolver reads it (Node `ModelCatalogEntry`).
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogEntry {
    pub provider: String,
    pub model: String,
    /// The provider's display name; `None` when unset (the provider id is shown).
    pub provider_label: Option<String>,
    pub reasoning_levels: Vec<String>,
    pub default_level: Option<String>,
    /// The model's context window, for the ListModels card.
    pub context_window: Option<u64>,
    /// The session's own model (provider and model; the level is not part of the identity).
    pub current: bool,
    /// Never set by this host, as Node's port never sets it.
    pub disabled_reason: Option<String>,
}

/// A resolved reference: the canonical string and the selection it names.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub canonical: String,
    pub selection: ModelSelection,
}

/// Node's failure reasons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalReason {
    NotFound,
    Ambiguous,
    OtherProvider,
    Disabled,
    ReasoningLevelUnknown,
}

/// A reference that does not resolve, with the model-facing text.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub reason: RefusalReason,
    pub message: String,
}

/// Node `createModelCatalogPort`'s entries: the catalog's models, the session's marked `current`. The default level is
/// the model's configured default when its rule sets one, else the last level (Node `reasoning.default ??
/// values.at(-1)`; 9.65, closes 917).
pub fn catalog_entries(
    catalog: &ModelCatalog,
    session: Option<&ModelSelection>,
) -> Vec<CatalogEntry> {
    catalog
        .models
        .iter()
        .map(|model| {
            let label = model.provider_name.trim();
            CatalogEntry {
                provider: model.provider.clone(),
                model: model.model.clone(),
                provider_label: (!label.is_empty()).then(|| label.to_owned()),
                reasoning_levels: model.reasoning_levels.clone(),
                // Node `reasoning.default ?? reasoning.values.at(-1)` (9.65, closes 917).
                default_level: model.default_level(),
                context_window: Some(model.context_window),
                current: session.is_some_and(|session| {
                    session.provider == model.provider && session.model == model.model
                }),
                disabled_reason: None,
            }
        })
        .collect()
}

/// The catalog the tools resolve against, read now (Node reads the registry on every `listModels`). `None` without a
/// directory: the host cannot choose models.
pub async fn read_entries(
    directory: Option<&dyn ModelDirectory>,
    session: Option<&ModelSelection>,
) -> Option<Vec<CatalogEntry>> {
    let directory = directory?;
    Some(catalog_entries(&directory.catalog().await, session))
}

/// Node `resolveModelReference`.
pub fn resolve(text: &str, entries: &[CatalogEntry]) -> Result<Resolved, Refusal> {
    let (reference, level) = split_level(text.trim());
    let qualified = reference.find('/').is_some_and(|index| index > 0);
    let matches: Vec<&CatalogEntry> = match reference.split_once('/') {
        Some((provider, model)) if qualified => entries
            .iter()
            .filter(|entry| same(&entry.provider, provider) && same(&entry.model, model))
            .collect(),
        _ => entries
            .iter()
            .filter(|entry| same(&entry.model, reference))
            .collect(),
    };
    if matches.is_empty() {
        return Err(not_found(text, entries));
    }
    let enabled: Vec<&CatalogEntry> = matches
        .iter()
        .copied()
        .filter(|entry| entry.disabled_reason.is_none())
        .collect();
    if enabled.is_empty() {
        return Err(disabled(text, &matches));
    }
    let session = entries.iter().find(|entry| entry.current);
    let guarded = session.filter(|_| !qualified);
    let home: Vec<&CatalogEntry> = match guarded {
        Some(session) => enabled
            .iter()
            .copied()
            .filter(|entry| same(&entry.provider, &session.provider))
            .collect(),
        None => enabled.clone(),
    };
    if let Some(session) = guarded
        && home.is_empty()
    {
        return Err(other_provider(text, session, &enabled));
    }
    let entry = if home.len() == 1 {
        Some(home[0])
    } else {
        home.iter().copied().find(|entry| entry.current)
    };
    let Some(entry) = entry else {
        return Err(ambiguous(text, &home));
    };
    let reasoning = match level {
        Some(level) => match entry
            .reasoning_levels
            .iter()
            .find(|candidate| same(candidate, level))
        {
            Some(matched) => Some(matched.clone()),
            None => return Err(level_unknown(entry, level)),
        },
        None if entry.reasoning_levels.is_empty() => None,
        None => entry.default_level.clone(),
    };
    let mut selection = ModelSelection::new(&entry.provider, &entry.model);
    selection.reasoning = reasoning;
    Ok(Resolved {
        canonical: canonical(&selection),
        selection,
    })
}

/// Node `formatModelPickerValue`: `provider/model`, with `$level` when there is one.
pub fn canonical(selection: &ModelSelection) -> String {
    match &selection.reasoning {
        Some(level) => format!("{}/{}${level}", selection.provider, selection.model),
        None => format!("{}/{}", selection.provider, selection.model),
    }
}

/// Node `describeWorkflowSubagentModel`.
pub fn describe_subagent_model(canonical: Option<&str>) -> String {
    canonical.map_or_else(String::new, |canonical| {
        format!(" Subagents run on {canonical} (the main agent stays on the session model).")
    })
}

/// Node `resolveName` of the script models: a name the predecessor bound resolves its canonical string again.
fn resolve_name(
    name: &str,
    entries: Option<&[CatalogEntry]>,
    inherited: Option<&Map<String, Value>>,
) -> Result<String, String> {
    let Some(entries) = entries else {
        return Err(SCRIPT_MODELS_UNAVAILABLE.to_owned());
    };
    if let Some(previous) = inherited
        .and_then(|table| table.get(name))
        .and_then(Value::as_str)
    {
        return resolve(previous, entries)
            .map(|resolved| resolved.canonical)
            .map_err(|refusal| {
                format!(
                    "\"{name}\" keeps the model the amended run bound it to, {previous}, which cannot be used now. {}",
                    refusal.message
                )
            });
    }
    resolve(name, entries)
        .map(|resolved| resolved.canonical)
        .map_err(|refusal| {
            format!(
                "The model \"{name}\" named in the script cannot be used: {}",
                refusal.message
            )
        })
}

/// Node `resolveScriptModelBindings` over `distinctModelNames`: the names that resolve, in first-occurrence order.
pub fn script_bindings(
    references: &[ModelReference],
    entries: Option<&[CatalogEntry]>,
    inherited: Option<&Map<String, Value>>,
) -> Map<String, Value> {
    let mut bindings = Map::new();
    for reference in references {
        if bindings.contains_key(&reference.name) {
            continue;
        }
        if let Ok(canonical) = resolve_name(&reference.name, entries, inherited) {
            bindings.insert(reference.name.clone(), Value::String(canonical));
        }
    }
    bindings
}

/// Node `allScriptModelsBound`.
pub fn all_bound(references: &[ModelReference], bindings: &Map<String, Value>) -> bool {
    references
        .iter()
        .all(|reference| bindings.get(&reference.name).is_some_and(Value::is_string))
}

/// Node `unresolvedScriptModelDiagnostics`: one 9011 per unbound name, at its first occurrence.
pub fn unbound_diagnostics(
    references: &[ModelReference],
    bindings: &Map<String, Value>,
    entries: Option<&[CatalogEntry]>,
    inherited: Option<&Map<String, Value>>,
) -> Vec<WorkflowDiagnostic> {
    let mut reported: Vec<&str> = Vec::new();
    let mut diagnostics = Vec::new();
    for reference in references {
        if bindings.get(&reference.name).is_some_and(Value::is_string)
            || reported.contains(&reference.name.as_str())
        {
            continue;
        }
        reported.push(&reference.name);
        let message = match resolve_name(&reference.name, entries, inherited) {
            Ok(_) => format!(
                "The model \"{}\" became available only after this call was checked; submit the script again.",
                reference.name
            ),
            Err(message) => message,
        };
        diagnostics.push(WorkflowDiagnostic {
            code: MODEL_UNRESOLVED_CODE,
            line: reference.line,
            column: reference.column,
            message,
        });
    }
    diagnostics
}

/// Node `describeScriptModelBindings`.
pub fn describe_script_bindings(bindings: &Map<String, Value>) -> String {
    let pairs: Vec<String> = bindings
        .iter()
        .filter_map(|(name, canonical)| {
            canonical
                .as_str()
                .map(|canonical| format!("\"{name}\" = {canonical}"))
        })
        .collect();
    if pairs.is_empty() {
        return String::new();
    }
    format!(" Models named in the script: {}.", pairs.join("; "))
}

/// The catalog through the late slot, with the calling session's model marked (Node `context.modelCatalogPort`).
pub async fn session_entries(
    models: &rust_cli_kernel_api::provider::LateModelDirectory,
    context: &rust_cli_kernel_api::tool::ToolUseContext,
) -> Option<Vec<CatalogEntry>> {
    let directory = models.get()?;
    let session = context
        .session_ops
        .view()
        .await
        .and_then(|view| view.selection);
    read_entries(Some(directory.as_ref()), session.as_ref()).await
}

/// A three-state model choice that failed (Node `resolveAmendSubagentModelChoice`'s failure).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChoiceFailure {
    /// The failing name was the predecessor's, not the caller's.
    pub inherited: bool,
    pub text: String,
    pub message: String,
}

/// Node `resolveAmendSubagentModelChoice`, shared by AmendWorkflow and the GUI settings (Node shares it too). `requested`
/// is the call's field: `Some(Null)` clears the model, a string is resolved, absent keeps `inherited` (re-resolved). With
/// no catalog, an inherited model passes as it is and a requested one is refused. `Ok(None)` is the session model.
pub fn choose(
    requested: Option<&Value>,
    inherited: Option<&str>,
    entries: Option<&[CatalogEntry]>,
) -> Result<Option<String>, ChoiceFailure> {
    let requested = match requested {
        Some(Value::Null) => return Ok(None),
        Some(value) => value.as_str(),
        None => None,
    };
    let Some(text) = requested.or(inherited) else {
        return Ok(None);
    };
    let Some(entries) = entries else {
        return match requested {
            None => Ok(Some(text.to_owned())),
            Some(_) => Err(ChoiceFailure {
                inherited: false,
                text: text.to_owned(),
                message: SUBAGENT_MODEL_UNAVAILABLE.to_owned(),
            }),
        };
    };
    resolve(text, entries)
        .map(|resolved| Some(resolved.canonical))
        .map_err(|refusal| ChoiceFailure {
            inherited: requested.is_none(),
            text: text.to_owned(),
            message: refusal.message,
        })
}

/// Node `introducedProviders`: the providers the revision's models use that neither the session's model nor the
/// predecessor's models used (deduplicated, sorted).
pub fn introduced_providers(
    next_model: Option<&str>,
    next_bindings: &Map<String, Value>,
    predecessor_model: Option<&str>,
    predecessor_bindings: Option<&Map<String, Value>>,
    entries: Option<&[CatalogEntry]>,
) -> Vec<String> {
    let mut used = std::collections::BTreeSet::new();
    if let Some(session) = entries.and_then(|entries| entries.iter().find(|entry| entry.current)) {
        used.insert(session.provider.clone());
    }
    let before = predecessor_bindings
        .into_iter()
        .flat_map(|bindings| bindings.values().filter_map(Value::as_str));
    for model in predecessor_model.into_iter().chain(before) {
        if let Some(provider) = provider_of(model) {
            used.insert(provider.to_owned());
        }
    }
    let after = next_bindings.values().filter_map(Value::as_str);
    let mut introduced = std::collections::BTreeSet::new();
    for model in next_model.into_iter().chain(after) {
        if let Some(provider) = provider_of(model)
            && !used.contains(provider)
        {
            introduced.insert(provider.to_owned());
        }
    }
    introduced.into_iter().collect()
}

/// The provider part of a canonical `provider/model[$level]`; `None` for anything else.
fn provider_of(model: &str) -> Option<&str> {
    model.find('/').filter(|at| *at > 0).map(|at| &model[..at])
}

/// Node `splitReasoningLevel`: the `$` is searched after the provider separator; an empty side is not a level.
fn split_level(text: &str) -> (&str, Option<&str>) {
    let from = text.find('/').map_or(0, |index| index + 1);
    match text[from..].find('$').map(|index| index + from) {
        Some(index) if index > from && index + 1 < text.len() => {
            (&text[..index], Some(&text[index + 1..]))
        }
        _ => (text, None),
    }
}

fn same(left: &str, right: &str) -> bool {
    left.trim().to_lowercase() == right.trim().to_lowercase()
}

/// Node `formatModelCatalogId`: `provider/model`, without a level.
pub fn canonical_id(entry: &CatalogEntry) -> String {
    format!("{}/{}", entry.provider, entry.model)
}

fn not_found(text: &str, entries: &[CatalogEntry]) -> Refusal {
    let candidates: Vec<&CatalogEntry> = entries
        .iter()
        .filter(|entry| entry.disabled_reason.is_none())
        .collect();
    let mut lines: Vec<String> = candidates
        .iter()
        .take(CANDIDATE_LINES)
        .map(|entry| {
            format!(
                "{}{}",
                canonical_id(entry),
                if entry.current { " [current]" } else { "" }
            )
        })
        .collect();
    if candidates.len() > CANDIDATE_LINES {
        lines.push(format!(
            "… and {} more.",
            candidates.len() - CANDIDATE_LINES
        ));
    }
    let body = if candidates.is_empty() {
        "No models are configured on this host.".to_owned()
    } else {
        format!("Available models:\n{}", lines.join("\n"))
    };
    Refusal {
        reason: RefusalReason::NotFound,
        message: format!(
            "No configured model matches `{text}`. {body}\n\nPass one of these ids, or call ListModels."
        ),
    }
}

fn other_provider(text: &str, session: &CatalogEntry, candidates: &[&CatalogEntry]) -> Refusal {
    let lines: Vec<String> = candidates.iter().map(|entry| canonical_id(entry)).collect();
    let provider = session
        .provider_label
        .as_deref()
        .unwrap_or(&session.provider);
    Refusal {
        reason: RefusalReason::OtherProvider,
        message: format!(
            "`{text}` is not configured under the session's provider ({provider}), only under:\n{}\n\nA bare model name never moves the subagents to another provider. Do not pick one on your own: if you think it would help, ask the user first; once they asked for that model, pass its full `providerId/modelId`.",
            lines.join("\n")
        ),
    }
}

fn ambiguous(text: &str, candidates: &[&CatalogEntry]) -> Refusal {
    let lines: Vec<String> = candidates.iter().map(|entry| canonical_id(entry)).collect();
    Refusal {
        reason: RefusalReason::Ambiguous,
        message: format!(
            "`{text}` is configured under more than one provider:\n{}\n\nPass the full `providerId/modelId` of the one you want.",
            lines.join("\n")
        ),
    }
}

fn disabled(text: &str, candidates: &[&CatalogEntry]) -> Refusal {
    let lines: Vec<String> = candidates
        .iter()
        .map(|entry| {
            format!(
                "{} — {}",
                canonical_id(entry),
                entry.disabled_reason.as_deref().unwrap_or_default()
            )
        })
        .collect();
    Refusal {
        reason: RefusalReason::Disabled,
        message: format!(
            "`{text}` matches a model that cannot be used on this host:\n{}\n\nResolve that with the user, or call ListModels and pick another id.",
            lines.join("\n")
        ),
    }
}

fn level_unknown(entry: &CatalogEntry, level: &str) -> Refusal {
    let id = canonical_id(entry);
    let levels = if entry.reasoning_levels.is_empty() {
        format!("{id} has no reasoning levels — drop the `$` suffix.")
    } else {
        format!(
            "Its levels are: {}.{}",
            entry.reasoning_levels.join(", "),
            entry
                .default_level
                .as_deref()
                .map_or_else(String::new, |level| format!(
                    " Omit the suffix to use {level}."
                ))
        )
    };
    Refusal {
        reason: RefusalReason::ReasoningLevelUnknown,
        message: format!("`{level}` is not a reasoning level of {id}. {levels}"),
    }
}

#[cfg(test)]
#[path = "model_reference_tests.rs"]
mod tests;
