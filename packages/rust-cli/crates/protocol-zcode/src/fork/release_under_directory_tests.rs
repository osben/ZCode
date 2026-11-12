//! `session/releaseUnderDirectory` tests (specs/fork-rust-agent-parity.md "Upstream 3.18.0 gaps (wave 2)", A3).
//! Each test names the Node rule it checks; the rules are listed in the spec's A3 paragraph.

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
use rust_cli_kernel_api::ids::{
    EnvironmentId, InteractionId, MessageId, SessionId, TraceId, TurnId,
};
use rust_cli_kernel_api::manage::{BackgroundEntry, BackgroundKind};
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, CommandEnvelope, CreateSession, EndReason, Kernel, KernelError,
    SequencedEvent, SessionHandle, SessionView,
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
use crate::worktree::{Execution, Facts};

const PROJECT: &str = "/fixture/repo";
const WORKTREE: &str = "/fixture/worktrees/3f2a/repo";

/// The handle double: a fixed view, the kernel's background ledger, and a record of `close` calls.
struct TestHandle {
    id: SessionId,
    view: SessionView,
    background: Vec<BackgroundEntry>,
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
        self.closes.lock_unpoisoned().push(reason);
        Vec::new()
    }

    async fn background_tasks(&self) -> Result<Vec<BackgroundEntry>, KernelError> {
        Ok(self.background.clone())
    }
}

/// The kernel double: opens the handle of the requested session.
struct ReleaseKernel {
    handles: HashMap<String, Arc<TestHandle>>,
}

#[async_trait]
impl Kernel for ReleaseKernel {
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

fn meta(id: &str, root: &str) -> SessionMeta {
    SessionMeta {
        id: SessionId::new(id),
        kind: SessionKind::Interactive,
        parent: None,
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new(root),
        },
        title: String::new(),
        trace: TraceId::new("trace"),
        created_at_ms: 1000,
        incognito: None,
    }
}

/// An idle session opened on `root`.
fn idle(id: &str, root: &str) -> SessionView {
    SessionView::new(
        meta(id, root),
        Vec::new(),
        selection(),
        PermissionMode::Default,
    )
}

/// A session with a turn running: an open user message and the live turn id, as the kernel reports a running turn.
fn running(id: &str, root: &str) -> SessionView {
    let mut view = idle(id, root);
    view.messages = vec![Message::User(UserMessage {
        intent: None,
        id: MessageId::new("m1"),
        content: vec![ContentBlock::Text {
            text: "hello".into(),
        }],
        origin: UserOrigin::Human,
    })];
    view.running_turn = Some(TurnId::new("t1"));
    view.running = true;
    view
}

/// Builds the server with every session in `views` open. The scope must outlive the test (the session
/// pumps are its tasks).
async fn fixture(
    views: Vec<SessionView>,
) -> (TaskScope, Arc<Server>, HashMap<String, Arc<TestHandle>>) {
    let handles: HashMap<String, Arc<TestHandle>> = views
        .into_iter()
        .map(|view| {
            let id = view.meta.id.as_str().to_owned();
            let handle = Arc::new(TestHandle {
                id: SessionId::new(&id),
                view,
                background: Vec::new(),
                closes: StdMutex::new(Vec::new()),
            });
            (id, handle)
        })
        .collect();
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let kernel = Arc::new(ReleaseKernel {
        handles: handles.clone(),
    });
    let server = Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    for id in handles.keys() {
        server.live(&SessionId::new(id)).await.unwrap();
    }
    (scope, server, handles)
}

async fn release(server: &Server, directory: &str) -> Value {
    super::release(server, &json!({ "directory": directory }))
        .await
        .expect("a valid request is answered")
}

fn is_open(server: &Server, id: &str) -> bool {
    server.bridge.get(&SessionId::new(id)).is_some()
}

fn closes(handles: &HashMap<String, Arc<TestHandle>>, id: &str) -> Vec<EndReason> {
    handles[id].closes.lock_unpoisoned().clone()
}

#[tokio::test]
async fn releases_the_idle_sessions_under_the_directory_only() {
    let (_scope, server, handles) = fixture(vec![
        idle("inside", &format!("{WORKTREE}/packages/ui")),
        idle("outside", PROJECT),
    ])
    .await;
    assert_eq!(
        release(&server, WORKTREE).await,
        json!({"released": ["inside"], "busy": []})
    );
    assert_eq!(closes(&handles, "inside"), vec![EndReason::Other]);
    assert!(closes(&handles, "outside").is_empty());
    assert!(!is_open(&server, "inside"));
    assert!(is_open(&server, "outside"));
}

/// A worktree session is listed under its project; its cwd is the execution worktree, so only the worktree
/// directory releases it.
#[tokio::test]
async fn a_worktree_session_is_matched_by_its_execution_cwd_not_its_listed_project() {
    let (_scope, server, handles) = fixture(vec![idle("wt", PROJECT)]).await;
    let live = server.live(&SessionId::new("wt")).await.unwrap();
    live.sink
        .set_worktree(Facts {
            preparing: None,
            execution: Some(Execution {
                path: format!("{WORKTREE}/packages/ui"),
                branch: Some("feat".to_owned()),
                missing: false,
            }),
        })
        .await;
    assert_eq!(
        release(&server, PROJECT).await,
        json!({"released": [], "busy": []})
    );
    assert!(closes(&handles, "wt").is_empty());
    assert_eq!(
        release(&server, WORKTREE).await,
        json!({"released": ["wt"], "busy": []})
    );
    assert_eq!(closes(&handles, "wt"), vec![EndReason::Other]);
}

/// `/x/repo2` is not inside `/x/repo`, and `/x/rep` does not contain `/x/repo`.
#[tokio::test]
async fn a_sibling_prefix_or_a_partial_name_is_not_matched() {
    let (_scope, server, handles) = fixture(vec![
        idle("sibling", &format!("{WORKTREE}2")),
        idle("exact", WORKTREE),
    ])
    .await;
    assert_eq!(
        release(&server, WORKTREE).await,
        json!({"released": ["exact"], "busy": []})
    );
    assert!(closes(&handles, "sibling").is_empty());
    assert!(is_open(&server, "sibling"));
    let partial = WORKTREE.trim_end_matches("/repo");
    assert_eq!(
        release(&server, partial).await,
        json!({"released": ["sibling"], "busy": []}),
        "the parent holds only the sibling, which is already the one left"
    );
}

#[tokio::test]
async fn an_equal_path_with_a_trailing_separator_matches() {
    let (_scope, server, _handles) = fixture(vec![idle("eq", WORKTREE)]).await;
    assert_eq!(
        release(&server, &format!("{WORKTREE}/")).await,
        json!({"released": ["eq"], "busy": []})
    );
}

/// A Windows directory matches a cwd written with the other separator and another case, and not a sibling
/// (`wt2`) that shares its first letters.
#[tokio::test]
async fn windows_paths_match_across_separators_and_case() {
    let (_scope, server, _handles) = fixture(vec![
        idle("win", r"C:\Repo\wt\sub"),
        idle("sibling", r"C:\Repo\wt2"),
    ])
    .await;
    assert_eq!(
        release(&server, "c:/repo/WT").await,
        json!({"released": ["win"], "busy": []})
    );
    assert!(is_open(&server, "sibling"));
}

/// Node `releaseSessionsUnderDirectory`: one busy session makes the whole answer busy, and nothing closes.
#[tokio::test]
async fn one_running_session_blocks_every_release() {
    let (_scope, server, handles) = fixture(vec![
        idle("idle", WORKTREE),
        running("run", &format!("{WORKTREE}/sub")),
    ])
    .await;
    assert_eq!(
        release(&server, WORKTREE).await,
        json!({"released": [], "busy": ["run"]})
    );
    assert!(closes(&handles, "idle").is_empty());
    assert!(closes(&handles, "run").is_empty());
    assert!(is_open(&server, "idle"));
    assert!(is_open(&server, "run"));
}

#[tokio::test]
async fn a_pending_interaction_is_busy() {
    let mut asking = idle("ask", WORKTREE);
    let request: rust_cli_kernel_api::orchestration::InteractionRequest = serde_json::from_value(
        json!({"kind": "permission", "tool_use": "tu1", "tool": "Bash", "input": {}, "message": "ok?"}),
    )
    .expect("a permission request");
    asking.pending = vec![(InteractionId::new("i1"), request)];
    let (_scope, server, handles) = fixture(vec![asking]).await;
    assert_eq!(
        release(&server, WORKTREE).await,
        json!({"released": [], "busy": ["ask"]})
    );
    assert!(closes(&handles, "ask").is_empty());
}

/// Node `hasResidencyBlockingWork` includes registry background tasks. The shell is read from the kernel ledger
/// when the session opens, like the App's `backgroundWorks`.
#[tokio::test]
async fn a_running_background_command_is_busy() {
    let handle = Arc::new(TestHandle {
        id: SessionId::new("bg"),
        view: idle("bg", WORKTREE),
        background: vec![BackgroundEntry::new(
            "b1",
            BackgroundKind::Shell,
            "sleep 30",
            BackgroundStatus::Running,
        )],
        closes: StdMutex::new(Vec::new()),
    });
    let handles = HashMap::from([("bg".to_owned(), handle)]);
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let kernel = Arc::new(ReleaseKernel {
        handles: handles.clone(),
    });
    let server = Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    let live = server.live(&SessionId::new("bg")).await.unwrap();
    for _ in 0..200 {
        if live.sink.snapshot()["backgroundWorks"]
            .as_array()
            .is_some_and(|works| !works.is_empty())
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        release(&server, WORKTREE).await,
        json!({"released": [], "busy": ["bg"]})
    );
    assert!(closes(&handles, "bg").is_empty());
    drop(scope);
}

/// A first submission still preparing is accepted input that has not started (busy).
#[tokio::test]
async fn a_preparing_first_submission_is_busy() {
    let (_scope, server, handles) = fixture(vec![idle("prep", WORKTREE)]).await;
    let live = server.live(&SessionId::new("prep")).await.unwrap();
    live.sink
        .set_preparation(Some(json!({"status": "preparing"})));
    assert_eq!(
        release(&server, WORKTREE).await,
        json!({"released": [], "busy": ["prep"]})
    );
    assert!(closes(&handles, "prep").is_empty());
}

#[tokio::test]
async fn no_matching_or_no_open_session_answers_empty_success() {
    let (_scope, server, handles) = fixture(vec![idle("s", PROJECT)]).await;
    assert_eq!(
        release(&server, "/fixture/worktrees/9999/repo").await,
        json!({"released": [], "busy": []})
    );
    assert!(closes(&handles, "s").is_empty());
    let (_scope, empty, _handles) = fixture(Vec::new()).await;
    assert_eq!(
        release(&empty, WORKTREE).await,
        json!({"released": [], "busy": []})
    );
}

#[tokio::test]
async fn invalid_params_are_refused_and_change_nothing() {
    let (_scope, server, handles) = fixture(vec![idle("s", WORKTREE)]).await;
    for params in [
        json!({}),
        json!({"directory": ""}),
        json!({"directory": 3}),
        json!({"directory": WORKTREE, "force": true}),
    ] {
        let error = super::release(&server, &params)
            .await
            .expect_err("invalid params are refused");
        assert_eq!(
            error.code,
            rust_cli_protocol_core::rpc::codes::INVALID_PARAMS,
            "{params}"
        );
    }
    assert!(closes(&handles, "s").is_empty());
    assert!(is_open(&server, "s"));
}

/// The method is routed to the handler, not answered `-32601`.
#[tokio::test]
async fn the_method_is_routed_to_the_handler() {
    let (_scope, server, handles) = fixture(vec![idle("s", WORKTREE)]).await;
    let reply = crate::fork::methods::dispatch(
        &server,
        "session/releaseUnderDirectory",
        json!({"directory": WORKTREE}),
    )
    .await;
    assert!(matches!(reply, Some(Ok(_))), "the method is handled");
    assert_eq!(closes(&handles, "s"), vec![EndReason::Other]);
}
