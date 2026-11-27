//! Fork: the desktop agent's off-peak tools, OffPeakCreate and OffPeakList (Node `core/src/tool/handlers/off-peak.ts`
//! with the port of `bootstrap/src/zcode-protocol/offpeak-port.ts`; specs/fork-rust-automations.md, slice 3).
//!
//! The tasks live in the desktop Host's store, reached through [`OffPeakPort`]; nothing is queued in this process. The
//! provider contracts (name, description, input schema) are generated from Node's TypeScript
//! (`scripts/fork-rust-agent/off-peak-tools.mts`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::incognito::IncognitoToolGate;
use rust_cli_kernel_api::mcp_state::McpConnections;
use rust_cli_kernel_api::off_peak::{self as port, OffPeakError, OffPeakPort};
use rust_cli_kernel_api::orchestration::{ToolRegistry, ToolSnapshot};
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation,
    answers_to, failed, invalid, parse,
};
use rust_cli_kernel_api::tool_names;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

const CONTRACTS: &str = rust_cli_base::include_lf!("../assets/node_off_peak_tools.json");

/// Node `OFF_PEAK_TOOL_TIMEOUT_MS`: the whole call (the bound check and the create) may take this long.
const TIMEOUT: Duration = Duration::from_secs(30);
/// Node `OFF_PEAK_MODEL_BYTES`.
const RESULT_CHARS: usize = 32_000;
const PERMISSION_MODES: [&str; 5] = ["build", "edit", "plan", "yolo", "guarded"];
/// Node `OFF_PEAK_TERMINAL_STATUSES`: a task in one of these no longer holds its session.
const TERMINAL_STATUSES: [&str; 3] = ["completed", "failed", "cancelled"];
/// The task fields the model and the UI see (Node `OffPeakTaskSummarySchema`; the Host's ticket and provider fields
/// stay out).
const TASK_FIELDS: [&str; 6] = [
    "offPeakTaskId",
    "title",
    "status",
    "queuePosition",
    "sessionId",
    "createdAt",
];

pub const IN_BOUND_SESSION: &str = "This session already has a pending idle-time task. Wait for it to finish (or cancel it in Automations) before creating another one here.";
pub const BOUND_SESSION_CHECK_FAILED: &str =
    "Cannot verify whether this session already has a pending idle-time task; try again later.";

/// One generated provider contract.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    name: String,
    description: String,
    search_hint: Option<String>,
    read_only: bool,
    destructive: bool,
    concurrent_safe: bool,
    needs_approval: bool,
    should_defer: bool,
    input_schema: Value,
}

fn contracts() -> &'static [Contract] {
    static CONTRACTS_PARSED: OnceLock<Vec<Contract>> = OnceLock::new();
    CONTRACTS_PARSED.get_or_init(|| {
        serde_json::from_str(CONTRACTS)
            .unwrap_or_else(|error| unreachable!("the off-peak tool contracts parse: {error}"))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Create,
    List,
}

impl Kind {
    fn of(name: &str) -> Option<Self> {
        Some(match name {
            tool_names::OFF_PEAK_CREATE => Self::Create,
            tool_names::OFF_PEAK_LIST => Self::List,
            _ => return None,
        })
    }
}

/// The two tools in the contract file's order (Node's registration order), all sending to `port`.
pub fn off_peak_tools(port: Arc<dyn OffPeakPort>) -> Vec<Arc<dyn Tool>> {
    contracts()
        .iter()
        .filter_map(|contract| {
            let kind = Kind::of(&contract.name)?;
            let tool: Arc<dyn Tool> = Arc::new(OffPeakTool {
                contract: contract.clone(),
                kind,
                port: port.clone(),
            });
            Some(tool)
        })
        .collect()
}

pub struct OffPeakTool {
    contract: Contract,
    kind: Kind,
    port: Arc<dyn OffPeakPort>,
}

/// An optional field that may be absent but not `null` (zod `.optional()` without `.nullable()`).
fn not_null<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    title: String,
    prompt: String,
    #[serde(default, deserialize_with = "not_null")]
    permission_mode: Option<String>,
    #[serde(default, deserialize_with = "not_null")]
    model: Option<String>,
    #[serde(default, deserialize_with = "not_null")]
    thought_level: Option<String>,
}

/// zod `z.string().trim().min(1)`: the trimmed value, or the field's error.
fn non_empty(field: &str, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!(
            "{field}: String must contain at least 1 character(s)"
        ));
    }
    Ok(trimmed.to_owned())
}

fn optional_non_empty(field: &str, value: Option<&String>) -> Result<Option<String>, String> {
    value.map(|value| non_empty(field, value)).transpose()
}

/// The OffPeakCreate input after Node's `OffPeakCreateInputSchema` (trimmed strings, the permission enum).
#[derive(Debug, PartialEq)]
struct Create {
    title: String,
    prompt: String,
    permission_mode: Option<String>,
    model: Option<String>,
    thought_level: Option<String>,
}

fn create_input(input: &Value) -> Result<Create, String> {
    let raw: CreateInput = parse(input).map_err(|error| error.to_string())?;
    let title = non_empty("title", &raw.title)?;
    let prompt = non_empty("prompt", &raw.prompt)?;
    if let Some(mode) = raw.permission_mode.as_deref()
        && !PERMISSION_MODES.contains(&mode)
    {
        return Err(format!("permissionMode: Invalid enum value '{mode}'"));
    }
    Ok(Create {
        title,
        prompt,
        permission_mode: raw.permission_mode,
        model: optional_non_empty("model", raw.model.as_ref())?,
        thought_level: optional_non_empty("thoughtLevel", raw.thought_level.as_ref())?,
    })
}

/// Node `OffPeakListInputSchema` is `z.object({}).strict()`. serde's `deny_unknown_fields` does not reject keys on an
/// empty struct, so the object is checked by hand.
fn list_input(input: &Value) -> Result<(), String> {
    match input.as_object() {
        Some(object) => match object.keys().next() {
            Some(key) => Err(format!("Unrecognized key: \"{key}\"")),
            None => Ok(()),
        },
        None => Err("Expected object, received a non-object value".to_owned()),
    }
}

/// Node `assertNotOffPeakTurn`: the turn's own limits hide OffPeakCreate on a run dispatched by an off-peak task.
fn refuse_off_peak_turn(name: &str) -> ToolError {
    failed(format!(
        "{name} is not allowed while running an idle-time task."
    ))
}

/// Node `throwOffPeakCreateFailure`: the business failure the Host classified, worded for the model by category.
fn create_failure(outcome: &Value) -> String {
    let code = outcome["errorCode"].as_str().unwrap_or_default();
    match outcome["errorCategory"].as_str().unwrap_or_default() {
        "quota_3103" => "The idle-time task quota is used up for now. Tell the user the free quota is exhausted and they can retry later or review tasks in Automations.".to_owned(),
        "eligibility_3101" => "The current account has no eligible Coding Plan connection for idle-time tasks. Tell the user to select a ZAI/BigModel Coding Plan connection first.".to_owned(),
        "client_validation" => match code {
            "model_not_allowed" => "The requested model is not in the idle-time allowed model list. Omit the model field to use the default allowed model.".to_owned(),
            "session_bound" => "This session already has a pending idle-time task. Tell the user to wait for it to finish or cancel it in Automations before creating another one here.".to_owned(),
            "offpeak_disabled" => "Idle-time tasks are not enabled for this account right now. Tell the user the feature is unavailable; do not retry with different parameters.".to_owned(),
            _ => "The idle-time task input was rejected by validation.".to_owned(),
        },
        "network" => "The idle-time ticket service is unreachable. Tell the user to retry later.".to_owned(),
        _ => "Creating the idle-time task failed. Tell the user to retry from the Automations page.".to_owned(),
    }
}

/// The task as the model sees it: only the summary fields the Host sent.
fn summary(task: &Value) -> Value {
    let mut out = Map::new();
    for field in TASK_FIELDS {
        if let Some(value) = task.get(field).filter(|value| !value.is_null()) {
            out.insert(field.to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

fn host_error(error: OffPeakError) -> ToolError {
    failed(error.message)
}

fn json_output(value: &Value) -> ToolOutput {
    rust_cli_kernel_api::tool::text(value.to_string())
}

impl OffPeakTool {
    async fn request(
        &self,
        owner: &SessionId,
        method: &str,
        params: Value,
    ) -> Result<Value, OffPeakError> {
        self.port.request(owner, method, params).await
    }

    /// Whether `owner` already has a task that has not finished (Node `createProtocolOffPeakPort`: the bound check
    /// reads `offPeak/list`, and any failure is "cannot verify", never "unbound").
    async fn bound(&self, owner: &SessionId) -> Result<bool, ToolError> {
        let listed = self
            .request(owner, port::LIST, json!({}))
            .await
            .map_err(|error| {
                tracing::warn!(
                    session = owner.as_str(),
                    error = %error,
                    "failed to check bound off-peak tasks before OffPeakCreate"
                );
                failed(BOUND_SESSION_CHECK_FAILED.to_owned())
            })?;
        Ok(listed["tasks"].as_array().is_some_and(|tasks| {
            tasks.iter().any(|task| {
                task["sessionId"] == owner.as_str()
                    && !TERMINAL_STATUSES.contains(&task["status"].as_str().unwrap_or_default())
            })
        }))
    }

    async fn create(&self, input: &Value, owner: &SessionId) -> Result<ToolOutput, ToolError> {
        let fields = create_input(input).map_err(|message| ToolError::InvalidInput { message })?;
        if self.bound(owner).await? {
            return Err(failed(IN_BOUND_SESSION.to_owned()));
        }
        let mut params = Map::new();
        params.insert("title".into(), json!(fields.title));
        params.insert("prompt".into(), json!(fields.prompt));
        if let Some(mode) = fields.permission_mode {
            params.insert("permissionMode".into(), json!(mode));
        }
        if let Some(model) = fields.model {
            params.insert("model".into(), json!(model));
        }
        if let Some(level) = fields.thought_level {
            params.insert("thoughtLevel".into(), json!(level));
        }
        params.insert("boundSessionId".into(), json!(owner.as_str()));
        let reply = self
            .request(owner, port::CREATE, Value::Object(params))
            .await
            .map_err(host_error)?;
        if reply["ok"] != true {
            return Err(failed(create_failure(&reply)));
        }
        let task = summary(&reply["task"]);
        let id = task["offPeakTaskId"].as_str().unwrap_or_default();
        let message = match task["queuePosition"].as_i64() {
            Some(position) => format!("Created idle-time task {id} (#{position} in queue)."),
            None => format!("Created idle-time task {id}."),
        };
        Ok(json_output(&json!({"task": task, "message": message})))
    }

    async fn list(&self, owner: &SessionId) -> Result<ToolOutput, ToolError> {
        let reply = self
            .request(owner, port::LIST, json!({}))
            .await
            .map_err(host_error)?;
        let tasks: Vec<Value> = reply["tasks"]
            .as_array()
            .map(|tasks| tasks.iter().map(summary).collect())
            .unwrap_or_default();
        Ok(json_output(&json!({"tasks": tasks})))
    }

    async fn dispatch(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> Result<ToolOutput, ToolError> {
        // The limits decide the refusal. Without the session view a create cannot tell an off-peak run apart, so it
        // fails closed.
        if self.kind == Kind::Create {
            let Some(view) = context.session_ops.view().await else {
                return Err(failed("Session state is unavailable.".to_owned()));
            };
            if view.turn.hides(&self.contract.name) {
                return Err(refuse_off_peak_turn(&self.contract.name));
            }
        }
        let owner = context.session_ops.owner_session(&context.session).await;
        match self.kind {
            Kind::Create => self.create(input, &owner).await,
            Kind::List => {
                list_input(input).map_err(|message| ToolError::InvalidInput { message })?;
                self.list(&owner).await
            }
        }
    }
}

#[async_trait]
impl Tool for OffPeakTool {
    fn name(&self) -> &str {
        &self.contract.name
    }

    fn input_schema(&self) -> Value {
        self.contract.input_schema.clone()
    }

    fn description(&self, _context: &PromptContext) -> String {
        self.contract.description.clone()
    }

    /// Node marks both tools `shouldDefer: true`.
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

    fn max_result_size_chars(&self) -> Option<usize> {
        Some(RESULT_CHARS)
    }

    async fn validate_input(&self, input: &Value, context: &ToolUseContext) -> Validation {
        // Node refuses OffPeakCreate on an off-peak turn before it parses the input (`assertNotOffPeakTurn` first):
        // leave the checks to `call`, whose dispatch refuses before any parse.
        if self.kind == Kind::Create
            && context
                .session_ops
                .view()
                .await
                .is_some_and(|view| view.turn.hides(&self.contract.name))
        {
            return Validation::Ok;
        }
        let checked = match self.kind {
            Kind::Create => create_input(input).map(drop),
            Kind::List => list_input(input),
        };
        match checked {
            Ok(()) => Validation::Ok,
            Err(message) => invalid(message),
        }
    }

    /// Node `needsApproval`: OffPeakCreate goes through the usual ask; OffPeakList is allowed.
    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        if self.contract.needs_approval {
            return PermissionDecision::Passthrough;
        }
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
        tokio::time::timeout(TIMEOUT, self.dispatch(&input, &context))
            .await
            .unwrap_or_else(|_| {
                Err(failed(format!(
                    "Tool execution timed out after {}ms",
                    TIMEOUT.as_millis()
                )))
            })
    }
}

/// The registry layer that owns the off-peak tools' visibility (specs/fork-rust-session-context-gaps.md, item 4): a
/// session's snapshot has them, and `find_for` resolves them, only when the port offers them to that session and its
/// incognito profile keeps the automation tools. Node injects `offPeakPort` once, when the session's runtime is
/// created, so the port's answer is read on the session's first lookup and kept. Lookups without a session never see
/// the tools.
/// The per-session decisions of [`OffPeakTools`]. A session close drops the session's entry, so a session resumed
/// afterwards (a new runtime in Node) decides again.
#[derive(Default)]
pub struct OffPeakDecisions(Mutex<HashMap<SessionId, bool>>);

impl OffPeakDecisions {
    pub fn forget(&self, session: &SessionId) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session);
    }
}

pub struct OffPeakTools {
    inner: Arc<dyn ToolRegistry>,
    tools: Vec<Arc<dyn Tool>>,
    port: Arc<dyn OffPeakPort>,
    incognito: Arc<dyn IncognitoToolGate>,
    decided: Arc<OffPeakDecisions>,
}

impl OffPeakTools {
    pub fn new(
        inner: Arc<dyn ToolRegistry>,
        port: Arc<dyn OffPeakPort>,
        incognito: Arc<dyn IncognitoToolGate>,
        decided: Arc<OffPeakDecisions>,
    ) -> Self {
        Self {
            inner,
            tools: off_peak_tools(port.clone()),
            port,
            incognito,
            decided,
        }
    }

    fn named(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools
            .iter()
            .find(|tool| answers_to(tool.as_ref(), name))
    }

    /// The port's answer for `session`, asked once.
    fn enabled(&self, session: &SessionId) -> bool {
        *self
            .decided
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(session.clone())
            .or_insert_with(|| self.port.tools_enabled(session))
    }

    fn offered(&self, session: &SessionId, tool: &dyn Tool) -> bool {
        self.enabled(session) && !self.incognito.hides(session, tool)
    }
}

impl ToolRegistry for OffPeakTools {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.inner.tools()
    }

    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.inner.find(name)
    }

    fn find_for(&self, session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        if let Some(tool) = self.named(name) {
            return self.offered(session, tool.as_ref()).then(|| tool.clone());
        }
        self.inner.find_for(session, name)
    }

    /// Hidden means not offered, never "withheld for a fallback".
    fn withheld(&self, name: &str) -> Option<Arc<dyn Tool>> {
        if self.named(name).is_some() {
            return None;
        }
        self.inner.withheld(name)
    }

    fn hides(&self, name: &str) -> bool {
        self.inner.hides(name)
    }

    fn keeps_order(&self) -> bool {
        self.inner.keeps_order()
    }

    fn snapshot(&self, session: &SessionId) -> ToolSnapshot {
        let mut snapshot = self.inner.snapshot(session);
        snapshot.tools.extend(
            self.tools
                .iter()
                .filter(|tool| self.offered(session, tool.as_ref()))
                .cloned(),
        );
        snapshot
    }

    fn mcp(&self) -> Option<Arc<dyn McpConnections>> {
        self.inner.mcp()
    }

    fn mcp_for(&self, session: &SessionId) -> Option<Arc<dyn McpConnections>> {
        self.inner.mcp_for(session)
    }
}

#[cfg(test)]
#[path = "off_peak_tools_tests.rs"]
mod tests;
