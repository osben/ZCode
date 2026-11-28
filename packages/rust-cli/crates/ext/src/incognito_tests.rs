//! Fork: the incognito gates over MCP servers, the global MCP tools and skills (specs/fork-rust-agent-parity.md).

use std::sync::Arc;

use rust_cli_base::TaskScope;
use rust_cli_base::models::GLM_5_3;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::incognito::{IncognitoProfile, IncognitoProfiles};
use rust_cli_kernel_api::mcp::McpTransportConfig;
use rust_cli_kernel_api::model::{ModelSelection, QuerySource};
use rust_cli_kernel_api::orchestration::{ContextRequest, ToolRegistry};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::{ListTools, MemoryEnvironment, SequentialIds};
use serde_json::json;

use crate::test_support::{CWD, EchoBash, FakeMcp, facts, server, workspace};
use crate::{Ext, ExtConfig, ExtPorts, McpScope, McpServer, McpSettings};

fn listed(tool: &str, instructions: &str) -> Arc<crate::test_support::Handler> {
    let tool = tool.to_owned();
    server(
        json!({"tools": {}}),
        Some(instructions),
        move |method, _| {
            (method == "tools/list")
                .then(|| Ok(json!({"tools": [{"name": tool, "inputSchema": {"type": "object"}}]})))
        },
    )
}

fn config(name: &str, scope: McpScope) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope,
        transport: McpTransportConfig::stdio("node".to_owned(), Vec::new()),
        options: Default::default(),
        oauth: None,
        machine: Default::default(),
    }
}

async fn started(profiles: &IncognitoProfiles, scope: &TaskScope) -> Ext {
    started_with(
        profiles,
        scope,
        vec![
            ("files", McpScope::Project, listed("read", "Read files.")),
            ("kit", McpScope::Plugin, listed("build", "Build things.")),
        ],
    )
    .await
}

async fn started_with(
    profiles: &IncognitoProfiles,
    scope: &TaskScope,
    servers: Vec<(&str, McpScope, Arc<crate::test_support::Handler>)>,
) -> Ext {
    started_on(profiles, &Default::default(), scope, servers).await
}

async fn started_on(
    profiles: &IncognitoProfiles,
    sessions: &rust_cli_kernel_api::workspace_key::SessionWorkspaces,
    scope: &TaskScope,
    servers: Vec<(&str, McpScope, Arc<crate::test_support::Handler>)>,
) -> Ext {
    let mut fake = FakeMcp::default();
    for (name, _, handler) in &servers {
        fake = fake.with(name, handler.clone());
    }
    let fake = Arc::new(fake);
    let base: Arc<dyn ToolRegistry> = Arc::new(ListTools(vec![Arc::new(EchoBash::default())]));
    let env = Arc::new(MemoryEnvironment::new(facts()).with_file(
        &format!("{CWD}/.zcode/skills/greet/SKILL.md"),
        "---\ndescription: Greet\n---\n",
    ));
    let ext = Ext::new(
        ExtPorts {
            info: env.clone(),
            files: env,
            ids: Arc::new(SequentialIds::default()),
            gate: Arc::new(crate::test_support::AllowedGate::default()),
            mcp: fake,
            machines: None,
            spawner: scope.spawner(),
            clock: crate::clock_tests::clock(),
            incognito: profiles.clone(),
            sessions: sessions.clone(),
            app_tools: None,
        },
        base,
        ExtConfig {
            mcp: McpSettings {
                servers: servers
                    .iter()
                    .map(|(name, scope, _)| config(name, *scope))
                    .collect(),
                ..McpSettings::default()
            },
            workspace: Some(workspace()),
            ..ExtConfig::default()
        },
    );
    ext.start().await;
    ext.mcp().wait_ready().await;
    ext
}

fn request(session: &str) -> ContextRequest {
    ContextRequest::new(
        SessionId::new(session),
        workspace(),
        QuerySource::MainThread,
        PermissionMode::Default,
        ModelSelection::new("anthropic".to_owned(), GLM_5_3.to_owned()),
    )
}

#[tokio::test]
async fn a_profile_keeps_only_the_servers_and_listings_it_allows() {
    let profiles = IncognitoProfiles::default();
    let lockdown = SessionId::new("locked");
    let plugins_only = SessionId::new("plugins");
    profiles.record(&lockdown, Some(IncognitoProfile::LOCKDOWN));
    profiles.record(
        &plugins_only,
        Some(IncognitoProfile {
            plugins: true,
            skills: true,
            ..IncognitoProfile::LOCKDOWN
        }),
    );
    let scope = TaskScope::root("test", |_| {});
    let ext = started(&profiles, &scope).await;
    let registry = ext.registry();
    let names = |session: &SessionId| -> (Vec<String>, Vec<String>) {
        let snapshot = registry.snapshot(session);
        let view = snapshot.mcp.unwrap_or_default();
        (
            snapshot
                .tools
                .iter()
                .map(|tool| tool.name().to_owned())
                .collect(),
            view.servers.into_iter().map(|server| server.name).collect(),
        )
    };
    // A normal session is unchanged.
    let (tools, servers) = names(&SessionId::new("normal"));
    assert_eq!(
        tools,
        ["Bash", "Skill", "mcp__files__read", "mcp__kit__build"]
    );
    assert_eq!(servers, ["files", "kit"]);
    let (tools, servers) = names(&lockdown);
    assert_eq!(tools, ["Bash", "Skill"]);
    assert!(servers.is_empty());
    let (tools, servers) = names(&plugins_only);
    assert_eq!(tools, ["Bash", "Skill", "mcp__kit__build"]);
    assert_eq!(servers, ["kit"]);

    // The call-time gate agrees with the snapshot.
    let gate = ext.incognito_tools();
    let files_tool = registry.find("mcp__files__read").unwrap();
    assert!(gate.hides(&lockdown, files_tool.as_ref()));
    assert!(gate.hides(&plugins_only, files_tool.as_ref()));
    assert!(!gate.hides(&SessionId::new("normal"), files_tool.as_ref()));

    // Instructions without a snapshot follow the same servers; skills off empties the listing only.
    let listings = ext.listings();
    let instructions = |session: &str| {
        let listings = listings.clone();
        let request = request(session);
        async move {
            listings
                .mcp_instructions(&request)
                .await
                .unwrap()
                .into_iter()
                .map(|entry| entry.name)
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(instructions("normal").await, ["files", "kit"]);
    assert!(instructions("locked").await.is_empty());
    assert_eq!(instructions("plugins").await, ["kit"]);
    let skills = |session: &str| {
        let listings = listings.clone();
        let request = request(session);
        async move { listings.listings_for(&request, &[]).await.unwrap().skills }
    };
    assert!(skills("locked").await.is_empty());
    assert!(!skills("plugins").await.is_empty());
}

/// Fork (round 4): with `mcp` kept and `plugins` off, the user's server `plugin_demo_api` and the plugin server
/// `plugin:demo:api` both expose `mcp__plugin_demo_api__lookup`. The global lookup answers with the plugin server's
/// tool; the session's lookup answers with the tool its snapshot lists, so the advertised tool stays callable.
#[tokio::test]
async fn a_session_lookup_skips_a_hidden_server_with_the_same_tool_name() {
    let profiles = IncognitoProfiles::default();
    let session = SessionId::new("mcp-only");
    profiles.record(
        &session,
        Some(IncognitoProfile {
            mcp: true,
            ..IncognitoProfile::LOCKDOWN
        }),
    );
    let scope = TaskScope::root("test", |_| {});
    let ext = started_with(
        &profiles,
        &scope,
        vec![
            (
                "plugin_demo_api",
                McpScope::Project,
                listed("lookup", "User."),
            ),
            (
                "plugin:demo:api",
                McpScope::Plugin,
                listed("lookup", "Plugin."),
            ),
        ],
    )
    .await;
    let registry = ext.registry();
    const NAME: &str = "mcp__plugin_demo_api__lookup";
    let server = |tool: Arc<dyn rust_cli_kernel_api::tool::Tool>| {
        tool.mcp_info().map(|info| info.server.clone())
    };
    let listed: Vec<_> = registry
        .snapshot(&session)
        .tools
        .into_iter()
        .filter(|tool| tool.name() == NAME)
        .filter_map(server)
        .collect();
    assert_eq!(listed, ["plugin_demo_api"]);
    assert_eq!(
        registry.find(NAME).and_then(server).as_deref(),
        Some("plugin:demo:api")
    );
    assert_eq!(
        registry
            .find_for(&session, NAME)
            .and_then(server)
            .as_deref(),
        Some("plugin_demo_api")
    );
    assert!(!ext.incognito_tools().hides(
        &session,
        registry.find_for(&session, NAME).unwrap().as_ref()
    ));
    // A normal session keeps the global answer.
    assert_eq!(
        registry
            .find_for(&SessionId::new("normal"), NAME)
            .and_then(server),
        registry.find(NAME).and_then(server)
    );
}

/// Node's incognito `automationTools` covers all five Cron tools, the desktop's CronUpdate and CronPauseSelf included.
#[test]
fn the_automation_switch_covers_every_cron_tool() {
    let off = IncognitoProfile::LOCKDOWN;
    let on = IncognitoProfile {
        automation_tools: true,
        ..IncognitoProfile::LOCKDOWN
    };
    for name in [
        "CronCreate",
        "CronDelete",
        "CronList",
        "CronUpdate",
        "CronPauseSelf",
    ] {
        assert_eq!(
            super::hides_automation_tool(&off, name),
            Some(true),
            "{name}"
        );
        assert_eq!(
            super::hides_automation_tool(&on, name),
            Some(false),
            "{name}"
        );
    }
    assert_eq!(super::hides_automation_tool(&off, "ScheduleWakeup"), None);
}

/// A tool with a given name, for the gate's name checks.
struct Named(&'static str);

#[async_trait::async_trait]
impl rust_cli_kernel_api::tool::Tool for Named {
    fn name(&self) -> &str {
        self.0
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({"type": "object"})
    }

    fn description(&self, _context: &rust_cli_kernel_api::tool::PromptContext) -> String {
        String::new()
    }

    async fn call(
        &self,
        _input: serde_json::Value,
        _context: rust_cli_kernel_api::tool::ToolUseContext,
        _progress: tokio::sync::mpsc::Sender<rust_cli_kernel_api::tool::ToolProgress>,
    ) -> Result<rust_cli_kernel_api::tool::ToolOutput, rust_cli_kernel_api::tool::ToolError> {
        unreachable!("the gate tests never call the tool")
    }
}

/// Node `resolveSessionToolDenylist`: a session on a remote workspace identity (ssh, wsl, docker, server) has the five
/// Cron tools denied (`REMOTE_AUTOMATION_TOOL_NAMES`), whatever its incognito profile. The off-peak tools and a local
/// or malformed-identity workspace are untouched.
#[tokio::test]
async fn a_remote_workspace_session_hides_the_five_cron_tools() {
    let sessions = rust_cli_kernel_api::workspace_key::SessionWorkspaces::default();
    let remote = SessionId::new("remote");
    let local = SessionId::new("local");
    let malformed = SessionId::new("malformed");
    let at = |root: &str| rust_cli_kernel_api::env::WorkspaceRef {
        environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
        root: rust_cli_kernel_api::env::EnvPath::new(root),
    };
    sessions.record(&remote, at("remote:ssh:host:22:user:/work/app"));
    sessions.record(&local, at(CWD));
    sessions.record(&malformed, at("remote:ftp:host:/work"));
    let scope = TaskScope::root("test", |_| {});
    let ext = started_on(&IncognitoProfiles::default(), &sessions, &scope, Vec::new()).await;
    let gate = ext.incognito_tools();
    for name in [
        "CronCreate",
        "CronList",
        "CronUpdate",
        "CronDelete",
        "CronPauseSelf",
    ] {
        assert!(gate.hides(&remote, &Named(name)), "{name} on remote");
        assert!(!gate.hides(&local, &Named(name)), "{name} on local");
        assert!(!gate.hides(&malformed, &Named(name)), "{name} malformed");
    }
    for name in ["OffPeakCreate", "OffPeakList", "ScheduleWakeup", "Bash"] {
        assert!(!gate.hides(&remote, &Named(name)), "{name} on remote");
    }
}
