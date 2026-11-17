//! Resume (Node `engine/engine-resume.ts` and `replay-order.ts` `recoverSettleOrder`): the run-level state
//! a resumed lifetime restores from the journal rows and the run's own events.
//!
//! - The settle order comes from the `node-settled` events, not from a column: the first settlement of
//!   each completed or failed instance, in event order. Replay releases cached settlements in that order.
//! - The number of ask rows per actor is counted once, so a new admission waits for every recorded row.
use crate::engine::{WorkflowDriver, WorkflowEngine};
use crate::journal::JournalPort;
use crate::model::{NodeKind, NodeRow, NodeStatus, Ref, StoredEvent};
use crate::replay::ReplayGate;
use anyhow::Result;
use serde_json::Value;
use std::collections::HashSet;

/// Node `recoverSettleOrder`: the instance keys of the settled work, in the order the first lifetime
/// settled them. Only rows that settle a promise on replay are claimable (asks here; reports and
/// artifacts are excluded by the caller).
pub fn recover_settle_order(rows: &[NodeRow], events: &[StoredEvent]) -> Result<Vec<String>> {
    let claimable: HashSet<String> = rows
        .iter()
        .filter(|row| row.status != NodeStatus::Running)
        .map(|row| Ref::new(row.site_id.clone(), row.ordinal).key())
        .collect();
    if claimable.is_empty() {
        return Ok(Vec::new());
    }
    let mut order = Vec::new();
    let mut seen = HashSet::new();
    for event in events {
        let value: Value = serde_json::from_str(&event.payload_json)?;
        if value.get("type").and_then(Value::as_str) != Some("node-settled") {
            continue;
        }
        let Some(key) = instance_key(&value) else {
            continue;
        };
        if seen.contains(&key) || !claimable.contains(&key) {
            continue;
        }
        seen.insert(key.clone());
        order.push(key);
    }
    Ok(order)
}

fn instance_key(event: &Value) -> Option<String> {
    let instance = event.get("instance")?;
    let site = instance.get("siteId")?.as_str()?;
    let ordinal = instance.get("ordinal")?.as_u64()?;
    Some(Ref::new(site, ordinal).key())
}

impl<J: JournalPort, D: WorkflowDriver> WorkflowEngine<J, D> {
    /// Node `restoreFromJournal` for the scheduler: the gate's order and the recorded ask counts.
    pub(crate) fn restore_from_journal(&mut self) -> Result<()> {
        let rows: Vec<NodeRow> = self
            .journal
            .list_nodes(&self.run_id)?
            .into_iter()
            .filter(|row| row.kind != NodeKind::Report && row.kind != NodeKind::Artifact)
            .collect();
        let events = self.journal.list_events(&self.run_id)?;
        let order = recover_settle_order(&rows, &events)?;
        self.gate = ReplayGate::new(&order);
        for row in &rows {
            if row.kind != NodeKind::Ask {
                continue;
            }
            if let (Some(site), Some(ordinal)) = (&row.actor_site_id, row.actor_ordinal) {
                *self
                    .recorded_asks
                    .entry(Ref::new(site.clone(), ordinal).key())
                    .or_insert(0) += 1;
            }
        }
        Ok(())
    }
}
