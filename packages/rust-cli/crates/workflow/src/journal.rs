//! The journal port (Node `JournalStorePort`, the run, actor, node and event subset) and its in-memory
//! implementation (Node `InMemoryJournalStore`). The engine's only I/O goes through this trait.
//!
//! Semantics the engine depends on, copied from `journal-memory.ts`:
//! - `update_run_status` to a non-terminal status clears the settlement fields (failure, result,
//!   stop reason, successor); a terminal status rewrites the failure tuple as a whole, and an absent
//!   `result` leaves the stored one untouched.
//! - `put_actor` and `put_node` are full-row upserts. A row keeps its place in insertion order when
//!   it is upserted again (Node's `Map.set` and SQLite's `order by id` agree).
//! - `append_event` numbers events from 0 per run and keeps the exact payload text.
use crate::event::RunEvent;
use crate::model::{ActorRow, Caps, NodeRow, Ref, RunRow, RunStatus, Settlement, StoredEvent};
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
    /// Node `updateRunScript`: the effective script text and its hash, written together.
    fn update_run_script(
        &mut self,
        run_id: &str,
        script_text: &str,
        script_hash: &str,
    ) -> Result<()>;
    fn put_actor(&mut self, row: ActorRow) -> Result<()>;
    fn get_actor(&self, run_id: &str, actor: &Ref) -> Result<Option<ActorRow>>;
    fn list_actors(&self, run_id: &str) -> Result<Vec<ActorRow>>;
    fn put_node(&mut self, row: NodeRow) -> Result<()>;
    fn get_node(&self, run_id: &str, instance: &Ref) -> Result<Option<NodeRow>>;
    fn list_nodes(&self, run_id: &str) -> Result<Vec<NodeRow>>;
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

    fn update_run_script(
        &mut self,
        run_id: &str,
        script_text: &str,
        script_hash: &str,
    ) -> Result<()> {
        (**self).update_run_script(run_id, script_text, script_hash)
    }

    fn put_actor(&mut self, row: ActorRow) -> Result<()> {
        (**self).put_actor(row)
    }

    fn get_actor(&self, run_id: &str, actor: &Ref) -> Result<Option<ActorRow>> {
        (**self).get_actor(run_id, actor)
    }

    fn list_actors(&self, run_id: &str) -> Result<Vec<ActorRow>> {
        (**self).list_actors(run_id)
    }

    fn put_node(&mut self, row: NodeRow) -> Result<()> {
        (**self).put_node(row)
    }

    fn get_node(&self, run_id: &str, instance: &Ref) -> Result<Option<NodeRow>> {
        (**self).get_node(run_id, instance)
    }

    fn list_nodes(&self, run_id: &str) -> Result<Vec<NodeRow>> {
        (**self).list_nodes(run_id)
    }

    fn append_event(&mut self, run_id: &str, event: &RunEvent) -> Result<StoredEvent> {
        (**self).append_event(run_id, event)
    }

    fn list_events(&self, run_id: &str) -> Result<Vec<StoredEvent>> {
        (**self).list_events(run_id)
    }
}

/// One run's rows in insertion order. The keyed maps index into the ordered vectors.
#[derive(Default)]
struct MemoryRun {
    row: Option<RunRow>,
    actors: Ordered<ActorRow>,
    nodes: Ordered<NodeRow>,
    events: Vec<StoredEvent>,
}

/// Insertion-ordered rows keyed by `site@ordinal`.
struct Ordered<T> {
    rows: Vec<T>,
    index: HashMap<String, usize>,
}

impl<T> Default for Ordered<T> {
    fn default() -> Self {
        Self {
            rows: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<T> Ordered<T> {
    fn upsert(&mut self, key: String, row: T) {
        match self.index.get(&key) {
            Some(&position) => self.rows[position] = row,
            None => {
                self.index.insert(key, self.rows.len());
                self.rows.push(row);
            }
        }
    }

    fn get(&self, key: &str) -> Option<&T> {
        self.index.get(key).map(|&position| &self.rows[position])
    }
}

/// In-memory journal (Node `InMemoryJournalStore`).
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

    fn run_mut(&mut self, run_id: &str) -> Result<&mut MemoryRun> {
        match self.runs.get_mut(run_id) {
            Some(run) if run.row.is_some() => Ok(run),
            _ => bail!("journal: unknown run {run_id}"),
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

    fn update_run_script(
        &mut self,
        run_id: &str,
        script_text: &str,
        script_hash: &str,
    ) -> Result<()> {
        let row = self.row_mut(run_id)?;
        row.script_text = Some(script_text.to_owned());
        row.script_hash = Some(script_hash.to_owned());
        Ok(())
    }

    fn put_actor(&mut self, row: ActorRow) -> Result<()> {
        let key = Ref::key_of(&row.site_id, row.ordinal);
        let run = self.run_mut(&row.run_id)?;
        run.actors.upsert(key, row);
        Ok(())
    }

    fn get_actor(&self, run_id: &str, actor: &Ref) -> Result<Option<ActorRow>> {
        Ok(self
            .runs
            .get(run_id)
            .and_then(|run| run.actors.get(&actor.key()))
            .cloned())
    }

    fn list_actors(&self, run_id: &str) -> Result<Vec<ActorRow>> {
        Ok(self
            .runs
            .get(run_id)
            .map(|run| run.actors.rows.clone())
            .unwrap_or_default())
    }

    fn put_node(&mut self, mut row: NodeRow) -> Result<()> {
        let key = Ref::new(row.site_id.clone(), row.ordinal).key();
        let run = self.run_mut(&row.run_id)?;
        // Same rule as DwfJournal::put_node: a row that leaves out the input or the boundary keeps the
        // stored value, so a settlement never resets what the driver or the admission wrote.
        if let Some((input, boundary)) = run
            .nodes
            .get(&key)
            .map(|stored| (stored.input.clone(), stored.message_boundary))
        {
            if row.input.is_none() {
                row.input = input;
            }
            if row.message_boundary.is_none() {
                row.message_boundary = boundary;
            }
        }
        run.nodes.upsert(key, row);
        Ok(())
    }

    fn get_node(&self, run_id: &str, instance: &Ref) -> Result<Option<NodeRow>> {
        Ok(self
            .runs
            .get(run_id)
            .and_then(|run| run.nodes.get(&instance.key()))
            .cloned())
    }

    fn list_nodes(&self, run_id: &str) -> Result<Vec<NodeRow>> {
        Ok(self
            .runs
            .get(run_id)
            .map(|run| run.nodes.rows.clone())
            .unwrap_or_default())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{NodeKind, NodeStatus};
    use serde_json::{Value, json};

    fn run_row(run_id: &str) -> RunRow {
        RunRow {
            run_id: run_id.to_owned(),
            parent_session_id: None,
            cwd: None,
            name: None,
            tool_call_id: None,
            script_text: None,
            script_hash: None,
            args: None,
            resumed_from: None,
            caps: Caps::default(),
            spent_tokens: 0.0,
            status: RunStatus::Running,
            stop_reason: None,
            superseded_by: None,
            failure: None,
            result: None,
        }
    }

    fn ask_row(status: NodeStatus, input: Option<Value>, boundary: Option<u64>) -> NodeRow {
        NodeRow {
            run_id: "run".to_owned(),
            site_id: "ask#1".to_owned(),
            ordinal: 1,
            kind: NodeKind::Ask,
            actor_site_id: Some("actor#1".to_owned()),
            actor_ordinal: Some(1),
            actor_seq: Some(0),
            input_hash: "h".to_owned(),
            status,
            result: None,
            error: None,
            stats: None,
            input,
            message_boundary: boundary,
            artifact_id: None,
        }
    }

    /// Node writes the whole row, but a driver boundary and a world input are columns the settlement does not
    /// rewrite. The memory journal must keep them as the DWF journal does.
    #[test]
    fn a_row_without_boundary_or_input_keeps_the_stored_ones() {
        let mut journal = MemoryJournal::new();
        journal.create_run(run_row("run")).expect("run");
        journal
            .put_node(ask_row(NodeStatus::Running, Some(json!({"op": "x"})), None))
            .expect("admission");
        journal
            .put_node(ask_row(NodeStatus::Completed, None, Some(3)))
            .expect("boundary");
        journal
            .put_node(ask_row(NodeStatus::Completed, None, None))
            .expect("settlement");
        let stored = journal
            .get_node("run", &Ref::new("ask#1", 1))
            .expect("get")
            .expect("row");
        assert_eq!(stored.message_boundary, Some(3));
        assert_eq!(stored.input, Some(json!({"op": "x"})));
    }
}
