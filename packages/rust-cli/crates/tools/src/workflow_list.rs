//! Fork: the ListSavedWorkflows tool (Node `core/src/tool/handlers/list-saved-workflows.ts`, specs/fork-rust-workflow-engine.md
//! W7-8b). A read of the catalog: no confirmation, no write. The project root is always the session's working directory.

use std::path::PathBuf;

use async_trait::async_trait;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation, failed,
    text,
};
use rust_cli_kernel_api::tool_names;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::saved_workflow::{ArgDecl, ArgType, InvalidEntry, Listing, SavedEntry, Store};
use crate::workflow_tools::{Contract, contract, workspace_dir};

/// Node `LIST_SAVED_WORKFLOWS_MODEL_BYTES`: enough for dozens of entries.
pub const LIST_MODEL_BYTES: usize = 24_000;

/// The input takes nothing: the root is the session's working directory (Node's strict empty schema).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListInput {}

pub struct ListSavedWorkflowsTool {
    contract: &'static Contract,
    home: PathBuf,
}

impl ListSavedWorkflowsTool {
    pub fn new(home: PathBuf) -> Self {
        Self {
            contract: contract(tool_names::LIST_SAVED_WORKFLOWS),
            home,
        }
    }
}

fn entry_value(entry: &SavedEntry) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("name".to_owned(), json!(entry.name));
    object.insert("description".to_owned(), json!(entry.description));
    if let Some(when) = &entry.when_to_use {
        object.insert("whenToUse".to_owned(), json!(when));
    }
    if let Some(args) = &entry.args {
        let mut declared = serde_json::Map::new();
        for (name, decl) in args {
            declared.insert(name.clone(), decl_value(decl));
        }
        object.insert("args".to_owned(), Value::Object(declared));
    }
    object.insert("scope".to_owned(), json!(entry.scope.as_str()));
    object.insert("path".to_owned(), json!(entry.path));
    Value::Object(object)
}

fn decl_value(decl: &ArgDecl) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("type".to_owned(), json!(arg_type_text(decl.ty)));
    if let Some(description) = &decl.description {
        object.insert("description".to_owned(), json!(description));
    }
    if let Some(required) = decl.required {
        object.insert("required".to_owned(), json!(required));
    }
    if let Some(default) = &decl.default {
        object.insert("default".to_owned(), default.clone());
    }
    Value::Object(object)
}

fn arg_type_text(ty: ArgType) -> &'static str {
    match ty {
        ArgType::String => "string",
        ArgType::Number => "number",
        ArgType::Boolean => "boolean",
        ArgType::Json => "json",
    }
}

fn display_of(listing: &Listing) -> Value {
    let mut display = serde_json::Map::new();
    display.insert(
        "workflows".to_owned(),
        Value::Array(listing.entries.iter().map(entry_value).collect()),
    );
    // Omitted when empty, as Node omits `invalid` from the output.
    if !listing.invalid.is_empty() {
        display.insert(
            "invalid".to_owned(),
            Value::Array(listing.invalid.iter().map(invalid_value).collect()),
        );
    }
    Value::Object(display)
}

fn invalid_value(entry: &InvalidEntry) -> Value {
    json!({"path": entry.path, "reason": entry.reason})
}

/// Node `escapeAttribute`: the name and the path can carry quotes, so they are escaped before they go in an attribute.
fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
}

/// The model's text: one container with one block per definition. The name, the description, the usage and the argument
/// table are what the model needs to choose, so each definition gets several lines.
fn format_model_text(display: &Value) -> String {
    let workflows: &[Value] = display["workflows"].as_array().map_or(&[], Vec::as_slice);
    let invalid: Option<&[Value]> = display
        .get("invalid")
        .and_then(Value::as_array)
        .map(Vec::as_slice);
    if workflows.is_empty() && invalid.is_none() {
        return [
            "<saved_workflows count=\"0\">".to_owned(),
            "No workflows are saved in this project yet. Saved definitions live in .zcode/workflows/.".to_owned(),
            "</saved_workflows>".to_owned(),
        ]
        .join("\n");
    }
    let mut lines = vec![format!("<saved_workflows count=\"{}\">", workflows.len())];
    for workflow in workflows {
        lines.push(format!(
            "<workflow name=\"{}\" scope=\"{}\">",
            escape_attribute(workflow["name"].as_str().unwrap_or_default()),
            workflow["scope"].as_str().unwrap_or_default()
        ));
        lines.push(format!(
            "  {}",
            workflow["description"].as_str().unwrap_or_default()
        ));
        if let Some(when) = workflow["whenToUse"].as_str() {
            lines.push(format!("  When to use: {when}"));
        }
        if let Some(args) = workflow["args"].as_object() {
            for (key, spec) in args {
                let mut notes = vec![spec["type"].as_str().unwrap_or_default().to_owned()];
                if spec["required"] == json!(true) {
                    notes.push("required".to_owned());
                }
                if let Some(default) = spec.get("default") {
                    notes.push(format!("default {default}"));
                }
                let description = spec["description"]
                    .as_str()
                    .map(|text| format!(" — {text}"))
                    .unwrap_or_default();
                lines.push(format!("  arg {key} ({}){description}", notes.join(", ")));
            }
        }
        lines.push("</workflow>".to_owned());
    }
    for entry in invalid.unwrap_or_default() {
        lines.push(format!(
            "<invalid path=\"{}\">{}</invalid>",
            escape_attribute(entry["path"].as_str().unwrap_or_default()),
            entry["reason"].as_str().unwrap_or_default()
        ));
    }
    lines.push("</saved_workflows>".to_owned());
    lines.join("\n")
}

#[async_trait]
impl Tool for ListSavedWorkflowsTool {
    fn name(&self) -> &str {
        tool_names::LIST_SAVED_WORKFLOWS
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
        Some(LIST_MODEL_BYTES)
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
        let cwd = PathBuf::from(workspace_dir(&context));
        let home = self.home.clone();
        let listing = tokio::task::spawn_blocking(move || Store::new(&cwd, &home).list())
            .await
            .map_err(|error| {
                failed(format!(
                    "ListSavedWorkflows could not read the catalog: {error}"
                ))
            })?;
        let display = display_of(&listing);
        let mut output = text(format_model_text(&display));
        output.display = display;
        Ok(output)
    }
}

#[cfg(test)]
#[path = "workflow_list_tests.rs"]
mod tests;
