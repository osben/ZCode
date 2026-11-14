//! Fork: the workspace hook review flow (specs/fork-rust-agent-parity.md, "Workspace hook review flow"), a port of
//! Node `app/workspace-hook-review-controller.ts`: `requestWorkspaceHookReview`, `respondWorkspaceHookReview`,
//! `toggleWorkspaceHookReviewItem` and `revokeWorkspaceHookTrust`.
//!
//! The protocol owns the session's flow (its id, generation, the current immutable request and the session-scoped
//! revocations) and publishes the review as a session-level pending interaction. The hook bundle, the trust store and
//! the `.zcode/config.json` writes belong to the entry point's [`WorkspaceAdmin`]. The commands of a session run one
//! at a time (Node `enqueueMutation`).

use std::collections::{BTreeSet, HashSet};
use std::sync::{Arc, Weak};
use std::time::Duration;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::incognito::{IncognitoKey, excludes};
use rust_cli_protocol_core::sessions::Bridged;
use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;

use super::workspace_trust::{WorkspaceAdmin, WorkspaceTarget, publish};
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::server::Server;

/// Node `WORKSPACE_HOOK_REVIEW_TIMEOUT_MS`.
pub const REVIEW_TIMEOUT_MS: u64 = 600_000;

/// The reason codes of the review commands (Node `WorkspaceHookReasonCode`).
pub mod codes {
    pub const REQUIRE_TRUST_CAPABLE_HOST: &str = "workspace_hooks_require_trust_capable_host";
    pub const SNAPSHOT_MISMATCH: &str = "workspace_hooks_snapshot_mismatch";
    pub const REVIEW_SUPERSEDED: &str = "workspace_hooks_review_superseded";
    pub const TRUST_STORE_CORRUPT: &str = "workspace_hooks_trust_store_corrupt";
    pub const BUNDLE_CHANGED: &str = "workspace_hooks_bundle_changed";
    pub const CONFIG_UNREADABLE: &str = "workspace_hooks_config_unreadable";
    pub const CONFIG_WRITE_FAILED: &str = "workspace_hooks_config_write_failed";
    pub const CONFIG_REBUILD_FAILED: &str = "workspace_hooks_config_rebuild_failed";
}
#[cfg(test)]
use codes::BUNDLE_CHANGED;
pub(crate) use codes::{
    CONFIG_REBUILD_FAILED, CONFIG_UNREADABLE, REQUIRE_TRUST_CAPABLE_HOST, REVIEW_SUPERSEDED,
    SNAPSHOT_MISMATCH, TRUST_STORE_CORRUPT,
};

/// The stored trust of one declaration (Node `WorkspaceHookTrustCoordinator.evaluateSnapshot` without a policy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoredTrust {
    /// A persistent record of this digest.
    Trusted,
    /// A record of the same slot with another digest (Node `stale_digest`).
    StaleSlot,
    Untrusted,
}

/// One declaration of the bundle, in discovery order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewItem {
    pub review_item_id: String,
    pub event: String,
    /// `None` for no matcher or an empty one (Node omits a falsy matcher).
    pub matcher: Option<String>,
    /// `"command"` or `"process"`.
    pub kind: &'static str,
    pub display_command: String,
    /// The declaration's source, relative to the workspace (`sourceRelativePath`).
    pub source_path: String,
    pub resolved_timeout_ms: u64,
    pub resolved_max_output_bytes: u64,
    /// An async command hook.
    pub background: bool,
    pub configured_enabled: bool,
    pub editable: bool,
    pub digest: String,
    pub stored: StoredTrust,
}

/// One project file that declares hooks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewSource {
    pub path: String,
    pub display_path: String,
    pub editable: bool,
}

/// The workspace's hook bundle as discovered now, with its stored trust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewBundle {
    pub identity: String,
    pub bundle_digest: String,
    pub sources: Vec<ReviewSource>,
    pub items: Vec<ReviewItem>,
    /// The trust store exists but cannot be read: every declaration is `blocked_untrusted`.
    pub store_corrupt: bool,
}

/// What a review lookup found in the workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewLookup {
    Bundle(ReviewBundle),
    /// No workspace hook declarations: Node builds no runtime security for the session.
    Nothing,
    /// A config that cannot be read or parsed: nothing can be reviewed or confirmed.
    Unreadable,
}

/// A toggle failure: a reason code before the write, or a rebuild failure after it (Node settles the flow as
/// `configuration_error` then).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleError {
    Rejected(&'static str),
    RebuildFailed,
}

/// A change of the session's review interaction ([`Live::hook_review`]).
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    Put(Value),
    Remove(String),
}

/// The session's review flow (Node `WorkspaceHookReviewFlowRegistry` + the controller's flow fields).
pub(crate) struct SessionReview {
    gate: Semaphore,
    state: std::sync::Mutex<ReviewState>,
}

impl Default for SessionReview {
    fn default() -> Self {
        Self {
            gate: Semaphore::new(1),
            state: std::sync::Mutex::new(ReviewState::default()),
        }
    }
}

#[derive(Default)]
struct ReviewState {
    flow_id: Option<String>,
    run_id: Option<String>,
    generation: u64,
    current: Option<Flow>,
    /// Digests revoked in this session (Node coordinator `revokedKeys`): `revoked` until trusted again.
    revoked: HashSet<String>,
}

struct Flow {
    request: Value,
    pending: bool,
}

impl Flow {
    fn interaction_id(&self) -> &str {
        self.request["interactionId"].as_str().unwrap_or_default()
    }
}

/// What a command leaves to publish, in order.
#[derive(Default)]
struct Outcome {
    changes: Vec<Change>,
    /// A new flow to time out.
    opened: Option<String>,
}

struct Scope<'a> {
    server: &'a Server,
    live: &'a Arc<Bridged<Live>>,
    admin: Arc<dyn WorkspaceAdmin>,
    target: WorkspaceTarget,
    session: String,
}

type Refusal = &'static str;

pub(crate) async fn decide(
    server: &Server,
    live: &Arc<Bridged<Live>>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let refuse = |code: &str| {
        Ack::refused(
            &envelope.command_id,
            Status::Failed,
            code,
            format!("Workspace Hook review command rejected: {code}"),
            revision,
        )
    };
    let session = live.handle.id().as_str().to_owned();
    let payload = &envelope.payload;
    if payload["sessionId"].as_str() != Some(session.as_str()) {
        return refuse(SNAPSHOT_MISMATCH);
    }
    let review = &live.sink.hook_review;
    let Ok(_turn) = review.gate.acquire().await else {
        return refuse(REQUIRE_TRUST_CAPABLE_HOST);
    };
    let Some(scope) = scope(server, live, &session) else {
        return refuse(REQUIRE_TRUST_CAPABLE_HOST);
    };
    let result = match envelope.kind.as_str() {
        "requestWorkspaceHookReview" => request(&scope, payload).await,
        "respondWorkspaceHookReview" => respond(&scope, payload).await,
        "toggleWorkspaceHookReviewItem" => toggle(&scope, payload).await,
        _ if payload.get("reviewItemIds").is_some() => revoke_flow(&scope, payload).await,
        _ => revoke_current(&scope, payload).await,
    };
    match result {
        Ok(()) => Ack::accepted(&envelope.command_id, revision, None),
        Err(code) => refuse(code),
    }
}

/// The session's admin and workspace; `None` when this session cannot review (no trust-capable entry point, an
/// incognito session without hooks, or no workspace).
fn scope<'a>(server: &'a Server, live: &'a Arc<Bridged<Live>>, session: &str) -> Option<Scope<'a>> {
    let admin = server.context.workspace_admin()?;
    if excludes(live.sink.incognito().as_ref(), IncognitoKey::Hooks) {
        return None;
    }
    let path = server.context.workspace_of(session)?;
    Some(Scope {
        server,
        live,
        admin,
        target: WorkspaceTarget::local(&path),
        session: session.to_owned(),
    })
}

/// The bundle a command works on; `unreadable` is the command's code for a config that cannot be read.
async fn bundle(scope: &Scope<'_>, unreadable: Refusal) -> Result<ReviewBundle, Refusal> {
    match scope.admin.hook_review(&scope.target).await {
        ReviewLookup::Bundle(bundle) => Ok(bundle),
        ReviewLookup::Nothing => Err(REQUIRE_TRUST_CAPABLE_HOST),
        ReviewLookup::Unreadable => Err(unreadable),
    }
}

/// `requestWorkspaceHookReview` (Node `requestReview`).
async fn request(scope: &Scope<'_>, payload: &Value) -> Result<(), Refusal> {
    // Node builds no snapshot from a config it cannot read, so no runtime security answers.
    let bundle = bundle(scope, REQUIRE_TRUST_CAPABLE_HOST).await?;
    if !matches_bundle(scope, payload, &bundle) {
        return Err(SNAPSHOT_MISMATCH);
    }
    let mut outcome = Outcome::default();
    {
        let mut state = scope.live.sink.hook_review.state.lock_unpoisoned();
        if !has_pending(&bundle, &state.revoked) {
            if bundle.store_corrupt {
                return Err(TRUST_STORE_CORRUPT);
            }
            return Ok(());
        }
        open_or_reuse(scope, &mut state, &bundle, &mut outcome);
    }
    finish(scope, outcome, false).await;
    Ok(())
}

/// `respondWorkspaceHookReview` (Node `respond`).
async fn respond(scope: &Scope<'_>, payload: &Value) -> Result<(), Refusal> {
    let decision = &payload["decision"];
    if decision["action"] != "trust_selected" {
        return Err(SNAPSHOT_MISMATCH);
    }
    let ids = strings(&decision["reviewItemIds"]).ok_or(SNAPSHOT_MISMATCH)?;
    validate(scope, payload, &ids)?;
    let bundle = bundle(scope, SNAPSHOT_MISMATCH).await?;
    if !matches_bundle(scope, payload, &bundle) {
        return Err(SNAPSHOT_MISMATCH);
    }
    scope
        .admin
        .hook_review_grant(&scope.target, &bundle.bundle_digest, &ids)
        .await?;
    let interaction = text(payload, "interactionId").to_owned();
    {
        let mut state = scope.live.sink.hook_review.state.lock_unpoisoned();
        // Node `coordinator.ts` forgets the session's revocation of a granted declaration.
        for item in bundle
            .items
            .iter()
            .filter(|item| ids.contains(&item.review_item_id))
        {
            state.revoked.remove(&item.digest);
        }
        // A flow that timed out meanwhile still answers accepted: the grant took effect (Node).
        if let Some(flow) = state.current.as_mut()
            && flow.interaction_id() == interaction
        {
            flow.pending = false;
        }
    }
    finish(
        scope,
        Outcome {
            changes: vec![Change::Remove(interaction)],
            opened: None,
        },
        true,
    )
    .await;
    let mut outcome = Outcome::default();
    refresh_after_mutation(scope, &mut outcome).await;
    finish(scope, outcome, false).await;
    Ok(())
}

/// `toggleWorkspaceHookReviewItem` (Node `toggle`).
async fn toggle(scope: &Scope<'_>, payload: &Value) -> Result<(), Refusal> {
    let id = text(payload, "reviewItemId").to_owned();
    let enabled = payload["enabled"].as_bool().ok_or(SNAPSHOT_MISMATCH)?;
    validate(scope, payload, std::slice::from_ref(&id))?;
    let bundle = bundle(scope, CONFIG_UNREADABLE).await?;
    if !bundle
        .items
        .iter()
        .any(|item| item.review_item_id == id && item.editable)
    {
        return Err(SNAPSHOT_MISMATCH);
    }
    let digest = text(payload, "bundleDigest");
    match scope
        .admin
        .hook_review_toggle(&scope.target, digest, &id, enabled)
        .await
    {
        Ok(()) => {}
        Err(ToggleError::Rejected(code)) => return Err(code),
        Err(ToggleError::RebuildFailed) => {
            let interaction = text(payload, "interactionId").to_owned();
            {
                let mut state = scope.live.sink.hook_review.state.lock_unpoisoned();
                if let Some(flow) = state.current.as_mut()
                    && flow.interaction_id() == interaction
                {
                    flow.pending = false;
                }
            }
            finish(
                scope,
                Outcome {
                    changes: vec![Change::Remove(interaction)],
                    opened: None,
                },
                false,
            )
            .await;
            return Err(CONFIG_REBUILD_FAILED);
        }
    }
    let mut outcome = Outcome::default();
    refresh_after_mutation(scope, &mut outcome).await;
    finish(scope, outcome, true).await;
    Ok(())
}

/// `revokeWorkspaceHookTrust` with the flow target (Node `revoke`).
async fn revoke_flow(scope: &Scope<'_>, payload: &Value) -> Result<(), Refusal> {
    let ids = strings(&payload["reviewItemIds"]).ok_or(SNAPSHOT_MISMATCH)?;
    validate(scope, payload, &ids)?;
    let bundle = bundle(scope, SNAPSHOT_MISMATCH).await?;
    if !matches_bundle(scope, payload, &bundle) {
        return Err(SNAPSHOT_MISMATCH);
    }
    let digests = ids
        .iter()
        .map(|id| {
            bundle
                .items
                .iter()
                .find(|item| &item.review_item_id == id)
                .map(|item| item.digest.clone())
                .ok_or(SNAPSHOT_MISMATCH)
        })
        .collect::<Result<Vec<_>, _>>()?;
    apply_revoke(scope, digests).await
}

/// `revokeWorkspaceHookTrust` with the current-bundle target (Node `revokeCurrent`).
async fn revoke_current(scope: &Scope<'_>, payload: &Value) -> Result<(), Refusal> {
    if payload.get("remoteSessionId").is_some() {
        return Err(SNAPSHOT_MISMATCH);
    }
    let bundle = bundle(scope, SNAPSHOT_MISMATCH).await?;
    if !matches_bundle(scope, payload, &bundle) {
        return Err(SNAPSHOT_MISMATCH);
    }
    let digests: Vec<String> = strings(&payload["hookDeclarationDigests"])
        .ok_or(SNAPSHOT_MISMATCH)?
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let known = digests
        .iter()
        .all(|digest| bundle.items.iter().any(|item| &item.digest == digest));
    if digests.is_empty() || !known {
        return Err(SNAPSHOT_MISMATCH);
    }
    apply_revoke(scope, digests).await
}

/// Node `applyWorkspaceHookRevoke`, then `refreshPendingFlow` and the banner.
async fn apply_revoke(scope: &Scope<'_>, digests: Vec<String>) -> Result<(), Refusal> {
    scope
        .admin
        .hook_review_revoke(&scope.target, &digests)
        .await?;
    let mut outcome = Outcome::default();
    {
        let mut state = scope.live.sink.hook_review.state.lock_unpoisoned();
        state.revoked.extend(digests);
    }
    refresh_after_mutation(scope, &mut outcome).await;
    finish(scope, outcome, true).await;
    Ok(())
}

/// Node `refreshPendingFlow` after an accepted mutation, from the bundle rediscovered now. Node refreshes from its
/// session snapshot; without one, a bundle that can no longer be discovered closes the pending flow, so the UI keeps no
/// actions on a bundle that does not exist.
async fn refresh_after_mutation(scope: &Scope<'_>, outcome: &mut Outcome) {
    let rediscovered = bundle(scope, CONFIG_UNREADABLE).await;
    let mut state = scope.live.sink.hook_review.state.lock_unpoisoned();
    match rediscovered {
        Ok(bundle) => refresh_pending(scope, &mut state, &bundle, outcome),
        Err(code) => {
            tracing::warn!(
                reason = code,
                "the workspace hook bundle could not be rediscovered after a trust change"
            );
            if let Some(flow) = state.current.as_mut().filter(|flow| flow.pending) {
                flow.pending = false;
                outcome
                    .changes
                    .push(Change::Remove(flow.interaction_id().to_owned()));
            }
        }
    }
}

/// Node `WorkspaceHookReviewFlowRegistry.validate`: the target names the current pending flow, and its items.
fn validate(scope: &Scope<'_>, payload: &Value, ids: &[String]) -> Result<(), Refusal> {
    let state = scope.live.sink.hook_review.state.lock_unpoisoned();
    let Some(flow) = state.current.as_ref() else {
        return Err(REVIEW_SUPERSEDED);
    };
    let request = &flow.request;
    let same = |key: &str| request[key] == payload[key];
    let current = same("reviewFlowId") && same("generation") && same("interactionId");
    if !current || !flow.pending {
        return Err(REVIEW_SUPERSEDED);
    }
    let snapshot = [
        "sessionId",
        "taskId",
        "runId",
        "remoteSessionId",
        "workspaceIdentity",
    ]
    .into_iter()
    .all(|key| request.get(key) == payload.get(key))
        && same("bundleDigest");
    if !snapshot {
        return Err(SNAPSHOT_MISMATCH);
    }
    let known: HashSet<&str> = request["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["reviewItemId"].as_str())
        .collect();
    if ids.iter().any(|id| !known.contains(id.as_str())) {
        return Err(SNAPSHOT_MISMATCH);
    }
    Ok(())
}

/// The target names this session's workspace and the bundle on disk. The App sends the session's workspace key, as
/// the review publishes it; the bundle's own identity is the trust store's key, which the entry point resolves (Node
/// `resolveTargetTrustIdentity`).
fn matches_bundle(scope: &Scope<'_>, payload: &Value, bundle: &ReviewBundle) -> bool {
    payload["workspaceIdentity"].as_str() == Some(scope.target.key.as_str())
        && payload["bundleDigest"].as_str() == Some(bundle.bundle_digest.as_str())
}

/// The declaration's trust state now (Node `evaluateSnapshot`; the policy is `user_decides`).
fn trust_state(
    item: &ReviewItem,
    bundle: &ReviewBundle,
    revoked: &HashSet<String>,
) -> &'static str {
    if bundle.store_corrupt {
        return "blocked_untrusted";
    }
    match item.stored {
        StoredTrust::Trusted => "trusted_persistent",
        _ if revoked.contains(&item.digest) => "revoked",
        StoredTrust::StaleSlot => "stale_digest",
        StoredTrust::Untrusted => "pending_trust",
    }
}

fn is_pending(state: &str) -> bool {
    matches!(state, "pending_trust" | "revoked" | "stale_digest")
}

fn has_pending(bundle: &ReviewBundle, revoked: &HashSet<String>) -> bool {
    bundle
        .items
        .iter()
        .any(|item| is_pending(trust_state(item, bundle, revoked)))
}

/// Node `openOrReuseFlow`: the pending flow of the same bundle stays; otherwise the next generation opens.
fn open_or_reuse(
    scope: &Scope<'_>,
    state: &mut ReviewState,
    bundle: &ReviewBundle,
    outcome: &mut Outcome,
) {
    if let Some(flow) = state.current.as_ref()
        && flow.pending
        && flow.request["bundleDigest"] == bundle.bundle_digest.as_str()
    {
        return;
    }
    let flow_id = state
        .flow_id
        .get_or_insert_with(|| format!("workspace-hook-review:{}", crate::ids::uuid_v4()))
        .clone();
    let generation = state.generation + 1;
    let request = build_request(scope, state, bundle, &flow_id, generation);
    open(state, request, outcome);
}

/// Node `refreshPendingFlow`: a pending flow is superseded by the next generation of the new state (and closed at
/// once when nothing is pending any more); without one, a new flow opens when declarations are pending.
fn refresh_pending(
    scope: &Scope<'_>,
    state: &mut ReviewState,
    bundle: &ReviewBundle,
    outcome: &mut Outcome,
) {
    let superseded = match state.current.as_ref() {
        Some(flow) if flow.pending => flow.interaction_id().to_owned(),
        _ => {
            if has_pending(bundle, &state.revoked) {
                open_or_reuse(scope, state, bundle, outcome);
            }
            return;
        }
    };
    let flow_id = state.flow_id.clone().unwrap_or_default();
    let generation = state.generation + 1;
    let request = build_request(scope, state, bundle, &flow_id, generation);
    let nothing_pending = request["summary"]["pendingCount"] == 0;
    outcome.changes.push(Change::Remove(superseded));
    open(state, request, outcome);
    if nothing_pending {
        if let Some(flow) = state.current.as_mut() {
            flow.pending = false;
            outcome
                .changes
                .push(Change::Remove(flow.interaction_id().to_owned()));
        }
        outcome.opened = None;
    }
}

fn open(state: &mut ReviewState, request: Value, outcome: &mut Outcome) {
    state.generation = request["generation"]
        .as_u64()
        .unwrap_or(state.generation + 1);
    let interaction = interaction(&request);
    outcome.opened = Some(
        request["interactionId"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    );
    outcome.changes.push(Change::Put(interaction));
    state.current = Some(Flow {
        request,
        pending: true,
    });
}

/// Node `buildWorkspaceHookReviewRequest` (`workspaceHookReviewRequestPayloadSchema`).
fn build_request(
    scope: &Scope<'_>,
    state: &mut ReviewState,
    bundle: &ReviewBundle,
    flow_id: &str,
    generation: u64,
) -> Value {
    let created_at = scope.server.context.now();
    let run_id = state
        .run_id
        .get_or_insert_with(|| {
            format!(
                "workspace-hook-run:{}:{}",
                scope.session,
                crate::ids::uuid_v4()
            )
        })
        .clone();
    let items: Vec<Value> = bundle
        .items
        .iter()
        .map(|item| {
            let mut entry = Map::new();
            entry.insert("reviewItemId".into(), json!(item.review_item_id));
            entry.insert("event".into(), json!(item.event));
            if let Some(matcher) = &item.matcher {
                entry.insert("matcher".into(), json!(matcher));
            }
            entry.insert("type".into(), json!(item.kind));
            let name = item.matcher.as_ref().map_or_else(
                || item.event.clone(),
                |matcher| format!("{} · {matcher}", item.event),
            );
            entry.insert("displayName".into(), json!(name));
            entry.insert("displayCommand".into(), json!(item.display_command));
            entry.insert("sourcePath".into(), json!(item.source_path));
            entry.insert("resolvedTimeoutMs".into(), json!(item.resolved_timeout_ms));
            entry.insert(
                "resolvedMaxOutputBytes".into(),
                json!(item.resolved_max_output_bytes),
            );
            let mode = if item.kind == "command" && item.background {
                "background"
            } else {
                "foreground"
            };
            entry.insert("executionMode".into(), json!(mode));
            entry.insert("configuredEnabled".into(), json!(item.configured_enabled));
            entry.insert("editable".into(), json!(item.editable));
            entry.insert(
                "trustState".into(),
                json!(trust_state(item, bundle, &state.revoked)),
            );
            Value::Object(entry)
        })
        .collect();
    let events: HashSet<&str> = bundle
        .items
        .iter()
        .map(|item| item.event.as_str())
        .collect();
    let pending = items
        .iter()
        .filter(|item| is_pending(item["trustState"].as_str().unwrap_or_default()))
        .count();
    let label = scope
        .target
        .key
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(scope.target.key.as_str());
    json!({
        "kind": "workspaceHookReview",
        "reviewFlowId": flow_id,
        "generation": generation,
        "interactionId": format!("workspace-hook-interaction:{}", crate::ids::uuid_v4()),
        "sessionId": scope.session,
        "taskId": scope.session,
        "runId": run_id,
        "workspaceIdentity": scope.target.key,
        "workspaceLabel": label,
        "bundleDigest": bundle.bundle_digest,
        "createdAt": created_at,
        "deadlineAt": created_at + REVIEW_TIMEOUT_MS,
        "sourceFiles": bundle.sources.iter().map(|source| json!({
            "path": source.path,
            "displayPath": source.display_path,
            "editable": source.editable,
        })).collect::<Vec<_>>(),
        "summary": {
            "eventCount": events.len(),
            "hookCount": items.len(),
            "pendingCount": pending,
        },
        "items": items,
        "warningCode": "workspace_hooks_execute_code",
    })
}

/// The pending interaction of a request (Node `onWorkspaceHookReviewRequested`): session-level, no auto resolution.
fn interaction(request: &Value) -> Value {
    json!({
        "interactionId": request["interactionId"],
        "kind": "workspaceHookReview",
        "anchorRowId": null,
        "createdAt": request["createdAt"],
        "payload": request,
    })
}

/// Publishes the changes in the session's pump, then (when `banner`) the session's banners, and times out a new flow.
async fn finish(scope: &Scope<'_>, outcome: Outcome, banner: bool) {
    for change in outcome.changes {
        let sink = scope.live.sink.clone();
        scope
            .live
            .run(Box::pin(async move { sink.hook_review(change).await }));
    }
    if banner {
        let ticket = scope.live.sink.admission_ticket();
        let admission = scope.admin.admission(&scope.target).await;
        publish(scope.live, admission, ticket);
    }
    if let Some(interaction) = outcome.opened {
        let weak = Arc::downgrade(scope.live);
        drop(scope.server.spawner.spawn(
            "workspace-hook-review-deadline",
            deadline(weak, interaction),
        ));
    }
}

/// The flow's deadline (Node registry deadline timer + supervisor): a review still pending is settled `timed_out`.
async fn deadline(live: Weak<Bridged<Live>>, interaction: String) {
    tokio::time::sleep(Duration::from_millis(REVIEW_TIMEOUT_MS)).await;
    let Some(live) = live.upgrade() else {
        return;
    };
    {
        let mut state = live.sink.hook_review.state.lock_unpoisoned();
        match state.current.as_mut() {
            Some(flow) if flow.pending && flow.interaction_id() == interaction => {
                flow.pending = false;
            }
            _ => return,
        }
    }
    let sink = live.sink.clone();
    live.run(Box::pin(async move {
        sink.hook_review(Change::Remove(interaction)).await;
    }));
}

fn text<'a>(payload: &'a Value, key: &str) -> &'a str {
    payload[key].as_str().unwrap_or_default()
}

fn strings(value: &Value) -> Option<Vec<String>> {
    let list = value.as_array()?;
    let strings: Vec<String> = list
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect::<Option<_>>()?;
    (!strings.is_empty()).then_some(strings)
}

#[cfg(test)]
#[path = "hook_review_tests.rs"]
mod tests;
