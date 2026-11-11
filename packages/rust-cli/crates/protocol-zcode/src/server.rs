//! App 协议的方法表（docs/specs/rust-cli/app-protocol.md §3.4、§10.3）：P1 的方法；其余回 `-32601`。
//! 命令在 [`crate::commands`]，订阅在 [`crate::subscribe`]。

use rust_cli_base::sync::LockUnpoisoned;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{EndReason, Kernel, KernelError};
use rust_cli_protocol_core::connection::{Reply, Service};
use rust_cli_protocol_core::rpc::RpcError;
use rust_cli_protocol_core::sessions::{Bridged, SessionBridge};
use serde_json::{Value, json};

use crate::context::Context;
use crate::inbound::Inbound;
use crate::inbox::Remembered;
use crate::index::Topics;
use crate::live::Live;
use crate::projection::state::Followup;

/// 会话不可用（`zcodeProtocolErrorCodes.sessionUnavailable`）。
pub const SESSION_UNAVAILABLE: i64 = -32004;

/// 会话事件攒成一批再发的窗口。
const EVENT_BATCH_WINDOW: std::time::Duration = std::time::Duration::from_millis(30);

/// 新会话的缺省（入口给出）。
#[derive(Debug, Clone)]
pub struct Defaults {
    pub selection: ModelSelection,
    pub mode: PermissionMode,
    pub environment: EnvironmentId,
}

/// 工作区级的开关（Host 推来的偏好；P1 只保存与回声）。
#[derive(Debug, Clone, Default)]
struct Preferences {
    ask_auto_resolution: bool,
    full_retention: bool,
}

pub struct Server {
    pub(crate) context: Arc<Context>,
    pub(crate) kernel: Arc<dyn Kernel>,
    pub(crate) bridge: SessionBridge<Live>,
    /// Fork: spawns the per-session subagent table watchers.
    spawner: rust_cli_base::Spawner,
    pub(crate) topics: Arc<Topics>,
    pub(crate) remembered: Mutex<Remembered>,
    pub(crate) followups: Mutex<HashMap<SessionId, Followup>>,
    pub(crate) defaults: Defaults,
    /// 本进程的实例标识（时钟探测的 `clock.instanceId`）。
    pub(crate) instance: String,
    preferences: Mutex<Preferences>,
    /// Fork: staged App attachment uploads (crate::uploads).
    pub(crate) uploads: Mutex<crate::uploads::Registry>,
    /// Fork: serializes submission reservations (crate::preparation::ReservationGate).
    pub(crate) reservations: crate::preparation::ReservationGate,
    /// Fork: prepared worktree sessions materialized in this process whose active marker failed to store
    /// (`worktree::activate`). Process-local like Node's runtime record: the gate lets their commands through and
    /// heals the marker; after a restart the durable marker decides again.
    pub(crate) unreceipted: Mutex<std::collections::HashSet<SessionId>>,
    /// Fork: the incognito choice a prepared worktree session's first activation froze in this process (Node's
    /// in-memory `prepared.incognito`): `None` a normal session, `Some(profile)` an incognito one. It covers a warm
    /// retry of a failed activation; the row's set-once `fork_incognito` is the durable fact, and the stored marker
    /// never carries the choice (Node `persistPreparedWorktreeStatus`).
    pub(crate) prepared_incognito:
        Mutex<HashMap<SessionId, Option<rust_cli_kernel_api::incognito::IncognitoProfile>>>,
    /// Fork: session lifecycle revisions (crate::lifecycle).
    pub(crate) lifecycles: crate::lifecycle::Lifecycles,
}

pub(crate) fn kernel_error(error: &KernelError) -> RpcError {
    match error {
        KernelError::NotFound { session } => RpcError::new(
            SESSION_UNAVAILABLE,
            format!("Session unavailable: {}", session.as_str()),
        ),
        other => RpcError::internal(other.to_string()),
    }
}

impl Server {
    /// Fork: `v4/conversation/rowsRange`, the cursor read behind the App's load-older (Node `V4Gateway.rowsRange`).
    /// `residency: "resident-only"` (the phone's preload) never opens a stored session.
    async fn rows_range(&self, params: &Value) -> Result<Value, RpcError> {
        let Some(id) = params["sessionId"].as_str().filter(|id| !id.is_empty()) else {
            return Err(RpcError::invalid_params("sessionId is required"));
        };
        let Some(limit) = params["limit"].as_u64().filter(|limit| *limit >= 1) else {
            return Err(RpcError::invalid_params("limit must be a positive number"));
        };
        let session = SessionId::new(id);
        if params["residency"] == "resident-only" && self.bridge.get(&session).is_none() {
            return Err(RpcError::new(
                SESSION_UNAVAILABLE,
                format!("session is not resident: {id} (proto.sessionNotResident)"),
            )
            .with_data(json!({"reasonCode": "proto.sessionNotResident"})));
        }
        let live = self
            .live(&session)
            .await
            .map_err(|error| kernel_error(&error))?;
        let before = params["beforeRowId"]
            .as_f64()
            .map(|before| before.ceil() as u64);
        Ok(live
            .sink
            .rows_range(before, usize::try_from(limit).unwrap_or(usize::MAX)))
    }
}

impl Server {
    pub fn new(
        context: Arc<Context>,
        kernel: Arc<dyn Kernel>,
        spawner: rust_cli_base::Spawner,
        defaults: Defaults,
    ) -> Self {
        let topics = Arc::new(Topics::new(context.clone(), &spawner));
        Self {
            instance: context.fresh("instance"),
            bridge: SessionBridge::new(kernel.clone(), spawner.clone(), EVENT_BATCH_WINDOW),
            spawner,
            context,
            kernel,
            topics,
            remembered: Mutex::new(Remembered::default()),
            followups: Mutex::new(HashMap::new()),
            defaults,
            preferences: Mutex::new(Preferences::default()),
            uploads: Mutex::new(crate::uploads::Registry::default()),
            reservations: crate::preparation::ReservationGate::default(),
            unreceipted: Mutex::new(std::collections::HashSet::new()),
            prepared_incognito: Mutex::new(HashMap::new()),
            lifecycles: crate::lifecycle::Lifecycles::default(),
        }
    }

    pub(crate) fn workspace(&self, path: &str) -> WorkspaceRef {
        WorkspaceRef {
            environment: self.defaults.environment.clone(),
            root: EnvPath::new(path),
        }
    }

    /// 打开会话并接上投影（已经打开时直接给出）。
    pub(crate) async fn live(
        &self,
        session: &SessionId,
    ) -> Result<Arc<Bridged<Live>>, KernelError> {
        let followup = self
            .followups
            .lock_unpoisoned()
            .get(session)
            .copied()
            .unwrap_or(Followup::Queue);
        let (context, topics) = (self.context.clone(), self.topics.clone());
        let opening = self.bridge.get(session).is_none();
        // Fork: the model directory is read only for a cold open.
        let catalog = if opening {
            self.context.catalog().await
        } else {
            std::sync::Arc::from(Vec::new())
        };
        // Fork: the stored worktree and submission facts, read for a cold open only and handed to the projection when
        // it is made, so a later concurrent open cannot write them again over an activation.
        let restored = if opening {
            let execution = crate::worktree::stored_execution(self, session).await;
            crate::live::Restored {
                listed: execution
                    .as_ref()
                    .map(|worktree| worktree.directory.as_str().to_owned()),
                worktree: crate::worktree::facts(self, session, execution.as_ref())
                    .await
                    .map_err(|reason| KernelError::Failed {
                        message: reason.to_owned(),
                    })?,
                preparation: match crate::preparation::load(self, session).await {
                    Ok(Some(marker)) => marker.exposed(),
                    _ => None,
                },
            }
        } else {
            crate::live::Restored::default()
        };
        // Fork: a prepared worktree that is not active yet (an agent restart before the activation) keeps SessionStart
        // held, as the live session did, so the hook never runs in the parent checkout. The kernel opens it here; the
        // bridge's own open below finds it open.
        if restored.worktree.preparing.is_some() {
            self.kernel.open_prepared_session(session).await?;
        }
        // Set by the one open that makes the projection: only it starts the session's watchers.
        let made = std::sync::atomic::AtomicBool::new(false);
        let made_here = &made;
        let live = self
            .bridge
            .open(session, move |handle, view| {
                made_here.store(true, std::sync::atomic::Ordering::Relaxed);
                Live::new(
                    context,
                    topics,
                    handle.clone(),
                    view,
                    followup,
                    catalog,
                    restored,
                )
            })
            .await?;
        if made.load(std::sync::atomic::Ordering::Relaxed) {
            // Fork: the subagent rows and the `subagents` manifest follow the kernel's subagent table.
            let watcher = self.spawner.spawn(
                "subagent-table-watch",
                crate::live::watch_subagents(live.handle.subagent_changes(), Arc::downgrade(&live)),
            );
            live.sink.watch_subagents(watcher);
            // Fork: the telemetry facts of a subagent's run are read from its live feed (crate::telemetry).
            let (spawner, weak) = (self.spawner.clone(), Arc::downgrade(&live));
            live.sink
                .set_child_watch(Box::new(move |child, watch, alive| {
                    let bridged = weak.upgrade()?;
                    let feed = bridged.sink.handle().child_run(&SessionId::new(child))?;
                    Some(spawner.spawn(
                        "telemetry-child-run",
                        crate::live::read_child_run(
                            feed,
                            child.to_owned(),
                            watch,
                            alive,
                            weak.clone(),
                        ),
                    ))
                }));
            let sink = live.sink.clone();
            live.run(Box::pin(async move { sink.prime_child_runs().await }));
            // Fork: the background commands already running (a subagent's child session opened in a side tab, a
            // session reopened while its command runs) are listed from the open, not from the next ledger change.
            let sink = live.sink.clone();
            live.run(Box::pin(async move { sink.shells_changed().await }));
            self.announce_lifecycle(session, "ready").await;
        }
        Ok(live)
    }

    /// Fork: records a lifecycle change and tells the App (crate::lifecycle).
    async fn announce_lifecycle(&self, session: &SessionId, state: &str) {
        let snapshot = self.lifecycles.changed(session, state);
        self.context
            .peer
            .notify(crate::lifecycle::CHANGED, &snapshot)
            .await;
    }

    /// Fork: `session/lifecycle/getState`. An open session is `ready`, a stored one `unloaded`; an unknown one is an
    /// error, like Node's `exists` check.
    async fn lifecycle_state(&self, params: &Value) -> Result<Value, RpcError> {
        let Some(id) = params["sessionId"].as_str().filter(|id| !id.is_empty()) else {
            return Err(RpcError::invalid_params("sessionId is required"));
        };
        let session = SessionId::new(id);
        if self.bridge.get(&session).is_some() {
            return Ok(self.lifecycles.current(&session, "ready"));
        }
        self.kernel
            .session_snapshot(&session)
            .await
            .map_err(|error| kernel_error(&error))?;
        Ok(self.lifecycles.current(&session, "unloaded"))
    }

    /// Fork: `session/lifecycle/{ensureReady,stop,restart}` (Node `SessionLifecycleController`). A manual stop
    /// does not wait for a busy turn, like Node's no-op `assertCanStop`; restart is stop plus a cold open, so the
    /// App sees `unloaded` and then `ready` with higher revisions. An unknown session fails like `getState`.
    pub(crate) async fn lifecycle_operation(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let Some(id) = params["sessionId"].as_str().filter(|id| !id.is_empty()) else {
            return Err(RpcError::invalid_params("sessionId is required"));
        };
        let session = SessionId::new(id);
        if self.bridge.get(&session).is_none() {
            self.kernel
                .session_snapshot(&session)
                .await
                .map_err(|error| kernel_error(&error))?;
        }
        if method != "session/lifecycle/ensureReady"
            && let Some(bridged) = self.bridge.close(&session)
        {
            // End the kernel actor too (as session delete does): a bridge-only close keeps the old runtime, and the
            // kernel's next open waits for this close before it cold-loads the session again.
            bridged.handle.close(EndReason::Other).await;
            self.announce_lifecycle(&session, "unloaded").await;
        }
        if method != "session/lifecycle/stop" {
            self.live(&session)
                .await
                .map_err(|error| kernel_error(&error))?;
        }
        Ok(json!({"completed": true}))
    }

    fn preferences(&self) -> std::sync::MutexGuard<'_, Preferences> {
        self.preferences.lock_unpoisoned()
    }

    async fn read_presentation(&self, params: &Value) -> Value {
        let workspace = params["workspace"].clone();
        let path = workspace["workspacePath"].as_str().unwrap_or_default();
        let commands: Vec<Value> = self
            .kernel
            .user_commands(&self.workspace(path))
            .await
            .into_iter()
            .filter(|command| !command.hidden && !command.name.is_empty())
            .map(|command| {
                let mut value = json!({"name": command.name, "description": command.description,
                    "source": "custom"});
                if let Some(hint) = command.argument_hint {
                    value["inputHint"] = json!(hint);
                }
                value
            })
            .collect();
        json!({"workspace": workspace, "mode": self.defaults.mode.node_name(),
            "slashCommands": commands})
    }

    async fn close_session(&self, params: &Value) -> Value {
        let session = SessionId::new(params["sessionId"].as_str().unwrap_or_default());
        let open = self.bridge.get(&session).is_some();
        self.bridge.close(&session);
        if open {
            self.announce_lifecycle(&session, "unloaded").await;
        }
        json!({"closed": true})
    }

    async fn dispatch(&self, method: &str, params: Value) -> Result<Reply, RpcError> {
        let reply = |value: Value| Ok(Reply::new(value));
        match method {
            // 不支持的能力给 false（app-protocol.md §4.3）。
            "runtime/capabilities" => reply(json!({
                // Fork: reservation, activation receipts and the first-input marker (crate::preparation).
                "durableFirstSubmission": true,
                // Fork: plan is a switch beside the permission mode, frozen per queued input
                // (`Command::SubmitWith`); yolo with plan on still runs in plan mode.
                "independentPlanState": true,
                "historyFirst": false,
                "sessionDirectorySource": false,
                "genUiContext": false,
                "sessionWorkspaceRouting": true,
                "residentRowsRange": true,
                // Fork: incognito sessions with per-capability toggles (kernel_api::incognito,
                // specs/fork-rust-agent-parity.md "Incognito sessions").
                "incognitoSession": true,
                "incognitoPromptToggles": true,
            })),
            // platform 自己读同一批文件；回执版本（app-protocol.md §5.1）。
            "provider/updateAccountConfig" => reply(json!({
                "receivedRevision": params["revision"],
                "providerCount": params["providers"].as_object().map_or(0, serde_json::Map::len),
                "status": "received",
            })),
            "provider/refreshRegistry" => reply(json!({"refreshed": true})),
            "workspace/updateInteractionPreferences" => {
                let enabled = params["preferences"]["askUserQuestionAutoResolutionEnabled"]
                    .as_bool()
                    .unwrap_or(false);
                self.preferences().ask_auto_resolution = enabled;
                reply(json!({"workspace": params["workspace"],
                    "askUserQuestionAutoResolutionEnabled": enabled, "snoozedInteractionCount": 0}))
            }
            "workspace/updateModelIoPreferences" => {
                let enabled = params["preferences"]["fullRetentionEnabled"]
                    .as_bool()
                    .unwrap_or(false);
                self.preferences().full_retention = enabled;
                reply(
                    json!({"workspace": params["workspace"], "fullRetentionEnabled": enabled,
                    "updatedSessionCount": 0}),
                )
            }
            "workspace/updateOffPeakToolPolicy" => {
                reply(json!({"workspace": params["workspace"], "enabled": params["enabled"]}))
            }
            // 动态工作流不移植（P4 决定）：回 disabled 生效。
            "workspace/updateDynamicWorkflowPolicy" => {
                reply(json!({"workspace": params["workspace"], "enabled": false}))
            }
            "workspace/readPresentation" => reply(self.read_presentation(&params).await),
            // 目录来源按 sessionIds 查父链：rust 的会话没有要报的父链（子代理不进列表），P1 回空列表。
            "session/list" => reply(json!({"sessions": []})),
            "session/read" => crate::legacy::read(self, &params).await.map(Reply::new),
            "session/close" => reply(self.close_session(&params).await),
            "v4/conversation/subscribe" => crate::subscribe::subscribe(self, &params).await,
            "v4/conversation/unsubscribe" => crate::subscribe::unsubscribe(self, &params).await,
            "v4/conversation/resync" => crate::subscribe::resync(self, &params).await,
            "session/lifecycle/getState" => self.lifecycle_state(&params).await.map(Reply::new),
            "session/lifecycle/ensureReady"
            | "session/lifecycle/stop"
            | "session/lifecycle/restart" => self
                .lifecycle_operation(method, &params)
                .await
                .map(Reply::new),
            "v4/conversation/rowsRange" => self.rows_range(&params).await.map(Reply::new),
            "v4/connection/flow" => crate::subscribe::flow(self, &params).await,
            "v4/sessionsIndex/reconcile" => crate::subscribe::reconcile(self, &params).await,
            "v4/command" => crate::commands::command(self, params).await.map(Reply::new),
            "v4/commands/query" => crate::commands::query(self, &params).await.map(Reply::new),
            "v4/attachment/begin" => crate::attachments::begin(self, &params).await,
            "v4/attachment/chunk" => crate::attachments::chunk(self, &params).await,
            "v4/attachment/commit" => crate::attachments::commit(self, &params).await,
            "v4/attachment/abort" => crate::attachments::abort(self, &params).await,
            "v4/attachment/read" => crate::attachments::read_chunk(self, &params).await,
            "v4/attachment/previewSource" => {
                crate::attachments::preview_source(self, &params).await
            }
            // Fork: method families ported for desktop parity (specs/fork-rust-agent-parity.md).
            other => match crate::fork::methods::dispatch(self, other, params).await {
                Some(result) => result,
                None => {
                    tracing::info!(
                        event = "protocol.method.unsupported",
                        method = other,
                        "method is not supported by this agent"
                    );
                    Err(RpcError::method_not_found(other))
                }
            },
        }
    }
}

/// [`Server`] 放在连接上的形状（读循环要 `'static`）。
pub struct Handler(pub Arc<Server>);

#[async_trait]
impl Service for Handler {
    async fn request(&self, method: &str, params: Value) -> Result<Reply, RpcError> {
        Inbound::get().method(method, &params)?;
        self.0.dispatch(method, params).await
    }
}
