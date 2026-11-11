//! Execution worktree: Node's marker shape and guards (`worktree-preparation-guard.test.ts`,
//! `v4-prepared-worktree-lifecycle.test.ts`), the sessions-index fields, and the prepare → update → activate flow
//! through the protocol server with a recording kernel.

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::ids::{EnvironmentId, TraceId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    CommandEnvelope, CommandResult, CreateSession, KernelError, SequencedEvent, SessionHandle,
    SessionView,
};
use rust_cli_kernel_api::store::{
    SessionFilter, SessionKind, SessionMeta, SessionStore, SessionSummary, StoreQueries,
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
            Command::SetModel { .. } => "SetModel".to_owned(),
            Command::SetMode { .. } => "SetMode".to_owned(),
            Command::SetPlan { .. } => "SetPlan".to_owned(),
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
    /// Sessions created through `create_prepared_session` (SessionStart held until the move).
    prepared: StdMutex<Vec<String>>,
}

impl WorktreeKernel {
    fn handle(&self, id: &SessionId) -> Result<Arc<TestHandle>, KernelError> {
        if let Some(handle) = self.handles.lock().unwrap().get(id) {
            return Ok(handle.clone());
        }
        let meta = self.store.meta(id).ok_or_else(|| KernelError::NotFound {
            session: id.clone(),
        })?;
        let handle = Arc::new(TestHandle {
            id: id.clone(),
            view: StdMutex::new(SessionView::new(
                meta,
                Vec::new(),
                selection(),
                PermissionMode::Default,
            )),
            sent: self.sent.clone(),
            refuse_moves: self.refuse_moves.clone(),
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
        let meta = SessionMeta {
            id: id.clone(),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: request.workspace,
            title: String::new(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
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

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }

    async fn session_snapshot(&self, session: &SessionId) -> Result<SessionView, KernelError> {
        HandleOverride::view(self.handle(session)?.as_ref()).await
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
        prepared: StdMutex::new(Vec::new()),
    });
    let server = Arc::new(Server::new(
        context,
        kernel.clone(),
        scope.spawner(),
        Defaults {
            selection: selection(),
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
    assert_eq!(
        sent[0],
        ("c5:worktree".to_owned(), format!("SetExecutionRoot {path}"))
    );
    assert!(sent.iter().any(|(_, name)| name == "SetMode"), "{sent:?}");
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
            "config": {"mode": "build"}, "firstInput": {"text": "hello"}}),
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
    assert_eq!(sent.first(), Some(&format!("SetExecutionRoot {path}")));
    let mode = sent.iter().position(|name| name == "SetMode").unwrap();
    let input = sent.iter().position(|name| name == "Submit hello").unwrap();
    assert!(mode < input, "{sent:?}");
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
