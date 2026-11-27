//! Fork (specs/fork-rust-workflow-engine.md 9.67, divergence 931): a hub launch record passes the session through
//! `running` before it is `completedSuccess`, as Node's control-only turn does (`TurnStarted` then `TurnComplete`). The
//! sidebar's task-index syncer takes the became-visible branch (the immediate mirror and the `task_created` broadcast) on
//! the `running` summary, and only the sessions-index rows the session publishes can show that it was there: the two
//! phases must be two published rows, not one coalesced one.

use std::sync::Arc;

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, SessionId};
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{KernelEvent, SequencedEvent, SessionView};
use rust_cli_kernel_api::store::{SessionKind, SessionMeta};
use rust_cli_kernel_api::testing::{FixedClock, HandleOverride, selection};
use rust_cli_protocol_core::connection::{self, Options};
use rust_cli_protocol_core::sessions::SessionSink;
use serde_json::json;
use tokio::io::AsyncReadExt;

use super::*;
use crate::wire::Purpose;

const TOPIC: &str = "sessions-index//w";

pub(super) struct Handle {
    pub(super) id: SessionId,
}

#[async_trait]
impl HandleOverride for Handle {
    fn id(&self) -> &SessionId {
        &self.id
    }

    async fn send(
        &self,
        _command: rust_cli_kernel_api::session_api::CommandEnvelope,
    ) -> rust_cli_kernel_api::session_api::Ack {
        rust_cli_kernel_api::session_api::Ack::Duplicate
    }

    fn subscribe(&self, _after: Option<u64>) -> BoxStream<'static, SequencedEvent> {
        stream::empty().boxed()
    }

    async fn view(&self) -> Result<SessionView, rust_cli_kernel_api::session_api::KernelError> {
        Ok(view())
    }
}

pub(super) fn view() -> SessionView {
    let meta = SessionMeta {
        id: SessionId::new("s1"),
        kind: SessionKind::Interactive,
        parent: None,
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/w"),
        },
        title: String::new(),
        trace: rust_cli_kernel_api::ids::TraceId::new("trace"),
        created_at_ms: 1000,
        incognito: None,
    };
    SessionView::new(meta, Vec::new(), selection(), PermissionMode::Default)
}

fn launch_record() -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        workflow_meta: Some(
            json!({"workflowLaunch": {"runId": "dwfrun-1", "toolCallId": "tc-1", "name": "nightly"}}),
        ),
        epilogue_start: None,
        intent: None,
        id: MessageId::new("msg_launch"),
        content: vec![ContentBlock::Text {
            text: "Started the saved workflow nightly.".into(),
        }],
        origin: UserOrigin::Meta {
            source: "workflow_launch".into(),
        },
    })
}

pub(super) fn event(seq: u64, event: KernelEvent) -> SequencedEvent {
    SequencedEvent {
        seq,
        event,
        revision: seq,
    }
}

/// The phases of the `session.upserted` rows the sessions-index topic sent, in the order they were sent.
async fn published_phases(mut reader: tokio::io::DuplexStream) -> Vec<String> {
    let mut bytes = Vec::new();
    let _ = tokio::time::timeout(
        std::time::Duration::from_millis(300),
        reader.read_to_end(&mut bytes),
    )
    .await;
    // The frames are one JSON line each, and a payload may sit inside a string: compare on the unescaped text.
    let text = String::from_utf8_lossy(&bytes).replace("\\\"", "\"");
    let mut phases = Vec::new();
    let mut rest = text.as_str();
    while let Some(at) = rest.find("\"op\":\"session.upserted\"") {
        rest = &rest[at..];
        let Some(phase_at) = rest.find("\"phase\":\"") else {
            break;
        };
        let after = &rest[phase_at + "\"phase\":\"".len()..];
        let phase = after.split('"').next().unwrap_or_default().to_owned();
        phases.push(phase);
        rest = &rest["\"op\":\"session.upserted\"".len()..];
    }
    phases
}

#[tokio::test]
async fn a_hub_launch_record_publishes_running_then_completed_success() {
    let scope = TaskScope::root("test", |_| {});
    let (out, reader) = tokio::io::duplex(1 << 20);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let topics = Arc::new(Topics::new(context.clone(), &scope.spawner()));
    topics.subscribe(TOPIC, "sub-1", "conn-1");
    topics.start(
        TOPIC.to_owned(),
        "sub-1".to_owned(),
        Vec::new(),
        Purpose::Online,
    );
    let handle = Arc::new(Handle {
        id: SessionId::new("s1"),
    });
    let live = Live::new(
        context,
        topics,
        handle,
        &view(),
        Followup::Queue,
        Arc::from(Vec::new()),
        Restored::default(),
    );
    live.event(event(
        1,
        KernelEvent::MessageDone {
            message: launch_record(),
        },
    ))
    .await;
    live.flush().await;
    assert_eq!(live.status().0, Phase::CompletedSuccess);
    // One coalesced `completedSuccess` row would hide the `running` step the syncer needs.
    let phases = published_phases(reader).await;
    assert_eq!(phases, ["running", "completedSuccess"], "{phases:?}");
}
