//! Workspace trust routes and banners (specs/fork-rust-agent-parity.md, "Workspace MCP trust, the MCP settings list
//! and Hook trust grants"): the projection's Node publish rules, the refresh after an accepted decision, and the
//! methods without an entry-point admin.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use rust_cli_base::TaskScope;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, CommandEnvelope, CommandResult, CreateSession, Kernel, KernelError,
    SequencedEvent, SessionHandle, SessionView,
};
use rust_cli_kernel_api::store::{
    SessionFilter, SessionKind, SessionMeta, SessionSummary, StoreQueries,
};
use rust_cli_kernel_api::testing::{FixedClock, HandleOverride, MemoryStore, selection};
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::{Value, json};

use super::*;
use crate::context::Context;
use crate::fork::methods::dispatch;
use crate::projection::Projection;
use crate::projection::state::Followup;
use crate::server::Defaults;

const ROOT: &str = "/fixture/repo";
const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn meta() -> SessionMeta {
    SessionMeta {
        id: SessionId::new("s1"),
        kind: SessionKind::Interactive,
        parent: None,
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new(ROOT),
        },
        title: String::new(),
        trace: TraceId::new("trace"),
        created_at_ms: 1000,
        incognito: None,
    }
}

fn view() -> SessionView {
    SessionView::new(meta(), Vec::new(), selection(), PermissionMode::Default)
}

fn mcp(pending: u64) -> Value {
    json!({"pendingCount": pending, "bundleDigest": DIGEST, "workspaceIdentity": ROOT})
}

fn hook(pending: u64) -> Value {
    json!({"pendingCount": pending, "bundleDigest": "b1"})
}

fn admission(mcp: Option<Value>, hook: Option<Value>) -> Admission {
    Admission { mcp, hook }
}

#[test]
fn the_mcp_banner_follows_nodes_publish_rules() {
    let mut projection = Projection::from_view(&view(), Followup::Queue, Vec::new());
    // Never published and nothing pending: Node stays silent.
    assert_eq!(
        projection.set_admission(admission(Some(mcp(0)), None)),
        None
    );
    let shown = projection.set_admission(admission(Some(mcp(2)), None));
    assert_eq!(
        shown,
        Some(json!({"op": "state.updated", "patch": {"workspaceMcpAdmission": mcp(2)}}))
    );
    assert_eq!(projection.snapshot(1, "e")["workspaceMcpAdmission"], mcp(2));
    // The same payload again is skipped.
    assert_eq!(
        projection.set_admission(admission(Some(mcp(2)), None)),
        None
    );
    // Once shown, a settled workspace clears it with `null`.
    let cleared = projection.set_admission(admission(Some(mcp(0)), None));
    assert_eq!(
        cleared,
        Some(json!({"op": "state.updated", "patch": {"workspaceMcpAdmission": null}}))
    );
    assert_eq!(
        projection.set_admission(admission(Some(mcp(0)), None)),
        None
    );
    assert!(
        projection
            .snapshot(2, "e")
            .get("workspaceMcpAdmission")
            .is_none(),
        "absent when nothing is pending"
    );
}

#[test]
fn the_hook_banner_is_null_without_pending_hooks() {
    let mut projection = Projection::from_view(&view(), Followup::Queue, Vec::new());
    assert_eq!(
        projection.snapshot(1, "e")["workspaceHookAdmission"],
        Value::Null
    );
    assert_eq!(
        projection.set_admission(admission(None, Some(hook(0)))),
        None
    );
    assert_eq!(
        projection.set_admission(admission(None, Some(hook(1)))),
        Some(json!({"op": "state.updated", "patch": {"workspaceHookAdmission": hook(1)}}))
    );
    assert_eq!(
        projection.snapshot(1, "e")["workspaceHookAdmission"],
        hook(1)
    );
    // Both banners in one refresh: one patch with the two that changed.
    assert_eq!(
        projection.set_admission(admission(Some(mcp(1)), None)),
        Some(json!({"op": "state.updated", "patch": {
            "workspaceMcpAdmission": mcp(1),
            "workspaceHookAdmission": null,
        }}))
    );
}

#[test]
fn a_rewritten_history_keeps_the_banners() {
    let mut projection = Projection::from_view(&view(), Followup::Queue, Vec::new());
    projection.set_admission(admission(Some(mcp(1)), Some(hook(1))));
    let rebuilt = projection.rebuilt(&view()).snapshot(2, "e");
    assert_eq!(rebuilt["workspaceMcpAdmission"], mcp(1));
    assert_eq!(rebuilt["workspaceHookAdmission"], hook(1));
}

struct TestHandle {
    id: SessionId,
}

#[async_trait]
impl HandleOverride for TestHandle {
    fn id(&self) -> &SessionId {
        &self.id
    }

    async fn send(&self, _envelope: CommandEnvelope) -> KernelAck {
        KernelAck::Accepted {
            result: CommandResult::Done,
        }
    }

    fn subscribe(&self, _after: Option<u64>) -> BoxStream<'static, SequencedEvent> {
        stream::empty().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(view())
    }
}

struct OneKernel {
    handle: Arc<TestHandle>,
}

#[async_trait]
impl Kernel for OneKernel {
    fn queries(&self) -> Arc<dyn StoreQueries> {
        Arc::new(MemoryStore::default())
    }

    async fn create_session(&self, _request: CreateSession) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "create".to_owned(),
        })
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Ok(self.handle.clone())
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }
}

/// The entry point's admin double: answers what it is told and records the calls.
#[derive(Default)]
struct FakeAdmin {
    accept: bool,
    banners: StdMutex<Admission>,
    calls: StdMutex<Vec<Value>>,
}

#[async_trait]
impl WorkspaceAdmin for FakeAdmin {
    async fn mcp_list(
        &self,
        target: &WorkspaceTarget,
        servers: Option<&[Value]>,
        connect: bool,
    ) -> Result<Value, String> {
        self.calls.lock_unpoisoned().push(json!({
            "list": target.key, "identity": target.identity, "servers": servers, "connect": connect,
        }));
        Ok(json!({"statuses": []}))
    }

    async fn mcp_trust(
        &self,
        target: &WorkspaceTarget,
        server: &str,
        digest: &str,
        trusted: bool,
    ) -> Value {
        self.calls.lock_unpoisoned().push(
            json!({"trust": target.path, "server": server, "digest": digest, "trusted": trusted}),
        );
        if self.accept {
            json!({"accepted": true})
        } else {
            json!({"accepted": false, "reasonCode": "workspace_mcp_declaration_changed"})
        }
    }

    async fn hook_trust_grant(
        &self,
        target: &WorkspaceTarget,
        bundle_digest: &str,
        declaration_digest: &str,
    ) -> Value {
        self.calls.lock_unpoisoned().push(
            json!({"grant": target.path, "bundle": bundle_digest, "digest": declaration_digest}),
        );
        json!({"accepted": self.accept})
    }

    async fn admission(&self, target: &WorkspaceTarget) -> Admission {
        self.calls
            .lock_unpoisoned()
            .push(json!({"admission": target.path}));
        self.banners.lock_unpoisoned().clone()
    }
}

fn fixture(admin: Option<Arc<FakeAdmin>>) -> (TaskScope, Arc<Server>) {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    if let Some(admin) = admin {
        context.set_workspace_admin(admin);
    }
    let server = Arc::new(Server::new(
        context,
        Arc::new(OneKernel {
            handle: Arc::new(TestHandle {
                id: SessionId::new("s1"),
            }),
        }),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    (scope, server)
}

/// Waits until the session's pump ran every job queued before this call (jobs run in order).
async fn settled(live: &Arc<Bridged<Live>>) {
    let (done, wait) = tokio::sync::oneshot::channel();
    live.run(Box::pin(async move {
        let _ = done.send(());
    }));
    wait.await.expect("the pump runs");
}

async fn call(server: &Server, method: &str, params: Value) -> Option<Result<Value, RpcError>> {
    dispatch(server, method, params)
        .await
        .map(|result| result.map(|reply| reply.result))
}

fn workspace(path: &str) -> Value {
    json!({"workspacePath": path, "workspaceIdentity": "remote:box", "workspaceKey": "key-1"})
}

#[tokio::test]
async fn without_an_admin_the_workspace_methods_are_not_ported() {
    let (_scope, server) = fixture(None);
    for method in [
        "mcp/list",
        "workspace/mcp/trust",
        "workspace/hooks/trustGrant",
    ] {
        assert!(
            call(&server, method, json!({"workspace": workspace(ROOT)}))
                .await
                .is_none(),
            "{method}"
        );
    }
}

#[tokio::test]
async fn mcp_list_hands_the_admin_the_workspace_the_dto_and_the_mode() {
    let admin = Arc::new(FakeAdmin::default());
    let (_scope, server) = fixture(Some(admin.clone()));
    let servers = json!([{"name": "a", "command": "node"}]);
    let listed = call(
        &server,
        "mcp/list",
        json!({"workspace": workspace(ROOT), "mcpServers": servers, "mode": "status"}),
    )
    .await
    .expect("ported")
    .expect("listed");
    assert_eq!(listed, json!({"statuses": []}));
    call(
        &server,
        "mcp/list",
        json!({"workspace": {"workspacePath": ROOT}}),
    )
    .await
    .expect("ported")
    .expect("listed");
    assert_eq!(
        *admin.calls.lock_unpoisoned(),
        vec![
            json!({"list": "key-1", "identity": "remote:box", "servers": servers, "connect": false}),
            json!({"list": ROOT, "identity": null, "servers": null, "connect": true}),
        ]
    );
    let missing = call(&server, "mcp/list", json!({"workspace": {}}))
        .await
        .expect("ported");
    assert!(missing.is_err(), "the workspace path is required");
}

#[tokio::test]
async fn an_accepted_decision_refreshes_the_banners_of_the_workspaces_sessions() {
    let admin = Arc::new(FakeAdmin {
        accept: true,
        ..FakeAdmin::default()
    });
    *admin.banners.lock_unpoisoned() = admission(Some(mcp(1)), Some(hook(2)));
    let (_scope, server) = fixture(Some(admin.clone()));
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    // Another workspace's decision leaves this session alone.
    let other = call(
        &server,
        "workspace/mcp/trust",
        json!({"workspace": workspace("/elsewhere"), "serverName": "a", "declarationDigest": DIGEST, "trusted": true}),
    )
    .await
    .expect("ported")
    .expect("answered");
    assert_eq!(other, json!({"accepted": true}));
    settled(&live).await;
    assert_eq!(live.sink.snapshot()["workspaceHookAdmission"], Value::Null);

    call(
        &server,
        "workspace/mcp/trust",
        json!({"workspace": workspace(ROOT), "serverName": "a", "declarationDigest": DIGEST, "trusted": true}),
    )
    .await
    .expect("ported")
    .expect("answered");
    settled(&live).await;
    let snapshot = live.sink.snapshot();
    assert_eq!(snapshot["workspaceMcpAdmission"], mcp(1));
    assert_eq!(snapshot["workspaceHookAdmission"], hook(2));

    *admin.banners.lock_unpoisoned() = admission(Some(mcp(0)), None);
    let granted = call(
        &server,
        "workspace/hooks/trustGrant",
        json!({"workspace": workspace(ROOT), "bundleDigest": "b1", "hookDeclarationDigest": "d1"}),
    )
    .await
    .expect("ported")
    .expect("answered");
    assert_eq!(granted, json!({"accepted": true}));
    settled(&live).await;
    let snapshot = live.sink.snapshot();
    assert!(snapshot.get("workspaceMcpAdmission").is_none());
    assert_eq!(snapshot["workspaceHookAdmission"], Value::Null);
}

#[tokio::test]
async fn a_refused_decision_refreshes_nothing() {
    let admin = Arc::new(FakeAdmin::default());
    *admin.banners.lock_unpoisoned() = admission(Some(mcp(1)), None);
    let (_scope, server) = fixture(Some(admin.clone()));
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    let refused = call(
        &server,
        "workspace/mcp/trust",
        json!({"workspace": workspace(ROOT), "serverName": "a", "declarationDigest": DIGEST, "trusted": false}),
    )
    .await
    .expect("ported")
    .expect("answered");
    assert_eq!(refused["accepted"], json!(false));
    settled(&live).await;
    assert!(live.sink.snapshot().get("workspaceMcpAdmission").is_none());
    assert!(
        !admin
            .calls
            .lock_unpoisoned()
            .iter()
            .any(|call| call.get("admission").is_some()),
        "no banner read after a refusal"
    );
}

#[tokio::test]
async fn an_mcp_app_resource_is_never_authorized() {
    let (_scope, server) = fixture(None);
    let error = call(
        &server,
        "mcp/readResource",
        json!({"sessionId": "s1", "instanceId": "i1", "uri": "ui://x"}),
    )
    .await
    .expect("ported without an admin")
    .expect_err("no MCP App instances");
    assert_eq!(error.message, "MCP App instance is no longer authorized");
}
