//! Fork: the app-server's workspace trust admin (specs/fork-rust-agent-parity.md, "Workspace MCP trust, the MCP
//! settings list and Hook trust grants"). Implements the protocol's [`WorkspaceAdmin`]: `mcp/list` with a
//! settings-lane MCP manager, `workspace/mcp/trust`, `workspace/hooks/trustGrant` and the session banners.
//!
//! Config files and both trust stores are read again on every call: the App edits them while the agent runs, and
//! the stores are shared with Node. The settings lane is separate from the kernel's session MCP (Node's
//! `protocol-settings` lease): connecting there never changes what a running session has.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use rust_cli_base::Spawner;
use rust_cli_base::secret::EnvSnapshot;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_ext::mcp::{McpManager, McpScope, McpServer, McpSettings, parse_node_servers};
use rust_cli_hooks::HooksConfig;
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::machine::Files;
use rust_cli_kernel_api::manage::{McpAction, McpServerInfo, McpServerState};
use rust_cli_kernel_api::mcp::McpTransport;
use rust_cli_node_store::LOCAL_ENVIRONMENT;
use rust_cli_paths::StoragePaths;
use rust_cli_platform::local::{McpTrustError, McpTrustRecord};
use rust_cli_protocol_zcode::{Admission, WorkspaceAdmin, WorkspaceTarget};
use serde_json::{Map, Value, json};

use crate::commands::hooks_trust::{self, TrustContext};
use crate::config::mcp_trust::{self, Inspection, Review, Target};
use crate::config::{ConfigInputs, read_files};

/// The inputs the app-server's own workspace was assembled from: an accepted hook grant for that workspace
/// rebuilds the process's hook snapshot from them.
pub(crate) struct ProcessConfig {
    pub(crate) workspace: WorkspaceRef,
    pub(crate) process_env: EnvSnapshot,
    pub(crate) flag: Option<Map<String, Value>>,
    pub(crate) project_is_local: bool,
}

pub(crate) struct AppWorkspace {
    pub(crate) files: Arc<dyn Files>,
    pub(crate) paths: StoragePaths,
    pub(crate) process: ProcessConfig,
    /// The kernel's `replace_hooks` (a seam: tests record the snapshot instead).
    pub(crate) replace_hooks: Box<dyn Fn(HooksConfig) + Send + Sync>,
    pub(crate) transport: Arc<dyn McpTransport>,
    pub(crate) spawner: Spawner,
    pub(crate) clock: Arc<dyn Clock>,
    /// Connect and tool settings for the settings lane (defaults; the handshake carries the agent version).
    pub(crate) mcp: McpSettings,
    pub(crate) version: &'static str,
    lane: StdMutex<Option<Arc<Lane>>>,
}

/// The settings lane of one workspace key: the servers it connected and the ones it refused.
struct Lane {
    key: String,
    manager: McpManager,
    blocked: BTreeMap<String, Value>,
}

/// One read of a workspace: its ref, the configured servers and the MCP trust state.
struct Read {
    workspace: WorkspaceRef,
    user: Option<Map<String, Value>>,
    inspection: Inspection,
}

impl AppWorkspace {
    pub(crate) fn new(
        (files, paths): (Arc<dyn Files>, StoragePaths),
        process: ProcessConfig,
        replace_hooks: Box<dyn Fn(HooksConfig) + Send + Sync>,
        (transport, spawner, clock): (Arc<dyn McpTransport>, Spawner, Arc<dyn Clock>),
    ) -> Self {
        Self {
            files,
            paths,
            process,
            replace_hooks,
            transport,
            spawner,
            clock,
            mcp: McpSettings {
                client_version: crate::VERSION.to_owned(),
                ..McpSettings::default()
            },
            version: crate::VERSION,
            lane: StdMutex::new(None),
        }
    }

    fn now(&self) -> String {
        rust_cli_base::js::iso_timestamp(self.clock.now_ms())
    }

    fn trust_target(target: &WorkspaceTarget) -> Target {
        Target::new(&target.path, target.identity.as_deref())
    }

    async fn read(&self, target: &WorkspaceTarget) -> Read {
        let trust = Self::trust_target(target);
        let workspace = WorkspaceRef {
            environment: EnvironmentId::new(LOCAL_ENVIRONMENT),
            root: EnvPath::new(trust.working_directory.clone()),
        };
        let inputs = ConfigInputs {
            files: self.files.as_ref(),
            workspace: &workspace,
            paths: &self.paths,
            process_env: &self.process.process_env,
            flag: None,
            project_is_local: true,
        };
        let files = read_files(&inputs).await;
        let user = files.user.object().cloned();
        let inspection = Inspection::read(
            self.files.as_ref(),
            &workspace,
            trust,
            (user.as_ref(), &files.projects),
            &self.paths,
        )
        .await;
        Read {
            workspace,
            user,
            inspection,
        }
    }

    /// Node's configured servers: the Host's DTO when given, else the config's (project declarations and user
    /// servers, each tagged with its source).
    fn configured(read: &Read, servers: Option<&[Value]>) -> Vec<(String, Map<String, Value>)> {
        let mut out: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
        if let Some(servers) = servers {
            for (name, config) in servers.iter().filter_map(mcp_trust::dto_config) {
                out.insert(name, config);
            }
            return out.into_iter().collect();
        }
        if let Ok(discovery) = read.inspection.discovery() {
            for (name, declaration) in &discovery.declarations {
                let mut config = declaration.config.clone();
                config.insert("source".into(), json!({"kind": "workspace"}));
                out.insert(name.clone(), config);
            }
        }
        let user_servers = read
            .user
            .as_ref()
            .and_then(|user| user.get("mcp"))
            .and_then(|mcp| mcp.get("servers"))
            .and_then(Value::as_object);
        for (name, value) in user_servers.into_iter().flatten() {
            if let Some(mut config) = mcp_trust::validate(value) {
                config.insert("source".into(), json!({"kind": "user"}));
                out.insert(name.clone(), config);
            }
        }
        out.into_iter().collect()
    }

    /// The servers the settings lane may connect, and the status of each refused one (Node's guarded port).
    fn admit(
        &self,
        read: &Read,
        configured: &[(String, Map<String, Value>)],
    ) -> (Vec<McpServer>, BTreeMap<String, Value>) {
        let mut admitted = Vec::new();
        let mut blocked = BTreeMap::new();
        for (name, config) in configured {
            let disabled = config.get("enabled") == Some(&Value::Bool(false));
            if disabled || !read.inspection.allows(name, config) {
                let status = if disabled { "disabled" } else { "untrusted" };
                blocked.insert(name.clone(), self.idle(status, transport(config)));
                continue;
            }
            let scope = match mcp_trust::source_kind(config) {
                Some("user") => McpScope::User,
                Some("plugin" | "builtin") => McpScope::Plugin,
                _ => McpScope::Project,
            };
            let mut execution = config.clone();
            execution.remove("source");
            execution.remove("enabled");
            let (parsed, warnings) = parse_node_servers(&json!({ name.clone(): execution }), scope);
            for warning in warnings {
                tracing::warn!(warning, "settings MCP server");
            }
            admitted.extend(parsed.into_iter().map(|found| found.server));
        }
        (admitted, blocked)
    }

    fn idle(&self, status: &str, transport: &str) -> Value {
        json!({"status": status, "transport": transport, "toolCount": 0, "updatedAt": self.now()})
    }

    fn live(&self, info: &McpServerInfo, transport: &str) -> Value {
        let status = match info.state {
            McpServerState::Pending => "connecting",
            McpServerState::Connected => "connected",
            McpServerState::Failed => "failed",
            McpServerState::Disabled => "disabled",
        };
        let mut value = json!({
            "status": status,
            "transport": transport,
            "toolCount": info.tools,
            "updatedAt": self.now(),
        });
        if let Some(reason) = &info.reason {
            value["error"] = json!(reason);
        }
        value
    }

    /// Replaces the settings lane with one for `key` holding `servers` (Node connects with replace semantics and
    /// revalidates on every Settings refresh). The previous lane is closed before the new one starts; a lane that a
    /// concurrent connect put in meanwhile is closed too, so at most one lane stays open.
    async fn connect(
        &self,
        key: &str,
        workspace: WorkspaceRef,
        (servers, blocked): (Vec<McpServer>, BTreeMap<String, Value>),
    ) {
        let previous = self.lane.lock_unpoisoned().take();
        if let Some(previous) = previous {
            close(&previous).await;
        }
        let manager = McpManager::new(
            self.transport.clone(),
            self.spawner.clone(),
            self.mcp.clone(),
            self.clock.clone(),
        );
        manager.start(workspace, servers);
        manager.wait_ready().await;
        let fresh = Arc::new(Lane {
            key: key.to_owned(),
            manager,
            blocked,
        });
        let displaced = self.lane.lock_unpoisoned().replace(fresh);
        if let Some(displaced) = displaced {
            close(&displaced).await;
        }
    }

    /// Node `withReviews`: workspace declarations carry their review, and an unreviewed or disabled one shows so.
    fn with_reviews(
        &self,
        statuses: &mut Map<String, Value>,
        configured: &[(String, Map<String, Value>)],
        reviews: &[Review],
    ) {
        for review in reviews {
            let kind = configured
                .iter()
                .find(|(name, _)| *name == review.name)
                .and_then(|(_, config)| mcp_trust::source_kind(config));
            if matches!(kind, Some("user" | "plugin" | "builtin")) {
                continue;
            }
            let mut status = statuses
                .remove(&review.name)
                .unwrap_or_else(|| self.idle("disconnected", &review.transport));
            if !review.configured_enabled {
                status["status"] = json!("disabled");
                status["toolCount"] = json!(0);
            } else if !review.trusted {
                status["status"] = json!("untrusted");
                status["toolCount"] = json!(0);
            }
            status["workspaceTrust"] = review.to_value();
            statuses.insert(review.name.clone(), status);
        }
    }
}

async fn close(lane: &Lane) {
    let names: Vec<String> = lane
        .manager
        .server_infos()
        .into_iter()
        .map(|info| info.name)
        .collect();
    lane.manager.control(McpAction::Disable, &names).await;
}

fn transport(config: &Map<String, Value>) -> &str {
    config
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio")
}

#[async_trait]
impl WorkspaceAdmin for AppWorkspace {
    async fn mcp_list(
        &self,
        target: &WorkspaceTarget,
        servers: Option<&[Value]>,
        connect: bool,
    ) -> Result<Value, String> {
        let read = self.read(target).await;
        let configured = Self::configured(&read, servers);
        let reviews = read.inspection.reviews();
        let untrusted: Vec<&str> = reviews
            .iter()
            .filter(|review| !review.trusted)
            .map(|review| review.name.as_str())
            .collect();
        if connect {
            let admitted = self.admit(&read, &configured);
            self.connect(&target.key, read.workspace.clone(), admitted)
                .await;
        }
        // A status read reuses the lane only for its own workspace key (it never takes the lane over).
        let lane = self.lane.lock_unpoisoned().clone();
        let current = lane.as_deref().filter(|lane| lane.key == target.key);
        let infos: BTreeMap<String, McpServerInfo> = current
            .map(|lane| lane.manager.server_infos())
            .unwrap_or_default()
            .into_iter()
            .map(|info| (info.name.clone(), info))
            .collect();
        let mut statuses = Map::new();
        for (name, config) in &configured {
            let kind = transport(config);
            let status = if let Some(info) = infos.get(name) {
                self.live(info, kind)
            } else if let Some(blocked) = current.and_then(|lane| lane.blocked.get(name)) {
                blocked.clone()
            } else if config.get("enabled") == Some(&Value::Bool(false)) {
                self.idle("disabled", kind)
            } else if untrusted.contains(&name.as_str()) {
                self.idle("untrusted", kind)
            } else {
                self.idle("disconnected", kind)
            };
            statuses.insert(name.clone(), status);
        }
        self.with_reviews(&mut statuses, &configured, &reviews);
        Ok(json!({ "statuses": statuses }))
    }

    async fn mcp_trust(
        &self,
        target: &WorkspaceTarget,
        server: &str,
        digest: &str,
        trusted: bool,
    ) -> Value {
        let read = self.read(target).await;
        let record = McpTrustRecord {
            workspace_identity: read.inspection.target.identity.clone(),
            server_name: server.to_owned(),
            declaration_digest: digest.to_owned(),
            granted_at: self.now(),
        };
        // Node rediscovers inside the store lock: the decision is about the declaration shown, not a newer one.
        // An unreadable config is not a changed declaration: Node's `discover` throws and the answer is
        // `workspace_mcp_trust_unavailable`.
        let unreadable = AtomicBool::new(false);
        let still_declared = async || {
            let current = self.read(target).await;
            match current.inspection.discovery() {
                Ok(discovery) => discovery
                    .get(server)
                    .is_some_and(|declaration| declaration.digest == digest),
                Err(_) => {
                    unreadable.store(true, Ordering::Relaxed);
                    false
                }
            }
        };
        match read
            .inspection
            .store
            .decide(still_declared, record, trusted)
            .await
        {
            Ok(()) => json!({"accepted": true}),
            Err(McpTrustError::Changed) if !unreadable.load(Ordering::Relaxed) => {
                json!({"accepted": false, "reasonCode": "workspace_mcp_declaration_changed"})
            }
            Err(error) => {
                tracing::warn!(error = ?error, "workspace MCP trust decision failed");
                json!({"accepted": false, "reasonCode": "workspace_mcp_trust_unavailable"})
            }
        }
    }

    async fn hook_trust_grant(
        &self,
        target: &WorkspaceTarget,
        bundle_digest: &str,
        declaration_digest: &str,
    ) -> Value {
        let trust = Self::trust_target(target);
        let context = TrustContext {
            files: self.files.as_ref(),
            paths: &self.paths,
            cwd: &trust.working_directory,
            version: self.version,
            now_ms: self.clock.now_ms(),
        };
        let identity = (trust.identity != trust.working_directory).then(|| trust.identity.clone());
        let answer = hooks_trust::grant_for_app(
            &context,
            (trust.working_directory.clone(), identity),
            bundle_digest,
            declaration_digest,
        )
        .await;
        // The process's hook snapshot belongs to its own workspace: only a grant there changes it.
        let own = Target::new(self.process.workspace.root.as_str(), None);
        if answer["accepted"] == json!(true) && trust == own {
            let inputs = ConfigInputs {
                files: self.files.as_ref(),
                workspace: &self.process.workspace,
                paths: &self.paths,
                process_env: &self.process.process_env,
                flag: self.process.flag.as_ref(),
                project_is_local: self.process.project_is_local,
            };
            let hooks = crate::config::assemble(&inputs).await.hooks;
            (self.replace_hooks)(hooks);
        }
        answer
    }

    async fn admission(&self, target: &WorkspaceTarget) -> Admission {
        let read = self.read(target).await;
        let mcp = mcp_trust::admission(&read.inspection.target, &read.inspection.reviews());
        let trust = &read.inspection.target;
        let context = TrustContext {
            files: self.files.as_ref(),
            paths: &self.paths,
            cwd: &trust.working_directory,
            version: self.version,
            now_ms: self.clock.now_ms(),
        };
        let identity = (trust.identity != trust.working_directory).then(|| trust.identity.clone());
        let hooks =
            hooks_trust::inspect_at(&context, trust.working_directory.clone(), identity).await;
        let hook = hooks.pending().map(|pending| {
            json!({
                "pendingCount": pending.digests.len(),
                "bundleDigest": pending.bundle_digest,
                "workspaceIdentity": pending.identity,
            })
        });
        Admission {
            mcp: Some(mcp),
            hook,
        }
    }
}

#[cfg(test)]
#[path = "app_workspace_tests.rs"]
mod tests;
