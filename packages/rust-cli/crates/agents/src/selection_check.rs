//! Fork (node_desktop): Node's up-front check of a subagent's own model selection
//! (specs/fork-rust-subagent-runtime-config.md rule 9; core `runtime/helpers/subagent-selection.ts`
//! `resolveSubagentSelection`, provider `effective-model-selection.ts`).

use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::provider::ModelCatalog;

/// Why the catalog cannot serve `selection`, as Node's `selectionIssue`; None when it can.
///
/// The provider and model are matched as given: Node's account-plan remap and legacy reasoning levels are not
/// ported (rule 9, remaining differences), and the account connection is left for the platform to pick.
pub(crate) fn issue(catalog: &ModelCatalog, selection: &ModelSelection) -> Option<&'static str> {
    let mut models = catalog
        .models
        .iter()
        .filter(|entry| entry.provider == selection.provider)
        .peekable();
    if models.peek().is_none() {
        return Some("provider-not-found");
    }
    let Some(model) = models.find(|entry| entry.model == selection.model) else {
        return Some("model-not-found");
    };
    match &selection.reasoning {
        None => Some("reasoning-level-missing"),
        Some(level) if !model.reasoning_levels.contains(level) => {
            Some("reasoning-level-not-supported")
        }
        Some(_) => None,
    }
}

/// Node's error text for `reason` (`SUBAGENT_SELECTION_MESSAGES`).
pub(crate) fn refusal(reason: &str, selection: &ModelSelection) -> String {
    let message = match reason {
        "provider-not-found" => "Provider unavailable / 供应商不存在或不可用",
        "model-not-found" => "Model unavailable / 模型不存在或不可用",
        "reasoning-level-missing" => "No reasoning level selected / 未选择思考档位",
        "reasoning-level-not-supported" => "Reasoning level unsupported / 不支持所选思考档位",
        _ => "No model selected / 未选择模型",
    };
    format!(
        "Cannot start subagent: {message} [reason={reason}; selection={}/{}]",
        selection.provider, selection.model
    )
}

#[cfg(test)]
#[path = "selection_check_tests.rs"]
mod tests;
