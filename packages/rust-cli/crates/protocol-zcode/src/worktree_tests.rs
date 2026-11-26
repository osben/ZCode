//! Execution worktree: Node's marker shape and guards (`worktree-preparation-guard.test.ts`,
//! `v4-prepared-worktree-lifecycle.test.ts`), the sessions-index fields, and the prepare → update → activate flow
//! through the protocol server with a recording kernel.

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::OwnerEpoch;
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, TraceId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    CommandEnvelope, CommandResult, CreateSession, Forked, KernelError, SequencedEvent,
    SessionHandle, SessionView,
};
use rust_cli_kernel_api::store::{
    Fact, FactBatch, SessionFilter, SessionKind, SessionMeta, SessionStore, SessionSummary,
    StoreQueries,
};
use rust_cli_kernel_api::testing::{FixedClock, HandleOverride, MemoryStore, selection};
use rust_cli_protocol_core::connection::{self, Options};

use super::*;
use crate::context::Context;
use crate::server::Defaults;

fn request(attempt: Option<&str>) -> Request {
    Request {
        branch_name: "feat/a".to_owned(),
        target_path: "/w/.worktrees/a".to_owned(),
        base_branch: Some("main".to_owned()),
        attempt_id: attempt.map(str::to_owned),
    }
}

fn update(status: PrepStatus, expected: Option<&str>, replacing: Option<Request>) -> Update {
    Update {
        status,
        failure_message: None,
        expected_attempt_id: expected.map(str::to_owned),
        worktree_preparation: replacing,
    }
}

/// Fork: the stored record and `worktreePreparation` are both Node's shape (`persistPreparedWorktreeStatus`,
/// `worktreePreparationStateSchema`), so a failed activation leaks nothing to the renderer. A key Node does not write,
/// such as the `incognito` stamp an earlier build of this branch stored, is dropped on read like Node's parser does.
#[test]
fn the_marker_record_and_the_wire_shape_are_nodes() {
    let marker =
        Marker::preparing(&request(Some("a1"))).with_status(PrepStatus::Failed, Some("boom"), None);
    let wire = json!({"attemptId": "a1", "branchName": "feat/a", "targetPath": "/w/.worktrees/a",
                      "baseBranch": "main", "status": "failed", "failureMessage": "boom"});
    assert_eq!(marker.exposed(), Some(wire.clone()));
    let mut record = marker.record("s1");
    assert_eq!(record.data, wire);
    record.data["incognito"] = json!(null);
    let read = Marker::latest(&[record]).unwrap();
    assert_eq!(read, marker);
    assert_eq!(read.record("s1").data, wire);
}

#[test]
fn the_marker_is_nodes_record_without_times() {
    let marker = Marker::preparing(&request(Some("a1")));
    let record = marker.record("s1");
    assert_eq!(record.kind, "v4/worktree_preparation");
    assert_eq!(record.key, "v4/worktree_preparation:s1");
    assert_eq!(
        record.data,
        json!({"attemptId": "a1", "branchName": "feat/a", "targetPath": "/w/.worktrees/a",
               "baseBranch": "main", "status": "preparing"})
    );
    assert_eq!(Marker::latest(&[record]), Some(marker));
    // A Node-written marker without the optional fields; an active one is not exposed.
    let node = FrontendRecord {
        kind: KIND.to_owned(),
        key: "k".to_owned(),
        data: json!({"branchName": "b", "targetPath": "/t", "status": "active"}),
    };
    let read = Marker::latest(&[node]).unwrap();
    assert_eq!(read.attempt_id, None);
    assert_eq!(read.exposed(), None);
    let broken = FrontendRecord {
        kind: KIND.to_owned(),
        key: "k".to_owned(),
        data: json!({"branchName": "b", "targetPath": "/t", "status": "done"}),
    };
    assert_eq!(Marker::latest(&[broken]), None);
}

#[test]
fn a_status_change_keeps_or_replaces_the_request_like_node() {
    let marker = Marker::preparing(&request(Some("a1")));
    let failed = marker.with_status(PrepStatus::Failed, Some("git failed"), None);
    assert_eq!(failed.failure_message.as_deref(), Some("git failed"));
    assert_eq!(failed.attempt_id.as_deref(), Some("a1"));
    let retry = Request {
        branch_name: "feat/b".to_owned(),
        target_path: "/w/.worktrees/b".to_owned(),
        base_branch: None,
        attempt_id: Some("a2".to_owned()),
    };
    let next = failed.with_status(PrepStatus::Preparing, None, Some(&retry));
    assert_eq!(next.failure_message, None);
    assert_eq!(next.attempt_id.as_deref(), Some("a2"));
    assert_eq!(next.branch_name, "feat/b");
    assert_eq!(next.base_branch, None);
}

#[test]
fn updates_follow_the_attempt_compare_and_set() {
    let preparing = Marker::preparing(&request(Some("a1")));
    assert_eq!(
        check_update(None, &update(PrepStatus::Failed, Some("a1"), None)),
        Err(UNAVAILABLE)
    );
    // Another attempt is stale.
    assert_eq!(
        check_update(
            Some(&preparing),
            &update(PrepStatus::Failed, Some("a0"), None)
        ),
        Err(UNAVAILABLE)
    );
    assert_eq!(
        check_update(
            Some(&preparing),
            &update(PrepStatus::Failed, Some("a1"), None)
        ),
        Ok(())
    );
    let active = preparing.with_status(PrepStatus::Active, None, None);
    assert_eq!(
        check_update(Some(&active), &update(PrepStatus::Failed, Some("a1"), None)),
        Err(UNAVAILABLE)
    );
    // A cancelled preparation only restarts with a new attempt.
    let cancelled = preparing.with_status(PrepStatus::Cancelled, None, None);
    assert_eq!(
        check_update(
            Some(&cancelled),
            &update(PrepStatus::Failed, Some("a1"), None)
        ),
        Err(CANCELLED)
    );
    assert_eq!(
        check_update(
            Some(&cancelled),
            &update(PrepStatus::Preparing, Some("a1"), Some(request(Some("a1"))))
        ),
        Err(CANCELLED)
    );
    assert_eq!(
        check_update(
            Some(&cancelled),
            &update(PrepStatus::Preparing, Some("a1"), Some(request(Some("a2"))))
        ),
        Ok(())
    );
    // A failed preparation can be retried in place.
    let failed = preparing.with_status(PrepStatus::Failed, Some("x"), None);
    assert_eq!(
        check_update(
            Some(&failed),
            &update(PrepStatus::Preparing, Some("a1"), None)
        ),
        Ok(())
    );
}

#[test]
fn activation_checks_the_attempt_the_workspace_and_the_worktree() {
    let preparing = Marker::preparing(&request(Some("a1")));
    let requested = Requested {
        path: "/w/.worktrees/a".to_owned(),
        branch_name: Some("feat/a".to_owned()),
    };
    let ok = |marker: &Marker| check_activation(Some(marker), Some("a1"), true, Some(&requested));
    assert_eq!(ok(&preparing), Ok(Activation::Materialize));
    assert_eq!(
        ok(&preparing.with_status(PrepStatus::Active, None, None)),
        Ok(Activation::AlreadyActive)
    );
    assert_eq!(
        ok(&preparing.with_status(PrepStatus::Failed, None, None)),
        Err(UNAVAILABLE)
    );
    assert_eq!(
        check_activation(Some(&preparing), Some("a0"), true, Some(&requested)),
        Err(UNAVAILABLE)
    );
    assert_eq!(
        check_activation(None, Some("a1"), true, Some(&requested)),
        Err(UNAVAILABLE)
    );
    assert_eq!(
        check_activation(Some(&preparing), Some("a1"), false, Some(&requested)),
        Err(MISMATCH)
    );
    assert_eq!(
        check_activation(Some(&preparing), Some("a1"), true, None),
        Err(MISMATCH)
    );
    let elsewhere = Requested {
        path: "/other".to_owned(),
        branch_name: None,
    };
    assert_eq!(
        check_activation(Some(&preparing), Some("a1"), true, Some(&elsewhere)),
        Err(MISMATCH)
    );
    let other_branch = Requested {
        branch_name: Some("feat/z".to_owned()),
        ..requested.clone()
    };
    assert_eq!(
        check_activation(Some(&preparing), Some("a1"), true, Some(&other_branch)),
        Err(MISMATCH)
    );
}

#[test]
fn the_row_is_a_titled_draft_while_preparing_and_carries_the_worktree_after() {
    let mut row = json!({"title": "", "phase": "completedSuccess", "sessionEnded": true, "lastOutcome": "completed"});
    Facts {
        preparing: Some(Marker::preparing(&request(None))),
        execution: None,
    }
    .decorate_row(&mut row);
    assert_eq!(row["phase"], "draft");
    assert_eq!(row["sessionEnded"], false);
    assert_eq!(row["title"], "Worktree feat/a");
    assert_eq!(row["worktreePreparation"]["status"], "preparing");
    assert!(row.get("lastOutcome").is_none());

    let mut row = json!({"title": "Fix it"});
    Facts {
        preparing: None,
        execution: Some(Execution {
            path: "/w/.worktrees/a".to_owned(),
            branch: None,
            missing: true,
        }),
    }
    .decorate_row(&mut row);
    assert_eq!(row["executionWorktree"], json!({"path": "/w/.worktrees/a"}));
    assert_eq!(row["executionWorktreeMissing"], true);
    assert!(row.get("worktreePreparation").is_none());
}

/// A handle that records commands and moves its view's root on `SetExecutionRoot`, as the actor does.
struct TestHandle {
    id: SessionId,
    view: StdMutex<SessionView>,
    sent: Arc<StdMutex<Vec<(String, String)>>>,
    /// How many `SetExecutionRoot` commands to refuse (the actor refuses a move while busy).
    refuse_moves: Arc<std::sync::atomic::AtomicUsize>,
    /// How many `SetMode` commands to refuse.
    refuse_modes: Arc<std::sync::atomic::AtomicUsize>,
    /// B1.3: the store the fork command writes through (the actor's `copy_through`).
    store: Arc<MemoryStore>,
}

#[async_trait]
impl HandleOverride for TestHandle {
    fn id(&self) -> &SessionId {
        &self.id
    }

    async fn send(&self, envelope: CommandEnvelope) -> KernelAck {
        let name = match &envelope.command {
            Command::SetExecutionRoot { root } => {
                let refuse = self
                    .refuse_moves
                    .fetch_update(
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst,
                        |left| left.checked_sub(1),
                    )
                    .is_ok();
                if refuse {
                    return KernelAck::Rejected {
                        reason: "A turn is in progress".to_owned(),
                    };
                }
                self.view.lock().unwrap().meta.workspace.root = root.clone();
                format!("SetExecutionRoot {}", root.as_str())
            }
            Command::Submit { text, .. } => format!("Submit {text}"),
            Command::SubmitWith {
                text, execution, ..
            } => match execution {
                Some(execution) => format!(
                    "Submit {text} mode={:?} plan={}{}",
                    execution.state.mode,
                    execution.state.plan,
                    execution
                        .selection
                        .as_ref()
                        .map(|chosen| format!(" model={}", chosen.model))
                        .unwrap_or_default()
                ),
                None => format!("Submit {text}"),
            },
            Command::SetModel { selection } => {
                self.view.lock().unwrap().selection = selection.clone();
                format!("SetModel {}", selection.model)
            }
            Command::SetMode { mode } => {
                let refuse = self
                    .refuse_modes
                    .fetch_update(
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst,
                        |left| left.checked_sub(1),
                    )
                    .is_ok();
                if refuse {
                    return KernelAck::Rejected {
                        reason: "the mode could not be set".to_owned(),
                    };
                }
                self.view.lock().unwrap().mode = *mode;
                "SetMode".to_owned()
            }
            Command::SetPlan { enabled } => {
                self.view.lock().unwrap().plan = *enabled;
                "SetPlan".to_owned()
            }
            Command::SetIncognito { profile } => {
                self.view.lock().unwrap().meta.incognito = Some(*profile);
                "SetIncognito".to_owned()
            }
            // B1.3: the store fork, as the actor's `copy_through` runs it — the child row and, with a
            // managed-worktree target, its execution columns in the same write, under the Host's
            // pre-allocated child id.
            Command::ForkFromAssistant {
                assistant,
                target_cwd,
            } => {
                let view = self.view.lock().unwrap().clone();
                let child = target_cwd.as_ref().map_or_else(
                    || SessionId::new(format!("{}_forked", self.id.as_str())),
                    |target| target.child.clone(),
                );
                // A fixed stamp, not the test clock's now(): nothing asserts timestamps, and the
                // double only needs a stable value the copied facts carry.
                let fork = rust_cli_kernel_api::store::SessionFork {
                    parent: self.id.clone(),
                    child: child.clone(),
                    created_at_ms: 5000,
                    through: Some(assistant.clone()),
                    kind: Default::default(),
                    selection: view.selection.clone(),
                    mode: view.mode,
                    plan: view.plan,
                    execution: target_cwd.as_ref().map(|target| target.root.clone()),
                };
                let copied = match SessionStore::fork(self.store.as_ref(), fork).await {
                    Ok(receipt) => receipt.copied,
                    Err(error) => {
                        return KernelAck::Rejected {
                            reason: error.to_string(),
                        };
                    }
                };
                let root = target_cwd
                    .as_ref()
                    .map_or(String::new(), |target| target.root.as_str().to_owned());
                self.sent.lock().unwrap().push((
                    envelope.id.as_str().to_owned(),
                    format!(
                        "ForkFromAssistant {assistant} child={} root={root}",
                        child.as_str()
                    ),
                ));
                return KernelAck::Accepted {
                    result: CommandResult::Forked(Forked {
                        session: child,
                        through: Some(assistant.clone()),
                        copied,
                    }),
                };
            }
            // The selection side chat, as the actor's `fork_selection_side_chat` runs it: the whole committed history
            // here (nothing runs in the double), the chosen model or the session's own.
            Command::ForkSelectionSideChat { selection } => {
                let view = self.view.lock().unwrap().clone();
                let child = SessionId::new(format!("{}_side_{}", self.id.as_str(), envelope.id));
                let through = view.messages.last().map(|message| message.id().clone());
                let fork = rust_cli_kernel_api::store::SessionFork {
                    parent: self.id.clone(),
                    child: child.clone(),
                    created_at_ms: 5000,
                    through: through.clone(),
                    kind: rust_cli_kernel_api::store::ForkKind::SelectionSideChat,
                    selection: selection.clone().unwrap_or(view.selection.clone()),
                    mode: view.mode,
                    plan: view.plan,
                    execution: None,
                };
                let copied = match SessionStore::fork(self.store.as_ref(), fork).await {
                    Ok(receipt) => receipt.copied,
                    Err(error) => {
                        return KernelAck::Rejected {
                            reason: error.to_string(),
                        };
                    }
                };
                self.sent.lock().unwrap().push((
                    envelope.id.as_str().to_owned(),
                    format!(
                        "ForkSelectionSideChat child={} model={}",
                        child.as_str(),
                        selection
                            .as_ref()
                            .map_or("-", |chosen| chosen.model.as_str())
                    ),
                ));
                return KernelAck::Accepted {
                    result: CommandResult::Forked(Forked {
                        session: child,
                        through,
                        copied,
                    }),
                };
            }
            other => format!("{other:?}"),
        };
        self.sent
            .lock()
            .unwrap()
            .push((envelope.id.as_str().to_owned(), name));
        KernelAck::Accepted {
            result: CommandResult::Done,
        }
    }

    fn subscribe(&self, _after: Option<u64>) -> BoxStream<'static, SequencedEvent> {
        stream::empty().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(self.view.lock().unwrap().clone())
    }
}

/// A kernel over a memory store: sessions are created in it, every session opens one recording handle.
struct WorktreeKernel {
    store: Arc<MemoryStore>,
    handles: StdMutex<HashMap<SessionId, Arc<TestHandle>>>,
    sent: Arc<StdMutex<Vec<(String, String)>>>,
    deleted: StdMutex<Vec<String>>,
    refuse_moves: Arc<std::sync::atomic::AtomicUsize>,
    refuse_modes: Arc<std::sync::atomic::AtomicUsize>,
    /// Sessions created through `create_prepared_session` (SessionStart held until the move).
    prepared: StdMutex<Vec<String>>,
    /// Sessions cold-opened through `open_prepared_session` (SessionStart held until the move).
    reopened_held: StdMutex<Vec<String>>,
    /// The mode and plan each session was created with (its view starts there, as the actor's does).
    created: StdMutex<HashMap<SessionId, (PermissionMode, bool)>>,
    /// Fork: how many `freeze_incognito` calls to fail (a store without the column).
    refuse_freezes: std::sync::atomic::AtomicUsize,
}

impl WorktreeKernel {
    fn handle(&self, id: &SessionId) -> Result<Arc<TestHandle>, KernelError> {
        if let Some(handle) = self.handles.lock().unwrap().get(id) {
            return Ok(handle.clone());
        }
        let meta = self.store.meta(id).ok_or_else(|| KernelError::NotFound {
            session: id.clone(),
        })?;
        let (mode, plan) = self
            .created
            .lock()
            .unwrap()
            .get(id)
            .copied()
            .unwrap_or((PermissionMode::Default, false));
        let mut view = SessionView::new(meta, Vec::new(), selection(), mode);
        view.plan = plan;
        let handle = Arc::new(TestHandle {
            id: id.clone(),
            view: StdMutex::new(view),
            sent: self.sent.clone(),
            refuse_moves: self.refuse_moves.clone(),
            refuse_modes: self.refuse_modes.clone(),
            store: self.store.clone(),
        });
        self.handles
            .lock()
            .unwrap()
            .insert(id.clone(), handle.clone());
        Ok(handle)
    }
}

#[async_trait]
impl rust_cli_kernel_api::session_api::Kernel for WorktreeKernel {
    fn queries(&self) -> Arc<dyn StoreQueries> {
        self.store.clone()
    }

    async fn create_session(&self, request: CreateSession) -> Result<SessionId, KernelError> {
        let id = request.id.unwrap_or_else(|| SessionId::new("generated"));
        self.created
            .lock()
            .unwrap()
            .insert(id.clone(), (request.mode, request.plan));
        let meta = SessionMeta {
            id: id.clone(),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: request.workspace,
            title: String::new(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
            incognito: request.incognito,
        };
        self.store
            .create(meta)
            .await
            .map_err(|error| KernelError::Failed {
                message: error.to_string(),
            })?;
        Ok(id)
    }

    async fn create_prepared_session(
        &self,
        request: CreateSession,
    ) -> Result<SessionId, KernelError> {
        let id = self.create_session(request).await?;
        self.prepared.lock().unwrap().push(id.as_str().to_owned());
        // The kernel starts the created session: a later open finds it open.
        self.handle(&id)?;
        Ok(id)
    }

    async fn create_session_in_worktree(
        &self,
        request: CreateSession,
        worktree: EnvPath,
        branch: Option<String>,
    ) -> Result<SessionId, KernelError> {
        let id = self.create_session(request).await?;
        self.store
            .set_execution_worktree(&id, &worktree, branch.as_deref())
            .await
            .map_err(|error| KernelError::Failed {
                message: error.to_string(),
            })?;
        Ok(id)
    }

    async fn open_session(
        &self,
        session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Ok(self.handle(session)?)
    }

    async fn open_prepared_session(
        &self,
        session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        // An open session keeps its state: only a cold open is recorded.
        if !self.handles.lock().unwrap().contains_key(session) {
            self.reopened_held
                .lock()
                .unwrap()
                .push(session.as_str().to_owned());
        }
        Ok(self.handle(session)?)
    }

    async fn list_sessions(
        &self,
        filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        // node-store's listing (`directory = ?`, soft-deleted out, `order by time_updated desc, id desc`,
        // `limit ?`), for the sessions-index seed.
        let (root, limit) = (filter.workspace.root.as_str().to_owned(), filter.limit);
        let mut summaries: Vec<SessionSummary> = self
            .store
            .list(filter)
            .await
            .map_err(|error| KernelError::Failed {
                message: error.to_string(),
            })?
            .into_iter()
            .filter(|summary| {
                self.store
                    .meta(&summary.id)
                    .is_some_and(|meta| meta.workspace.root.as_str() == root)
            })
            .collect();
        summaries.sort_by(|left, right| {
            right
                .updated_at_ms
                .cmp(&left.updated_at_ms)
                .then_with(|| right.id.as_str().cmp(left.id.as_str()))
        });
        if limit > 0 {
            summaries.truncate(limit);
        }
        Ok(summaries)
    }

    async fn session_snapshot(&self, session: &SessionId) -> Result<SessionView, KernelError> {
        HandleOverride::view(self.handle(session)?.as_ref()).await
    }

    /// The row once (MemoryStore), recorded in `sent` so the order against the actor's commands shows.
    async fn freeze_incognito(
        &self,
        session: &SessionId,
        profile: rust_cli_kernel_api::incognito::IncognitoProfile,
    ) -> Result<(), KernelError> {
        let refuse = self
            .refuse_freezes
            .fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |left| left.checked_sub(1),
            )
            .is_ok();
        if refuse {
            return Err(KernelError::Unsupported {
                what: "the fork_incognito column".to_owned(),
            });
        }
        self.store.set_incognito(session, &profile).await?;
        self.sent
            .lock()
            .unwrap()
            .push(("kernel".to_owned(), "FreezeIncognito".to_owned()));
        Ok(())
    }

    async fn delete_session(&self, session: &SessionId) -> Result<(), KernelError> {
        self.deleted
            .lock()
            .unwrap()
            .push(session.as_str().to_owned());
        Ok(())
    }
}

fn server() -> (TaskScope, Arc<Server>, Arc<WorktreeKernel>) {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let kernel = Arc::new(WorktreeKernel {
        store: Arc::new(MemoryStore::default()),
        handles: StdMutex::new(HashMap::new()),
        sent: Arc::new(StdMutex::new(Vec::new())),
        deleted: StdMutex::new(Vec::new()),
        refuse_moves: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        refuse_modes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        prepared: StdMutex::new(Vec::new()),
        reopened_held: StdMutex::new(Vec::new()),
        created: StdMutex::new(HashMap::new()),
        refuse_freezes: std::sync::atomic::AtomicUsize::new(0),
    });
    let server = Arc::new(Server::new(
        context,
        kernel.clone(),
        scope.spawner(),
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    (scope, server, kernel)
}

fn envelope(id: &str, session: Option<&str>, kind: &str, payload: Value) -> Envelope {
    Envelope {
        command_id: id.to_owned(),
        client_id: "client".to_owned(),
        session_id: session.map(str::to_owned),
        base_revision: None,
        kind: kind.to_owned(),
        payload,
        input_origin: None,
    }
}

async fn create(server: &Server, id: &str, payload: Value) -> Ack {
    crate::commands::create_session(server, &envelope(id, None, "createSession", payload)).await
}

#[tokio::test]
async fn prepare_update_and_activate_run_the_session_in_the_worktree() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt-a");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );

    // Prepare: a new session listed under the parent, its marker preparing.
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "worktreePreparation": {
            "branchName": "feat/a", "targetPath": path, "attemptId": "a1"}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let session = ack.result.as_ref().unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = SessionId::new(&session);
    let live = server.bridge.get(&id).unwrap();
    assert_eq!(
        live.sink.summary()["worktreePreparation"]["status"],
        "preparing"
    );
    assert_eq!(live.sink.summary()["workspaceId"], workspace.as_str());

    // A failed attempt, then a retry under a new attempt.
    let failed = crate::worktree::update(
        &server,
        &live,
        &envelope(
            "c2",
            Some(&session),
            "updateWorktreePreparation",
            json!({"status": "failed", "failureMessage": "git failed", "expectedAttemptId": "a1"}),
        ),
        0,
    )
    .await;
    assert_eq!(failed.status, Status::Accepted, "{failed:?}");
    assert_eq!(failed.result.unwrap()["status"], "failed");
    let stale = crate::worktree::update(
        &server,
        &live,
        &envelope(
            "c3",
            Some(&session),
            "updateWorktreePreparation",
            json!({"status": "preparing", "expectedAttemptId": "a0"}),
        ),
        0,
    )
    .await;
    assert_eq!(stale.status, Status::Failed);
    assert_eq!(stale.message.as_deref(), Some(UNAVAILABLE));
    let retried = crate::worktree::update(
        &server,
        &live,
        &envelope(
            "c4",
            Some(&session),
            "updateWorktreePreparation",
            json!({"status": "preparing", "expectedAttemptId": "a1", "worktreePreparation": {
                "branchName": "feat/a", "targetPath": path, "attemptId": "a2"}}),
        ),
        0,
    )
    .await;
    assert_eq!(retried.status, Status::Accepted, "{retried:?}");
    let stored = load(&server, &id).await.unwrap().unwrap();
    assert_eq!(stored.attempt_id.as_deref(), Some("a2"));
    assert_eq!(stored.status, PrepStatus::Preparing);

    // The store has no execution columns until the activation writes them; MemoryStore always accepts.
    let activation = json!({"workspaceId": workspace, "preparedSessionId": session,
        "expectedAttemptId": "a2", "executionWorktree": {"path": path, "branchName": "feat/a"},
        "config": {"mode": "build"}});
    let ack = create(&server, "c5", activation.clone()).await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert_eq!(ack.result.unwrap()["preparedActivation"], "materialized");
    let sent = kernel.sent.lock().unwrap().clone();
    // The config comes first: the move releases SessionStart, which must see the configured session.
    let mode = sent.iter().position(|(_, name)| name == "SetMode");
    let moved = sent
        .iter()
        .position(|entry| *entry == ("c5:worktree".to_owned(), format!("SetExecutionRoot {path}")));
    assert!(mode.is_some() && mode < moved, "{sent:?}");
    let execution = kernel.store.execution_worktree(&id).await.unwrap().unwrap();
    assert_eq!(execution.path.as_str(), path);
    assert_eq!(execution.directory.as_str(), workspace);
    assert_eq!(execution.branch.as_deref(), Some("feat/a"));
    let marker = load(&server, &id).await.unwrap().unwrap();
    assert_eq!(marker.status, PrepStatus::Active);
    assert_eq!(marker.attempt_id.as_deref(), Some("a2"));

    // The facts land on the pump: the row drops the preparation and carries the worktree, still under the parent.
    let facts_set = async {
        loop {
            let row = live.sink.summary();
            if row.get("executionWorktree").is_some() {
                return row;
            }
            tokio::task::yield_now().await;
        }
    };
    let row = tokio::time::timeout(std::time::Duration::from_secs(5), facts_set)
        .await
        .unwrap();
    assert_eq!(
        row["executionWorktree"],
        json!({"path": path, "branchName": "feat/a"})
    );
    assert!(row.get("worktreePreparation").is_none());
    assert_eq!(row["workspaceId"], workspace.as_str());

    // A repeat is answered from the durable receipt: no second move.
    let ack = create(&server, "c6", activation).await;
    assert_eq!(ack.result.unwrap()["preparedActivation"], "already-active");
    assert_eq!(kernel.sent.lock().unwrap().len(), sent.len());
    // An update after the activation is refused.
    let late = crate::worktree::update(
        &server,
        &live,
        &envelope(
            "c7",
            Some(&session),
            "updateWorktreePreparation",
            json!({"status": "cancelled", "expectedAttemptId": "a2"}),
        ),
        0,
    )
    .await;
    assert_eq!(late.status, Status::Failed);
}

#[tokio::test]
async fn preparation_refuses_runtime_settings_and_activation_a_mismatch() {
    let (_scope, server, kernel) = server();
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": "/w", "config": {"mode": "build"}, "worktreePreparation": {
            "branchName": "b", "targetPath": "/w/.worktrees/b"}}),
    )
    .await;
    assert_eq!(ack.status, Status::Rejected);
    assert_eq!(ack.reason_code.as_deref(), Some("proto.invalidPayload"));

    let ack = create(
        &server,
        "c2",
        json!({"workspaceId": "/w", "worktreePreparation": {
            "branchName": "b", "targetPath": "/w/.worktrees/b"}}),
    )
    .await;
    let session = ack.result.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let ack = create(
        &server,
        "c3",
        json!({"workspaceId": "/other", "preparedSessionId": session,
            "executionWorktree": {"path": "/w/.worktrees/b"}}),
    )
    .await;
    assert_eq!(ack.status, Status::Failed);
    assert_eq!(ack.message.as_deref(), Some(MISMATCH));
    // A worktree that is not on disk is refused before the session moves.
    let ack = create(
        &server,
        "c4",
        json!({"workspaceId": "/w", "preparedSessionId": session,
            "executionWorktree": {"path": "/w/.worktrees/b"}}),
    )
    .await;
    assert_eq!(ack.status, Status::Rejected);
    assert_eq!(
        ack.message.as_deref(),
        Some("Execution worktree path does not exist or is not a directory: /w/.worktrees/b")
    );
    assert!(kernel.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_direct_route_runs_a_new_session_in_the_worktree() {
    let (_scope, server, kernel) = server();
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": "/w", "executionWorktree": {"path": "/w/.worktrees/gone"}}),
    )
    .await;
    assert_eq!(ack.status, Status::Rejected);
    assert!(kernel.store.meta(&SessionId::new("generated")).is_none());

    let worktree = tempfile::tempdir().unwrap();
    let path = worktree.path().to_str().unwrap().to_owned();
    let ack = create(
        &server,
        "c2",
        json!({"workspaceId": "/w", "sessionId": "s-direct",
            "executionWorktree": {"path": path, "branchName": "feat/d"}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let id = SessionId::new("s-direct");
    // The session is created in the worktree, so nothing has to move it afterwards.
    assert!(kernel.sent.lock().unwrap().is_empty());
    let execution = kernel.store.execution_worktree(&id).await.unwrap().unwrap();
    assert_eq!(execution.directory.as_str(), "/w");
    assert_eq!(execution.path.as_str(), path);
    let live = server.bridge.get(&id).unwrap();
    let summary = live.sink.summary();
    assert_eq!(summary["workspaceId"], "/w");
    assert_eq!(
        summary["executionWorktree"],
        json!({"path": path, "branchName": "feat/d"})
    );
}

/// B1.1 (specs/fork-rust-agent-parity.md): a managed-worktree `cwd` takes the direct execution-worktree route —
/// the same kernel create (`create_session_in_worktree`, no branch: the Host created the worktree) — and the
/// `worktreeCreation` fact is stored as the session's creation record. A `cwd` that is not a directory is
/// refused with the route's text. The marker row the record draws is tested at the projection and on a cold
/// open below (this double's handle produces no turn events).
#[tokio::test]
async fn a_managed_worktree_cwd_creates_the_session_in_the_worktree() {
    let (_scope, server, kernel) = server();
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": "/w", "sessionId": "s-mw",
            "cwd": "/w/.zcode-worktrees/gone"}),
    )
    .await;
    assert_eq!(ack.status, Status::Rejected);
    assert_eq!(
        ack.message.as_deref(),
        Some(
            "Execution worktree path does not exist or is not a directory: /w/.zcode-worktrees/gone"
        )
    );
    assert!(kernel.store.meta(&SessionId::new("s-mw")).is_none());

    let worktree = tempfile::tempdir().unwrap();
    let path = worktree.path().to_str().unwrap().to_owned();
    let creation = json!({
        "path": path, "sha": "a1b2c3d4", "ref": null, "output": "worktree added"
    });
    let ack = create(
        &server,
        "c2",
        json!({"workspaceId": "/w", "sessionId": "s-mw", "cwd": path,
            "worktreeCreation": creation}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let id = SessionId::new("s-mw");
    // The fork columns, not Node's directory override: the row keeps the workspace and names the worktree.
    let execution = kernel.store.execution_worktree(&id).await.unwrap().unwrap();
    assert_eq!(execution.directory.as_str(), "/w");
    assert_eq!(execution.path.as_str(), path);
    assert_eq!(execution.branch, None);
    let live = server.bridge.get(&id).unwrap();
    let summary = live.sink.summary();
    assert_eq!(summary["workspaceId"], "/w");
    assert_eq!(summary["executionWorktree"], json!({"path": path}));
    // The creation fact is durable (the fork-shaped storage of Node's timeline part), as the marker reads it.
    assert_eq!(
        crate::worktree::creation_fact(&server, &id).await,
        Some(json!({"path": path, "sha": "a1b2c3d4", "ref": null, "output": "worktree added"}))
    );
}

/// B1.1 (ocr): Node's `z.string().trim().min(1)` — whitespace-only is refused with the field named,
/// a null is refused (not read as absent), and a padded cwd trims before use.
#[tokio::test]
async fn an_empty_or_padded_cwd_is_refused_or_trimmed() {
    let (_scope, server, kernel) = server();
    let blank = create(
        &server,
        "c1",
        json!({"workspaceId": "/w", "sessionId": "s-blank", "cwd": "   "}),
    )
    .await;
    assert_eq!(blank.status, Status::Rejected);
    assert!(blank.message.as_deref().unwrap_or_default().contains("cwd"));
    let null_cwd = create(
        &server,
        "c2",
        json!({"workspaceId": "/w", "sessionId": "s-null", "cwd": null}),
    )
    .await;
    assert_eq!(null_cwd.status, Status::Rejected);
    assert!(kernel.store.meta(&SessionId::new("s-blank")).is_none());

    let worktree = tempfile::tempdir().unwrap();
    let padded = format!(" {} ", worktree.path().to_str().unwrap());
    let ack = create(
        &server,
        "c3",
        json!({"workspaceId": "/w", "sessionId": "s-pad", "cwd": padded}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let execution = kernel
        .store
        .execution_worktree(&SessionId::new("s-pad"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        execution.path.as_str(),
        worktree.path().to_str().unwrap(),
        "the padded cwd trims before use"
    );
}

/// B1.1 (ocr): the activation routes name their own worktree — a `cwd` riding a `preparedSessionId` is
/// refused instead of being silently dropped (its creation fact would never persist).
#[tokio::test]
async fn a_cwd_riding_a_prepared_activation_is_refused() {
    let (_scope, server, kernel) = server();
    let worktree = tempfile::tempdir().unwrap();
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": "/w", "sessionId": "s-ride",
            "preparedSessionId": "prep-1",
            "cwd": worktree.path().to_str().unwrap()}),
    )
    .await;
    assert_eq!(ack.status, Status::Rejected);
    assert_eq!(ack.reason_code.as_deref(), Some("proto.invalidPayload"));
    assert!(
        ack.message
            .as_deref()
            .unwrap_or_default()
            .contains("preparedSessionId")
    );
    assert!(kernel.store.meta(&SessionId::new("s-ride")).is_none());
}

/// B1.1: Node does not tie `worktreeCreation.path` to `cwd` (`workspaceRefWithCwd` reads only `cwd`; the record
/// is stored as sent), so a differing path is accepted and noted, not refused — the session runs in `cwd`. The
/// fork's own `executionWorktree` (the richer shape: it names a branch) wins when both ride.
#[tokio::test]
async fn a_creation_record_is_untied_and_execution_worktree_wins() {
    let (_scope, server, kernel) = server();
    let worktree = tempfile::tempdir().unwrap();
    let path = worktree.path().to_str().unwrap().to_owned();
    // A differing record path: accepted, and the execution follows cwd, as in Node.
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": "/w", "sessionId": "s-untied", "cwd": path,
            "worktreeCreation": {
                "path": "/elsewhere/other-worktree", "sha": "a1b2c3d4",
                "ref": "feature-branch", "output": "worktree added"}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let id = SessionId::new("s-untied");
    let execution = kernel.store.execution_worktree(&id).await.unwrap().unwrap();
    assert_eq!(execution.path.as_str(), path);
    assert_eq!(
        crate::worktree::creation_fact(&server, &id).await,
        Some(
            json!({"path": "/elsewhere/other-worktree", "sha": "a1b2c3d4",
            "ref": "feature-branch", "output": "worktree added"})
        )
    );
    // The fork's executionWorktree wins over cwd when both ride (Node never combines the two shapes).
    let ack = create(
        &server,
        "c2",
        json!({"workspaceId": "/w", "sessionId": "s-both", "cwd": "/w/.zcode-worktrees/one",
            "executionWorktree": {"path": path, "branchName": "feat/d"}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let id = SessionId::new("s-both");
    let execution = kernel.store.execution_worktree(&id).await.unwrap().unwrap();
    assert_eq!(execution.path.as_str(), path);
    assert_eq!(execution.branch.as_deref(), Some("feat/d"));
    assert_eq!(crate::worktree::creation_fact(&server, &id).await, None);
}

/// B1.1: a cold open of a managed-worktree session draws the `worktreeCreated` marker from the stored record,
/// like Node's cold hydration of the timeline part. No first input yet: the marker waits for a turn, as Node's
/// pending marker does.
#[tokio::test]
async fn a_cold_open_draws_the_stored_creation_marker() {
    let (_scope, server, kernel) = server();
    let id = SessionId::new("s-cold");
    rust_cli_kernel_api::session_api::Kernel::create_session(
        kernel.as_ref(),
        CreateSession {
            id: Some(id.clone()),
            workspace: rust_cli_kernel_api::env::WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
            incognito: None,
        },
    )
    .await
    .unwrap();
    let worktree = tempfile::tempdir().unwrap();
    let path = worktree.path().to_str().unwrap().to_owned();
    kernel
        .store
        .set_execution_worktree(&id, &EnvPath::new(&path), None)
        .await
        .unwrap();
    crate::worktree::record_creation(
        &server,
        &id,
        &crate::worktree::Creation {
            path: path.clone(),
            sha: "a1b2c3d4".to_owned(),
            start: None,
            output: "worktree added".to_owned(),
        },
    )
    .await
    .unwrap();
    // The turn that the stored history carries (a user message) draws the marker on the cold open.
    kernel
        .handle(&id)
        .unwrap()
        .view
        .lock()
        .unwrap()
        .messages
        .push(rust_cli_kernel_api::message::Message::User(
            rust_cli_kernel_api::message::UserMessage {
                stall_execution: None,
                workflow_meta: None,
                epilogue_start: None,
                intent: None,
                id: rust_cli_kernel_api::ids::MessageId::new("m1"),
                content: vec![rust_cli_kernel_api::message::ContentBlock::Text {
                    text: "hello".to_owned(),
                }],
                origin: rust_cli_kernel_api::message::UserOrigin::Human,
            },
        ));
    let live = server.live(&id).await.unwrap();
    let snapshot = live.sink.snapshot();
    let rows = snapshot["rows"]["window"].as_array().unwrap();
    let marker = rows
        .iter()
        .find(|row| row["marker"]["type"] == "worktreeCreated")
        .expect("the stored creation fact draws its marker");
    assert_eq!(marker["marker"]["path"], json!(path));
}

/// B1.3: one finished turn in session `s1` — committed to the store (the fork copies it) and in the live
/// view (the projection offers the reply's `canFork` row). `key` overrides the session's listed workspace key
/// (a remote session's `remote:` identity).
async fn forkable(
    server: &Server,
    kernel: &Arc<WorktreeKernel>,
    key: Option<&str>,
) -> (u64, String) {
    let id = SessionId::new("s1");
    rust_cli_kernel_api::session_api::Kernel::create_session(
        kernel.as_ref(),
        CreateSession {
            id: Some(id.clone()),
            workspace: rust_cli_kernel_api::env::WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
            incognito: None,
        },
    )
    .await
    .unwrap();
    if let Some(key) = key {
        kernel.store.set_workspace_key(&id, key);
    }
    let messages = vec![
        rust_cli_kernel_api::message::Message::User(rust_cli_kernel_api::message::UserMessage {
            stall_execution: None,
            workflow_meta: None,
            epilogue_start: None,
            intent: None,
            id: MessageId::new("msg_u1"),
            content: vec![rust_cli_kernel_api::message::ContentBlock::Text {
                text: "hello".to_owned(),
            }],
            origin: rust_cli_kernel_api::message::UserOrigin::Human,
        }),
        rust_cli_kernel_api::message::Message::Assistant(
            rust_cli_kernel_api::message::AssistantMessage {
                id: MessageId::new("msg_a1"),
                content: vec![rust_cli_kernel_api::message::ContentBlock::Text {
                    text: "answer".to_owned(),
                }],
                model: "m".to_owned(),
                stop_reason: Some(rust_cli_kernel_api::message::StopReason::EndTurn),
                usage: None,
            },
        ),
    ];
    let facts = messages
        .iter()
        .cloned()
        .map(|message| Fact::MessageAppended { message })
        .collect();
    SessionStore::commit(
        kernel.store.as_ref(),
        &id,
        FactBatch {
            owner_epoch: OwnerEpoch::LOCAL,
            command: None,
            facts,
            turn: None,
        },
    )
    .await
    .unwrap();
    kernel.handle(&id).unwrap().view.lock().unwrap().messages = messages;
    let live = server.live(&id).await.unwrap();
    let reply = live.sink.snapshot()["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "assistantText" && row["actions"]["canFork"] == json!(true))
        .expect("the finished turn offers its reply's fork action")
        .clone();
    (
        reply["rowId"].as_u64().unwrap(),
        reply["entityId"].as_str().unwrap().to_owned(),
    )
}

/// A `forkAssistant` envelope through the command entry, so the inbound schema validates it too.
async fn fork_command(server: &Server, id: &str, target: serde_json::Value, extra: Value) -> Value {
    let mut payload = json!({"target": target});
    payload
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    crate::commands::command(
        server,
        json!({
            "commandId": id, "clientId": "client", "sessionId": "s1", "type": "forkAssistant",
            "issuedAt": 1, "baseRevision": 0, "baseLogEpoch": "e", "payload": payload,
        }),
    )
    .await
    .unwrap()
}

/// B1.3 (specs/fork-rust-agent-parity.md): `forkAssistant.targetCwd` forks the child into the Host-created
/// managed worktree. The pre-allocated `childSessionId` names the child (Node's `forkedSessionId`), the fork
/// columns — not Node's directory override — carry the root while the row keeps the parent workspace, the
/// creation record stores on the child (the fork-shaped `worktree_creation` fact), and the opened child lists
/// under the parent with its execution worktree, like B1.1's create.
#[tokio::test]
async fn a_managed_worktree_fork_lands_the_child_in_the_worktree() {
    let (_scope, server, kernel) = server();
    let (row, entity) = forkable(&server, &kernel, None).await;
    let worktree = tempfile::tempdir().unwrap();
    let path = worktree.path().to_str().unwrap().to_owned();
    let creation =
        json!({"path": path, "sha": "a1b2c3d4", "ref": null, "output": "worktree added"});
    let ack = fork_command(
        &server,
        "c-fork",
        json!({"rowId": row, "entityId": entity}),
        json!({"targetCwd": {"cwd": path, "childSessionId": "child-1",
            "worktreeCreation": creation}}),
    )
    .await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    assert_eq!(
        ack["result"],
        json!({"type": "forkAssistant", "sessionId": "child-1"})
    );
    // The kernel command carried the target: the Host's child id and the worktree root.
    assert_eq!(
        kernel
            .sent
            .lock()
            .unwrap()
            .last()
            .map(|(_, name)| name.as_str()),
        Some(format!("ForkFromAssistant msg_a1 child=child-1 root={path}").as_str())
    );
    // The fork columns, not Node's directory override: the child's row keeps the parent workspace.
    let child = SessionId::new("child-1");
    let execution = kernel
        .store
        .execution_worktree(&child)
        .await
        .unwrap()
        .expect("the child carries the execution worktree");
    assert_eq!(execution.directory.as_str(), "/w");
    assert_eq!(execution.path.as_str(), path);
    assert_eq!(execution.branch, None);
    // The creation fact is the child's record (the marker row reads it, as in B1.1).
    assert_eq!(
        crate::worktree::creation_fact(&server, &child).await,
        Some(json!({"path": path, "sha": "a1b2c3d4", "ref": null,
            "output": "worktree added"}))
    );
    // The handler opened the child: listed under the parent, running in the worktree.
    let live = server
        .bridge
        .get(&child)
        .expect("the forked child is opened for the App");
    let summary = live.sink.summary();
    assert_eq!(summary["workspaceId"], "/w");
    assert_eq!(summary["executionWorktree"], json!({"path": path}));
}

/// B1.3: Node runs `workspaceRefWithCwd` before anything persists (`v4-bridge.ts`
/// `forkStableConversation`), so a `targetCwd` on a remote workspace is structured refusal
/// (`guard.worktreeCwdLocalOnly`, B1.1's guard shape) and nothing is forked. A malformed `remote:` key is
/// refused at resolution, as in B1.1.
#[tokio::test]
async fn a_fork_target_cwd_on_a_remote_workspace_refuses_like_node() {
    let (_scope, server, kernel) = server();
    let (row, entity) = forkable(&server, &kernel, Some("remote:docker:box:/w")).await;
    let worktree = tempfile::tempdir().unwrap();
    let path = worktree.path().to_str().unwrap().to_owned();
    let creation = json!({"path": path, "sha": "a1b2c3d4", "ref": null, "output": ""});
    let ack = fork_command(
        &server,
        "c-fork",
        json!({"rowId": row, "entityId": entity}),
        json!({"targetCwd": {"cwd": path, "childSessionId": "child-1",
            "worktreeCreation": creation}}),
    )
    .await;
    assert_eq!(ack["status"], "failed", "{ack}");
    assert_eq!(ack["reasonCode"], "guard.worktreeCwdLocalOnly");
    assert_eq!(
        ack["message"],
        "session cwd override only supports local workspaces: remote:docker:box:/w"
    );
    assert!(kernel.store.meta(&SessionId::new("child-1")).is_none());
}

/// B1.3: the route's not-a-directory pre-check refuses before anything is forked (B1.1's
/// `check_directory` text), leaving no child behind.
#[tokio::test]
async fn a_fork_target_cwd_without_a_directory_refuses_before_forking() {
    let (_scope, server, kernel) = server();
    let (row, entity) = forkable(&server, &kernel, None).await;
    let creation =
        json!({"path": "/w/.zcode-worktrees/gone", "sha": "a1b2c3d4", "ref": null, "output": ""});
    let ack = fork_command(
        &server,
        "c-fork",
        json!({"rowId": row, "entityId": entity}),
        json!({"targetCwd": {"cwd": "/w/.zcode-worktrees/gone", "childSessionId": "child-1",
            "worktreeCreation": creation}}),
    )
    .await;
    assert_eq!(ack["status"], "rejected", "{ack}");
    assert_eq!(ack["reasonCode"], "proto.invalidPayload");
    assert_eq!(
        ack["message"],
        "Execution worktree path does not exist or is not a directory: /w/.zcode-worktrees/gone"
    );
    assert!(kernel.store.meta(&SessionId::new("child-1")).is_none());
}

/// A stored worktree session (as the Node agent leaves one) whose directory was deleted: the cold row and the
/// opened session report it missing and the session stays listed under the parent. That the root stays the
/// worktree is tested on a real cold open (cli `tests/worktree_resume.rs`).
#[tokio::test]
async fn a_stored_worktree_that_is_gone_is_reported_missing() {
    let (_scope, server, kernel) = server();
    let id = SessionId::new("s-stored");
    rust_cli_kernel_api::session_api::Kernel::create_session(
        kernel.as_ref(),
        CreateSession {
            id: Some(id.clone()),
            workspace: rust_cli_kernel_api::env::WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
            incognito: None,
        },
    )
    .await
    .unwrap();
    let worktree = tempfile::tempdir().unwrap();
    let path = worktree.path().to_str().unwrap().to_owned();
    kernel
        .store
        .set_execution_worktree(&id, &EnvPath::new(&path), Some("feat/s"))
        .await
        .unwrap();
    drop(worktree);

    let mut row = json!({"title": "Stored"});
    crate::worktree::decorate_cold_row(&server, &id, &mut row).await;
    assert_eq!(
        row["executionWorktree"],
        json!({"path": path, "branchName": "feat/s"})
    );
    assert_eq!(row["executionWorktreeMissing"], true);

    let live = server.live(&id).await.unwrap();
    let summary = live.sink.summary();
    assert_eq!(summary["workspaceId"], "/w");
    assert_eq!(summary["executionWorktreeMissing"], true);
}

/// A helper session of a worktree session opens in its worktree while it exists, and in its workspace once it is gone
/// (Node create-app.ts:200-208; specs/fork-rust-node-helper.md F3 "Session open and close").
#[tokio::test]
async fn a_helper_session_runs_in_the_worktree_only_while_it_exists() {
    use crate::fork::node_helper::HelperRequests;
    let (_scope, server, kernel) = server();
    let worktree = tempfile::tempdir().unwrap();
    let path = worktree.path().to_str().unwrap().to_owned();
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": "/w", "sessionId": "s-wt", "executionWorktree": {"path": path}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let ack = create(
        &server,
        "c2",
        json!({"workspaceId": "/w", "sessionId": "s-plain"}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert_eq!(
        server.session_execution_directory("s-wt").await.as_deref(),
        Some(path.as_str())
    );
    assert_eq!(server.session_execution_directory("s-plain").await, None);
    assert!(
        kernel
            .store
            .execution_worktree(&SessionId::new("s-wt"))
            .await
            .unwrap()
            .is_some()
    );
    drop(worktree);
    assert_eq!(server.session_execution_directory("s-wt").await, None);
}

async fn run(server: &Server, params: Value) -> Value {
    crate::commands::command(server, params).await.unwrap()
}

/// The worktree commands through the real command path (`commands::command`, the inbound schema first): the schema
/// knows `updateWorktreePreparation` and the createSession worktree fields, and the superRefine rules are mirrored.
#[tokio::test]
async fn worktree_commands_pass_the_inbound_schema() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let workspace = parent.path().to_str().unwrap().to_owned();
    let target = parent.path().join("wt").to_str().unwrap().to_owned();
    let ack = run(
        &server,
        json!({"commandId": "p1", "clientId": "k", "type": "createSession", "issuedAt": 1,
            "payload": {"workspaceId": workspace, "worktreePreparation": {
                "branchName": "feat/a", "targetPath": target, "attemptId": "a1"}}}),
    )
    .await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    let session = ack["result"]["sessionId"].as_str().unwrap().to_owned();
    // SessionStart waits for the activation (the kernel's prepared create).
    assert_eq!(
        *kernel.prepared.lock().unwrap(),
        std::slice::from_ref(&session)
    );
    let update = |id: &str, payload: Value| {
        json!({"commandId": id, "clientId": "k", "sessionId": session,
            "type": "updateWorktreePreparation", "issuedAt": 1, "payload": payload})
    };

    let ack = run(
        &server,
        update(
            "u1",
            json!({"status": "failed", "failureMessage": "git failed", "expectedAttemptId": "a1"}),
        ),
    )
    .await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    assert_eq!(ack["result"]["status"], "failed");
    let marker = load(&server, &SessionId::new(&session))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.status, PrepStatus::Failed);
    assert_eq!(marker.failure_message.as_deref(), Some("git failed"));

    let ack = run(
        &server,
        update(
            "u2",
            json!({"status": "cancelled", "expectedAttemptId": "a1"}),
        ),
    )
    .await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    let marker = load(&server, &SessionId::new(&session))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.status, PrepStatus::Cancelled);

    // The schema: `active` is not an update status.
    let ack = run(&server, update("u3", json!({"status": "active"}))).await;
    assert_eq!(ack["status"], "rejected", "{ack}");
    assert_eq!(ack["reasonCode"], "proto.invalidPayload");

    // The superRefine mirror: a submission activation needs its prepared session.
    let ack = run(
        &server,
        json!({"commandId": "p2", "clientId": "k", "type": "createSession", "issuedAt": 1,
            "payload": {"workspaceId": workspace, "expectedSubmissionId": "sub"}}),
    )
    .await;
    assert_eq!(ack["status"], "rejected", "{ack}");
    assert!(
        ack["message"]
            .as_str()
            .unwrap()
            .starts_with("/payload/expectedSubmissionId"),
        "{ack}"
    );

    // A submission activation that names a worktree is refused like Node, never activated without it.
    let ack = run(
        &server,
        json!({"commandId": "p3", "clientId": "k", "type": "createSession", "issuedAt": 1,
            "payload": {"workspaceId": workspace, "preparedSessionId": session,
                "expectedSubmissionId": "sub", "executionWorktree": {"path": target}}}),
    )
    .await;
    assert_eq!(ack["status"], "rejected", "{ack}");
    assert_eq!(
        ack["message"],
        "Prepared submission does not match the requested workspace or submission"
    );
    assert!(kernel.sent.lock().unwrap().is_empty());
}

/// Node `runActivation`: the move, the draft's config, then `firstInput` under the activation's command id; the
/// result carries the input. A SessionStart message already in the history is not the client's input.
#[tokio::test]
async fn activation_admits_the_first_input_in_the_worktree() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "worktreePreparation": {
            "branchName": "feat/a", "targetPath": path, "attemptId": "a1"}}),
    )
    .await;
    let session = ack.result.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = SessionId::new(&session);
    // A hook message (no command) in the history, as a SessionStart hook on a cold open leaves one.
    kernel
        .handle(&id)
        .unwrap()
        .view
        .lock()
        .unwrap()
        .messages
        .push(rust_cli_kernel_api::message::Message::User(
            rust_cli_kernel_api::message::UserMessage {
                stall_execution: None,
                workflow_meta: None,
                epilogue_start: None,
                intent: None,
                id: rust_cli_kernel_api::ids::MessageId::new("m-hook"),
                content: vec![rust_cli_kernel_api::message::ContentBlock::Text {
                    text: "hook context".to_owned(),
                }],
                origin: rust_cli_kernel_api::message::UserOrigin::Meta {
                    source: "hook".to_owned(),
                },
            },
        ));

    let ack = create(
        &server,
        "c2",
        json!({"workspaceId": workspace, "preparedSessionId": session, "expectedAttemptId": "a1",
            "executionWorktree": {"path": path, "branchName": "feat/a"},
            "config": {"mode": "build"}, "firstInput": {"text": "hello", "planEnabled": true}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let result = ack.result.unwrap();
    assert_eq!(result["preparedActivation"], "materialized");
    assert_eq!(
        result["input"],
        json!({"delivery": "startNow", "inputId": "c2"})
    );
    let sent: Vec<String> = kernel
        .sent
        .lock()
        .unwrap()
        .iter()
        .map(|(_, name)| name.clone())
        .collect();
    // Node's order as SessionStart sees it: the config, the move (which releases SessionStart), the first input.
    let mode = sent.iter().position(|name| name == "SetMode").unwrap();
    let moved = sent
        .iter()
        .position(|name| *name == format!("SetExecutionRoot {path}"))
        .unwrap();
    let input = sent
        .iter()
        .position(|name| name.starts_with("Submit hello"))
        .unwrap();
    assert!(mode < moved && moved < input, "{sent:?}");
    // The input's own plan switch rides with it (Node `resolveSubmittedExecutionState`), not the defaults.
    assert!(sent[input].ends_with("plan=true"), "{sent:?}");
}

/// A refused move stores nothing, so a retry into another worktree leaves the actor and the stored fact together.
#[tokio::test]
async fn a_refused_move_stores_nothing_and_a_retry_elsewhere_wins() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let (a, b) = (parent.path().join("wt-a"), parent.path().join("wt-b"));
    rust_cli_fs::create_dir_all(&a).await.unwrap();
    rust_cli_fs::create_dir_all(&b).await.unwrap();
    let workspace = parent.path().to_str().unwrap().to_owned();
    let (a, b) = (
        a.to_str().unwrap().to_owned(),
        b.to_str().unwrap().to_owned(),
    );
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "worktreePreparation": {
            "branchName": "feat/a", "targetPath": a, "attemptId": "a1"}}),
    )
    .await;
    let session = ack.result.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = SessionId::new(&session);

    kernel
        .refuse_moves
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let ack = create(
        &server,
        "c2",
        json!({"workspaceId": workspace, "preparedSessionId": session, "expectedAttemptId": "a1",
            "executionWorktree": {"path": a}}),
    )
    .await;
    assert_eq!(ack.status, Status::Failed, "{ack:?}");
    assert!(
        kernel
            .store
            .execution_worktree(&id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        load(&server, &id).await.unwrap().unwrap().status,
        PrepStatus::Preparing
    );

    // The client prepares again elsewhere, then activates there.
    let live = server.bridge.get(&id).unwrap();
    let retried = crate::worktree::update(
        &server,
        &live,
        &envelope(
            "c3",
            Some(&session),
            "updateWorktreePreparation",
            json!({"status": "preparing", "expectedAttemptId": "a1", "worktreePreparation": {
                "branchName": "feat/b", "targetPath": b, "attemptId": "a2"}}),
        ),
        0,
    )
    .await;
    assert_eq!(retried.status, Status::Accepted, "{retried:?}");
    let ack = create(
        &server,
        "c4",
        json!({"workspaceId": workspace, "preparedSessionId": session, "expectedAttemptId": "a2",
            "executionWorktree": {"path": b}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let stored = kernel.store.execution_worktree(&id).await.unwrap().unwrap();
    assert_eq!(stored.path.as_str(), b);
    let view = kernel.handle(&id).unwrap().view.lock().unwrap().clone();
    assert_eq!(view.meta.workspace.root.as_str(), b);
}

/// A prepared session reopened cold before its activation (an agent restart) opens through
/// `open_prepared_session`, so SessionStart stays held and never runs in the parent checkout. A session without a
/// marker reopens the ordinary way.
#[tokio::test]
async fn a_prepared_session_reopened_cold_keeps_session_start_held() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt-a");
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "worktreePreparation": {
            "branchName": "feat/a", "targetPath": path, "attemptId": "a1"}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let id = SessionId::new(ack.result.as_ref().unwrap()["sessionId"].as_str().unwrap());
    // The restart: the projection and the kernel's actor are gone, the marker stays.
    server.bridge.close(&id);
    kernel.handles.lock().unwrap().clear();
    server.live(&id).await.unwrap();
    assert_eq!(*kernel.reopened_held.lock().unwrap(), [id.as_str()]);

    // An ordinary session reopens the ordinary way.
    let plain = create(&server, "c2", json!({"workspaceId": workspace})).await;
    let plain = SessionId::new(
        plain.result.as_ref().unwrap()["sessionId"]
            .as_str()
            .unwrap(),
    );
    server.bridge.close(&plain);
    kernel.handles.lock().unwrap().clear();
    server.live(&plain).await.unwrap();
    assert_eq!(*kernel.reopened_held.lock().unwrap(), [id.as_str()]);
}

/// W1 (specs/fork-rust-workflow-engine.md 9.2): the direct createSession route records the gate that its
/// `dynamicWorkflowEnabled` / `dynamicWorkflowMode` fields resolve to, and a create without them records a closed gate.
#[tokio::test]
async fn create_session_records_the_dynamic_workflow_gate() {
    use rust_cli_kernel_api::dynamic_workflow::DynamicWorkflowGate;

    let (_scope, server, _kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let workspace = parent.path().to_str().unwrap().to_owned();

    let ack = create(
        &server,
        "d1",
        json!({"workspaceId": workspace, "dynamicWorkflowEnabled": true, "dynamicWorkflowMode": "onDemand"}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let on_demand = SessionId::new(ack.result.as_ref().unwrap()["sessionId"].as_str().unwrap());
    assert_eq!(
        server.dynamic_workflow_gate(&on_demand),
        Some(DynamicWorkflowGate {
            enabled: true,
            tools_on_demand: true,
        })
    );

    let ack = create(&server, "d2", json!({"workspaceId": workspace})).await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let closed = SessionId::new(ack.result.as_ref().unwrap()["sessionId"].as_str().unwrap());
    assert_eq!(
        server.dynamic_workflow_gate(&closed),
        Some(DynamicWorkflowGate {
            enabled: false,
            tools_on_demand: false,
        })
    );
}

/// The column write fails after the move: the actor already runs in the worktree, the row stays listed under the
/// parent. A retry names the parent `workspaceId` and is matched against the row, not against the actor's root.
#[tokio::test]
async fn a_failed_column_write_after_the_move_keeps_the_parent_identity() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt-a");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "worktreePreparation": {
            "branchName": "feat/a", "targetPath": path, "attemptId": "a1"}}),
    )
    .await;
    let session = ack.result.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = SessionId::new(&session);
    let activation = json!({"workspaceId": workspace, "preparedSessionId": session,
        "expectedAttemptId": "a1", "executionWorktree": {"path": path}});

    kernel.store.fail_next_execution_worktree();
    let ack = create(&server, "c2", activation.clone()).await;
    assert_eq!(ack.status, Status::Failed, "{ack:?}");
    let view = kernel.handle(&id).unwrap().view.lock().unwrap().clone();
    assert_eq!(view.meta.workspace.root.as_str(), path);
    assert!(
        kernel
            .store
            .execution_worktree(&id)
            .await
            .unwrap()
            .is_none()
    );

    let ack = create(&server, "c3", activation).await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert_eq!(ack.result.unwrap()["preparedActivation"], "materialized");
    let stored = kernel.store.execution_worktree(&id).await.unwrap().unwrap();
    assert_eq!(stored.path.as_str(), path);
    assert_eq!(stored.directory.as_str(), workspace);
}

/// Fail closed like Node before the activation: a prepared session has no Node runtime record, so `sendText` is
/// refused with Node's ack (`failed`, `fault.command.executionFailed`, `v4 command session not found: <id>`) and no
/// turn runs at the parent. After the activation the same text is accepted. `deleteSession` passes before the
/// activation, as Node lets a prepared session through `hasPreparedSession`.
#[tokio::test]
async fn input_before_the_activation_is_refused_like_node() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let prepare = |id: &str| {
        json!({"commandId": id, "clientId": "k", "sessionId": null, "type": "createSession", "issuedAt": 1,
            "payload": {"workspaceId": workspace, "worktreePreparation": {
                "branchName": "feat/a", "targetPath": path, "attemptId": "a1"}}})
    };
    let ack = run(&server, prepare("p1")).await;
    let session = ack["result"]["sessionId"].as_str().unwrap().to_owned();
    let send = |id: &str| {
        json!({"commandId": id, "clientId": "k", "sessionId": session, "type": "sendText",
            "issuedAt": 1, "payload": {"text": "hello"}})
    };

    let ack = run(&server, send("s1")).await;
    assert_eq!(ack["status"], "failed", "{ack}");
    assert_eq!(ack["reasonCode"], "fault.command.executionFailed", "{ack}");
    assert_eq!(
        ack["message"],
        format!("v4 command session not found: {session}")
    );
    assert!(
        !kernel
            .sent
            .lock()
            .unwrap()
            .iter()
            .any(|(_, name)| name.starts_with("Submit")),
        "{:?}",
        kernel.sent.lock().unwrap()
    );

    let ack = create(
        &server,
        "c2",
        json!({"workspaceId": workspace, "preparedSessionId": session, "expectedAttemptId": "a1",
            "executionWorktree": {"path": path}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let ack = run(&server, send("s2")).await;
    assert_eq!(ack["status"], "accepted", "{ack}");

    // deleteSession passes before the activation.
    let ack = run(&server, prepare("p2")).await;
    let other = ack["result"]["sessionId"].as_str().unwrap().to_owned();
    let ack = run(
        &server,
        json!({"commandId": "d1", "clientId": "k", "sessionId": other, "type": "deleteSession",
            "issuedAt": 1, "payload": {}}),
    )
    .await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    assert_eq!(*kernel.deleted.lock().unwrap(), [other]);
}

/// Fail closed on a cold open: a marker that cannot be read fails the open instead of opening the session like an
/// ordinary one (SessionStart would run in the parent checkout). The kernel never opens the session; the next open,
/// with the marker readable, holds SessionStart as before.
#[tokio::test]
async fn a_marker_read_failure_fails_the_cold_open() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        parent.path().join("wt-a").to_str().unwrap().to_owned(),
    );
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "worktreePreparation": {
            "branchName": "feat/a", "targetPath": path, "attemptId": "a1"}}),
    )
    .await;
    let id = SessionId::new(ack.result.as_ref().unwrap()["sessionId"].as_str().unwrap());
    server.bridge.close(&id);
    kernel.handles.lock().unwrap().clear();

    kernel.store.fail_next_records();
    assert!(server.live(&id).await.is_err());
    assert!(!kernel.handles.lock().unwrap().contains_key(&id));
    assert!(kernel.reopened_held.lock().unwrap().is_empty());

    server.live(&id).await.unwrap();
    assert_eq!(*kernel.reopened_held.lock().unwrap(), [id.as_str()]);
}

/// The first input was admitted, then the process stopped before the marker turned active. Reopened cold, the
/// session is in its stored worktree with SessionStart held; the retried activation still sends the move (which
/// releases the start), never a second input, and completes the marker.
#[tokio::test]
async fn a_retry_after_the_admitted_input_still_releases_the_start() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt-a");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "worktreePreparation": {
            "branchName": "feat/a", "targetPath": path, "attemptId": "a1"}}),
    )
    .await;
    let session = ack.result.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = SessionId::new(&session);
    // The state an earlier attempt left: the worktree stored, the first input admitted, the marker still preparing.
    kernel
        .store
        .set_execution_worktree(&id, &EnvPath::new(&path), Some("feat/a"))
        .await
        .unwrap();
    server.bridge.close(&id);
    kernel.handles.lock().unwrap().clear();
    {
        let handle = kernel.handle(&id).unwrap();
        let mut view = handle.view.lock().unwrap();
        view.meta.workspace.root = EnvPath::new(&path);
        view.commands.insert(
            rust_cli_kernel_api::ids::MessageId::new("m-first"),
            rust_cli_kernel_api::ids::CommandId::new("c2"),
        );
    }
    kernel.sent.lock().unwrap().clear();

    let ack = create(
        &server,
        "c3",
        json!({"workspaceId": workspace, "preparedSessionId": session, "expectedAttemptId": "a1",
            "executionWorktree": {"path": path, "branchName": "feat/a"},
            "firstInput": {"text": "hello"}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert_eq!(ack.result.unwrap()["preparedActivation"], "input-admitted");
    let sent: Vec<String> = kernel
        .sent
        .lock()
        .unwrap()
        .iter()
        .map(|(_, name)| name.clone())
        .collect();
    assert_eq!(sent, [format!("SetExecutionRoot {path}")]);
    let marker = crate::worktree::load(&server, &id).await.unwrap().unwrap();
    assert_eq!(marker.status, PrepStatus::Active);
}

/// Node `resolveExecutionState`: the legacy `mode: "plan"` keeps the session's mode and an explicit
/// `planEnabled: false` wins, for the first input of an ordinary createSession and of an activation alike.
#[tokio::test]
async fn a_legacy_plan_first_input_keeps_the_mode_and_the_plan_switch() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt-a");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let first = json!({"text": "hello", "mode": "plan", "planEnabled": false});
    let submitted = |kernel: &WorktreeKernel| -> Vec<String> {
        kernel
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, name)| name.starts_with("Submit hello"))
            .map(|(_, name)| name.clone())
            .collect()
    };

    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "config": {"mode": "edit"}, "firstInput": first}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert_eq!(
        submitted(&kernel),
        ["Submit hello mode=AcceptEdits plan=false"]
    );

    kernel.sent.lock().unwrap().clear();
    let ack = create(
        &server,
        "c2",
        json!({"workspaceId": workspace, "worktreePreparation": {
            "branchName": "feat/a", "targetPath": path, "attemptId": "a1"}}),
    )
    .await;
    let session = ack.result.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let ack = create(
        &server,
        "c3",
        json!({"workspaceId": workspace, "preparedSessionId": session, "expectedAttemptId": "a1",
            "executionWorktree": {"path": path}, "config": {"mode": "edit"}, "firstInput": first}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert_eq!(
        submitted(&kernel),
        ["Submit hello mode=AcceptEdits plan=false"]
    );
}

/// Node `runActivation` + `applyRequestedSessionConfig`: the draft's config reaches the session before the move that
/// releases SessionStart (Node runs SessionStart in the first turn, after the config). Without a model in the config
/// the first input's model is the session's, as an ordinary createSession chooses it (Node makes the first turn's
/// model the session's), and `followupMode: guide` reaches the open projection and the server's table.
#[tokio::test]
async fn activation_applies_the_draft_before_session_start() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt-a");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "worktreePreparation": {
            "branchName": "feat/a", "targetPath": path, "attemptId": "a1"}}),
    )
    .await;
    let session = ack.result.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = SessionId::new(&session);
    let ack = create(
        &server,
        "c2",
        json!({"workspaceId": workspace, "preparedSessionId": session, "expectedAttemptId": "a1",
            "executionWorktree": {"path": path}, "config": {"followupMode": "guide"},
            "firstInput": {"text": "hello", "modelSelection": {"providerId": "other", "modelId": "m2"}}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let sent: Vec<String> = kernel
        .sent
        .lock()
        .unwrap()
        .iter()
        .map(|(_, name)| name.clone())
        .collect();
    let model = sent.iter().position(|name| name == "SetModel m2");
    let moved = sent
        .iter()
        .position(|name| *name == format!("SetExecutionRoot {path}"));
    let input = sent
        .iter()
        .position(|name| name.starts_with("Submit hello") && name.ends_with("model=m2"));
    assert!(
        model.is_some() && model < moved && moved < input,
        "{sent:?}"
    );
    let view = kernel.handle(&id).unwrap().view.lock().unwrap().clone();
    assert_eq!(view.selection.model, "m2");

    assert_eq!(
        server.followups.lock().unwrap().get(&id).copied(),
        Some(crate::projection::state::Followup::Guide)
    );
    let live = server.live(&id).await.unwrap();
    let guided = async {
        while live.sink.followup() != crate::projection::state::Followup::Guide {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), guided)
        .await
        .unwrap();
}

/// Node rethrows a config failure when `guarded` was asked for (`session-mgmt.ts` `runActivation`): a refused guarded
/// mode fails the activation before the move, so SessionStart stays held, no input is admitted with the previous
/// permission mode, and the preparation stays retryable.
#[tokio::test]
async fn a_refused_guarded_mode_fails_the_activation_before_the_move() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt-a");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "worktreePreparation": {
            "branchName": "feat/a", "targetPath": path, "attemptId": "a1"}}),
    )
    .await;
    let session = ack.result.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = SessionId::new(&session);
    let activation = json!({"workspaceId": workspace, "preparedSessionId": session, "expectedAttemptId": "a1",
        "executionWorktree": {"path": path}, "config": {"mode": "guarded"}, "firstInput": {"text": "hello"}});

    kernel
        .refuse_modes
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let ack = create(&server, "c2", activation.clone()).await;
    assert_eq!(ack.status, Status::Failed, "{ack:?}");
    let sent: Vec<String> = kernel
        .sent
        .lock()
        .unwrap()
        .iter()
        .map(|(_, name)| name.clone())
        .collect();
    assert!(
        !sent
            .iter()
            .any(|name| name.starts_with("SetExecutionRoot") || name.starts_with("Submit")),
        "{sent:?}"
    );
    let marker = load(&server, &id).await.unwrap().unwrap();
    assert_eq!(marker.status, PrepStatus::Preparing);

    let ack = create(&server, "c3", activation).await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert_eq!(ack.result.unwrap()["preparedActivation"], "materialized");
    let sent = kernel.sent.lock().unwrap().clone();
    assert!(
        sent.iter()
            .any(|(_, name)| name.starts_with("Submit hello")),
        "{sent:?}"
    );
    let view = kernel.handle(&id).unwrap().view.lock().unwrap().clone();
    assert_eq!(view.mode, PermissionMode::Guarded);
}

/// The activation materialized the session but its active marker failed to store. Node has the runtime record then,
/// so commands pass; zcode-rs lets them through the gate and heals the marker, unlike a session never activated.
#[tokio::test]
async fn a_materialized_session_whose_receipt_failed_still_takes_commands() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "worktreePreparation": {
            "branchName": "feat/a", "targetPath": path, "attemptId": "a1"}}),
    )
    .await;
    let session = ack.result.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = SessionId::new(&session);
    let activation = json!({"workspaceId": workspace, "preparedSessionId": session, "expectedAttemptId": "a1",
        "executionWorktree": {"path": path}});
    // Fork: a first attempt (its move refused) freezes the incognito choice in memory, so the failure below hits the
    // active marker, not that freeze.
    kernel
        .refuse_moves
        .store(1, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        create(&server, "c1b", activation).await.status,
        Status::Failed
    );

    kernel.store.fail_next_put_record(KIND);
    let ack = create(
        &server,
        "c2",
        json!({"workspaceId": workspace, "preparedSessionId": session, "expectedAttemptId": "a1",
            "executionWorktree": {"path": path}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert_eq!(
        load(&server, &id).await.unwrap().unwrap().status,
        PrepStatus::Preparing
    );

    let ack = run(
        &server,
        json!({"commandId": "s1", "clientId": "k", "sessionId": session, "type": "sendText",
            "issuedAt": 1, "payload": {"text": "hello"}}),
    )
    .await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    assert_eq!(
        load(&server, &id).await.unwrap().unwrap().status,
        PrepStatus::Active
    );
}

/// Node's `JSON.stringify` order; `mcp` picks the second profile the retries use.
fn profile(mcp: bool) -> Value {
    json!({
        "projectInstructions": false, "skills": false, "hooks": false, "plugins": false, "mcp": mcp,
        "customAgents": false, "memory": false, "outputStyle": false, "systemPromptOverrides": false,
        "identity": false, "harness": false, "environment": false, "automationTools": false,
    })
}

/// W7-7a (specs/fork-rust-workflow-engine.md 9.36): preparing a worktree records no dynamic-workflow gate. The prepared
/// session has no tools until its activation records the gate before its first turn (9.2, divergence 53 of 9.18).
#[tokio::test]
async fn preparing_a_worktree_records_no_dynamic_workflow_gate() {
    let (_scope, server, _kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let (session, _, _) = prepared(&server, parent.path()).await;
    assert_eq!(
        server.dynamic_workflow_gate(&SessionId::new(&session)),
        None,
        "a prepared session has no record until its activation"
    );
}

/// Prepares a worktree session under a temporary parent; its id, the parent and the worktree path.
async fn prepared(server: &Server, parent: &std::path::Path) -> (String, String, String) {
    let worktree = parent.join("wt-i");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let ack = create(
        server,
        "prep",
        json!({"workspaceId": workspace, "worktreePreparation": {"branchName": "feat/i", "targetPath": path}}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let session = ack.result.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    (session, workspace, path)
}

fn activation(session: &str, workspace: &str, path: &str, incognito: Option<Value>) -> Value {
    let mut payload = json!({"workspaceId": workspace, "preparedSessionId": session,
        "executionWorktree": {"path": path, "branchName": "feat/i"},
        "firstInput": {"text": "first"}});
    if let Some(profile) = incognito {
        payload["incognito"] = profile;
    }
    payload
}

/// Fork (specs/fork-rust-agent-parity.md, "Incognito sessions"; Node `createSessionRecord`): the activation's profile
/// is frozen (prepared entry in memory, row, kernel profile, actor meta) before the move releases SessionStart and before the
/// first input; the sessions-index row carries the flag. Only the same profile may repeat the activation.
#[tokio::test]
async fn an_incognito_activation_freezes_the_profile_before_the_session_runs() {
    use rust_cli_kernel_api::incognito::IncognitoProfile;
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let (session, workspace, path) = prepared(&server, parent.path()).await;
    let id = SessionId::new(&session);
    // Before the activation the reserved row has no profile and the session has run nothing.
    assert_eq!(kernel.store.meta(&id).unwrap().incognito, None);
    assert!(kernel.sent.lock().unwrap().is_empty());

    let ack = create(
        &server,
        "c1",
        activation(&session, &workspace, &path, Some(profile(false))),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    assert_eq!(ack.result.unwrap()["preparedActivation"], "materialized");
    let names: Vec<String> = kernel
        .sent
        .lock()
        .unwrap()
        .iter()
        .map(|(_, name)| name.clone())
        .collect();
    let at = |prefix: &str| names.iter().position(|name| name.starts_with(prefix));
    assert!(at("FreezeIncognito") < at("SetIncognito"), "{names:?}");
    assert!(at("SetIncognito") < at("SetExecutionRoot"), "{names:?}");
    assert!(at("SetExecutionRoot") < at("Submit first"), "{names:?}");
    assert_eq!(
        kernel.store.meta(&id).unwrap().incognito,
        Some(IncognitoProfile::LOCKDOWN)
    );
    let marker = load(&server, &id).await.unwrap().unwrap();
    assert_eq!(marker.status, PrepStatus::Active);
    let live = server.bridge.get(&id).unwrap();
    assert_eq!(live.sink.summary()["incognito"], json!(true));

    // The same profile is answered from the receipt; another one, or none, is refused with Node's text.
    let again = create(
        &server,
        "c2",
        activation(&session, &workspace, &path, Some(profile(false))),
    )
    .await;
    assert_eq!(
        again.result.unwrap()["preparedActivation"],
        "already-active"
    );
    for (command, other) in [("c3", Some(profile(true))), ("c4", None)] {
        let refused = create(
            &server,
            command,
            activation(&session, &workspace, &path, other),
        )
        .await;
        assert_eq!(refused.status, Status::Failed, "{refused:?}");
        assert_eq!(refused.message.as_deref(), Some(INCOGNITO_MISMATCH));
    }
}

/// Fork: an attempt that fails after the freeze (a refused move) leaves the choice frozen in memory (Node's
/// `prepared.incognito`; the stored marker never holds it): a retry with
/// another profile is refused, the same one completes. A normal activation freezes a normal session the same way.
#[tokio::test]
async fn a_retry_must_repeat_the_frozen_incognito_choice() {
    use rust_cli_kernel_api::incognito::IncognitoProfile;
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let (session, workspace, path) = prepared(&server, parent.path()).await;
    let id = SessionId::new(&session);
    kernel
        .refuse_moves
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let first = create(
        &server,
        "c1",
        activation(&session, &workspace, &path, Some(profile(true))),
    )
    .await;
    assert_eq!(first.status, Status::Failed, "{first:?}");
    let marker = load(&server, &id).await.unwrap().unwrap();
    assert_eq!(marker.status, PrepStatus::Preparing);
    let mcp_only = IncognitoProfile {
        mcp: true,
        ..IncognitoProfile::LOCKDOWN
    };
    assert_eq!(
        server.prepared_incognito.lock_unpoisoned().get(&id),
        Some(&Some(mcp_only))
    );
    let other = create(
        &server,
        "c2",
        activation(&session, &workspace, &path, Some(profile(false))),
    )
    .await;
    assert_eq!(other.message.as_deref(), Some(INCOGNITO_MISMATCH));
    let same = create(
        &server,
        "c3",
        activation(&session, &workspace, &path, Some(profile(true))),
    )
    .await;
    assert_eq!(same.status, Status::Accepted, "{same:?}");
    assert_eq!(same.result.unwrap()["preparedActivation"], "materialized");
    assert_eq!(kernel.store.meta(&id).unwrap().incognito, Some(mcp_only));

    // A normal activation freezes a normal session (`null`): a later incognito request is refused.
    let (normal, workspace, path) = prepared(&server, parent.path()).await;
    kernel
        .refuse_moves
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let first = create(&server, "c4", activation(&normal, &workspace, &path, None)).await;
    assert_eq!(first.status, Status::Failed, "{first:?}");
    assert_eq!(
        server
            .prepared_incognito
            .lock_unpoisoned()
            .get(&SessionId::new(&normal)),
        Some(&None)
    );
    let late = create(
        &server,
        "c5",
        activation(&normal, &workspace, &path, Some(profile(false))),
    )
    .await;
    assert_eq!(late.message.as_deref(), Some(INCOGNITO_MISMATCH));
}

/// Fork (round 5; Node `persistPreparedWorktreeStatus`): the stored marker never carries the incognito choice. Node
/// keeps it on the in-memory prepared entry (`prepared.incognito`) and its parser drops unknown keys, so the record is
/// Node's shape after a failed attempt and after the activation, for an incognito and for a normal session alike.
#[tokio::test]
async fn the_stored_marker_has_no_incognito_key() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let stored = |id: &SessionId| {
        let store = kernel.store.clone();
        let id = id.clone();
        async move { store.records(&id, KIND).await.unwrap() }
    };
    for (index, choice) in [Some(profile(false)), None].into_iter().enumerate() {
        let (session, workspace, path) = prepared(&server, parent.path()).await;
        let id = SessionId::new(&session);
        kernel
            .refuse_moves
            .store(1, std::sync::atomic::Ordering::SeqCst);
        let failed = create(
            &server,
            &format!("f{index}"),
            activation(&session, &workspace, &path, choice.clone()),
        )
        .await;
        assert_eq!(failed.status, Status::Failed, "{failed:?}");
        for record in stored(&id).await {
            assert!(record.data.get("incognito").is_none(), "{}", record.data);
        }
        let done = create(
            &server,
            &format!("a{index}"),
            activation(&session, &workspace, &path, choice),
        )
        .await;
        assert_eq!(done.status, Status::Accepted, "{done:?}");
        let records = stored(&id).await;
        let last = records.last().unwrap();
        assert_eq!(last.data["status"], "active");
        for record in &records {
            assert!(record.data.get("incognito").is_none(), "{}", record.data);
        }
    }
}

/// Fork: a profile the store cannot freeze fails the activation before anything runs (no move, so SessionStart stays
/// held; no input), like a refused config; the preparation stays retryable.
#[tokio::test]
async fn a_failed_freeze_fails_the_activation_before_the_move() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let (session, workspace, path) = prepared(&server, parent.path()).await;
    kernel
        .refuse_freezes
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let ack = create(
        &server,
        "c1",
        activation(&session, &workspace, &path, Some(profile(false))),
    )
    .await;
    assert_eq!(ack.status, Status::Failed, "{ack:?}");
    assert!(kernel.sent.lock().unwrap().is_empty(), "{:?}", kernel.sent);
    let marker = load(&server, &SessionId::new(&session))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.status, PrepStatus::Preparing);
    let retried = create(
        &server,
        "c2",
        activation(&session, &workspace, &path, Some(profile(false))),
    )
    .await;
    assert_eq!(retried.status, Status::Accepted, "{retried:?}");
}

/// The real inbound path: the `v4/command` envelope schema (its `type` enum), then `commands::command`.
async fn inbound(
    server: &Arc<Server>,
    params: Value,
) -> Result<Value, rust_cli_protocol_core::rpc::RpcError> {
    use rust_cli_protocol_core::connection::Service;
    crate::server::Handler(server.clone())
        .request("v4/command", params)
        .await
        .map(|reply| reply.result)
}

/// `inbound.json` is generated from the App's zod schemas as a whole (`scripts/fork-rust-agent/inbound-schema.mts`).
/// Before, `setRowPinned` and `setExternalAgentConfigOption` were missing from the envelope's `type` enum (refused as
/// invalid params before any command handling), `setRowPinned` from the CAS lists, and `sendText.firstSubmissionId`
/// from the payload (an empty id passed the schema).
#[tokio::test]
async fn commands_missing_from_the_inbound_schema_reach_the_command_path() {
    let (_scope, server, _kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let workspace = parent.path().to_str().unwrap().to_owned();
    let ack = inbound(
        &server,
        json!({"commandId": "c1", "clientId": "k", "sessionId": null, "type": "createSession",
            "issuedAt": 1, "payload": {"workspaceId": workspace}}),
    )
    .await
    .unwrap();
    assert_eq!(ack["status"], "accepted", "{ack}");
    let session = ack["result"]["sessionId"].as_str().unwrap().to_owned();
    let command = |id: &str, kind: &str, payload: Value, cas: bool| {
        let mut params = json!({"commandId": id, "clientId": "k", "sessionId": session,
            "type": kind, "issuedAt": 1, "payload": payload});
        if cas {
            params["baseRevision"] = json!(0);
            params["baseLogEpoch"] = json!("e");
        }
        params
    };
    let target = json!({"rowId": 1, "entityId": "m1"});

    // A known command reaches its handler, not the invalid-envelope refusal. `setRowPinned` is ported
    // (specs/fork-rust-feedback-and-pins.md): row 1 is not in this empty session, so the target is stale.
    let ack = inbound(
        &server,
        command(
            "p1",
            "setRowPinned",
            json!({"target": target, "pinned": true}),
            true,
        ),
    )
    .await
    .unwrap();
    assert_eq!(ack["status"], "stale", "{ack}");
    assert_eq!(ack["reasonCode"], "proto.staleTarget", "{ack}");
    let ack = inbound(
        &server,
        command(
            "x1",
            "setExternalAgentConfigOption",
            json!({"sessionId": session, "configId": "model", "value": "fast"}),
            false,
        ),
    )
    .await
    .unwrap();
    // Ported since: it reaches its handler, which this server gives no ACP config port.
    assert_eq!(
        ack["reasonCode"], "fault.command.capabilityUnsupported",
        "{ack}"
    );

    // The CAS rule (Node `parseCommandEnvelope`): setRowPinned needs baseRevision and baseLogEpoch.
    let ack = inbound(
        &server,
        command(
            "p2",
            "setRowPinned",
            json!({"target": target, "pinned": true}),
            false,
        ),
    )
    .await
    .unwrap();
    assert_eq!(ack["reasonCode"], "proto.invalidPayload", "{ack}");
    assert_eq!(
        ack["message"],
        "CAS commands require baseRevision and baseLogEpoch"
    );
    // The payload schema: a pin without its row is invalid.
    let ack = inbound(
        &server,
        command("p3", "setRowPinned", json!({"pinned": true}), true),
    )
    .await
    .unwrap();
    assert_eq!(ack["reasonCode"], "proto.invalidPayload", "{ack}");

    // sendText.firstSubmissionId is a non-empty string.
    let ack = inbound(
        &server,
        command(
            "s1",
            "sendText",
            json!({"text": "hi", "firstSubmissionId": ""}),
            false,
        ),
    )
    .await
    .unwrap();
    assert_eq!(ack["status"], "rejected", "{ack}");
    assert_eq!(ack["reasonCode"], "proto.invalidPayload", "{ack}");
    assert!(
        ack["message"]
            .as_str()
            .unwrap()
            .starts_with("/payload/firstSubmissionId"),
        "{ack}"
    );
}

/// Node `v4-bridge.ts`: a submission activation whose `workspaceId` is not the reservation's workspace is refused,
/// never activated in the other workspace; the reservation stays for the right one.
#[tokio::test]
async fn a_submission_activation_in_another_workspace_is_refused() {
    let (_scope, server, kernel) = server();
    let (parent, other) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let workspace = parent.path().to_str().unwrap().to_owned();
    let ack = run(
        &server,
        json!({"commandId": "r1", "clientId": "k", "type": "createSession", "issuedAt": 1,
            "payload": {"workspaceId": workspace, "submissionPreparation": {"submissionId": "sub"}}}),
    )
    .await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    let session = ack["result"]["sessionId"].as_str().unwrap().to_owned();
    let activate = |id: &str, workspace: &str| {
        json!({"commandId": id, "clientId": "k", "type": "createSession", "issuedAt": 1,
            "payload": {"workspaceId": workspace, "preparedSessionId": session,
                "expectedSubmissionId": "sub"}})
    };

    let ack = run(&server, activate("a1", other.path().to_str().unwrap())).await;
    assert_eq!(ack["status"], "rejected", "{ack}");
    assert_eq!(
        ack["message"],
        "Prepared submission does not match the requested workspace or submission"
    );
    assert!(kernel.sent.lock().unwrap().is_empty());
    let marker = crate::preparation::load(&server, &SessionId::new(&session))
        .await
        .unwrap()
        .unwrap();
    assert!(!marker.active);

    let ack = run(&server, activate("a2", &workspace)).await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    assert_eq!(ack["result"]["sessionId"], session.as_str());
}

/// W7-1 review finding 6 (specs/fork-rust-workflow-engine.md 9.2): a refused submission activation leaves the gate its
/// reservation recorded unchanged; the gate its activation asks for is recorded only once the activation is accepted.
#[tokio::test]
async fn a_refused_activation_leaves_the_gate_record_unchanged() {
    use rust_cli_kernel_api::dynamic_workflow::DynamicWorkflowGate;

    let (_scope, server, _kernel) = server();
    let (parent, other) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let workspace = parent.path().to_str().unwrap().to_owned();
    let ack = run(
        &server,
        json!({"commandId": "r1", "clientId": "k", "type": "createSession", "issuedAt": 1,
            "payload": {"workspaceId": workspace, "submissionPreparation": {"submissionId": "sub"}}}),
    )
    .await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    let session = ack["result"]["sessionId"].as_str().unwrap().to_owned();
    let id = SessionId::new(&session);
    let closed = Some(DynamicWorkflowGate {
        enabled: false,
        tools_on_demand: false,
    });
    assert_eq!(server.dynamic_workflow_gate(&id), closed);

    let activate = |command: &str, workspace: &str| {
        json!({"commandId": command, "clientId": "k", "type": "createSession", "issuedAt": 1,
            "payload": {"workspaceId": workspace, "preparedSessionId": session,
                "expectedSubmissionId": "sub",
                "dynamicWorkflowEnabled": true, "dynamicWorkflowMode": "onDemand"}})
    };
    let ack = run(&server, activate("a1", other.path().to_str().unwrap())).await;
    assert_eq!(ack["status"], "rejected", "{ack}");
    assert_eq!(server.dynamic_workflow_gate(&id), closed);

    let ack = run(&server, activate("a2", &workspace)).await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    assert_eq!(
        server.dynamic_workflow_gate(&id),
        Some(DynamicWorkflowGate {
            enabled: true,
            tools_on_demand: true,
        })
    );
}

/// Node lists a prepared session under `workspaceID ?? directory` and compares that key with `workspaceId`. A row a
/// Node agent wrote with a workspace identity besides its directory is activated with the identity, not the path.
#[tokio::test]
async fn activations_compare_the_listed_workspace_key_not_the_directory() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let workspace = parent.path().to_str().unwrap().to_owned();
    let identity = format!("remote:ssh:box:{workspace}");

    // Submission activation.
    let ack = run(
        &server,
        json!({"commandId": "r1", "clientId": "k", "type": "createSession", "issuedAt": 1,
            "payload": {"workspaceId": workspace, "submissionPreparation": {"submissionId": "sub"}}}),
    )
    .await;
    let submission = ack["result"]["sessionId"].as_str().unwrap().to_owned();
    kernel
        .store
        .set_workspace_key(&SessionId::new(&submission), &identity);
    let activate = |id: &str, workspace: &str| {
        json!({"commandId": id, "clientId": "k", "type": "createSession", "issuedAt": 1,
            "payload": {"workspaceId": workspace, "preparedSessionId": submission,
                "expectedSubmissionId": "sub"}})
    };
    let ack = run(&server, activate("a1", &workspace)).await;
    assert_eq!(
        ack["status"], "rejected",
        "the directory is not the key: {ack}"
    );
    let ack = run(&server, activate("a2", &identity)).await;
    assert_eq!(ack["status"], "accepted", "{ack}");

    // Worktree activation.
    let worktree = parent.path().join("wt");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let path = worktree.to_str().unwrap().to_owned();
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "worktreePreparation": {
            "branchName": "feat/a", "targetPath": path, "attemptId": "a1"}}),
    )
    .await;
    let prepared = ack.result.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    kernel
        .store
        .set_workspace_key(&SessionId::new(&prepared), &identity);
    let activate = |id: &str, workspace: &str| {
        json!({"commandId": id, "clientId": "k", "type": "createSession", "issuedAt": 1,
            "payload": {"workspaceId": workspace, "preparedSessionId": prepared,
                "expectedAttemptId": "a1",
                "executionWorktree": {"path": path, "branchName": "feat/a"}}})
    };
    let ack = run(&server, activate("w1", &workspace)).await;
    assert_ne!(
        ack["status"], "accepted",
        "the directory is not the key: {ack}"
    );
    let ack = run(&server, activate("w2", &identity)).await;
    assert_eq!(ack["status"], "accepted", "{ack}");
}

/// A session row built the fork way: the parent workspace as its `directory`, the worktree in the execution
/// columns, and nothing open (a stored session a restarted agent finds).
async fn stored_worktree_session(
    kernel: &WorktreeKernel,
    id: &str,
    workspace: &str,
    worktree: &str,
) -> SessionId {
    rust_cli_kernel_api::session_api::Kernel::create_session(
        kernel,
        CreateSession {
            id: Some(SessionId::new(id)),
            workspace: rust_cli_kernel_api::env::WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new(workspace),
            },
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
            incognito: None,
        },
    )
    .await
    .unwrap();
    let id = SessionId::new(id);
    kernel
        .store
        .set_execution_worktree(&id, &EnvPath::new(worktree), None)
        .await
        .unwrap();
    id
}

/// The cold-restore subscribe of a conversation topic (Node: the cold branch of
/// `ensureColdReadyPublisher` → `resumePersistedSession` consumes the request's `workspace`).
async fn resume_subscribe(server: &Server, session: &str, workspace: Value) -> Result<(), String> {
    crate::subscribe::subscribe(
        server,
        &json!({
            "topic": format!("conversation/{session}"),
            "connectionId": "conn",
            "clientMode": "desktop-continuous",
            "workspace": workspace,
        }),
    )
    .await
    .map(|_| ())
    .map_err(|error| format!("{} ({})", error.message, error.code))
}

/// B1.2: the cold-restore `workspace` override (Node `resolveResumeWorkspaceRef` + the lineage check of
/// `validateSessionActivationWorkspace`). A request naming the stored worktree or its parent (the row's
/// `directory`) opens the session with the request's key as its listed identity; the stored execution root
/// is what the session keeps running in (Node: the execution path comes from the stored directory, never the
/// request). Node keeps the request's `workspaceKey` in both cases, so a worktree-naming request lists the
/// session under the worktree key.
#[tokio::test]
async fn a_cold_resume_workspace_naming_the_worktree_or_its_parent_opens_the_session() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let id = stored_worktree_session(&kernel, "s-cold-wt", &workspace, &path).await;
    for named in [workspace.clone(), path.clone()] {
        resume_subscribe(
            &server,
            id.as_str(),
            json!({"workspacePath": named, "workspaceKey": named}),
        )
        .await
        .unwrap_or_else(|error| panic!("a request naming {named} is accepted: {error}"));
        let live = server.bridge.get(&id).unwrap();
        // The identity (the listed key) comes from the Host request.
        assert_eq!(live.sink.summary()["workspaceId"], json!(named));
        // The execution root stays the stored one: the request never rewrites the columns.
        let execution = kernel.store.execution_worktree(&id).await.unwrap().unwrap();
        assert_eq!(execution.directory.as_str(), workspace.as_str());
        assert_eq!(execution.path.as_str(), path.as_str());
        // Cold again for the next case.
        server.bridge.close(&id);
    }
}

/// B1.2: one String-equal directory compares lexically like Node's `resolve(a) === resolve(b)`, so a
/// trailing separator or a padded request still names the parent.
#[tokio::test]
async fn a_cold_resume_workspace_compares_paths_lexically() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let id = stored_worktree_session(&kernel, "s-lex", &workspace, &path).await;
    let padded = format!("{workspace}/");
    resume_subscribe(
        &server,
        id.as_str(),
        json!({"workspacePath": padded, "workspaceKey": workspace}),
    )
    .await
    .expect("a trailing separator names the same directory");
}

/// B1.2: anything the stored facts cannot prove fails the subscribe fail-closed with Node's wire text (the
/// lineage error thrown by the resume, wrapped by the cold-resume coordinator as `fault.subscribe.resumeFailed`),
/// and nothing opens. A remote `workspaceIdentity` fails the same way (Node's `isSameSessionWorkspacePath`
/// answers false for remote requests on a locally stored session). Node proves a worktree-of relation with a
/// git resolver (`classifyLocalSessionDirectory`); the fork's proof is the exact stored columns, so a
/// worktree-naming request is accepted only when the columns name that worktree.
#[tokio::test]
async fn a_cold_resume_workspace_naming_something_else_fails_fail_closed() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let id = stored_worktree_session(&kernel, "s-refused", &workspace, &path).await;
    // A sibling of the worktree: under the parent, but neither the worktree nor the parent. A
    // whitespace-only identity trims to absent (Node `requested.workspaceIdentity?.trim()`), so the
    // path alone decides that case.
    let sibling = parent.path().join("other");
    let cases = [
        json!({"workspacePath": "/elsewhere", "workspaceKey": "/elsewhere"}),
        json!({"workspacePath": sibling.to_str().unwrap(), "workspaceKey": workspace}),
        json!({"workspacePath": workspace, "workspaceKey": workspace,
               "workspaceIdentity": "remote:1:u@h:/w"}),
        json!({"workspacePath": "/elsewhere", "workspaceKey": "/elsewhere",
               "workspaceIdentity": "  "}),
    ];
    for workspace_ref in cases {
        let shown = workspace_ref.to_string();
        let error = match crate::subscribe::subscribe(
            &server,
            &json!({
                "topic": format!("conversation/{}", id.as_str()),
                "connectionId": "conn",
                "clientMode": "desktop-continuous",
                "workspace": workspace_ref,
            }),
        )
        .await
        {
            Err(error) => error,
            Ok(_) => panic!("the request is refused fail-closed: {shown}"),
        };
        assert_eq!(error.code, -32603, "{shown}: {error}");
        assert_eq!(
            error.message,
            format!(
                "Failed to resume persisted session {}: project.session-lineage-invalid \
                 (fault.subscribe.resumeFailed)",
                id.as_str()
            ),
            "{shown}"
        );
        assert!(
            server.bridge.get(&id).is_none(),
            "the refusal opens nothing"
        );
    }
}

/// B1.2: an ordinary session (no execution columns) accepts only its own directory, like Node's same-dir
/// branch; a foreign workspace is refused with the lineage error.
#[tokio::test]
async fn an_ordinary_session_refuses_a_foreign_resume_workspace() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let workspace = parent.path().to_str().unwrap().to_owned();
    rust_cli_kernel_api::session_api::Kernel::create_session(
        kernel.as_ref(),
        CreateSession {
            id: Some(SessionId::new("s-plain")),
            workspace: rust_cli_kernel_api::env::WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new(&workspace),
            },
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
            incognito: None,
        },
    )
    .await
    .unwrap();
    let id = SessionId::new("s-plain");
    resume_subscribe(
        &server,
        id.as_str(),
        json!({"workspacePath": workspace, "workspaceKey": workspace}),
    )
    .await
    .expect("its own directory is the same directory");
    server.bridge.close(&id);
    let error = resume_subscribe(
        &server,
        id.as_str(),
        json!({"workspacePath": "/elsewhere", "workspaceKey": "/elsewhere"}),
    )
    .await
    .unwrap_err();
    assert!(error.contains("project.session-lineage-invalid"), "{error}");
}

/// B1.2: the shared transport contract — "live paths do not consume it". A subscribe of an already-open
/// session never reads the workspace (Node's live `hydratePublisher` path has no resume admission), so a
/// workspace that the cold path would refuse still subscribes.
#[tokio::test]
async fn a_live_subscribe_does_not_consume_the_workspace() {
    let (_scope, server, _kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let workspace = parent.path().to_str().unwrap().to_owned();
    let ack = create(
        &server,
        "c1",
        json!({"workspaceId": workspace, "sessionId": "s-live"}),
    )
    .await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    resume_subscribe(
        &server,
        "s-live",
        json!({"workspacePath": "/elsewhere", "workspaceKey": "/elsewhere"}),
    )
    .await
    .expect("a live subscribe does not consume the workspace");
}

/// B1.2: `subscribe.worktreeSessionIds` (Node `loadWorktreeSessionSummaries` + `ensureIndexPublisher`): the
/// Host names the sessions whose task rows carry a worktree root; each id is read read-only (the
/// `reconcileSessions` row read) and seeds the stored half only when the row proves it belongs to the
/// workspace. Nothing opens, nothing is persisted, an id the scan already listed is not duplicated (Node
/// merges missing only), and the seeded row carries the worktree facts like a scanned row.
#[tokio::test]
async fn worktree_session_ids_seed_read_only_rows_for_ids_the_scan_cannot_see() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let named = stored_worktree_session(&kernel, "s-named", &workspace, &path).await;
    let foreign = stored_worktree_session(&kernel, "s-foreign", "/elsewhere", "/elsewhere").await;
    let deleted = stored_worktree_session(&kernel, "s-deleted", &workspace, &workspace).await;
    rust_cli_kernel_api::store::SessionStore::delete(kernel.store.as_ref(), &deleted)
        .await
        .unwrap();

    let rows = crate::subscribe::stored_rows(
        &server,
        &workspace,
        &["s-named", "s-named", "s-foreign", "s-deleted", "s-missing"],
    )
    .await;
    let count = |rows: &[Value], id: &str| {
        rows.iter()
            .filter(|row| row["sessionId"] == json!(id))
            .count()
    };
    assert_eq!(count(&rows, "s-named"), 1, "merged missing, not duplicated");
    assert_eq!(count(&rows, "s-foreign"), 0, "another workspace's row");
    assert_eq!(count(&rows, "s-deleted"), 0, "a soft-deleted row");
    assert_eq!(count(&rows, "s-missing"), 0, "no row at all");
    let row = rows
        .iter()
        .find(|row| row["sessionId"] == json!("s-named"))
        .unwrap();
    assert_eq!(row["workspaceId"], json!(workspace));
    assert_eq!(row["executionWorktree"], json!({"path": path}));
    // Read-only: the reads never open the named sessions and never touch their stored facts.
    {
        let handles = kernel.handles.lock().unwrap();
        assert!(
            handles.get(&named).is_none() && handles.get(&foreign).is_none(),
            "the ids are read from their rows, not opened"
        );
    }
    let execution = kernel
        .store
        .execution_worktree(&named)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(execution.path.as_str(), path, "nothing was persisted");
}

/// B1.2: the one row the scan window cannot see (node-store lists at most 200 by activity, id desc; the
/// Host's id list names it exactly) is seeded from its row — the read-side value of the ids (Node: upstream
/// worktree sessions are scan-invisible; the fork: the window, until B1.5's sessions make both paths agree).
#[tokio::test]
async fn a_worktree_id_names_the_row_the_scan_window_missed() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("wt");
    rust_cli_fs::create_dir_all(&worktree).await.unwrap();
    let (workspace, path) = (
        parent.path().to_str().unwrap().to_owned(),
        worktree.to_str().unwrap().to_owned(),
    );
    let create_plain = |id: String| {
        let (kernel, root) = (kernel.clone(), workspace.clone());
        async move {
            rust_cli_kernel_api::session_api::Kernel::create_session(
                kernel.as_ref(),
                CreateSession {
                    id: Some(SessionId::new(&id)),
                    workspace: rust_cli_kernel_api::env::WorkspaceRef {
                        environment: EnvironmentId::new("local"),
                        root: EnvPath::new(&root),
                    },
                    selection: selection(),
                    mode: PermissionMode::Default,
                    plan: false,
                    incognito: None,
                },
            )
            .await
            .unwrap();
        }
    };
    for index in 1..=200 {
        create_plain(format!("s-{index:03}")).await;
    }
    let missed = stored_worktree_session(&kernel, "s-000", &workspace, &path).await;

    let scanned = crate::subscribe::stored_rows(&server, &workspace, &[]).await;
    assert_eq!(scanned.len(), 200, "the window is node-store's");
    assert!(
        !scanned.iter().any(|row| row["sessionId"] == json!("s-000")),
        "the window missed the named row"
    );
    let rows = crate::subscribe::stored_rows(&server, &workspace, &["s-000"]).await;
    let row = rows
        .iter()
        .find(|row| row["sessionId"] == json!("s-000"))
        .expect("the id seeds the row the window missed");
    assert_eq!(row["executionWorktree"], json!({"path": path}));
    assert!(
        kernel.handles.lock().unwrap().get(&missed).is_none(),
        "the row was read, never opened"
    );
}

/// B1.2: a row read that fails skips the id with a warn (Node logs each failed summary read) instead of
/// failing the subscribe. The named row sits outside the scan's directory, so only the id path could seed it.
#[tokio::test]
async fn a_failed_worktree_row_read_skips_the_id() {
    let (_scope, server, kernel) = server();
    let parent = tempfile::tempdir().unwrap();
    let workspace = parent.path().to_str().unwrap().to_owned();
    let foreign = parent.path().join("foreign");
    let named = stored_worktree_session(
        &kernel,
        "s-fail",
        foreign.to_str().unwrap(),
        foreign.to_str().unwrap(),
    )
    .await;
    kernel.store.fail_next_reconcile_row();
    let rows = crate::subscribe::stored_rows(&server, &workspace, &["s-fail"]).await;
    assert!(
        !rows.iter().any(|row| row["sessionId"] == json!("s-fail")),
        "a failed read seeds nothing"
    );
    assert!(kernel.handles.lock().unwrap().get(&named).is_none());
}

/// B1.2: the generated inbound schema keeps Node's subscribe contract for the two fields (the workspace ref
/// and the bounded id list), so a wire request that Node would refuse never reaches the handler.
#[tokio::test]
async fn a_subscribe_validates_workspace_and_worktree_ids_like_the_app_schema() {
    let (_scope, server, _kernel) = server();
    let request = |params: Value| async {
        use rust_cli_protocol_core::connection::Service;
        crate::server::Handler(server.clone())
            .request("v4/conversation/subscribe", params)
            .await
    };
    let base = json!({"topic": "sessions-index//w", "connectionId": "conn",
                      "clientMode": "desktop-continuous"});
    let mut valid = base.clone();
    valid["workspace"] = json!({"workspacePath": "/w", "workspaceKey": "/w"});
    valid["worktreeSessionIds"] = json!(["s-1", "s-2"]);
    request(valid).await.expect("Node's own shape passes");

    let mut missing_key = base.clone();
    missing_key["workspace"] = json!({"workspacePath": "/w"});
    assert!(request(missing_key).await.is_err());

    let mut empty_id = base.clone();
    empty_id["worktreeSessionIds"] = json!(["s-1", ""]);
    assert!(request(empty_id).await.is_err());

    let mut too_many = base.clone();
    too_many["worktreeSessionIds"] = json!(
        (0..201)
            .map(|index| format!("s-{index}"))
            .collect::<Vec<_>>()
    );
    assert!(request(too_many).await.is_err());

    let mut extra = base.clone();
    extra["unknownField"] = json!(1);
    assert!(request(extra).await.is_err());
}

/// A `createSelectionSideSession` envelope through the command entry (the inbound schema validates it too).
async fn side_chat_command(server: &Server, id: &str, payload: Value) -> Value {
    crate::commands::command(
        server,
        json!({
            "commandId": id, "clientId": "client", "sessionId": "s1", "type": "createSelectionSideSession",
            "issuedAt": 1, "baseRevision": 0, "baseLogEpoch": "e", "payload": payload,
        }),
    )
    .await
    .unwrap()
}

fn sent(kernel: &WorktreeKernel) -> Vec<String> {
    kernel
        .sent
        .lock()
        .unwrap()
        .iter()
        .map(|(_, name)| name.clone())
        .collect()
}

/// specs/fork-rust-selection-side-chat.md: without a `firstInput` the side chat is an empty child of the parent, opened
/// for the App, and nothing is sent to it or to the parent but the fork.
#[tokio::test]
async fn a_side_chat_without_a_first_input_is_an_opened_empty_child() {
    let (_scope, server, kernel) = server();
    forkable(&server, &kernel, None).await;
    let ack = side_chat_command(&server, "c-side", json!({})).await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    assert_eq!(
        ack["result"],
        json!({"type": "createSelectionSideSession", "sessionId": "s1_side_c-side"})
    );
    assert_eq!(
        sent(&kernel),
        ["ForkSelectionSideChat child=s1_side_c-side model=-"]
    );
    let child = SessionId::new("s1_side_c-side");
    let meta = kernel.store.meta(&child).expect("the child is stored");
    assert_eq!(meta.parent, Some(SessionId::new("s1")));
    assert_eq!(meta.title, "Selection side chat");
    // The handler opened the child for the App.
    assert!(server.bridge.get(&child).is_some());
}

/// A `firstInput` starts in the child only, under the command's id; the chosen model rides on the fork and the
/// first input. The parent receives no input, and its history is as it was.
#[tokio::test]
async fn a_side_chat_first_input_starts_in_the_child_only() {
    let (_scope, server, kernel) = server();
    forkable(&server, &kernel, None).await;
    let parent_messages = kernel
        .handle(&SessionId::new("s1"))
        .unwrap()
        .view
        .lock()
        .unwrap()
        .messages
        .clone();
    let ack = side_chat_command(
        &server,
        "c-side",
        json!({"firstInput": {"text": "what does this mean",
            "modelSelection": {"providerId": "other", "modelId": "m2"}}}),
    )
    .await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    assert_eq!(ack["result"]["sessionId"], "s1_side_c-side");
    assert_eq!(
        ack["result"]["input"],
        json!({"delivery": "startNow", "inputId": "c-side"})
    );
    let log = sent(&kernel);
    assert_eq!(log.len(), 2, "{log:?}");
    assert_eq!(
        log[0],
        "ForkSelectionSideChat child=s1_side_c-side model=m2"
    );
    assert!(log[1].starts_with("Submit what does this mean"), "{log:?}");
    // The first submit went to the child's handle, not the parent's.
    let parent = kernel.handle(&SessionId::new("s1")).unwrap();
    assert_eq!(parent.view.lock().unwrap().messages, parent_messages);
    let parent_live = server.bridge.get(&SessionId::new("s1")).unwrap();
    assert_eq!(
        parent_live.sink.status().0,
        crate::projection::state::Phase::CompletedSuccess
    );
}

/// The same command id again answers the first result (same child, a duplicate ack); no second fork.
#[tokio::test]
async fn a_side_chat_retry_with_the_same_command_id_returns_the_same_child() {
    let (_scope, server, kernel) = server();
    forkable(&server, &kernel, None).await;
    let first = side_chat_command(&server, "c-side", json!({})).await;
    let again = side_chat_command(&server, "c-side", json!({})).await;
    assert_eq!(first["status"], "accepted", "{first}");
    assert_eq!(again["status"], "duplicate", "{again}");
    assert_eq!(again["result"], first["result"]);
    assert_eq!(sent(&kernel).len(), 1);
    // A different command id is a new side chat.
    let other = side_chat_command(&server, "c-side-2", json!({})).await;
    assert_ne!(other["result"]["sessionId"], first["result"]["sessionId"]);
}
