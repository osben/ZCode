//! Fork: the SaveWorkflow tool (Node `core/src/tool/handlers/save-workflow.ts`, specs/fork-rust-workflow-engine.md W7-8b).
//!
//! The order is Node's: the input is checked (name, one source, no block in an inline script), then the Skill gate.
//! The permission decision reads the script (a `script_path` is bounded to the workspace) and typechecks it. A script
//! that does not check gets its diagnostics back without a confirmation or a write. A script that checks asks, with no
//! always-allow option, and the bytes the user was asked about are the bytes the call writes: the decision keeps them
//! for the call that follows it.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use rust_cli_fs::read_text;
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
    ArgDecl, ArgType, Meta, SENTINEL, Scope, Shadowing, Store, is_valid_name, js_trim_start, parse,
    starts_with_sentinel,
};
use crate::workflow_tools::{
    Contract, DYNAMIC_WORKFLOW_SKILL, contract, skill_loaded, workspace_dir,
};
use crate::workspace_path::{Refusal, contain};

/// The refusal code for a missing source or an unusable name (Node's `SAVE_WORKFLOW_FAILURE_CODE`).
const FAILURE_CODE: i32 = 400;
/// The refusal code for a missing Skill read (Node `WORKFLOW_SKILL_NOT_LOADED_CODE`).
const SKILL_NOT_LOADED_CODE: i32 = 428;
/// Node `SAVE_WORKFLOW_MODEL_BYTES`.
pub const SAVE_MODEL_BYTES: usize = 24_000;
/// Decisions waiting for their call. A decision that is refused never reaches its call, so the table is bounded: past
/// this many, the oldest entry goes (one at a time), never the whole table.
const PENDING_CAP: usize = 256;
const SOURCE_ERROR: &str = "Provide exactly one script source: `script` for the body inline, or `script_path` for the file holding it (a draft, usually). Passing both, or neither, is ambiguous.";
const SENTINEL_IN_SCRIPT_ERROR: &str = "The `script` must be the workflow body only — it already starts with a `/* zcode-workflow` metadata block. Pass the metadata through the `description` / `whenToUse` / `args` fields instead; the block is written for you.";
const NOT_SAVED_NOTE: &str =
    "NOTE: Nothing was saved — fix the errors above and call the tool again.";

/// The input (Node `SaveWorkflowInputSchema`). The keys are the schema's own names. `path`, `overwrite` and `shadowing`
/// are filled during resolution in Node; they are accepted for the schema and ignored, since the model's values never
/// decide anything.
#[derive(Debug, Clone, Deserialize)]
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

/// What the permission decision leaves for the call with the same tool-use id.
#[derive(Debug, Clone)]
enum Pending {
    /// The script the user approved (it checked clean); the call writes these bytes.
    Approved(String),
    /// The checker's diagnostics for a script that did not check; the call returns them without checking again.
    Failed(Vec<WorkflowDiagnostic>),
}

/// The pending decisions in arrival order. Past the cap the oldest entry is evicted, so a decision that is still waiting
/// is dropped only when it is the oldest one.
#[derive(Default)]
struct PendingTable {
    entries: HashMap<ToolUseId, Pending>,
    order: VecDeque<ToolUseId>,
}

impl PendingTable {
    fn insert(&mut self, id: ToolUseId, pending: Pending) {
        if self.entries.insert(id.clone(), pending).is_some() {
            self.order.retain(|queued| queued != &id);
        }
        self.order.push_back(id);
        while self.order.len() > PENDING_CAP {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    fn take(&mut self, id: &ToolUseId) -> Option<Pending> {
        let pending = self.entries.remove(id)?;
        self.order.retain(|queued| queued != id);
        Some(pending)
    }
}

pub struct SaveWorkflowTool {
    contract: &'static Contract,
    analyzer: Arc<dyn WorkflowAnalyzer>,
    home: PathBuf,
    pending: Mutex<PendingTable>,
}

impl SaveWorkflowTool {
    pub fn new(analyzer: Arc<dyn WorkflowAnalyzer>, home: PathBuf) -> Self {
        Self {
            contract: contract(tool_names::SAVE_WORKFLOW),
            analyzer,
            home,
            pending: Mutex::new(PendingTable::default()),
        }
    }

    fn store(&self, cwd: &Path) -> Store {
        Store::new(cwd, &self.home)
    }

    fn pending(&self) -> MutexGuard<'_, PendingTable> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The output of a script that does not check: its diagnostics, and where the file would have gone.
    fn failing_output(
        &self,
        name: &str,
        scope: Scope,
        cwd: &Path,
        diagnostics: &[WorkflowDiagnostic],
    ) -> ToolOutput {
        let path = self.store(cwd).path(scope, name);
        let mut output = text(failing_response(diagnostics));
        output.display = json!({
            "name": name,
            "scope": scope.as_str(),
            "path": path.display().to_string(),
            "diagnostics": diagnostics.iter().map(diagnostic_value).collect::<Vec<_>>(),
            "ok": false,
        });
        output
    }
}

/// The source of a call, read on a blocking thread (the draft is a file).
async fn resolve_source_blocking(input: &SaveInput, cwd: &Path) -> Result<String, String> {
    let input = input.clone();
    let cwd = cwd.to_path_buf();
    tokio::task::spawn_blocking(move || resolve_source(&input, &cwd))
        .await
        .map_err(|error| join_message(&error))?
}

/// Whether an inline script opens with the metadata marker, as Node's `trimStart().startsWith` decides (a byte order
/// mark is trimmed by JavaScript, so it is skipped here too).
fn opens_with_block(script: &str) -> bool {
    js_trim_start(script).starts_with(SENTINEL)
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
        && opens_with_block(script)
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

/// A `script_path` must resolve inside the workspace (divergences 113 and 119, the shared check in `workspace_path`).
/// The file is read at the real path that was checked, never at the named one. A file that cannot be resolved (missing,
/// dangling link) is reported as an unreadable file, and a path outside the workspace is refused.
fn read_script_path(cwd: &Path, input_path: &str) -> Result<String, String> {
    let contained = match contain(cwd, input_path) {
        Ok(contained) => contained,
        Err(Refusal::Outside) => {
            return Err(format!(
                "The workflow script file {input_path} is outside the workspace. Pass a `script_path` inside it, or submit the script inline."
            ));
        }
        Err(Refusal::Unresolved(error)) => {
            let described = describe(&cwd.join(input_path), cwd);
            return Err(unreadable(&described, &error));
        }
    };
    let described = describe(&contained.named, cwd);
    let source = read_text(&contained.real).map_err(|error| unreadable(&described, &error))?;
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

/// The refusal for a file that cannot be read (the same text for a missing file and for an unresolvable link).
fn unreadable(described: &str, error: &std::io::Error) -> String {
    format!(
        "The workflow script file {described} could not be read: {error}. Pass `script_path` for a file that exists, or submit the script inline."
    )
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
        // zod's `strict()` lists every unknown key, quoted and joined with ", ".
        let extras: Vec<String> = fields
            .keys()
            .filter(|key| {
                !matches!(
                    key.as_str(),
                    "type" | "description" | "required" | "default"
                )
            })
            .map(|key| format!("'{key}'"))
            .collect();
        if !extras.is_empty() {
            return Err(format!(
                "{path}: Unrecognized key(s) in object: {}",
                extras.join(", ")
            ));
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

fn join_message(error: &tokio::task::JoinError) -> String {
    format!("SaveWorkflow could not finish the file operation: {error}")
}

fn blocking_failure(error: tokio::task::JoinError) -> ToolError {
    failed(join_message(&error))
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
        let script = match resolve_source_blocking(&input, &cwd).await {
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
            // The call returns these diagnostics; it does not check the script a second time.
            self.pending().insert(
                context.tool_use.clone(),
                Pending::Failed(analysis.diagnostics),
            );
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
        self.pending()
            .insert(context.tool_use.clone(), Pending::Approved(script));
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
        // The guard is a statement temporary: it is released before the next await.
        let taken = self.pending().take(&context.tool_use);
        let script = match taken {
            Some(Pending::Approved(script)) => script,
            Some(Pending::Failed(diagnostics)) => {
                return Ok(self.failing_output(&input.name, scope, &cwd, &diagnostics));
            }
            None => {
                let script = resolve_source_blocking(&input, &cwd)
                    .await
                    .map_err(failed)?;
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
                return Ok(self.failing_output(&input.name, scope, &cwd, &analysis.diagnostics));
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
