//! 插件的 agent 与 hooks 接线（ext.md §4，L12）。

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use rust_cli_ext::{Plugin, PluginAgentFile as ExtAgentFile, Plugins};
use rust_cli_kernel_api::env::{EnvFacts, EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{CommandId, EnvironmentId};
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
