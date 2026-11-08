//! `deleteSession` handler tests: the running-turn refusal changes nothing, and the accepted
//! path closes the session (bridge and kernel actor), soft-deletes through the kernel, drops the
//! protocol-owned follow-up preference and answers an ACK without a result, like Node.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use rust_cli_base::TaskScope;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, CommandEnvelope, CreateSession, EndReason, KernelError, SequencedEvent,
    SessionHandle, SessionView,
};
use rust_cli_kernel_api::store::{
    SessionFilter, SessionKind, SessionMeta, SessionSummary, StoreQueries,
};
use rust_cli_kernel_api::testing::{FixedClock, HandleOverride, MemoryStore, selection};
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::json;

use super::*;
use crate::context::Context;
use crate::inbox::Status;
use crate::projection::state::Followup;
use crate::server::Defaults;

/// The handle double: a fixed view, an empty event stream, and a record of `close` calls.
struct TestHandle {
    id: SessionId,
    view: SessionView,
    closes: StdMutex<Vec<EndReason>>,
}

#[async_trait]
impl HandleOverride for TestHandle {
    fn id(&self) -> &SessionId {
        &self.id
    }

    async fn send(&self, _command: CommandEnvelope) -> KernelAck {
        KernelAck::Duplicate
    }

    fn subscribe(&self, _after: Option<u64>) -> BoxStream<'static, SequencedEvent> {
        stream::empty().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(self.view.clone())
    }

    async fn close(&self, reason: EndReason) -> Vec<String> {
        self.closes.lock().unwrap().push(reason);
        Vec::new()
    }
}

/// The kernel double: opens the one handle, records (or fails) deletes.
struct DeleteKernel {
    handle: Arc<TestHandle>,
    fail: bool,
    deleted: StdMutex<Vec<String>>,
}

#[async_trait]
impl rust_cli_kernel_api::session_api::Kernel for DeleteKernel {
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
        _session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Ok(self.handle.clone())
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }

    async fn delete_session(&self, session: &SessionId) -> Result<(), KernelError> {
        if self.fail {
            return Err(KernelError::Failed {
                message: "the store is read-only".to_owned(),
            });
        }
        self.deleted
            .lock()
            .unwrap()
            .push(session.as_str().to_owned());
        Ok(())
    }
}

fn view(running: bool, running_turn: bool) -> SessionView {
    let mut view = SessionView::new(meta(), Vec::new(), selection(), PermissionMode::Default);
    if running_turn {
        view.messages = vec![Message::User(UserMessage {
            id: rust_cli_kernel_api::ids::MessageId::new("m1"),
            content: vec![ContentBlock::Text {
                text: "hello".into(),
            }],
            origin: UserOrigin::Human,
        })];
    }
    view.running = running;
    view
}

fn meta() -> SessionMeta {
    SessionMeta {
        id: SessionId::new("s1"),
        kind: SessionKind::Interactive,
        parent: None,
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/w"),
        },
        title: String::new(),
        trace: TraceId::new("trace"),
        created_at_ms: 1000,
    }
}

/// Builds the server. The scope is returned too: it must outlive the test, because the session
/// pump and the topics writer are its tasks (a dropped scope aborts them).
fn server(handle: Arc<TestHandle>, fail: bool) -> (TaskScope, Arc<Server>, Arc<DeleteKernel>) {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let kernel = Arc::new(DeleteKernel {
        handle,
        fail,
        deleted: StdMutex::new(Vec::new()),
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

fn envelope() -> Envelope {
    Envelope {
        command_id: "c1".to_owned(),
        client_id: "client".to_owned(),
        session_id: Some("s1".to_owned()),
        base_revision: None,
        kind: "deleteSession".to_owned(),
        payload: json!({}),
        input_origin: None,
    }
}

/// The accepted path: the kernel actor is closed, the kernel soft-deletes, the bridge entry and
/// the follow-up preference are dropped, and the ACK carries no result (Node returns `undefined`).
#[tokio::test]
async fn an_idle_session_is_closed_deleted_and_forgotten() {
    let handle = Arc::new(TestHandle {
        id: SessionId::new("s1"),
        view: view(false, true),
        closes: StdMutex::new(Vec::new()),
    });
    let (_scope, server, kernel) = server(handle.clone(), false);
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    server
        .followups
        .lock_unpoisoned()
        .insert(SessionId::new("s1"), Followup::Guide);
    let ack = delete(&server, &live, &envelope(), 7).await;
    assert_eq!(ack.status, Status::Accepted);
    assert_eq!(ack.result, None);
    assert_eq!(ack.revision_at_decision, 7);
    assert_eq!(*kernel.deleted.lock().unwrap(), vec!["s1"]);
    assert_eq!(*handle.closes.lock().unwrap(), vec![EndReason::Other]);
    assert!(server.bridge.get(&SessionId::new("s1")).is_none());
    assert!(
        !server
            .followups
            .lock_unpoisoned()
            .contains_key(&SessionId::new("s1"))
    );
}

/// A running turn refuses with Node's failed-command code and touches nothing: no close, no
/// delete, the bridge keeps the session open.
#[tokio::test]
async fn a_running_turn_refuses_without_side_effects() {
    let handle = Arc::new(TestHandle {
        id: SessionId::new("s1"),
        view: view(true, true),
        closes: StdMutex::new(Vec::new()),
    });
    let (_scope, server, kernel) = server(handle.clone(), false);
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    let ack = delete(&server, &live, &envelope(), 3).await;
    assert_eq!(ack.status, Status::Failed);
    assert_eq!(
        ack.reason_code.as_deref(),
        Some("fault.command.executionFailed")
    );
    assert!(kernel.deleted.lock().unwrap().is_empty());
    assert!(handle.closes.lock().unwrap().is_empty());
    assert!(server.bridge.get(&SessionId::new("s1")).is_some());
}

/// A kernel error maps to Node's failed-command code. The close already happened (the kernel
/// requires it before the delete), which is the recoverable order: the session is closed but
/// still listed, and the delete can be retried.
#[tokio::test]
async fn a_failed_kernel_delete_refuses_with_the_execution_failed_code() {
    let handle = Arc::new(TestHandle {
        id: SessionId::new("s1"),
        view: view(false, true),
        closes: StdMutex::new(Vec::new()),
    });
    let (_scope, server, kernel) = server(handle.clone(), true);
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    let ack = delete(&server, &live, &envelope(), 4).await;
    assert_eq!(ack.status, Status::Failed);
    assert_eq!(
        ack.reason_code.as_deref(),
        Some("fault.command.executionFailed")
    );
    assert_eq!(ack.message.as_deref(), Some("the store is read-only"));
    assert!(kernel.deleted.lock().unwrap().is_empty());
    assert_eq!(*handle.closes.lock().unwrap(), vec![EndReason::Other]);
}
