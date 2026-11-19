//! Runs `tests/fixtures/mcp_ui_app_tools_conformance.json` against the Rust owner of the panels: `RustMcpUi`'s mailbox
//! over its own lease table. The same file runs against Node `McpUiAppToolRegistry` with `McpUiInstances`
//! (`apps/zcode-cli/packages/bootstrap/tests/fork-rust-helper/mcp-ui-app-tools-conformance.test.ts`); both must produce
//! every expected outcome.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp_app::{
    McpAppConnection, McpAppError, McpAppHost, McpAppOwner, McpAppSubscription,
};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::super::mcp_ui_lease::{Binding, Connection, Lease, UNAUTHORIZED};
use super::super::mcp_ui_rust::RustMcpUi;
use super::super::node_helper::HelperRequests;
use super::Timing;

const FIXTURE: &str = include_str!("../../tests/fixtures/mcp_ui_app_tools_conformance.json");

/// The server's connection, as the extension layer reports it.
struct Host {
    current: Mutex<Connection>,
}

#[async_trait]
impl McpAppHost for Host {
    fn owner(&self, _session: &SessionId, server: &str) -> Option<McpAppOwner> {
        (server == "s1").then_some(McpAppOwner::Rust)
    }

    fn connection(&self, _session: &SessionId, _server: &str) -> Option<McpAppConnection> {
        let current = self.current.lock().unwrap();
        Some(McpAppConnection {
            identity: current.identity.clone(),
            generation: current.generation,
        })
    }

    async fn wait_connection(
        &self,
        session: &SessionId,
        server: &str,
        _cancel: &CancellationToken,
    ) -> Option<McpAppConnection> {
        self.connection(session, server)
    }

    fn on_connection_changed(
        &self,
        _session: &SessionId,
        _server: &str,
        _callback: Arc<dyn Fn() + Send + Sync>,
    ) -> Option<McpAppSubscription> {
        Some(Box::new(()))
    }

    fn tool_visibility(
        &self,
        _session: &SessionId,
        _server: &str,
        _tool: &str,
    ) -> Option<Vec<String>> {
        Some(vec!["app".to_owned()])
    }

    async fn request(
        &self,
        _session: &SessionId,
        _server: &str,
        _expected: &McpAppConnection,
        _method: &str,
        _params: Value,
        _cancel: &CancellationToken,
    ) -> Result<Value, McpAppError> {
        Err(McpAppError::Failed {
            code: None,
            message: "the conformance run makes no server request".to_owned(),
        })
    }
}

/// Records the `pluginUi.*` deltas the owner sends.
#[derive(Default)]
struct Recorder {
    deltas: Mutex<Vec<Value>>,
}

#[async_trait]
impl HelperRequests for Recorder {
    async fn authorize_app_tool(
        &self,
        _params: Value,
        _cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    async fn sample_model(
        &self,
        _params: Value,
        _cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    async fn session_workspace(&self, _session: &str) -> Option<Value> {
        None
    }

    fn session_delta(&self, _session: &str, delta: Value) {
        self.deltas.lock().unwrap().push(delta);
    }
}

impl Recorder {
    /// The model calls published so far (not the activity or cancel messages).
    fn published_calls(&self) -> Vec<String> {
        self.deltas
            .lock()
            .unwrap()
            .iter()
            .filter(|delta| {
                delta["op"] == "pluginUi.appToolCall"
                    && delta.get("activity").is_none()
                    && delta.get("cancelled").is_none()
            })
            .map(|delta| delta["callId"].as_str().unwrap_or_default().to_owned())
            .collect()
    }
}

/// A model call of the run: its task, and the call id the panel was published.
struct Call {
    task: JoinHandle<Result<Value, String>>,
}

/// The outcome word of a call's failure, by the texts the registry uses (the same words as the Node runner).
fn classify(message: &str) -> &'static str {
    if message.contains("cancelled") {
        "cancelled"
    } else if message.contains("timed out") {
        "timedOut"
    } else if message.contains("not running") || message.contains("not available") {
        "notRunning"
    } else if message.contains("closed") || message.contains("reloaded") {
        "closed"
    } else {
        "error"
    }
}

/// The outcome word of a registration. Only a refusal of the wire schema (invalid params, as Node's `parseParams` gives)
/// is `refused`; any other error keeps its message, as the other steps report theirs.
fn register_outcome(result: Result<Value, RpcError>) -> String {
    match result {
        Ok(answer) => {
            let names: Vec<&str> = answer["tools"]
                .as_array()
                .expect("tools")
                .iter()
                .map(|tool| tool["modelName"].as_str().expect("model name"))
                .collect();
            format!("registered:{}", names.join(","))
        }
        Err(error) if error.code == rust_cli_protocol_core::rpc::codes::INVALID_PARAMS => {
            "refused".to_owned()
        }
        Err(error) => format!("error:{}", error.message),
    }
}

fn lease_json(lease: &Lease) -> Value {
    json!({
        "runtimeId": lease.runtime_id,
        "generation": lease.generation,
        "token": lease.token,
        "appIdentity": lease.app_identity,
    })
}

/// The page's request on a lease: its scope, generation and instance, as the wire carries them.
fn request(lease: &Lease, extra: Value) -> Value {
    let mut params = json!({
        "workspace": {"workspacePath": "/w", "workspaceKey": "/w"},
        "sessionId": "app",
        "pluginId": "p",
        "serverName": "s1",
        "instance": lease_json(lease),
        "scopeId": lease.token,
        "generation": lease.generation,
    });
    if let (Some(base), Some(more)) = (params.as_object_mut(), extra.as_object()) {
        for (key, value) in more {
            base.insert(key.clone(), value.clone());
        }
    }
    params
}

struct Runner {
    ui: Arc<RustMcpUi>,
    host: Arc<Host>,
    recorder: Arc<Recorder>,
    leases: BTreeMap<String, Lease>,
    calls: BTreeMap<String, Call>,
    /// Call alias -> the call id it was published with. Kept after the call is collected.
    call_ids: BTreeMap<String, Option<String>>,
}

impl Runner {
    fn lease(&self, step: &Value, key: &str) -> Lease {
        let alias = step[key].as_str().expect("lease alias");
        self.leases
            .get(alias)
            .unwrap_or_else(|| panic!("unknown lease alias {alias}"))
            .clone()
    }

    fn session_of(step: &Value) -> SessionId {
        SessionId::new(step["session"].as_str().expect("session"))
    }

    /// The outcome word of a request's error.
    fn refusal(error: &RpcError) -> &'static str {
        if error.message == UNAUTHORIZED {
            "unauthorized"
        } else {
            "error"
        }
    }

    fn call_id(&self, step: &Value) -> String {
        let alias = step["call"].as_str().expect("call alias");
        self.call_ids[alias]
            .clone()
            .unwrap_or_else(|| panic!("call {alias} was not published"))
    }

    async fn run(&mut self, step: &Value) -> String {
        match step["op"].as_str().expect("op") {
            "openPanel" => {
                let binding = Binding {
                    workspace: "/w".to_owned(),
                    account_context: None,
                    session_id: step["session"].as_str().expect("session").to_owned(),
                    plugin_id: "p".to_owned(),
                    server_name: step["server"].as_str().expect("server").to_owned(),
                    scope_id: step["scope"].as_str().expect("scope").to_owned(),
                    resource_uri: "ui://a".to_owned(),
                    owner_web_contents_id: 7,
                };
                let source = {
                    let current = self.host.current.lock().unwrap();
                    Connection {
                        identity: current.identity.clone(),
                        generation: current.generation,
                    }
                };
                let lease = self.ui.instances.open(binding, &source);
                let alias = step["as"].as_str().expect("as").to_owned();
                self.leases.insert(alias, lease);
                "opened".to_owned()
            }
            "closePanel" => {
                let lease = self.lease(step, "lease");
                let closed = self.ui.instances.close(&lease);
                if closed {
                    self.ui
                        .drop_lease_tools(&lease.token, lease.generation, "App page was closed");
                }
                if closed { "closed" } else { "not-closed" }.to_owned()
            }
            "register" => {
                let lease = self.lease(step, "lease");
                let mut tools: Vec<Value> = match step.get("descriptors") {
                    Some(descriptors) => descriptors.as_array().expect("descriptors").clone(),
                    None => step["tools"]
                        .as_array()
                        .expect("tools")
                        .iter()
                        .map(|name| json!({"name": name, "inputSchema": {"type": "object"}}))
                        .collect(),
                };
                if let Some(pad) = step["padOutputSchemaBytes"].as_u64() {
                    tools[0]["outputSchema"]["description"] = json!("x".repeat(pad as usize));
                }
                let mut instance = lease_json(&lease);
                if let Some(fields) = step["instanceFields"].as_object() {
                    for (key, value) in fields {
                        instance[key] = value.clone();
                    }
                }
                let params = request(&lease, json!({"tools": tools, "instance": instance}));
                register_outcome(self.ui.register_app_tools("app", &params))
            }
            "exposed" => {
                let names: Vec<String> = self
                    .ui
                    .exposed_tools("app")
                    .into_iter()
                    .map(|spec| spec.model_name)
                    .collect();
                format!("exposed:{}", names.join(","))
            }
            "unregister" => {
                let lease = self.lease(step, "lease");
                match self
                    .ui
                    .unregister_app_tools("app", &request(&lease, json!({})))
                {
                    Ok(answer) => format!("removed:{}", answer["removed"]),
                    Err(error) => format!("error:{}", error.message),
                }
            }
            "call" => {
                let alias = step["as"].as_str().expect("as").to_owned();
                let tool = step["tool"].as_str().expect("tool").to_owned();
                let arguments = step["arguments"].clone();
                let before = self.recorder.published_calls().len();
                let ui = self.ui.clone();
                let tool_call = format!("tool-use-{alias}");
                let task =
                    tokio::spawn(
                        async move { ui.app_call("app", &tool_call, &tool, arguments).await },
                    );
                let mut outcome = "started";
                for _ in 0..400 {
                    if task.is_finished() {
                        outcome = "not-running";
                        break;
                    }
                    if self.recorder.published_calls().len() > before {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                let call_id = self.recorder.published_calls().get(before).cloned();
                self.call_ids.insert(alias.clone(), call_id);
                self.calls.insert(alias, Call { task });
                outcome.to_owned()
            }
            "claim" => {
                let lease = self.lease(step, "lease");
                let call_id = self.call_id(step);
                let params = request(&lease, json!({"callId": call_id}));
                match self.ui.claim_app_tool_call(
                    self.host.as_ref(),
                    &Self::session_of(step),
                    &params,
                ) {
                    Ok(answer) if answer["accepted"] == json!(true) => "accepted".to_owned(),
                    Ok(_) => "rejected".to_owned(),
                    Err(error) => Self::refusal(&error).to_owned(),
                }
            }
            "resolve" => {
                let lease = self.lease(step, "lease");
                let call_id = self.call_id(step);
                let params = request(&lease, json!({"callId": call_id, "result": step["result"]}));
                match self.ui.resolve_app_tool_call(
                    self.host.as_ref(),
                    &Self::session_of(step),
                    &params,
                ) {
                    Ok(answer) if answer["accepted"] == json!(true) => "accepted".to_owned(),
                    Ok(_) => "rejected".to_owned(),
                    Err(error) => Self::refusal(&error).to_owned(),
                }
            }
            "cancelCall" => {
                let alias = step["call"].as_str().expect("call");
                self.calls[alias].task.abort();
                "ok".to_owned()
            }
            "collectCall" => {
                let alias = step["call"].as_str().expect("call");
                let call = self.calls.remove(alias).expect("a call of that alias");
                match call.task.await {
                    Ok(Ok(_)) => "done".to_owned(),
                    Ok(Err(message)) => classify(&message).to_owned(),
                    Err(join) if join.is_cancelled() => "cancelled".to_owned(),
                    Err(join) => panic!("the call task failed: {join}"),
                }
            }
            other => panic!("unknown op {other}"),
        }
    }
}

#[tokio::test]
async fn the_rust_app_tool_mailbox_matches_the_shared_conformance_sequence() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture parses");
    let server = &fixture["server"];
    let host = Arc::new(Host {
        current: Mutex::new(Connection {
            identity: server["identity"].as_str().expect("identity").to_owned(),
            generation: server["generation"].as_u64().expect("generation"),
        }),
    });
    let recorder = Arc::new(Recorder::default());
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&recorder) as _;
    let timing = Timing::default();
    let ui = RustMcpUi::with_timing(weak, timing);
    let mut runner = Runner {
        ui,
        host,
        recorder,
        leases: BTreeMap::new(),
        calls: BTreeMap::new(),
        call_ids: BTreeMap::new(),
    };
    let mut mismatches = Vec::new();
    for (index, step) in fixture["steps"]
        .as_array()
        .expect("steps")
        .iter()
        .enumerate()
    {
        let expected = step["expect"].as_str().expect("expect");
        let actual = runner.run(step).await;
        if actual != expected {
            mismatches.push(format!(
                "step {index} ({}): expected {expected}, got {actual}",
                step["op"]
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "conformance mismatches:\n{}",
        mismatches.join("\n")
    );
}

#[test]
fn a_schema_refusal_is_refused_and_any_other_registration_error_is_reported_as_such() {
    assert_eq!(
        register_outcome(Err(RpcError::invalid_params("tool title is not a string"))),
        "refused"
    );
    assert_eq!(
        register_outcome(Err(RpcError::internal(
            "Invalid MCP App registration binding"
        ))),
        "error:Invalid MCP App registration binding"
    );
}
