//! Fork: the app-provided tools of the MCP App panels of Rust-run servers (specs/fork-rust-node-helper.md, "MCP Apps on
//! Rust-hosted servers (F7)", PR 3). Port of Node `zcode-protocol/mcp-ui/appTools.ts` (the registry and the mailbox) and
//! `appToolsProtocol.ts` (`mcp/uiRegisterAppTools`, `mcp/uiUnregisterAppTools`, `mcp/uiClaimAppToolCall`,
//! `mcp/uiResolveAppToolCall`).
//!
//! The mailbox: a model call of an app tool is published to the one panel instance that exposes the tool
//! (`pluginUi.appToolCall`). The panel claims it, runs the page's `tools/call` and resolves it. A claim that does not
//! come in time means the page is not running; a claimed call that does not resolve in time is a timeout. Every outcome
//! other than a result publishes a `cancelled` message, so the page drops the call.
//!
//! Owner: [`RustMcpUi`] owns the registry (`tools`). It implements the kernel's [`AppToolHost`] for the sets of its
//! panels. [`AppToolRouter`] composes it with the Node helper's set: a name the Rust registry exposes goes to Rust, every
//! other name to the helper.

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::app_tool::{AppToolHost, AppToolSpec};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp_app::McpAppHost;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio::sync::{oneshot, watch};

use super::mcp_ui_rust::{Guard, RustMcpUi, random_hex, text};
use super::mcp_ui_sampling::utf16_len;

/// Node `MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS` and `MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS`.
const CLAIM_TIMEOUT: Duration = Duration::from_millis(5_000);
const CALL_TIMEOUT: Duration = Duration::from_millis(30_000);
/// Node `MCP_APPS_APP_TOOL_RESULT_MAX_BYTES` and `MCP_APPS_APP_TOOL_ARGUMENTS_MAX_BYTES`.
const RESULT_MAX_BYTES: usize = 10 * 1024 * 1024;
const ARGUMENTS_MAX_BYTES: usize = 1024 * 1024;
/// Node `MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE` and the descriptor limits of `mcpAppsAppToolDescriptorSchema`.
const TOOLS_MAX: usize = 50;
const NAME_MAX_UNITS: usize = 128;
const TITLE_MAX_UNITS: usize = 256;
const DESCRIPTION_MAX_UNITS: usize = 4096;
const SCHEMA_MAX_BYTES: usize = 64 * 1024;
const CALL_ID_MAX_UNITS: usize = 128;
const SCOPE_MAX_UNITS: usize = 256;
const ERROR_MAX_UNITS: usize = 4096;

/// The mailbox's deadlines. Production uses Node's values; tests inject short ones.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Timing {
    pub claim: Duration,
    pub call: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            claim: CLAIM_TIMEOUT,
            call: CALL_TIMEOUT,
        }
    }
}

/// One deliverable `pluginUi.*` delta, by session (the owner sends them after its lock is released).
type Outbox = Vec<(String, Value)>;

/// The panel instance a call or a registration names: its scope (the lease token), generation, plugin, server and the
/// credential (`params.instance`) its subscribers carry.
#[derive(Debug, Clone)]
pub(super) struct Target {
    plugin_id: String,
    server: String,
    scope: String,
    generation: u64,
    credential: Value,
}

/// A registered instance: its target, its registration order and its descriptors.
struct Instance {
    target: Target,
    seq: u64,
    tools: Vec<Descriptor>,
}

/// One tool of a registration, as Node's `McpAppsAppToolDescriptor` reads it.
#[derive(Debug, Clone)]
struct Descriptor {
    name: String,
    title: Option<String>,
    description: Option<String>,
    input_schema: Value,
    read_only: bool,
    destructive: bool,
    idempotent: bool,
}

/// A tool the session exposes: the overlay entry and the instance it comes from.
#[derive(Clone)]
struct Exposed {
    spec: AppToolSpec,
    instance: String,
}

/// A model call waiting for its outcome.
struct Pending {
    instance: String,
    target: Target,
    tool_name: String,
    tool_call: String,
    claimed: watch::Sender<bool>,
    outcome: Option<oneshot::Sender<Result<Value, String>>>,
}

#[derive(Default)]
struct SessionTools {
    /// Instance key (`scope|generation`) -> instance.
    instances: BTreeMap<String, Instance>,
    next_seq: u64,
    /// The tools the session exposes, rebuilt by [`sync`] after every change.
    exposed: Vec<Exposed>,
    /// Call id -> pending call.
    pending: BTreeMap<String, Pending>,
}

/// The registry of every session (Node `McpUiAppToolRegistry`'s state). Owned by [`RustMcpUi`].
#[derive(Default)]
pub(crate) struct Mailbox {
    sessions: BTreeMap<String, SessionTools>,
}

fn instance_key(scope: &str, generation: u64) -> String {
    format!("{scope}|{generation}")
}

/// Node `sanitizeMcpAppsModelNamePart`: each UTF-16 unit outside `[A-Za-z0-9_-]` becomes `_`, runs of `_` collapse, and
/// an empty result is `unknown`.
fn sanitize(name: &str) -> String {
    let mut out = String::new();
    for character in name.chars() {
        if character.is_ascii_alphanumeric() || character == '-' {
            out.push(character);
            continue;
        }
        // Each UTF-16 unit of a replaced character is one `_`, and the `_` runs (replaced or not) collapse.
        let units = if character == '_' {
            1
        } else {
            character.len_utf16()
        };
        for _ in 0..units {
            if !out.ends_with('_') {
                out.push('_');
            }
        }
    }
    if out.is_empty() {
        "unknown".to_owned()
    } else {
        out
    }
}

/// Node `buildMcpAppsAppToolModelName`: `app__<server>__<tool>`.
pub(crate) fn model_name(server: &str, tool: &str) -> String {
    format!("app__{}__{}", sanitize(server), sanitize(tool))
}

/// The exposed set of a session (Node `sync`): the newest instance of each server, servers in name order, and a model
/// name appears once.
fn sync(session: &mut SessionTools) {
    let mut latest: BTreeMap<String, String> = BTreeMap::new();
    for (key, instance) in &session.instances {
        let replace = latest
            .get(&instance.target.server)
            .is_none_or(|current| session.instances[current].seq < instance.seq);
        if replace {
            latest.insert(instance.target.server.clone(), key.clone());
        }
    }
    let mut seen = HashSet::new();
    let mut exposed = Vec::new();
    for (server, key) in &latest {
        for tool in &session.instances[key].tools {
            let model = model_name(server, &tool.name);
            if !seen.insert(model.clone()) {
                continue;
            }
            exposed.push(Exposed {
                spec: AppToolSpec {
                    model_name: model,
                    server_name: server.clone(),
                    plugin_id: session.instances[key].target.plugin_id.clone(),
                    tool_name: tool.name.clone(),
                    title: tool.title.clone(),
                    description: tool.description.clone(),
                    input_schema: tool.input_schema.clone(),
                    read_only: tool.read_only,
                    destructive: tool.destructive,
                    idempotent: tool.idempotent,
                },
                instance: key.clone(),
            });
        }
    }
    session.exposed = exposed;
}

fn delta(target: &Target, call_id: &str, tool: &str, arguments: Value, cancelled: bool) -> Value {
    let mut value = json!({
        "op": "pluginUi.appToolCall",
        "pluginId": target.plugin_id,
        "serverName": target.server,
        "subscribers": [{
            "scopeId": target.scope,
            "generation": target.generation,
            "instance": target.credential,
        }],
        "callId": call_id,
        "toolName": tool,
        "arguments": arguments,
    });
    if cancelled {
        value["cancelled"] = json!(true);
    }
    value
}

/// Node `onActivity`: a pin of a lease's execution started or ended.
fn activity(target: &Target, pin: &str, active: bool) -> Value {
    let mut value = delta(target, pin, "", json!({}), false);
    value["activity"] = json!(active);
    value
}

/// Ends a pending call with `outcome` (Node `settle`): a result is delivered, anything else publishes a `cancelled`
/// message first. A call that is no longer pending is left alone.
fn settle(
    session: &mut SessionTools,
    session_id: &str,
    call_id: &str,
    outcome: Result<Value, String>,
    out: &mut Outbox,
) {
    let Some(mut pending) = session.pending.remove(call_id) else {
        return;
    };
    if outcome.is_err() {
        out.push((
            session_id.to_owned(),
            delta(
                &pending.target,
                call_id,
                &pending.tool_name,
                json!({}),
                true,
            ),
        ));
    }
    if let Some(sender) = pending.outcome.take() {
        let _ = sender.send(outcome);
    }
}

/// Node `dropInstance`: removes an instance and ends its pending calls with `reason`.
fn drop_instance(
    session: &mut SessionTools,
    session_id: &str,
    key: &str,
    reason: &str,
    out: &mut Outbox,
) {
    if session.instances.remove(key).is_none() {
        return;
    }
    let calls: Vec<String> = session
        .pending
        .iter()
        .filter(|(_, pending)| pending.instance == key)
        .map(|(id, _)| id.clone())
        .collect();
    for call in calls {
        settle(session, session_id, &call, Err(reason.to_owned()), out);
    }
}

/// Node `parseParams`: the descriptors of a registration, with the limits of `mcpAppsAppToolDescriptorSchema`.
fn parse_descriptors(params: &Value) -> Result<Vec<Descriptor>, RpcError> {
    let tools = params
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| RpcError::invalid_params("tools is required"))?;
    if tools.len() > TOOLS_MAX {
        return Err(RpcError::invalid_params(format!(
            "tools has at most {TOOLS_MAX} entries"
        )));
    }
    tools.iter().map(parse_descriptor).collect()
}

fn parse_descriptor(tool: &Value) -> Result<Descriptor, RpcError> {
    let name = tool
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty() && utf16_len(name) <= NAME_MAX_UNITS)
        .ok_or_else(|| {
            RpcError::invalid_params("tool name is required (at most 128 characters)")
        })?;
    let limited = |key: &str, max: usize| -> Result<Option<String>, RpcError> {
        match tool.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) if utf16_len(text) <= max => Ok(Some(text.clone())),
            Some(_) => Err(RpcError::invalid_params(format!(
                "tool {key} is not a string of at most {max} characters"
            ))),
        }
    };
    let title = limited("title", TITLE_MAX_UNITS)?;
    let description = limited("description", DESCRIPTION_MAX_UNITS)?;
    let input_schema = tool
        .get("inputSchema")
        .filter(|schema| {
            schema.get("type").and_then(Value::as_str) == Some("object")
                && serde_json::to_vec(schema).map_or(usize::MAX, |bytes| bytes.len())
                    <= SCHEMA_MAX_BYTES
        })
        .cloned()
        .ok_or_else(|| {
            RpcError::invalid_params("tool inputSchema must be an object schema of at most 64 KiB")
        })?;
    let hint = |key: &str| -> Result<Option<bool>, RpcError> {
        let annotations = tool.get("annotations");
        match annotations.and_then(|value| value.get(key)) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(flag)) => Ok(Some(*flag)),
            Some(_) => Err(RpcError::invalid_params(format!(
                "tool annotations.{key} is not a boolean"
            ))),
        }
    };
    Ok(Descriptor {
        name: name.to_owned(),
        title,
        description,
        input_schema,
        read_only: hint("readOnlyHint")?.unwrap_or(false),
        destructive: hint("destructiveHint")?.unwrap_or(false),
        idempotent: hint("idempotentHint")?.unwrap_or(false),
    })
}

/// The binding of a request: `scopeId` and `generation` must name the `instance` it carries (Node's binding check).
fn binding(params: &Value, message: &str) -> Result<(String, u64), RpcError> {
    let scope = text(params, "scopeId")?;
    if utf16_len(scope) > SCOPE_MAX_UNITS {
        return Err(RpcError::invalid_params(
            "scopeId is at most 256 characters",
        ));
    }
    let generation = params
        .get("generation")
        .and_then(Value::as_u64)
        .ok_or_else(|| RpcError::invalid_params("generation is required"))?;
    let instance = params
        .get("instance")
        .ok_or_else(|| RpcError::invalid_params("instance is required"))?;
    if instance.get("token").and_then(Value::as_str) != Some(scope)
        || instance.get("generation").and_then(Value::as_u64) != Some(generation)
    {
        return Err(RpcError::internal(message));
    }
    Ok((scope.to_owned(), generation))
}

fn call_id_of(params: &Value) -> Result<&str, RpcError> {
    let call_id = text(params, "callId")?;
    if utf16_len(call_id) > CALL_ID_MAX_UNITS {
        return Err(RpcError::invalid_params("callId is at most 128 characters"));
    }
    Ok(call_id)
}

/// The mailbox's outcome of one resolve: the page's result, or its error message.
fn outcome_of(params: &Value) -> Result<Result<Value, String>, RpcError> {
    match (params.get("result"), params.get("error")) {
        (Some(result), None) => {
            if !result.get("content").is_some_and(Value::is_array) {
                return Err(RpcError::invalid_params("result.content is required"));
            }
            if serde_json::to_vec(result).map_or(usize::MAX, |bytes| bytes.len()) > RESULT_MAX_BYTES
            {
                return Ok(Err(format!(
                    "App tool result exceeds {RESULT_MAX_BYTES} bytes"
                )));
            }
            Ok(Ok(result.clone()))
        }
        (None, Some(error)) => {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .filter(|message| utf16_len(message) <= ERROR_MAX_UNITS)
                .ok_or_else(|| RpcError::invalid_params("error.message is required"))?;
            Ok(Err(if message.is_empty() {
                "App tool failed".to_owned()
            } else {
                message.to_owned()
            }))
        }
        _ => Err(RpcError::invalid_params(
            "exactly one of result or error is required",
        )),
    }
}

/// Settles the outcome channel of a call the caller waits on.
fn settled(
    outcome: Result<Result<Value, String>, oneshot::error::RecvError>,
) -> Result<Value, String> {
    match outcome {
        Ok(result) => result,
        Err(_) => Err("App tool call was cancelled".to_owned()),
    }
}

/// The pin and the activity of one model call: released (and its activity ended) however the call ends, and a call that
/// is still pending when it ends is cancelled (the caller dropped it, as the kernel does when the turn is cancelled).
struct Execution {
    ui: Weak<RustMcpUi>,
    session: String,
    call_id: String,
    token: String,
    pin: String,
    target: Target,
}

impl Drop for Execution {
    fn drop(&mut self) {
        let Some(ui) = self.ui.upgrade() else {
            return;
        };
        ui.end_call(&self.session, &self.call_id, "App tool call was cancelled");
        ui.instances.release(&self.token, &self.pin);
        ui.deliver(&self.session, activity(&self.target, &self.pin, false));
    }
}

impl RustMcpUi {
    /// Runs `f` on the registry and delivers what it queued, after the lock is released.
    fn with_tools<R>(&self, f: impl FnOnce(&mut Mailbox, &mut Outbox) -> R) -> R {
        let mut out = Outbox::new();
        let result = {
            let mut mailbox = self.tools.lock_unpoisoned();
            f(&mut mailbox, &mut out)
        };
        for (session, value) in out {
            self.deliver(&session, value);
        }
        result
    }

    /// Node `register`: the instance replaces the older generation of its scope, and the exposed tools it names are
    /// returned.
    pub(super) fn register_app_tools(
        &self,
        session: &str,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let guard = Guard::new(params)?;
        let (scope, generation) = binding(params, "Invalid MCP App registration binding")?;
        let tools = parse_descriptors(params)?;
        let target = Target {
            plugin_id: guard.plugin.clone(),
            server: guard.server,
            scope: scope.clone(),
            generation,
            credential: params["instance"].clone(),
        };
        let key = instance_key(&scope, generation);
        let exposed = self.with_tools(|mailbox, out| {
            let session_tools = mailbox.sessions.entry(session.to_owned()).or_default();
            let stale: Vec<String> = session_tools
                .instances
                .iter()
                .filter(|(other, instance)| **other != key && instance.target.scope == scope)
                .map(|(other, _)| other.clone())
                .collect();
            for other in stale {
                drop_instance(session_tools, session, &other, "App page was reloaded", out);
            }
            let seq = match session_tools.instances.get(&key) {
                Some(existing) => existing.seq,
                None => {
                    session_tools.next_seq += 1;
                    session_tools.next_seq - 1
                }
            };
            session_tools
                .instances
                .insert(key.clone(), Instance { target, seq, tools });
            sync(session_tools);
            session_tools
                .exposed
                .iter()
                .filter(|exposed| exposed.instance == key)
                .map(|exposed| {
                    json!({"name": exposed.spec.tool_name, "modelName": exposed.spec.model_name})
                })
                .collect::<Vec<Value>>()
        });
        Ok(json!({"tools": exposed}))
    }

    /// Node `unregister`: drops the instance and its pending calls. A session that is gone removed nothing.
    pub(super) fn unregister_app_tools(
        &self,
        session: &str,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let (scope, generation) = binding(params, "Invalid MCP App binding")?;
        let key = instance_key(&scope, generation);
        let removed = self.with_tools(|mailbox, out| {
            let Some(session_tools) = mailbox.sessions.get_mut(session) else {
                return 0;
            };
            let Some(count) = session_tools.instances.get(&key).map(|i| i.tools.len()) else {
                return 0;
            };
            drop_instance(session_tools, session, &key, "App page was closed", out);
            sync(session_tools);
            count
        });
        Ok(json!({"removed": removed}))
    }

    /// Node `claimMcpUiAppToolCall`: the lease is validated first, then the binding. A repeated claim by the same
    /// instance is accepted again (idempotent by call id).
    pub(super) fn claim_app_tool_call(
        &self,
        host: &dyn McpAppHost,
        session: &SessionId,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let guard = Guard::new(params)?;
        self.validate(host, session, &guard, params)?;
        let (scope, generation) = binding(params, "Invalid MCP App binding")?;
        let call_id = call_id_of(params)?;
        let key = instance_key(&scope, generation);
        let accepted = self.with_tools(|mailbox, _| {
            let pending = mailbox
                .sessions
                .get_mut(session.as_str())
                .and_then(|session_tools| session_tools.pending.get_mut(call_id));
            match pending {
                Some(pending) if pending.instance == key => {
                    pending.claimed.send_replace(true);
                    true
                }
                _ => false,
            }
        });
        Ok(json!({"accepted": accepted}))
    }

    /// Node `resolveMcpUiAppToolCall`: only a claimed call of the same instance can be resolved, once.
    pub(super) fn resolve_app_tool_call(
        &self,
        host: &dyn McpAppHost,
        session: &SessionId,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let guard = Guard::new(params)?;
        self.validate(host, session, &guard, params)?;
        let (scope, generation) = binding(params, "Invalid MCP App binding")?;
        let call_id = call_id_of(params)?;
        let outcome = outcome_of(params)?;
        let key = instance_key(&scope, generation);
        let accepted = self.with_tools(|mailbox, out| {
            let Some(session_tools) = mailbox.sessions.get_mut(session.as_str()) else {
                return false;
            };
            let claimed = session_tools
                .pending
                .get(call_id)
                .is_some_and(|pending| pending.instance == key && *pending.claimed.borrow());
            if !claimed {
                return false;
            }
            settle(session_tools, session.as_str(), call_id, outcome, out);
            true
        });
        Ok(json!({"accepted": accepted}))
    }

    /// Node `execute`: a model call is published to its instance and waits for the claim and the resolve.
    pub(super) async fn app_call(
        &self,
        session: &str,
        tool_call: &str,
        name: &str,
        input: Value,
    ) -> Result<Value, String> {
        let found = self.with_tools(|mailbox, _| {
            let session_tools = mailbox.sessions.get(session)?;
            let exposed = session_tools
                .exposed
                .iter()
                .find(|e| e.spec.model_name == name)?;
            let instance = session_tools.instances.get(&exposed.instance)?;
            Some((
                exposed.spec.clone(),
                instance.target.clone(),
                exposed.instance.clone(),
            ))
        });
        let Some((spec, target, key)) = found else {
            return Err(format!("App tool {name} is not available"));
        };
        if serde_json::to_vec(&input).map_or(usize::MAX, |bytes| bytes.len()) > ARGUMENTS_MAX_BYTES
        {
            return Err("App tool arguments are too large".to_owned());
        }
        // Node retains the lease for the whole execution, so `onlyIfIdle` close sees it busy.
        let pin = self.instances.retain(&target.scope, tool_call)?;
        let call_id = random_hex();
        let execution = Execution {
            ui: self.me.clone(),
            session: session.to_owned(),
            call_id: call_id.clone(),
            token: target.scope.clone(),
            pin: pin.clone(),
            target: target.clone(),
        };
        self.deliver(session, activity(&target, &pin, true));

        let (claim_tx, mut claimed) = watch::channel(false);
        let (outcome_tx, mut outcome_rx) = oneshot::channel();
        let queued = self.with_tools(|mailbox, _| {
            let session_tools = mailbox.sessions.get_mut(session)?;
            if !session_tools.instances.contains_key(&key) {
                return None;
            }
            session_tools.pending.insert(
                call_id.clone(),
                Pending {
                    instance: key.clone(),
                    target: target.clone(),
                    tool_name: spec.tool_name.clone(),
                    tool_call: tool_call.to_owned(),
                    claimed: claim_tx,
                    outcome: Some(outcome_tx),
                },
            );
            Some(())
        });
        if queued.is_none() {
            return Err(format!("The {} app page is not running", target.server));
        }
        self.deliver(
            session,
            delta(&target, &call_id, &spec.tool_name, input, false),
        );

        // The claim window: no claim in time means the page is not running (the instance is dropped).
        let claim_timer = tokio::time::sleep(self.timing.claim);
        tokio::pin!(claim_timer);
        loop {
            if *claimed.borrow() {
                break;
            }
            tokio::select! {
                outcome = &mut outcome_rx => return settled(outcome),
                () = &mut claim_timer => {
                    let message = format!("The {} app page is not running", target.server);
                    self.with_tools(|mailbox, out| {
                        if let Some(session_tools) = mailbox.sessions.get_mut(session) {
                            settle(session_tools, session, &call_id, Err(message.clone()), out);
                            drop_instance(session_tools, session, &key, "App page is not running", out);
                            sync(session_tools);
                        }
                    });
                    return Err(message);
                }
                changed = claimed.changed() => {
                    if changed.is_err() {
                        break;
                    }
                }
            }
        }

        // The call window: the page has claimed the call and must resolve it in time.
        let call_timer = tokio::time::sleep(self.timing.call);
        tokio::pin!(call_timer);
        let result = tokio::select! {
            outcome = &mut outcome_rx => settled(outcome),
            () = &mut call_timer => {
                let message = format!(
                    "App tool {} timed out after {} ms",
                    spec.tool_name,
                    self.timing.call.as_millis()
                );
                self.with_tools(|mailbox, out| {
                    if let Some(session_tools) = mailbox.sessions.get_mut(session) {
                        settle(session_tools, session, &call_id, Err(message.clone()), out);
                    }
                });
                Err(message)
            }
        };
        drop(execution);
        result
    }

    /// Ends a pending call that is still open with `message` (the execution was dropped, or its owner abandoned it).
    fn end_call(&self, session: &str, call_id: &str, message: &str) {
        self.with_tools(|mailbox, out| {
            if let Some(session_tools) = mailbox.sessions.get_mut(session) {
                settle(
                    session_tools,
                    session,
                    call_id,
                    Err(message.to_owned()),
                    out,
                );
            }
        });
    }

    /// `helper/appTools/cancel` for a call of this registry: the call is cancelled and its `cancelled` message sent.
    pub(super) fn app_cancel(&self, session: &str, tool_call: &str) {
        self.with_tools(|mailbox, out| {
            let Some(session_tools) = mailbox.sessions.get_mut(session) else {
                return;
            };
            let call = session_tools
                .pending
                .iter()
                .find(|(_, pending)| pending.tool_call == tool_call)
                .map(|(id, _)| id.clone());
            if let Some(call) = call {
                settle(
                    session_tools,
                    session,
                    &call,
                    Err("App tool call was cancelled".to_owned()),
                    out,
                );
            }
        });
    }

    /// Whether this registry holds the pending call of `tool_call` in `session`.
    pub(crate) fn owns_call(&self, session: &str, tool_call: &str) -> bool {
        self.tools
            .lock_unpoisoned()
            .sessions
            .get(session)
            .is_some_and(|session_tools| {
                session_tools
                    .pending
                    .values()
                    .any(|pending| pending.tool_call == tool_call)
            })
    }

    /// Node `clearSession`: the session's registry is dropped and its pending calls end with "Session was closed".
    pub(super) fn clear_session_tools(&self, session: &str) {
        self.with_tools(|mailbox, out| {
            let Some(mut session_tools) = mailbox.sessions.remove(session) else {
                return;
            };
            let calls: Vec<String> = session_tools.pending.keys().cloned().collect();
            for call in calls {
                settle(
                    &mut session_tools,
                    session,
                    &call,
                    Err("Session was closed".to_owned()),
                    out,
                );
            }
        });
    }

    /// The instance of a lease that ends (close, revoke): its tools are unregistered in every session that holds it.
    pub(super) fn drop_lease_tools(&self, token: &str, generation: u64, reason: &str) {
        self.with_tools(|mailbox, out| {
            for (session, session_tools) in mailbox.sessions.iter_mut() {
                let keys: Vec<String> = session_tools
                    .instances
                    .iter()
                    .filter(|(_, instance)| {
                        instance.target.scope == token && instance.target.generation == generation
                    })
                    .map(|(key, _)| key.clone())
                    .collect();
                if keys.is_empty() {
                    continue;
                }
                for key in keys {
                    drop_instance(session_tools, session, &key, reason, out);
                }
                sync(session_tools);
            }
        });
    }

    /// The exposed tools of `session` (the overlay), for the kernel.
    pub(crate) fn exposed_tools(&self, session: &str) -> Vec<AppToolSpec> {
        self.tools
            .lock_unpoisoned()
            .sessions
            .get(session)
            .map(|session_tools| {
                session_tools
                    .exposed
                    .iter()
                    .map(|exposed| exposed.spec.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[async_trait]
impl AppToolHost for RustMcpUi {
    fn app_tools(&self, session: &SessionId) -> Vec<AppToolSpec> {
        self.exposed_tools(session.as_str())
    }

    async fn call(
        &self,
        session: &SessionId,
        _turn: &str,
        tool_call: &str,
        name: &str,
        input: Value,
    ) -> Result<Value, String> {
        self.app_call(session.as_str(), tool_call, name, input)
            .await
    }

    async fn cancel(&self, session: &SessionId, tool_call: &str) {
        self.app_cancel(session.as_str(), tool_call);
    }
}

/// The app-provided tools of a session, composed: the Rust mailbox's exposed tools and the Node helper's set. The
/// composition is installed before the protocol server exists, and the Rust side is bound when it does.
pub struct AppToolRouter {
    helper: Option<Arc<dyn AppToolHost>>,
    rust: OnceLock<Arc<RustMcpUi>>,
}

impl AppToolRouter {
    pub fn new(helper: Option<Arc<dyn AppToolHost>>) -> Arc<Self> {
        Arc::new(Self {
            helper,
            rust: OnceLock::new(),
        })
    }

    /// The Rust side: set once, by the protocol handler.
    pub(crate) fn bind_rust(&self, ui: Arc<RustMcpUi>) {
        let _ = self.rust.set(ui);
    }

    fn rust_owns_name(&self, session: &SessionId, name: &str) -> Option<&Arc<RustMcpUi>> {
        self.rust.get().filter(|ui| {
            ui.exposed_tools(session.as_str())
                .iter()
                .any(|spec| spec.model_name == name)
        })
    }
}

#[async_trait]
impl AppToolHost for AppToolRouter {
    fn app_tools(&self, session: &SessionId) -> Vec<AppToolSpec> {
        let mut tools = self
            .helper
            .as_ref()
            .map(|helper| helper.app_tools(session))
            .unwrap_or_default();
        if let Some(ui) = self.rust.get() {
            tools.extend(ui.app_tools(session));
        }
        tools
    }

    async fn call(
        &self,
        session: &SessionId,
        turn: &str,
        tool_call: &str,
        name: &str,
        input: Value,
    ) -> Result<Value, String> {
        if let Some(ui) = self.rust_owns_name(session, name) {
            return ui.call(session, turn, tool_call, name, input).await;
        }
        match &self.helper {
            Some(helper) => helper.call(session, turn, tool_call, name, input).await,
            None => Err(format!("App tool {name} is not available")),
        }
    }

    async fn cancel(&self, session: &SessionId, tool_call: &str) {
        if let Some(ui) = self
            .rust
            .get()
            .filter(|ui| ui.owns_call(session.as_str(), tool_call))
        {
            ui.cancel(session, tool_call).await;
        } else if let Some(helper) = &self.helper {
            helper.cancel(session, tool_call).await;
        }
    }
}

#[cfg(test)]
#[path = "mcp_ui_app_tools_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "mcp_ui_app_tools_conformance_tests.rs"]
mod conformance_tests;
