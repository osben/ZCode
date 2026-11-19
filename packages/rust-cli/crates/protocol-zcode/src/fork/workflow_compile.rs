//! Fork: the compile and format client of the workflow engine (specs/fork-rust-workflow-engine.md, 4.1, as built in W4).
//!
//! Both methods are stateless helper calls over the NodeHelper link. Rust hashes, lowers and runs nothing itself: the
//! helper's answer is the contract, and a reply that does not match it is an error. A helper that does not serve the
//! method answers as unavailable, with [`NODE_HELPER_UNAVAILABLE`].

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

/// A typecheck or analysis diagnostic, positioned in the author's script (1-based).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: i64,
    pub line: i64,
    pub column: i64,
    pub message: String,
}

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

/// The CreateWorkflow confirmation window of `script_text`, as Node builds it (`null` when Node opens no window).
pub async fn display(helper: &NodeHelper, script_text: &str) -> Result<Option<Value>, RpcError> {
    let reply = forward(
        helper,
        FORMAT,
        &json!({"kind": "display", "scriptText": script_text}),
    )
    .await?;
    parse_display(&reply)
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

/// The GetWorkflowRun text for `run_id`, from the run port's `detail`. The summary is built by Node's handler.
pub async fn run_detail_text(
    helper: &NodeHelper,
    run_id: &str,
    detail: &Value,
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

pub(crate) fn run_detail_params(run_id: &str, detail: &Value, working_directory: &str) -> Value {
    json!({
        "kind": "runDetail",
        "runId": run_id,
        "detail": detail,
        "workingDirectory": working_directory,
    })
}

pub(crate) fn parse_display(reply: &Value) -> Result<Option<Value>, RpcError> {
    match reply.get("display") {
        Some(Value::Null) => Ok(None),
        Some(value) if value.is_object() => Ok(Some(value.clone())),
        _ => Err(malformed()),
    }
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

pub(crate) fn parse_analysis(reply: &Value) -> Result<Value, RpcError> {
    reply
        .get("analysis")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(malformed)
}

fn malformed() -> RpcError {
    RpcError::internal("the helper's workflow reply does not match its contract")
}

#[cfg(test)]
#[path = "workflow_compile_tests.rs"]
mod tests;
