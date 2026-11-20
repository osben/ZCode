//! Fork: the SaveWorkflow tool (Node `core/src/tool/handlers/save-workflow.ts`, specs/fork-rust-workflow-engine.md W7-8b).
//!
//! The order is Node's: the input is checked (name, one source, no block in an inline script), then the Skill gate.
//! The permission decision reads the script (a `script_path` is bounded to the workspace) and typechecks it. A script
//! that does not check gets its diagnostics back without a confirmation or a write. A script that checks asks, with no
//! always-allow option, and the bytes the user was asked about are the bytes the call writes: the decision keeps them
//! for the call that follows it.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_fs::text_files::read_text;
use rust_cli_kernel_api::ids::ToolUseId;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation, failed,
    text,
};
use rust_cli_kernel_api::tool_names;
use rust_cli_kernel_api::workflow_analysis::{WorkflowAnalyzer, WorkflowDiagnostic};
use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::saved_workflow::{
    ArgDecl, ArgType, Meta, SENTINEL, Scope, Shadowing, Store, is_valid_name, parse,
    starts_with_sentinel,
};
use crate::workflow_tools::{
    Contract, DYNAMIC_WORKFLOW_SKILL, contract, skill_loaded, workspace_dir,
};

/// The refusal code for a missing source or an unusable name (Node's `SAVE_WORKFLOW_FAILURE_CODE`).
const FAILURE_CODE: i32 = 400;
/// The refusal code for a missing Skill read (Node `WORKFLOW_SKILL_NOT_LOADED_CODE`).
const SKILL_NOT_LOADED_CODE: i32 = 428;
/// Node `SAVE_WORKFLOW_MODEL_BYTES`.
pub const SAVE_MODEL_BYTES: usize = 24_000;
/// Approvals waiting for their call. A decision that is refused never reaches its call, so the table is bounded.
const APPROVAL_CAP: usize = 256;
const SOURCE_ERROR: &str = "Provide exactly one script source: `script` for the body inline, or `script_path` for the file holding it (a draft, usually). Passing both, or neither, is ambiguous.";
const SENTINEL_IN_SCRIPT_ERROR: &str = "The `script` must be the workflow body only — it already starts with a `/* zcode-workflow` metadata block. Pass the metadata through the `description` / `whenToUse` / `args` fields instead; the block is written for you.";
const NOT_SAVED_NOTE: &str =
    "NOTE: Nothing was saved — fix the errors above and call the tool again.";

/// The input (Node `SaveWorkflowInputSchema`). The keys are the schema's own names. `path`, `overwrite` and `shadowing`
/// are filled during resolution in Node; they are accepted for the schema and ignored, since the model's values never
/// decide anything.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveInput {
    name: String,
    description: String,
    #[serde(default, rename = "whenToUse")]
    when_to_use: Option<String>,
    #[serde(default)]
    args: Option<Value>,
    #[serde(default)]
    script: Option<String>,
    #[serde(default)]
    script_path: Option<String>,
    scope: String,
    #[serde(default, rename = "run_id")]
    _run_id: Option<IgnoredAny>,
    #[serde(default, rename = "path")]
    _path: Option<IgnoredAny>,
    #[serde(default, rename = "overwrite")]
    _overwrite: Option<IgnoredAny>,
    #[serde(default, rename = "shadowing")]
    _shadowing: Option<IgnoredAny>,
}

/// What the permission decision approved: the script bytes, and the checker's diagnostics for them (none, since an
/// approved script checked clean).
#[derive(Debug, Clone)]
struct Approval {
    script: String,
}

pub struct SaveWorkflowTool {
    contract: &'static Contract,
    analyzer: Arc<dyn WorkflowAnalyzer>,
    home: PathBuf,
    approvals: Mutex<HashMap<ToolUseId, Approval>>,
}

impl SaveWorkflowTool {
    pub fn new(analyzer: Arc<dyn WorkflowAnalyzer>, home: PathBuf) -> Self {
        Self {
            contract: contract(tool_names::SAVE_WORKFLOW),
            analyzer,
            home,
            approvals: Mutex::new(HashMap::new()),
        }
    }

    fn store(&self, cwd: &Path) -> Store {
        Store::new(cwd, &self.home)
    }

    fn remember(&self, tool_use: ToolUseId, script: String) {
        let mut approvals = self
            .approvals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if approvals.len() >= APPROVAL_CAP {
            approvals.clear();
        }
        approvals.insert(tool_use, Approval { script });
    }

    fn take_approval(&self, tool_use: &ToolUseId) -> Option<Approval> {
        self.approvals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(tool_use)
    }

    fn forget(&self, tool_use: &ToolUseId) {
        self.approvals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(tool_use);
    }
}

/// The refusals of the input's own shape, in Node's order (name, source, block). They read nothing from the disk.
fn check_fields(input: &SaveInput) -> Option<Validation> {
    if !is_valid_name(&input.name) {
        return Some(invalid_with(
            FAILURE_CODE,
            format!(
                "'{}' is not a usable workflow name: names may only contain letters, digits, '.', '-' and '_', and must be 1-64 characters.",
                input.name
            ),
        ));
    }
    if input.script.is_some() == input.script_path.is_some() {
        return Some(invalid_with(FAILURE_CODE, SOURCE_ERROR.to_owned()));
    }
    if let Some(script) = &input.script
        && script.trim_start().starts_with(SENTINEL)
    {
        return Some(invalid_with(
            FAILURE_CODE,
            SENTINEL_IN_SCRIPT_ERROR.to_owned(),
        ));
    }
    None
}

fn invalid_with(code: i32, message: String) -> Validation {
    Validation::Invalid {
        message,
        error_code: Some(code),
    }
}

/// Lexical normalization of `.` and `..` (no disk access).
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// A `script_path` must resolve inside the workspace. Node accepts any path; a draft outside the repository is refused
/// here (divergence 113), so a model cannot make the tool read files it has no business with.
fn within_workspace(cwd: &Path, input_path: &str) -> Result<PathBuf, String> {
    let joined = if Path::new(input_path).is_absolute() {
        PathBuf::from(input_path)
    } else {
        cwd.join(input_path)
    };
    let resolved = normalize(&joined);
    if resolved.starts_with(normalize(cwd)) {
        Ok(resolved)
    } else {
        Err(format!(
            "The workflow script file {input_path} is outside the workspace. Pass a `script_path` inside it, or submit the script inline."
        ))
    }
}

/// Node `readWorkflowScriptFile` for a save: read the file, and if it starts with a block, take its body only.
fn read_script_path(cwd: &Path, input_path: &str) -> Result<String, String> {
    let absolute = within_workspace(cwd, input_path)?;
    let described = describe(&absolute, cwd);
    let source = read_text(&absolute).map_err(|error| {
        format!(
            "The workflow script file {described} could not be read: {error}. Pass `script_path` for a file that exists, or submit the script inline."
        )
    })?;
    if !starts_with_sentinel(&source) {
        return Ok(source);
    }
    match parse(&source) {
        Ok(parsed) => Ok(parsed.script),
        Err(error) => Err(format!(
            "The workflow script file {described} starts with a `/* zcode-workflow` metadata block that could not be read ({}): {}. Fix the block in that file, or remove it and pass the script alone.",
            error.reason(),
            error.detail()
        )),
    }
}

/// Node `describeWorkflowScriptPath`: relative to the working directory when the file is inside it.
fn describe(absolute: &Path, cwd: &Path) -> String {
    match absolute.strip_prefix(cwd) {
        Ok(relative) if !relative.as_os_str().is_empty() => relative.display().to_string(),
        _ => absolute.display().to_string(),
    }
}

/// The source of a call: the inline script, or the draft file's body.
fn resolve_source(input: &SaveInput, cwd: &Path) -> Result<String, String> {
    if let Some(script) = &input.script {
        return Ok(script.clone());
    }
    read_script_path(cwd, input.script_path.as_deref().unwrap_or_default())
}

fn meta_of(input: &SaveInput) -> Result<Meta, String> {
    let args = match &input.args {
        None => None,
        Some(value) => Some(args_from_json(value)?),
    };
    Ok(Meta {
        description: input.description.clone(),
        when_to_use: input.when_to_use.clone(),
        args,
    })
}

/// The declared arguments, checked against the input schema's rules (type enum, known keys only). The description may be
/// empty (Node: `z.string().optional()`).
fn args_from_json(value: &Value) -> Result<Vec<(String, ArgDecl)>, String> {
    let Some(entries) = value.as_object() else {
        return Err("args: Expected object".to_owned());
    };
    let mut declared = Vec::new();
    for (name, decl) in entries {
        let path = format!("args.{name}");
        let Some(fields) = decl.as_object() else {
            return Err(format!("{path}: Expected object"));
        };
        if let Some(extra) = fields.keys().find(|key| {
            !matches!(
                key.as_str(),
                "type" | "description" | "required" | "default"
            )
        }) {
            return Err(format!("{path}: Unrecognized key(s) in object: '{extra}'"));
        }
        let ty = match fields.get("type").and_then(Value::as_str) {
            Some("string") => ArgType::String,
            Some("number") => ArgType::Number,
            Some("boolean") => ArgType::Boolean,
            Some("json") => ArgType::Json,
            _ => {
                return Err(format!(
                    "{path}.type: Invalid enum value. Expected 'string' | 'number' | 'boolean' | 'json'"
                ));
            }
        };
        let description = match fields.get("description") {
            None => None,
            Some(Value::String(text)) => Some(text.clone()),
            Some(_) => return Err(format!("{path}.description: Expected string")),
        };
        let required = match fields.get("required") {
            None => None,
            Some(Value::Bool(flag)) => Some(*flag),
            Some(_) => return Err(format!("{path}.required: Expected boolean")),
        };
        declared.push((
            name.clone(),
            ArgDecl {
                ty,
                description,
                required,
                default: fields.get("default").cloned(),
            },
        ));
    }
    Ok(declared)
}

/// The confirmation's text: the destination, and what the write would replace or hide.
fn confirmation_message(
    name: &str,
    path: &Path,
    overwrite: bool,
    shadowing: Option<Shadowing>,
) -> String {
    let mut message = format!("Save workflow '{name}' to {}", path.display());
    if overwrite {
        message.push_str(" (replaces the existing file)");
    }
    match shadowing {
        Some(Shadowing::HidesGlobal) => {
            message.push_str(" (hides a global workflow of the same name)")
        }
        Some(Shadowing::HiddenByProject) => {
            message.push_str(" (hidden by a project workflow of the same name)")
        }
        None => {}
    }
    message
}

fn diagnostic_value(diagnostic: &WorkflowDiagnostic) -> Value {
    json!({
        "code": diagnostic.code,
        "column": diagnostic.column,
        "line": diagnostic.line,
        "message": diagnostic.message,
    })
}

fn failing_response(diagnostics: &[WorkflowDiagnostic]) -> String {
    let mut lines = vec!["The workflow script has errors:".to_owned()];
    lines.extend(diagnostics.iter().map(|diagnostic| {
        format!(
            "L{}:C{} {}",
            diagnostic.line, diagnostic.column, diagnostic.message
        )
    }));
    lines.push(String::new());
    lines.push(NOT_SAVED_NOTE.to_owned());
    lines.join("\n")
}

fn saved_response(name: &str, scope: Scope, path: &Path, overwritten: bool) -> String {
    let global = scope == Scope::Global;
    let report = match (overwritten, global) {
        (true, true) => format!(
            "Replaced the saved global workflow '{name}' at {}.",
            path.display()
        ),
        (true, false) => format!(
            "Replaced the saved workflow '{name}' at {}.",
            path.display()
        ),
        (false, true) => format!("Saved global workflow '{name}' to {}.", path.display()),
        (false, false) => format!("Saved the workflow '{name}' to {}.", path.display()),
    };
    format!("{report} Run it with CreateWorkflow using `saved: {{ name: \"{name}\" }}`.")
}

fn scope_of(input: &SaveInput) -> Option<Scope> {
    Scope::parse(&input.scope)
}

fn blocking_failure(error: tokio::task::JoinError) -> ToolError {
    failed(format!(
        "SaveWorkflow could not finish the file operation: {error}"
    ))
}

#[async_trait]
impl Tool for SaveWorkflowTool {
    fn name(&self) -> &str {
        tool_names::SAVE_WORKFLOW
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

    /// Writes the user's repository, so it is never read-only and never concurrency safe (Node `readOnly: false`).
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
        Some(SAVE_MODEL_BYTES)
    }

    /// The input's shape, the Skill gate, and the args. No disk access: a `script_path` is read by the permission decision.
    async fn validate_input(&self, input: &Value, context: &ToolUseContext) -> Validation {
        let input: SaveInput = match serde_json::from_value(input.clone()) {
            Ok(input) => input,
            Err(error) => {
                return Validation::Invalid {
                    message: error.to_string(),
                    error_code: None,
                };
            }
        };
        if let Some(refusal) = check_fields(&input) {
            return refusal;
        }
        if !skill_loaded(context).await {
            return invalid_with(
                SKILL_NOT_LOADED_CODE,
                format!(
                    "SaveWorkflow needs the `{DYNAMIC_WORKFLOW_SKILL}` skill loaded in this session before it accepts a script. Call the Skill tool with skill \"{DYNAMIC_WORKFLOW_SKILL}\" first — it carries the facade declarations the script is checked against, the authoring rules and this tool's full contract — then call SaveWorkflow again. Nothing was started."
                ),
            );
        }
        match meta_of(&input) {
            Ok(_) => Validation::Ok,
            Err(message) => invalid_with(FAILURE_CODE, message),
        }
    }

    /// Node `prepareSaveWorkflowApproval`: the source is read here and checked. A script that checks asks, as an
    /// always-ask with `independent` (no always-allow), and the bytes asked about are kept for the call. A script that does not check
    /// proceeds to the call, which returns its diagnostics without writing.
    async fn check_permissions(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> PermissionDecision {
        let Ok(input) = serde_json::from_value::<SaveInput>(input.clone()) else {
            return PermissionDecision::Passthrough;
        };
        let cwd = PathBuf::from(workspace_dir(context));
        let script = match resolve_source(&input, &cwd) {
            Ok(script) => script,
            Err(message) => return PermissionDecision::Deny { message },
        };
        let analysis = match self.analyzer.analyze(&script).await {
            Ok(analysis) => analysis,
            Err(error) => {
                return PermissionDecision::Deny {
                    message: error.message,
                };
            }
        };
        if !analysis.ok {
            self.forget(&context.tool_use);
            return PermissionDecision::Allow {
                updated_input: None,
            };
        }
        let Some(scope) = scope_of(&input) else {
            return PermissionDecision::Passthrough;
        };
        let store = self.store(&cwd);
        let name = input.name.clone();
        let facts = tokio::task::spawn_blocking(move || {
            (
                store.path(scope, &name),
                store.exists(&name, scope),
                store.shadowing(&name, scope),
            )
        })
        .await;
        let Ok((path, overwrite, shadowing)) = facts else {
            return PermissionDecision::Deny {
                message: "SaveWorkflow could not read the saved workflows".to_owned(),
            };
        };
        self.remember(context.tool_use.clone(), script);
        // Node `alwaysAsk` with `allowAlways: false`: asked in every mode, and no always-allow is offered.
        PermissionDecision::always_ask(
            confirmation_message(&input.name, &path, overwrite, shadowing),
            Vec::new(),
            true,
        )
    }

    /// Writes the approved bytes. Without an approval for this call, a script that checks clean is not written: the
    /// call reports that it was not confirmed, and a script that does not check gets its diagnostics.
    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let input: SaveInput =
            serde_json::from_value(input).map_err(|error| ToolError::InvalidInput {
                message: error.to_string(),
            })?;
        let Some(scope) = scope_of(&input) else {
            return Err(ToolError::InvalidInput {
                message: "scope must be \"project\" or \"global\"".to_owned(),
            });
        };
        let cwd = PathBuf::from(workspace_dir(&context));
        let meta = meta_of(&input).map_err(|message| ToolError::InvalidInput { message })?;
        let script = match self.take_approval(&context.tool_use) {
            Some(approval) => approval.script,
            None => {
                let script = resolve_source(&input, &cwd).map_err(failed)?;
                let analysis = self
                    .analyzer
                    .analyze(&script)
                    .await
                    .map_err(|error| failed(error.message))?;
                if analysis.ok {
                    return Err(failed(
                        "SaveWorkflow has no confirmation for this script, so nothing was written. Call it again.".to_owned(),
                    ));
                }
                let path = self.store(&cwd).path(scope, &input.name);
                let mut output = text(failing_response(&analysis.diagnostics));
                output.display = json!({
                    "name": input.name,
                    "scope": scope.as_str(),
                    "path": path.display().to_string(),
                    "diagnostics": analysis.diagnostics.iter().map(diagnostic_value).collect::<Vec<_>>(),
                    "ok": false,
                });
                return Ok(output);
            }
        };
        let store = self.store(&cwd);
        let name = input.name.clone();
        let saved = tokio::task::spawn_blocking(move || store.save(&name, &meta, &script, scope))
            .await
            .map_err(blocking_failure)?
            .map_err(|error| failed(format!("SaveWorkflow could not write the file: {error}")))?;
        let mut output = text(saved_response(
            &input.name,
            saved.scope,
            &saved.path,
            saved.overwritten,
        ));
        output.display = json!({
            "name": input.name,
            "scope": saved.scope.as_str(),
            "path": saved.path.display().to_string(),
            "diagnostics": [],
            "ok": true,
            "overwritten": saved.overwritten,
        });
        Ok(output)
    }
}

#[cfg(test)]
#[path = "workflow_save_tests.rs"]
mod tests;
