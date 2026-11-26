//! `setAssistantFeedback` and `setRowPinned` through the whole command path (specs/fork-rust-feedback-and-pins.md): a
//! session double with a stored history and marks, which records the kernel commands it is sent and answers them.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, SessionId, TraceId};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, Message, StopReason, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::message_mark::{Feedback, MARK_STALE, MarkRequest, Marks};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, Command, CommandEnvelope, CommandResult, CreateSession, EndReason,
    KernelError, SequencedEvent, SessionHandle, SessionView,
};
use rust_cli_kernel_api::store::{
    SessionFilter, SessionKind, SessionMeta, SessionSummary, StoreQueries,
};
use rust_cli_kernel_api::testing::{FixedClock, HandleOverride, MemoryStore, selection};
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, Server};

/// The session double: a fixed view, an empty event stream, the commands it was sent, and the answer it gives them.
struct Handle {
    id: SessionId,
    view: SessionView,
    sent: StdMutex<Vec<Command>>,
    answer: KernelAck,
}

#[async_trait]
impl HandleOverride for Handle {
    fn id(&self) -> &SessionId {
        &self.id
    }

    async fn send(&self, command: CommandEnvelope) -> KernelAck {
        self.sent.lock().unwrap().push(command.command);
        self.answer.clone()
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
}

struct Kernel(Arc<Handle>);

#[async_trait]
impl rust_cli_kernel_api::session_api::Kernel for Kernel {
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
        Ok(self.0.clone())
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }
}

fn history() -> Vec<Message> {
    vec![
        Message::User(UserMessage {
            stall_execution: None,
            workflow_meta: None,
            epilogue_start: None,
            intent: None,
            id: MessageId::new("msg_u1"),
            content: vec![ContentBlock::Text {
                text: "hello".into(),
            }],
            origin: UserOrigin::Human,
        }),
        Message::Assistant(AssistantMessage {
            id: MessageId::new("msg_a1"),
            content: vec![ContentBlock::Text { text: "hi".into() }],
            model: "m".into(),
            stop_reason: Some(StopReason::EndTurn),
            usage: None,
        }),
    ]
}

fn view() -> SessionView {
    let mut view = SessionView::new(
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
            incognito: None,
        },
        history(),
        selection(),
        PermissionMode::Default,
    );
    view.marks.insert(
        MessageId::new("msg_a1"),
        Marks {
            feedback: Some(Feedback::Like),
            pinned_at: Some(321),
        },
    );
    view
}

fn server(answer: KernelAck) -> (TaskScope, Arc<Server>, Arc<Handle>) {
    let handle = Arc::new(Handle {
        id: SessionId::new("s1"),
        view: view(),
        sent: StdMutex::new(Vec::new()),
        answer,
    });
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let server = Arc::new(Server::new(
        context,
        Arc::new(Kernel(handle.clone())),
        scope.spawner(),
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    (scope, server, handle)
}

fn accepted() -> KernelAck {
    KernelAck::Accepted {
        result: CommandResult::Done,
    }
}

/// The row id and entity id of the `at`-th row of `kind` in the session's snapshot.
async fn row(server: &Server, kind: &str, at: usize) -> Value {
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    let snapshot = live.sink.snapshot();
    let rows: Vec<Value> = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == kind)
        .cloned()
        .collect();
    json!({"rowId": rows[at]["rowId"], "entityId": rows[at]["entityId"]})
}

async fn command(server: &Server, id: &str, kind: &str, payload: Value) -> Value {
    crate::commands::command(
        server,
        json!({
            "commandId": id, "clientId": "k", "sessionId": "s1", "type": kind,
            "payload": payload, "issuedAt": 1, "baseRevision": 0, "baseLogEpoch": "e",
        }),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_cold_snapshot_shows_the_stored_like_and_pin() {
    let (_scope, server, _handle) = server(accepted());
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    let snapshot = live.sink.snapshot();
    let rows = snapshot["rows"]["window"].as_array().unwrap();
    let reply = rows
        .iter()
        .find(|row| row["kind"] == "assistantText")
        .unwrap();
    assert_eq!(reply["feedback"], "like");
    assert_eq!(reply["pinnedAt"], 321);
}

#[tokio::test]
async fn feedback_reaches_the_session_as_one_command() {
    let (_scope, server, handle) = server(accepted());
    let target = row(&server, "assistantText", 0).await;
    for (id, feedback, expected) in [
        ("f1", json!("dislike"), Some(Feedback::Dislike)),
        ("f2", json!(null), None),
    ] {
        let ack = command(
            &server,
            id,
            "setAssistantFeedback",
            json!({"target": target, "feedback": feedback}),
        )
        .await;
        assert_eq!(ack["status"], "accepted", "{ack}");
        assert!(ack.get("result").is_none_or(Value::is_null), "{ack}");
        let sent = handle.sent.lock().unwrap().pop().unwrap();
        assert_eq!(
            sent,
            Command::MarkMessage {
                message: MessageId::new("msg_a1"),
                request: MarkRequest::Feedback(expected),
            }
        );
    }
}

#[tokio::test]
async fn a_pin_and_an_unpin_reach_the_session() {
    let (_scope, server, handle) = server(accepted());
    for (id, kind, message, pinned) in [
        ("p1", "assistantText", "msg_a1", true),
        ("p2", "userInput", "msg_u1", true),
        ("p3", "userInput", "msg_u1", false),
    ] {
        let target = row(&server, kind, 0).await;
        let ack = command(
            &server,
            id,
            "setRowPinned",
            json!({"target": target, "pinned": pinned}),
        )
        .await;
        assert_eq!(ack["status"], "accepted", "{ack}");
        let sent = handle.sent.lock().unwrap().pop().unwrap();
        assert_eq!(
            sent,
            Command::MarkMessage {
                message: MessageId::new(message),
                request: MarkRequest::Pin(pinned),
            }
        );
    }
}

#[tokio::test]
async fn a_wrong_row_kind_is_refused_with_the_gateways_code_and_sends_nothing() {
    let (_scope, server, handle) = server(accepted());
    // A like on the typed input, a pin on the turn header.
    let user = row(&server, "userInput", 0).await;
    let ack = command(
        &server,
        "w1",
        "setAssistantFeedback",
        json!({"target": user, "feedback": "like"}),
    )
    .await;
    assert_eq!(ack["status"], "rejected", "{ack}");
    assert_eq!(ack["reasonCode"], "guard.actionUnavailable", "{ack}");
    let header = row(&server, "turnHeader", 0).await;
    let ack = command(
        &server,
        "w2",
        "setRowPinned",
        json!({"target": header, "pinned": true}),
    )
    .await;
    assert_eq!(ack["status"], "rejected", "{ack}");
    assert_eq!(ack["reasonCode"], "guard.actionUnavailable", "{ack}");
    assert!(handle.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_missing_row_is_stale() {
    let (_scope, server, handle) = server(accepted());
    let ack = command(
        &server,
        "s1",
        "setRowPinned",
        json!({"target": {"rowId": 999_999, "entityId": "gone"}, "pinned": true}),
    )
    .await;
    assert_eq!(ack["status"], "stale", "{ack}");
    assert_eq!(ack["reasonCode"], "proto.staleTarget", "{ack}");
    assert!(handle.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_message_gone_from_the_history_is_stale() {
    let (_scope, server, _handle) = server(KernelAck::Rejected {
        reason: MARK_STALE.to_owned(),
    });
    let target = row(&server, "assistantText", 0).await;
    let ack = command(
        &server,
        "g1",
        "setAssistantFeedback",
        json!({"target": target, "feedback": "like"}),
    )
    .await;
    assert_eq!(ack["status"], "stale", "{ack}");
    assert_eq!(ack["reasonCode"], "proto.staleTarget", "{ack}");
}

#[tokio::test]
async fn a_failed_commit_is_an_execution_failure() {
    let (_scope, server, _handle) = server(KernelAck::Rejected {
        reason: "disk full".to_owned(),
    });
    let target = row(&server, "assistantText", 0).await;
    let ack = command(
        &server,
        "e1",
        "setRowPinned",
        json!({"target": target, "pinned": true}),
    )
    .await;
    assert_eq!(ack["status"], "rejected", "{ack}");
    assert_eq!(ack["reasonCode"], "fault.command.executionFailed", "{ack}");
}
