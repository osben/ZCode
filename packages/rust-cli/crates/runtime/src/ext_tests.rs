//! 插件的 agent 与 hooks 接线（ext.md §4，L12）。

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use rust_cli_ext::{Plugin, PluginAgentFile as ExtAgentFile, Plugins};
use rust_cli_kernel_api::env::{EnvFacts, EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{CommandId, EnvironmentId, SessionId};
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::session_api::{
    Command, CommandEnvelope, CreateSession, Delivery, Kernel, KernelEvent,
};
use rust_cli_kernel_api::testing::{
    FixedClock, MemoryEnvironment, MemoryStore, ScriptedModel, SequentialIds, environments,
    selection, text_response,
};
use serde_json::json;

use super::*;
use crate::{CompactConfig, ContextConfig, Defaults, LocalKernel, Ports, Surface};
use rust_cli_agents::MemoryTaskLists;
use rust_cli_kernel_api::permission::PermissionMode;

const KIT: &str = "/Users/dev/plugins/kit";

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/Users/dev/work"),
    }
}

#[test]
fn plugin_parts_carry_the_plugin_name_and_root() {
    let plugins = Plugins(vec![Plugin {
        id: "kit@inline".to_owned(),
        name: "kit".to_owned(),
        dir: KIT.to_owned(),
        manifest: json!({}),
        skill_dirs: Vec::new(),
        mcp_servers: Vec::new(),
        agent_files: vec![ExtAgentFile {
            path: format!("{KIT}/agents/team/lead.md"),
            namespace: vec!["team".to_owned()],
        }],
        hooks: vec![
            json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "a.sh"}]}]}}),
        ],
    }]);
    let (agents, hooks) = plugin_parts(&plugins);
    assert_eq!(
        agents,
        [rust_cli_agents::PluginAgentFile {
            id: "kit@inline".to_owned(),
            plugin: "kit".to_owned(),
            root: KIT.to_owned(),
            path: format!("{KIT}/agents/team/lead.md"),
            namespace: vec!["team".to_owned()],
        }]
    );
    assert_eq!(hooks.len(), 1);
    assert_eq!(hooks[0].root, KIT);
}

/// 插件 agent 经 `start_extensions` 进入主线程的 agent 清单（context 与 Agent 工具共用一个目录）。
#[tokio::test]
async fn plugin_agents_reach_the_agent_listing() {
    let env = MemoryEnvironment::new(EnvFacts {
        cwd: EnvPath::new("/Users/dev/work"),
        platform: "darwin".to_owned(),
        os_version: "Darwin 24".to_owned(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    })
    .with_file(
        &format!("{KIT}/agents/helper.md"),
        "---\ndescription: Plugin helper.\n---\nHelp.",
    );
    let store = Arc::new(MemoryStore::default());
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["ok"])]));
    let kernel = LocalKernel::with_extensions(
        Ports {
            model,
            environments: environments(Arc::new(env)),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
        ContextConfig::new(Surface::Print),
        CompactConfig::default(),
        Arc::new(MemoryTaskLists::default()),
        Extensions {
            config: ExtConfig {
                plugin_dirs: vec![EnvPath::new(KIT)],
                workspace: Some(workspace()),
                ..ExtConfig::default()
            },
            cron_store: None,
            peers: rust_cli_session::PeerDeps::off(),
            streaming_input: false,
            monitor: false,
            node_desktop: false,
            automation: None,
            topic_resources: None,
            acp: None,
            code_intelligence: None,
            subagent_config: None,
            models: None,
            hook_transcripts: None,
        },
    );
    kernel.start_extensions().await;
    let id = kernel
        .create_session(CreateSession {
            id: None,
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
            incognito: None,
        })
        .await
        .unwrap();
    let session = kernel.open_session(&id).await.unwrap();
    let mut events = session.subscribe(Some(0));
    session
        .send(CommandEnvelope {
            id: CommandId::new("c1"),
            command: Command::Submit {
                text: "hello".to_owned(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            },
        })
        .await;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .unwrap()
            .unwrap();
        if matches!(event.event, KernelEvent::TurnFinished { .. }) {
            break;
        }
    }
    let listing = session
        .view()
        .await
        .unwrap()
        .messages
        .into_iter()
        .find_map(|message| match message {
            Message::Attachment(attachment) if attachment.source == "agent_listing_delta" => {
                Some(attachment.text)
            }
            _ => None,
        })
        .unwrap();
    assert!(
        listing.contains("- kit:helper: Plugin helper. (Tools: All tools)"),
        "{listing}"
    );
}

/// Fork (specs/fork-rust-agent-parity.md, "Incognito sessions"): `system/init` of `-p` reads the session catalog, so an
/// incognito session without `plugins` lists neither plugin skills nor plugin MCP servers; a normal session does.
#[tokio::test]
async fn the_session_catalog_follows_the_incognito_profile() {
    let env = MemoryEnvironment::new(EnvFacts {
        cwd: EnvPath::new("/Users/dev/work"),
        platform: "darwin".to_owned(),
        os_version: "Darwin 24".to_owned(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    })
    .with_file(
        &format!("{KIT}/skills/hello/SKILL.md"),
        "---\ndescription: Say hello.\n---\nHello.",
    )
    .with_file(
        &format!("{KIT}/.mcp.json"),
        r#"{"mcpServers": {"api": {"command": "node", "args": []}}}"#,
    );
    let store = Arc::new(MemoryStore::default());
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let kernel = LocalKernel::with_extensions(
        Ports {
            model,
            environments: environments(Arc::new(env)),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
        ContextConfig::new(Surface::Print),
        CompactConfig::default(),
        Arc::new(MemoryTaskLists::default()),
        Extensions {
            config: ExtConfig {
                plugin_dirs: vec![EnvPath::new(KIT)],
                workspace: Some(workspace()),
                ..ExtConfig::default()
            },
            cron_store: None,
            peers: rust_cli_session::PeerDeps::off(),
            streaming_input: false,
            monitor: false,
            node_desktop: false,
            automation: None,
            topic_resources: None,
            acp: None,
            code_intelligence: None,
            subagent_config: None,
            models: None,
            hook_transcripts: None,
        },
    );
    kernel.start_extensions().await;
    let create = |incognito| CreateSession {
        id: None,
        workspace: workspace(),
        selection: selection(),
        mode: PermissionMode::Default,
        plan: false,
        incognito,
    };
    let normal = kernel.create_session(create(None)).await.unwrap();
    let without_plugins = kernel
        .create_session(create(Some(
            rust_cli_kernel_api::incognito::IncognitoProfile {
                skills: true,
                mcp: true,
                ..rust_cli_kernel_api::incognito::IncognitoProfile::LOCKDOWN
            },
        )))
        .await
        .unwrap();
    let catalog = |session| {
        kernel.session_catalog(rust_cli_kernel_api::catalog::CatalogQuery {
            session,
            workspace: workspace(),
            selection: selection(),
        })
    };
    let normal = catalog(normal).await.unwrap();
    let plugin_skill = |catalog: &rust_cli_kernel_api::catalog::SessionCatalog| {
        catalog.skills.iter().any(|name| name.contains("hello"))
    };
    let plugin_server = |catalog: &rust_cli_kernel_api::catalog::SessionCatalog| {
        catalog.mcp_servers.iter().any(|name| name.contains("api"))
    };
    assert!(plugin_skill(&normal), "{normal:?}");
    assert!(plugin_server(&normal), "{normal:?}");
    let locked = catalog(without_plugins).await.unwrap();
    assert!(!plugin_skill(&locked), "{locked:?}");
    assert!(!plugin_server(&locked), "{locked:?}");
}

/// Fork (specs/fork-rust-automations.md, slice 2): with the desktop Host's automation port the Cron tools are Node's
/// five, not deferred, in place of this process's cron; ScheduleWakeup stays.
#[test]
fn the_host_automation_port_replaces_the_local_cron_tools() {
    struct Unused;
    #[async_trait::async_trait]
    impl rust_cli_kernel_api::automation::AutomationPort for Unused {
        async fn request(
            &self,
            _session: &rust_cli_kernel_api::ids::SessionId,
            _method: &str,
            _params: serde_json::Value,
        ) -> Result<serde_json::Value, rust_cli_kernel_api::automation::AutomationError> {
            Err(rust_cli_kernel_api::automation::AutomationError::new(
                "unused",
            ))
        }
    }
    let env = MemoryEnvironment::new(EnvFacts {
        cwd: EnvPath::new("/Users/dev/work"),
        platform: "darwin".to_owned(),
        os_version: "Darwin 24".to_owned(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    });
    let store = Arc::new(MemoryStore::default());
    let ports = Ports {
        model: Arc::new(ScriptedModel::new(Vec::new())),
        environments: environments(Arc::new(env)),
        store: store.clone(),
        artifacts: store,
        clock: Arc::new(FixedClock(1_000)),
        ids: Arc::new(SequentialIds::default()),
    };
    let defaults = Defaults {
        selection: selection().into(),
        mode: PermissionMode::Default,
        max_turns: None,
        search_tools: false,
        task_tools: None,
        limits: Default::default(),
    };
    let traits = crate::assemble::SurfaceTraits::new(false, false);
    let gate = crate::assemble::gate(&ports, true);
    let names = |extensions: &Extensions| {
        let base = crate::assemble::base_tools(&ports, &defaults, extensions, (traits, &gate));
        base.registry
            .tools()
            .iter()
            .filter(|tool| tool.name().starts_with("Cron") || tool.name() == "ScheduleWakeup")
            .map(|tool| (tool.name().to_owned(), tool.should_defer()))
            .collect::<Vec<_>>()
    };
    let local = names(&Extensions::none());
    assert_eq!(
        local,
        [
            ("CronCreate".to_owned(), true),
            ("CronDelete".to_owned(), true),
            ("CronList".to_owned(), true),
            ("ScheduleWakeup".to_owned(), false),
        ]
    );
    // The swap keys on the port alone: without `node_desktop`, and `node_desktop` without a port keeps the local tools.
    assert_eq!(
        names(&Extensions {
            node_desktop: true,
            ..Extensions::none()
        }),
        local
    );
    let desktop = Extensions {
        automation: Some(Arc::new(Unused)),
        ..Extensions::none()
    };
    assert_eq!(
        names(&desktop),
        [
            ("CronCreate".to_owned(), false),
            ("CronList".to_owned(), false),
            ("CronUpdate".to_owned(), false),
            ("CronDelete".to_owned(), false),
            ("CronPauseSelf".to_owned(), false),
            ("ScheduleWakeup".to_owned(), false),
        ]
    );
}

struct NoTopic;

#[async_trait::async_trait]
impl rust_cli_kernel_api::topic_resource::TopicResources for NoTopic {
    async fn read(
        &self,
        _request: rust_cli_kernel_api::topic_resource::TopicResourceRequest,
    ) -> Result<rust_cli_kernel_api::topic_resource::TopicResource, String> {
        Err("unused".to_owned())
    }
}

/// Fork (specs/fork-rust-topic-resource.md, acceptance case 3): `ReadTopicResource` exists only when the entry gives
/// topic resources (the app-server).
#[tokio::test]
async fn read_topic_resource_is_registered_only_with_topic_resources() {
    for (resources, expected) in [
        (None, false),
        (
            Some(Arc::new(NoTopic)
                as Arc<
                    dyn rust_cli_kernel_api::topic_resource::TopicResources,
                >),
            true,
        ),
    ] {
        let env = MemoryEnvironment::new(EnvFacts {
            cwd: EnvPath::new("/Users/dev/work"),
            platform: "darwin".to_owned(),
            os_version: "Darwin 24".to_owned(),
            shell: "zsh".to_owned(),
            is_git_repo: false,
            home: Some(EnvPath::new("/Users/dev")),
            uid: None,
        });
        let store = Arc::new(MemoryStore::default());
        let kernel = LocalKernel::with_extensions(
            Ports {
                model: Arc::new(ScriptedModel::new(Vec::new())),
                environments: environments(Arc::new(env)),
                store: store.clone(),
                artifacts: store,
                clock: Arc::new(FixedClock(1_000)),
                ids: Arc::new(SequentialIds::default()),
            },
            Defaults {
                selection: selection().into(),
                mode: PermissionMode::Default,
                max_turns: None,
                search_tools: false,
                task_tools: None,
                limits: Default::default(),
            },
            ContextConfig::new(Surface::Print),
            CompactConfig::default(),
            Arc::new(MemoryTaskLists::default()),
            Extensions {
                topic_resources: resources,
                ..Extensions::none()
            },
        );
        let session = kernel
            .create_session(CreateSession {
                id: None,
                workspace: workspace(),
                selection: selection(),
                mode: PermissionMode::Default,
                plan: false,
                incognito: None,
            })
            .await
            .unwrap();
        let catalog = kernel
            .session_catalog(rust_cli_kernel_api::catalog::CatalogQuery {
                session,
                workspace: workspace(),
                selection: selection(),
            })
            .await
            .unwrap();
        assert_eq!(
            catalog
                .tools
                .iter()
                .any(|name| name == rust_cli_kernel_api::tool_names::READ_TOPIC_RESOURCE),
            expected,
            "{:?}",
            catalog.tools
        );
    }
}

struct NoAutomations;

#[async_trait::async_trait]
impl rust_cli_kernel_api::automation::AutomationPort for NoAutomations {
    async fn request(
        &self,
        _session: &rust_cli_kernel_api::ids::SessionId,
        _method: &str,
        _params: serde_json::Value,
    ) -> Result<serde_json::Value, rust_cli_kernel_api::automation::AutomationError> {
        Err(rust_cli_kernel_api::automation::AutomationError::new(
            "unused",
        ))
    }
}

/// Fork (specs/fork-rust-automations.md, slice 2): with the Host's automation port the local cron gets no store, even
/// when an embedder passes one too, so persisted local jobs never fire beside the Host's scheduler.
#[test]
fn the_host_automation_port_leaves_the_local_cron_without_a_store() {
    let store: Arc<dyn rust_cli_kernel_api::cron_store::CronStore> =
        Arc::new(rust_cli_kernel_api::testing::MemoryCronStore::default());
    let local = Extensions {
        cron_store: Some(store.clone()),
        ..Extensions::none()
    };
    assert!(crate::assemble::cron_store(&local).is_some());
    let desktop = Extensions {
        cron_store: Some(store),
        automation: Some(Arc::new(NoAutomations)),
        ..Extensions::none()
    };
    assert!(crate::assemble::cron_store(&desktop).is_none());
}

/// Fork: `/loop` is hidden exactly when the Cron tools are the Host's: the runtime derives the flag from the port, so a
/// caller cannot set one without the other.
#[test]
fn host_automations_follow_the_automation_port() {
    let mut stale = Extensions::none();
    stale.config.host_automations = true;
    assert!(!crate::assemble::ext_config(&stale).host_automations);
    let desktop = Extensions {
        automation: Some(Arc::new(NoAutomations)),
        ..Extensions::none()
    };
    assert!(crate::assemble::ext_config(&desktop).host_automations);
}

/// A workspace layer loader that always answers one fixed config (the fail-closed case is `None`).
struct FixedLayer(Option<rust_cli_ext::WorkspaceConfig>);

#[async_trait::async_trait]
impl rust_cli_ext::WorkspaceConfigLoader for FixedLayer {
    async fn load(
        &self,
        _workspace: &rust_cli_kernel_api::env::WorkspaceRef,
    ) -> Option<rust_cli_ext::WorkspaceConfig> {
        self.0.clone()
    }
}

/// A loader the test flips between answers, for the kernel's layer reload.
struct SwitchingLayer(std::sync::Mutex<Option<rust_cli_ext::WorkspaceConfig>>);

#[async_trait::async_trait]
impl rust_cli_ext::WorkspaceConfigLoader for SwitchingLayer {
    async fn load(
        &self,
        _workspace: &rust_cli_kernel_api::env::WorkspaceRef,
    ) -> Option<rust_cli_ext::WorkspaceConfig> {
        self.0.lock().unwrap().clone()
    }
}

/// Fork (specs/fork-rust-node-helper.md F3, per-workspace admission): a session of a workspace with
/// a loaded layer resolves that workspace's plugin set; the process workspace and unknown sessions
/// resolve none, so the helper's catalog falls back to the process one for them.
#[tokio::test]
async fn a_session_resolves_its_workspaces_plugins() {
    let env = MemoryEnvironment::new(EnvFacts {
        cwd: EnvPath::new("/Users/dev/work"),
        platform: "darwin".to_owned(),
        os_version: "Darwin 24".to_owned(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    });
    let store = Arc::new(MemoryStore::default());
    let kernel = LocalKernel::with_extensions(
        Ports {
            model: Arc::new(ScriptedModel::new(Vec::new())),
            environments: environments(Arc::new(env)),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
        ContextConfig::new(Surface::Print),
        CompactConfig::default(),
        Arc::new(MemoryTaskLists::default()),
        Extensions {
            config: ExtConfig {
                workspace: Some(workspace()),
                ..ExtConfig::default()
            },
            ..Extensions::none()
        },
    );
    kernel.set_workspace_config_loader(Arc::new(FixedLayer(Some(rust_cli_ext::WorkspaceConfig {
        plugins: Default::default(),
        servers: Vec::new(),
    }))));
    let other = WorkspaceRef {
        environment: workspace().environment,
        root: EnvPath::new("/Users/dev/other"),
    };
    let session = kernel
        .create_session(CreateSession {
            id: None,
            workspace: other,
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
            incognito: None,
        })
        .await
        .unwrap();
    assert!(
        kernel.plugins_for_session(&session).is_some(),
        "a session of the loaded workspace resolves that workspace's set"
    );
    // The process workspace's own sessions resolve none: the process group already serves them.
    let process = kernel
        .create_session(CreateSession {
            id: None,
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
            incognito: None,
        })
        .await
        .unwrap();
    assert!(kernel.plugins_for_session(&process).is_none());
    assert!(
        kernel
            .plugins_for_session(&rust_cli_kernel_api::ids::SessionId::new("unknown"))
            .is_none()
    );
}

/// Fork (specs/fork-rust-workspace-plugins-mcp.md, "As built: layer reload"): the kernel's reload
/// re-reads a session workspace's layer past the loaded-slot reuse — the App's committed trust
/// writes go through it — and a read that now fails is fail-closed (`Invalid`, the process set).
#[tokio::test]
async fn a_workspace_layer_reload_replaces_the_loaded_slot() {
    let env = MemoryEnvironment::new(EnvFacts {
        cwd: EnvPath::new("/Users/dev/work"),
        platform: "darwin".to_owned(),
        os_version: "Darwin 24".to_owned(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    });
    let store = Arc::new(MemoryStore::default());
    let kernel = LocalKernel::with_extensions(
        Ports {
            model: Arc::new(ScriptedModel::new(Vec::new())),
            environments: environments(Arc::new(env)),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
        ContextConfig::new(Surface::Print),
        CompactConfig::default(),
        Arc::new(MemoryTaskLists::default()),
        Extensions {
            config: ExtConfig {
                workspace: Some(workspace()),
                ..ExtConfig::default()
            },
            ..Extensions::none()
        },
    );
    let config = || {
        Some(rust_cli_ext::WorkspaceConfig {
            plugins: Default::default(),
            servers: Vec::new(),
        })
    };
    let loader = Arc::new(SwitchingLayer(std::sync::Mutex::new(config())));
    kernel.set_workspace_config_loader(loader.clone());
    let other = WorkspaceRef {
        environment: workspace().environment,
        root: EnvPath::new("/Users/dev/other"),
    };
    let session = kernel
        .create_session(CreateSession {
            id: None,
            workspace: other.clone(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
            incognito: None,
        })
        .await
        .unwrap();
    let loaded = kernel
        .plugins_for_session(&session)
        .expect("the session's workspace loaded a layer");

    kernel.reload_workspace_layer(&other).await;
    assert!(
        !Arc::ptr_eq(
            &loaded,
            &kernel
                .plugins_for_session(&session)
                .expect("the reload installed a loaded slot")
        ),
        "the reload re-read the layer, it did not reuse the slot"
    );

    // The re-read fails: the slot turns Invalid and the session falls back to the process set.
    *loader.0.lock().unwrap() = None;
    kernel.reload_workspace_layer(&other).await;
    assert!(kernel.plugins_for_session(&session).is_none());
}

/// Fork (print `--continue` prewarm, Node parity — `frontends/print.rs` kicks it): a loader whose
/// calls the test gates; each call records the workspace root it was asked for and answers through
/// a oneshot the test holds, so the test decides when the layer's read proceeds.
struct GatedLayer {
    answers: std::sync::Mutex<
        std::collections::VecDeque<
            tokio::sync::oneshot::Receiver<Option<rust_cli_ext::WorkspaceConfig>>,
        >,
    >,
    roots: std::sync::Mutex<Vec<String>>,
}

impl GatedLayer {
    fn calls(&self) -> usize {
        self.roots.lock().unwrap().len()
    }

    fn roots(&self) -> Vec<String> {
        self.roots.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl rust_cli_ext::WorkspaceConfigLoader for GatedLayer {
    async fn load(&self, workspace: &WorkspaceRef) -> Option<rust_cli_ext::WorkspaceConfig> {
        self.roots
            .lock()
            .unwrap()
            .push(workspace.root.as_str().to_owned());
        let answer = self
            .answers
            .lock()
            .unwrap()
            .pop_front()
            .expect("every call has a gated answer");
        match answer.await {
            Ok(config) => config,
            Err(_) => panic!("the test answers every gated call"),
        }
    }
}

fn gated_layer(
    answers: usize,
) -> (
    Arc<GatedLayer>,
    Vec<tokio::sync::oneshot::Sender<Option<rust_cli_ext::WorkspaceConfig>>>,
) {
    let (senders, receivers) = (0..answers)
        .map(|_| tokio::sync::oneshot::channel())
        .unzip();
    (
        Arc::new(GatedLayer {
            answers: std::sync::Mutex::new(receivers),
            roots: std::sync::Mutex::new(Vec::new()),
        }),
        senders,
    )
}

fn layer_config() -> rust_cli_ext::WorkspaceConfig {
    rust_cli_ext::WorkspaceConfig {
        plugins: Default::default(),
        servers: Vec::new(),
    }
}

/// The print entry's shape for the prewarm tests: the process workspace is `workspace()`
/// (`/Users/dev/work`), the workspace layer's loader is the test's gated one.
fn prewarm_kernel(store: Arc<MemoryStore>, loader: Arc<GatedLayer>) -> LocalKernel {
    let env = MemoryEnvironment::new(EnvFacts {
        cwd: EnvPath::new("/Users/dev/work"),
        platform: "darwin".to_owned(),
        os_version: "Darwin 24".to_owned(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        home: Some(EnvPath::new("/Users/dev")),
        uid: None,
    });
    let kernel = LocalKernel::with_extensions(
        Ports {
            model: Arc::new(ScriptedModel::new(Vec::new())),
            environments: environments(Arc::new(env)),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
        ContextConfig::new(Surface::Print),
        CompactConfig::default(),
        Arc::new(MemoryTaskLists::default()),
        Extensions {
            config: ExtConfig {
                workspace: Some(workspace()),
                ..ExtConfig::default()
            },
            ..Extensions::none()
        },
    );
    kernel.set_workspace_config_loader(loader);
    kernel
}

/// Seeds a session row straight into the store — a kernel create would load the row's layer
/// itself — like a stored session a later `--continue` run resolves.
async fn seeded_row(store: &MemoryStore, id: &str, root: &str) -> SessionId {
    use rust_cli_kernel_api::ids::TraceId;
    use rust_cli_kernel_api::store::{SessionKind, SessionMeta, SessionStore as _};
    let id = SessionId::new(id);
    store
        .create(SessionMeta {
            id: id.clone(),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: workspace().environment,
                root: EnvPath::new(root),
            },
            title: "continued".to_owned(),
            trace: TraceId::new(id.as_str()),
            created_at_ms: 1,
            incognito: None,
        })
        .await
        .unwrap();
    id
}

/// Waits (bounded, on the single-threaded test runtime) until `condition` holds.
async fn settles(within: Duration, condition: impl Fn() -> bool) {
    tokio::time::timeout(within, async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the condition settled in time");
}

/// Fork (print `--continue` prewarm, Node parity): the kicked layer load starts before the session
/// open completes — the store's `load` gate holds the open inside its cold read, and only the
/// prewarm's load has entered the loader (with the prewarm removed, a serial open stays behind the
/// store gate and the loader is never entered). Past the gate the open joins the in-flight load —
/// one read, not a second — and awaits the installed slot.
#[tokio::test]
async fn a_continue_prewarm_starts_the_layer_load_before_the_open_loads_it() {
    let store = Arc::new(MemoryStore::default());
    let (loader, mut answers) = gated_layer(1);
    let kernel = Arc::new(prewarm_kernel(store.clone(), loader.clone()));
    let id = seeded_row(store.as_ref(), "sess_continue", "/Users/dev/other").await;
    // The open's cold read waits at this gate, before its layer step.
    let gate = store.hold_next_load();

    kernel.prewarm_continue_layer(&workspace()).await;
    settles(Duration::from_millis(500), || loader.calls() >= 1).await;
    assert_eq!(loader.roots(), ["/Users/dev/other".to_owned()]);

    // The open runs concurrently and reaches the store gate; the prewarm's read is still the
    // only one the layer has started.
    let opening = tokio::spawn({
        let (kernel, id) = (kernel.clone(), id.clone());
        async move { kernel.open_session(&id).await }
    });
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
    assert!(
        !opening.is_finished(),
        "the open waits inside its cold read"
    );
    assert_eq!(
        loader.calls(),
        1,
        "the layer load started before the session open completed"
    );

    // Past the store gate the open joins the in-flight load instead of reading again.
    gate.notify_one();
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        loader.calls(),
        1,
        "the open joined the in-flight prewarm load; the read was not duplicated"
    );
    assert!(
        !opening.is_finished(),
        "the open waits for the joined load to install the slot"
    );

    answers
        .pop()
        .expect("one gated answer")
        .send(Some(layer_config()))
        .unwrap_or_else(|_| panic!("the prewarm's read was awaiting its answer"));
    opening.await.unwrap().unwrap();
    assert_eq!(loader.calls(), 1);
    assert!(
        kernel.plugins_for_session(&id).is_some(),
        "the opened session resolves the loaded slot's plugin set"
    );
}

/// Fork (print `--continue` prewarm): a prewarm whose read fails is fail-closed and breaks
/// nothing upward — the open joins the in-flight load, takes the `Invalid` slot it installed (the
/// workspace keeps the process set until a later load) and completes as if nothing failed.
#[tokio::test]
async fn a_failing_continue_prewarm_does_not_break_the_session_open() {
    let store = Arc::new(MemoryStore::default());
    let (loader, mut answers) = gated_layer(1);
    let kernel = Arc::new(prewarm_kernel(store.clone(), loader.clone()));
    let id = seeded_row(store.as_ref(), "sess_continue", "/Users/dev/other").await;

    kernel.prewarm_continue_layer(&workspace()).await;
    settles(Duration::from_millis(500), || loader.calls() >= 1).await;

    // The open joins the still-in-flight prewarm load; its read is never duplicated.
    let opening = tokio::spawn({
        let (kernel, id) = (kernel.clone(), id.clone());
        async move { kernel.open_session(&id).await }
    });
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
    assert_eq!(loader.calls(), 1, "the open joined the prewarm's read");
    assert!(
        !opening.is_finished(),
        "the open waits for the joined load to finish"
    );

    // The read fails: the slot turns Invalid, the joined open returns over it, the run is intact.
    answers
        .pop()
        .expect("the prewarm's answer")
        .send(None)
        .unwrap_or_else(|_| panic!("the prewarm's read was awaiting its answer"));
    opening
        .await
        .unwrap()
        .expect("a failed prewarm leaves the print run intact");
    assert_eq!(loader.calls(), 1, "the failing read was never repeated");
    assert!(
        kernel.plugins_for_session(&id).is_none(),
        "the workspace keeps the process set (fail-closed)"
    );
}

/// Fork (print `--continue` prewarm): no resumable row (a benchmark harness's first `-c` run)
/// prewarms nothing — any loader call would trip the gated loader's missing answer.
#[tokio::test]
async fn a_continue_prewarm_without_a_row_loads_nothing() {
    let store = Arc::new(MemoryStore::default());
    let (loader, _answers) = gated_layer(0);
    let kernel = prewarm_kernel(store.clone(), loader.clone());

    kernel.prewarm_continue_layer(&workspace()).await;
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }

    assert_eq!(
        loader.calls(),
        0,
        "nothing loaded without a continue target"
    );
}

/// Fork (print `--continue` prewarm): a fork row's cold open runs in its execution worktree, so
/// the prewarm targets the WORKTREE's root — the row's own directory (here the process workspace)
/// would be the layer's no-op and never enter the loader.
#[tokio::test]
async fn a_continue_prewarm_targets_the_rows_execution_worktree() {
    use rust_cli_kernel_api::store::StoreQueries as _;
    let store = Arc::new(MemoryStore::default());
    let (loader, mut answers) = gated_layer(1);
    let kernel = prewarm_kernel(store.clone(), loader.clone());
    // The row sits in the process workspace; its stored worktree is where the session runs.
    let id = seeded_row(store.as_ref(), "sess_forked", "/Users/dev/work").await;
    let worktree = WorkspaceRef {
        environment: workspace().environment,
        root: EnvPath::new("/Users/dev/work-tree"),
    };
    store
        .set_execution_worktree(&id, &worktree.root, None)
        .await
        .unwrap();

    kernel.prewarm_continue_layer(&workspace()).await;
    settles(Duration::from_millis(500), || loader.calls() >= 1).await;
    assert_eq!(
        loader.roots(),
        ["/Users/dev/work-tree".to_owned()],
        "the prewarm read the worktree's layer, not the process workspace's"
    );
    answers
        .pop()
        .expect("one gated answer")
        .send(Some(layer_config()))
        .unwrap_or_else(|_| panic!("the prewarm's read was awaiting its answer"));
    settles(Duration::from_millis(500), || {
        kernel.plugins_for_workspace(&worktree).is_some()
    })
    .await;
    assert_eq!(loader.calls(), 1);
}
