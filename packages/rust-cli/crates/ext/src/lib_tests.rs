//! 组装：注册表、清单来源、MCP 启动（ext.md §1）。

use std::sync::Arc;

use rust_cli_base::TaskScope;
use rust_cli_base::models::GLM_5_3;
use rust_cli_kernel_api::app_tool::{AppToolHost, AppToolSpec};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use rust_cli_kernel_api::model::{ModelSelection, QuerySource};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::{ListTools, MemoryEnvironment, SequentialIds};
use serde_json::json;

use super::*;
use crate::test_support::{CWD, EchoBash, FakeMcp, facts, server, workspace};

fn ext(env: MemoryEnvironment, fake: Arc<FakeMcp>, scope: &TaskScope, servers: McpServers) -> Ext {
    let base: Arc<dyn ToolRegistry> = Arc::new(ListTools(vec![Arc::new(EchoBash::default())]));
    ext_with_apps(env, fake, scope, servers, None, base)
}

/// A named base tool that is never called (for the collision tests).
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
        self.0.to_owned()
    }

    async fn call(
        &self,
        _input: serde_json::Value,
        _context: rust_cli_kernel_api::tool::ToolUseContext,
        _progress: tokio::sync::mpsc::Sender<rust_cli_kernel_api::tool::ToolProgress>,
    ) -> Result<rust_cli_kernel_api::tool::ToolOutput, rust_cli_kernel_api::tool::ToolError> {
        Err(rust_cli_kernel_api::tool::ToolError::Cancelled)
    }
}

fn ext_with_apps(
    env: MemoryEnvironment,
    fake: Arc<FakeMcp>,
    scope: &TaskScope,
    servers: McpServers,
    app_tools: Option<Arc<dyn AppToolHost>>,
    base: Arc<dyn ToolRegistry>,
) -> Ext {
    let env = Arc::new(env);
    let ports = ExtPorts {
        info: env.clone(),
        files: env,
        ids: Arc::new(SequentialIds::default()),
        gate: Arc::new(crate::test_support::AllowedGate::default()),
        mcp: fake,
        machines: None,
        spawner: scope.spawner(),
        clock: crate::clock_tests::clock(),
        incognito: Default::default(),
        sessions: Default::default(),
        app_tools,
    };
    let config = ExtConfig {
        mcp: McpSettings {
            servers,
            ..McpSettings::default()
        },
        workspace: Some(workspace()),
        ..ExtConfig::default()
    };
    Ext::new(ports, base, config)
}

fn request() -> ContextRequest {
    ContextRequest {
        tool_names: vec!["Skill".to_owned()],
        ..ContextRequest::new(
            SessionId::new("sess_1"),
            workspace(),
            QuerySource::MainThread,
            PermissionMode::Default,
            ModelSelection::new("anthropic".to_owned(), GLM_5_3.to_owned()),
        )
    }
}

#[tokio::test]
async fn the_registry_adds_skill_and_mcp_tools_after_the_base() {
    let fake = Arc::new(FakeMcp::default().with(
        "files",
        server(json!({"tools": {}}), Some("Read files."), |method, _| {
            (method == "tools/list").then(|| {
                Ok(json!({"tools": [{"name": "read", "inputSchema": {"type": "object"}}]}))
            })
        }),
    ));
    let scope = TaskScope::root("test", |_| {});
    let env = MemoryEnvironment::new(facts()).with_file(
        &format!("{CWD}/.zcode/skills/greet/SKILL.md"),
        "---\ndescription: Greet\n---\n",
    );
    let servers = vec![McpServer {
        name: "files".to_owned(),
        scope: McpScope::Project,
        transport: McpTransportConfig::stdio("node".to_owned(), Vec::new()),
        options: Default::default(),
        oauth: None,
        machine: Default::default(),
    }];
    let ext = ext(env, fake, &scope, servers);
    let registry = ext.registry();
    let names = |registry: &Arc<dyn ToolRegistry>| -> Vec<String> {
        registry
            .tools()
            .iter()
            .map(|tool| tool.name().to_owned())
            .collect()
    };
    assert_eq!(names(&registry), ["Bash", "Skill"]);
    ext.start().await;
    ext.mcp().wait_ready().await;
    assert_eq!(names(&registry), ["Bash", "Skill", "mcp__files__read"]);
    assert!(registry.find("mcp__files__read").is_some());
    let listings = ext.listings();
    let found = listings.listings_for(&request(), &[]).await.unwrap();
    let lines: Vec<&str> = found
        .skills
        .iter()
        .map(|entry| entry.line.as_str())
        .collect();
    // 文件 skill 在前，内置的 `loop` 在后（tools-more.md §17.1），再是内置提示词命令（修复线 L-A）。
    assert_eq!(lines[0], "- greet: Greet");
    assert!(lines[1].starts_with("- loop: "));
    assert!(lines[2].starts_with("- init: "));
    assert!(lines[3].starts_with("- security-review: "));
    assert_eq!(lines.len(), 4);
    let instructions = listings.mcp_instructions(&request()).await.unwrap();
    assert_eq!(instructions[0].line, "## files\nRead files.");
}

/// The helper's set for the test: one app tool, named as the given MCP tool is.
struct OneAppTool(Vec<AppToolSpec>);

#[async_trait::async_trait]
impl AppToolHost for OneAppTool {
    fn app_tools(&self, _session: &SessionId) -> Vec<AppToolSpec> {
        self.0.clone()
    }

    async fn call(
        &self,
        _session: &SessionId,
        _turn: &str,
        _tool_call: &str,
        _name: &str,
        _input: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err("not called".to_owned())
    }

    async fn cancel(&self, _session: &SessionId, _tool_call: &str) {}
}

/// Node keeps the existing tool on a name collision (`replaceMcpAppProvidedTools`): an app tool named like an MCP tool
/// of the session is neither listed twice nor found in its place.
#[tokio::test]
async fn an_app_tool_never_shadows_an_mcp_tool_of_the_same_name() {
    let fake = Arc::new(FakeMcp::default().with(
        "files",
        server(json!({"tools": {}}), Some("Read files."), |method, _| {
            (method == "tools/list").then(|| {
                Ok(json!({"tools": [{"name": "read", "inputSchema": {"type": "object"}}]}))
            })
        }),
    ));
    let scope = TaskScope::root("test", |_| {});
    let servers = vec![McpServer {
        name: "files".to_owned(),
        scope: McpScope::Project,
        transport: McpTransportConfig::stdio("node".to_owned(), Vec::new()),
        options: Default::default(),
        oauth: None,
        machine: Default::default(),
    }];
    let app = OneAppTool(vec![AppToolSpec {
        model_name: "mcp__files__read".to_owned(),
        server_name: "calc".to_owned(),
        plugin_id: "calc".to_owned(),
        tool_name: "pick".to_owned(),
        title: None,
        description: None,
        input_schema: json!({"type": "object"}),
        read_only: true,
        destructive: false,
        idempotent: false,
    }]);
    let base: Arc<dyn ToolRegistry> = Arc::new(ListTools(vec![Arc::new(EchoBash::default())]));
    let ext = ext_with_apps(
        MemoryEnvironment::new(facts()),
        fake,
        &scope,
        servers,
        Some(Arc::new(app)),
        base,
    );
    ext.start().await;
    ext.mcp().wait_ready().await;
    let registry = ext.registry();
    let session = SessionId::new("sess_1");
    let listed: Vec<String> = registry
        .snapshot(&session)
        .tools
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert_eq!(
        listed
            .iter()
            .filter(|name| *name == "mcp__files__read")
            .count(),
        1,
        "{listed:?}"
    );
    let found = registry
        .find_for(&session, "mcp__files__read")
        .expect("the MCP tool answers");
    assert_eq!(found.mcp_info().expect("an MCP tool").server, "files");
}

/// WaitForMcpServers 在有连接中的服务器时出现；主线程带过它的会话之后一直带着（ext.md §3.8，修复线 F36）。快照里的
/// instructions 与工具同一时点，清单来源按快照给（query.md §1.3）。
#[tokio::test(start_paused = true)]
async fn the_wait_tool_follows_pending_servers_and_the_declared_session() {
    let fake = Arc::new(FakeMcp::default().with("slow", crate::test_support::held(|_, _| None)));
    let scope = TaskScope::root("test", |_| {});
    let servers = vec![McpServer {
        name: "slow".to_owned(),
        scope: McpScope::Project,
        transport: McpTransportConfig::stdio("node".to_owned(), Vec::new()),
        options: Default::default(),
        oauth: None,
        machine: Default::default(),
    }];
    let ext = ext(
        MemoryEnvironment::new(facts()),
        fake.clone(),
        &scope,
        servers,
    );
    let registry = ext.registry();
    ext.start().await;
    let names = |tools: Vec<Arc<dyn Tool>>| -> Vec<String> {
        tools.iter().map(|tool| tool.name().to_owned()).collect()
    };
    assert_eq!(
        names(registry.tools()),
        ["Bash", "Skill", "WaitForMcpServers"]
    );
    let main = SessionId::new("sess_1");
    let other = SessionId::new("sess_2");
    let snapshot = registry.snapshot(&main);
    assert_eq!(
        names(snapshot.tools),
        ["Bash", "Skill", "WaitForMcpServers"]
    );
    assert_eq!(snapshot.mcp.unwrap().pending(), ["slow"]);
    registry.mcp().unwrap().declare_wait_tool(&main);
    fake.release("slow", json!({}), Some("Slow."));
    ext.mcp().wait_ready().await;
    // 连上之后：现在的工具表没有它；带过它的会话的快照仍有，别的会话没有。
    assert_eq!(names(registry.tools()), ["Bash", "Skill"]);
    let declared = registry.snapshot(&main);
    assert_eq!(
        names(declared.tools),
        ["Bash", "Skill", "WaitForMcpServers"]
    );
    assert_eq!(names(registry.snapshot(&other).tools), ["Bash", "Skill"]);
    assert!(registry.find("WaitForMcpServers").is_some());
    // 清单来源：有快照时用快照里的 instructions，没有时取现在的。
    let listings = ext.listings();
    let mut stale = request();
    stale.mcp = Some(rust_cli_kernel_api::mcp_state::McpView::default());
    assert!(listings.mcp_instructions(&stale).await.unwrap().is_empty());
    let mut fresh = request();
    fresh.mcp = declared.mcp;
    let lines: Vec<String> = listings
        .mcp_instructions(&fresh)
        .await
        .unwrap()
        .into_iter()
        .map(|entry| entry.line)
        .collect();
    assert_eq!(lines, ["## slow\nSlow."]);
    assert_eq!(
        listings.mcp_instructions(&request()).await.unwrap()[0].line,
        "## slow\nSlow."
    );
}

/// An app tool spec named `model`, as a page's set holds it.
fn app_spec(model: &str) -> AppToolSpec {
    AppToolSpec {
        model_name: model.to_owned(),
        server_name: "calc".to_owned(),
        plugin_id: "calc".to_owned(),
        tool_name: "pick".to_owned(),
        title: None,
        description: None,
        input_schema: json!({"type": "object"}),
        read_only: true,
        destructive: false,
        idempotent: false,
    }
}

/// Lookup resolves legacy names (`answers_to`), so an app tool named as a listed tool's legacy name is taken: it is not
/// listed, and the name keeps resolving to the existing tool.
#[tokio::test]
async fn an_app_tool_named_as_a_listed_tools_legacy_name_is_not_listed() {
    let scope = TaskScope::root("test", |_| {});
    let app = OneAppTool(vec![app_spec("Task")]);
    let base: Arc<dyn ToolRegistry> = Arc::new(ListTools(vec![Arc::new(Named("Agent"))]));
    let ext = ext_with_apps(
        MemoryEnvironment::new(facts()),
        Arc::new(FakeMcp::default()),
        &scope,
        Vec::new(),
        Some(Arc::new(app)),
        base,
    );
    let registry = ext.registry();
    let session = SessionId::new("sess_1");
    let listed: Vec<String> = registry
        .snapshot(&session)
        .tools
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    // Lookup of `Task` resolves to `Agent` in the production base registry (`answers_to`); this double matches names
    // exactly, so only the listing is checked here.
    assert!(!listed.contains(&"Task".to_owned()), "{listed:?}");
    assert!(listed.contains(&"Agent".to_owned()), "{listed:?}");
}

/// A host that lists one name twice must not put it in the model's list twice (an API-rejected duplicate).
#[tokio::test]
async fn an_app_tool_name_the_host_lists_twice_is_listed_once() {
    let scope = TaskScope::root("test", |_| {});
    let app = OneAppTool(vec![
        app_spec("app__calc__pick"),
        app_spec("app__calc__pick"),
    ]);
    let base: Arc<dyn ToolRegistry> = Arc::new(ListTools(vec![Arc::new(EchoBash::default())]));
    let ext = ext_with_apps(
        MemoryEnvironment::new(facts()),
        Arc::new(FakeMcp::default()),
        &scope,
        Vec::new(),
        Some(Arc::new(app)),
        base,
    );
    let listed: Vec<String> = ext
        .registry()
        .snapshot(&SessionId::new("sess_1"))
        .tools
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert_eq!(
        listed
            .iter()
            .filter(|name| *name == "app__calc__pick")
            .count(),
        1,
        "{listed:?}"
    );
}
