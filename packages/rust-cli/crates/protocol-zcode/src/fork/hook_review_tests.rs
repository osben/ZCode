//! The workspace hook review flow (specs/fork-rust-agent-parity.md, "Workspace hook review flow"): Node's controller
//! rules for the four commands, the published interaction, and the projection keeping the session-level review.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::{SessionId, TurnId};
use rust_cli_kernel_api::session_api::{KernelEvent, SequencedEvent, TurnOutcome};
use serde_json::{Value, json};

use super::*;
use crate::fork::workspace_trust::Admission;
use crate::fork::workspace_trust::tests::{ROOT, fixture_with, settled};
use crate::projection::Projection;
use crate::projection::state::Followup;

const B1: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const B2: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const D1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const D2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn item(id: &str, digest: &str, event: &str, matcher: Option<&str>) -> ReviewItem {
    ReviewItem {
        review_item_id: id.to_owned(),
        event: event.to_owned(),
        matcher: matcher.map(str::to_owned),
        kind: "command",
        display_command: format!("echo {id}"),
        source_path: ".zcode/config.json".to_owned(),
        resolved_timeout_ms: 60_000,
        resolved_max_output_bytes: 1_048_576,
        background: false,
        configured_enabled: true,
        editable: true,
        digest: digest.to_owned(),
        stored: StoredTrust::Untrusted,
    }
}

fn two_hooks() -> ReviewBundle {
    let mut second = item("r2", D2, "PreToolUse", Some("Bash"));
    second.kind = "process";
    second.display_command = "node hook.js --check".to_owned();
    second.background = true;
    ReviewBundle {
        identity: ROOT.to_owned(),
        bundle_digest: B1.to_owned(),
        sources: vec![ReviewSource {
            path: format!("{ROOT}/.zcode/config.json"),
            display_path: ".zcode/config.json".to_owned(),
            editable: true,
        }],
        items: vec![item("r1", D1, "UserPromptSubmit", None), second],
        store_corrupt: false,
    }
}

/// The entry point double: a bundle that grants, revokes and toggles change, and the calls made.
struct FakeReview {
    bundle: StdMutex<Option<ReviewBundle>>,
    grant: StdMutex<Result<(), &'static str>>,
    toggle: StdMutex<Result<(), ToggleError>>,
    calls: StdMutex<Vec<Value>>,
}

impl FakeReview {
    fn new(bundle: Option<ReviewBundle>) -> Arc<Self> {
        Arc::new(Self {
            bundle: StdMutex::new(bundle),
            grant: StdMutex::new(Ok(())),
            toggle: StdMutex::new(Ok(())),
            calls: StdMutex::new(Vec::new()),
        })
    }

    fn calls(&self) -> Vec<Value> {
        self.calls.lock_unpoisoned().clone()
    }

    fn set_stored(&self, digest: &str, stored: StoredTrust) {
        if let Some(bundle) = self.bundle.lock_unpoisoned().as_mut() {
            for item in &mut bundle.items {
                if item.digest == digest {
                    item.stored = stored;
                }
            }
        }
    }
}

#[async_trait]
impl WorkspaceAdmin for FakeReview {
    async fn mcp_list(
        &self,
        _target: &WorkspaceTarget,
        _servers: Option<&[Value]>,
        _connect: bool,
    ) -> Result<Value, String> {
        Ok(json!({"statuses": []}))
    }

    async fn mcp_trust(&self, _: &WorkspaceTarget, _: &str, _: &str, _: bool) -> Value {
        json!({"accepted": false})
    }

    async fn hook_trust_grant(&self, _: &WorkspaceTarget, _: &str, _: &str) -> Value {
        json!({"accepted": false})
    }

    async fn admission(&self, _target: &WorkspaceTarget) -> Admission {
        let bundle = self.bundle.lock_unpoisoned().clone();
        let pending = bundle.as_ref().map_or(0, |bundle| {
            bundle
                .items
                .iter()
                .filter(|item| item.stored != StoredTrust::Trusted)
                .count()
        });
        self.calls
            .lock_unpoisoned()
            .push(json!({"admission": pending}));
        Admission {
            mcp: None,
            hook: bundle.map(
                |bundle| json!({"pendingCount": pending, "bundleDigest": bundle.bundle_digest}),
            ),
        }
    }

    async fn hook_review(&self, target: &WorkspaceTarget) -> Option<ReviewBundle> {
        assert_eq!(target.path, ROOT);
        self.bundle.lock_unpoisoned().clone()
    }

    async fn hook_review_grant(
        &self,
        _target: &WorkspaceTarget,
        bundle_digest: &str,
        review_item_ids: &[String],
    ) -> Result<(), &'static str> {
        self.calls
            .lock_unpoisoned()
            .push(json!({"grant": review_item_ids, "bundle": bundle_digest}));
        (*self.grant.lock_unpoisoned())?;
        let digests: Vec<String> = self
            .bundle
            .lock_unpoisoned()
            .iter()
            .flat_map(|bundle| bundle.items.iter())
            .filter(|item| review_item_ids.contains(&item.review_item_id))
            .map(|item| item.digest.clone())
            .collect();
        for digest in digests {
            self.set_stored(&digest, StoredTrust::Trusted);
        }
        Ok(())
    }

    async fn hook_review_revoke(
        &self,
        _target: &WorkspaceTarget,
        digests: &[String],
    ) -> Result<(), &'static str> {
        self.calls
            .lock_unpoisoned()
            .push(json!({"revoke": digests}));
        for digest in digests {
            self.set_stored(digest, StoredTrust::Untrusted);
        }
        Ok(())
    }

    async fn hook_review_toggle(
        &self,
        _target: &WorkspaceTarget,
        bundle_digest: &str,
        review_item_id: &str,
        enabled: bool,
    ) -> Result<(), ToggleError> {
        self.calls
            .lock_unpoisoned()
            .push(json!({"toggle": review_item_id, "enabled": enabled, "bundle": bundle_digest}));
        (*self.toggle.lock_unpoisoned())?;
        if let Some(bundle) = self.bundle.lock_unpoisoned().as_mut() {
            bundle.bundle_digest = B2.to_owned();
            for item in &mut bundle.items {
                if item.review_item_id == review_item_id {
                    item.configured_enabled = enabled;
                }
            }
        }
        Ok(())
    }
}

struct Harness {
    _scope: rust_cli_base::TaskScope,
    server: Arc<Server>,
    live: Arc<Bridged<Live>>,
    admin: Arc<FakeReview>,
}

async fn harness(bundle: Option<ReviewBundle>) -> Harness {
    let admin = FakeReview::new(bundle);
    let (scope, server) = fixture_with(Some(admin.clone() as Arc<dyn WorkspaceAdmin>), false);
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    Harness {
        _scope: scope,
        server,
        live,
        admin,
    }
}

impl Harness {
    async fn send(&self, kind: &str, payload: Value) -> Ack {
        let envelope = Envelope {
            command_id: "c1".to_owned(),
            client_id: "client".to_owned(),
            session_id: Some("s1".to_owned()),
            base_revision: None,
            kind: kind.to_owned(),
            payload,
            input_origin: None,
        };
        let ack = decide(&self.server, &self.live, &envelope, 7).await;
        settled(&self.live).await;
        ack
    }

    fn reviews(&self) -> Vec<Value> {
        self.live.sink.snapshot()["pendingInteractions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|pending| pending["kind"] == "workspaceHookReview")
            .cloned()
            .collect()
    }

    fn review(&self) -> Value {
        let reviews = self.reviews();
        assert_eq!(reviews.len(), 1, "one review interaction: {reviews:?}");
        reviews[0].clone()
    }

    async fn open(&self) -> Value {
        let ack = self
            .send(
                "requestWorkspaceHookReview",
                json!({"sessionId": "s1", "workspaceIdentity": ROOT, "bundleDigest": B1}),
            )
            .await;
        assert_eq!(ack.status, Status::Accepted, "{ack:?}");
        self.review()
    }
}

fn refused(ack: &Ack, code: &str) {
    assert_eq!(ack.status, Status::Failed, "{ack:?}");
    assert_eq!(ack.reason_code.as_deref(), Some(code));
    assert_eq!(
        ack.message.as_deref(),
        Some(format!("Workspace Hook review command rejected: {code}").as_str())
    );
    assert_eq!(ack.revision_at_decision, 7);
}

/// The command target of a published review (`workspaceHookReviewCommandTargetSchema`).
fn target(review: &Value) -> Value {
    let request = &review["payload"];
    json!({
        "sessionId": request["sessionId"],
        "taskId": request["taskId"],
        "runId": request["runId"],
        "workspaceIdentity": request["workspaceIdentity"],
        "bundleDigest": request["bundleDigest"],
        "reviewFlowId": request["reviewFlowId"],
        "generation": request["generation"],
        "interactionId": request["interactionId"],
    })
}

fn with(mut target: Value, extra: Value) -> Value {
    if let (Some(target), Some(extra)) = (target.as_object_mut(), extra.as_object()) {
        target.extend(extra.clone());
    }
    target
}

/// The review with its random ids replaced, as `tests/fixtures/hook-review-interaction.json` holds it.
fn normalized(review: &Value) -> Value {
    let mut review = review.clone();
    review["interactionId"] = json!("workspace-hook-interaction:fixture");
    review["payload"]["interactionId"] = json!("workspace-hook-interaction:fixture");
    review["payload"]["reviewFlowId"] = json!("workspace-hook-review:fixture");
    review["payload"]["runId"] = json!("workspace-hook-run:s1:fixture");
    review
}

#[tokio::test]
async fn a_request_publishes_nodes_review_interaction() {
    let harness = harness(Some(two_hooks())).await;
    let review = harness.open().await;
    let request = &review["payload"];
    assert!(
        request["interactionId"]
            .as_str()
            .unwrap()
            .starts_with("workspace-hook-interaction:")
    );
    assert!(
        request["reviewFlowId"]
            .as_str()
            .unwrap()
            .starts_with("workspace-hook-review:")
    );
    assert!(
        request["runId"]
            .as_str()
            .unwrap()
            .starts_with("workspace-hook-run:s1:")
    );
    // The golden the fork Vitest parses with `pendingInteractionSchema`.
    let golden: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/hook-review-interaction.json"
    ))
    .unwrap();
    assert_eq!(
        normalized(&review),
        golden,
        "{}",
        serde_json::to_string_pretty(&normalized(&review)).unwrap()
    );
    // Only the review opens; the banner waits for a decision (Node emits Requested alone).
    assert!(
        harness.admin.calls().is_empty(),
        "{:?}",
        harness.admin.calls()
    );
}

/// The trust identity of the bundle is the entry point's (a normalized path, a source repository); the commands name
/// the session's workspace key, which the review publishes.
#[tokio::test]
async fn the_commands_name_the_sessions_workspace_key() {
    let mut bundle = two_hooks();
    bundle.identity = "local:/normalized".to_owned();
    let harness = harness(Some(bundle)).await;
    let refused_identity = harness
        .send(
            "requestWorkspaceHookReview",
            json!({"sessionId": "s1", "workspaceIdentity": "local:/normalized", "bundleDigest": B1}),
        )
        .await;
    refused(&refused_identity, SNAPSHOT_MISMATCH);
    let review = harness.open().await;
    assert_eq!(review["payload"]["workspaceIdentity"], ROOT);
    let ack = harness
        .send(
            "respondWorkspaceHookReview",
            with(
                target(&review),
                json!({"decision": {"action": "trust_selected", "reviewItemIds": ["r1"]}}),
            ),
        )
        .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
}

#[tokio::test]
async fn a_second_request_reuses_the_pending_flow() {
    let harness = harness(Some(two_hooks())).await;
    let first = harness.open().await;
    let again = harness.open().await;
    assert_eq!(first, again);
}

#[tokio::test]
async fn a_request_is_refused_or_a_no_op_like_node() {
    let harness = harness(Some(two_hooks())).await;
    let mismatch = harness
        .send(
            "requestWorkspaceHookReview",
            json!({"sessionId": "s1", "workspaceIdentity": ROOT, "bundleDigest": B2}),
        )
        .await;
    refused(&mismatch, SNAPSHOT_MISMATCH);
    let other_session = harness
        .send(
            "requestWorkspaceHookReview",
            json!({"sessionId": "s2", "workspaceIdentity": ROOT, "bundleDigest": B1}),
        )
        .await;
    refused(&other_session, SNAPSHOT_MISMATCH);
    assert!(harness.reviews().is_empty());

    // Nothing pending: accepted, nothing published.
    harness.admin.set_stored(D1, StoredTrust::Trusted);
    harness.admin.set_stored(D2, StoredTrust::Trusted);
    let ack = harness
        .send(
            "requestWorkspaceHookReview",
            json!({"sessionId": "s1", "workspaceIdentity": ROOT, "bundleDigest": B1}),
        )
        .await;
    assert_eq!(ack.status, Status::Accepted);
    assert!(ack.result.is_none());
    assert!(harness.reviews().is_empty());

    // An unreadable store blocks every declaration.
    let mut corrupt = two_hooks();
    corrupt.store_corrupt = true;
    *harness.admin.bundle.lock_unpoisoned() = Some(corrupt);
    let ack = harness
        .send(
            "requestWorkspaceHookReview",
            json!({"sessionId": "s1", "workspaceIdentity": ROOT, "bundleDigest": B1}),
        )
        .await;
    refused(&ack, TRUST_STORE_CORRUPT);
    assert!(harness.reviews().is_empty());
}

#[tokio::test]
async fn without_a_reviewable_workspace_the_host_cannot_review() {
    let harness = harness(None).await;
    let ack = harness
        .send(
            "requestWorkspaceHookReview",
            json!({"sessionId": "s1", "workspaceIdentity": ROOT, "bundleDigest": B1}),
        )
        .await;
    refused(&ack, REQUIRE_TRUST_CAPABLE_HOST);

    let (_scope, server) = fixture_with(None, false);
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    let envelope = Envelope {
        command_id: "c1".to_owned(),
        client_id: "client".to_owned(),
        session_id: Some("s1".to_owned()),
        base_revision: None,
        kind: "requestWorkspaceHookReview".to_owned(),
        payload: json!({"sessionId": "s1", "workspaceIdentity": ROOT, "bundleDigest": B1}),
        input_origin: None,
    };
    refused(
        &decide(&server, &live, &envelope, 7).await,
        REQUIRE_TRUST_CAPABLE_HOST,
    );
}

#[tokio::test]
async fn a_grant_settles_the_review_refreshes_the_banner_and_reopens_for_the_rest() {
    let harness = harness(Some(two_hooks())).await;
    let review = harness.open().await;
    let ack = harness
        .send(
            "respondWorkspaceHookReview",
            with(
                target(&review),
                json!({"decision": {"action": "trust_selected", "reviewItemIds": ["r1"]}}),
            ),
        )
        .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert!(ack.result.is_none());
    assert_eq!(
        harness.admin.calls(),
        vec![
            json!({"grant": ["r1"], "bundle": B1}),
            json!({"admission": 1}),
        ]
    );
    let snapshot = harness.live.sink.snapshot();
    assert_eq!(
        snapshot["workspaceHookAdmission"],
        json!({"pendingCount": 1, "bundleDigest": B1})
    );
    // The next generation carries the remaining declaration as pending.
    let next = harness.review();
    assert_ne!(next["interactionId"], review["interactionId"]);
    assert_eq!(next["payload"]["generation"], 2);
    assert_eq!(
        next["payload"]["reviewFlowId"],
        review["payload"]["reviewFlowId"]
    );
    assert_eq!(next["payload"]["runId"], review["payload"]["runId"]);
    assert_eq!(
        next["payload"]["items"][0]["trustState"],
        "trusted_persistent"
    );
    assert_eq!(next["payload"]["items"][1]["trustState"], "pending_trust");
    assert_eq!(next["payload"]["summary"]["pendingCount"], 1);

    // The old generation is gone for good.
    let stale = harness
        .send(
            "respondWorkspaceHookReview",
            with(
                target(&review),
                json!({"decision": {"action": "trust_selected", "reviewItemIds": ["r2"]}}),
            ),
        )
        .await;
    refused(&stale, REVIEW_SUPERSEDED);

    // Trusting the last one closes the flow without a new generation.
    let ack = harness
        .send(
            "respondWorkspaceHookReview",
            with(
                target(&next),
                json!({"decision": {"action": "trust_selected", "reviewItemIds": ["r2"]}}),
            ),
        )
        .await;
    assert_eq!(ack.status, Status::Accepted);
    assert!(harness.reviews().is_empty());
    // Nothing pending any more: the banner clears.
    assert_eq!(
        harness.live.sink.snapshot()["workspaceHookAdmission"],
        Value::Null
    );
}

#[tokio::test]
async fn a_response_is_validated_against_the_current_flow_and_bundle() {
    let harness = harness(Some(two_hooks())).await;
    let review = harness.open().await;
    let trust =
        |ids: Value| json!({"decision": {"action": "trust_selected", "reviewItemIds": ids}});
    let unknown = harness
        .send(
            "respondWorkspaceHookReview",
            with(target(&review), trust(json!(["nope"]))),
        )
        .await;
    refused(&unknown, SNAPSHOT_MISMATCH);
    let other_run = harness
        .send(
            "respondWorkspaceHookReview",
            with(
                with(target(&review), json!({"runId": "workspace-hook-run:x"})),
                trust(json!(["r1"])),
            ),
        )
        .await;
    refused(&other_run, SNAPSHOT_MISMATCH);
    let remote = harness
        .send(
            "respondWorkspaceHookReview",
            with(
                with(target(&review), json!({"remoteSessionId": "r"})),
                trust(json!(["r1"])),
            ),
        )
        .await;
    refused(&remote, SNAPSHOT_MISMATCH);
    let other_generation = harness
        .send(
            "respondWorkspaceHookReview",
            with(
                with(target(&review), json!({"generation": 5})),
                trust(json!(["r1"])),
            ),
        )
        .await;
    refused(&other_generation, REVIEW_SUPERSEDED);

    // The config changed on disk since the review opened.
    harness
        .admin
        .bundle
        .lock_unpoisoned()
        .as_mut()
        .unwrap()
        .bundle_digest = B2.to_owned();
    let changed = harness
        .send(
            "respondWorkspaceHookReview",
            with(target(&review), trust(json!(["r1"]))),
        )
        .await;
    refused(&changed, SNAPSHOT_MISMATCH);
    assert!(
        !harness
            .admin
            .calls()
            .iter()
            .any(|call| call.get("grant").is_some()),
        "nothing was granted"
    );
    // A refusal leaves the review as it was.
    assert_eq!(harness.review(), review);
}

#[tokio::test]
async fn a_store_failure_keeps_the_review_open() {
    let harness = harness(Some(two_hooks())).await;
    let review = harness.open().await;
    *harness.admin.grant.lock_unpoisoned() = Err(TRUST_STORE_CORRUPT);
    let ack = harness
        .send(
            "respondWorkspaceHookReview",
            with(
                target(&review),
                json!({"decision": {"action": "trust_selected", "reviewItemIds": ["r1"]}}),
            ),
        )
        .await;
    refused(&ack, TRUST_STORE_CORRUPT);
    assert_eq!(harness.review(), review);
}

#[tokio::test]
async fn a_toggle_supersedes_the_review_with_the_rewritten_bundle() {
    let harness = harness(Some(two_hooks())).await;
    let review = harness.open().await;
    let ack = harness
        .send(
            "toggleWorkspaceHookReviewItem",
            with(
                target(&review),
                json!({"reviewItemId": "r2", "enabled": false}),
            ),
        )
        .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert_eq!(
        harness.admin.calls(),
        vec![
            json!({"toggle": "r2", "enabled": false, "bundle": B1}),
            json!({"admission": 2}),
        ]
    );
    let next = harness.review();
    assert_ne!(next["interactionId"], review["interactionId"]);
    assert_eq!(next["payload"]["generation"], 2);
    assert_eq!(next["payload"]["bundleDigest"], B2);
    assert_eq!(next["payload"]["items"][1]["configuredEnabled"], false);
    // Disabled declarations stay reviewable (Node counts trust, not the switch).
    assert_eq!(next["payload"]["summary"]["pendingCount"], 2);
}

#[tokio::test]
async fn a_toggle_is_refused_like_node() {
    let mut bundle = two_hooks();
    bundle.items[0].editable = false;
    let harness = harness(Some(bundle)).await;
    let review = harness.open().await;
    let readonly = harness
        .send(
            "toggleWorkspaceHookReviewItem",
            with(
                target(&review),
                json!({"reviewItemId": "r1", "enabled": false}),
            ),
        )
        .await;
    refused(&readonly, SNAPSHOT_MISMATCH);

    *harness.admin.toggle.lock_unpoisoned() = Err(ToggleError::Rejected(BUNDLE_CHANGED));
    let changed = harness
        .send(
            "toggleWorkspaceHookReviewItem",
            with(
                target(&review),
                json!({"reviewItemId": "r2", "enabled": false}),
            ),
        )
        .await;
    refused(&changed, BUNDLE_CHANGED);
    assert_eq!(harness.review(), review);

    // Written but not rebuilt: the review settles as a configuration error.
    *harness.admin.toggle.lock_unpoisoned() = Err(ToggleError::RebuildFailed);
    let rebuild = harness
        .send(
            "toggleWorkspaceHookReviewItem",
            with(
                target(&review),
                json!({"reviewItemId": "r2", "enabled": false}),
            ),
        )
        .await;
    refused(&rebuild, CONFIG_REBUILD_FAILED);
    assert!(harness.reviews().is_empty());
    let after = harness
        .send(
            "toggleWorkspaceHookReviewItem",
            with(
                target(&review),
                json!({"reviewItemId": "r2", "enabled": false}),
            ),
        )
        .await;
    refused(&after, REVIEW_SUPERSEDED);
}

#[tokio::test]
async fn a_settings_revoke_reopens_the_review_with_the_revoked_declaration() {
    let harness = harness(Some(two_hooks())).await;
    harness.admin.set_stored(D1, StoredTrust::Trusted);
    harness.admin.set_stored(D2, StoredTrust::Trusted);
    let revoke = |digests: Value| json!({"sessionId": "s1", "workspaceIdentity": ROOT, "bundleDigest": B1, "hookDeclarationDigests": digests});
    let unknown = harness
        .send("revokeWorkspaceHookTrust", revoke(json!([B2])))
        .await;
    refused(&unknown, SNAPSHOT_MISMATCH);
    let remote = harness
        .send(
            "revokeWorkspaceHookTrust",
            with(revoke(json!([D1])), json!({"remoteSessionId": "r"})),
        )
        .await;
    refused(&remote, SNAPSHOT_MISMATCH);

    let ack = harness
        .send("revokeWorkspaceHookTrust", revoke(json!([D1, D1])))
        .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert_eq!(
        harness.admin.calls(),
        vec![json!({"revoke": [D1]}), json!({"admission": 1})]
    );
    let review = harness.review();
    assert_eq!(review["payload"]["generation"], 1);
    assert_eq!(review["payload"]["items"][0]["trustState"], "revoked");
    assert_eq!(
        review["payload"]["items"][1]["trustState"],
        "trusted_persistent"
    );
    assert_eq!(review["payload"]["summary"]["pendingCount"], 1);

    // Trusted again: the revocation of this session no longer applies.
    let ack = harness
        .send(
            "respondWorkspaceHookReview",
            with(
                target(&review),
                json!({"decision": {"action": "trust_selected", "reviewItemIds": ["r1"]}}),
            ),
        )
        .await;
    assert_eq!(ack.status, Status::Accepted);
    assert!(harness.reviews().is_empty());
}

#[tokio::test]
async fn a_flow_revoke_supersedes_the_open_review() {
    let harness = harness(Some(two_hooks())).await;
    harness.admin.set_stored(D2, StoredTrust::Trusted);
    let review = harness.open().await;
    let ack = harness
        .send(
            "revokeWorkspaceHookTrust",
            with(target(&review), json!({"reviewItemIds": ["r2"]})),
        )
        .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert_eq!(harness.admin.calls()[0], json!({"revoke": [D2]}));
    let next = harness.review();
    assert_eq!(next["payload"]["generation"], 2);
    assert_eq!(next["payload"]["items"][1]["trustState"], "revoked");
    assert_eq!(next["payload"]["summary"]["pendingCount"], 2);
}

#[tokio::test(start_paused = true)]
async fn an_unanswered_review_times_out() {
    let harness = harness(Some(two_hooks())).await;
    let review = harness.open().await;
    assert_eq!(review["payload"]["createdAt"], 5);
    assert_eq!(review["payload"]["deadlineAt"], 5 + REVIEW_TIMEOUT_MS);
    tokio::time::sleep(Duration::from_millis(REVIEW_TIMEOUT_MS - 1)).await;
    settled(&harness.live).await;
    assert_eq!(harness.reviews().len(), 1);
    tokio::time::sleep(Duration::from_millis(2)).await;
    settled(&harness.live).await;
    assert!(harness.reviews().is_empty());
    let late = harness
        .send(
            "respondWorkspaceHookReview",
            with(
                target(&review),
                json!({"decision": {"action": "trust_selected", "reviewItemIds": ["r1"]}}),
            ),
        )
        .await;
    refused(&late, REVIEW_SUPERSEDED);
    // A new request opens the next generation.
    let next = harness.open().await;
    assert_eq!(next["payload"]["generation"], 2);
}

fn review_interaction(id: &str) -> Value {
    json!({"interactionId": id, "kind": "workspaceHookReview", "anchorRowId": null, "createdAt": 1, "payload": {}})
}

fn finish_turn(projection: &mut Projection) -> Vec<Value> {
    projection.apply(
        &SequencedEvent {
            seq: 1,
            event: KernelEvent::TurnStarted {
                turn: TurnId::new("turn_1"),
                command: None,
            },
            revision: 1,
        },
        10,
    );
    projection.apply(
        &SequencedEvent {
            seq: 2,
            event: KernelEvent::TurnFinished {
                turn: TurnId::new("turn_1"),
                outcome: TurnOutcome::Success,
                usage: None,
            },
            revision: 2,
        },
        11,
    )
}

#[test]
fn the_projection_keeps_one_session_level_review() {
    let view = crate::fork::workspace_trust::tests::view();
    let mut projection = Projection::from_view(&view, Followup::Queue, Vec::new());
    let put = projection.put_hook_review(review_interaction("i1"));
    assert_eq!(
        put,
        json!({"op": "state.updated", "patch": {"pendingInteractions": [review_interaction("i1")]}})
    );
    projection.put_hook_review(review_interaction("i2"));
    assert_eq!(
        projection.snapshot(1, "e")["pendingInteractions"],
        json!([review_interaction("i2")])
    );
    assert_eq!(projection.pending_permissions(), 0);
    assert_eq!(projection.remove_hook_review("i1"), None);

    // A turn's end and a rewritten history keep it.
    let finished = finish_turn(&mut projection);
    assert!(
        !finished
            .iter()
            .any(|delta| delta["patch"].get("pendingInteractions").is_some()),
        "{finished:?}"
    );
    let rebuilt = projection.rebuilt(&view);
    assert_eq!(
        rebuilt.snapshot(3, "e")["pendingInteractions"],
        json!([review_interaction("i2")])
    );

    assert_eq!(
        projection.remove_hook_review("i2"),
        Some(json!({"op": "state.updated", "patch": {"pendingInteractions": []}}))
    );
}
