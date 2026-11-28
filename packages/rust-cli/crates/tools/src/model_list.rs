//! Fork: the ListModels tool (Node `core/src/tool/handlers/list-models.ts`, specs/fork-rust-workflow-engine.md 9.69). A read
//! of the catalog the resolver reads (`model_reference::session_entries`): no confirmation, no write, and it cannot change
//! the model the session runs on. Its rows are what `subagent_model` takes.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::provider::LateModelDirectory;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation, text,
};
use rust_cli_kernel_api::tool_names;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::model_reference::{CatalogEntry, canonical_id, session_entries};
use crate::workflow_observation_display::list_models_display;
use crate::workflow_tools::{Contract, contract};

/// Node `LIST_MODELS_MODEL_BYTES`.
pub const LIST_MODELS_MODEL_BYTES: usize = 24_000;
/// Node `LIST_MODELS_ERROR_CODE.CATALOG_UNAVAILABLE`.
const CATALOG_UNAVAILABLE_CODE: i32 = 31;
/// Node `modelCatalogUnavailableFailure`: a host with no catalog is a capability gap, never an empty configuration.
const CATALOG_UNAVAILABLE: &str = "model_catalog_unavailable: this session cannot list models \u{2014} the host did not provide a model catalog. This is a capability gap, not an empty configuration. Omit `subagent_model` on CreateWorkflow and AmendWorkflow; the workflow's subagents will run on the session model.";

/// The input takes nothing (Node's strict empty schema: no filter, no paging).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListInput {}

pub struct ListModelsTool {
    contract: &'static Contract,
    models: Arc<LateModelDirectory>,
}

impl ListModelsTool {
    /// `models` is the late slot the workflow tools resolve against; it is read at each call.
    pub fn new(models: Arc<LateModelDirectory>) -> Self {
        Self {
            contract: contract(tool_names::LIST_MODELS),
            models,
        }
    }
}

/// Node `formatListModelsModelContent`: one line per model, the id first, then the provider name, the levels, and the
/// current and disabled markers last so a long level list cannot push them out of view.
fn format_model_text(entries: &[CatalogEntry]) -> String {
    if entries.is_empty() {
        return [
            "<models count=\"0\">",
            "No models are configured on this host. Omit `subagent_model`: the workflow's subagents run on the session model.",
            "</models>",
        ]
        .join("\n");
    }
    let current = entries.iter().find(|entry| entry.current).map(canonical_id);
    let mut lines = vec![format!("<models count=\"{}\">", entries.len())];
    for entry in entries {
        let id = canonical_id(entry);
        let mut line = id.clone();
        if let Some(label) = &entry.provider_label {
            line.push_str(&format!(" \u{2014} {label}"));
        }
        if !entry.reasoning_levels.is_empty() {
            line.push_str(&format!("; levels: {}", entry.reasoning_levels.join(",")));
            if let Some(level) = &entry.default_level {
                line.push_str(&format!(" (default {level})"));
            }
        }
        if current.as_deref() == Some(id.as_str()) {
            line.push_str(" [current]");
        }
        if let Some(reason) = &entry.disabled_reason {
            line.push_str(&format!(" [disabled: {reason}]"));
        }
        lines.push(line);
    }
    lines.push("</models>".to_owned());
    lines.join("\n")
}

#[async_trait]
impl Tool for ListModelsTool {
    fn name(&self) -> &str {
        tool_names::LIST_MODELS
    }

    fn input_schema(&self) -> Value {
        self.contract.input_schema.clone()
    }

    fn description(&self, _context: &PromptContext) -> String {
        self.contract.description.clone()
    }

    fn should_defer(&self) -> bool {
        self.contract.should_defer
    }

    fn search_hint(&self) -> Option<&str> {
        self.contract.search_hint.as_deref()
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        self.contract.read_only
    }

    fn is_destructive(&self, _input: &Value) -> bool {
        self.contract.destructive
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        self.contract.concurrent_safe
    }

    fn result_budget_truncate_bytes(&self) -> Option<usize> {
        Some(LIST_MODELS_MODEL_BYTES)
    }

    async fn validate_input(&self, input: &Value, _context: &ToolUseContext) -> Validation {
        match serde_json::from_value::<ListInput>(input.clone()) {
            Ok(_) => Validation::Ok,
            Err(error) => Validation::Invalid {
                message: error.to_string(),
                error_code: None,
            },
        }
    }

    /// Reads the catalog and writes nothing: no confirmation (Node `needsApproval: false`).
    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        PermissionDecision::Allow {
            updated_input: None,
        }
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        serde_json::from_value::<ListInput>(input).map_err(|error| ToolError::InvalidInput {
            message: error.to_string(),
        })?;
        let Some(entries) = session_entries(&self.models, &context).await else {
            return Err(ToolError::FailedWithCode {
                message: CATALOG_UNAVAILABLE.to_owned(),
                code: CATALOG_UNAVAILABLE_CODE,
            });
        };
        let mut output = text(format_model_text(&entries));
        output.display = list_models_display(&entries);
        Ok(output)
    }
}

#[cfg(test)]
#[path = "model_list_tests.rs"]
mod tests;
