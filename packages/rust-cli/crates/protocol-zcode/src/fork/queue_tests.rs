//! `editQueueItem` mapping tests (specs/fork-rust-agent-parity.md, A1 rule 15): what the kernel's `EditQueued` carries.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use rust_cli_base::TaskScope;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use rust_cli_kernel_api::message::ContentBlock;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, CommandEnvelope, CommandResult, CreateSession, Kernel, KernelError,
    QueuedInput, QueuedKind, SequencedEvent, SessionHandle, SessionView,
};
use rust_cli_kernel_api::store::{
    SessionFilter, SessionKind, SessionMeta, SessionSummary, StoreQueries,
};
use rust_cli_kernel_api::testing::{FixedClock, HandleOverride, MemoryStore, selection};
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::{Value, json};

use super::*;
use crate::context::Context;
use crate::server::Defaults;

/// The handle double: accepts every command and records it.
struct TestHandle {
    id: SessionId,
    view: SessionView,
    /// What `Dequeue` hands back (the kernel's queued content).
    dequeued: Vec<ContentBlock>,
    sent: StdMutex<Vec<Command>>,
}

#[async_trait]
impl HandleOverride for TestHandle {
    fn id(&self) -> &SessionId {
        &self.id
    }

    async fn send(&self, envelope: CommandEnvelope) -> KernelAck {
        let result = match &envelope.command {
            Command::Dequeue { .. } if !self.dequeued.is_empty() => CommandResult::Dequeued {
                content: self.dequeued.clone(),
            },
            _ => CommandResult::Done,
        };
        self.sent.lock_unpoisoned().push(envelope.command);
        KernelAck::Accepted { result }
    }

    fn subscribe(&self, _after: Option<u64>) -> BoxStream<'static, SequencedEvent> {
        stream::empty().boxed()
    }

    async fn view(&self) -> Result<SessionView, KernelError> {
        Ok(self.view.clone())
    }
}

struct OneKernel {
    handle: Arc<TestHandle>,
}

#[async_trait]
impl Kernel for OneKernel {
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
}

async fn fixture() -> (TaskScope, Arc<Server>, Arc<TestHandle>) {
    fixture_with(Vec::new(), Vec::new()).await
}

async fn fixture_with(
    queue: Vec<QueuedInput>,
    dequeued: Vec<ContentBlock>,
) -> (TaskScope, Arc<Server>, Arc<TestHandle>) {
    let meta = SessionMeta {
        id: SessionId::new("s1"),
        kind: SessionKind::Interactive,
        parent: None,
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/fixture/repo"),
        },
        title: String::new(),
        trace: TraceId::new("trace"),
        created_at_ms: 1000,
        incognito: None,
    };
    let mut view = SessionView::new(meta, Vec::new(), selection(), PermissionMode::Default);
    view.queue = queue;
    let handle = Arc::new(TestHandle {
        id: SessionId::new("s1"),
        view,
        dequeued,
        sent: StdMutex::new(Vec::new()),
    });
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let server = Arc::new(Server::new(
        context,
        Arc::new(OneKernel {
            handle: handle.clone(),
        }),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    (scope, server, handle)
}

fn envelope(payload: Value) -> Envelope {
    serde_json::from_value(json!({
        "commandId": "cmd-1",
        "clientId": "app",
        "sessionId": "s1",
        "type": "editQueueItem",
        "payload": payload,
    }))
    .expect("an envelope")
}

async fn edit(payload: Value) -> (Ack, Vec<Command>) {
    let (_scope, server, handle) = fixture().await;
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    let ack = edit_queue_item(&server, &live, &envelope(payload), 3).await;
    let sent = handle.sent.lock_unpoisoned().clone();
    (ack, sent)
}

fn edited(sent: &[Command]) -> &QueuedEdit {
    match sent {
        [Command::EditQueued { edit, .. }] => edit,
        other => panic!("expected one EditQueued, got {other:?}"),
    }
}

#[tokio::test]
async fn the_apps_selection_reaches_the_intent_as_sent() {
    let raw = json!({"providerId": "p", "modelId": "m2", "options": {"reasoningLevel": "high"}});
    let (ack, sent) = edit(json!({
        "queueItemId": "queue_c1",
        "newText": "x",
        "modelSelection": raw,
        "mode": "edit",
    }))
    .await;
    assert_eq!(ack.status, Status::Accepted);
    let edit = edited(&sent);
    assert_eq!(edit.intent_model_selection, Some(raw));
    assert_eq!(
        edit.model_selection,
        Some(ModelSelection {
            reasoning: Some("high".to_owned()),
            ..ModelSelection::new("p", "m2")
        })
    );
    assert_eq!(edit.attachments, None, "no attachments sent: they stay");
}

#[tokio::test]
async fn attachments_are_resolved_before_the_kernel_sees_the_edit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    rust_cli_fs::append(&path, b"remember this").await.unwrap();
    let refs = json!([{
        "ref": path.to_string_lossy(),
        "fileName": "notes.txt",
        "mime": "text/plain",
        "bytes": 13,
    }]);
    let (ack, sent) = edit(json!({
        "queueItemId": "queue_c1",
        "newText": "x",
        "attachments": refs,
    }))
    .await;
    assert_eq!(ack.status, Status::Accepted);
    let attachments = edited(&sent).attachments.clone().expect("attachments sent");
    assert_eq!(attachments.refs, refs);
    assert!(
        matches!(attachments.content.as_slice(), [ContentBlock::File { file }] if file.name == "notes.txt"),
        "the attached file only, without a typed text block: {:?}",
        attachments.content
    );
    assert!(format!("{:?}", attachments.content).contains("remember this"));
    let (_, sent) =
        edit(json!({"queueItemId": "queue_c1", "newText": "x", "attachments": []})).await;
    let cleared = edited(&sent).attachments.clone().expect("`[]` is sent");
    assert_eq!(cleared.refs, json!([]));
    assert!(cleared.content.is_empty());
}

#[tokio::test]
async fn an_invalid_attachment_ref_refuses_the_edit_before_the_kernel() {
    let (ack, sent) = edit(json!({
        "queueItemId": "queue_c1",
        "newText": "x",
        "attachments": [{"ref": "/tmp/a.txt"}],
    }))
    .await;
    assert_eq!(ack.status, Status::Rejected);
    assert_eq!(ack.reason_code.as_deref(), Some("proto.invalidPayload"));
    assert!(sent.is_empty(), "the kernel never saw the edit: {sent:?}");
}

/// Node `sendQueuedNow` passes the item's attachments into the promoted turn: the content the kernel's `Dequeue`
/// hands back is what the promotion submits.
#[tokio::test]
async fn send_now_submits_the_queued_content() {
    let content = vec![
        ContentBlock::Text {
            text: "look".to_owned(),
        },
        ContentBlock::Text {
            text: "<file a.txt>".to_owned(),
        },
    ];
    let item = QueuedInput {
        edit_lock: None,
        intent: None,
        command: rust_cli_kernel_api::ids::CommandId::new("c1"),
        text: "look".to_owned(),
        delivery: Delivery::Queue,
        kind: QueuedKind::Text,
        execution: None,
    };
    let (_scope, server, handle) = fixture_with(vec![item], content.clone()).await;
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    let mut envelope = envelope(json!({"queueItemId": "queue_c1"}));
    envelope.kind = "sendQueuedNow".to_owned();
    let ack = send_queued_now(&live, &envelope, 3).await;
    assert_eq!(ack.status, Status::Accepted, "{ack:?}");
    let sent = handle.sent.lock_unpoisoned().clone();
    let submitted = sent
        .iter()
        .find_map(|command| match command {
            Command::SubmitWith { content, .. } => Some(content.clone()),
            _ => None,
        })
        .expect("the promotion submits");
    assert_eq!(submitted, content);
}
