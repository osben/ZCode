//! Fork: the MCP App panels of the servers Rust runs itself (specs/fork-rust-node-helper.md, "MCP Apps on Rust-hosted
//! servers (F7)", PR 1). Port of Node `zcode-protocol/mcp-ui/protocol.ts` and `handlers.ts` for the methods of PR 1:
//! `mcp/uiOpenInstance`, `mcp/uiValidateInstance`, `mcp/uiCloseInstance`, `mcp/uiCallTool`, `mcp/uiCancelCall`,
//! `mcp/uiReadResource`, `mcp/uiListResources`, `mcp/uiListResourceTemplates` and `mcp/readResource`; and PR 2's
//! `mcp/uiSampling` and `mcp/uiCancelSampling` (the ledger is [`super::mcp_ui_sampling`]).
//!
//! Owner: [`RustMcpUi`] owns the leases ([`super::mcp_ui_lease::Instances`]), the invalidation subscription of each
//! lease, the table of in-flight UI calls and the sampling ledger. A plugin-host server is helper-hosted and never reaches this module:
//! [`route`] picks the owner by server, through the session's MCP table.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, Weak};

use rust_cli_base::random;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp_app::{
    McpAppConnection, McpAppError, McpAppHost, McpAppOwner, McpAppSubscription,
};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::helper_answers::kernel_error;
use super::helper_sampling;
use super::helper_session_admit::{not_hosted, owns};
use super::mcp_ui_lease::{Binding, Connection, Instances, Lease, Scope};
use super::mcp_ui_sampling::{self, Sampling};
use super::node_helper::HelperRequests;
use crate::server::Server;
use rust_cli_kernel_api::sampling::SamplingCall;

const UI_READ_MAX_BYTES: usize = 8 * 1024 * 1024;

/// The methods this owner answers (Node `protocol.ts`). Everything else on a Rust-run server stays refused.
pub(crate) const METHODS: &[&str] = &[
    "mcp/uiOpenInstance",
    "mcp/uiValidateInstance",
    "mcp/uiCloseInstance",
    "mcp/uiCallTool",
    "mcp/uiCancelCall",
    "mcp/uiReadResource",
    "mcp/uiListResources",
    "mcp/uiListResourceTemplates",
    "mcp/readResource",
    "mcp/uiSampling",
    "mcp/uiCancelSampling",
];

/// Node `MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST`: an entry ending in `/` matches by prefix, otherwise exactly.
const MIME_ALLOWLIST: &[&str] = &[
    "text/",
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/pdf",
    "application/rtf",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/svg+xml",
    "image/gif",
    "image/avif",
    "image/bmp",
    "image/tiff",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/heic",
    "image/heif",
    "audio/mpeg",
    "audio/mp4",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/webm",
    "audio/aac",
    "audio/flac",
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/quicktime",
    "video/mpeg",
    "application/zip",
    "application/gzip",
    "application/x-gzip",
    "application/x-tar",
    "application/x-7z-compressed",
    "application/vnd.rar",
    "font/woff",
    "font/woff2",
    "font/ttf",
    "font/otf",
    "model/gltf+json",
    "model/gltf-binary",
    "application/octet-stream",
];

/// Node `isMcpAppsUiReadResourceMimeAllowed`: the essence (no parameters, lower case) must match an entry.
pub(crate) fn mime_allowed(mime: &str) -> bool {
    let essence = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    !essence.is_empty()
        && MIME_ALLOWLIST.iter().any(|entry| {
            if entry.ends_with('/') {
                essence.starts_with(entry)
            } else {
                essence == *entry
            }
        })
}

/// The decoded size of a base64 string (Node `Buffer.byteLength(blob, "base64")`).
pub(crate) fn base64_decoded_len(blob: &str) -> usize {
    let padding = blob
        .bytes()
        .rev()
        .take_while(|byte| *byte == b'=')
        .count()
        .min(2);
    (blob.len() / 4 * 3).saturating_sub(padding)
}

/// Node `handlers.ts` `boundUiResourceContents`: the mime and size rules of a page-initiated read. Returns the bounded
/// contents without `_meta`, or the reason code and detail of the rejection.
pub(crate) fn bound_contents(
    uri: &str,
    contents: &[Value],
) -> Result<(Vec<Value>, usize), RpcError> {
    let mut bytes = 0;
    let mut bounded = Vec::new();
    for content in contents {
        let item_uri = content
            .get("uri")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or(uri);
        let mime = content.get("mimeType").and_then(Value::as_str);
        if let Some(mime) = mime
            && !mime_allowed(mime)
        {
            return Err(resource_rejected(
                "mime_not_allowed",
                item_uri,
                json!({"mimeType": mime}),
            ));
        }
        if content.get("blob").is_some() && mime.is_none() {
            return Err(resource_rejected(
                "mime_not_allowed",
                item_uri,
                json!({"mimeType": "(missing)"}),
            ));
        }
        if let Some(text) = content.get("text").and_then(Value::as_str) {
            bytes += text.len();
        }
        if let Some(blob) = content.get("blob").and_then(Value::as_str) {
            bytes += base64_decoded_len(blob);
        }
        if bytes > UI_READ_MAX_BYTES {
            return Err(resource_rejected(
                "too_large",
                uri,
                json!({"bytes": bytes, "maxBytes": UI_READ_MAX_BYTES}),
            ));
        }
        let mut item = Map::new();
        item.insert(
            "uri".to_owned(),
            json!(content.get("uri").cloned().unwrap_or(Value::Null)),
        );
        for key in ["mimeType", "text", "blob"] {
            if let Some(value) = content.get(key) {
                item.insert(key.to_owned(), value.clone());
            }
        }
        bounded.push(Value::Object(item));
    }
    Ok((bounded, bytes))
}

/// Node `McpUiResourceRejectedError` (JSON-RPC -32001).
fn resource_rejected(reason: &str, uri: &str, detail: Value) -> RpcError {
    let message = if reason == "too_large" {
        format!(
            "MCP resource \"{uri}\" is {} bytes, exceeding the {} byte limit for plugin UI reads",
            detail["bytes"], detail["maxBytes"]
        )
    } else {
        format!(
            "MCP resource \"{uri}\" has mimeType \"{}\" which is not allowed for plugin UI reads",
            detail["mimeType"].as_str().unwrap_or_default()
        )
    };
    RpcError::new(-32001, message)
        .with_data(json!({"reason": reason, "uri": uri, "detail": detail}))
}

/// Node `McpUiToolAccessError` (JSON-RPC -32602): the tool is missing, or not visible to the page.
pub(crate) fn visibility_error(
    visibility: Option<&[String]>,
    server: &str,
    tool: &str,
) -> Option<RpcError> {
    let (reason, message) = match visibility {
        None => (
            "tool_not_found",
            format!("MCP tool \"{tool}\" is not available on server \"{server}\""),
        ),
        Some(list) if !list.iter().any(|entry| entry == "app") => (
            "tool_not_app_visible",
            format!("MCP tool \"{tool}\" on server \"{server}\" is not visible to plugin UI"),
        ),
        Some(_) => return None,
    };
    Some(RpcError::invalid_params(message).with_data(json!({
        "reason": reason,
        "serverName": server,
        "toolName": tool,
    })))
}

/// The in-flight UI calls and the call ids already used, per session and instance (Node `activeUiToolCalls`,
/// `finishedUiToolCalls`). A `callId` is single-use, so a retry cannot run a second time.
#[derive(Default)]
struct CallTable {
    active: BTreeMap<String, CancellationToken>,
    finished: BTreeSet<String>,
}

/// A panel's lease, with what its close notice names.
struct Panel {
    lease: Lease,
    session: String,
    plugin_id: String,
    server_name: String,
    /// Node `scopeId` plus the resource and owner: one logical panel of one session.
    logical: String,
    /// Drops the connection-change subscription when the lease ends.
    subscription: McpAppSubscription,
}

/// The Rust owner of the panels of Rust-run servers.
pub(crate) struct RustMcpUi {
    me: Weak<Self>,
    answers: Weak<dyn HelperRequests>,
    instances: Instances,
    panels: Mutex<BTreeMap<String, Panel>>,
    calls: Mutex<CallTable>,
    /// The sampling ledger of the panels (F7 PR 2): its operations end with their lease.
    sampling: Sampling,
}

fn random_hex() -> String {
    format!("{:016x}{:016x}", random::u64(), random::u64())
}

impl RustMcpUi {
    pub(crate) fn new(answers: Weak<dyn HelperRequests>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            answers,
            instances: Instances::new(&random_hex()),
            panels: Mutex::new(BTreeMap::new()),
            calls: Mutex::new(CallTable::default()),
            sampling: Sampling::new(),
        })
    }

    /// `pluginUi.*` deltas go to the session stream, in the protocol server's pump order (Node's live-only events).
    fn deliver(&self, session: &str, delta: Value) {
        if let Some(answers) = self.answers.upgrade() {
            answers.session_delta(session, delta);
        }
    }

    /// Node `instanceClosed`: the panel's close notice. Called without locks, so a subscription drop cannot deadlock.
    fn finish_closed(&self, leases: Vec<Lease>) {
        for lease in leases {
            self.sampling.forget(&lease.token);
            let panel = self.panels.lock_unpoisoned().remove(&lease.token);
            if let Some(panel) = panel {
                drop(panel.subscription);
                let delta = json!({
                    "op": "pluginUi.instanceClosed",
                    "pluginId": panel.plugin_id,
                    "serverName": panel.server_name,
                    "subscribers": [{
                        "scopeId": lease.token,
                        "generation": lease.generation,
                        "instance": lease_json(&lease),
                    }],
                });
                self.deliver(&panel.session, delta);
            }
        }
    }

    /// The server's connection changed: the leases of that server in that session are revoked.
    fn connection_changed(&self, session: &str, server: &str) {
        let leases = self.instances.revoke_server(session, server);
        self.finish_closed(leases);
    }

    /// The session closed: its leases end with it.
    pub(crate) fn session_closed(&self, session: &str) {
        let leases = self.instances.close_session(session);
        self.finish_closed(leases);
    }

    /// Routes one of [`METHODS`] for a session and a Rust-run server.
    async fn dispatch(
        &self,
        host: &dyn McpAppHost,
        server: &Server,
        session: &SessionId,
        method: &str,
        params: &Value,
    ) -> Result<Value, RpcError> {
        match method {
            "mcp/uiOpenInstance" => self.open(host, session, params).await,
            "mcp/uiSampling" => self.sample(host, server, session, params).await,
            "mcp/uiCancelSampling" => self.cancel_sampling(host, session, params),
            "mcp/uiValidateInstance" => {
                let scope = Guard::new(params)?;
                self.validate(host, session, &scope, params)?;
                Ok(json!({}))
            }
            "mcp/uiCloseInstance" => self.close(params),
            "mcp/uiCallTool" => self.call_tool(host, session, params).await,
            "mcp/uiCancelCall" => self.cancel_call(params),
            "mcp/uiReadResource" => self.read_for_ui(host, session, params).await,
            "mcp/uiListResources" => {
                self.list(
                    host,
                    session,
                    params,
                    "resources/list",
                    "resources",
                    &["uri", "name", "title", "description", "mimeType", "_meta"],
                )
                .await
            }
            "mcp/uiListResourceTemplates" => {
                self.list(
                    host,
                    session,
                    params,
                    "resources/templates/list",
                    "resourceTemplates",
                    &["uriTemplate", "name", "title", "description", "mimeType"],
                )
                .await
            }
            "mcp/readResource" => self.read_resource(host, session, params).await,
            other => Err(RpcError::internal(format!(
                "unhandled MCP App method {other}"
            ))),
        }
    }

    /// Node `openMcpUiInstance` after the session is ready: a lease on the server's current connection.
    async fn open(
        &self,
        host: &dyn McpAppHost,
        session: &SessionId,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let guard = Guard::new(params)?;
        let server = guard.server.clone();
        let unavailable = || RpcError::new(-32001, "MCP App connection is unavailable");
        // No caller cancel exists for an open: the wait is bounded by the server's connect timeout.
        let source = host
            .wait_connection(session, &server, &CancellationToken::new())
            .await
            .ok_or_else(unavailable)?;
        if host.connection(session, &server).as_ref() != Some(&source) {
            return Err(unavailable());
        }
        let binding = Binding {
            workspace: guard.workspace.clone(),
            account_context: text_opt(params, "accountContext"),
            session_id: guard.session.clone(),
            plugin_id: guard.plugin.clone(),
            server_name: server.clone(),
            scope_id: text(params, "scopeId")?.to_owned(),
            resource_uri: text(params, "resourceUri")?.to_owned(),
            owner_web_contents_id: params
                .get("ownerWebContentsId")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        };
        let logical = format!(
            "{}\u{0}{}\u{0}{}\u{0}{}",
            binding.session_id,
            binding.scope_id,
            binding.resource_uri,
            binding.owner_web_contents_id
        );
        let lease = self.instances.open(binding, &to_connection(&source));
        // Node validates the lease it just opened, against the connection it was opened on.
        let scope = guard.scope();
        self.instances
            .validate(&lease, scope, Some(&to_connection(&source)))
            .map_err(RpcError::internal)?;
        let mut panels = self.panels.lock_unpoisoned();
        // A reopen on a new connection replaced the previous lease of this logical panel: it is closed now.
        let replaced: Vec<String> = panels
            .iter()
            .filter(|(token, panel)| panel.logical == logical && **token != lease.token)
            .map(|(token, _)| token.clone())
            .collect();
        let mut closed = Vec::new();
        for token in replaced {
            if let Some(panel) = panels.remove(&token) {
                closed.push((panel.session.clone(), panel));
            }
        }
        if !panels.contains_key(&lease.token) {
            let me = self.me.clone();
            let session_key = guard.session.clone();
            let server_key = server.clone();
            let callback: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                if let Some(ui) = me.upgrade() {
                    ui.connection_changed(&session_key, &server_key);
                }
            });
            if let Some(subscription) = host.on_connection_changed(session, &server, callback) {
                panels.insert(
                    lease.token.clone(),
                    Panel {
                        lease: lease.clone(),
                        session: guard.session.clone(),
                        plugin_id: guard.plugin.clone(),
                        server_name: server.clone(),
                        logical,
                        subscription,
                    },
                );
            }
        }
        drop(panels);
        for (_, panel) in closed {
            self.instances.close(&panel.lease);
            self.sampling.forget(&panel.lease.token);
            drop(panel.subscription);
            self.deliver(
                &panel.session,
                json!({
                    "op": "pluginUi.instanceClosed",
                    "pluginId": panel.plugin_id,
                    "serverName": panel.server_name,
                    "subscribers": [{
                        "scopeId": panel.lease.token,
                        "generation": panel.lease.generation,
                        "instance": lease_json(&panel.lease),
                    }],
                }),
            );
        }
        Ok(lease_json(&lease))
    }

    /// Node `validate` through the guard: the lease and the scope, against the server's current connection.
    fn validate(
        &self,
        host: &dyn McpAppHost,
        session: &SessionId,
        guard: &Guard,
        params: &Value,
    ) -> Result<super::mcp_ui_lease::Active, RpcError> {
        let lease = lease_of(params)?;
        let current = host
            .connection(session, &guard.server)
            .as_ref()
            .map(to_connection);
        self.instances
            .validate(&lease, guard.scope(), current.as_ref())
            .map_err(RpcError::internal)
    }

    /// Node `closeMcpUiInstance`: validated against the connection the lease was opened on.
    fn close(&self, params: &Value) -> Result<Value, RpcError> {
        let guard = Guard::new(params)?;
        let lease = lease_of(params)?;
        if let Some(source) = self.instances.source_of(&lease.token) {
            self.instances
                .validate(&lease, guard.scope(), Some(&source))
                .map_err(RpcError::internal)?;
        }
        if params.get("onlyIfIdle").and_then(Value::as_bool) == Some(true)
            && self.instances.is_busy(&lease)
        {
            return Ok(json!({"closed": false}));
        }
        let closed = self.instances.close(&lease);
        if closed {
            self.finish_closed(vec![lease]);
        }
        Ok(json!({"closed": closed}))
    }

    /// Node `sampleMcpUi`: the request's limits, then the lease, then one operation of the session's model. The
    /// operation ends with the lease (its cancel is the lease's child), and a pin keeps an idle close from ending it.
    async fn sample(
        &self,
        host: &dyn McpAppHost,
        server: &Server,
        session: &SessionId,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let guard = Guard::new(params)?;
        let lease = lease_of(params)?;
        let operation = operation_id(params)?;
        mcp_ui_sampling::check_request(params.get("request").unwrap_or(&Value::Null))?;
        let call = helper_sampling::parse(params, CancellationToken::new())?;
        let active = self.validate(host, session, &guard, params)?;
        let scope = mcp_ui_sampling::Scope {
            lease: &lease.token,
            session: &guard.session,
            cancel: &active.cancel,
        };
        let admission = self.sampling.admit(&scope, operation)?;
        let session_id = session.clone();
        let request = call.request;
        admission
            .run(move |cancel| async move {
                let _pin = Pinned::retain(&self.instances, &lease.token, operation)?;
                self.validate(host, session, &guard, params)?;
                server.live(session).await.map_err(kernel_error)?;
                let result = server
                    .kernel
                    .sample_model(SamplingCall {
                        session: session_id,
                        request,
                        cancel,
                    })
                    .await;
                self.validate(host, session, &guard, params)?;
                match result {
                    Ok(reply) => {
                        mcp_ui_sampling::check_reply(&reply)?;
                        helper_sampling::answer(Ok(reply))
                    }
                    Err(error) => helper_sampling::answer(Err(error)),
                }
            })
            .await
    }

    /// Node `cancelMcpUiSampling`: the lease is validated, then the operation id is recorded as terminal.
    fn cancel_sampling(
        &self,
        host: &dyn McpAppHost,
        session: &SessionId,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let guard = Guard::new(params)?;
        let lease = lease_of(params)?;
        let operation = operation_id(params)?;
        let active = self.validate(host, session, &guard, params)?;
        let scope = mcp_ui_sampling::Scope {
            lease: &lease.token,
            session: &guard.session,
            cancel: &active.cancel,
        };
        let cancelled = self.sampling.cancel(&scope, operation)?;
        Ok(json!({"cancelled": cancelled}))
    }

    /// Node `callTool`: the tool must be visible to the page; the call runs on the server's current connection and
    /// ends with the lease (its cancel is a child of the lease's).
    async fn call_tool(
        &self,
        host: &dyn McpAppHost,
        session: &SessionId,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let guard = Guard::new(params)?;
        let lease = lease_of(params)?;
        let call_id = text(params, "callId")?;
        let key = call_key(&guard.session, &lease.token, call_id);
        {
            let calls = self.calls.lock_unpoisoned();
            if calls.active.contains_key(&key) || calls.finished.contains(&key) {
                return Err(RpcError::internal("Duplicate MCP App callId"));
            }
        }
        let outcome = self
            .call_inner(host, session, &guard, &lease, params, &key)
            .await;
        {
            let mut calls = self.calls.lock_unpoisoned();
            calls.active.remove(&key);
            calls.finished.insert(key);
        }
        outcome
    }

    async fn call_inner(
        &self,
        host: &dyn McpAppHost,
        session: &SessionId,
        guard: &Guard,
        lease: &Lease,
        params: &Value,
        key: &str,
    ) -> Result<Value, RpcError> {
        let active = self.validate(host, session, guard, params)?;
        let tool = text(params, "toolName")?;
        let visibility = host.tool_visibility(session, &guard.server, tool);
        if let Some(error) = visibility_error(visibility.as_deref(), &guard.server, tool) {
            return Err(error);
        }
        let expected = current_connection(host, session, &guard.server)?;
        let cancel = active.cancel.child_token();
        self.calls
            .lock_unpoisoned()
            .active
            .insert(key.to_owned(), cancel.clone());
        let pin = self
            .instances
            .retain(&lease.token, "ui-call")
            .map_err(RpcError::internal)?;
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let result = host
            .request(
                session,
                &guard.server,
                &expected,
                "tools/call",
                json!({"name": tool, "arguments": arguments}),
                &cancel,
            )
            .await;
        self.instances.release(&lease.token, &pin);
        result.map_err(app_error)
    }

    /// Node `cancelToolCall`: no lease check, as Node. An unknown call is remembered as finished.
    fn cancel_call(&self, params: &Value) -> Result<Value, RpcError> {
        let guard = Guard::new(params)?;
        let lease = lease_of(params)?;
        let key = call_key(&guard.session, &lease.token, text(params, "callId")?);
        let mut calls = self.calls.lock_unpoisoned();
        let cancelled = match calls.active.remove(&key) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        };
        calls.finished.insert(key);
        Ok(json!({"cancelled": cancelled}))
    }

    /// Node `readMcpUiResource` (`mcp/readResource`): the `ui://` read of a bound panel, unbounded as Node.
    async fn read_resource(
        &self,
        host: &dyn McpAppHost,
        session: &SessionId,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let guard = Guard::new(params)?;
        let active = self.validate(host, session, &guard, params)?;
        let uri = text(params, "uri")?;
        if active.resource_uri != uri {
            return Err(RpcError::invalid_params(
                "MCP App resource binding mismatch",
            ));
        }
        self.read(host, session, &guard, uri, &active.cancel).await
    }

    /// Node `readResourceForUi` (`mcp/uiReadResource`): bounded by [`bound_contents`].
    async fn read_for_ui(
        &self,
        host: &dyn McpAppHost,
        session: &SessionId,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let guard = Guard::new(params)?;
        let active = self.validate(host, session, &guard, params)?;
        let uri = text(params, "uri")?;
        let raw = self
            .read(host, session, &guard, uri, &active.cancel)
            .await?;
        let contents = raw
            .get("contents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let (bounded, _) = bound_contents(uri, &contents)?;
        Ok(json!({"contents": bounded}))
    }

    async fn read(
        &self,
        host: &dyn McpAppHost,
        session: &SessionId,
        guard: &Guard,
        uri: &str,
        lease_cancel: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let expected = current_connection(host, session, &guard.server)?;
        let cancel = lease_cancel.child_token();
        host.request(
            session,
            &guard.server,
            &expected,
            "resources/read",
            json!({"uri": uri}),
            &cancel,
        )
        .await
        .map_err(app_error)
    }

    /// Node `listResourcesForUi` / `listResourceTemplatesForUi`: the descriptors the page may see, with the cursor.
    async fn list(
        &self,
        host: &dyn McpAppHost,
        session: &SessionId,
        params: &Value,
        method: &str,
        key: &str,
        fields: &[&str],
    ) -> Result<Value, RpcError> {
        let guard = Guard::new(params)?;
        self.validate(host, session, &guard, params)?;
        let mut request = Map::new();
        if let Some(cursor) = params.get("cursor").and_then(Value::as_str) {
            request.insert("cursor".to_owned(), json!(cursor));
        }
        let expected = current_connection(host, session, &guard.server)?;
        let cancel = CancellationToken::new();
        let raw = host
            .request(
                session,
                &guard.server,
                &expected,
                method,
                Value::Object(request),
                &cancel,
            )
            .await
            .map_err(app_error)?;
        let items: Vec<Value> = raw
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| {
                        let mut out = Map::new();
                        for field in fields {
                            if let Some(value) = item.get(*field) {
                                out.insert((*field).to_owned(), value.clone());
                            }
                        }
                        Value::Object(out)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut out = Map::new();
        out.insert(key.to_owned(), Value::Array(items));
        if let Some(next) = raw.get("nextCursor").and_then(Value::as_str) {
            out.insert("nextCursor".to_owned(), json!(next));
        }
        Ok(Value::Object(out))
    }
}

/// The server's current connection, or the unavailable error when it has none.
fn current_connection(
    host: &dyn McpAppHost,
    session: &SessionId,
    server: &str,
) -> Result<McpAppConnection, RpcError> {
    host.connection(session, server)
        .ok_or_else(|| RpcError::new(-32001, "MCP App connection is unavailable"))
}

/// Node `callMcpUiTool` etc.: the request's shared fields, validated before any work.
struct Guard {
    workspace: String,
    session: String,
    plugin: String,
    server: String,
}

impl Guard {
    fn new(params: &Value) -> Result<Self, RpcError> {
        Ok(Self {
            workspace: workspace_key(params),
            session: text(params, "sessionId")?.to_owned(),
            plugin: text(params, "pluginId")?.to_owned(),
            server: text(params, "serverName")?.to_owned(),
        })
    }

    fn scope(&self) -> Scope<'_> {
        Scope {
            workspace: &self.workspace,
            session_id: &self.session,
            plugin_id: &self.plugin,
            server_name: &self.server,
        }
    }
}

/// The routing decision of one request: `Some` when a Rust-run server of this session names it, `None` when the method
/// is not one of [`METHODS`], names no session or server, or the server is helper-hosted (or unknown) and so keeps its
/// existing path.
pub(crate) async fn route(
    server: &Server,
    method: &str,
    params: &Value,
) -> Option<Result<Value, RpcError>> {
    if !METHODS.contains(&method) {
        return None;
    }
    let session = params
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|session| !session.is_empty())?;
    let name = params.get("serverName").and_then(Value::as_str)?;
    let host = server.context.mcp_app_host()?;
    let ui = server.context.mcp_ui()?.clone();
    let session_id = SessionId::new(session);
    if host.owner(&session_id, name)? != McpAppOwner::Rust {
        return None;
    }
    if !owns(server, &session_id).await {
        return Some(Err(not_hosted("the session is not one of this agent's")));
    }
    Some(
        ui.dispatch(host.as_ref(), server, &session_id, method, params)
            .await,
    )
}

fn app_error(error: McpAppError) -> RpcError {
    match error {
        McpAppError::Cancelled => RpcError::internal("MCP App call cancelled"),
        McpAppError::TimedOut => RpcError::internal("MCP App call timed out"),
        McpAppError::Changed => RpcError::internal("MCP App connection changed"),
        McpAppError::Failed { code, message } => match code {
            Some(code) => RpcError::new(code, message),
            None => RpcError::internal(message),
        },
    }
}

fn call_key(session: &str, token: &str, call_id: &str) -> String {
    format!("{session}\u{0}{token}:{call_id}")
}

/// Node `nonEmptyString.max(128)` on an operation id.
fn operation_id(params: &Value) -> Result<&str, RpcError> {
    let id = text(params, "operationId")?;
    if super::mcp_ui_sampling::utf16_len(id) > 128 {
        return Err(RpcError::invalid_params(
            "operationId is at most 128 characters",
        ));
    }
    Ok(id)
}

/// A pin of one in-flight sampling in its lease (Node `retain`): released when the operation ends, however it ends.
struct Pinned<'a> {
    instances: &'a Instances,
    token: String,
    pin: String,
}

impl<'a> Pinned<'a> {
    fn retain(instances: &'a Instances, token: &str, call_id: &str) -> Result<Self, RpcError> {
        let pin = instances
            .retain(token, call_id)
            .map_err(RpcError::internal)?;
        Ok(Self {
            instances,
            token: token.to_owned(),
            pin,
        })
    }
}

impl Drop for Pinned<'_> {
    fn drop(&mut self) {
        self.instances.release(&self.token, &self.pin);
    }
}

fn to_connection(connection: &McpAppConnection) -> Connection {
    Connection {
        identity: connection.identity.clone(),
        generation: connection.generation,
    }
}

fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| RpcError::invalid_params(format!("{key} is required")))
}

fn text_opt(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Node `params.workspace.workspaceIdentity?.trim() || workspacePath`.
fn workspace_key(params: &Value) -> String {
    let workspace = &params["workspace"];
    workspace["workspaceIdentity"]
        .as_str()
        .map(str::trim)
        .filter(|identity| !identity.is_empty())
        .or_else(|| workspace["workspacePath"].as_str())
        .unwrap_or_default()
        .to_owned()
}

fn lease_of(params: &Value) -> Result<Lease, RpcError> {
    let instance = params
        .get("instance")
        .ok_or_else(|| RpcError::invalid_params("instance is required"))?;
    Ok(Lease {
        runtime_id: text(instance, "runtimeId")?.to_owned(),
        generation: instance
            .get("generation")
            .and_then(Value::as_u64)
            .ok_or_else(|| RpcError::invalid_params("instance.generation is required"))?,
        token: text(instance, "token")?.to_owned(),
        app_identity: text(instance, "appIdentity")?.to_owned(),
    })
}

fn lease_json(lease: &Lease) -> Value {
    json!({
        "runtimeId": lease.runtime_id,
        "generation": lease.generation,
        "token": lease.token,
        "appIdentity": lease.app_identity,
    })
}

#[cfg(test)]
#[path = "mcp_ui_rust_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "mcp_ui_route_tests.rs"]
mod route_tests;
