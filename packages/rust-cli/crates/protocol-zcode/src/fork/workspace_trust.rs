//! Fork: workspace trust from the App (specs/fork-rust-agent-parity.md, "Workspace MCP trust, the MCP settings list
//! and Hook trust grants"): `mcp/list`, `workspace/mcp/trust`, `workspace/hooks/trustGrant`, `mcp/readResource`, and
//! the session banners `workspaceMcpAdmission` / `workspaceHookAdmission`.
//!
//! The trust records, the config reads and the settings-lane MCP connections belong to the entry point, which
//! implements [`WorkspaceAdmin`] and sets it on the [`crate::Context`]. Without one the three workspace methods are not
//! ported (`-32601`), as before. The protocol owns only the banners: each session's projection keeps the last
//! published payload, so a snapshot (desktop subscribe or a mobile replay) carries the same state as the deltas.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_protocol_core::rpc::RpcError;
use rust_cli_protocol_core::sessions::Bridged;
use serde_json::{Value, json};

use super::hook_review::REQUIRE_TRUST_CAPABLE_HOST;
pub use super::hook_review::{
    ReviewBundle, ReviewItem, ReviewLookup, ReviewSource, StoredTrust, ToggleError,
};
use crate::live::Live;
use crate::server::{Server, kernel_error};

/// The workspace of a request (`zcodeWorkspaceRefSchema`): identity for trust, path for files, key for the
/// settings lane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceTarget {
    pub path: String,
    pub identity: Option<String>,
    pub key: String,
}

impl WorkspaceTarget {
    fn from_params(params: &Value) -> Result<Self, RpcError> {
        let workspace = &params["workspace"];
        let path = workspace["workspacePath"]
            .as_str()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| RpcError::invalid_params("workspace.workspacePath is required"))?
            .to_owned();
        let identity = workspace["workspaceIdentity"].as_str().map(str::to_owned);
        let key = workspace["workspaceKey"]
            .as_str()
            .filter(|key| !key.is_empty())
            .map_or_else(|| path.clone(), str::to_owned);
        Ok(Self {
            path,
            identity,
            key,
        })
    }

    /// A session's workspace (local sessions carry only the path).
    pub fn local(path: &str) -> Self {
        Self {
            path: path.to_owned(),
            identity: None,
            key: path.to_owned(),
        }
    }
}

/// The two banner payloads of a workspace. For MCP, `None` means the review list could not be built (a declaration
/// without a display, Node's `inspect()` throw) and leaves the published banner as it is; for hooks, `None` is
/// "nothing pending" and clears the banner.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Admission {
    /// `{pendingCount, bundleDigest, workspaceIdentity}`; published even with `pendingCount: 0` once a banner
    /// was shown (Node clears it with `null`).
    pub mcp: Option<Value>,
    /// `{pendingCount, bundleDigest, workspaceIdentity?}` with `pendingCount > 0`.
    pub hook: Option<Value>,
}

/// What the entry point provides (the cli owns config reads, trust stores and the settings-lane MCP manager).
#[async_trait]
pub trait WorkspaceAdmin: Send + Sync {
    /// `mcp/list`: `{statuses}` (`zcodeMcpListResultSchema`). `servers` is the Host's `mcpServers` when given.
    async fn mcp_list(
        &self,
        target: &WorkspaceTarget,
        servers: Option<&[Value]>,
        connect: bool,
    ) -> Result<Value, String>;
    /// `workspace/mcp/trust`: `{accepted: true}` or `{accepted: false, reasonCode}`.
    async fn mcp_trust(
        &self,
        target: &WorkspaceTarget,
        server: &str,
        digest: &str,
        trusted: bool,
    ) -> Value;
    /// `workspace/hooks/trustGrant`: `{accepted: true}` or `{accepted: false, reasonCode}`. An accepted grant
    /// already rebuilt the process's hook snapshot.
    async fn hook_trust_grant(
        &self,
        target: &WorkspaceTarget,
        bundle_digest: &str,
        declaration_digest: &str,
    ) -> Value;
    /// The banners of a workspace now.
    async fn admission(&self, target: &WorkspaceTarget) -> Admission;
    /// The workspace's hook bundle and its stored trust for a review (`fork/hook_review.rs`), or why there is none.
    async fn hook_review(&self, _target: &WorkspaceTarget) -> ReviewLookup {
        ReviewLookup::Nothing
    }
    /// Writes the trust records of `review_item_ids` in the bundle `bundle_digest` (Node
    /// `createWorkspaceHookTrustRecords` + `store.grant`); `Err` is the reason code.
    async fn hook_review_grant(
        &self,
        _target: &WorkspaceTarget,
        _bundle_digest: &str,
        _review_item_ids: &[String],
    ) -> Result<(), &'static str> {
        Err(REQUIRE_TRUST_CAPABLE_HOST)
    }
    /// Removes the workspace's records of `digests` (Node `store.revoke`); `Err` is the reason code.
    async fn hook_review_revoke(
        &self,
        _target: &WorkspaceTarget,
        _digests: &[String],
    ) -> Result<(), &'static str> {
        Err(REQUIRE_TRUST_CAPABLE_HOST)
    }
    /// Sets the configured `enabled` of one declaration in the workspace's `.zcode/config.json` (Node
    /// `createWorkspaceHookReviewMutationPort().toggle`).
    async fn hook_review_toggle(
        &self,
        _target: &WorkspaceTarget,
        _bundle_digest: &str,
        _review_item_id: &str,
        _enabled: bool,
    ) -> Result<(), ToggleError> {
        Err(ToggleError::Rejected(REQUIRE_TRUST_CAPABLE_HOST))
    }
}

fn admin(server: &Server) -> Option<Arc<dyn WorkspaceAdmin>> {
    server.context.workspace_admin()
}

fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    params[key]
        .as_str()
        .ok_or_else(|| RpcError::invalid_params(format!("{key} is required")))
}

/// `mcp/list`; `None` without an admin (not ported).
pub(super) async fn mcp_list(server: &Server, params: &Value) -> Option<Result<Value, RpcError>> {
    let admin = admin(server)?;
    let result = async {
        let target = WorkspaceTarget::from_params(params)?;
        let servers = params.get("mcpServers").and_then(Value::as_array);
        let connect = params.get("mode").and_then(Value::as_str) != Some("status");
        admin
            .mcp_list(&target, servers.map(Vec::as_slice), connect)
            .await
            .map_err(RpcError::internal)
    };
    Some(result.await)
}

/// `workspace/mcp/trust`; the banners of the workspace's open sessions refresh after a decision.
pub(super) async fn mcp_trust(server: &Server, params: &Value) -> Option<Result<Value, RpcError>> {
    let admin = admin(server)?;
    let result = async {
        let target = WorkspaceTarget::from_params(params)?;
        let name = text(params, "serverName")?;
        let digest = text(params, "declarationDigest")?;
        let trusted = params["trusted"]
            .as_bool()
            .ok_or_else(|| RpcError::invalid_params("trusted is required"))?;
        let answer = admin.mcp_trust(&target, name, digest, trusted).await;
        if answer["accepted"] == json!(true) {
            refresh_workspace(server, &admin, &target).await;
        }
        Ok(answer)
    };
    Some(result.await)
}

/// `workspace/hooks/trustGrant`.
pub(super) async fn hook_trust_grant(
    server: &Server,
    params: &Value,
) -> Option<Result<Value, RpcError>> {
    let admin = admin(server)?;
    let result = async {
        let target = WorkspaceTarget::from_params(params)?;
        let bundle = text(params, "bundleDigest")?;
        let digest = text(params, "hookDeclarationDigest")?;
        let answer = admin.hook_trust_grant(&target, bundle, digest).await;
        if answer["accepted"] == json!(true) {
            refresh_workspace(server, &admin, &target).await;
        }
        Ok(answer)
    };
    Some(result.await)
}

/// `mcp/readResource`: zcode-rs issues no MCP App instances, so every instance id is unknown. The session check
/// comes first, like Node.
pub(super) async fn read_resource(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let session = super::methods::session_id(params)?;
    server
        .live(&session)
        .await
        .map_err(|error| kernel_error(&error))?;
    Err(RpcError::internal(
        "MCP App instance is no longer authorized",
    ))
}

/// The open sessions in `target`'s workspace re-read their banners (Node `reloadWorkspaceMcpTrust` and the hook
/// grant's reannounce). Sessions are matched by their workspace path, the identity key of local workspaces.
async fn refresh_workspace(
    server: &Server,
    admin: &Arc<dyn WorkspaceAdmin>,
    target: &WorkspaceTarget,
) {
    // The banners depend only on the workspace: one read for all of its sessions. Every ticket is taken before the
    // read, so a read that started earlier for any of them cannot land after this one.
    let matched: Vec<(Arc<Bridged<Live>>, u64)> = server
        .bridge
        .sessions()
        .into_iter()
        .filter(|live| {
            server
                .context
                .workspace_of(live.handle.id().as_str())
                .as_deref()
                == Some(target.path.as_str())
        })
        .map(|live| {
            let ticket = live.sink.admission_ticket();
            (live, ticket)
        })
        .collect();
    if matched.is_empty() {
        return;
    }
    let admission = admin.admission(&WorkspaceTarget::local(&target.path)).await;
    for (live, ticket) in matched {
        publish(&live, admission.clone(), ticket);
    }
}

/// A session's banners after an accepted input, including a new session's first input (Node
/// `refreshWorkspaceTrustAdmission` on each real user input). Node runs that refresh inside the turn, after the input's
/// acknowledgement, so the read runs in the background here: the ack never waits on the configuration and store reads.
/// The ticket is taken now, so a later revalidation that settles first is not overwritten by this older read.
pub(crate) fn refresh_after_input(server: &Server, session: &SessionId) {
    let Some(admin) = admin(server) else {
        return;
    };
    let Some(path) = server.context.workspace_of(session.as_str()) else {
        return;
    };
    let Some(live) = server.bridge.get(session) else {
        return;
    };
    let ticket = live.sink.admission_ticket();
    drop(
        server
            .spawner
            .spawn("workspace-trust-input-refresh", async move {
                let admission = admin.admission(&WorkspaceTarget::local(&path)).await;
                publish(&live, admission, ticket);
            }),
    );
}

/// A stored session's banners when it is opened again; awaited, as Node awaits `refreshWorkspaceTrustAdmission` before
/// `resumeFromStore` completes.
pub(crate) async fn refresh_session(server: &Server, live: &Bridged<Live>, session: &SessionId) {
    let Some(admin) = admin(server) else {
        return;
    };
    let Some(path) = server.context.workspace_of(session.as_str()) else {
        return;
    };
    let ticket = live.sink.admission_ticket();
    let admission = admin.admission(&WorkspaceTarget::local(&path)).await;
    publish(live, admission, ticket);
}

pub(super) fn publish(live: &Bridged<Live>, admission: Admission, ticket: u64) {
    let sink = live.sink.clone();
    live.run(Box::pin(async move {
        sink.set_admission(admission, ticket).await;
    }));
}

#[cfg(test)]
#[path = "workspace_trust_tests.rs"]
pub(super) mod tests;
