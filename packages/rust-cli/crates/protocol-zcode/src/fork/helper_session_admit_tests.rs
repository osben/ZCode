//! Fork: which session-scoped calls Rust forwards to the Node helper (specs/fork-rust-node-helper.md F3,
//! "Session-scoped forwarded methods").

use serde_json::json;

use super::*;
use crate::fork::node_helper::{HelperCatalog, NodeHelper, NodeHelperLauncher};

fn catalog() -> HelperCatalog {
    HelperCatalog {
        plugin_ids: vec!["viewer@inline".to_owned(), "skills@inline".to_owned()],
        helper_plugins: vec!["viewer@inline".to_owned()],
        servers: vec!["plugin:viewer:view".to_owned()],
    }
}

fn reason(error: Option<RpcError>) -> Option<(i64, Value)> {
    error.map(|error| (error.code, error.data.unwrap_or_default()))
}

fn not_hosted() -> Option<(i64, Value)> {
    Some((
        -32602,
        json!({"reasonCode": MCP_UI_SERVER_NOT_HELPER_HOSTED}),
    ))
}

#[test]
fn a_helper_hosted_server_of_an_own_session_is_forwarded() {
    let params =
        json!({"sessionId": "s1", "pluginId": "viewer@inline", "serverName": "plugin:viewer:view"});
    assert!(refusal("mcp/uiCallTool", &params, true, Some(&catalog())).is_none());
    // Methods without a server name check the session only.
    assert!(
        refusal(
            "mcp/uiCancelCall",
            &json!({"sessionId": "s1", "callId": "c"}),
            true,
            Some(&catalog())
        )
        .is_none()
    );
}

#[test]
fn a_server_rust_runs_itself_is_refused() {
    let params = json!({"sessionId": "s1", "pluginId": "user", "serverName": "github"});
    assert_eq!(
        reason(refusal(
            "mcp/uiOpenInstance",
            &params,
            true,
            Some(&catalog())
        )),
        not_hosted()
    );
    // Without a catalog nothing is helper-hosted.
    let hosted = json!({"sessionId": "s1", "serverName": "plugin:viewer:view"});
    assert_eq!(
        reason(refusal("mcp/readResource", &hosted, true, None)),
        not_hosted()
    );
}

#[test]
fn a_session_rust_does_not_own_is_refused() {
    let params = json!({"sessionId": "elsewhere", "serverName": "plugin:viewer:view"});
    assert_eq!(
        reason(refusal("mcp/uiCallTool", &params, false, Some(&catalog()))),
        not_hosted()
    );
}

#[test]
fn mention_items_need_a_helper_hosted_plugin() {
    let hosted =
        json!({"sessionId": "s1", "pluginId": "viewer@inline", "tool": "search", "query": ""});
    assert!(refusal("plugins/mentionItems", &hosted, true, Some(&catalog())).is_none());
    let skills =
        json!({"sessionId": "s1", "pluginId": "skills@inline", "tool": "search", "query": ""});
    assert_eq!(
        reason(refusal(
            "plugins/mentionItems",
            &skills,
            true,
            Some(&catalog())
        )),
        not_hosted()
    );
}

#[test]
fn a_session_method_without_a_session_is_invalid() {
    let error = refusal(
        "mcp/uiCallTool",
        &json!({"serverName": "plugin:viewer:view"}),
        true,
        Some(&catalog()),
    )
    .expect("refused");
    assert_eq!(error.code, -32602);
    assert!(error.data.is_none());
}

#[test]
fn the_session_catalog_needs_an_own_session_and_the_draft_catalog_does_not() {
    let session = json!({"sessionId": "s1"});
    assert!(refusal("plugins/referenceCatalog", &session, true, Some(&catalog())).is_none());
    assert_eq!(
        reason(refusal(
            "plugins/referenceCatalogWithCategory",
            &session,
            false,
            Some(&catalog())
        )),
        not_hosted()
    );
    assert!(refusal("plugins/referenceCatalog", &json!({}), false, None).is_none());
    assert!(refusal("plugins/list", &json!({"sessionId": "x"}), false, None).is_none());
}

/// A store-only kernel: `owns` reads the bridge and the store, nothing else.
struct StoreKernel(std::sync::Arc<rust_cli_kernel_api::testing::MemoryStore>);

#[async_trait::async_trait]
impl rust_cli_kernel_api::session_api::Kernel for StoreKernel {
    fn queries(&self) -> std::sync::Arc<dyn rust_cli_kernel_api::store::StoreQueries> {
        self.0.clone()
    }

    async fn create_session(
        &self,
        _request: rust_cli_kernel_api::session_api::CreateSession,
    ) -> Result<SessionId, rust_cli_kernel_api::session_api::KernelError> {
        Err(rust_cli_kernel_api::session_api::KernelError::Unsupported {
            what: "create".to_owned(),
        })
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<
        std::sync::Arc<dyn rust_cli_kernel_api::session_api::SessionHandle>,
        rust_cli_kernel_api::session_api::KernelError,
    > {
        Err(rust_cli_kernel_api::session_api::KernelError::Unsupported {
            what: "open".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: rust_cli_kernel_api::store::SessionFilter,
    ) -> Result<
        Vec<rust_cli_kernel_api::store::SessionSummary>,
        rust_cli_kernel_api::session_api::KernelError,
    > {
        Ok(Vec::new())
    }

    async fn delete_session(
        &self,
        _session: &SessionId,
    ) -> Result<(), rust_cli_kernel_api::session_api::KernelError> {
        Ok(())
    }
}

/// A stored session row, as `owns` and the workspace queries read it.
async fn stored(store: &rust_cli_kernel_api::testing::MemoryStore, id: &str) {
    use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
    use rust_cli_kernel_api::store::{SessionKind, SessionMeta, SessionStore};
    store
        .create(SessionMeta {
            id: SessionId::new(id),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
                root: EnvPath::new("/home/ZCodeProject"),
            },
            title: String::new(),
            trace: rust_cli_kernel_api::ids::TraceId::new("trace"),
            created_at_ms: 1000,
            incognito: None,
        })
        .await
        .unwrap();
}

/// A server over a store-only kernel, with a live task scope for its connections.
fn store_server(
    store: std::sync::Arc<rust_cli_kernel_api::testing::MemoryStore>,
) -> (Server, rust_cli_base::TaskScope) {
    let scope = rust_cli_base::TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = rust_cli_protocol_core::connection::start(
        out,
        &scope.spawner(),
        rust_cli_protocol_core::connection::Options::default(),
    );
    let context = std::sync::Arc::new(crate::context::Context::new(
        peer,
        std::sync::Arc::new(rust_cli_kernel_api::testing::FixedClock(5)),
    ));
    let server = Server::new(
        context,
        std::sync::Arc::new(StoreKernel(store)),
        scope.spawner(),
        crate::server::Defaults {
            selection: rust_cli_kernel_api::testing::selection().into(),
            mode: rust_cli_kernel_api::permission::PermissionMode::Default,
            environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
        },
    );
    (server, scope)
}

/// The agent's cwd is not its sessions' workspace: the Host may spawn it in a fixed internal directory
/// (`ZCODE_AGENT_SERVER_CWD`, the spawn fallback), and the desktop E2E runs it in `<home>/.zcode` while its sessions live
/// in `<home>/ZCodeProject`. A session of this process's store is Rust's whatever its directory; an unknown one is not.
#[tokio::test]
async fn a_stored_session_is_owned_whatever_the_agents_cwd() {
    let store = std::sync::Arc::new(rust_cli_kernel_api::testing::MemoryStore::default());
    stored(&store, "s1").await;
    let (server, _scope) = store_server(store);
    assert!(owns(&server, &SessionId::new("s1")).await);
    assert!(!owns(&server, &SessionId::new("unknown")).await);
}

/// Admission never starts the helper; the launcher only satisfies the constructor.
struct NoLaunch;

#[async_trait::async_trait]
impl NodeHelperLauncher for NoLaunch {
    async fn launch(&self) -> std::io::Result<crate::NodeHelperProcess> {
        Err(std::io::Error::other("admission never launches the helper"))
    }
}

/// Fork (specs/fork-rust-node-helper.md F3, per-workspace admission): the forwarding check resolves
/// the session's workspace catalog — a helper-hosted server of the workspace set passes, the process
/// set's own does not for that session, and a session without a workspace layer keeps the process
/// catalog.
#[tokio::test]
async fn admission_resolves_the_sessions_workspace_catalog() {
    let store = std::sync::Arc::new(rust_cli_kernel_api::testing::MemoryStore::default());
    stored(&store, "s1").await;
    stored(&store, "s2").await;
    let (server, scope) = store_server(store);
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (host, _writer) = rust_cli_protocol_core::connection::start(
        out,
        &scope.spawner(),
        rust_cli_protocol_core::connection::Options::default(),
    );
    let helper = NodeHelper::new(
        std::sync::Arc::new(NoLaunch),
        scope.spawner(),
        host,
        crate::fork::node_helper::Timing::default(),
    );
    helper.set_catalog(catalog());
    let workspace = HelperCatalog {
        plugin_ids: vec!["docs@inline".to_owned()],
        helper_plugins: vec!["docs@inline".to_owned()],
        servers: vec!["plugin:docs:documents".to_owned()],
    };
    let empty = HelperCatalog::default();
    helper.set_catalog_resolver(std::sync::Arc::new(move |session| match session {
        // s1's workspace set replaces the process one.
        "s1" => Some(std::sync::Arc::new(workspace.clone())),
        // A loaded-but-empty set denies everything: no fallback to the process catalog.
        "empty-ws" => Some(std::sync::Arc::new(empty.clone())),
        _ => None,
    }));
    let call = |session: &str, server: &str| json!({"sessionId": session, "serverName": server});

    // s1's workspace set replaces the process one for s1.
    assert!(
        admit(
            &server,
            &helper,
            "mcp/uiCallTool",
            &call("s1", "plugin:docs:documents")
        )
        .await
        .is_ok()
    );
    // A loaded-but-empty workspace denies even the process catalog's servers.
    assert_eq!(
        reason(
            admit(
                &server,
                &helper,
                "mcp/uiCallTool",
                &call("empty-ws", "plugin:viewer:view")
            )
            .await
            .err()
        ),
        not_hosted()
    );
    assert_eq!(
        reason(
            admit(
                &server,
                &helper,
                "mcp/uiCallTool",
                &call("s1", "plugin:viewer:view")
            )
            .await
            .err()
        ),
        not_hosted()
    );
    // s2 has no workspace layer: the process catalog answers.
    assert!(
        admit(
            &server,
            &helper,
            "mcp/uiCallTool",
            &call("s2", "plugin:viewer:view")
        )
        .await
        .is_ok()
    );
}
