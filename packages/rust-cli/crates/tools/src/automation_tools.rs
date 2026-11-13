//! Fork: the desktop agent's Cron tools (Node `core/src/tool/handlers/cron.ts` with the param mapping of
//! `bootstrap/src/zcode-protocol/automation-port.ts`; specs/fork-rust-automations.md, slice 2).
//!
//! Schedules live in the desktop Host's automation store, reached through [`AutomationPort`]; nothing is scheduled
//! in this process. The provider contracts (name, description, input schema) are generated from Node's TypeScript
//! (`scripts/fork-rust-agent/automation-tools.mts`); the input rules below are Node's zod refinements.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_kernel_api::automation::{self as port, AutomationError, AutomationPort};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::{PermissionDecision, PermissionMode};
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation, failed,
    invalid, parse,
};
use rust_cli_kernel_api::tool_names;
use rust_cli_kernel_api::turn_limits::TurnLimits;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

const CONTRACTS: &str = rust_cli_base::include_lf!("../assets/node_automation_tools.json");

/// Node `CRON_TOOL_TIMEOUT_MS`: the whole tool call (every Host request it sends) may take this long.
const TIMEOUT: Duration = Duration::from_secs(30);
/// Node `CRON_MODEL_BYTES`.
const RESULT_CHARS: usize = 32_000;
/// Node `delayMinutes` maximum (one year).
const MAX_DELAY_MINUTES: i64 = 525_600;
const INTERVAL_RANGE: std::ops::RangeInclusive<i64> = 1..=200;
const INTERVAL_UNITS: [&str; 6] = ["minute", "hourly", "daily", "weekly", "monthly", "yearly"];

pub const CREATE_IN_BOUND_SESSION: &str = "Cannot create a scheduled task inside a session that already belongs to a scheduled task. Ask the user to start a new chat to create another scheduled task.";
pub const BOUND_SESSION_CHECK_FAILED: &str =
    "Cannot verify whether this session belongs to a scheduled task. Try again later.";
const PAUSE_SELF_OUTSIDE_RUN: &str =
    "CronPauseSelf is only available while running a scheduled automation.";
/// The automation fields the model sees (Node `toModelAutomation`: no model selection, mode or target).
const MODEL_FIELDS: [&str; 12] = [
    "automationId",
    "title",
    "cronExpr",
    "prompt",
    "enabled",
    "lifecycleStatus",
    "nextRunAt",
    "lastRunAt",
    "runCount",
    "recurring",
    "maxRuns",
    "scheduleRule",
];

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
    input_schema: Value,
}

fn contracts() -> &'static [Contract] {
    static CONTRACTS_PARSED: OnceLock<Vec<Contract>> = OnceLock::new();
    CONTRACTS_PARSED.get_or_init(|| {
        serde_json::from_str(CONTRACTS)
            .unwrap_or_else(|error| unreachable!("the automation tool contracts parse: {error}"))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Create,
    List,
    Update,
    Delete,
    PauseSelf,
}

impl Kind {
    fn of(name: &str) -> Option<Self> {
        Some(match name {
            tool_names::CRON_CREATE => Self::Create,
            tool_names::CRON_LIST => Self::List,
            tool_names::CRON_UPDATE => Self::Update,
            tool_names::CRON_DELETE => Self::Delete,
            tool_names::CRON_PAUSE_SELF => Self::PauseSelf,
            _ => return None,
        })
    }
}

/// The five tools in the contract file's order (Node's registration order), all sending to `port`.
pub fn automation_tools(port: Arc<dyn AutomationPort>) -> Vec<Arc<dyn Tool>> {
    contracts()
        .iter()
        .filter_map(|contract| {
            let kind = Kind::of(&contract.name)?;
            let tool: Arc<dyn Tool> = Arc::new(AutomationTool {
                contract: contract.clone(),
                kind,
                port: port.clone(),
            });
            Some(tool)
        })
        .collect()
}

pub struct AutomationTool {
    contract: Contract,
    kind: Kind,
    port: Arc<dyn AutomationPort>,
}

/// `null` and absent differ (`maxRuns: null` clears the limit).
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
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
    #[serde(default, deserialize_with = "not_null")]
    cron: Option<String>,
    /// `null` is the same as absent (Node `hasRelativeDelayMinutes`: only a number is a relative delay).
    delay_minutes: Option<i64>,
    prompt: String,
    title: String,
    #[serde(default, deserialize_with = "not_null")]
    recurring: Option<bool>,
    #[serde(default, deserialize_with = "not_null")]
    max_runs: Option<i64>,
    #[serde(default, deserialize_with = "not_null")]
    interval_unit: Option<String>,
    #[serde(default, deserialize_with = "not_null")]
    interval: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateInput {
    id: String,
    #[serde(default, deserialize_with = "not_null")]
    cron: Option<String>,
    #[serde(default, deserialize_with = "not_null")]
    prompt: Option<String>,
    title: String,
    #[serde(default, deserialize_with = "not_null")]
    recurring: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    max_runs: Option<Option<i64>>,
    #[serde(default, deserialize_with = "not_null")]
    interval_unit: Option<String>,
    #[serde(default, deserialize_with = "not_null")]
    interval: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteInput {
    id: String,
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

fn check_interval(unit: Option<&String>, interval: Option<i64>) -> Result<(), String> {
    if let Some(unit) = unit
        && !INTERVAL_UNITS.contains(&unit.as_str())
    {
        return Err(format!("intervalUnit: Invalid enum value '{unit}'"));
    }
    if let Some(interval) = interval
        && !INTERVAL_RANGE.contains(&interval)
    {
        return Err("interval: must be an integer from 1 to 200".to_owned());
    }
    if unit.is_some() != interval.is_some() {
        return Err("intervalUnit and interval must be set together".to_owned());
    }
    Ok(())
}

/// The CronCreate input after Node's `CronCreateInputSchema` (trimmed strings, refinements in Node's order).
#[derive(Debug, PartialEq)]
struct Create {
    cron: Option<String>,
    delay_minutes: Option<i64>,
    prompt: String,
    title: String,
    recurring: Option<bool>,
    max_runs: Option<i64>,
    carrier: Option<(String, i64)>,
}

fn create_input(input: &Value) -> Result<Create, String> {
    let raw: CreateInput = parse(input).map_err(|error| error.to_string())?;
    let cron = optional_non_empty("cron", raw.cron.as_ref())?;
    let prompt = non_empty("prompt", &raw.prompt)?;
    let title = non_empty("title", &raw.title)?;
    if let Some(delay) = raw.delay_minutes
        && !(1..=MAX_DELAY_MINUTES).contains(&delay)
    {
        return Err(format!(
            "delayMinutes: must be a positive integer up to {MAX_DELAY_MINUTES}"
        ));
    }
    if raw.max_runs.is_some_and(|runs| runs < 1) {
        return Err("maxRuns: must be a positive integer".to_owned());
    }
    let relative = raw.delay_minutes.is_some();
    let unit = raw.interval_unit.as_ref();
    let rules = [
        (
            !relative && cron.is_none(),
            "cron is required when delayMinutes is not set",
        ),
        (
            relative && cron.is_some(),
            "a relative delay must omit cron; the host computes the schedule from its real clock",
        ),
        (
            relative && raw.recurring == Some(true),
            "a relative delay creates a one-shot automation and cannot use recurring=true",
        ),
        (
            relative && raw.max_runs.is_some(),
            "a relative delay runs once and cannot use maxRuns",
        ),
        (
            unit.is_some() && relative,
            "intervalUnit is a recurring carrier and cannot combine with a relative delayMinutes",
        ),
    ];
    if let Some((_, message)) = rules.iter().find(|(broken, _)| *broken) {
        return Err((*message).to_owned());
    }
    check_interval(unit, raw.interval)?;
    if unit.is_some() && raw.recurring == Some(false) {
        return Err("intervalUnit is a recurring carrier and requires recurring=true".to_owned());
    }
    if unit.is_some() && raw.max_runs.is_some() {
        return Err(
            "intervalUnit is a recurring carrier and cannot combine with maxRuns".to_owned(),
        );
    }
    Ok(Create {
        cron,
        delay_minutes: raw.delay_minutes,
        prompt,
        title,
        recurring: raw.recurring,
        max_runs: raw.max_runs,
        carrier: raw.interval_unit.zip(raw.interval),
    })
}

/// The CronUpdate input after Node's `CronUpdateInputSchema`.
#[derive(Debug, PartialEq)]
struct Update {
    id: String,
    cron: Option<String>,
    prompt: Option<String>,
    title: String,
    recurring: Option<bool>,
    max_runs: Option<Option<i64>>,
    carrier: Option<(String, i64)>,
}

fn update_input(input: &Value) -> Result<Update, String> {
    let raw: UpdateInput = parse(input).map_err(|error| error.to_string())?;
    let id = non_empty("id", &raw.id)?;
    let cron = optional_non_empty("cron", raw.cron.as_ref())?;
    let prompt = optional_non_empty("prompt", raw.prompt.as_ref())?;
    let title = non_empty("title", &raw.title)?;
    if raw.max_runs.flatten().is_some_and(|runs| runs < 1) {
        return Err("maxRuns: must be a positive integer".to_owned());
    }
    let clears_limit = raw.max_runs == Some(None);
    let numeric_limit = matches!(raw.max_runs, Some(Some(_)));
    if clears_limit && raw.recurring != Some(true) {
        return Err("Clearing maxRuns requires recurring=true in the same update".to_owned());
    }
    if raw.recurring == Some(true) && numeric_limit {
        return Err("recurring=true cannot be combined with a numeric maxRuns".to_owned());
    }
    let unit = raw.interval_unit.as_ref();
    check_interval(unit, raw.interval)?;
    if unit.is_some() && raw.recurring == Some(false) {
        return Err(
            "intervalUnit is a recurring carrier and cannot combine with recurring=false"
                .to_owned(),
        );
    }
    if unit.is_some() && raw.max_runs.is_some() && !(clears_limit && raw.recurring == Some(true)) {
        return Err(
            "intervalUnit is a recurring carrier and only allows maxRuns=null with recurring=true"
                .to_owned(),
        );
    }
    Ok(Update {
        id,
        cron,
        prompt,
        title,
        recurring: raw.recurring,
        max_runs: raw.max_runs,
        carrier: raw.interval_unit.zip(raw.interval),
    })
}

/// The session's selection as the protocol's `modelSelection`.
fn model_selection(selection: &ModelSelection) -> Value {
    let mut value = json!({"providerId": selection.provider, "modelId": selection.model});
    if let Some(level) = selection
        .reasoning
        .as_deref()
        .filter(|level| !level.trim().is_empty())
    {
        value["options"] = json!({"reasoningLevel": level});
    }
    value
}

/// The session's mode for a new automation: Node's mode names, `auto` saved as `build`.
fn automation_mode(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Auto => "build",
        mode => mode.node_name(),
    }
}

/// `automation/create` params (Node `automation-port.ts` `create`, without the `workspace` the port adds).
fn create_params(
    input: &Create,
    selection: Option<&ModelSelection>,
    mode: PermissionMode,
    target: &SessionId,
) -> Value {
    let mut params = Map::new();
    let relative = input.delay_minutes.is_some();
    params.insert(
        "cronExpr".into(),
        json!(input.cron.as_deref().unwrap_or("* * * * *")),
    );
    if let Some(delay) = input.delay_minutes {
        params.insert("relativeDelayMinutes".into(), json!(delay));
    }
    params.insert("prompt".into(), json!(input.prompt));
    params.insert("title".into(), json!(input.title));
    let recurring = if relative {
        false
    } else if input.carrier.is_some() {
        true
    } else {
        input.recurring.unwrap_or(true)
    };
    params.insert("recurring".into(), json!(recurring));
    if let Some(selection) = selection {
        params.insert("modelSelection".into(), model_selection(selection));
    }
    params.insert("mode".into(), json!(automation_mode(mode)));
    params.insert("targetTaskId".into(), json!(target.as_str()));
    match (&input.carrier, input.max_runs) {
        (Some((unit, interval)), _) => {
            params.insert("intervalUnit".into(), json!(unit));
            params.insert("interval".into(), json!(interval));
        }
        (None, Some(runs)) => {
            params.insert("maxRuns".into(), json!(runs));
        }
        (None, None) => {}
    }
    Value::Object(params)
}

/// `automation/update` params (Node `automation-port.ts` `update`): an interval carrier also switches the
/// automation to an unbounded recurrence.
fn update_params(input: &Update) -> Value {
    let mut params = Map::new();
    params.insert("automationId".into(), json!(input.id));
    params.insert("title".into(), json!(input.title));
    if let Some(cron) = &input.cron {
        params.insert("cronExpr".into(), json!(cron));
    }
    if let Some(prompt) = &input.prompt {
        params.insert("prompt".into(), json!(prompt));
    }
    match &input.carrier {
        Some((unit, interval)) => {
            params.insert("recurring".into(), json!(true));
            params.insert("maxRuns".into(), Value::Null);
            params.insert("intervalUnit".into(), json!(unit));
            params.insert("interval".into(), json!(interval));
        }
        None => {
            if let Some(recurring) = input.recurring {
                params.insert("recurring".into(), json!(recurring));
            }
            if let Some(runs) = input.max_runs {
                params.insert("maxRuns".into(), json!(runs));
            }
        }
    }
    Value::Object(params)
}

/// Node `toModelAutomation`: the reply's model fields in Node's order, absent ones left out.
fn model_automation(automation: &Value) -> Value {
    let mut out = Map::new();
    for field in MODEL_FIELDS {
        if let Some(value) = automation.get(field) {
            out.insert(field.to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

fn not_allowed(tool: &str) -> ToolError {
    failed(format!(
        "{tool} is not allowed while running a scheduled automation."
    ))
}

fn host_error(error: AutomationError) -> ToolError {
    failed(error.message)
}

fn json_output(value: &Value) -> ToolOutput {
    rust_cli_kernel_api::tool::text(value.to_string())
}

impl AutomationTool {
    async fn request(
        &self,
        owner: &SessionId,
        method: &str,
        params: Value,
    ) -> Result<Value, AutomationError> {
        self.port.request(owner, method, params).await
    }

    /// Whether `owner` already belongs to an automation (Node: `automation/checkTaskBinding`; only `-32601` falls
    /// back to filtering `automation/list`; every other failure is "cannot verify", never "unbound").
    async fn bound(&self, owner: &SessionId) -> Result<bool, ToolError> {
        let checked = match self
            .request(
                owner,
                port::CHECK_TASK_BINDING,
                json!({"targetTaskId": owner.as_str()}),
            )
            .await
        {
            Ok(result) => Ok(result["bound"] == true),
            Err(error) if error.is_method_not_found() => self
                .request(owner, port::LIST, json!({}))
                .await
                .map(|result| {
                    result["automations"].as_array().is_some_and(|automations| {
                        automations
                            .iter()
                            .any(|automation| automation["targetTaskId"] == owner.as_str())
                    })
                }),
            Err(error) => Err(error),
        };
        checked.map_err(|error| {
            tracing::warn!(
                session = owner.as_str(),
                error = %error,
                "automation.create.bound_session_check.failed"
            );
            failed(BOUND_SESSION_CHECK_FAILED.to_owned())
        })
    }

    async fn create(
        &self,
        input: &Value,
        context: &ToolUseContext,
        owner: &SessionId,
    ) -> Result<ToolOutput, ToolError> {
        let input = create_input(input).map_err(|message| ToolError::InvalidInput { message })?;
        if self.bound(owner).await? {
            return Err(failed(CREATE_IN_BOUND_SESSION.to_owned()));
        }
        let selection = context
            .session_ops
            .view()
            .await
            .and_then(|view| view.selection);
        let params = create_params(&input, selection.as_ref(), context.base_mode, owner);
        let result = self
            .request(owner, port::CREATE, params)
            .await
            .map_err(host_error)?;
        let automation = model_automation(&result["automation"]);
        let id = automation["automationId"].as_str().unwrap_or_default();
        let message = format!("Created automation {id}.");
        // A generated title may land after the create and would describe the reply instead of the task: the
        // automation title becomes the session's custom title (Node `setCustomSessionTitle`).
        let title = automation["title"].as_str().unwrap_or_default().trim();
        if !title.is_empty() {
            context.session_ops.freeze_title(title.to_owned()).await;
        }
        Ok(json_output(
            &json!({"automation": automation, "message": message}),
        ))
    }

    async fn update(&self, input: &Value, owner: &SessionId) -> Result<ToolOutput, ToolError> {
        let input = update_input(input).map_err(|message| ToolError::InvalidInput { message })?;
        let result = self
            .request(owner, port::UPDATE, update_params(&input))
            .await
            .map_err(host_error)?;
        let automation = model_automation(&result["automation"]);
        let id = automation["automationId"].as_str().unwrap_or_default();
        let message = format!("Updated automation {id}.");
        Ok(json_output(
            &json!({"automation": automation, "message": message}),
        ))
    }

    async fn list(&self, owner: &SessionId) -> Result<ToolOutput, ToolError> {
        let result = self
            .request(owner, port::LIST, json!({}))
            .await
            .map_err(host_error)?;
        let automations: Vec<Value> = result["automations"]
            .as_array()
            .map(|automations| automations.iter().map(model_automation).collect())
            .unwrap_or_default();
        Ok(json_output(&json!({"automations": automations})))
    }

    async fn delete(&self, input: &Value, owner: &SessionId) -> Result<ToolOutput, ToolError> {
        let input: DeleteInput = parse(input)?;
        let id =
            non_empty("id", &input.id).map_err(|message| ToolError::InvalidInput { message })?;
        let result = self
            .request(owner, port::DELETE, json!({"automationId": id}))
            .await
            .map_err(host_error)?;
        let deleted = result["deleted"] == true;
        let message = if deleted {
            format!("Deleted automation {id}.")
        } else {
            format!("Automation {id} was not found in the current workspace.")
        };
        Ok(json_output(
            &json!({"deleted": deleted, "id": id, "message": message}),
        ))
    }

    /// The target is only the turn's automation id, never the model's input.
    async fn pause_self(
        &self,
        limits: &TurnLimits,
        owner: &SessionId,
    ) -> Result<ToolOutput, ToolError> {
        let Some(id) = limits.automation() else {
            return Err(failed(PAUSE_SELF_OUTSIDE_RUN.to_owned()));
        };
        let result = self
            .request(owner, port::PAUSE, json!({"automationId": id}))
            .await
            .map_err(host_error)?;
        let paused = result["paused"] == true;
        let message = if paused {
            format!(
                "Paused automation {id}. It will not run on schedule until the user resumes it."
            )
        } else {
            format!(
                "Automation {id} is not active (already paused, completed, failed, or deleted), so nothing changed."
            )
        };
        Ok(json_output(
            &json!({"paused": paused, "id": id, "message": message}),
        ))
    }

    async fn dispatch(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> Result<ToolOutput, ToolError> {
        let mutates = matches!(self.kind, Kind::Create | Kind::Update | Kind::Delete);
        // A mutation needs the turn's limits: without the session view it cannot tell an automation turn apart, so it
        // fails closed.
        let limits = match context.session_ops.view().await {
            Some(view) => view.turn,
            None if mutates => return Err(failed("Session state is unavailable.".to_owned())),
            None => TurnLimits::default(),
        };
        // The turn's tool list already hides these; a call that still arrives is refused before any request.
        if mutates && limits.restricts_automation_mutations() {
            return Err(not_allowed(&self.contract.name));
        }
        let owner = context.session_ops.owner_session(&context.session).await;
        match self.kind {
            Kind::Create => self.create(input, context, &owner).await,
            Kind::Update => self.update(input, &owner).await,
            Kind::List => self.list(&owner).await,
            Kind::Delete => self.delete(input, &owner).await,
            Kind::PauseSelf => self.pause_self(&limits, &owner).await,
        }
    }
}

#[async_trait]
impl Tool for AutomationTool {
    fn name(&self) -> &str {
        &self.contract.name
    }

    fn input_schema(&self) -> Value {
        self.contract.input_schema.clone()
    }

    fn description(&self, _context: &PromptContext) -> String {
        self.contract.description.clone()
    }

    /// Node's desktop agent runs with tool search off (the Host default), so its first request carries these
    /// contracts directly.
    fn should_defer(&self) -> bool {
        false
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
        // Node refuses a mutation on an automation turn before it parses the input (`assertNotAutomationTurn`
        // first): leave the refinements to `call`, whose dispatch refuses before any parse.
        if matches!(self.kind, Kind::Create | Kind::Update)
            && context
                .session_ops
                .view()
                .await
                .is_some_and(|view| view.turn.restricts_automation_mutations())
        {
            return Validation::Ok;
        }
        let checked = match self.kind {
            Kind::Create => create_input(input).map(drop),
            Kind::Update => update_input(input).map(drop),
            Kind::List | Kind::Delete | Kind::PauseSelf => Ok(()),
        };
        match checked {
            Ok(()) => Validation::Ok,
            Err(message) => invalid(message),
        }
    }

    /// Node `needsApproval`: create, update and delete go through the usual ask (an allow rule or a bypass mode
    /// skips it); list and the run's own pause are allowed.
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
        // Node runs the whole handler under one deadline (`timeoutMs`), so CronCreate's binding check and its create
        // share it.
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

#[cfg(test)]
#[path = "automation_tools_tests.rs"]
mod tests;
