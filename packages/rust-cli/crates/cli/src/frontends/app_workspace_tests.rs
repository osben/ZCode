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
use rust_cli_ext::WorkspaceConfig;
use rust_cli_ext::plugins::{PluginCandidate, PluginOrigin, PluginSources};
use rust_cli_hooks::ProjectEntry;
use rust_cli_kernel_api::env::EnvFacts;
use rust_cli_kernel_api::mcp::{
    McpConnect, McpConnectionId, McpError, McpTransportConfig, McpTransportEvent,
};
use rust_cli_kernel_api::testing::{FixedClock, MemoryEnvironment};

use std::collections::BTreeSet;

use super::*;

pub(super) const ROOT: &str = "/Users/dev/repo";

/// Records which servers the lane tried to start; every connect fails, so `wait_ready` settles at once.
#[derive(Default)]
struct Recording(StdMutex<Vec<McpConnect>>);

impl Recording {
    fn started(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.server.clone())
            .collect()
    }

    /// The stdio env the lane handed to `server`'s connect.
    fn stdio_env(&self, server: &str) -> BTreeMap<String, String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .find(|request| request.server == server)
            .and_then(|request| match &request.transport {
                McpTransportConfig::Stdio { env, .. } => Some(env.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }
}

#[async_trait]
impl McpTransport for Recording {
    async fn connect(
        &self,
        _: &WorkspaceRef,
        request: McpConnect,
    ) -> Result<McpConnectionId, McpError> {
        // `oauth-` servers answer HTTP 401 without a bearer, as a remote MCP server behind OAuth does.
        let message = if request.server.starts_with("oauth-") {
            "HTTP 401: unauthorized"
        } else {
            "refused"
        };
        self.0.lock().unwrap().push(request);
        Err(McpError::Connect {
            message: message.to_owned(),
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

/// The engine's slot ordering (`hooks` `projects.rs` `put_at`), recording the entries it accepts.
#[derive(Default)]
pub(super) struct Slots {
    epoch: std::sync::atomic::AtomicU64,
    newest: StdMutex<BTreeMap<String, u64>>,
    pub(super) accepted: Arc<StdMutex<Vec<(String, ProjectEntry)>>>,
}

impl ProjectHookSlots for Slots {
    fn reserve_project(&self) -> rust_cli_hooks::ProjectEpoch {
        rust_cli_hooks::ProjectEpoch(self.epoch.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn put_project_at(
        &self,
        key: &str,
        epoch: rust_cli_hooks::ProjectEpoch,
        entry: ProjectEntry,
    ) -> bool {
        let key = rust_cli_hooks::project_key(key);
        let mut newest = self.newest.lock().unwrap();
        if newest.get(&key).is_some_and(|newest| *newest > epoch.0) {
            return false;
        }
        newest.insert(key.clone(), epoch.0);
        self.accepted.lock().unwrap().push((key, entry));
        true
    }
}

/// The layer host seam (specs/fork-rust-workspace-plugins-mcp.md, "As built: layer reload"): records
/// the workspaces whose plugin/MCP layer the admin's committed trust writes reloaded.
#[derive(Default)]
pub(super) struct Layer {
    reloaded: StdMutex<Vec<String>>,
    loaded: StdMutex<Vec<String>>,
}

impl Layer {
    pub(super) fn reloaded(&self) -> Vec<String> {
        self.reloaded.lock().unwrap().clone()
    }

    fn loaded(&self) -> Vec<String> {
        self.loaded.lock().unwrap().clone()
    }
}

#[async_trait]
impl rust_cli_kernel_api::workspace_key::WorkspaceLayerHost for Layer {
    async fn load(&self, workspace: &WorkspaceRef) {
        self.loaded
            .lock()
            .unwrap()
            .push(workspace.root.as_str().to_owned());
    }

    async fn reload(&self, workspace: &WorkspaceRef) {
        self.reloaded
            .lock()
            .unwrap()
            .push(workspace.root.as_str().to_owned());
    }
}

/// The workspace plugin view seam (`config::workspace_layer::Loader` in the app-server): the fixed view of the
/// test workspace, `None` for an unreadable config.
struct Plugins(Option<WorkspaceConfig>);

#[async_trait]
impl WorkspaceConfigLoader for Plugins {
    async fn load(&self, _workspace: &WorkspaceRef) -> Option<WorkspaceConfig> {
        self.0.clone()
    }
}

/// A plugin `toolkit` in `/Users/dev/plugins/kit` whose manifest declares the stdio server `db`.
const PLUGIN_DIR: &str = "/Users/dev/plugins/kit";

fn plugin_files() -> Vec<(String, String)> {
    vec![(
        format!("{PLUGIN_DIR}/.claude-plugin/plugin.json"),
        r#"{"name": "toolkit", "mcpServers": {"db": {"command": "${CLAUDE_PLUGIN_ROOT}/bin/db"}}}"#
            .to_owned(),
    )]
}

fn plugin_view() -> Option<WorkspaceConfig> {
    Some(WorkspaceConfig {
        plugins: PluginSources {
            candidates: vec![PluginCandidate {
                dir: EnvPath::new(PLUGIN_DIR),
                marketplace: "inline".to_owned(),
                origin: PluginOrigin::ConfigDir,
            }],
            ..PluginSources::default()
        },
        servers: Vec::new(),
    })
}

/// Shared with `app_hook_review_tests.rs`.
pub(super) struct Fixture {
    pub(super) _home: tempfile::TempDir,
    _scope: TaskScope,
    pub(super) admin: AppWorkspace,
    transport: Arc<Recording>,
    pub(super) hooks: Arc<StdMutex<Vec<(String, ProjectEntry)>>>,
    pub(super) slots: Arc<Slots>,
    pub(super) layer: Arc<Layer>,
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
    fixture_with(project, user, Vec::new(), None, wrap)
}

/// A fixture whose workspace has the plugin `toolkit` ([`plugin_files`], [`plugin_view`]).
fn fixture_with_plugin(project: Value, user: Value) -> Fixture {
    fixture_with(
        &project.to_string(),
        user,
        plugin_files(),
        plugin_view(),
        |env| env,
    )
}

fn fixture_with(
    project: &str,
    user: Value,
    extra_files: Vec<(String, String)>,
    plugins: Option<WorkspaceConfig>,
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
    let mut env = MemoryEnvironment::new(facts)
        .with_file("/Users/dev/repo/.git/HEAD", "ref")
        .with_file("/Users/dev/repo/.zcode/config.json", project)
        // The entry script of `node check.js` (D24): a grant needs reviewable content.
        .with_file("/Users/dev/repo/check.js", "process.exit(0)\n");
    for (path, text) in &extra_files {
        env = env.with_file(path, text);
    }
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join(".zcode/cli/config.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, user.to_string()).unwrap();
    let paths = StoragePaths::resolve(&Default::default(), home.path(), home.path());
    let scope = TaskScope::root("app-workspace-test", |_| {});
    let transport = Arc::new(Recording::default());
    let slots = Arc::new(Slots::default());
    let layer = Arc::new(Layer::default());
    let hooks = slots.accepted.clone();
    let admin = AppWorkspace::new(
        (wrap(Arc::new(env)), paths),
        ProcessConfig {
            process_env: EnvSnapshot::default(),
        },
        slots.clone(),
        layer.clone(),
        (
            transport.clone(),
            scope.spawner(),
            Arc::new(FixedClock(1_767_225_600_000)),
        ),
        Arc::new(Plugins(plugins)),
    );
    Fixture {
        _home: home,
        _scope: scope,
        admin,
        transport,
        hooks,
        slots,
        layer,
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
    // Like Node, the decision does not reach the open tasks' MCP: no layer reload (the next session open re-reads).
    assert!(fixture.layer.reloaded().is_empty());

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
    // A refused grant wrote nothing, so nothing reloads.
    assert!(fixture.layer.reloaded().is_empty());

    let answer = fixture
        .admin
        .hook_trust_grant(&target(ROOT), &bundle, &pending.digests[0])
        .await;
    assert_eq!(answer, json!({"accepted": true}));
    assert_eq!(fixture.hooks.lock().unwrap().len(), 1);
    assert_eq!(fixture.admin.admission(&target(ROOT)).await.hook, None);
    // The accepted grant rebuilt the hooks entry and reloaded the workspace's plugin/MCP layer.
    assert_eq!(fixture.layer.reloaded(), [ROOT.to_owned()]);
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
            let configured = AppWorkspace::configured(&read, None, &BTreeMap::new());
            (
                read.workspace.clone(),
                admin.admit(&read, &configured, &BTreeMap::new(), &BTreeSet::new()),
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
    let first_manager = first.manager.clone();
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
    // The older connect finds itself displaced and starts nothing. The same workspace key shares the manager, so the
    // newer connect revalidated the failed server in place (one more attempt) and nothing was closed.
    fixture.admin.settle(first, displaced, workspace).await;
    assert_eq!(fixture.transport.started(), ["mine", "mine"]);
    assert!(Arc::ptr_eq(&started.manager, &first_manager));
}

/// Another workspace key gets a lane of its own and the displaced lane is closed (Node switches the owner).
#[tokio::test]
async fn a_connect_for_another_workspace_key_closes_the_previous_lane() {
    let fixture = fixture(
        json!({}),
        json!({"mcp": {"servers": {"mine": {"command": "user-tool"}}}}),
    );
    let older = fixture.admin.arrival();
    fixture
        .admin
        .list(&target("one"), None, Some(older))
        .await
        .unwrap();
    let first = fixture.admin.lane.lock().unwrap().clone().unwrap();
    let newer = fixture.admin.arrival();
    fixture
        .admin
        .list(&target("two"), None, Some(newer))
        .await
        .unwrap();
    let second = fixture.admin.lane.lock().unwrap().clone().unwrap();
    assert!(!Arc::ptr_eq(&first.manager, &second.manager));
    assert!(
        first
            .manager
            .server_infos()
            .iter()
            .all(|info| info.state == McpServerState::Disabled)
    );
}

/// Node drops the retired standalone CUA server from the Settings rows and never connects it; `node_repl` stays.
#[tokio::test]
async fn a_retired_cua_server_is_neither_listed_nor_connected() {
    let fixture = fixture(
        json!({}),
        json!({"mcp": {"servers": {
            "computer-use": {"command": "node"},
            "viacmd": {"command": "/opt/bin/zcode-cua"},
            "viaarg": {"command": "uvx", "args": ["--from", "zcode_cua", "run"]},
            "node_repl": {"command": "zcode-cua"},
            "mine": {"command": "user-tool"},
        }}}),
    );
    let statuses = fixture
        .admin
        .mcp_list(&target("k"), None, true)
        .await
        .unwrap()["statuses"]
        .as_object()
        .unwrap()
        .clone();
    let mut names: Vec<&String> = statuses.keys().collect();
    names.sort();
    assert_eq!(names, ["mine", "node_repl"]);
    let mut started = fixture.transport.started();
    started.sort();
    assert_eq!(started, ["mine", "node_repl"]);
}

/// The settings lane gives up on a connect when a session would: `MCP_TIMEOUT` and its siblings apply.
#[tokio::test]
async fn the_lane_reads_the_mcp_timeouts_from_the_process_environment() {
    let mut fixture = fixture(json!({}), json!({}));
    assert_eq!(fixture.admin.lane_settings().connect_timeout_ms, 30_000);
    fixture.admin.process.process_env = EnvSnapshot::default()
        .with_var("MCP_TIMEOUT", "4500")
        .with_var("MCP_TOOL_TIMEOUT", "9000")
        .with_var("MAX_MCP_OUTPUT_TOKENS", "777");
    let settings = fixture.admin.lane_settings();
    assert_eq!(settings.connect_timeout_ms, 4_500);
    assert_eq!(settings.tool_timeout_ms, 9_000);
    assert_eq!(settings.max_output_tokens, 777);
    assert_eq!(settings.client_version, crate::VERSION);
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

// ---- MCP OAuth through `with_mcp_oauth` (PR2, `specs/fork-rust-mcp-oauth.md`): the lane manager starts the flow
// after a 401, and the status row shows `connecting` with the authorization.

use std::collections::BTreeMap as OAuthMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use rust_cli_ext::mcp::oauth::{
    AuthorizationLease, LoopbackConnection, LoopbackListener, McpOAuthRuntime, McpOAuthStore,
    McpOAuthStoreError, McpOAuthWrite, OAuthHttpError, OAuthHttpRequest, OAuthHttpResponse,
    credential_key, credential_key_prefix,
};

/// The credential map of the flow, in memory.
#[derive(Default)]
struct MemoryOAuthStore(StdMutex<OAuthMap<String, String>>);

/// The lease the flow takes here: this fixture has no other flow to exclude.
struct NoLease;

#[async_trait]
impl AuthorizationLease for NoLease {
    async fn release(self: Box<Self>) {}
}

#[async_trait]
impl McpOAuthStore for MemoryOAuthStore {
    async fn load(&self, key: &str) -> Result<Option<String>, McpOAuthStoreError> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }

    async fn apply(&self, writes: &[McpOAuthWrite]) -> Result<(), McpOAuthStoreError> {
        let mut raw = self.0.lock().unwrap();
        for write in writes {
            match write {
                McpOAuthWrite::Put { key, value } => {
                    raw.insert(key.clone(), value.clone());
                }
                McpOAuthWrite::DeleteIfValue { key, expected } => {
                    if raw.get(key) == Some(expected) {
                        raw.remove(key);
                    }
                }
                McpOAuthWrite::DeleteGuarded {
                    guard_key,
                    expected,
                    keys,
                } => {
                    if raw.get(guard_key) == Some(expected) {
                        for key in keys {
                            raw.remove(key);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    async fn try_acquire_lease(
        &self,
        _key_prefix: &str,
    ) -> Result<Option<Box<dyn AuthorizationLease>>, McpOAuthStoreError> {
        Ok(Some(Box::new(NoLease)))
    }

    async fn try_acquire_refresh_lock(
        &self,
        _key_prefix: &str,
    ) -> Result<Option<Box<dyn AuthorizationLease>>, McpOAuthStoreError> {
        Ok(Some(Box::new(NoLease)))
    }
}

/// A loopback listener that never receives the browser's callback: the flow stays pending.
struct Parked;

#[async_trait]
impl LoopbackListener for Parked {
    fn local_addr(&self) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], 1))
    }

    async fn accept(&mut self) -> Result<Box<dyn LoopbackConnection>, OAuthHttpError> {
        std::future::pending().await
    }
}

/// Discovery answers from the authorization server at the MCP origin; the rest is never reached.
struct DiscoveryOnly;

#[async_trait]
impl McpOAuthRuntime for DiscoveryOnly {
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, OAuthHttpError> {
        Ok(vec![7; len])
    }

    fn now_ms(&self) -> i64 {
        1_767_225_600_000
    }

    async fn http(&self, request: OAuthHttpRequest) -> Result<OAuthHttpResponse, OAuthHttpError> {
        let reply = |status: u16, body: Value| OAuthHttpResponse {
            status,
            body: body.to_string(),
            www_authenticate: None,
        };
        Ok(
            if let Some(base) = request
                .url
                .strip_suffix("/.well-known/oauth-authorization-server")
            {
                reply(
                    200,
                    json!({
                        "issuer": base,
                        "authorization_endpoint": format!("{base}/authorize"),
                        "token_endpoint": format!("{base}/token"),
                        "registration_endpoint": format!("{base}/register"),
                        "response_types_supported": ["code"],
                        "code_challenge_methods_supported": ["S256"],
                    }),
                )
            } else if request.url.ends_with("/register") {
                reply(201, json!({"client_id": "dcr-client"}))
            } else {
                reply(404, json!({}))
            },
        )
    }

    async fn bind_loopback(&self) -> Result<Box<dyn LoopbackListener>, OAuthHttpError> {
        Ok(Box::new(Parked))
    }
}

/// [`fixture`] with the OAuth store and runtime wired through `with_mcp_oauth`, as `app_server` does.
fn oauth_fixture(user: Value) -> (Fixture, Arc<MemoryOAuthStore>) {
    let facts = EnvFacts {
        cwd: EnvPath::new(ROOT),
        platform: "linux".to_owned(),
        os_version: "Linux".to_owned(),
        shell: "bash".to_owned(),
        is_git_repo: true,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    };
    let env = MemoryEnvironment::new(facts).with_file("/Users/dev/repo/.git/HEAD", "ref");
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join(".zcode/cli/config.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, user.to_string()).unwrap();
    let paths = StoragePaths::resolve(&Default::default(), home.path(), home.path());
    let scope = TaskScope::root("app-workspace-oauth-test", |_| {});
    let transport = Arc::new(Recording::default());
    let slots = Arc::new(Slots::default());
    let layer = Arc::new(Layer::default());
    let hooks = slots.accepted.clone();
    let store = Arc::new(MemoryOAuthStore::default());
    let admin = AppWorkspace::new(
        (Arc::new(env) as Arc<dyn Files>, paths),
        ProcessConfig {
            process_env: EnvSnapshot::default(),
        },
        slots.clone(),
        layer.clone(),
        (
            transport.clone(),
            scope.spawner(),
            Arc::new(FixedClock(1_767_225_600_000)),
        ),
        Arc::new(Plugins(None)),
    )
    .with_mcp_oauth(store.clone(), Arc::new(DiscoveryOnly));
    let fixture = Fixture {
        _home: home,
        _scope: scope,
        admin,
        transport,
        hooks,
        slots,
        layer,
    };
    (fixture, store)
}

#[tokio::test]
async fn a_401_starts_the_flow_and_the_row_shows_connecting_with_the_authorization() {
    let (fixture, store) = oauth_fixture(json!({"mcp": {"servers": {
        "oauth-remote": {"type": "http", "url": "https://mcp.example.test/mcp"},
    }}}));
    // The connect is refused with 401; the lane manager starts the flow once.
    let _ = list(&fixture, "k", true).await;
    assert_eq!(fixture.transport.started(), ["oauth-remote"]);

    // The flow publishes its pending record and the status read turns the row into `connecting`.
    let deadline = Instant::now() + Duration::from_secs(10);
    let row = loop {
        let row = list(&fixture, "k", false).await["oauth-remote"].clone();
        if row["status"] == "connecting" {
            break row;
        }
        assert!(
            Instant::now() < deadline,
            "the row never showed connecting: {row}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(row["authorization"]["type"], "oauth_authorization_code");
    let url = row["authorization"]["authorizationUrl"].as_str().unwrap();
    assert!(
        url.starts_with("https://mcp.example.test/authorize?"),
        "{url}"
    );
    assert!(url.contains("code_challenge_method=S256"), "{url}");
    assert!(row["authorization"]["startedAt"].is_string());
    // The status reads did not connect again.
    assert_eq!(fixture.transport.started(), ["oauth-remote"]);
    let prefix = credential_key_prefix(
        "oauth-remote",
        "https://mcp.example.test/mcp",
        None,
        None,
        None,
    );
    assert!(
        store
            .load(&credential_key(&prefix, "pending_authorization"))
            .await
            .unwrap()
            .is_some()
    );
}

#[test]
fn the_production_app_server_wires_mcp_oauth_into_the_workspace() {
    // Guard on the production call site: if `app_server` stops passing the store and runtime, this fails.
    let source: String = include_str!("app_server.rs").split_whitespace().collect();
    assert!(
        source.contains(".with_mcp_oauth(opened.platform.mcp_oauth_store(),opened.platform.mcp_oauth_runtime(),)"),
        "app_server.rs no longer wires the MCP OAuth store and runtime into the workspace"
    );
}

#[tokio::test]
async fn a_status_read_lists_plugin_servers_without_loading_the_layer() {
    let fixture = fixture_with_plugin(json!({}), json!({}));
    let statuses = list(&fixture, "k", false).await;
    let row = &statuses["plugin:toolkit:db"];
    assert_eq!(row["status"], "disconnected");
    assert_eq!(row["transport"], "stdio");
    assert_eq!(row["toolCount"], 0);
    assert!(row.get("workspaceTrust").is_none());
    // Node reads the plugin set per request and starts nothing for it: no lane, no layer load.
    assert!(fixture.transport.started().is_empty());
    assert!(fixture.layer.loaded().is_empty());
}

#[tokio::test]
async fn a_connect_admits_the_plugin_server_with_its_plugin_env() {
    let fixture = fixture_with_plugin(json!({}), json!({}));
    let statuses = list(&fixture, "k", true).await;
    // The read does not wait for the plugin server, so its connect task records the request a little later.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while fixture.transport.started().is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the plugin server was never connected");
    assert_eq!(fixture.transport.started(), ["plugin:toolkit:db"]);
    assert_eq!(
        fixture
            .transport
            .stdio_env("plugin:toolkit:db")
            .get("CLAUDE_PLUGIN_ROOT")
            .map(String::as_str),
        Some(PLUGIN_DIR)
    );
    // The read no longer waits for plugin servers, so the refused connect may still be in flight when it returns.
    assert!(matches!(
        statuses["plugin:toolkit:db"]["status"].as_str(),
        Some("connecting" | "failed")
    ));
    assert!(
        statuses["plugin:toolkit:db"]
            .get("workspaceTrust")
            .is_none()
    );
}

#[tokio::test]
async fn a_host_dto_entry_replaces_the_plugin_server_of_the_same_name() {
    let fixture = fixture_with_plugin(json!({}), json!({}));
    let dtos =
        [json!({"name": "plugin:toolkit:db", "command": "node", "args": ["mine.js"], "env": []})];
    let result = fixture
        .admin
        .mcp_list(&target("k"), Some(&dtos), true)
        .await
        .unwrap();
    let statuses = result["statuses"].as_object().unwrap();
    assert_eq!(fixture.transport.started(), ["plugin:toolkit:db"]);
    // The DTO replaced the plugin server: its env no longer carries the plugin root.
    assert!(
        !fixture
            .transport
            .stdio_env("plugin:toolkit:db")
            .contains_key("CLAUDE_PLUGIN_ROOT")
    );
    assert_eq!(statuses["plugin:toolkit:db"]["status"], "failed");
}

#[tokio::test]
async fn an_unreadable_workspace_config_lists_no_plugin_rows() {
    let fixture = fixture_with("{}", json!({}), plugin_files(), None, |env| env);
    let statuses = list(&fixture, "k", false).await;
    assert!(statuses.get("plugin:toolkit:db").is_none());
}

/// A transport whose connects never complete, as a server that never answers its handshake behaves.
#[derive(Default)]
struct Silent;

#[async_trait]
impl McpTransport for Silent {
    async fn connect(&self, _: &WorkspaceRef, _: McpConnect) -> Result<McpConnectionId, McpError> {
        std::future::pending().await
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

#[tokio::test]
async fn a_silent_plugin_server_does_not_hold_the_settings_read() {
    let mut fixture = fixture_with_plugin(json!({}), json!({}));
    fixture.admin.transport = Arc::new(Silent);
    // The plugin server gets a 200 ms connect timeout (its `timeoutMs` default is the settings default, 30 s in
    // production). Node awaits each connection of the lane within that bound, so the read returns with the server
    // `failed` and the timeout message, well inside the Desktop's read timeout.
    fixture.admin.mcp.connect_timeout_ms = 200;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        fixture.admin.mcp_list(&target("k"), None, true),
    )
    .await
    .expect("mcp/list waited past the connect timeout of a silent plugin server")
    .unwrap();
    let row = &result["statuses"]["plugin:toolkit:db"];
    assert_eq!(row["status"], "failed");
    assert_eq!(
        row["error"],
        "MCP server plugin:toolkit:db connection timed out after 200ms"
    );
}
