//! Fork: open documents and diagnostics freshness (specs/fork-rust-lsp.md "Documents and freshness"), Node core
//! `lsp/document-sync.ts`, `lsp/document-store.ts`, `lsp/diagnostics-freshness.ts` and `lsp/keyed-lock.ts`.
//!
//! One store per `(serverId, key)` and connection: a new connection (a restarted server) starts an empty store. Edits
//! of one file are serialized by a per-URI lock; the store itself is a plain mutex never held across an await.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::lsp::{FileMutation, FileMutationKind};
use serde_json::{Value, json};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

use super::MAX_OPEN_DOCUMENTS;
use super::edits::{Diagnostic, normalize, split_lines};
use super::pool::{ServerConnection, ServerKey};
use super::server::PULL_DIAGNOSTICS;
use super::uri::{document_uri, normalize as normalize_uri};

const INITIAL_VERSION: i64 = 1;

/// Node `DocumentSnapshot`: what the disk said when the text was last synced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub(crate) size: u64,
    pub(crate) mtime_ms: Option<u64>,
}

/// The workspace's files as document sync reads them.
#[async_trait]
pub(crate) trait Disk: Send + Sync {
    async fn stat(&self, path: &str) -> Result<Snapshot, String>;
    async fn read(&self, path: &str) -> Result<String, String>;
}

/// Node `PublishOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    Fresh,
    Stale,
    Ambiguous,
    Unattributed,
}

/// Node `DiagnosticsFreshness`: a result counts for the current version when it is a pull for that version, a publish
/// with `version >=` it, or a versionless publish while exactly one change is in flight.
#[derive(Debug, Default)]
pub(crate) struct Freshness {
    version: i64,
    in_flight: u32,
    /// The most recent fresh result and the version it was fresh for.
    last_fresh: Option<(i64, Vec<Diagnostic>)>,
}

impl Freshness {
    pub(crate) fn version(&self) -> i64 {
        self.version
    }

    pub(crate) fn last_fresh(&self) -> Option<&Vec<Diagnostic>> {
        self.last_fresh.as_ref().map(|(_, items)| items)
    }

    pub(crate) fn current_fresh(&self) -> Option<&Vec<Diagnostic>> {
        self.last_fresh
            .as_ref()
            .filter(|(version, _)| *version == self.version)
            .map(|(_, items)| items)
    }

    /// didOpen or didChange went out with `version`.
    pub(crate) fn record_change(&mut self, version: i64) {
        self.version = version;
        self.in_flight += 1;
    }

    /// A pull answered for `version`; pulls do not reset the in-flight count.
    pub(crate) fn record_pull(&mut self, version: i64, items: Vec<Diagnostic>) -> Outcome {
        if version != self.version {
            return Outcome::Stale;
        }
        self.last_fresh = Some((version, items));
        Outcome::Fresh
    }

    /// A publish: every publish resets the in-flight count.
    pub(crate) fn record_publish(
        &mut self,
        version: Option<f64>,
        items: Vec<Diagnostic>,
    ) -> Outcome {
        let in_flight = std::mem::take(&mut self.in_flight);
        if let Some(version) = version {
            // Versions are small integers; the comparison is Node's number comparison.
            #[allow(clippy::cast_precision_loss)]
            if version < self.version as f64 {
                return Outcome::Stale;
            }
            self.last_fresh = Some((self.version, items));
            return Outcome::Fresh;
        }
        match in_flight {
            1 => {
                self.last_fresh = Some((self.version, items));
                Outcome::Fresh
            }
            0 => Outcome::Unattributed,
            _ => Outcome::Ambiguous,
        }
    }
}

/// Node `OpenDocument`; `id` tells a reopened document from the one a late pull answer was for.
struct Document {
    id: u64,
    uri: String,
    path: String,
    text: String,
    snapshot: Snapshot,
    freshness: Freshness,
}

/// Node `OpenDocumentStore`, least recently used first.
struct Store {
    connection: Arc<ServerConnection>,
    subscription: u64,
    documents: Vec<Document>,
}

impl Store {
    fn position(&self, uri: &str) -> Option<usize> {
        self.documents
            .iter()
            .position(|document| document.uri == uri)
    }

    fn peek_mut(&mut self, uri: &str) -> Option<&mut Document> {
        self.documents
            .iter_mut()
            .find(|document| document.uri == uri)
    }

    /// Moves the document to the most recently used end.
    fn touch(&mut self, uri: &str) -> Option<&mut Document> {
        let at = self.position(uri)?;
        let document = self.documents.remove(at);
        self.documents.push(document);
        self.documents.last_mut()
    }

    /// Inserts and evicts the least recently used beyond the capacity.
    fn insert(&mut self, document: Document) -> Vec<Document> {
        if let Some(at) = self.position(&document.uri) {
            self.documents.remove(at);
        }
        self.documents.push(document);
        let excess = self.documents.len().saturating_sub(MAX_OPEN_DOCUMENTS);
        self.documents.drain(..excess).collect()
    }
}

/// What a mutation sync found (Node `MutationOutcome`): the last fresh result before it, when the file was open.
#[derive(Debug, Default)]
pub(crate) struct MutationOutcome {
    pub(crate) baseline: Option<Vec<Diagnostic>>,
    /// Whether didOpen/didChange/didClose went out; the LSP tool (D2) waits for fresh results only then.
    #[cfg_attr(not(test), expect(dead_code, reason = "the LSP tool (D2) reads it"))]
    pub(crate) synced: bool,
}

/// One sync's server and file (Node `SyncContext`).
pub(crate) struct SyncContext<'a> {
    pub(crate) key: &'a ServerKey,
    pub(crate) connection: &'a Arc<ServerConnection>,
    pub(crate) language_id: &'a str,
    pub(crate) disk: &'a dyn Disk,
}

type StoreKey = (String, ServerKey);

struct Inner {
    windows: bool,
    stores: Mutex<HashMap<StoreKey, Store>>,
    locks: Mutex<HashMap<(StoreKey, String), Arc<Semaphore>>>,
    ids: AtomicU64,
    /// Bumped on every fresh result and by the session after each sync: waiters re-check their predicate.
    wake: watch::Sender<u64>,
}

/// Node `LspDocumentSync`, one per process. Cheap to clone.
#[derive(Clone)]
pub(crate) struct Documents(Arc<Inner>);

impl Documents {
    pub(crate) fn new(windows: bool) -> Self {
        Self(Arc::new(Inner {
            windows,
            stores: Mutex::default(),
            locks: Mutex::default(),
            ids: AtomicU64::new(1),
            wake: watch::Sender::new(0),
        }))
    }

    pub(crate) fn windows(&self) -> bool {
        self.0.windows
    }

    pub(crate) fn wakeups(&self) -> watch::Receiver<u64> {
        self.0.wake.subscribe()
    }

    pub(crate) fn wake(&self) {
        self.0
            .wake
            .send_modify(|count| *count = count.wrapping_add(1));
    }

    pub(crate) fn uri(&self, path: &str) -> String {
        document_uri(path, self.0.windows)
    }

    /// The current fresh diagnostics of an open document, for any connection of that server and key.
    pub(crate) fn fresh(
        &self,
        server_id: &str,
        key: &ServerKey,
        uri: &str,
    ) -> Option<Vec<Diagnostic>> {
        let stores = self.0.stores.lock_unpoisoned();
        let store = stores.get(&(server_id.to_owned(), key.clone()))?;
        let at = store.position(uri)?;
        store.documents[at].freshness.current_fresh().cloned()
    }

    /// Node `KeyedLock.run`: one sync of a URI at a time.
    async fn lock(&self, store: &StoreKey, uri: &str) -> UriLock {
        let key = (store.clone(), uri.to_owned());
        let semaphore = Arc::clone(
            self.0
                .locks
                .lock_unpoisoned()
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Semaphore::new(1))),
        );
        let permit = Arc::clone(&semaphore).acquire_owned().await.ok();
        UriLock {
            documents: Arc::downgrade(&self.0),
            key: Some(key),
            semaphore,
            permit,
        }
    }

    /// Node `storeFor`: the store of this connection, replacing one of an older connection.
    fn store_for<'s>(
        &self,
        stores: &'s mut HashMap<StoreKey, Store>,
        context: &SyncContext<'_>,
    ) -> &'s mut Store {
        let key = store_key(context);
        let current = stores
            .get(&key)
            .is_some_and(|store| store.connection.id == context.connection.id);
        if !current {
            if let Some(old) = stores.remove(&key) {
                old.connection.unsubscribe(old.subscription);
            }
            let weak = Arc::downgrade(&self.0);
            let (handler_key, connection_id) = (key.clone(), context.connection.id);
            let subscription = context.connection.subscribe(
                "textDocument/publishDiagnostics",
                Arc::new(move |params| {
                    if let Some(inner) = weak.upgrade() {
                        Documents(inner).handle_publish(&handler_key, connection_id, params);
                    }
                }),
            );
            stores.insert(
                key.clone(),
                Store {
                    connection: Arc::clone(context.connection),
                    subscription,
                    documents: Vec::new(),
                },
            );
        }
        stores
            .get_mut(&key)
            .unwrap_or_else(|| unreachable!("inserted above"))
    }

    /// Node `ensureOpen`: opens the file from disk, or re-reads an open one whose mtime or size drifted. Returns the
    /// synced text (the `LSP` tool resolves positions against it).
    pub(crate) async fn ensure_open(
        &self,
        context: &SyncContext<'_>,
        path: &str,
    ) -> Result<String, String> {
        let uri = self.uri(path);
        let _lock = self.lock(&store_key(context), &uri).await;
        let open = {
            let mut stores = self.0.stores.lock_unpoisoned();
            let store = self.store_for(&mut stores, context);
            store.touch(&uri).map(|document| {
                (
                    document.id,
                    document.path.clone(),
                    document.snapshot,
                    document.text.clone(),
                )
            })
        };
        if let Some((id, path, snapshot, current)) = open {
            let stat = context.disk.stat(&path).await?;
            if stat.mtime_ms.is_some() && stat == snapshot {
                return Ok(current);
            }
            let text = context.disk.read(&path).await?;
            let mut stores = self.0.stores.lock_unpoisoned();
            let store = self.store_for(&mut stores, context);
            if let Some(document) = store.peek_mut(&uri).filter(|document| document.id == id) {
                document.snapshot = stat;
                if document.text != text {
                    self.apply_change(
                        context.connection,
                        store_key(context),
                        document,
                        text.clone(),
                    );
                }
            }
            return Ok(text);
        }
        let snapshot = context.disk.stat(path).await?;
        let text = context.disk.read(path).await?;
        let mut stores = self.0.stores.lock_unpoisoned();
        let store = self.store_for(&mut stores, context);
        self.open(context, store, path, &uri, text.clone(), snapshot);
        Ok(text)
    }

    /// Node `applyMutation`: close a deleted file, change an open one, open a new one.
    pub(crate) async fn apply_mutation(
        &self,
        context: &SyncContext<'_>,
        mutation: &FileMutation,
    ) -> Result<MutationOutcome, String> {
        let uri = self.uri(&mutation.path);
        let _lock = self.lock(&store_key(context), &uri).await;
        if mutation.kind == FileMutationKind::Deleted {
            let mut stores = self.0.stores.lock_unpoisoned();
            let store = self.store_for(&mut stores, context);
            let removed = store.position(&uri).map(|at| store.documents.remove(at));
            if removed.is_some() {
                context.connection.notify(
                    "textDocument/didClose",
                    Some(json!({"textDocument": {"uri": uri}})),
                );
            }
            return Ok(MutationOutcome {
                baseline: None,
                synced: removed.is_some(),
            });
        }
        let text = match &mutation.content {
            Some(content) => content.clone(),
            None => context.disk.read(&mutation.path).await?,
        };
        let snapshot = context.disk.stat(&mutation.path).await.unwrap_or(Snapshot {
            size: text.len() as u64,
            mtime_ms: None,
        });
        let mut stores = self.0.stores.lock_unpoisoned();
        let store = self.store_for(&mut stores, context);
        if let Some(document) = store.touch(&uri) {
            let baseline = document.freshness.last_fresh().cloned();
            document.snapshot = snapshot;
            if document.text == text {
                return Ok(MutationOutcome {
                    baseline,
                    synced: false,
                });
            }
            self.apply_change(context.connection, store_key(context), document, text);
            return Ok(MutationOutcome {
                baseline,
                synced: true,
            });
        }
        self.open(context, store, &mutation.path, &uri, text, snapshot);
        Ok(MutationOutcome {
            baseline: None,
            synced: true,
        })
    }

    /// Node `notifyWatchedFile`: type 1 created, 2 changed, 3 deleted.
    pub(crate) fn notify_watched_file(
        &self,
        connection: &ServerConnection,
        mutation: &FileMutation,
    ) {
        let kind = match mutation.kind {
            FileMutationKind::Created => 1,
            FileMutationKind::Changed => 2,
            FileMutationKind::Deleted => 3,
        };
        connection.notify(
            "workspace/didChangeWatchedFiles",
            Some(json!({"changes": [{"uri": self.uri(&mutation.path), "type": kind}]})),
        );
    }

    /// Node `openWithContent`.
    fn open(
        &self,
        context: &SyncContext<'_>,
        store: &mut Store,
        path: &str,
        uri: &str,
        text: String,
        snapshot: Snapshot,
    ) {
        let mut document = Document {
            id: self.0.ids.fetch_add(1, Ordering::Relaxed),
            uri: uri.to_owned(),
            path: path.to_owned(),
            text,
            snapshot,
            freshness: Freshness::default(),
        };
        document.freshness.record_change(INITIAL_VERSION);
        let open = json!({"textDocument": {
            "uri": uri,
            "languageId": context.language_id,
            "version": INITIAL_VERSION,
            "text": document.text,
        }});
        let pull = (document.id, document.text.clone());
        for evicted in store.insert(document) {
            context.connection.notify(
                "textDocument/didClose",
                Some(json!({"textDocument": {"uri": evicted.uri}})),
            );
        }
        context
            .connection
            .notify("textDocument/didOpen", Some(open));
        self.request_pull(
            context.connection,
            store_key(context),
            uri,
            pull,
            INITIAL_VERSION,
        );
    }

    /// Node `applyChange`: a full-text didChange with version + 1, then a pull.
    fn apply_change(
        &self,
        connection: &Arc<ServerConnection>,
        key: StoreKey,
        document: &mut Document,
        text: String,
    ) {
        document.text = text;
        let version = document.freshness.version() + 1;
        document.freshness.record_change(version);
        connection.notify(
            "textDocument/didChange",
            Some(json!({
                "textDocument": {"uri": document.uri, "version": version},
                "contentChanges": [{"text": document.text}],
            })),
        );
        let pull = (document.id, document.text.clone());
        self.request_pull(connection, key, &document.uri, pull, version);
    }

    /// Node `requestPull`: only when the server pulls; `kind: "unchanged"` changes nothing; failures are debug only.
    fn request_pull(
        &self,
        connection: &Arc<ServerConnection>,
        key: StoreKey,
        uri: &str,
        (id, text): (u64, String),
        version: i64,
    ) {
        if !connection.supports_pull() {
            return;
        }
        let weak: Weak<Inner> = Arc::downgrade(&self.0);
        let connection = Arc::clone(connection);
        let uri = uri.to_owned();
        drop(tokio::spawn(async move {
            let params = json!({"textDocument": {"uri": uri}});
            let result = match connection
                .request(PULL_DIAGNOSTICS, Some(params), None, None)
                .await
            {
                Ok(result) => result,
                Err(error) => {
                    tracing::debug!(event = "core.lsp.pull_failed", server_id = %connection.server.id, code = error.code, "LSP pull diagnostics failed");
                    return;
                }
            };
            let Some(items) = pull_items(&result) else {
                return;
            };
            let diagnostics = normalize(&split_lines(&text), &items);
            let Some(inner) = weak.upgrade() else {
                return;
            };
            let documents = Documents(inner);
            let fresh = {
                let mut stores = documents.0.stores.lock_unpoisoned();
                stores
                    .get_mut(&key)
                    .and_then(|store| store.peek_mut(&uri))
                    .filter(|document| document.id == id)
                    .is_some_and(|document| {
                        document.freshness.record_pull(version, diagnostics) == Outcome::Fresh
                    })
            };
            if fresh {
                documents.wake();
            }
        }));
    }

    /// Node `handlePublish`: the URI is matched after normalizing it; a fresh result wakes the waiters.
    fn handle_publish(&self, key: &StoreKey, connection_id: u64, params: &Value) {
        let Some(uri) = params.get("uri").and_then(Value::as_str) else {
            return;
        };
        let uri = normalize_uri(uri, self.0.windows);
        let version = params.get("version").and_then(Value::as_f64);
        let raw: &[Value] = params
            .get("diagnostics")
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice);
        let fresh = {
            let mut stores = self.0.stores.lock_unpoisoned();
            let Some(store) = stores
                .get_mut(key)
                .filter(|store| store.connection.id == connection_id)
            else {
                return;
            };
            let Some(document) = store.peek_mut(&uri) else {
                return;
            };
            let items = normalize(&split_lines(&document.text), raw);
            document.freshness.record_publish(version, items) == Outcome::Fresh
        };
        if fresh {
            self.wake();
        }
    }
}

fn store_key(context: &SyncContext<'_>) -> StoreKey {
    (context.connection.server.id.clone(), context.key.clone())
}

/// Node `pullItems`.
fn pull_items(result: &Value) -> Option<Vec<Value>> {
    let record = result.as_object()?;
    if record.get("kind").and_then(Value::as_str) == Some("unchanged") {
        return None;
    }
    Some(
        record
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    )
}

/// A held per-URI lock; the lock's map entry goes with its last user.
struct UriLock {
    documents: Weak<Inner>,
    key: Option<(StoreKey, String)>,
    semaphore: Arc<Semaphore>,
    permit: Option<OwnedSemaphorePermit>,
}

impl Drop for UriLock {
    fn drop(&mut self) {
        self.permit = None;
        let (Some(inner), Some(key)) = (self.documents.upgrade(), self.key.take()) else {
            return;
        };
        let mut locks = inner.locks.lock_unpoisoned();
        // The map's reference and this one: nobody else waits for it.
        if Arc::strong_count(&self.semaphore) == 2 {
            locks.remove(&key);
        }
    }
}

#[cfg(test)]
#[path = "documents_tests.rs"]
pub(crate) mod tests;
