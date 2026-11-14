//! The app-server's workspace trust admin: what the settings lane connects, trust decisions against the shared
//! store, hook grants and the banners. Project files live in a memory environment, the stores in a temporary HOME.
#![allow(
    clippy::disallowed_methods,
    reason = "the test prepares the user config in a temporary HOME"
)]

use std::sync::Mutex as StdMutex;

use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::env::EnvFacts;
use rust_cli_kernel_api::mcp::{McpConnect, McpConnectionId, McpError, McpTransportEvent};
use rust_cli_kernel_api::testing::{FixedClock, MemoryEnvironment};

use std::collections::BTreeSet;

use super::*;

pub(super) const ROOT: &str = "/Users/dev/repo";

/// Records which servers the lane tried to start; every connect fails, so `wait_ready` settles at once.
#[derive(Default)]
struct Recording(StdMutex<Vec<String>>);

impl Recording {
    fn started(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

#[async_trait]
impl McpTransport for Recording {
    async fn connect(
        &self,
        _: &WorkspaceRef,
        request: McpConnect,
    ) -> Result<McpConnectionId, McpError> {
        self.0.lock().unwrap().push(request.server);
        Err(McpError::Connect {
            message: "refused".to_owned(),
        })
    }

    async fn send(&self, _: &McpConnectionId, _: Value) -> Result<(), McpError> {
        Ok(())
    }

    fn events(&self, _: &McpConnectionId) -> BoxStream<'static, McpTransportEvent> {
        futures_util::stream::pending().boxed()
    }

    async fn close(&self, _: &McpConnectionId) -> Result<(), McpError> {
        Ok(())
    }
}

/// Shared with `app_hook_review_tests.rs`.
pub(super) struct Fixture {
    pub(super) _home: tempfile::TempDir,
    _scope: TaskScope,
    pub(super) admin: AppWorkspace,
    transport: Arc<Recording>,
    pub(super) hooks: Arc<StdMutex<Vec<(String, ProjectEntry)>>>,
}

fn fixture(project: Value, user: Value) -> Fixture {
    fixture_text(&project.to_string(), user)
}

pub(super) fn fixture_text(project: &str, user: Value) -> Fixture {
    fixture_files(project, user, |env| env)
}

/// [`fixture_text`] with the project files seen through `wrap` (a seam for held or failing reads).
pub(super) fn fixture_files(
    project: &str,
    user: Value,
    wrap: impl FnOnce(Arc<dyn Files>) -> Arc<dyn Files>,
) -> Fixture {
    let facts = EnvFacts {
        cwd: EnvPath::new(ROOT),
        platform: "linux".to_owned(),
        os_version: "Linux".to_owned(),
        shell: "bash".to_owned(),
        is_git_repo: true,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    };
    let env = MemoryEnvironment::new(facts)
        .with_file("/Users/dev/repo/.git/HEAD", "ref")
        .with_file("/Users/dev/repo/.zcode/config.json", project);
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join(".zcode/cli/config.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, user.to_string()).unwrap();
    let paths = StoragePaths::resolve(&Default::default(), home.path(), home.path());
    let scope = TaskScope::root("app-workspace-test", |_| {});
    let transport = Arc::new(Recording::default());
    let hooks = Arc::new(StdMutex::new(Vec::new()));
    let recorded = hooks.clone();
    let admin = AppWorkspace::new(
        (wrap(Arc::new(env)), paths),
        ProcessConfig {
            workspace: WorkspaceRef {
                environment: EnvironmentId::new(LOCAL_ENVIRONMENT),
                root: EnvPath::new(ROOT),
            },
            process_env: EnvSnapshot::default(),
        },
        Box::new(move |key, entry| recorded.lock().unwrap().push((key, entry))),
        (
            transport.clone(),
            scope.spawner(),
            Arc::new(FixedClock(1_767_225_600_000)),
        ),
    );
    Fixture {
        _home: home,
        _scope: scope,
        admin,
        transport,
        hooks,
    }
}

pub(super) fn target(key: &str) -> WorkspaceTarget {
    WorkspaceTarget {
        path: ROOT.to_owned(),
        identity: None,
        key: key.to_owned(),
    }
}

fn mcp_project() -> Value {
    json!({"mcp": {"servers": {
        "alpha": {"command": "node", "args": ["a.js"]},
        "off": {"command": "deno", "enabled": false},
    }}})
}

async fn list(fixture: &Fixture, key: &str, connect: bool) -> Map<String, Value> {
    let result = fixture
        .admin
        .mcp_list(&target(key), None, connect)
        .await
        .unwrap();
    result["statuses"].as_object().unwrap().clone()
}

#[tokio::test]
async fn untrusted_workspace_servers_never_reach_the_settings_lane() {
    let fixture = fixture(
        mcp_project(),
        json!({"mcp": {"servers": {"mine": {"command": "user-tool"}}}}),
    );
    let statuses = list(&fixture, "k", true).await;
    assert_eq!(fixture.transport.started(), ["mine"]);
    assert_eq!(statuses["alpha"]["status"], "untrusted");
    assert_eq!(statuses["alpha"]["toolCount"], 0);
    assert_eq!(statuses["alpha"]["transport"], "stdio");
    assert_eq!(statuses["alpha"]["workspaceTrust"]["trusted"], false);
    assert_eq!(statuses["off"]["status"], "disabled");
    assert_eq!(statuses["mine"]["status"], "failed");
    assert!(statuses["mine"].get("workspaceTrust").is_none());
    assert_eq!(statuses["mine"]["updatedAt"], "2026-01-01T00:00:00.000Z");
}

#[tokio::test]
async fn a_trust_grant_admits_the_declaration_and_clears_the_banner() {
    let fixture = fixture(mcp_project(), json!({}));
    let statuses = list(&fixture, "k", false).await;
    let digest = statuses["alpha"]["workspaceTrust"]["declarationDigest"]
        .as_str()
        .unwrap()
        .to_owned();
    let before = fixture.admin.admission(&target("k")).await;
    assert_eq!(before.mcp.as_ref().unwrap()["pendingCount"], 1);

    let stale = fixture
        .admin
        .mcp_trust(&target("k"), "alpha", &"0".repeat(64), true)
        .await;
    assert_eq!(
        stale,
        json!({"accepted": false, "reasonCode": "workspace_mcp_declaration_changed"})
    );
    let answer = fixture
        .admin
        .mcp_trust(&target("k"), "alpha", &digest, true)
        .await;
    assert_eq!(answer, json!({"accepted": true}));

    let statuses = list(&fixture, "k", true).await;
    assert_eq!(fixture.transport.started(), ["alpha"]);
    assert_eq!(statuses["alpha"]["status"], "failed");
    assert_eq!(statuses["alpha"]["workspaceTrust"]["trusted"], true);
    let after = fixture.admin.admission(&target("k")).await;
    assert_eq!(after.mcp.as_ref().unwrap()["pendingCount"], 0);

    // A revoke takes it out of the next connect.
    let revoked = fixture
        .admin
        .mcp_trust(&target("k"), "alpha", &digest, false)
        .await;
    assert_eq!(revoked, json!({"accepted": true}));
    let statuses = list(&fixture, "k", true).await;
    assert_eq!(fixture.transport.started(), ["alpha"]);
    assert_eq!(statuses["alpha"]["status"], "untrusted");
}

#[tokio::test]
async fn a_status_read_never_connects_and_reuses_only_its_own_lane() {
    let fixture = fixture(
        json!({}),
        json!({"mcp": {"servers": {"mine": {"command": "user-tool"}}}}),
    );
    let statuses = list(&fixture, "k", false).await;
    assert!(fixture.transport.started().is_empty());
    assert_eq!(statuses["mine"]["status"], "disconnected");
    list(&fixture, "k", true).await;
    assert_eq!(list(&fixture, "k", false).await["mine"]["status"], "failed");
    assert_eq!(
        list(&fixture, "other", false).await["mine"]["status"],
        "disconnected"
    );
    assert_eq!(fixture.transport.started(), ["mine"]);
}

#[tokio::test]
async fn host_dtos_replace_the_config_and_unreviewed_declarations_are_blocked() {
    let fixture = fixture(mcp_project(), json!({}));
    let dtos = [
        json!({"name": "alpha", "scope": "workspace", "command": "node", "args": ["a.js"], "env": []}),
        json!({"name": "outside", "command": "node", "args": [], "env": []}),
        json!({"name": "mine", "scope": "user", "command": "node", "args": [], "env": []}),
    ];
    let result = fixture
        .admin
        .mcp_list(&target("k"), Some(&dtos), true)
        .await
        .unwrap();
    let statuses = result["statuses"].as_object().unwrap();
    // A source-less name the workspace does not declare passes (Node golden `dtoAllows`).
    assert_eq!(fixture.transport.started(), ["mine", "outside"]);
    assert_eq!(statuses["alpha"]["status"], "untrusted");
    assert_eq!(statuses["outside"]["status"], "failed");
    assert_eq!(statuses["mine"]["status"], "failed");
    // Every workspace declaration carries its review, listed or not (Node `withReviews`).
    assert_eq!(statuses["off"]["status"], "disabled");
}

const HOOKS: &str = r#"{"hooks": {"enabled": true, "events": {"UserPromptSubmit": [{"hooks": [
    {"type": "command", "command": "echo hi"}
]}]}}}"#;

#[tokio::test]
async fn a_hook_grant_is_persisted_and_rebuilds_the_process_hooks() {
    let fixture = fixture(serde_json::from_str(HOOKS).unwrap(), json!({}));
    let banner = fixture.admin.admission(&target(ROOT)).await.hook.unwrap();
    assert_eq!(banner["pendingCount"], 1);
    assert_eq!(banner["workspaceIdentity"], ROOT);
    let bundle = banner["bundleDigest"].as_str().unwrap().to_owned();
    let context = TrustContext {
        files: fixture.admin.files.as_ref(),
        paths: &fixture.admin.paths,
        cwd: ROOT,
        version: "0.1.0",
        now_ms: 0,
    };
    let pending = hooks_trust::inspect_at(&context, ROOT.to_owned(), None)
        .await
        .pending()
        .unwrap();

    let refused = fixture
        .admin
        .hook_trust_grant(&target(ROOT), &"0".repeat(64), &pending.digests[0])
        .await;
    assert_eq!(refused["accepted"], false);
    assert!(fixture.hooks.lock().unwrap().is_empty());

    let answer = fixture
        .admin
        .hook_trust_grant(&target(ROOT), &bundle, &pending.digests[0])
        .await;
    assert_eq!(answer, json!({"accepted": true}));
    assert_eq!(fixture.hooks.lock().unwrap().len(), 1);
    assert_eq!(fixture.admin.admission(&target(ROOT)).await.hook, None);
}

/// The current hook bundle and its first pending digest.
async fn pending_hook(fixture: &Fixture) -> (String, String) {
    let banner = fixture.admin.admission(&target(ROOT)).await.hook.unwrap();
    let bundle = banner["bundleDigest"].as_str().unwrap().to_owned();
    let context = TrustContext {
        files: fixture.admin.files.as_ref(),
        paths: &fixture.admin.paths,
        cwd: ROOT,
        version: "0.1.0",
        now_ms: 0,
    };
    let pending = hooks_trust::inspect_at(&context, ROOT.to_owned(), None)
        .await
        .pending()
        .unwrap();
    (bundle, pending.digests[0].clone())
}

/// Node `discoverSnapshot` throws when a config cannot be parsed (`readUserHooks` rethrows), so the grant answers
/// `workspace_hooks_config_unreadable` and writes nothing, even when the readable files still give the same bundle.
#[tokio::test]
async fn a_hook_grant_with_an_unreadable_config_is_refused() {
    let fixture = fixture(serde_json::from_str(HOOKS).unwrap(), json!({}));
    let (bundle, digest) = pending_hook(&fixture).await;
    std::fs::write(
        fixture._home.path().join(".zcode/cli/config.json"),
        "{ not json",
    )
    .unwrap();
    let answer = fixture
        .admin
        .hook_trust_grant(&target(ROOT), &bundle, &digest)
        .await;
    assert_eq!(
        answer,
        json!({"accepted": false, "reasonCode": "workspace_hooks_config_unreadable"})
    );
    assert!(fixture.hooks.lock().unwrap().is_empty());
    assert!(
        !fixture
            .admin
            .paths
            .hook_trust_store(None)
            .as_path()
            .exists()
    );
}

/// Node `didGrantExactDeclaration` reads the status after the grant: a corrupt store answers its own reason, and a
/// grant counts only while the declaration is still in the bundle.
#[tokio::test]
async fn a_hook_grant_is_confirmed_against_the_reread_bundle_and_store() {
    let fixture = fixture(serde_json::from_str(HOOKS).unwrap(), json!({}));
    let (bundle, digest) = pending_hook(&fixture).await;
    let answer = fixture
        .admin
        .hook_trust_grant(&target(ROOT), &bundle, &digest)
        .await;
    assert_eq!(answer, json!({"accepted": true}));
    let context = TrustContext {
        files: fixture.admin.files.as_ref(),
        paths: &fixture.admin.paths,
        cwd: ROOT,
        version: "0.1.0",
        now_ms: 0,
    };
    let confirmed = hooks_trust::confirm_grant(&context, (ROOT.to_owned(), None), &digest).await;
    assert_eq!(confirmed, json!({"accepted": true}));
    // A trusted record for a declaration the workspace no longer has does not count.
    let store = fixture.admin.paths.hook_trust_store(None);
    let mut file: Value = serde_json::from_slice(&std::fs::read(store.as_path()).unwrap()).unwrap();
    let mut gone = file["records"][0].clone();
    gone["hookDeclarationDigest"] = json!("f".repeat(64));
    file["records"].as_array_mut().unwrap().push(gone);
    std::fs::write(store.as_path(), file.to_string()).unwrap();
    let other =
        hooks_trust::confirm_grant(&context, (ROOT.to_owned(), None), &"f".repeat(64)).await;
    assert_eq!(
        other,
        json!({"accepted": false, "reasonCode": "workspace_hooks_config_unreadable"})
    );
    std::fs::write(store.as_path(), "{ corrupt").unwrap();
    let corrupt = hooks_trust::confirm_grant(&context, (ROOT.to_owned(), None), &digest).await;
    assert_eq!(
        corrupt,
        json!({"accepted": false, "reasonCode": "workspace_hooks_trust_store_corrupt"})
    );
}

#[tokio::test]
async fn an_unreadable_config_makes_a_decision_unavailable_not_changed() {
    let fixture = fixture_text("{ not json", json!({}));
    let answer = fixture
        .admin
        .mcp_trust(&target("k"), "alpha", &"0".repeat(64), true)
        .await;
    assert_eq!(
        answer,
        json!({"accepted": false, "reasonCode": "workspace_mcp_trust_unavailable"})
    );
}

#[tokio::test]
async fn a_host_dto_cannot_relabel_an_untrusted_declaration_as_a_user_server() {
    let fixture = fixture(mcp_project(), json!({}));
    let dtos =
        [json!({"name": "alpha", "scope": "user", "command": "node", "args": ["a.js"], "env": []})];
    let result = fixture
        .admin
        .mcp_list(&target("k"), Some(&dtos), true)
        .await
        .unwrap();
    // Node `omitMcpServers(configured, untrustedProjectMcpServers)` drops by name.
    assert!(fixture.transport.started().is_empty());
    let alpha = &result["statuses"]["alpha"];
    assert_eq!(alpha["status"], "untrusted");
    // Node `withReviews` skips user-sourced configs, so no trust prompt is attached.
    assert!(alpha.get("workspaceTrust").is_none());
}

#[tokio::test]
async fn a_declaration_without_a_display_fails_the_list_and_keeps_the_banner() {
    let project = json!({"mcp": {"servers": {
        "alpha": {"command": "node", "args": ["a.js"]},
        "web": {"type": "http", "url": "not a url"},
    }}});
    let fixture = fixture(
        project,
        json!({"mcp": {"servers": {"mine": {"command": "user-tool"}}}}),
    );
    let error = fixture
        .admin
        .mcp_list(&target("k"), None, true)
        .await
        .unwrap_err();
    assert_eq!(error, "Invalid URL");
    assert!(fixture.transport.started().is_empty());
    // Node's admission refresh rejects and publishes nothing: `None` leaves the banner as it is.
    assert_eq!(fixture.admin.admission(&target("k")).await.mcp, None);
}

#[tokio::test]
async fn a_revoke_with_a_stale_digest_keeps_the_grant() {
    let fixture = fixture(mcp_project(), json!({}));
    let statuses = list(&fixture, "k", false).await;
    let digest = statuses["alpha"]["workspaceTrust"]["declarationDigest"]
        .as_str()
        .unwrap()
        .to_owned();
    let granted = fixture
        .admin
        .mcp_trust(&target("k"), "alpha", &digest, true)
        .await;
    assert_eq!(granted, json!({"accepted": true}));
    let stale = fixture
        .admin
        .mcp_trust(&target("k"), "alpha", &"0".repeat(64), false)
        .await;
    assert_eq!(
        stale,
        json!({"accepted": false, "reasonCode": "workspace_mcp_declaration_changed"})
    );
    let statuses = list(&fixture, "k", false).await;
    assert_eq!(statuses["alpha"]["workspaceTrust"]["trusted"], true);
}

/// A connect displaced while it still closes the previous lane never starts its servers (the newer lane owns the
/// workspace), and until a lane starts, its admitted servers show `connecting`, not `disconnected`. The older connect
/// really closes a started lane here; its only decision after the close is the installed-lane check under the lane
/// lock, so the newer lane installing before that check is the race, wherever inside the close it happened.
#[tokio::test]
async fn a_displaced_connect_starts_nothing_and_a_pending_lane_shows_connecting() {
    let fixture = fixture(
        json!({}),
        json!({"mcp": {"servers": {"mine": {"command": "user-tool"}}}}),
    );
    let admitted = |key: &'static str| {
        let admin = &fixture.admin;
        async move {
            let read = admin.read(&target(key)).await;
            let configured = AppWorkspace::configured(&read, None);
            (
                read.workspace.clone(),
                admin.admit(&read, &configured, &BTreeSet::new()),
            )
        }
    };
    // A started lane for the older connect to close.
    let (workspace, servers) = admitted("k").await;
    let (started, displaced) = fixture
        .admin
        .install(fixture.admin.arrival(), "k", servers)
        .unwrap();
    fixture
        .admin
        .settle(started.clone(), displaced, workspace)
        .await;
    assert_eq!(fixture.transport.started(), ["mine"]);

    let (workspace, servers) = admitted("k").await;
    let older = fixture.admin.arrival();
    let (first, displaced) = fixture.admin.install(older, "k", servers).unwrap();
    assert!(
        displaced
            .as_ref()
            .is_some_and(|lane| Arc::ptr_eq(lane, &started))
    );
    assert_eq!(
        list(&fixture, "k", false).await["mine"]["status"],
        "connecting"
    );

    let (newer_workspace, newer_servers) = admitted("k").await;
    let newer = fixture.admin.arrival();
    let (second, newer_displaced) = fixture.admin.install(newer, "k", newer_servers).unwrap();
    fixture
        .admin
        .settle(second, newer_displaced, newer_workspace)
        .await;
    // The older connect now closes the started lane and finds itself displaced.
    fixture.admin.settle(first, displaced, workspace).await;
    assert_eq!(fixture.transport.started(), ["mine", "mine"]);
    assert!(
        started
            .manager
            .server_infos()
            .iter()
            .all(|info| info.state == McpServerState::Disabled)
    );
}

#[tokio::test]
async fn an_older_connect_never_replaces_a_newer_lane() {
    let fixture = fixture(
        json!({}),
        json!({"mcp": {"servers": {"mine": {"command": "user-tool"}}}}),
    );
    let older = fixture.admin.arrival();
    let newer = fixture.admin.arrival();
    fixture
        .admin
        .list(&target("new"), None, Some(newer))
        .await
        .unwrap();
    // The older request finishes last; Node runs the settings-lane mutations in arrival order.
    let statuses = fixture
        .admin
        .list(&target("old"), None, Some(older))
        .await
        .unwrap();
    assert_eq!(fixture.transport.started(), ["mine"]);
    assert_eq!(statuses["statuses"]["mine"]["status"], "disconnected");
    assert_eq!(
        list(&fixture, "new", false).await["mine"]["status"],
        "failed"
    );
}
