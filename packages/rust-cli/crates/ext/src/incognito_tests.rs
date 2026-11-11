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
        machine: Default::default(),
    }
}

async fn started(profiles: &IncognitoProfiles, scope: &TaskScope) -> Ext {
    let fake = Arc::new(
        FakeMcp::default()
            .with("files", listed("read", "Read files."))
            .with("kit", listed("build", "Build things.")),
    );
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
        },
        base,
        ExtConfig {
            mcp: McpSettings {
                servers: vec![
                    config("files", McpScope::Project),
                    config("kit", McpScope::Plugin),
                ],
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
