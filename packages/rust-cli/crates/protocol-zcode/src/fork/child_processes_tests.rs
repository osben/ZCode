//! `process/childProcesses` (specs/fork-rust-agent-parity.md "`process/childProcesses`").

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::mcp::{McpProcess, McpProcesses, McpProvenance};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{CreateSession, Kernel, KernelError, SessionHandle};
use rust_cli_kernel_api::store::{SessionFilter, SessionSummary, StoreQueries};
use rust_cli_kernel_api::testing::{FixedClock, MemoryStore, selection};
use rust_cli_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

/// The method never reaches the kernel.
struct NoKernel;

#[async_trait]
impl Kernel for NoKernel {
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
        session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Err(KernelError::NotFound {
            session: session.clone(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }
}

struct Fixed(Vec<McpProcess>);

impl McpProcesses for Fixed {
    fn processes(&self) -> Vec<McpProcess> {
        self.0.clone()
    }
}

/// The servers of official-marketplace plugins.
struct Official(&'static [&'static str]);

impl McpProvenance for Official {
    fn official_plugin_server(&self, server: &str) -> bool {
        self.0.contains(&server)
    }
}

fn process(pid: u32, server: &str) -> McpProcess {
    McpProcess {
        pid,
        server: server.to_owned(),
    }
}

async fn answer(source: Option<Vec<McpProcess>>, params: Value) -> Value {
    answer_with(source, None, params).await
}

async fn answer_with(
    source: Option<Vec<McpProcess>>,
    provenance: Option<Official>,
    params: Value,
) -> Value {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    if let Some(processes) = source {
        context.set_mcp_processes(Arc::new(Fixed(processes)));
    }
    if let Some(provenance) = provenance {
        context.set_mcp_provenance(Arc::new(provenance));
    }
    let kernel = Arc::new(NoKernel);
    let server = Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    Handler(server)
        .request("process/childProcesses", params)
        .await
        .expect("answered")
        .result
}

#[tokio::test]
async fn rows_carry_nodes_source_and_plugin_name() {
    let processes = vec![
        process(11, "node_repl"),
        process(12, "plugin:browser-use:node_repl"),
        process(13, "plugin: demo :api"),
        process(14, "plugin:docs"),
        process(15, "plugin::api"),
        process(16, "github"),
    ];
    assert_eq!(
        answer(Some(processes), json!({})).await,
        json!({"processes": [
            {"pid": 11, "serverName": "node_repl", "mcpSource": "builtin", "pluginName": "browser-use"},
            {"pid": 12, "serverName": "plugin:browser-use:node_repl", "mcpSource": "plugin", "pluginName": "browser-use"},
            {"pid": 13, "serverName": "plugin: demo :api", "mcpSource": "plugin", "pluginName": "demo"},
            {"pid": 14, "serverName": "plugin:docs", "mcpSource": "plugin", "pluginName": "docs"},
            {"pid": 15, "serverName": "plugin::api", "mcpSource": "plugin"},
            {"pid": 16, "serverName": "github", "mcpSource": "custom"},
        ]})
    );
}

/// Node does not parse the params: any value answers the same list; a pid of 0 is never listed.
#[tokio::test]
async fn params_are_not_read_and_pid_zero_is_skipped() {
    let processes = vec![process(0, "github"), process(21, "github")];
    for params in [json!({}), json!(null), json!({"anything": 1})] {
        assert_eq!(
            answer(Some(processes.clone()), params).await,
            json!({"processes": [{"pid": 21, "serverName": "github", "mcpSource": "custom"}]})
        );
    }
}

#[tokio::test]
async fn without_a_source_the_list_is_empty() {
    assert_eq!(answer(None, json!({})).await, json!({"processes": []}));
}

/// Node registers an official-marketplace plugin's server with `source.kind: "builtin"`, so the Host counts it as
/// built in; the plugin name still comes from the server name. A third-party plugin's server stays `plugin`.
#[tokio::test]
async fn an_official_marketplace_plugin_server_is_builtin() {
    let processes = vec![
        process(31, "plugin:docs:viewer"),
        process(32, "plugin:demo:api"),
    ];
    assert_eq!(
        answer_with(
            Some(processes),
            Some(Official(&["plugin:docs:viewer"])),
            json!({})
        )
        .await,
        json!({"processes": [
            {"pid": 31, "serverName": "plugin:docs:viewer", "mcpSource": "builtin", "pluginName": "docs"},
            {"pid": 32, "serverName": "plugin:demo:api", "mcpSource": "plugin", "pluginName": "demo"},
        ]})
    );
}
