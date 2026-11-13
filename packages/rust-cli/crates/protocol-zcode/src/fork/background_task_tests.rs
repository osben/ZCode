//! `session/cancelBackgroundTask` (specs/fork-rust-agent-parity.md "Legacy `session/cancelBackgroundTask`").

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use rust_cli_base::TaskScope;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::env_shell::BackgroundStatus;
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use rust_cli_kernel_api::manage::{BackgroundEntry, BackgroundKind};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, Command, CommandEnvelope, CreateSession, EndReason, Kernel, KernelError,
    SequencedEvent, SessionHandle, SessionView,
};
use rust_cli_kernel_api::store::{
    SessionFilter, SessionKind, SessionMeta, SessionSummary, StoreQueries,
};
use rust_cli_kernel_api::testing::{FixedClock, HandleOverride, MemoryStore, selection};
use rust_cli_protocol_core::connection::{self, Options, Service};
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, Handler, Server};

const RESIDENT: &str = "resident";
const COLD: &str = "cold";

/// The handle double: the session's background list and the kernel's answers to `StopTask`.
struct TestHandle {
    id: SessionId,
    view: SessionView,
    background: Vec<BackgroundEntry>,
    stopped: StdMutex<Vec<String>>,
}

#[async_trait]
impl HandleOverride for TestHandle {
    fn id(&self) -> &SessionId {
        &self.id
    }

    async fn send(&self, envelope: CommandEnvelope) -> KernelAck {
        let Command::StopTask { task } = envelope.command else {
            return KernelAck::Duplicate;
        };
        self.stopped.lock_unpoisoned().push(task.clone());
        match task.as_str() {
            "bg_1" | "agent_1" | "monitor_1" => KernelAck::Accepted {
                result: Default::default(),
            },
            "killed_1" => KernelAck::Rejected {
                reason: "Task killed_1 is not running (status: killed)".to_owned(),
            },
            "done_1" => KernelAck::Rejected {
                reason: "Task done_1 is not running (status: completed)".to_owned(),
            },
            "odd_1" => KernelAck::Rejected {
                reason: "Task odd_1 is not running (status: unknown)".to_owned(),
            },
            "broken_1" => KernelAck::Rejected {
                reason: "environment unavailable: machine m1 is disconnected".to_owned(),
            },
            other => KernelAck::Rejected {
                reason: format!("No task found with ID: {other}"),
            },
        }
    }

    fn subscribe(&self, _after: Option<u64>) -> BoxStream<'static, SequencedEvent> {
        stream::empty().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(self.view.clone())
    }

    async fn close(&self, _reason: EndReason) -> Vec<String> {
        Vec::new()
    }

    async fn background_tasks(&self) -> Result<Vec<BackgroundEntry>, KernelError> {
        Ok(self.background.clone())
    }
}

/// The kernel double: opens the handle of the requested session and counts the opens.
struct TestKernel {
    handles: HashMap<String, Arc<TestHandle>>,
    opened: StdMutex<Vec<String>>,
}

#[async_trait]
impl Kernel for TestKernel {
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
        self.opened
            .lock_unpoisoned()
            .push(session.as_str().to_owned());
        let handle =
            self.handles
                .get(session.as_str())
                .cloned()
                .ok_or_else(|| KernelError::NotFound {
                    session: session.clone(),
                })?;
        Ok(handle)
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }
}

fn handle(id: &str) -> Arc<TestHandle> {
    let meta = SessionMeta {
        id: SessionId::new(id),
        kind: SessionKind::Interactive,
        parent: None,
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/w"),
        },
        title: String::new(),
        trace: TraceId::new("trace"),
        created_at_ms: 1000,
        incognito: None,
    };
    Arc::new(TestHandle {
        id: SessionId::new(id),
        view: SessionView::new(meta, Vec::new(), selection(), PermissionMode::Default),
        background: vec![
            BackgroundEntry::new(
                "bg_1",
                BackgroundKind::Shell,
                "pnpm dev",
                BackgroundStatus::Running,
            ),
            BackgroundEntry::new(
                "agent_1",
                BackgroundKind::Agent,
                "Review",
                BackgroundStatus::Running,
            ),
            BackgroundEntry::new(
                "monitor_1",
                BackgroundKind::Monitor,
                "tail -f log",
                BackgroundStatus::Running,
            ),
        ],
        stopped: StdMutex::new(Vec::new()),
    })
}

struct Fixture {
    _scope: TaskScope,
    handler: Handler,
    kernel: Arc<TestKernel>,
    resident: Arc<TestHandle>,
}

/// `RESIDENT` is open (resident); `COLD` exists but was never opened.
async fn fixture() -> Fixture {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let resident = handle(RESIDENT);
    let kernel = Arc::new(TestKernel {
        handles: HashMap::from([
            (RESIDENT.to_owned(), resident.clone()),
            (COLD.to_owned(), handle(COLD)),
        ]),
        opened: StdMutex::new(Vec::new()),
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
    server.live(&SessionId::new(RESIDENT)).await.unwrap();
    Fixture {
        _scope: scope,
        handler: Handler(server),
        kernel,
        resident,
    }
}

async fn cancel(
    fixture: &Fixture,
    params: Value,
) -> Result<Value, rust_cli_protocol_core::rpc::RpcError> {
    fixture
        .handler
        .request("session/cancelBackgroundTask", params)
        .await
        .map(|reply| reply.result)
}

async fn cancel_task(fixture: &Fixture, task: &str) -> Value {
    cancel(fixture, json!({"sessionId": RESIDENT, "taskId": task}))
        .await
        .expect("answered")
}

#[tokio::test]
async fn a_running_command_is_stopped_with_its_snapshot() {
    let fixture = fixture().await;
    assert_eq!(
        cancel_task(&fixture, "bg_1").await,
        json!({
            "cancelled": true,
            "status": "cancelled",
            "taskId": "bg_1",
            "snapshot": {
                "taskId": "bg_1",
                "taskKind": "bash",
                "command": "pnpm dev",
                "status": "cancelled",
                "cancellable": false,
            },
        })
    );
    assert_eq!(*fixture.resident.stopped.lock_unpoisoned(), vec!["bg_1"]);
}

#[tokio::test]
async fn an_agent_and_a_monitor_carry_their_own_snapshot_fields() {
    let fixture = fixture().await;
    assert_eq!(
        cancel_task(&fixture, "agent_1").await["snapshot"],
        json!({
            "taskId": "agent_1",
            "taskKind": "subagent",
            "description": "Review",
            "status": "cancelled",
            "cancellable": false,
        })
    );
    assert_eq!(
        cancel_task(&fixture, "monitor_1").await["snapshot"],
        json!({
            "taskId": "monitor_1",
            "command": "tail -f log",
            "status": "cancelled",
            "cancellable": false,
        })
    );
}

/// Node's lenient path: an ended task is `background_task_not_running` with its terminal status; a killed one counts
/// as cancelled.
#[tokio::test]
async fn an_ended_task_answers_not_running_with_its_status() {
    let fixture = fixture().await;
    assert_eq!(
        cancel_task(&fixture, "killed_1").await,
        json!({
            "cancelled": true,
            "reason": "background_task_not_running",
            "status": "cancelled",
            "taskId": "killed_1",
        })
    );
    assert_eq!(
        cancel_task(&fixture, "done_1").await,
        json!({
            "cancelled": false,
            "reason": "background_task_not_running",
            "status": "completed",
            "taskId": "done_1",
        })
    );
    assert_eq!(cancel_task(&fixture, "odd_1").await["status"], "lost");
}

#[tokio::test]
async fn an_unknown_task_answers_not_found() {
    let fixture = fixture().await;
    assert_eq!(
        cancel_task(&fixture, "nope").await,
        json!({
            "cancelled": false,
            "reason": "background_task_not_found",
            "status": "lost",
            "taskId": "nope",
        })
    );
}

/// A stop that fails for another reason (the environment could not reach the process) is not "not found": Node
/// throws, so the call fails.
#[tokio::test]
async fn a_failed_stop_is_an_error_not_a_missing_task() {
    let fixture = fixture().await;
    let error = cancel(
        &fixture,
        json!({"sessionId": RESIDENT, "taskId": "broken_1"}),
    )
    .await
    .expect_err("the stop failed");
    assert_eq!(error.code, -32603);
    assert_eq!(
        error.message,
        "environment unavailable: machine m1 is disconnected"
    );
}

/// Node `requireSession`: only an active runtime answers; a stored session is not opened for this.
#[tokio::test]
async fn a_session_that_is_not_resident_is_unavailable_and_not_opened() {
    let fixture = fixture().await;
    let opened_before = fixture.kernel.opened.lock_unpoisoned().len();
    let error = cancel(&fixture, json!({"sessionId": COLD, "taskId": "bg_1"}))
        .await
        .expect_err("not active");
    assert_eq!(error.code, crate::server::SESSION_UNAVAILABLE);
    assert_eq!(error.message, "Session is not active: cold");
    assert_eq!(fixture.kernel.opened.lock_unpoisoned().len(), opened_before);
}

/// The strict zod params: a missing task id or an extra member is `-32602`.
#[tokio::test]
async fn invalid_params_are_refused() {
    let fixture = fixture().await;
    for params in [
        json!({"sessionId": RESIDENT}),
        json!({"sessionId": RESIDENT, "taskId": ""}),
        json!({"sessionId": RESIDENT, "taskId": "bg_1", "extra": true}),
    ] {
        let error = cancel(&fixture, params.clone()).await.expect_err("invalid");
        assert_eq!(error.code, -32602, "{params}");
    }
    assert!(fixture.resident.stopped.lock_unpoisoned().is_empty());
}
