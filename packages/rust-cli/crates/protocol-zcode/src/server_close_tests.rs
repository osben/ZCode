//! Fork: `session/close` with `expectedPersistence` (Node `shouldCloseSessionForExpectedPersistence`,
//! specs/fork-agent-runtime-selection.md "Draft prewarm in Rust mode"): a deferred close drops a
//! draft and closes its actor; a stored session answers `closed: false`, and the reverse for
//! `immediate`.

use std::collections::HashSet;
use std::sync::Mutex as StdMutex;

use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::metering::{ActivityQuery, ActivityStats, RequestStats, SessionMetering};
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, CommandEnvelope, CreateSession, SequencedEvent, SessionHandle, SessionView,
};
use rust_cli_kernel_api::store::{
    FrontendRecord, SessionFilter, SessionKind, SessionMeta, SessionSummary, StoreError,
    StoreQueries,
};
use rust_cli_kernel_api::testing::{FixedClock, HandleOverride, selection};
use rust_cli_protocol_core::connection::{self, Options};

use super::*;

/// What the store and the actor saw, in order (`persist`, `send`).
type Log = Arc<StdMutex<Vec<&'static str>>>;

/// The store's draft set: the only part of the queries `session/close` and admission read.
#[derive(Default)]
struct DraftQueries {
    drafts: StdMutex<HashSet<String>>,
    dropped: StdMutex<HashSet<String>>,
    /// The next `persist_for_input` fails as a full disk would.
    fail_persist: std::sync::atomic::AtomicBool,
    /// The input text of each admission.
    inputs: StdMutex<Vec<String>>,
    log: Log,
}

fn unsupported<T>() -> Result<T, StoreError> {
    Err(StoreError::Unsupported {
        what: "test double".to_owned(),
    })
}

#[async_trait]
impl StoreQueries for DraftQueries {
    async fn metering(&self, _session: &SessionId) -> Result<SessionMetering, StoreError> {
        unsupported()
    }

    async fn request_stats(&self, _session: &SessionId) -> Result<RequestStats, StoreError> {
        unsupported()
    }

    async fn activity(&self, _query: ActivityQuery) -> Result<ActivityStats, StoreError> {
        unsupported()
    }

    async fn put_record(
        &self,
        _session: &SessionId,
        _record: &FrontendRecord,
    ) -> Result<(), StoreError> {
        unsupported()
    }

    async fn records(
        &self,
        _session: &SessionId,
        _kind: &str,
    ) -> Result<Vec<FrontendRecord>, StoreError> {
        Ok(Vec::new())
    }

    async fn is_draft(&self, session: &SessionId) -> Result<bool, StoreError> {
        Ok(self.drafts.lock_unpoisoned().contains(session.as_str()))
    }

    async fn discard_draft(&self, session: &SessionId) -> Result<bool, StoreError> {
        let dropped = self.drafts.lock_unpoisoned().remove(session.as_str());
        if dropped {
            self.dropped
                .lock_unpoisoned()
                .insert(session.as_str().to_owned());
        }
        Ok(dropped)
    }

    async fn is_rowless_draft(&self, session: &SessionId) -> Result<bool, StoreError> {
        Ok(self.drafts.lock_unpoisoned().contains(session.as_str())
            || self.dropped.lock_unpoisoned().contains(session.as_str()))
    }

    async fn persist_for_input(
        &self,
        session: &SessionId,
        input: &str,
    ) -> Result<bool, StoreError> {
        self.inputs.lock_unpoisoned().push(input.to_owned());
        if self
            .fail_persist
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            return Err(StoreError::Storage {
                message: "database or disk is full: /home/u/.zcode/cli/db/db.sqlite".to_owned(),
            });
        }
        if self.dropped.lock_unpoisoned().contains(session.as_str()) {
            return Err(StoreError::NotFound {
                session: session.clone(),
            });
        }
        let held = self.drafts.lock_unpoisoned().remove(session.as_str());
        if held {
            self.log.lock_unpoisoned().push("persist");
        }
        Ok(held)
    }
}

struct TestHandle {
    id: SessionId,
    view: SessionView,
    closes: StdMutex<Vec<EndReason>>,
    log: Log,
}

#[async_trait]
impl HandleOverride for TestHandle {
    fn id(&self) -> &SessionId {
        &self.id
    }

    async fn send(&self, _command: CommandEnvelope) -> KernelAck {
        self.log.lock_unpoisoned().push("send");
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
}

struct CloseKernel {
    handle: Arc<TestHandle>,
    queries: Arc<DraftQueries>,
}

#[async_trait]
impl Kernel for CloseKernel {
    fn queries(&self) -> Arc<dyn StoreQueries> {
        self.queries.clone()
    }

    /// The open `s1` stands for the created session.
    async fn create_session(&self, _request: CreateSession) -> Result<SessionId, KernelError> {
        Ok(SessionId::new("s1"))
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

    /// Like `LocalKernel::overview`: a stored session, plus the open `s1` the store has no row for.
    async fn workspace_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<rust_cli_kernel_api::panels::WorkspaceSession>, KernelError> {
        let row = |id: &str, activity| rust_cli_kernel_api::panels::WorkspaceSession {
            summary: SessionSummary {
                id: SessionId::new(id),
                title: String::new(),
                updated_at_ms: 1000,
                created_at_ms: 1000,
                last_outcome: None,
                parent: None,
                title_source: None,
            },
            activity,
            last_reply: None,
        };
        Ok(vec![
            row("stored", None),
            row(
                "s1",
                Some(rust_cli_kernel_api::panels::SessionActivity::Ready),
            ),
        ])
    }
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
        trace: rust_cli_kernel_api::ids::TraceId::new("trace"),
        created_at_ms: 1000,
    }
}

/// An open session `s1`; `draft` says whether the store still holds it as a draft. The scope must
/// outlive the test (the session pump runs on it).
async fn open(draft: bool) -> (TaskScope, Arc<Server>, Arc<TestHandle>, Arc<DraftQueries>) {
    open_view(
        draft,
        SessionView::new(meta(), Vec::new(), selection(), PermissionMode::Default),
    )
    .await
}

/// [`open`] on a given view of `s1`.
async fn open_view(
    draft: bool,
    view: SessionView,
) -> (TaskScope, Arc<Server>, Arc<TestHandle>, Arc<DraftQueries>) {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let log = Log::default();
    let handle = Arc::new(TestHandle {
        id: SessionId::new("s1"),
        view,
        closes: StdMutex::new(Vec::new()),
        log: log.clone(),
    });
    let queries = Arc::new(DraftQueries {
        log,
        ..DraftQueries::default()
    });
    if draft {
        queries.drafts.lock_unpoisoned().insert("s1".to_owned());
    }
    let kernel = Arc::new(CloseKernel {
        handle: handle.clone(),
        queries: queries.clone(),
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
    server.live(&SessionId::new("s1")).await.unwrap();
    (scope, server, handle, queries)
}

fn close(expected: Option<&str>) -> Value {
    match expected {
        Some(expected) => json!({"sessionId": "s1", "expectedPersistence": expected}),
        None => json!({"sessionId": "s1"}),
    }
}

#[tokio::test]
async fn a_deferred_close_drops_the_draft_and_closes_its_actor() {
    let (_scope, server, handle, queries) = open(true).await;
    let reply = server.close_session(&close(Some("deferred"))).await;
    assert_eq!(reply, json!({"closed": true}));
    assert!(queries.drafts.lock_unpoisoned().is_empty());
    assert_eq!(*handle.closes.lock_unpoisoned(), vec![EndReason::Other]);
    assert!(server.bridge.get(&SessionId::new("s1")).is_none());
}

#[tokio::test]
async fn a_deferred_close_of_a_stored_session_changes_nothing() {
    let (_scope, server, handle, _queries) = open(false).await;
    let reply = server.close_session(&close(Some("deferred"))).await;
    assert_eq!(reply, json!({"closed": false}));
    assert!(handle.closes.lock_unpoisoned().is_empty());
    assert!(server.bridge.get(&SessionId::new("s1")).is_some());
}

#[tokio::test]
async fn an_immediate_close_of_a_draft_changes_nothing() {
    let (_scope, server, handle, queries) = open(true).await;
    let reply = server.close_session(&close(Some("immediate"))).await;
    assert_eq!(reply, json!({"closed": false}));
    assert!(queries.drafts.lock_unpoisoned().contains("s1"));
    assert!(handle.closes.lock_unpoisoned().is_empty());
    assert!(server.bridge.get(&SessionId::new("s1")).is_some());
}

/// Node `isDraftSession`: a prewarm's summary stays out of the sessions index until the store
/// persists it, then the next publish lists it.
#[tokio::test]
async fn a_draft_stays_out_of_the_sessions_index_until_the_store_persists_it() {
    let (_scope, server, _handle, queries) = open(true).await;
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    live.sink.publish_summary().await;
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert!(server.topics.live_rows("/w").is_empty());
    queries.drafts.lock_unpoisoned().clear();
    live.sink.publish_summary().await;
    for _ in 0..50 {
        if !server.topics.live_rows("/w").is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(server.topics.live_rows("/w"), vec!["s1".to_owned()]);
}

#[tokio::test]
async fn an_immediate_or_unconditional_close_of_a_stored_session_closes_the_bridge() {
    for expected in [Some("immediate"), None] {
        let (_scope, server, _handle, _queries) = open(false).await;
        let reply = server.close_session(&close(expected)).await;
        assert_eq!(reply, json!({"closed": true}));
        assert!(server.bridge.get(&SessionId::new("s1")).is_none());
    }
}

/// Node `session/close` without `expectedPersistence` disposes the runtime; for a draft that is all
/// there is, so the draft is dropped and its actor closed.
#[tokio::test]
async fn an_unconditional_close_releases_a_draft() {
    let (_scope, server, handle, queries) = open(true).await;
    let reply = server.close_session(&close(None)).await;
    assert_eq!(reply, json!({"closed": true}));
    assert!(queries.drafts.lock_unpoisoned().is_empty());
    assert_eq!(*handle.closes.lock_unpoisoned(), vec![EndReason::Other]);
    assert!(server.bridge.get(&SessionId::new("s1")).is_none());
}

/// The bridge and the pump outlive a deferred close briefly: a flush after the drop must not publish
/// a session that has no row.
#[tokio::test]
async fn a_flush_after_a_deferred_close_does_not_publish_the_draft() {
    let (_scope, server, _handle, _queries) = open(true).await;
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    let reply = server.close_session(&close(Some("deferred"))).await;
    assert_eq!(reply, json!({"closed": true}));
    live.sink.publish_summary().await;
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert!(server.topics.live_rows("/w").is_empty());
}

/// Node gateway `isDraftSession` filters the cold seed too: an open draft the kernel lists has no row.
#[tokio::test]
async fn the_sessions_index_seed_skips_an_open_draft() {
    let ids = |rows: Vec<Value>| -> Vec<String> {
        rows.iter()
            .map(|row| row["sessionId"].as_str().unwrap_or_default().to_owned())
            .collect()
    };
    let (_scope, server, _handle, queries) = open(true).await;
    assert_eq!(
        ids(crate::subscribe::stored_rows(&server, "/w").await),
        vec!["stored".to_owned()]
    );
    queries.drafts.lock_unpoisoned().clear();
    assert_eq!(
        ids(crate::subscribe::stored_rows(&server, "/w").await),
        vec!["stored".to_owned(), "s1".to_owned()]
    );
}

fn send_text(command: &str) -> Value {
    json!({
        "commandId": command, "clientId": "k", "sessionId": "s1", "type": "sendText",
        "payload": {"text": "hi"}, "issuedAt": 1, "baseRevision": 0, "baseLogEpoch": "e",
    })
}

/// Node `admitInputCommand`: a draft is persisted before its first input reaches the actor, so a later
/// deferred close finds no draft and cannot drop the accepted input.
#[tokio::test]
async fn the_first_input_persists_the_draft_before_the_submit() {
    let (_scope, server, handle, queries) = open(true).await;
    crate::commands::command(&server, send_text("c1"))
        .await
        .unwrap();
    assert_eq!(*handle.log.lock_unpoisoned(), vec!["persist", "send"]);
    // Node `ensureSessionPersistedForExternalActivity(input.text)`: the store titles the row from the input.
    assert_eq!(*queries.inputs.lock_unpoisoned(), vec!["hi".to_owned()]);
    let reply = server.close_session(&close(Some("deferred"))).await;
    assert_eq!(reply, json!({"closed": false}));
    assert!(queries.dropped.lock_unpoisoned().is_empty());
}

/// createSession with `firstInput` admits the input with its text, like `sendText`.
#[tokio::test]
async fn a_create_with_its_first_input_admits_the_text() {
    let (_scope, server, _handle, queries) = open(true).await;
    let ack = crate::commands::command(&server, create_with_input("c1"))
        .await
        .unwrap();
    assert_eq!(ack["status"], "accepted", "{ack}");
    assert_eq!(*queries.inputs.lock_unpoisoned(), vec!["hi".to_owned()]);
}

/// Fork: a session renamed while closed (stored `custom`) is opened again; the live sessions-index row, which
/// replaces the cold one, keeps `custom` after a live update instead of deriving `generated` from the title.
#[tokio::test]
async fn a_reopened_renamed_session_keeps_its_custom_source_in_the_live_summary() {
    let mut view = SessionView::new(meta(), Vec::new(), selection(), PermissionMode::Default);
    view.meta.title = "Renamed".into();
    view.title_source = Some(rust_cli_kernel_api::title::Source::Custom);
    let (_scope, server, _handle, _queries) = open_view(false, view).await;
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    live.sink.publish_summary().await;
    let summary = live.sink.summary();
    assert_eq!(summary["title"], "Renamed");
    assert_eq!(summary["titleSource"], "custom");
}

/// A deferred close that dropped the draft first wins: the input is refused, not accepted and lost.
#[tokio::test]
async fn an_input_after_the_draft_was_dropped_is_refused() {
    let (_scope, server, handle, _queries) = open(true).await;
    server.close_session(&close(Some("deferred"))).await;
    let ack = crate::commands::command(&server, send_text("c1"))
        .await
        .unwrap();
    assert_eq!(ack["status"], "rejected", "{ack}");
    assert!(handle.log.lock_unpoisoned().is_empty());
}

fn create_with_input(command: &str) -> Value {
    json!({
        "commandId": command, "clientId": "k", "sessionId": null, "type": "createSession",
        "payload": {"sessionId": "s1", "workspaceId": "/w", "firstInput": {"text": "hi"}},
        "issuedAt": 1, "baseRevision": 0, "baseLogEpoch": "e",
    })
}

/// Node `admitInputCommand` throws when the deferred session cannot be persisted, and the command
/// fails (`fault.command.executionFailed`). An accepted createSession without the input would be
/// replayed as accepted on a retry, and the input would never reach the actor.
#[tokio::test]
async fn a_failed_persist_fails_the_create_with_its_first_input() {
    let (_scope, server, handle, queries) = open(true).await;
    queries
        .fail_persist
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let ack = crate::commands::command(&server, create_with_input("c1"))
        .await
        .unwrap();
    assert_eq!(ack["status"], "failed", "{ack}");
    assert_eq!(ack["reasonCode"], "fault.command.executionFailed", "{ack}");
    assert!(!ack.to_string().contains("db.sqlite"), "{ack}");
    let retry = crate::commands::command(&server, create_with_input("c1"))
        .await
        .unwrap();
    assert_ne!(retry["status"], "accepted", "{retry}");
    assert!(handle.log.lock_unpoisoned().is_empty());
    assert!(queries.drafts.lock_unpoisoned().contains("s1"));
}

/// The same for `sendText`: a storage failure is a failed command, not "no such session".
#[tokio::test]
async fn a_failed_persist_fails_the_input() {
    let (_scope, server, handle, queries) = open(true).await;
    queries
        .fail_persist
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let ack = crate::commands::command(&server, send_text("c1"))
        .await
        .unwrap();
    assert_eq!(ack["status"], "failed", "{ack}");
    assert_eq!(ack["reasonCode"], "fault.command.executionFailed", "{ack}");
    assert!(!ack.to_string().contains("db.sqlite"), "{ack}");
    assert!(handle.log.lock_unpoisoned().is_empty());
}
