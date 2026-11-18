//! Reports (Node `engine/engine-report.ts`; spec 9.6): an intermediate result, published synchronously with one
//! journal row and one event. The run-level tally (count and bytes) is restored on resume from the stored rows.
//!
//! Order, as Node: (1) the item's serialization is probed, which gives its byte size; (2) a replay hit is
//! skipped after the input hash is compared; (3) an undeclared preset tag fails the run; (4) the three limits
//! fail the run before anything is counted; (5) the row is written, then the event.
//!
//! The item is a `serde_json::Value`, so the JavaScript-only refusals (a cycle, a bigint, `undefined`) cannot
//! arrive here; the compile-time check and the Node guard live on the script side.
use crate::canon::input_hash;
use crate::engine::{WorkflowDriver, WorkflowEngine};
use crate::error::{ErrorCode, WorkflowError};
use crate::event::RunEvent;
use crate::journal::JournalPort;
use crate::model::{NodeKind, NodeRow, NodeStatus, Ref};
use crate::scheduler::hash_mismatch;
use anyhow::Result;
use rust_cli_base::js::json::stringify;
use serde_json::Value;

/// Node `REPORT_CAPS` (facade/report-caps.ts).
pub const MAX_REPORT_ITEMS_PER_RUN: u64 = 65_536;
pub const MAX_REPORT_ITEM_BYTES: u64 = 1024 * 1024;
pub const MAX_REPORT_BYTES_PER_RUN: u64 = 1024 * 1024 * 1024;

/// Node `ReportTally`: items reported in this run and the sum of their serialized byte lengths.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReportTally {
    pub count: u64,
    pub bytes: u64,
}

impl<J: JournalPort, D: WorkflowDriver> WorkflowEngine<J, D> {
    /// Node `report` (`publishReport`). `artifact_id` is the preset the item also feeds, if any.
    pub fn report(&mut self, site_id: &str, item: Value, artifact_id: Option<&str>) -> Result<()> {
        if self.is_settled() {
            return Ok(());
        }
        let ordinal = self.identity.next_ordinal(site_id);
        let instance = Ref::new(site_id, ordinal);
        let serialized = stringify(&item);
        // The hash covers the item only: the label is a literal at the site, so it cannot change on resume.
        let hash = input_hash(&item);
        if let Some(recorded) = self.journal.get_node(&self.run_id, &instance)? {
            if recorded.input_hash != hash {
                let error = hash_mismatch(&instance, &recorded.input_hash, &hash);
                self.fail_run(error)?;
            }
            return Ok(());
        }
        if let Some(id) = artifact_id
            && !self.is_declared_preset(id)
        {
            let declared = self.declared_preset_ids().join(", ");
            let declared = if declared.is_empty() {
                "(none)".to_owned()
            } else {
                declared
            };
            let error = WorkflowError::new(
                ErrorCode::ArtifactUndeclared,
                format!(
                    "report() tag \"{id}\" is not a declared preset artifact (at {}). Declare it once at the top of the script, e.g. artifact.chart(\"{id}\", …), before tagging reports with it. Declared presets: {declared}.",
                    instance.key(),
                ),
            );
            self.fail_run(error)?;
            return Ok(());
        }
        let bytes = serialized.len() as u64;
        if let Some(error) = self.report_limit_problem(&instance, bytes) {
            self.fail_run(error)?;
            return Ok(());
        }
        self.report_tally.count += 1;
        self.report_tally.bytes += bytes;
        self.journal.put_node(NodeRow {
            run_id: self.run_id.clone(),
            site_id: site_id.to_owned(),
            ordinal,
            kind: NodeKind::Report,
            actor_site_id: None,
            actor_ordinal: None,
            actor_seq: None,
            input_hash: hash,
            status: NodeStatus::Completed,
            result: Some(item.clone()),
            error: None,
            stats: None,
            input: None,
            message_boundary: None,
            artifact_id: artifact_id.map(str::to_owned),
        })?;
        self.record(RunEvent::Report {
            instance,
            item,
            artifact_id: artifact_id.map(str::to_owned),
        })
    }

    /// Node `reserveReport`'s checks, in Node's order: the item, then the run's count, then its bytes.
    fn report_limit_problem(&self, instance: &Ref, bytes: u64) -> Option<WorkflowError> {
        if bytes > MAX_REPORT_ITEM_BYTES {
            return Some(WorkflowError::new(
                ErrorCode::ReportCapExceeded,
                format!(
                    "report() item at {} is {bytes} bytes, over the {MAX_REPORT_ITEM_BYTES}-byte limit. Report a summary instead.",
                    instance.key()
                ),
            ));
        }
        if self.report_tally.count >= MAX_REPORT_ITEMS_PER_RUN {
            return Some(WorkflowError::new(
                ErrorCode::ReportCapExceeded,
                format!(
                    "This run already reported {MAX_REPORT_ITEMS_PER_RUN} items, the maximum. Report findings, not chatter."
                ),
            ));
        }
        let total = self.report_tally.bytes + bytes;
        if total > MAX_REPORT_BYTES_PER_RUN {
            return Some(WorkflowError::new(
                ErrorCode::ReportCapExceeded,
                format!(
                    "report() item at {} would take this run's reports to {total} bytes, over the {MAX_REPORT_BYTES_PER_RUN}-byte limit per run. Report summaries, and publish large results with artifact.file.",
                    instance.key()
                ),
            ));
        }
        None
    }

    /// Node `restoreFromJournal`, the report part: the count and the byte total of the run's report rows, so
    /// the caps continue across resume. `rows` are the run's report rows (their results are present).
    pub(crate) fn restore_report_tally(&mut self, rows: &[NodeRow]) {
        self.report_tally = ReportTally::default();
        for row in rows.iter().filter(|row| row.kind == NodeKind::Report) {
            self.report_tally.count += 1;
            if let Some(result) = &row.result {
                self.report_tally.bytes += stringify(result).len() as u64;
            }
        }
    }
}
