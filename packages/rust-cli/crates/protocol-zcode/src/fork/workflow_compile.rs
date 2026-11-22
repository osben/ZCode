//! Fork: the compile and format client of the workflow engine (specs/fork-rust-workflow-engine.md, 4.1, as built in W4).
//!
//! Both methods are stateless helper calls over the NodeHelper link. Rust hashes, lowers and runs nothing itself: the
//! helper's answer is the contract, and a reply that does not match it is an error. A helper that does not serve the
//! method answers as unavailable, with [`NODE_HELPER_UNAVAILABLE`].

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::workflow_analysis::{
    WorkflowAnalysis, WorkflowAnalysisError, WorkflowAnalyzer, WorkflowDiagnostic,
};
use rust_cli_kernel_api::workflow_child::{FillPrepareInput, FillPrepareOutcome};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Map, Value, json};

use super::node_helper::{NODE_HELPER_UNAVAILABLE, NodeHelper};

/// `helper/workflow/compile`.
pub const COMPILE: &str = "helper/workflow/compile";
/// `helper/workflow/format`, kind `analysis`.
pub const FORMAT: &str = "helper/workflow/format";

/// The inputs of one compile: the script, the run it will start, and the run's frozen args and resume origin.
#[derive(Debug, Clone, Copy)]
pub struct CompileRequest<'a> {
    pub script_text: &'a str,
    pub run_id: &'a str,
    pub args: Option<&'a Map<String, Value>>,
    pub resumed_from: Option<&'a str>,
}

// A typecheck or analysis diagnostic, positioned in the author's script (1-based). It lives in kernel-api since W7-5a-1,
// so the child runner port can carry a refused compile to the runtime.
pub use rust_cli_kernel_api::workflow_child::Diagnostic;

/// The outcome of a compile.
#[derive(Debug, Clone, PartialEq)]
pub enum Compiled {
    /// The script compiled. `compiled` is the helper's compiled facts without the lowered body; `entry_source` is the
    /// child's ESM file, which the entry writer puts on disk.
    Ready {
        script_hash: String,
        compiled: Value,
        entry_source: String,
    },
    /// The script was refused. `message` is set when the compile threw after the diagnostics passed.
    Rejected {
        diagnostics: Vec<Diagnostic>,
        message: Option<String>,
    },
}

/// Compiles `request` on the helper.
pub async fn compile(
    helper: &NodeHelper,
    request: CompileRequest<'_>,
) -> Result<Compiled, RpcError> {
    let reply = forward(helper, COMPILE, &compile_params(&request)).await?;
    parse_compile(&reply)
}

/// The analysis of `script_text` (the window graph and its diagnostics), as the helper returns it.
pub async fn analysis(helper: &NodeHelper, script_text: &str) -> Result<Value, RpcError> {
    let reply = forward(
        helper,
        FORMAT,
        &json!({"kind": "analysis", "scriptText": script_text}),
    )
    .await?;
    parse_analysis(&reply)
}

/// The ListWorkflowRuns text for `input`, from the run port's `listed` result for that query. `working_directory` is the
/// session's cwd, which Node's handler reads.
pub async fn run_list_text(
    helper: &NodeHelper,
    input: &Map<String, Value>,
    listed: &Value,
    working_directory: &str,
) -> Result<String, RpcError> {
    let reply = forward(
        helper,
        FORMAT,
        &run_list_params(input, listed, working_directory),
    )
    .await?;
    parse_text(&reply)
}

/// The GetWorkflowRun text for `run_id`, from the run port's `detail`. `None` is an unknown run, which Node answers with
/// its not-found text. The summary is built by Node's handler.
pub async fn run_detail_text(
    helper: &NodeHelper,
    run_id: &str,
    detail: Option<&Value>,
    working_directory: &str,
) -> Result<String, RpcError> {
    let reply = forward(
        helper,
        FORMAT,
        &run_detail_params(run_id, detail, working_directory),
    )
    .await?;
    parse_text(&reply)
}

pub(crate) fn run_list_params(
    input: &Map<String, Value>,
    listed: &Value,
    working_directory: &str,
) -> Value {
    json!({
        "kind": "runList",
        "input": Value::Object(input.clone()),
        "listed": listed,
        "workingDirectory": working_directory,
    })
}

pub(crate) fn run_detail_params(
    run_id: &str,
    detail: Option<&Value>,
    working_directory: &str,
) -> Value {
    json!({
        "kind": "runDetail",
        "runId": run_id,
        "detail": detail.cloned().unwrap_or(Value::Null),
        "workingDirectory": working_directory,
    })
}

pub(crate) fn parse_text(reply: &Value) -> Result<String, RpcError> {
    reply
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(malformed)
}

async fn forward(helper: &NodeHelper, method: &str, params: &Value) -> Result<Value, RpcError> {
    match helper.forward(method, params).await {
        Some(result) => result,
        None => Err(RpcError::internal(format!(
            "the helper does not serve {method} ({NODE_HELPER_UNAVAILABLE})"
        ))
        .with_data(json!({"reasonCode": NODE_HELPER_UNAVAILABLE}))),
    }
}

/// The compile request's params. Optional fields are sent only when given, as the helper's schema is strict.
pub(crate) fn compile_params(request: &CompileRequest<'_>) -> Value {
    let mut params = json!({"scriptText": request.script_text, "runId": request.run_id});
    if let Some(args) = request.args {
        params["args"] = Value::Object(args.clone());
    }
    if let Some(resumed_from) = request.resumed_from {
        params["resumedFrom"] = json!(resumed_from);
    }
    params
}

pub(crate) fn parse_compile(reply: &Value) -> Result<Compiled, RpcError> {
    match reply.get("ok").and_then(Value::as_bool) {
        Some(true) => {
            let script_hash = reply.get("scriptHash").and_then(Value::as_str);
            let compiled = reply.get("compiled").filter(|value| value.is_object());
            let entry_source = reply.get("entrySource").and_then(Value::as_str);
            match (script_hash, compiled, entry_source) {
                (Some(script_hash), Some(compiled), Some(entry_source)) => Ok(Compiled::Ready {
                    script_hash: script_hash.to_owned(),
                    compiled: compiled.clone(),
                    entry_source: entry_source.to_owned(),
                }),
                _ => Err(malformed()),
            }
        }
        Some(false) => {
            let diagnostics = reply
                .get("diagnostics")
                .and_then(Value::as_array)
                .ok_or_else(malformed)?
                .iter()
                .map(parse_diagnostic)
                .collect::<Result<Vec<_>, _>>()?;
            let message = match reply.get("message") {
                None | Some(Value::Null) => None,
                Some(Value::String(message)) => Some(message.clone()),
                Some(_) => return Err(malformed()),
            };
            Ok(Compiled::Rejected {
                diagnostics,
                message,
            })
        }
        None => Err(malformed()),
    }
}

/// A helper diagnostic as the kernel-api analysis carries it: one parse and one conversion, the same fields.
fn parse_analysis_diagnostic(value: &Value) -> Result<WorkflowDiagnostic, RpcError> {
    let diagnostic = parse_diagnostic(value)?;
    Ok(WorkflowDiagnostic {
        code: diagnostic.code,
        line: diagnostic.line,
        column: diagnostic.column,
        message: diagnostic.message,
    })
}

fn parse_diagnostic(value: &Value) -> Result<Diagnostic, RpcError> {
    let code = value
        .get("code")
        .and_then(Value::as_i64)
        .ok_or_else(malformed)?;
    let line = value
        .get("line")
        .and_then(Value::as_i64)
        .ok_or_else(malformed)?;
    let column = value
        .get("column")
        .and_then(Value::as_i64)
        .ok_or_else(malformed)?;
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(malformed)?
        .to_owned();
    Ok(Diagnostic {
        code,
        line,
        column,
        message,
    })
}

/// The analysis object of an `analysis` reply. Fork (9.65, ocr #618): the reply also carries the script's display (Node
/// `displayOfAnalysis` of the same analysis), folded into the object as `display`, so one ask costs one analysis.
pub(crate) fn parse_analysis(reply: &Value) -> Result<Value, RpcError> {
    let mut analysis = reply
        .get("analysis")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(malformed)?;
    match reply.get("display") {
        None | Some(Value::Null) => {}
        Some(display) if display.is_object() => analysis["display"] = display.clone(),
        Some(_) => return Err(malformed()),
    }
    Ok(analysis)
}

/// `helper/workflow/evalSnippet` (W7-8c): the snippet compile under the snippet facade.
pub const EVAL_SNIPPET: &str = "helper/workflow/evalSnippet";

/// The outcome of a snippet compile.
#[derive(Debug, Clone, PartialEq)]
pub enum SnippetCompiled {
    /// The snippet compiles. `world_run` is true when it carries a world.run command; `entry_source` is the child's ESM file.
    Ready {
        world_run: bool,
        entry_source: String,
    },
    /// The snippet does not compile under the snippet facade, or a world.run command is not a literal.
    Rejected {
        diagnostics: Vec<WorkflowDiagnostic>,
    },
}

/// `helper/workflow/fillPrepare` (W7-12, 9.45): the fill of one hole, prepared on the helper. Nothing is written.
pub const FILL_PREPARE: &str = "helper/workflow/fillPrepare";

/// Prepares one hole's fill on the helper. A `ok: false` reply is a refusal (Node's reason, text and diagnostics); a
/// reply with no `ok` flag is a wiring fault.
pub async fn fill_prepare(
    helper: &NodeHelper,
    input: &FillPrepareInput,
) -> Result<FillPrepareOutcome, RpcError> {
    let reply = forward(helper, FILL_PREPARE, &fill_prepare_params(input)).await?;
    parse_fill_prepare(&reply)
}

pub(crate) fn fill_prepare_params(input: &FillPrepareInput) -> Value {
    let mut params = json!({
        "scriptText": input.script_text,
        "runId": input.run_id,
        "holeId": input.hole_id,
        "body": input.body,
    });
    // `null` is the same as no bindings: the helper's schema takes a record or no key at all.
    if let (Some(bindings), Some(map)) = (
        input
            .model_bindings
            .as_ref()
            .filter(|value| value.is_object()),
        params.as_object_mut(),
    ) {
        map.insert("modelBindings".to_owned(), bindings.clone());
    }
    params
}

/// A malformed fill reply: the helper broke its contract, which is a wiring fault, not a refusal.
fn malformed_fill(detail: &str) -> RpcError {
    RpcError::internal(format!("the fill helper's reply is malformed: {detail}"))
}

/// A string field the ready reply must carry.
fn required_text(reply: &Value, key: &str) -> Result<(), RpcError> {
    match reply.get(key).and_then(Value::as_str) {
        Some(_) => Ok(()),
        None => Err(malformed_fill(&format!("no text {key}"))),
    }
}

/// A list of strings the ready reply must carry (`phaseNames`, `phasesAdded`).
fn required_texts(reply: &Value, key: &str) -> Result<(), RpcError> {
    match reply.get(key).and_then(Value::as_array) {
        Some(items) if items.iter().all(Value::is_string) => Ok(()),
        _ => Err(malformed_fill(&format!("{key} is not a list of text"))),
    }
}

pub(crate) fn parse_fill_prepare(reply: &Value) -> Result<FillPrepareOutcome, RpcError> {
    match reply.get("ok").and_then(Value::as_bool) {
        Some(true) => {
            for key in ["effectiveText", "scriptHash", "code"] {
                required_text(reply, key)?;
            }
            for key in ["askSpecs", "sitePhases"] {
                if !reply.get(key).is_some_and(Value::is_object) {
                    return Err(malformed_fill(&format!("{key} is not an object")));
                }
            }
            required_texts(reply, "phaseNames")?;
            required_texts(reply, "phasesAdded")?;
            if let Some(holes) = reply.get("holes")
                && !holes
                    .as_array()
                    .is_some_and(|items| items.iter().all(|item| item.as_u64().is_some()))
            {
                return Err(malformed_fill("holes is not a list of indexes"));
            }
            Ok(FillPrepareOutcome::Ready(reply.clone()))
        }
        Some(false) => {
            let reason = reply.get("reason").and_then(Value::as_str);
            let message = reply.get("message").and_then(Value::as_str);
            let (Some(reason), Some(message)) = (reason, message) else {
                return Err(malformed_fill("a refusal has no reason or no message"));
            };
            // An absent or `null` diagnostics list is no diagnostics; anything else must be a list.
            let diagnostics = match reply.get("diagnostics") {
                None | Some(Value::Null) => None,
                Some(list @ Value::Array(items))
                    if items.iter().all(|item| {
                        item.get("line").and_then(Value::as_u64).is_some()
                            && item.get("column").and_then(Value::as_u64).is_some()
                            && item.get("message").is_some_and(Value::is_string)
                    }) =>
                {
                    Some(list.clone())
                }
                Some(Value::Array(_)) => {
                    return Err(malformed_fill(
                        "a diagnostic has no line, column or message",
                    ));
                }
                Some(_) => return Err(malformed_fill("diagnostics is not a list")),
            };
            Ok(FillPrepareOutcome::Refused {
                reason: reason.to_owned(),
                message: message.to_owned(),
                diagnostics,
            })
        }
        None => Err(malformed_fill("no ok flag")),
    }
}

/// Compiles a snippet on the helper. `run_id` is the identity the entry file carries.
pub async fn eval_snippet(
    helper: &NodeHelper,
    code: &str,
    run_id: &str,
) -> Result<SnippetCompiled, RpcError> {
    let reply = forward(helper, EVAL_SNIPPET, &eval_snippet_params(code, run_id)).await?;
    parse_eval_snippet(&reply)
}

pub(crate) fn eval_snippet_params(code: &str, run_id: &str) -> Value {
    json!({"scriptText": code, "runId": run_id})
}

pub(crate) fn parse_eval_snippet(reply: &Value) -> Result<SnippetCompiled, RpcError> {
    match reply.get("ok").and_then(Value::as_bool) {
        Some(true) => {
            let world_run = reply.get("worldRun").and_then(Value::as_bool);
            let entry_source = reply.get("entrySource").and_then(Value::as_str);
            match (world_run, entry_source) {
                (Some(world_run), Some(entry_source)) => Ok(SnippetCompiled::Ready {
                    world_run,
                    entry_source: entry_source.to_owned(),
                }),
                _ => Err(malformed()),
            }
        }
        Some(false) => {
            let diagnostics = reply
                .get("diagnostics")
                .and_then(Value::as_array)
                .ok_or_else(malformed)?
                .iter()
                .map(parse_analysis_diagnostic)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(SnippetCompiled::Rejected { diagnostics })
        }
        None => Err(malformed()),
    }
}

/// SaveWorkflow's typecheck over the helper (`helper/workflow/format`, kind `analysis`), as the kernel-api port.
pub struct HelperWorkflowAnalyzer {
    helper: Arc<NodeHelper>,
}

impl HelperWorkflowAnalyzer {
    pub fn new(helper: Arc<NodeHelper>) -> Self {
        Self { helper }
    }
}

#[async_trait]
impl WorkflowAnalyzer for HelperWorkflowAnalyzer {
    async fn analyze(&self, script: &str) -> Result<WorkflowAnalysis, WorkflowAnalysisError> {
        analysis_verdict(analysis(&self.helper, script).await)
    }
}

/// The port's verdict for one helper reply: a failed call and a reply that does not match its contract both mean the
/// checker cannot answer.
pub(crate) fn analysis_verdict(
    reply: Result<Value, RpcError>,
) -> Result<WorkflowAnalysis, WorkflowAnalysisError> {
    let reply = reply.map_err(|error| WorkflowAnalysisError {
        message: error.message,
    })?;
    analysis_from_value(&reply).map_err(|error| WorkflowAnalysisError {
        message: error.message,
    })
}

/// The helper's analysis object as the port's verdict. The window graph and the other fields are not needed here.
pub(crate) fn analysis_from_value(value: &Value) -> Result<WorkflowAnalysis, RpcError> {
    <WorkflowAnalysis as serde::Deserialize>::deserialize(value)
        .map_err(|error| RpcError::internal(format!("{MALFORMED_REPLY}: {error}")))
}

/// The contract message, shared by every malformed-reply path (the serde cause is appended where there is one).
const MALFORMED_REPLY: &str = "the helper's workflow reply does not match its contract";

fn malformed() -> RpcError {
    RpcError::internal(MALFORMED_REPLY)
}

#[cfg(test)]
#[path = "workflow_compile_tests.rs"]
mod tests;
