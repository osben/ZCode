//! The journal port (Node `JournalStorePort`, the run and event subset) and its in-memory implementation
//! (Node `InMemoryJournalStore`). The engine's only I/O goes through this trait.
//!
//! Semantics the engine depends on, copied from `journal-memory.ts`:
//! - `update_run_status` to a non-terminal status clears the settlement fields (failure, result,
//!   stop reason, successor); a terminal status rewrites the failure tuple as a whole, and an absent
//!   `result` leaves the stored one untouched.
//! - `append_event` numbers events from 0 per run and keeps the exact payload text.
use crate::event::RunEvent;
use crate::model::{Caps, RunRow, RunStatus, Settlement, StoredEvent};
use anyhow::{Result, bail};
use std::collections::HashMap;

pub trait JournalPort {
    fn create_run(&mut self, row: RunRow) -> Result<()>;
    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>>;
    fn update_run_status(
        &mut self,
        run_id: &str,
        status: RunStatus,
        settlement: &Settlement,
    ) -> Result<()>;
    fn update_run_usage(&mut self, run_id: &str, spent_tokens: f64) -> Result<()>;
    fn update_run_caps(&mut self, run_id: &str, caps: Caps) -> Result<()>;
    fn append_event(&mut self, run_id: &str, event: &RunEvent) -> Result<StoredEvent>;
    fn list_events(&self, run_id: &str) -> Result<Vec<StoredEvent>>;
}

impl<T: JournalPort + ?Sized> JournalPort for &mut T {
    fn create_run(&mut self, row: RunRow) -> Result<()> {
        (**self).create_run(row)
    }

    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>> {
        (**self).get_run(run_id)
    }

    fn update_run_status(
        &mut self,
        run_id: &str,
        status: RunStatus,
        settlement: &Settlement,
    ) -> Result<()> {
        (**self).update_run_status(run_id, status, settlement)
    }

    fn update_run_usage(&mut self, run_id: &str, spent_tokens: f64) -> Result<()> {
        (**self).update_run_usage(run_id, spent_tokens)
    }

    fn update_run_caps(&mut self, run_id: &str, caps: Caps) -> Result<()> {
        (**self).update_run_caps(run_id, caps)
    }

    fn append_event(&mut self, run_id: &str, event: &RunEvent) -> Result<StoredEvent> {
        (**self).append_event(run_id, event)
    }

    fn list_events(&self, run_id: &str) -> Result<Vec<StoredEvent>> {
        (**self).list_events(run_id)
    }
}

#[derive(Default)]
struct MemoryRun {
    row: Option<RunRow>,
    events: Vec<StoredEvent>,
}

/// In-memory journal (Node `InMemoryJournalStore`, runs and events).
#[derive(Default)]
pub struct MemoryJournal {
    runs: HashMap<String, MemoryRun>,
}

impl MemoryJournal {
    pub fn new() -> Self {
        Self::default()
    }

    fn row_mut(&mut self, run_id: &str) -> Result<&mut RunRow> {
        match self.runs.get_mut(run_id).and_then(|run| run.row.as_mut()) {
            Some(row) => Ok(row),
            None => bail!("journal: unknown run {run_id}"),
        }
    }
}

impl JournalPort for MemoryJournal {
    fn create_run(&mut self, row: RunRow) -> Result<()> {
        if self
            .runs
            .get(&row.run_id)
            .is_some_and(|run| run.row.is_some())
        {
            bail!("journal: run {} already exists", row.run_id);
        }
        let run_id = row.run_id.clone();
        self.runs.entry(run_id).or_default().row = Some(row);
        Ok(())
    }

    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>> {
        Ok(self.runs.get(run_id).and_then(|run| run.row.clone()))
    }

    fn update_run_status(
        &mut self,
        run_id: &str,
        status: RunStatus,
        settlement: &Settlement,
    ) -> Result<()> {
        let row = self.row_mut(run_id)?;
        row.status = status;
        if matches!(status, RunStatus::Pending | RunStatus::Running) {
            row.failure = None;
            row.result = None;
            row.stop_reason = None;
            row.superseded_by = None;
            return Ok(());
        }
        row.stop_reason = settlement.stop_reason;
        row.superseded_by = settlement.superseded_by.clone();
        row.failure = settlement.failure.clone();
        if settlement.result.is_some() {
            row.result = settlement.result.clone();
        }
        Ok(())
    }

    fn update_run_usage(&mut self, run_id: &str, spent_tokens: f64) -> Result<()> {
        self.row_mut(run_id)?.spent_tokens = spent_tokens;
        Ok(())
    }

    fn update_run_caps(&mut self, run_id: &str, caps: Caps) -> Result<()> {
        self.row_mut(run_id)?.caps = caps;
        Ok(())
    }

    fn append_event(&mut self, run_id: &str, event: &RunEvent) -> Result<StoredEvent> {
        let Some(run) = self.runs.get_mut(run_id) else {
            bail!("journal: unknown run {run_id}");
        };
        let stored = StoredEvent {
            sequence: run.events.len() as u64,
            payload_json: event.payload_json(),
        };
        run.events.push(stored.clone());
        Ok(stored)
    }

    fn list_events(&self, run_id: &str) -> Result<Vec<StoredEvent>> {
        Ok(self
            .runs
            .get(run_id)
            .map(|run| run.events.clone())
            .unwrap_or_default())
    }
}
