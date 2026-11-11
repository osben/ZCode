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
use rust_cli_kernel_api::ids::{OwnerEpoch, SessionId};
use rust_cli_kernel_api::store::{CommitReceipt, Fact, FactBatch, FrontendRecord, StoreError};

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
    created_at: u64,
    batches: Vec<(FactBatch, u64)>,
    records: Vec<(FrontendRecord, u64)>,
}

impl Drafts {
    pub(crate) fn hold(&mut self, create: Create, now: u64) {
        // A new create starts a new life of the id: the actor that held the dropped draft is
        // closed by then, so its tombstone must not reject the new session's writes.
        self.dropped.remove(&create.id);
        self.pending.insert(
            create.id.clone(),
            Draft {
                create,
                created_at: now,
                batches: Vec::new(),
                records: Vec::new(),
            },
        );
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

    /// The buffered records of a draft; `None` when the session is not a draft.
    pub(crate) fn records(&self, session: &str, kind: &str) -> Option<Vec<FrontendRecord>> {
        self.pending.get(session).map(|draft| {
            draft
                .records
                .iter()
                .filter(|(record, _)| record.kind == kind)
                .map(|(record, _)| record.clone())
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
        draft.batches.push((buffered, now));
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
    let now = ids.now_ms();
    if record.kind == BUFFERED_RECORD_KIND {
        // Same key replaces, like the `session_entry` upsert it stands for.
        match draft
            .records
            .iter_mut()
            .find(|(held, _)| held.key == record.key)
        {
            Some(held) => *held = (record.clone(), now),
            None => draft.records.push((record.clone(), now)),
        }
        return Ok(true);
    }
    materialize(conn, drafts, session, ids, |tx| {
        frontend_records::put(tx, session.as_str(), record, now)
    })?;
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
    if drafts.was_dropped(session.as_str()) {
        return Err(not_found(session));
    }
    if !drafts.is_draft(session.as_str()) {
        return Ok(false);
    }
    materialize(conn, drafts, session, ids, |_| Ok(()))?;
    Ok(true)
}

/// One `BEGIN IMMEDIATE` transaction: the row, the buffered batches and records with their own
/// times, then `then`. The draft leaves memory only when the transaction committed.
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
    let created = i64::try_from(draft.created_at).unwrap_or(i64::MAX);
    crate::repo::sessions::create(&tx, &draft.create, created).storage()?;
    for (batch, at) in &draft.batches {
        facts::commit_in(&tx, session, batch, ids, *at)?;
    }
    for (record, at) in &draft.records {
        frontend_records::put(&tx, session.as_str(), record, *at)?;
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
