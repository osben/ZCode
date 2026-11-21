//! Fork: the CreateWorkflow tool (Node `core/src/tool/handlers/create-workflow.ts`, `create-workflow-source.ts`,
//! `workflow-drafts.ts`, `workflow-path-source.ts`, `workflow-skill-gate.ts`; specs/fork-rust-workflow-engine.md W7-8a).
//!
//! The order is Node's. The input is checked (name, `max_concurrency`, exactly one source, `args` only with `path`), then
//! the Skill gate (a saved run is exempt), then `subagent_model`, which this host refuses (it has no model catalog). The
//! permission decision reads the script once (a `saved` definition, a `path` file or the inline text), checks it, and
//! asks when it checks. The bytes asked about are kept for the call, which writes the draft, and submits the run through
//! the run port when one is wired. A script that does not check gets its diagnostics in file lines, with no run.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_fs::{create_new_text, ensure_dir, read_text};
use rust_cli_kernel_api::ids::ToolUseId;
use rust_cli_kernel_api::permission::{PermissionDecision, PermissionRule};
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation, failed,
    text,
};
use rust_cli_kernel_api::tool_names;
use rust_cli_kernel_api::workflow_analysis::{
    WorkflowAnalysis, WorkflowAnalyzer, WorkflowDiagnostic,
};
use rust_cli_kernel_api::workflow_run::{DynamicWorkflowRunSessions, SubmitRequest};
use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::{Map, Value};
use tokio::sync::mpsc;

use crate::saved_workflow::{
    ArgDecl, ArgType, FILE_EXTENSION, ResolveRefusal, Scope, Store, invalid_name_text,
    not_found_headline, parse as parse_saved, starts_with_sentinel, unreadable_text,
};
use crate::workflow_tools::{
    Contract, DYNAMIC_WORKFLOW_SKILL, contract, skill_loaded, workspace_dir,
};
use crate::workspace_path::{Refusal, contain};

/// Node `CREATE_WORKFLOW_FAILURE_CODE`: a business refusal of the input.
const FAILURE_CODE: i32 = 400;
/// Node `WORKFLOW_SKILL_NOT_LOADED_CODE`.
const SKILL_NOT_LOADED_CODE: i32 = 428;
/// Node `CREATE_WORKFLOW_MODEL_BYTES`.
pub const CREATE_MODEL_BYTES: usize = 24_000;
/// Approvals waiting for their call. A decision that is refused never reaches its call, so the table is bounded.
const APPROVAL_CAP: usize = 256;
/// Node `MAX_DRAFT_ATTEMPTS`: suffixes tried for a taken draft name.
const DRAFT_ATTEMPTS: usize = 1_000;
/// Node `WORKFLOW_DRAFT_MAX_SLUG_CHARS` (the same cap as a saved name).
pub(crate) const DRAFT_SLUG_CHARS: usize = 64;
/// Node `WORKFLOW_DRAFTS_DIR`.
pub(crate) const DRAFTS_DIR: &str = ".zcode/workflow-drafts";
/// Node `DIAGNOSTICS_NOT_EXECUTED_NOTE`: diagnostics with no script file to point at.
pub(crate) const DIAGNOSTICS_NOT_EXECUTED_NOTE: &str =
    "NOTE: The workflow was NOT executed — fix the errors above and resubmit.";
/// Node `EXECUTION_UNAVAILABLE_NOTE`: the script checks, and this session has no run port.
pub(crate) const EXECUTION_UNAVAILABLE_NOTE: &str = "NOTE: The workflow was NOT executed — workflow execution is not available in this session, so the script was only typechecked.";
const SUBAGENT_MODEL_UNAVAILABLE: &str =
    "This host cannot choose a subagent model; omit subagent_model.";
const MISSING_SOURCE: &str = r"No workflow source arrived. Pass `script` for a one-off script written inline, `saved` to run a workflow saved in this project, or `path` for a script file on disk. If you did pass one, the call's arguments were not valid JSON, and a call that does not parse arrives empty. The usual cause is an unescaped backslash or double quote in the inline source: inside a JSON string a regex's `\d` must be written `\\d`. Escape it, or write the source to a file and pass `path`.";
const CONFLICTING_SOURCES: &str = "Provide exactly one workflow source: `script` for a one-off script written inline, `saved` to run a workflow saved in this project, or `path` for a script file on disk (the file a previous result named). Passing more than one is ambiguous.";
const ARGS_WITHOUT_PATH: &str = "`args` belongs to the `path` source: it carries values for the arguments a script file declares in its `/* zcode-workflow` block. For a saved workflow pass `saved.args`; an inline `script` declares no arguments, so it takes none.";

/// The input (Node `CreateWorkflowInputSchema`, as the model sends it). `saved.path` and the other resolved fields are
/// filled in Node's `resolveInput`; they are not model input, so they are not accepted here.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateInput {
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) script: Option<String>,
    #[serde(default)]
    pub(crate) saved: Option<SavedInput>,
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default)]
    pub(crate) args: Option<Value>,
    #[serde(default)]
    pub(crate) max_concurrency: Option<u64>,
    #[serde(default)]
    pub(crate) subagent_model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SavedInput {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) args: Option<Value>,
    #[serde(default, rename = "path")]
    _path: Option<IgnoredAny>,
    #[serde(default)]
    pub(crate) scope: Option<String>,
}

/// Where the script came from. The origin decides the draft (inline and saved get one, a path does not) and the words the
/// model reads about the file.
#[derive(Debug, Clone)]
pub(crate) enum Origin {
    /// Inline text: a draft named after the run (or `workflow`).
    Inline,
    /// A saved definition: a working copy of the file as read. `name` is the saved name (the run label may differ).
    Saved {
        name: String,
        file_text: String,
        path: PathBuf,
        scope: Scope,
    },
    /// A file the model named: the file is the working copy.
    Path { absolute: PathBuf },
}

/// The script that runs, and what the run is told about it (Node's normalized input).
#[derive(Debug, Clone)]
pub(crate) struct Resolved {
    /// The body that runs (a saved or path file without its metadata block).
    pub(crate) script: String,
    /// The run label: the given name, else the saved name.
    pub(crate) name: Option<String>,
    /// The declared arguments, validated and with defaults. Saved sources always pass theirs; a path passes them when
    /// it declares some; an inline script has none.
    pub(crate) args: Option<Map<String, Value>>,
    pub(crate) origin: Origin,
    /// Lines before the body in the file; file line = body line + this.
    pub(crate) body_offset: usize,
}

/// What the permission decision read and checked, kept for the call (keyed by the tool-use id).
#[derive(Debug, Clone)]
pub(crate) struct Prepared {
    pub(crate) resolved: Resolved,
    pub(crate) analysis: WorkflowAnalysis,
    /// The script's `create_workflow` display (the confirmation window's graph, Node `displayOfAnalysis`), read once
    /// for a script that checks. `None` when the helper gave none.
    pub(crate) display: Option<Value>,
    /// Fork (9.61): the input the ask shows, Node's resolved input (`shown_input`). `None` shows the model's input.
    pub(crate) shown: Option<Value>,
}

/// The kept decisions. A full table evicts its oldest entry (never the others), and a taken entry leaves at once.
#[derive(Default)]
struct Approvals {
    by_id: HashMap<ToolUseId, Prepared>,
    order: VecDeque<ToolUseId>,
}

pub struct CreateWorkflowTool {
    contract: &'static Contract,
    analyzer: Arc<dyn WorkflowAnalyzer>,
    /// The run service's per-session ports (9.39, divergence 322): a submit goes through the calling session's port.
    runs: Option<Arc<dyn DynamicWorkflowRunSessions>>,
    home: PathBuf,
    approvals: Mutex<Approvals>,
}

impl CreateWorkflowTool {
    /// The run service's sessions: each call submits through the port of its own session. Without sessions the tool
    /// typechecks and says it did not run.
    pub fn new(
        analyzer: Arc<dyn WorkflowAnalyzer>,
        runs: Option<Arc<dyn DynamicWorkflowRunSessions>>,
        home: PathBuf,
    ) -> Self {
        Self {
            contract: contract(tool_names::CREATE_WORKFLOW),
            analyzer,
            runs,
            home,
            approvals: Mutex::new(Approvals::default()),
        }
    }

    fn approvals(&self) -> std::sync::MutexGuard<'_, Approvals> {
        self.approvals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn remember(&self, tool_use: ToolUseId, prepared: Prepared) {
        let mut approvals = self.approvals();
        if approvals.by_id.insert(tool_use.clone(), prepared).is_none() {
            approvals.order.push_back(tool_use);
        }
        while approvals.order.len() > APPROVAL_CAP {
            if let Some(oldest) = approvals.order.pop_front() {
                approvals.by_id.remove(&oldest);
            }
        }
    }

    /// The display kept for this call's ask, read without taking the decision (the ask is raised before the call).
    fn kept_display(&self, tool_use: &ToolUseId) -> Option<Value> {
        self.approvals()
            .by_id
            .get(tool_use)
            .and_then(|prepared| prepared.display.clone())
    }

    fn take_approval(&self, tool_use: &ToolUseId) -> Option<Prepared> {
        let mut approvals = self.approvals();
        let taken = approvals.by_id.remove(tool_use)?;
        approvals.order.retain(|id| id != tool_use);
        Some(taken)
    }

    /// Drops a decision that will not reach its call (a refused source or checker).
    fn forget(&self, tool_use: &ToolUseId) {
        drop(self.take_approval(tool_use));
    }

    /// `resolve`, off the async executor: it reads the disk (a saved definition, a `path` file, the saved list).
    async fn resolve_off_thread(
        &self,
        input: &CreateInput,
        cwd: &Path,
    ) -> Result<Resolved, String> {
        let home = self.home.clone();
        let input = input.clone();
        let cwd = cwd.to_path_buf();
        tokio::task::spawn_blocking(move || resolve(&home, &input, &cwd))
            .await
            .unwrap_or_else(|error| {
                Err(format!("CreateWorkflow could not read its script: {error}"))
            })
    }
}

/// Node `resolveInput`: the script the call runs, read once. A refusal is returned as its model-facing message.
fn resolve(home: &Path, input: &CreateInput, cwd: &Path) -> Result<Resolved, String> {
    if let Some(path) = &input.path {
        return resolve_path(input, path, cwd);
    }
    if let Some(saved) = &input.saved {
        return resolve_saved(home, input, saved, cwd);
    }
    Ok(Resolved {
        script: input.script.clone().unwrap_or_default(),
        name: input.name.clone(),
        args: None,
        origin: Origin::Inline,
        body_offset: 0,
    })
}

fn resolve_saved(
    home: &Path,
    input: &CreateInput,
    saved: &SavedInput,
    cwd: &Path,
) -> Result<Resolved, String> {
    let store = Store::new(cwd, home);
    let scope = match saved.scope.as_deref() {
        None => None,
        Some(text) => Some(Scope::parse(text).ok_or_else(|| {
            "saved.scope: Invalid enum value. Expected 'project' | 'global'".to_owned()
        })?),
    };
    let found = store
        .resolve(&saved.name, scope)
        .map_err(|refusal| describe_refusal(&saved.name, refusal, &store, scope))?;
    let provided = args_object(saved.args.as_ref())?;
    let declared = found.meta.args.as_deref().unwrap_or(&[]);
    let args = validate_args(declared, &provided).map_err(|errors| {
        let mut lines = vec![format!(
            "The arguments for saved workflow '{}' are not valid:",
            found.name
        )];
        lines.extend(errors.iter().map(|error| format!("- {error}")));
        lines.push(String::new());
        lines.push(describe_declaration(
            &format!("'{}'", found.name),
            found.meta.args.as_deref(),
        ));
        lines.join("\n")
    })?;
    Ok(Resolved {
        script: found.script.clone(),
        name: Some(input.name.clone().unwrap_or_else(|| found.name.clone())),
        args: Some(args),
        origin: Origin::Saved {
            name: found.name.clone(),
            file_text: found.source.clone(),
            path: found.path.clone(),
            scope: found.scope,
        },
        body_offset: found.body_line_offset,
    })
}

/// Node `resolveCreateWorkflowInput` (saved): the input the ask shows carries the run label as `name`, the body as
/// `script`, and the definition's facts as `saved` (its name, the validated and defaulted arguments, its file and scope),
/// with `script_line_offset` when the body does not start the file. Node also names the working copy (`saved.draft`); Rust
/// writes it at the call, so the ask has none (divergence 908). An inline or path source shows the model's input.
fn shown_input(raw: &Value, resolved: &Resolved) -> Option<Value> {
    let Origin::Saved {
        name, path, scope, ..
    } = &resolved.origin
    else {
        return None;
    };
    let mut shown = raw.as_object().cloned().unwrap_or_default();
    shown.insert(
        "name".to_owned(),
        Value::String(resolved.name.clone().unwrap_or_else(|| name.clone())),
    );
    shown.insert("script".to_owned(), Value::String(resolved.script.clone()));
    shown.insert(
        "saved".to_owned(),
        serde_json::json!({
            "name": name,
            "args": resolved.args.clone().unwrap_or_default(),
            "path": path.display().to_string(),
            "scope": scope.as_str(),
        }),
    );
    if resolved.body_offset > 0 {
        shown.insert(
            "script_line_offset".to_owned(),
            Value::from(resolved.body_offset),
        );
    }
    Some(Value::Object(shown))
}

impl CreateWorkflowTool {
    /// Node `writeWorkflowDraft`, best effort: the draft of this call is a new file (never an overwrite), and a write
    /// that fails leaves no draft, so the run starts without a script path.
    async fn write_draft(&self, resolved: &Resolved, cwd: &Path) -> Option<PathBuf> {
        let (name, text) = match &resolved.origin {
            Origin::Inline => (
                resolved
                    .name
                    .clone()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| "workflow".to_owned()),
                resolved.script.clone(),
            ),
            Origin::Saved { file_text, .. } => {
                (resolved.name.clone().unwrap_or_default(), file_text.clone())
            }
            Origin::Path { .. } => return None,
        };
        let dir = cwd.join(DRAFTS_DIR);
        tokio::task::spawn_blocking(move || write_draft_file(&dir, &name, &text))
            .await
            .ok()
            .flatten()
    }

    /// The file the run is told about, and the words for it: a draft is "saved at", a path is "the file is".
    fn location(&self, resolved: &Resolved, draft: Option<&Path>, cwd: &Path) -> Option<Location> {
        let (absolute, path_source) = match &resolved.origin {
            Origin::Inline | Origin::Saved { .. } => (draft?.to_path_buf(), false),
            Origin::Path { absolute } => (absolute.clone(), true),
        };
        Some(Location {
            path_source,
            described: describe_script_path(&absolute, cwd),
            line_offset: resolved.body_offset,
        })
    }
}

/// Where a run's script file is, in the words the model reads (Node `WorkflowScriptLocation`).
pub(crate) struct Location {
    /// A file the model named (`path`), rather than a draft the tool wrote.
    pub(crate) path_source: bool,
    pub(crate) described: String,
    pub(crate) line_offset: usize,
}

fn describe_refusal(
    name: &str,
    refusal: ResolveRefusal,
    store: &Store,
    scope: Option<Scope>,
) -> String {
    match refusal {
        ResolveRefusal::InvalidName => invalid_name_text(name),
        ResolveRefusal::Parse { path, detail } => format!(
            "The saved workflow '{name}' at {} could not be read: {detail}\n\nIts metadata block is malformed — most likely hand-edited. Fix the file, or save the workflow again.",
            path.display()
        ),
        ResolveRefusal::Read { path, detail } => unreadable_text(name, &path, &detail),
        ResolveRefusal::NotFound => {
            let headline = not_found_headline(name, scope);
            let entries = store.list().entries;
            let tagged: Vec<String> = entries
                .iter()
                .map(|entry| format!("{} ({})", entry.name, entry.scope.as_str()))
                .collect();
            let available = if tagged.is_empty() {
                "There are no saved workflows yet, in this project or globally. Use SaveWorkflow to create one, or pass an inline `script` instead.".to_owned()
            } else {
                format!(
                    "Available saved workflows: {}. Use ListSavedWorkflows for their descriptions.",
                    tagged.join(", ")
                )
            };
            format!("{headline}\n\n{available}")
        }
    }
}

/// The `path` source (Node `readWorkflowScriptFile` and `resolvePathSource`): the file is read once, its block is taken
/// as the declaration of its arguments, and nothing is written.
pub(crate) fn resolve_path(
    input: &CreateInput,
    path: &str,
    cwd: &Path,
) -> Result<Resolved, String> {
    let contained = match contain(cwd, path) {
        Ok(contained) => contained,
        Err(Refusal::Outside) => {
            return Err(format!(
                "The workflow script file {path} is outside the workspace. Pass a `path` inside it, or submit the script inline."
            ));
        }
        Err(Refusal::Unresolved(error)) => {
            let described = describe_script_path(&cwd.join(path), cwd);
            return Err(format!(
                "The workflow script file {described} could not be read: {error}. Pass `path` for a file that exists, or submit the script inline."
            ));
        }
    };
    let absolute = contained.named;
    let described = describe_script_path(&absolute, cwd);
    // The file is read at the real path that was checked (the shared containment check).
    let source = read_text(&contained.real).map_err(|error| {
        format!(
            "The workflow script file {described} could not be read: {error}. Pass `path` for a file that exists, or submit the script inline."
        )
    })?;
    let (script, meta, body_offset) = if starts_with_sentinel(&source) {
        match parse_saved(&source) {
            Ok(parsed) => (parsed.script, Some(parsed.meta), parsed.body_line_offset),
            Err(error) => {
                return Err(format!(
                    "The workflow script file {described} starts with a `/* zcode-workflow` metadata block that could not be read ({}): {}. Fix the block in that file, or remove it and pass the script alone.",
                    error.reason(),
                    error.detail()
                ));
            }
        }
    } else {
        (source, None, 0)
    };
    let provided = args_object(input.args.as_ref())?;
    if meta.is_none() && input.args.is_some() {
        return Err(format!(
            "The workflow script file {described} declares no arguments (it has no `/* zcode-workflow` metadata block), so it takes none. Drop `args`, or add a block declaring them."
        ));
    }
    let declared = meta
        .as_ref()
        .and_then(|meta| meta.args.as_deref())
        .unwrap_or(&[]);
    let args = validate_args(declared, &provided).map_err(|errors| {
        let mut lines = vec![format!(
            "The arguments for the workflow script file {described} are not valid:"
        )];
        lines.extend(errors.iter().map(|error| format!("- {error}")));
        lines.push(String::new());
        lines.push(describe_declaration(
            &described,
            meta.as_ref().and_then(|meta| meta.args.as_deref()),
        ));
        lines.join("\n")
    })?;
    Ok(Resolved {
        script,
        name: input.name.clone(),
        args: (!args.is_empty()).then_some(args),
        origin: Origin::Path { absolute },
        body_offset,
    })
}

/// Node `describeWorkflowScriptPath`: relative to the working directory when the file is inside it.
pub(crate) fn describe_script_path(absolute: &Path, cwd: &Path) -> String {
    match absolute.strip_prefix(cwd) {
        Ok(relative) if !relative.as_os_str().is_empty() => relative.display().to_string(),
        _ => absolute.display().to_string(),
    }
}

/// The `args` object, or the schema's refusal of anything else.
pub(crate) fn args_object(value: Option<&Value>) -> Result<Map<String, Value>, String> {
    match value {
        None => Ok(Map::new()),
        Some(Value::Object(object)) => Ok(object.clone()),
        Some(_) => Err("args: Expected object".to_owned()),
    }
}

/// Node `validateWorkflowArgs`: every violation is collected, unknown keys first, then each declared argument in order.
/// Defaults pass through the same type check as supplied values.
pub(crate) fn validate_args(
    declared: &[(String, ArgDecl)],
    provided: &Map<String, Value>,
) -> Result<Map<String, Value>, Vec<String>> {
    let names: Vec<&str> = declared.iter().map(|(name, _)| name.as_str()).collect();
    let mut errors = Vec::new();
    let mut args = Map::new();
    for key in provided.keys() {
        if !names.contains(&key.as_str()) {
            errors.push(if names.is_empty() {
                format!("unknown argument '{key}': this workflow declares no arguments")
            } else {
                format!("unknown argument '{key}' (declared: {})", names.join(", "))
            });
        }
    }
    for (key, spec) in declared {
        match provided.get(key) {
            None => match &spec.default {
                Some(default) => match type_mismatch(key, spec, default, "default value") {
                    None => {
                        args.insert(key.clone(), default.clone());
                    }
                    Some(error) => errors.push(error),
                },
                None if spec.required == Some(true) => {
                    errors.push(format!("missing required argument '{key}'"));
                }
                None => {}
            },
            Some(value) => match type_mismatch(key, spec, value, "value") {
                None => {
                    args.insert(key.clone(), value.clone());
                }
                Some(error) => errors.push(error),
            },
        }
    }
    if errors.is_empty() {
        Ok(args)
    } else {
        Err(errors)
    }
}

/// The message when a value does not have the declared type (`json` accepts anything).
fn type_mismatch(key: &str, spec: &ArgDecl, value: &Value, what: &str) -> Option<String> {
    let (ok, expected) = match spec.ty {
        ArgType::String => (value.is_string(), "a string"),
        ArgType::Number => (value.is_number(), "a finite number"),
        ArgType::Boolean => (value.is_boolean(), "a boolean"),
        ArgType::Json => (true, ""),
    };
    if ok {
        return None;
    }
    let got = match value {
        Value::Null => "null",
        Value::Array(_) => "an array",
        Value::String(_) => "a string",
        Value::Number(_) => "a number",
        Value::Bool(_) => "a boolean",
        Value::Object(_) => "a object",
    };
    Some(format!(
        "argument '{key}': expected {expected}, got {got} ({what})"
    ))
}

/// Node `describeArgsDeclaration`: the declared arguments, for a refusal to read.
pub(crate) fn describe_declaration(label: &str, declared: Option<&[(String, ArgDecl)]>) -> String {
    let Some(declared) = declared.filter(|declared| !declared.is_empty()) else {
        return format!("{label} declares no arguments.");
    };
    let mut lines = vec![format!("{label} declares:")];
    for (key, spec) in declared {
        let mut notes = vec![type_name(spec.ty).to_owned()];
        notes.push(
            if spec.required == Some(true) {
                "required"
            } else {
                "optional"
            }
            .to_owned(),
        );
        if let Some(default) = &spec.default {
            notes.push(format!("default {default}"));
        }
        let description = spec
            .description
            .as_deref()
            .map_or_else(String::new, |text| format!(": {text}"));
        lines.push(format!("- {key} ({}){description}", notes.join(", ")));
    }
    lines.join("\n")
}

fn type_name(ty: ArgType) -> &'static str {
    match ty {
        ArgType::String => "string",
        ArgType::Number => "number",
        ArgType::Boolean => "boolean",
        ArgType::Json => "json",
    }
}

/// Node `draftSlug`: whitespace becomes `-`, characters outside Unicode letters and digits, `_`, `.` and `-` go, the stem is
/// capped and trimmed of its leading and trailing `.` and `-`; nothing usable falls back to `workflow`.
fn draft_slug(name: &str) -> String {
    let collapsed = name.split_whitespace().collect::<Vec<_>>().join("-");
    let kept: String = collapsed
        .chars()
        .filter(|c| c.is_alphabetic() || c.is_numeric() || matches!(c, '_' | '.' | '-'))
        .take(DRAFT_SLUG_CHARS)
        .collect();
    let trimmed = kept.trim_matches(|c| c == '.' || c == '-');
    if trimmed.is_empty() {
        "workflow".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// Node `writeWorkflowDraft`: the draft directory (with its own `.gitignore`, written once), then the first free name.
/// `None` when the directory cannot be made or the claim fails.
pub(crate) fn write_draft_file(dir: &Path, name: &str, text: &str) -> Option<PathBuf> {
    ensure_dir(dir).ok()?;
    match create_new_text(&dir.join(".gitignore"), "*\n") {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return None,
    }
    let slug = draft_slug(name);
    for attempt in 1..=DRAFT_ATTEMPTS {
        let stem = if attempt == 1 {
            slug.clone()
        } else {
            format!("{slug}-{attempt}")
        };
        let path = dir.join(format!("{stem}{FILE_EXTENSION}"));
        match create_new_text(&path, text) {
            Ok(()) => return Some(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

/// Node `describeWorkflowConcurrencyLimit`: one sentence when a limit is set, marked when it equals the default.
pub(crate) fn concurrency_sentence(limit: Option<u64>, default: Option<usize>) -> String {
    let Some(limit) = limit else {
        return String::new();
    };
    let subject = if limit == 1 {
        "1 subagent runs".to_owned()
    } else {
        format!("{limit} subagents run")
    };
    let marker = if default.is_some_and(|default| default as u64 == limit) {
        " (the default)"
    } else {
        ""
    };
    format!(" At most {subject} at once{marker}.")
}

/// Node `prepareCreateWorkflowApproval` and the handler's `ok` path: the confirmation names the run.
pub(crate) fn confirmation_message(name: Option<&str>) -> String {
    match name {
        Some(name) => format!("Run workflow '{name}' in the background"),
        None => "Run the workflow script in the background".to_owned(),
    }
}

pub(crate) fn diagnostic_lines(
    diagnostics: &[WorkflowDiagnostic],
    location: Option<&Location>,
) -> Vec<String> {
    diagnostics
        .iter()
        .map(|diagnostic| match location {
            None => format!(
                "L{}:C{} {}",
                diagnostic.line, diagnostic.column, diagnostic.message
            ),
            Some(location) => format!(
                "{}:L{}:C{} {}",
                location.described,
                diagnostic.line + location.line_offset as i64,
                diagnostic.column,
                diagnostic.message
            ),
        })
        .collect()
}

/// Node `diagnosticsNote`: the sentence that tells the model where to edit, and that it must not paste the script again.
pub(crate) fn diagnostics_note(
    resolved: &Resolved,
    location: Option<&Location>,
    cwd: &Path,
) -> String {
    let Some(location) = location else {
        return match resolved.origin {
            Origin::Saved { .. } => "NOTE: The workflow was NOT executed — the saved file needs fixing (edit it, or save a corrected version).".to_owned(),
            _ => DIAGNOSTICS_NOT_EXECUTED_NOTE.to_owned(),
        };
    };
    if let Origin::Saved { name, path, .. } = &resolved.origin {
        let saved_name = name.clone();
        return format!(
            "NOTE: The workflow was NOT executed. A working copy of the saved workflow '{}' ({}) was written to {}. Edit that copy in place and resubmit with `path: \"{}\"` (pass its `args` again); to change the saved definition itself, use SaveWorkflow.",
            saved_name,
            describe_script_path(path, cwd),
            location.described,
            location.described
        );
    }
    let where_ = if location.path_source {
        format!("The script file is {}.", location.described)
    } else {
        format!("The script is saved at {}.", location.described)
    };
    format!(
        "NOTE: The workflow was NOT executed. {where_} Edit that file in place and resubmit with `path: \"{}\"` — do not paste the script inline again.",
        location.described
    )
}

/// Node `createWorkflowPhaseNames` and `createWorkflowPhaseAlongside` over the window graph's `phases`: the named phases in
/// declaration order (capped at Node's `CREATE_WORKFLOW_GRAPH_MAX_PHASES`), and for each the indexes of the named phases
/// that run alongside it. Each is absent when the graph names no phase, or no phase runs alongside another.
pub(crate) fn phase_table(
    display: Option<&Value>,
) -> (Option<Vec<String>>, Option<Vec<Vec<usize>>>) {
    const MAX_PHASES: usize = 32;
    let Some(phases) = display
        .and_then(|display| display.get("causalityGraph"))
        .and_then(|graph| graph.get("phases"))
        .and_then(Value::as_array)
    else {
        return (None, None);
    };
    let named: Vec<&Value> = phases
        .iter()
        .filter(|phase| phase.get("name").and_then(Value::as_str).is_some())
        .take(MAX_PHASES)
        .collect();
    if named.is_empty() {
        return (None, None);
    }
    let names: Vec<String> = named
        .iter()
        .filter_map(|phase| phase.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    let index_of: std::collections::HashMap<&str, usize> = named
        .iter()
        .enumerate()
        .filter_map(|(index, phase)| {
            phase
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id, index))
        })
        .collect();
    let mut any = false;
    let alongside: Vec<Vec<usize>> = named
        .iter()
        .enumerate()
        .map(|(own, phase)| {
            let mut indexes: Vec<usize> = Vec::new();
            for id in phase
                .get("alongside")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if let Some(&index) = index_of.get(id)
                    && index != own
                    && !indexes.contains(&index)
                {
                    indexes.push(index);
                }
            }
            any = any || !indexes.is_empty();
            indexes
        })
        .collect();
    (Some(names), any.then_some(alongside))
}

pub(crate) fn output_for(text_body: String, display: Value) -> ToolOutput {
    let mut output = text(text_body);
    output.display = display;
    output
}

#[async_trait]
impl Tool for CreateWorkflowTool {
    fn name(&self) -> &str {
        tool_names::CREATE_WORKFLOW
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

    /// Starts a run and writes drafts (Node `readOnly: false`), and may be run side by side (Node `concurrentSafe: true`).
    /// Node `askOptions.allowAlways: "session"`: the ask offers "Always allow in this session" (the session actor grants it).
    fn ask_display(&self, tool_use: &ToolUseId) -> Option<Value> {
        self.kept_display(tool_use)
    }

    fn ask_input(&self, tool_use: &ToolUseId) -> Option<Value> {
        self.approvals()
            .by_id
            .get(tool_use)
            .and_then(|prepared| prepared.shown.clone())
    }

    fn allow_session(&self) -> bool {
        true
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
        Some(CREATE_MODEL_BYTES)
    }

    /// The input's shape, the source rules, the Skill gate and `subagent_model`. No disk access.
    async fn validate_input(&self, input: &Value, context: &ToolUseContext) -> Validation {
        let input: CreateInput = match serde_json::from_value(input.clone()) {
            Ok(input) => input,
            Err(error) => {
                return Validation::Invalid {
                    message: error.to_string(),
                    error_code: None,
                };
            }
        };
        if input.name.as_deref() == Some("") {
            return invalid(None, "name: String must contain at least 1 character(s)");
        }
        if input.path.as_deref() == Some("") {
            return invalid(None, "path: String must contain at least 1 character(s)");
        }
        if input.max_concurrency == Some(0) {
            return invalid(None, "max_concurrency: Number must be greater than 0");
        }
        if input.subagent_model.as_deref() == Some("") {
            return invalid(
                None,
                "subagent_model: String must contain at least 1 character(s)",
            );
        }
        if let Some(saved) = &input.saved {
            let length = saved.name.chars().count();
            if !(1..=64).contains(&length) {
                return invalid(None, "saved.name: String must be 1 to 64 characters");
            }
            if saved
                .scope
                .as_deref()
                .is_some_and(|scope| Scope::parse(scope).is_none())
            {
                return invalid(
                    None,
                    "saved.scope: Invalid enum value. Expected 'project' | 'global'",
                );
            }
        }
        if let Err(message) = args_object(input.args.as_ref()) {
            return invalid(None, &message);
        }
        let sources = [
            input.script.is_some(),
            input.saved.is_some(),
            input.path.is_some(),
        ]
        .iter()
        .filter(|present| **present)
        .count();
        if sources == 0 {
            return invalid(Some(FAILURE_CODE), MISSING_SOURCE);
        }
        if sources > 1 {
            return invalid(Some(FAILURE_CODE), CONFLICTING_SOURCES);
        }
        if input.args.is_some() && input.path.is_none() {
            return invalid(Some(FAILURE_CODE), ARGS_WITHOUT_PATH);
        }
        let saved_only = input.saved.is_some();
        if !saved_only && !skill_loaded(context).await {
            return Validation::Invalid {
                message: format!(
                    "CreateWorkflow needs the `{DYNAMIC_WORKFLOW_SKILL}` skill loaded in this session before it accepts a script. Call the Skill tool with skill \"{DYNAMIC_WORKFLOW_SKILL}\" first — it carries the facade declarations the script is checked against, the authoring rules and this tool's full contract — then call CreateWorkflow again. Nothing was started."
                ),
                error_code: Some(SKILL_NOT_LOADED_CODE),
            };
        }
        if input.subagent_model.is_some() {
            return invalid(Some(FAILURE_CODE), SUBAGENT_MODEL_UNAVAILABLE);
        }
        Validation::Ok
    }

    /// Node `prepareCreateWorkflowApproval`: the source is read and checked here. A script that checks asks, always,
    /// with no always-allow except this session's own rule; the read bytes are kept for the call. A script that does not
    /// check proceeds, so the call can report its diagnostics without a confirmation.
    async fn check_permissions(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> PermissionDecision {
        let raw = input;
        let Ok(input) = serde_json::from_value::<CreateInput>(input.clone()) else {
            return PermissionDecision::Passthrough;
        };
        let cwd = PathBuf::from(workspace_dir(context));
        let Ok(resolved) = self.resolve_off_thread(&input, &cwd).await else {
            // The call refuses with the same message; nothing is asked about.
            self.forget(&context.tool_use);
            return PermissionDecision::Allow {
                updated_input: None,
            };
        };
        let analysis = match self.analyzer.analyze(&resolved.script).await {
            Ok(analysis) => analysis,
            Err(error) => {
                self.forget(&context.tool_use);
                return PermissionDecision::Deny {
                    message: error.message,
                };
            }
        };
        let checks = analysis.ok;
        let name = resolved.name.clone();
        // A display the helper cannot give leaves the window without a graph; it never blocks the ask.
        let display = if checks {
            self.analyzer.display(&resolved.script).await.ok().flatten()
        } else {
            None
        };
        let shown = shown_input(raw, &resolved);
        self.remember(
            context.tool_use.clone(),
            Prepared {
                resolved,
                analysis,
                display,
                shown,
            },
        );
        if !checks {
            return PermissionDecision::Allow {
                updated_input: None,
            };
        }
        PermissionDecision::always_ask(
            confirmation_message(name.as_deref()),
            vec![PermissionRule {
                tool: tool_names::CREATE_WORKFLOW.to_owned(),
                content: None,
            }],
            false,
        )
    }

    /// Writes the draft of the approved bytes and starts the run. A script that does not check gets its diagnostics
    /// and no run. Without an approval for a script that checks, nothing starts.
    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let input: CreateInput =
            serde_json::from_value(input).map_err(|error| ToolError::InvalidInput {
                message: error.to_string(),
            })?;
        let cwd = PathBuf::from(workspace_dir(&context));
        let prepared = match self.take_approval(&context.tool_use) {
            Some(prepared) => prepared,
            None => {
                let resolved = self
                    .resolve_off_thread(&input, &cwd)
                    .await
                    .map_err(failed)?;
                let analysis = self
                    .analyzer
                    .analyze(&resolved.script)
                    .await
                    .map_err(|error| failed(error.message))?;
                if analysis.ok {
                    return Err(failed(
                        "CreateWorkflow has no confirmation for this script, so nothing was started. Call it again.".to_owned(),
                    ));
                }
                Prepared {
                    resolved,
                    analysis,
                    display: None,
                    shown: None,
                }
            }
        };
        let Prepared {
            resolved,
            analysis,
            display,
            ..
        } = prepared;
        let draft = self.write_draft(&resolved, &cwd).await;
        let location = self.location(&resolved, draft.as_deref(), &cwd);
        if !analysis.ok {
            let lines = diagnostic_lines(&analysis.diagnostics, location.as_ref());
            let mut body = Vec::new();
            body.push(match &resolved.origin {
                Origin::Saved { name, path, .. } => format!(
                    "The saved workflow '{}' ({}) has errors:",
                    name,
                    path.display()
                ),
                _ => "The workflow script has errors:".to_owned(),
            });
            body.extend(lines);
            body.push(String::new());
            body.push(diagnostics_note(&resolved, location.as_ref(), &cwd));
            return Ok(output_for(
                body.join("\n"),
                crate::workflow_card::card(None, false, &analysis.diagnostics),
            ));
        }
        let Some(port) = self
            .runs
            .as_ref()
            .map(|runs| runs.for_session(&context.session))
        else {
            return Ok(output_for(
                format!("The workflow script compiled cleanly.\n\n{EXECUTION_UNAVAILABLE_NOTE}"),
                crate::workflow_card::card(graph_of(display.as_ref()), true, &[]),
            ));
        };
        let script_path = match &resolved.origin {
            Origin::Path { absolute } => Some(absolute.display().to_string()),
            _ => draft.as_ref().map(|path| path.display().to_string()),
        };
        let (phase_names, phase_alongside) = phase_table(display.as_ref());
        let request = SubmitRequest {
            script_text: resolved.script.clone(),
            cwd: cwd.display().to_string(),
            name: resolved.name.clone(),
            args: resolved.args.clone(),
            parent_session_id: Some(context.session.clone()),
            tool_call_id: Some(context.tool_use.to_string()),
            max_concurrency: input.max_concurrency,
            script_path,
            phase_names,
            phase_alongside,
        };
        let run_id = port
            .submit(request)
            .await
            .map_err(|error| failed(error.message))?;
        let settings = concurrency_sentence(input.max_concurrency, port.default_concurrency());
        let where_ = match &location {
            None => String::new(),
            Some(location) if location.path_source => format!(
                " The script file is {}; to revise it later, edit that file and pass `path` to AmendWorkflow.",
                location.described
            ),
            Some(location) => format!(
                " The script is saved at {}; to revise it later, edit that file and pass `path` to AmendWorkflow.",
                location.described
            ),
        };
        let run_id = run_id.to_string();
        // The result card carries the script's graph, so the run card can find it by the call id. The run id travels in
        // the text and the run projection, never on the card (crate::workflow_card).
        let card = crate::workflow_card::card(graph_of(display.as_ref()), true, &[]);
        Ok(output_for(
            format!(
                "The workflow script compiled cleanly and the run started in the background with ID: {run_id}. It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.{settings}{where_}"
            ),
            card,
        ))
    }
}

/// The causality graph of the analyzer's window display, when it drew one.
fn graph_of(display: Option<&Value>) -> Option<&Value> {
    display.and_then(|display| display.get("causalityGraph"))
}

fn invalid(code: Option<i32>, message: &str) -> Validation {
    Validation::Invalid {
        message: message.to_owned(),
        error_code: code,
    }
}

#[cfg(test)]
#[path = "workflow_create_tests.rs"]
mod tests;
