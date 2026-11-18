//! Resume (Node `engine/engine-resume.ts` and `replay-order.ts` `recoverSettleOrder`): the run-level state
//! a resumed lifetime restores from the journal rows and the run's own events.
//!
//! - The settle order comes from the `node-settled` events, not from a column: the first settlement of
//!   each completed or failed instance, in event order. Replay releases cached settlements in that order.
//! - The number of ask rows per actor is counted once, so a new admission waits for every recorded row.
use crate::engine::{WorkflowDriver, WorkflowEngine};
use crate::engine_artifacts::is_preset_op;
use crate::engine_world::recover_import_closure;
use crate::journal::JournalPort;
use crate::model::{NodeKind, NodeRow, NodeStatus, Ref, StoredEvent};
use crate::replay::ReplayGate;
use anyhow::Result;
use serde_json::Value;
use std::collections::HashSet;

/// Node `recoverSettleOrder`: the instance keys of the settled work, in the order the first lifetime
/// settled them. Node's `claimsOnReplay` admits a work row once it is `completed` or `failed`; this port
/// keeps the same test (`status != Running`, since `NodeStatus` has no other value). The caller passes the
/// work rows and the artifact rows that claim the gate (`claims_on_replay`); reports never do.
pub fn recover_settle_order(
    run_id: &str,
    rows: &[NodeRow],
    events: &[StoredEvent],
) -> Result<Vec<String>> {
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
        let value: Value = serde_json::from_str(&event.payload_json).map_err(|error| {
            anyhow::anyhow!(
                "run {run_id}: event at sequence {} is not JSON: {error}",
                event.sequence
            )
        })?;
        if !matches!(
            value.get("type").and_then(Value::as_str),
            Some("node-settled" | "artifact-published" | "artifact-failed")
        ) {
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

/// Node `claimsOnReplay` for an artifact row: a failure claims; a content member claims; a preset declaration is
/// synchronous and does not.
fn claims_on_replay(row: &NodeRow) -> bool {
    if row.status == NodeStatus::Failed {
        return true;
    }
    row.result
        .as_ref()
        .and_then(|result| result.get("kind"))
        .and_then(Value::as_str)
        .is_some_and(|kind| !is_preset_op(kind))
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
        let all_rows: Vec<NodeRow> = self.journal.list_nodes(&self.run_id)?;
        let rows: Vec<NodeRow> = all_rows
            .iter()
            .filter(|row| row.kind != NodeKind::Report && row.kind != NodeKind::Artifact)
            .cloned()
            .collect();
        // Artifact rows settle through the same gate (Node `readReplayRows`): a failure or a content member claims
        // its slot, a preset declaration does not.
        let claims: Vec<NodeRow> = rows
            .iter()
            .cloned()
            .chain(
                all_rows
                    .iter()
                    .filter(|row| row.kind == NodeKind::Artifact && claims_on_replay(row))
                    .cloned(),
            )
            .collect();
        // World rows settle through the replay gate too (Node `heldResolution`), so they claim order slots like
        // asks do. `recover_settle_order` takes them from the same `node-settled` events.
        let events = self.journal.list_events(&self.run_id)?;
        let order = recover_settle_order(&self.run_id, &claims, &events)?;
        self.gate = ReplayGate::new(&order);
        // Node `recoverImportClosure`: the closure state and the asks that ran live, from this run's events.
        // Only an amended run has a cache to recover.
        if self.imported_cache.is_some() {
            let recovered = recover_import_closure(&events);
            self.live_before_resume = recovered.live;
            self.queued_before_close = recovered.queued_before_close;
            self.import_closed = recovered.closed;
        }
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
        // Artifact ids and the report tally continue across resume (Node `restoreFromJournal`).
        self.restore_artifacts(&all_rows);
        self.restore_report_tally(&all_rows);
        Ok(())
    }
}
