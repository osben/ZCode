//! Fork: the session's `completedActivityCount` (v4 snapshot and `state.updated`), the number of successful
//! standalone subagents plus completed workflow runs across the whole session history. Node keeps it in
//! `product-projection.ts` (`setSubagentOutcome`, `setWorkflowOutcome`, `markWorkflowChild`); the product rule is
//! `docs/ui/chat-summary-panel.md` and `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md`
//! ("Activity 成功总数"). Rules and owners: specs/fork-rust-activity-summary.md.
//!
//! The value is derived from keyed outcomes, never accumulated from events, so a repeated or replayed fact cannot add
//! up, and a resume of the same id takes it out until it succeeds again. The full history comes from a cold seed (the
//! workflow journal and the store's subagent classification); live facts only update known keys or add new ones.
//! `None` (null on the wire) means the full history could not be read: the UI must not take a partial count as the
//! total.

use std::collections::{HashMap, HashSet};

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::panels::{SubagentEntry, SubagentStatus};
use rust_cli_kernel_api::store::StoreQueries;
use rust_cli_kernel_api::workflow_run::DynamicWorkflowRunPort;
use serde_json::{Map, Value};

/// The full-history read a session open (or a rewind) supplies.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Seed {
    /// Every workflow run of the session: `(runId, status, last event sequence)`.
    pub runs: Vec<(String, String, i64)>,
    /// Every actor session of those runs (Node `workflowChildSessionIds`).
    pub workflow_children: Vec<String>,
    /// Every ended child on the session's active branch with its ended status (`success`, `failed`, ...).
    pub children: Vec<(String, String)>,
}

#[derive(Debug, Default)]
pub(crate) struct CompletedActivity {
    unknown: bool,
    children: HashMap<String, String>,
    runs: HashMap<String, (String, i64)>,
    workflow_children: HashSet<String>,
}

impl CompletedActivity {
    /// The state a session opens with: a cold open of a session with stored history does not know its total until the
    /// seed lands (Node's history-first first frame, null); a new empty session is 0.
    pub(crate) fn opened(has_history: bool) -> Self {
        Self {
            unknown: has_history,
            ..Self::default()
        }
    }

    /// A full-history read: `None` when it failed. Child outcomes are replaced (the read is the active branch, so a
    /// rewind drops the cut children); runs merge by sequence, so a live fact newer than the read is kept.
    pub(crate) fn seed(&mut self, seed: Option<Seed>) {
        let Some(seed) = seed else {
            self.unknown = true;
            return;
        };
        self.unknown = false;
        self.children = seed.children.into_iter().collect();
        for (run_id, status, sequence) in seed.runs {
            self.run(&run_id, &status, sequence);
        }
        self.workflow_children.extend(seed.workflow_children);
    }

    /// A child's live outcome: `Some(status)` once it ended, `None` while it runs (again).
    pub(crate) fn child(&mut self, child_id: &str, status: Option<&str>) {
        match status {
            Some(status) => {
                self.children.insert(child_id.to_owned(), status.to_owned());
            }
            None => {
                self.children.remove(child_id);
            }
        }
    }

    /// A run's status at `sequence`. An older fact than the known one is ignored.
    pub(crate) fn run(&mut self, run_id: &str, status: &str, sequence: i64) {
        if self
            .runs
            .get(run_id)
            .is_some_and(|(_, known)| *known > sequence)
        {
            return;
        }
        self.runs
            .insert(run_id.to_owned(), (status.to_owned(), sequence));
    }

    /// A workflow actor session: its own outcome never counts as a standalone subagent.
    pub(crate) fn workflow_child(&mut self, child_id: &str) {
        if !self.workflow_children.contains(child_id) {
            self.workflow_children.insert(child_id.to_owned());
        }
    }

    /// The kernel's subagent table: a running entry is no outcome (again), an ended one is its terminal status.
    pub(crate) fn table(&mut self, entries: &[SubagentEntry]) {
        for entry in entries {
            self.child(entry.child.as_str(), table_status(entry.status));
        }
    }

    /// The session's folded `workflowRuns`: each run's status at its `lastEventSequence`, and its actor sessions.
    /// Runs evicted from the bounded preview are not in `runs` and keep their known outcome.
    pub(crate) fn fold_runs(&mut self, runs: &[Map<String, Value>]) {
        for run in runs {
            let (Some(run_id), Some(status)) = (
                run.get("runId").and_then(Value::as_str),
                run.get("status").and_then(Value::as_str),
            ) else {
                continue;
            };
            let sequence = run
                .get("lastEventSequence")
                .and_then(Value::as_i64)
                .unwrap_or(-1);
            self.run(run_id, status, sequence);
            for actor in run
                .get("actors")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(session) = actor.get("sessionId").and_then(Value::as_str) {
                    self.workflow_child(session);
                }
            }
        }
    }

    pub(crate) fn count(&self) -> Option<u64> {
        if self.unknown {
            return None;
        }
        let children = self
            .children
            .iter()
            .filter(|(id, status)| {
                status.as_str() == "success" && !self.workflow_children.contains(*id)
            })
            .count();
        let runs = self
            .runs
            .values()
            .filter(|(status, _)| status == "completed")
            .count();
        Some(u64::try_from(children + runs).unwrap_or(u64::MAX))
    }
}

fn table_status(status: SubagentStatus) -> Option<&'static str> {
    match status {
        SubagentStatus::Running => None,
        SubagentStatus::Completed => Some("success"),
        SubagentStatus::Failed => Some("failed"),
        // A killed subagent was aborted by the user (Node `cancelled`), as `session/subagents` maps it.
        SubagentStatus::Killed => Some("cancelled"),
    }
}

/// The full-history read (rule 2 of the spec): the journal's Activity index and the store's ended children. `runs` is
/// `None` when the host keeps no run service (no runs at all). `None` when any read failed: the count is then unknown.
pub(crate) async fn read_seed(
    queries: &dyn StoreQueries,
    session: &SessionId,
    live: &[SubagentEntry],
    runs: Option<std::sync::Arc<dyn DynamicWorkflowRunPort>>,
    now_ms: u64,
) -> Option<Seed> {
    let history = match runs {
        Some(port) => match port.activity_history().await {
            Ok(history) => history,
            Err(error) => {
                tracing::warn!(event = "protocol.activity_count.runs_failed", session = %session.as_str(), error = %error.message, "the session's workflow activity history was not read; the success total is unknown");
                return None;
            }
        },
        None => rust_cli_kernel_api::workflow_run::ActivityHistory::default(),
    };
    let children = match crate::fork::subagents::ended_outcomes(queries, session, live, now_ms)
        .await
    {
        Ok(children) => children,
        Err(error) => {
            tracing::warn!(event = "protocol.activity_count.children_failed", session = %session.as_str(), error = %error, "the session's subagent outcomes were not read; the success total is unknown");
            return None;
        }
    };
    Some(Seed {
        runs: history
            .runs
            .into_iter()
            .map(|run| (run.run_id, run.status, run.sequence))
            .collect(),
        workflow_children: history.child_session_ids,
        children,
    })
}

#[cfg(test)]
#[path = "completed_activity_tests.rs"]
mod tests;
