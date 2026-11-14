//! Fork: deferred drafts (specs/fork-agent-runtime-selection.md "Draft prewarm in Rust mode").
//!
//! The Node agent keeps a prewarmed session in memory until its first real activity, so an
//! abandoned new task never reaches `db.sqlite`. With [`crate::NodeStore::with_deferred_drafts`]
//! (the app-server only) this store does the same for a top-level interactive session: config
//! batches and command-fact records are buffered, any other write inserts the row and replays the
//! buffer in one transaction, and a delete drops the draft and remembers its id so a late commit
//! from the closing actor cannot bring it back.
use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, TransactionBehavior};
use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::ids::{OwnerEpoch, SessionId};
use rust_cli_kernel_api::store::{
    CommitReceipt, ExecutionWorktree, Fact, FactBatch, FrontendRecord, StoreError,
};

use crate::ids::NodeIds;
use crate::repo::sessions::Create;
use crate::{OrStorage, facts, frontend_records, project_mode};

/// The App protocol's command facts (`protocol-zcode` `inbox::COMMAND_FACT`): written for every
/// session command, including the config commands a prewarm receives, so they are buffered.
/// Every other record kind (the reservation marker first of all) materializes the draft.
const BUFFERED_RECORD_KIND: &str = "v4/command_fact";

/// The drafts of one store. Locked only inside the connection lock (`NodeStore::with_drafts`),
/// or alone for a read, so the two locks are always taken in the same order.
#[derive(Default)]
pub(crate) struct Drafts {
    pending: HashMap<String, Draft>,
    /// Dropped drafts: a later write is `NotFound`, never a new row.
    dropped: HashSet<String>,
}

struct Draft {
    create: Create,
    batches: Vec<FactBatch>,
    records: Vec<FrontendRecord>,
    /// The execution worktree (`path`, `branch`), written with the row like Node's runtime config.
    execution: Option<(String, Option<String>)>,
}

impl Drafts {
    pub(crate) fn hold(&mut self, create: Create) {
        // A new create starts a new life of the id: the actor that held the dropped draft is
        // closed by then, so its tombstone must not reject the new session's writes.
        self.dropped.remove(&create.id);
        // A repeated create of a held draft keeps it and its buffered config.
        self.pending.entry(create.id.clone()).or_insert(Draft {
            create,
            batches: Vec::new(),
            records: Vec::new(),
            execution: None,
        });
    }

    pub(crate) fn is_draft(&self, session: &str) -> bool {
        self.pending.contains_key(session)
    }

    /// Drops a draft; `false` when the session is not one (stored, unknown or already dropped).
    pub(crate) fn discard(&mut self, session: &str) -> bool {
        let held = self.pending.remove(session).is_some();
        if held {
            self.dropped.insert(session.to_owned());
            tracing::info!(
                event = "store.draft.dropped",
                session,
                "the draft was dropped without a row"
            );
        }
        held
    }

    pub(crate) fn was_dropped(&self, session: &str) -> bool {
        self.dropped.contains(session)
    }

    /// The workspace key a draft's row will be listed under (Node `workspaceID ?? directory`); `None` when the
    /// session is not a draft.
    pub(crate) fn workspace_key(&self, session: &str) -> Option<String> {
        self.pending.get(session).map(|draft| {
            draft
                .create
                .workspace_id
                .clone()
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| draft.create.directory.clone())
        })
    }

    /// The workspace a draft's row will hold (`directory`, non-empty `workspace_id`).
    pub(crate) fn workspace(
        &self,
        session: &str,
    ) -> Option<rust_cli_kernel_api::store::SessionWorkspace> {
        self.pending
            .get(session)
            .map(|draft| rust_cli_kernel_api::store::SessionWorkspace {
                directory: draft.create.directory.clone(),
                identity: draft
                    .create
                    .workspace_id
                    .clone()
                    .filter(|id| !id.is_empty()),
            })
    }

    /// The execution worktree a draft's row will hold, beside the parent directory it is listed under; `None` when
    /// the session is not a draft, `Some(None)` for a draft without a worktree.
    pub(crate) fn execution(&self, session: &str) -> Option<Option<ExecutionWorktree>> {
        self.pending.get(session).map(|draft| {
            draft
                .execution
                .as_ref()
                .map(|(path, branch)| ExecutionWorktree {
                    directory: EnvPath::new(&draft.create.directory),
                    path: EnvPath::new(path),
                    branch: branch.clone().filter(|branch| !branch.is_empty()),
                })
        })
    }

    /// The buffered records of a draft; `None` when the session is not a draft.
    pub(crate) fn records(&self, session: &str, kind: &str) -> Option<Vec<FrontendRecord>> {
        self.pending.get(session).map(|draft| {
            draft
                .records
                .iter()
                .filter(|record| record.kind == kind)
                .cloned()
                .collect()
        })
    }
}

fn not_found(session: &SessionId) -> StoreError {
    StoreError::NotFound {
        session: session.clone(),
    }
}

/// Config facts a prewarm commits before anything is sent (create, model and mode changes).
fn is_config(fact: &Fact) -> bool {
    matches!(
        fact,
        Fact::ModelSelected { .. }
            | Fact::ModeChanged { .. }
            | Fact::ExecutionChanged { .. }
            | Fact::ProjectModeSet { .. }
    )
}

/// A commit to a draft: `None` when the session is not a draft (the caller commits as usual).
pub(crate) fn commit(
    conn: &mut Connection,
    drafts: &mut Drafts,
    session: &SessionId,
    batch: &FactBatch,
    ids: &NodeIds,
) -> Result<Option<CommitReceipt>, StoreError> {
    if drafts.was_dropped(session.as_str()) {
        return Err(not_found(session));
    }
    let Some(draft) = drafts.pending.get_mut(session.as_str()) else {
        return Ok(None);
    };
    if batch.owner_epoch != OwnerEpoch::LOCAL {
        return Err(StoreError::StaleOwner {
            session: session.clone(),
        });
    }
    let now = ids.now_ms();
    if !batch.facts.iter().all(is_config) {
        let receipt = materialize(conn, drafts, session, ids, |tx| {
            facts::commit_in(tx, session, batch, ids, now)
        })?;
        return Ok(Some(receipt));
    }
    // Node `setMode` saves the project mode even for a draft; written now and not replayed, so an
    // older buffered mode never overwrites a newer one set from another session.
    let mut buffered = batch.clone();
    buffered
        .facts
        .retain(|fact| !matches!(fact, Fact::ProjectModeSet { .. }));
    for fact in &batch.facts {
        if let Fact::ProjectModeSet { mode } = fact {
            project_mode::write_for_project(conn, now, &draft.create.project_id, *mode)?;
        }
    }
    if !buffered.facts.is_empty() {
        draft.batches.push(buffered);
    }
    let sequence = u64::try_from(draft.batches.len()).unwrap_or(u64::MAX);
    Ok(Some(CommitReceipt { sequence }))
}

/// A frontend record on a draft: `false` when the session is not a draft.
pub(crate) fn put_record(
    conn: &mut Connection,
    drafts: &mut Drafts,
    session: &SessionId,
    record: &FrontendRecord,
    ids: &NodeIds,
) -> Result<bool, StoreError> {
    if drafts.was_dropped(session.as_str()) {
        return Err(not_found(session));
    }
    let Some(draft) = drafts.pending.get_mut(session.as_str()) else {
        return Ok(false);
    };
    if record.kind == BUFFERED_RECORD_KIND {
        // Same key replaces, like the `session_entry` upsert it stands for.
        match draft.records.iter_mut().find(|held| held.key == record.key) {
            Some(held) => *held = record.clone(),
            None => draft.records.push(record.clone()),
        }
        return Ok(true);
    }
    let now = ids.now_ms();
    materialize(conn, drafts, session, ids, |tx| {
        frontend_records::put(tx, session.as_str(), record, now)
    })?;
    Ok(true)
}

/// The execution worktree of a draft: `false` when the session is not a draft. Set once per column,
/// like Node's `coalesce`. A database without the execution columns refuses it now, as it would
/// refuse the stored write, so a worktree session never runs that would resume in the parent.
pub(crate) fn set_execution(
    conn: &Connection,
    drafts: &mut Drafts,
    session: &SessionId,
    path: &str,
    branch: Option<&str>,
) -> Result<bool, StoreError> {
    if drafts.was_dropped(session.as_str()) {
        return Err(not_found(session));
    }
    let Some(draft) = drafts.pending.get_mut(session.as_str()) else {
        return Ok(false);
    };
    if !crate::fork_execution_worktree::has_columns(conn)? {
        return Err(StoreError::Unsupported {
            what: "execution worktree (the database has no execution columns)".to_owned(),
        });
    }
    let (held_path, held_branch) = draft.execution.take().unzip();
    draft.execution = Some((
        held_path.unwrap_or_else(|| path.to_owned()),
        held_branch.flatten().or_else(|| branch.map(str::to_owned)),
    ));
    Ok(true)
}

/// Persists a draft without a write of its own (a rename then runs as for a stored session).
/// `false` when the session is not a draft.
pub(crate) fn persist(
    conn: &mut Connection,
    drafts: &mut Drafts,
    session: &SessionId,
    ids: &NodeIds,
) -> Result<bool, StoreError> {
    Ok(persist_for_input(conn, drafts, session, ids, "")?.persisted)
}

/// Fork: the admission of a session's input (Node `admitInputCommand` →
/// `ensureSessionPersistedForExternalActivity(input.text)`). A draft is persisted with the input's title in the same
/// transaction, as Node `persistSession` creates the row with it; a stored row still on the `default` placeholder (a
/// reservation persisted it) takes the title too (Node `applyFirstInputTitleForPersistedSession`). Either way the
/// title is in place before the input's `UserPromptSubmit` hooks, so a blocked input does not leave "New session".
/// The admission reports the title it wrote for the session actor.
pub(crate) fn persist_for_input(
    conn: &mut Connection,
    drafts: &mut Drafts,
    session: &SessionId,
    ids: &NodeIds,
    input: &str,
) -> Result<rust_cli_kernel_api::store::Admission, StoreError> {
    if drafts.was_dropped(session.as_str()) {
        return Err(not_found(session));
    }
    let now = i64::try_from(ids.now_ms()).unwrap_or(i64::MAX);
    let titled = |conn: &Connection| {
        if input.trim().is_empty() {
            return Ok(None);
        }
        let title = crate::append::first_input_title(conn, session.as_str(), input, now)?;
        // A blank shown input rewrites the placeholder; only a real title is news for the actor.
        Ok(title.filter(|title| title != rust_cli_kernel_api::title::PLACEHOLDER))
    };
    let persisted = drafts.is_draft(session.as_str());
    let title = if persisted {
        materialize(conn, drafts, session, ids, titled)?
    } else {
        titled(conn)?
    };
    Ok(rust_cli_kernel_api::store::Admission { persisted, title })
}

/// One `BEGIN IMMEDIATE` transaction: the row, the buffered batches and records, then `then`. The
/// draft leaves memory only when the transaction committed. Like Node `persistSession` without an
/// input, the row is created now as "New session" (`titleSource: "default"`, which the first
/// input's title replaces), and the buffered config is written now too, as Node backfills the
/// session selection at its first persistence.
fn materialize<T>(
    conn: &mut Connection,
    drafts: &mut Drafts,
    session: &SessionId,
    ids: &NodeIds,
    then: impl FnOnce(&Connection) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let draft = drafts
        .pending
        .get(session.as_str())
        .ok_or_else(|| not_found(session))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .storage()?;
    let now = ids.now_ms();
    let mut create = draft.create.clone();
    if create.title.is_empty() {
        create.title = rust_cli_kernel_api::title::PLACEHOLDER.to_owned();
    }
    create.time_created = None;
    let created = i64::try_from(now).unwrap_or(i64::MAX);
    crate::repo::sessions::create(&tx, &create, created).storage()?;
    if let Some((path, branch)) = &draft.execution {
        crate::fork_execution_worktree::write(&tx, session.as_str(), path, branch.as_deref())?;
    }
    for batch in &draft.batches {
        facts::commit_in(&tx, session, batch, ids, now)?;
    }
    for record in &draft.records {
        frontend_records::put(&tx, session.as_str(), record, now)?;
    }
    let out = then(&tx)?;
    tx.commit().storage()?;
    drafts.pending.remove(session.as_str());
    tracing::info!(event = "store.draft.persisted", session = %session.as_str(), "the draft got its session row");
    Ok(out)
}

#[cfg(test)]
#[path = "drafts_tests.rs"]
mod tests;
