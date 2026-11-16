//! The per-workspace layer (specs/fork-rust-workspace-plugins-mcp.md): lazy load, fail-closed
//! invalid slots, and the group lifecycle.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::mcp::McpTransportConfig;

use super::*;
use crate::mcp::workspaces::WorkspaceMcp;
use crate::mcp::{McpManager, McpSettings};
use crate::test_support::FakeMcp;

struct Fixed(Option<WorkspaceConfig>);

#[async_trait]
impl WorkspaceConfigLoader for Fixed {
    async fn load(&self, _workspace: &WorkspaceRef) -> Option<WorkspaceConfig> {
        self.0.clone()
    }
}

/// Answers a scripted sequence, one config per call: the test drives a load then a reload.
struct Seq(std::sync::Mutex<std::collections::VecDeque<Option<WorkspaceConfig>>>);

#[async_trait]
impl WorkspaceConfigLoader for Seq {
    async fn load(&self, _workspace: &WorkspaceRef) -> Option<WorkspaceConfig> {
        self.0
            .lock()
            .unwrap()
            .pop_front()
            .expect("every call has a scripted answer")
    }
}

/// A loader whose calls answer through channels the test holds: each call pops the next receiver,
/// so the test decides when a concurrent load or reload proceeds (and `calls` shows it entered).
struct Gated {
    answers: std::sync::Mutex<
        std::collections::VecDeque<tokio::sync::oneshot::Receiver<Option<WorkspaceConfig>>>,
    >,
    calls: std::sync::atomic::AtomicUsize,
}

impl Gated {
    fn calls(&self) -> usize {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait]
impl WorkspaceConfigLoader for Gated {
    async fn load(&self, _workspace: &WorkspaceRef) -> Option<WorkspaceConfig> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let receiver = self
            .answers
            .lock()
            .unwrap()
            .pop_front()
            .expect("every call has a gated answer");
        match receiver.await {
            Ok(answer) => answer,
            Err(_) => panic!("the test answers every gated call"),
        }
    }
}

fn gated(
    answers: usize,
) -> (
    Arc<Gated>,
    Vec<tokio::sync::oneshot::Sender<Option<WorkspaceConfig>>>,
) {
    let (senders, receivers) = (0..answers)
        .map(|_| tokio::sync::oneshot::channel())
        .unzip();
    (
        Arc::new(Gated {
            answers: std::sync::Mutex::new(receivers),
            calls: std::sync::atomic::AtomicUsize::new(0),
        }),
        senders,
    )
}

// WorkspaceConfig is not Clone-sensitive here; build one with a project server.
fn config_with_server(name: &str) -> WorkspaceConfig {
    WorkspaceConfig {
        plugins: PluginSources::default(),
        servers: vec![McpServer {
            name: name.to_owned(),
            scope: crate::mcp::McpScope::Project,
            transport: McpTransportConfig::stdio("node".to_owned(), Vec::new()),
            options: Default::default(),
            machine: Default::default(),
        }],
    }
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
        root: crate::EnvPath::new("/w"),
    }
}

fn files() -> Arc<rust_cli_kernel_api::testing::MemoryEnvironment> {
    Arc::new(rust_cli_kernel_api::testing::MemoryEnvironment::new(
        crate::test_support::facts(),
    ))
}

fn layer(fake: &Arc<FakeMcp>, scope: &TaskScope) -> (Arc<WorkspaceMcp>, WorkspaceLayer) {
    let process = Arc::new(McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
    ));
    let mcp = Arc::new(WorkspaceMcp::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
        None,
        process,
    ));
    let layer = WorkspaceLayer::new(files(), mcp.clone(), Vec::new(), Vec::new(), None);
    (mcp, layer)
}

fn names(mcp: &WorkspaceMcp, key: &str) -> Vec<String> {
    mcp.group(key)
        .map(|manager| {
            manager
                .server_infos()
                .into_iter()
                .map(|info| info.name)
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn a_loaded_layer_starts_the_workspace_group() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let (mcp, layer) = layer(&fake, &scope);
    layer.set_loader(Arc::new(Fixed(Some(config_with_server("project-server")))));

    layer.load(&workspace()).await;

    assert!(matches!(layer.slot("/w"), Some(super::Slot::Loaded(_))));
    assert!(
        layer.plugins_of(&workspace()).is_some(),
        "a loaded slot carries the workspace's plugin set"
    );
    assert_eq!(names(&mcp, "/w"), ["project-server"]);
}

#[tokio::test]
async fn a_broken_project_layer_is_fail_closed() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let (mcp, layer) = layer(&fake, &scope);
    layer.set_loader(Arc::new(Fixed(Some(config_with_server("first")))));
    layer.load(&workspace()).await;

    // The config turns unreadable: the group stops, the slot is Invalid, the process set stays.
    let broken = WorkspaceLayer::new(files(), mcp.clone(), Vec::new(), Vec::new(), None);
    broken.set_loader(Arc::new(Fixed(None)));
    broken.load(&workspace()).await;

    assert!(matches!(broken.slot("/w"), Some(super::Slot::Invalid)));
    assert!(broken.plugins_of(&workspace()).is_none());
    assert!(mcp.group("/w").is_none());
}

#[tokio::test]
async fn without_a_loader_nothing_loads() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let (mcp, layer) = layer(&fake, &scope);

    layer.load(&workspace()).await;

    assert!(layer.slot("/w").is_none());
    assert!(mcp.group("/w").is_none());
}

/// Fork (specs/fork-rust-node-helper.md F3, per-workspace admission): a session resolves its
/// workspace's plugin set through its recorded workspace, mirroring the MCP group resolution — the
/// helper catalog of a session whose workspace has a loaded layer comes from that set, and any
/// other session resolves none (the caller keeps the process catalog).
#[tokio::test]
async fn a_session_resolves_its_workspaces_plugin_set() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let (mcp, layer) = layer(&fake, &scope);
    layer.set_loader(Arc::new(Fixed(Some(config_with_server("project-server")))));

    let sessions = rust_cli_kernel_api::workspace_key::SessionWorkspaces::default();
    sessions.record(&rust_cli_kernel_api::ids::SessionId::new("s1"), workspace());
    layer.load(&workspace()).await;

    assert!(
        layer
            .plugins_of_session(&sessions, &rust_cli_kernel_api::ids::SessionId::new("s1"))
            .is_some(),
        "a session of the loaded workspace resolves that workspace's set"
    );
    // A session without a recorded workspace (never opened in this process) resolves none.
    assert!(
        layer
            .plugins_of_session(&sessions, &rust_cli_kernel_api::ids::SessionId::new("s2"))
            .is_none()
    );

    // Fail-closed: a workspace whose layer is Invalid resolves none, like its MCP group.
    let broken = WorkspaceLayer::new(files(), mcp.clone(), Vec::new(), Vec::new(), None);
    broken.set_loader(Arc::new(Fixed(None)));
    broken.load(&workspace()).await;
    assert!(
        broken
            .plugins_of_session(&sessions, &rust_cli_kernel_api::ids::SessionId::new("s1"))
            .is_none()
    );
}

/// Fork (specs/fork-rust-workspace-plugins-mcp.md, "As built: plugin hooks per workspace"): installing a
/// `Loaded` slot hands the workspace's plugin set to the hooks sink (the runtime registers its hooks with the
/// engine under the same key).
#[tokio::test]
async fn a_loaded_slot_hands_its_plugin_set_to_the_hooks_sink() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let process = Arc::new(McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
    ));
    let mcp = Arc::new(WorkspaceMcp::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
        None,
        process,
    ));
    let files = Arc::new(
        rust_cli_kernel_api::testing::MemoryEnvironment::new(crate::test_support::facts())
            .with_file(
                "/plugins/kit/hooks/hooks.json",
                r#"{"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "kit.sh"}]}]}}"#,
            ),
    );
    let layer = WorkspaceLayer::new(
        files,
        mcp,
        vec![crate::EnvPath::new("/plugins/kit")],
        Vec::new(),
        None,
    );
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    layer.set_plugin_hooks_sink({
        let seen = seen.clone();
        Box::new(move |key, plugins| {
            let names: Vec<&str> = plugins
                .0
                .iter()
                .map(|plugin| plugin.name.as_str())
                .collect();
            seen.lock()
                .unwrap()
                .push(format!("{}:{}", key, names.join(",")));
        })
    });
    layer.set_loader(Arc::new(Fixed(Some(WorkspaceConfig {
        plugins: PluginSources::default(),
        servers: Vec::new(),
    }))));

    layer.load(&workspace()).await;

    assert_eq!(seen.lock().unwrap().clone(), ["/w:kit".to_owned()]);
    // The set the sink saw carries the plugin's hooks file.
    let plugins = layer.plugins_of(&workspace()).expect("the slot is loaded");
    assert_eq!(
        plugins
            .0
            .iter()
            .map(|plugin| plugin.hooks.len())
            .collect::<Vec<_>>(),
        [1]
    );
    // A loaded slot is reused, not installed again: the sink does not fire a second time.
    layer.load(&workspace()).await;
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn an_invalid_slot_does_not_reach_the_hooks_sink() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let (_mcp, layer) = layer(&fake, &scope);
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    layer.set_plugin_hooks_sink({
        let seen = seen.clone();
        Box::new(move |key, _plugins| seen.lock().unwrap().push(key.to_owned()))
    });
    layer.set_loader(Arc::new(Fixed(None)));

    layer.load(&workspace()).await;

    // Fail-closed: the workspace keeps the process set, so nothing registers.
    assert!(matches!(layer.slot("/w"), Some(super::Slot::Invalid)));
    assert!(seen.lock().unwrap().is_empty());
}

/// Fork (specs/fork-rust-workspace-plugins-mcp.md, "As built: layer reload"): a reload past the
/// loaded-slot reuse replaces the slot and the group (the replaced group's connections stop) and
/// re-fires the hooks sink for the new set.
#[tokio::test]
async fn a_reload_replaces_the_slot_the_group_and_refires_the_sink() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let (mcp, layer) = layer(&fake, &scope);
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    layer.set_plugin_hooks_sink({
        let seen = seen.clone();
        Box::new(move |key, _plugins| seen.lock().unwrap().push(key.to_owned()))
    });
    layer.set_loader(Arc::new(Seq(std::sync::Mutex::new(
        [
            Some(config_with_server("first")),
            Some(config_with_server("second")),
        ]
        .into(),
    ))));

    layer.load(&workspace()).await;
    let before = layer.plugins_of(&workspace()).expect("the slot is loaded");
    assert_eq!(names(&mcp, "/w"), ["first"]);

    layer.reload(&workspace()).await;

    let after = layer.plugins_of(&workspace()).expect("the slot is loaded");
    assert!(
        !Arc::ptr_eq(&before, &after),
        "the reload replaced the slot, it did not reuse it"
    );
    assert_eq!(names(&mcp, "/w"), ["second"]);
    assert_eq!(
        seen.lock().unwrap().clone(),
        ["/w".to_owned(), "/w".to_owned()],
        "the sink re-fires once for the reloaded set"
    );
}

/// The epoch ordering (the hooks engine's `put_project_at` shape): a session load that started
/// before a reload never installs its older read over the newer slot — and it must not replace the
/// group either, so the acceptance check covers the group swap.
#[tokio::test]
async fn an_older_load_never_installs_over_a_newer_reload() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let (mcp, owned) = layer(&fake, &scope);
    let layer = Arc::new(owned);
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    layer.set_plugin_hooks_sink({
        let seen = seen.clone();
        Box::new(move |key, _plugins| seen.lock().unwrap().push(key.to_owned()))
    });
    let (loader, mut answers) = gated(2);
    layer.set_loader(loader.clone());

    // The session-open load claims the workspace and enters its gated read first.
    let older = {
        let layer = layer.clone();
        tokio::spawn(async move { layer.load(&workspace()).await })
    };
    let entered = async {
        while loader.calls() < 1 {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_millis(500), entered)
        .await
        .expect("the older load started reading");

    // The reload (a config write committed meanwhile) reserves after it and installs first.
    let reload_answer = answers.pop().expect("two answers");
    reload_answer
        .send(Some(config_with_server("second")))
        .unwrap_or_else(|_| panic!("the reload's answer was not awaited"));
    layer.reload(&workspace()).await;
    assert_eq!(names(&mcp, "/w"), ["second"]);

    // The older read finishes last: its put is refused, the group keeps the reload's set.
    let older_answer = answers.pop().expect("two answers");
    older_answer
        .send(Some(config_with_server("first")))
        .unwrap_or_else(|_| panic!("the older load's answer was not awaited"));
    older.await.expect("the older load finished");
    assert_eq!(names(&mcp, "/w"), ["second"]);
    assert_eq!(
        seen.lock().unwrap().clone(),
        ["/w".to_owned()],
        "only the reload's set reached the sink"
    );
}

/// A reload whose read fails is fail-closed exactly like a first load (`Invalid`, the group stops,
/// nothing registers), and a later reload recovers; a workspace that never loaded stays unloaded.
#[tokio::test]
async fn a_broken_reload_is_fail_closed_and_recovers() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let (mcp, layer) = layer(&fake, &scope);
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    layer.set_plugin_hooks_sink({
        let seen = seen.clone();
        Box::new(move |key, _plugins| seen.lock().unwrap().push(key.to_owned()))
    });
    layer.set_loader(Arc::new(Seq(std::sync::Mutex::new(
        [
            Some(config_with_server("first")),
            None,
            Some(config_with_server("second")),
        ]
        .into(),
    ))));

    layer.load(&workspace()).await;
    assert_eq!(names(&mcp, "/w"), ["first"]);

    layer.reload(&workspace()).await;
    assert!(matches!(layer.slot("/w"), Some(super::Slot::Invalid)));
    assert!(layer.plugins_of(&workspace()).is_none());
    assert!(mcp.group("/w").is_none());
    assert_eq!(
        seen.lock().unwrap().clone(),
        ["/w".to_owned()],
        "an invalid reload does not reach the sink"
    );

    layer.reload(&workspace()).await;
    assert!(matches!(layer.slot("/w"), Some(super::Slot::Loaded(_))));
    assert_eq!(names(&mcp, "/w"), ["second"]);
}

/// The reload stays lazy: a workspace with neither a slot nor a load in flight does not load on a
/// reload (nothing in this process uses it yet; its next session open reads the config directly).
#[tokio::test]
async fn a_reload_of_a_never_loaded_workspace_loads_nothing() {
    let scope = TaskScope::root("test", |_| {});
    let fake: Arc<FakeMcp> = Arc::new(FakeMcp::default());
    let (mcp, layer) = layer(&fake, &scope);
    // Any loader call panics ("a gated answer"): the reload must not read.
    let (loader, _answers) = gated(0);
    layer.set_loader(loader);

    layer.reload(&workspace()).await;

    assert!(layer.slot("/w").is_none());
    assert!(mcp.group("/w").is_none());
}
