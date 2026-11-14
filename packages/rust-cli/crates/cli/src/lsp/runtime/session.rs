//! Fork: one session's code intelligence (specs/fork-rust-lsp.md "Diagnostics after edits"), Node core
//! `lsp/service.ts`: prewarm, file mutations and the post-edit report over the process-wide pool and documents.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_ext::plugins::lsp::ResolvedLspServer;
use rust_cli_kernel_api::env_files::PathStyle;
use rust_cli_kernel_api::lsp::{
    FileMutation, FileMutationKind, LspOperation, LspOutput, LspPreferences, LspQuery,
    LspResultStatus,
};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::documents::{Disk, Documents, SyncContext};
use super::edits::{Resolved, Tracker, report, split_lines};
use super::pool::{Acquired, Event, Pool, ServerConnection, ServerKey};
use super::query::{self, LineReader, Projection};
use super::server::{Match, Registry};
use super::{
    DIAGNOSTICS_QUERY_WAIT, EDIT_DIAGNOSTICS_MAX, EDIT_DIAGNOSTICS_MAX_CARRY_ROUNDS,
    EDIT_DIAGNOSTICS_WAIT, LspError,
};

/// The process's preferences as last loaded or set (Node `getPreferences`, synchronous).
pub(crate) type SharedPreferences = Arc<Mutex<LspPreferences>>;

/// Whether a server's command is installed (Node `LanguageServerPort.isInstalled`): the `LSP` tool's availability and
/// its first check before an acquire.
#[async_trait]
pub(crate) trait InstallProbe: Send + Sync {
    async fn installed(&self, server: &ResolvedLspServer) -> bool;
}

/// What one session's runtime shares with the process.
#[derive(Clone)]
pub(crate) struct Shared {
    pub(crate) pool: Pool,
    pub(crate) documents: Documents,
    pub(crate) preferences: SharedPreferences,
    pub(crate) probe: Arc<dyn InstallProbe>,
}

/// Node `LspService` for one session and workspace.
pub(crate) struct SessionLsp {
    shared: Shared,
    registry: Registry,
    key: ServerKey,
    disk: Arc<dyn Disk>,
    tracker: Mutex<Tracker>,
    /// Background syncs and replays; dropping the session aborts them.
    tasks: Mutex<JoinSet<()>>,
    /// Mutations in publish order: Node starts each sync synchronously, so two quick edits of one file reach its
    /// per-URI lock in order; spawned tasks would not.
    mutations: mpsc::UnboundedSender<Queued>,
    /// The last mutation's ordinal; assigned and queued under the tracker lock, so queue order is ordinal order.
    ordinal: AtomicU64,
    listener: u64,
}

/// One published mutation, its server, whether its diagnostics are tracked, and its ordinal.
type Queued = (Match, FileMutation, bool, u64);

impl SessionLsp {
    pub(crate) fn new(
        shared: Shared,
        registry: Registry,
        key: ServerKey,
        disk: Arc<dyn Disk>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|weak: &Weak<Self>| {
            let (mutations, mut queued) = mpsc::unbounded_channel::<Queued>();
            let mut tasks = JoinSet::new();
            let worker = weak.clone();
            tasks.spawn(async move {
                while let Some((found, mutation, track, ordinal)) = queued.recv().await {
                    let Some(session) = worker.upgrade() else {
                        return;
                    };
                    session.sync(&found, &mutation, track, ordinal).await;
                }
            });
            let weak = weak.clone();
            let listener = shared.pool.subscribe(Arc::new(move |event: &Event| {
                if let (
                    Some(session),
                    Event::Ready {
                        server_id,
                        key,
                        connection,
                    },
                ) = (weak.upgrade(), event)
                {
                    session.on_ready(server_id, key, connection);
                }
            }));
            Self {
                shared,
                registry,
                key,
                disk,
                tracker: Mutex::default(),
                tasks: Mutex::new(tasks),
                mutations,
                ordinal: AtomicU64::new(0),
                listener,
            }
        })
    }

    fn enabled(&self) -> bool {
        self.shared.preferences.lock_unpoisoned().enabled
    }

    /// Node `diagnosticsAfterEdit`: the preference override, else the server's own.
    fn diagnostics_after_edit(&self, server: &ResolvedLspServer) -> bool {
        self.shared
            .preferences
            .lock_unpoisoned()
            .diagnostics_after_edit
            .get(&server.id)
            .and_then(Value::as_bool)
            .unwrap_or(server.diagnostics_after_edit)
    }

    fn spawn(&self, task: impl Future<Output = ()> + Send + 'static) {
        let mut tasks = self.tasks.lock_unpoisoned();
        while tasks.try_join_next().is_some() {}
        tasks.spawn(task);
    }

    pub(crate) fn has_pending(&self) -> bool {
        !self.tracker.lock_unpoisoned().is_empty()
    }

    /// Node `prewarm`: acquire only.
    pub(crate) fn prewarm(&self, path: &str) {
        if !self.enabled() {
            return;
        }
        if let Some(found) = self.registry.for_file(path) {
            let _ = self
                .shared
                .pool
                .acquire_when(&found.server, &self.key, || self.enabled());
        }
    }

    /// Node `onFileMutated`: recorded before it returns, synced in the background.
    pub(crate) fn file_mutated(self: &Arc<Self>, mutation: FileMutation) {
        if !self.enabled() {
            return;
        }
        let Some(found) = self.registry.for_file(&mutation.path) else {
            return;
        };
        let diagnostics = self.diagnostics_after_edit(&found.server);
        let deleted = mutation.kind == FileMutationKind::Deleted;
        let mut tracker = self.tracker.lock_unpoisoned();
        let ordinal = self.ordinal.fetch_add(1, Ordering::Relaxed) + 1;
        if deleted {
            tracker.remove(&mutation.path);
        } else if diagnostics {
            tracker.record_syncing(
                &mutation.path,
                &found.server.id,
                mutation.changed_range,
                Instant::now(),
                ordinal,
            );
        }
        let _ = self
            .mutations
            .send((found, mutation, diagnostics && !deleted, ordinal));
    }

    async fn sync(&self, found: &Match, mutation: &FileMutation, track: bool, ordinal: u64) {
        if let Err(error) = self.run_mutation(found, mutation, track, ordinal).await {
            // A failed sync must not leave the edit "syncing", or every later request would wait the full bound; a
            // newer mutation of the file keeps its own record.
            self.tracker
                .lock_unpoisoned()
                .remove_up_to(&mutation.path, ordinal);
            tracing::warn!(event = "core.lsp.warn", operation = "mutation", server_id = %found.server.id, %error, "LSP operation failed");
        }
        self.shared.documents.wake();
    }

    /// Node `runMutation`.
    async fn run_mutation(
        &self,
        found: &Match,
        mutation: &FileMutation,
        track: bool,
        ordinal: u64,
    ) -> Result<(), String> {
        let connection = {
            // Acquire and mark under the tracker lock: the ready listener takes it too, so a server that becomes ready
            // right after `Starting` still finds the edit marked (Node does both in one synchronous step).
            let mut tracker = self.tracker.lock_unpoisoned();
            // Node checks and acquires when the mutation is published; a queued one must not start a server after
            // code intelligence was turned off, so the pool reads the switch under the lock `stop_all` takes.
            let Some(acquired) = self
                .shared
                .pool
                .acquire_when(&found.server, &self.key, || self.enabled())
            else {
                tracker.remove_up_to(&mutation.path, ordinal);
                return Ok(());
            };
            match acquired {
                // A failed server never publishes; keeping the edit would only report "pending" for the carry rounds.
                Acquired::Failed(_) => {
                    tracker.remove_up_to(&mutation.path, ordinal);
                    return Ok(());
                }
                Acquired::Starting => {
                    if track {
                        tracker.mark_needs_sync(&mutation.path, ordinal);
                    }
                    return Ok(());
                }
                Acquired::Ready(connection) => connection,
            }
        };
        let context = SyncContext {
            key: &self.key,
            connection: &connection,
            language_id: &found.language_id,
            disk: self.disk.as_ref(),
        };
        self.shared
            .documents
            .notify_watched_file(&connection, mutation);
        let outcome = self
            .shared
            .documents
            .apply_mutation(&context, mutation)
            .await?;
        if track {
            self.tracker
                .lock_unpoisoned()
                .settle(&mutation.path, outcome.baseline, ordinal);
        }
        Ok(())
    }

    /// Node `onServerEvent`: edits made while the server started are opened once it is ready, for this key only.
    fn on_ready(
        self: &Arc<Self>,
        server_id: &str,
        key: &ServerKey,
        connection: &Arc<ServerConnection>,
    ) {
        if *key != self.key {
            return;
        }
        let pending: Vec<(String, u64)> = self
            .tracker
            .lock_unpoisoned()
            .entries()
            .iter()
            .filter(|entry| entry.needs_sync && entry.server_id == server_id)
            .map(|entry| (entry.path.clone(), entry.ordinal))
            .collect();
        if pending.is_empty() {
            return;
        }
        let session = Arc::downgrade(self);
        let connection = Arc::clone(connection);
        self.spawn(async move {
            let Some(session) = session.upgrade() else {
                return;
            };
            for (path, ordinal) in pending {
                let Some(found) = session.registry.for_file(&path) else {
                    continue;
                };
                let context = SyncContext {
                    key: &session.key,
                    connection: &connection,
                    language_id: &found.language_id,
                    disk: session.disk.as_ref(),
                };
                match session.shared.documents.ensure_open(&context, &path).await {
                    Ok(_) => session
                        .tracker
                        .lock_unpoisoned()
                        .settle(&path, None, ordinal),
                    Err(error) => {
                        tracing::warn!(event = "core.lsp.warn", operation = "replay", server_id = %connection.server.id, %error, "LSP operation failed");
                        session
                            .tracker
                            .lock_unpoisoned()
                            .remove_up_to(&path, ordinal);
                    }
                }
            }
            session.shared.documents.wake();
        });
    }

    /// Node `isAvailable` after its enabled check: a declared server is installed.
    pub(crate) async fn any_installed(&self) -> bool {
        for server in self.registry.servers() {
            if self.shared.probe.installed(server).await {
                return true;
            }
        }
        false
    }

    /// Node `runLspQuery`. `query.file_path` is absolute.
    pub(crate) async fn query(
        &self,
        query: &LspQuery,
        cancel: &CancellationToken,
    ) -> Result<LspOutput, LspError> {
        let disabled = || LspError::new("lsp_disabled", "Code intelligence is turned off");
        if !self.enabled() {
            return Err(disabled());
        }
        let operation = query.operation;
        let style = if self.shared.documents.windows() {
            PathStyle::Windows
        } else {
            PathStyle::Posix
        };
        // Node `matchFor`: the tool resolves `filePath`, so this guards other callers.
        if !style.is_absolute(&query.file_path) {
            return Err(LspError::new(
                "lsp_invalid_position",
                "filePath must be absolute",
            ));
        }
        let found = self.registry.for_file(&query.file_path).ok_or_else(|| {
            LspError::new(
                "lsp_no_server_for_file",
                format!(
                    "No language server is configured for {} on this file type",
                    operation.as_str()
                ),
            )
        })?;
        let server = &found.server;
        if !self.shared.probe.installed(server).await {
            return Err(LspError::new(
                "lsp_server_not_installed",
                format!(
                    "Language server {} is not installed on this machine",
                    server.id
                ),
            ));
        }
        let connection = match self
            .shared
            .pool
            .acquire_when(server, &self.key, || self.enabled())
            .ok_or_else(disabled)?
        {
            Acquired::Ready(connection) => connection,
            Acquired::Starting => {
                return Err(LspError::new(
                    "lsp_server_starting",
                    format!(
                        "Language server {} is starting; retry shortly; use Grep meanwhile",
                        server.id
                    ),
                ));
            }
            Acquired::Failed(error) => return Err(error),
        };
        if !query::supports(connection.capabilities(), operation) {
            return Err(LspError::new(
                "lsp_operation_unsupported",
                format!(
                    "Language server {} does not support {}",
                    server.id,
                    operation.as_str()
                ),
            ));
        }
        let documents = &self.shared.documents;
        let windows = documents.windows();
        let mut reader = LineReader::new(self.disk.as_ref());
        let mut projection = Projection {
            operation,
            server_id: &server.id,
            document_uri: "",
            workspace: &self.key.workspace,
            windows,
            status: LspResultStatus::Ok,
        };
        if operation == LspOperation::WorkspaceSymbol {
            let (method, params) =
                query::request(operation, "", (0, 0), None, query.query.as_deref())
                    .unwrap_or_else(|| unreachable!("workspaceSymbol has a request"));
            let raw = connection
                .request(method, Some(params), None, Some(cancel))
                .await?;
            return query::project(&projection, &raw, &mut reader).await;
        }

        let context = SyncContext {
            key: &self.key,
            connection: &connection,
            language_id: &found.language_id,
            disk: self.disk.as_ref(),
        };
        let text = documents
            .ensure_open(&context, &query.file_path)
            .await
            .map_err(|error| LspError::new("lsp_document_unreadable", error))?;
        let uri = documents.uri(&query.file_path);
        if operation == LspOperation::Diagnostics {
            return Ok(self
                .diagnostics(&server.id, &query.file_path, &uri, cancel)
                .await);
        }
        let position = if operation.positional() {
            let line = query.line.ok_or_else(|| {
                LspError::new(
                    "lsp_invalid_position",
                    "line is required for this operation",
                )
            })?;
            query::resolve_position(
                &split_lines(&text),
                line,
                query.character,
                query.symbol.as_deref(),
            )?
        } else {
            (0, 0)
        };
        let (method, params) =
            query::request(operation, &uri, position, query.include_declaration, None)
                .unwrap_or_else(|| unreachable!("every operation but diagnostics has a request"));
        let raw = connection
            .request(method, Some(params), None, Some(cancel))
            .await?;
        projection.document_uri = &uri;
        query::project(&projection, &raw, &mut reader).await
    }

    /// Node `diagnosticsOperation`: waits for a result fresh for the current version, woken by the documents; a
    /// cancelled call stops waiting.
    async fn diagnostics(
        &self,
        server_id: &str,
        path: &str,
        uri: &str,
        cancel: &CancellationToken,
    ) -> LspOutput {
        let documents = &self.shared.documents;
        let deadline = Instant::now() + DIAGNOSTICS_QUERY_WAIT;
        let mut wakeups = documents.wakeups();
        let fresh = loop {
            wakeups.borrow_and_update();
            if let Some(items) = documents.fresh(server_id, &self.key, uri) {
                break Some(items);
            }
            tokio::select! {
                changed = wakeups.changed() => if changed.is_err() { break None },
                () = tokio::time::sleep_until(deadline) => break None,
                () = cancel.cancelled() => break None,
            }
        };
        // The last check after the wait, as Node's `finish` re-reads the predicate.
        let fresh = fresh.or_else(|| documents.fresh(server_id, &self.key, uri));
        let windows = documents.windows();
        match fresh {
            Some(items) => query::project_diagnostics(
                server_id,
                path,
                &items,
                &self.key.workspace,
                windows,
                LspResultStatus::Ok,
            ),
            None => query::project_diagnostics(
                server_id,
                path,
                &[],
                &self.key.workspace,
                windows,
                LspResultStatus::Pending,
            ),
        }
    }

    /// Fresh diagnostics of a pending edit, or None while it is syncing or not fresh.
    fn fresh_items(
        &self,
        entry: &super::edits::PendingEdit,
    ) -> Option<Vec<super::edits::Diagnostic>> {
        if entry.syncing || entry.needs_sync {
            return None;
        }
        let documents = &self.shared.documents;
        documents.fresh(&entry.server_id, &self.key, &documents.uri(&entry.path))
    }

    fn all_fresh(&self) -> bool {
        let entries = self.tracker.lock_unpoisoned().entries().to_vec();
        entries
            .iter()
            .all(|entry| self.fresh_items(entry).is_some())
    }

    /// Node `collectEditDiagnostics`. Dropping the future while it waits consumes nothing.
    pub(crate) async fn edit_diagnostics(&self) -> Option<String> {
        if !self.enabled() {
            self.tracker.lock_unpoisoned().clear();
            return None;
        }
        let started = Instant::now();
        let deadline = {
            let tracker = self.tracker.lock_unpoisoned();
            if tracker.is_empty() {
                return None;
            }
            tracker.last_mutation().unwrap_or(started) + EDIT_DIAGNOSTICS_WAIT
        };
        let mut wakeups = self.shared.documents.wakeups();
        loop {
            wakeups.borrow_and_update();
            if self.all_fresh() {
                break;
            }
            tokio::select! {
                changed = wakeups.changed() => if changed.is_err() { break },
                () = tokio::time::sleep_until(deadline) => break,
            }
        }

        // One tracker lock for the whole step: a mutation published meanwhile must not be consumed or dropped as the
        // entry it replaced (Node's consume step is synchronous).
        let mut resolved = Vec::new();
        let mut pending_count = 0;
        {
            let mut tracker = self.tracker.lock_unpoisoned();
            for entry in tracker.entries().to_vec() {
                if let Some(current) = self.fresh_items(&entry) {
                    tracker.remove(&entry.path);
                    resolved.push(Resolved { entry, current });
                } else if tracker.carry(&entry.path, EDIT_DIAGNOSTICS_MAX_CARRY_ROUNDS) {
                    pending_count += 1;
                }
            }
        }
        let report = report(
            &resolved,
            pending_count,
            &self.key.workspace,
            EDIT_DIAGNOSTICS_MAX,
            self.shared.documents.windows(),
        );
        let body = report.body?;
        let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        tracing::info!(
            event = "core.lsp.edit_diagnostics",
            server_ids = ?report.server_ids,
            error_count = report.error_count,
            warning_count = report.warning_count,
            latency_ms,
            no_baseline = report.no_baseline,
            "Post-edit diagnostics attached"
        );
        Some(body)
    }
}

impl Drop for SessionLsp {
    fn drop(&mut self) {
        self.shared.pool.unsubscribe(self.listener);
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
pub(crate) mod tests;
