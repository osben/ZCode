//! Engine behaviour when a journal write fails. Node has the same ordering, so these pin the outcome
//! of a failed write rather than a choice made in Rust:
//! - settlement latches before the journal status write (`finish_run`): a failed write leaves the engine
//!   settled, no `run-settled` event, no dispose, and a retry is a no-op;
//! - usage and caps are replaced in memory before the journal write: a failed write leaves the engine
//!   ahead of the row (see the doc comments on `record_usage` and `set_max_concurrency`).
use crate::engine::{
    AskMessage, EngineConfig, RunSettlement, SubmitVerdict, WorkflowDriver, WorkflowEngine,
};
use crate::error::{ErrorCode, WorkflowError};
use crate::event::RunEvent;
use crate::journal::{JournalPort, MemoryJournal};
use crate::model::{
    ActorRow, Caps, NodeRow, Ref, RunRow, RunStatus, Settlement, StopReason, StoredEvent,
};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::cell::Cell;
use std::rc::Rc;

/// Which journal write the next call fails on, once. Shared with the test through an `Rc`, because the
/// engine owns its journal handle while the test runs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fail {
    Status,
    Usage,
    Caps,
}

/// `MemoryJournal` that fails one chosen write once, then behaves normally again.
struct FlakyJournal {
    inner: MemoryJournal,
    next: Rc<Cell<Option<Fail>>>,
}

impl FlakyJournal {
    fn new(next: Rc<Cell<Option<Fail>>>) -> Self {
        Self {
            inner: MemoryJournal::new(),
            next,
        }
    }

    fn take(&self, write: Fail) -> Result<()> {
        if self.next.get() == Some(write) {
            self.next.set(None);
            bail!("injected journal failure");
        }
        Ok(())
    }
}

impl JournalPort for FlakyJournal {
    fn create_run(&mut self, row: RunRow) -> Result<()> {
        self.inner.create_run(row)
    }

    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>> {
        self.inner.get_run(run_id)
    }

    fn update_run_status(
        &mut self,
        run_id: &str,
        status: RunStatus,
        settlement: &Settlement,
    ) -> Result<()> {
        self.take(Fail::Status)?;
        self.inner.update_run_status(run_id, status, settlement)
    }

    fn update_run_usage(&mut self, run_id: &str, spent_tokens: f64) -> Result<()> {
        self.take(Fail::Usage)?;
        self.inner.update_run_usage(run_id, spent_tokens)
    }

    fn update_run_caps(&mut self, run_id: &str, caps: Caps) -> Result<()> {
        self.take(Fail::Caps)?;
        self.inner.update_run_caps(run_id, caps)
    }

    fn append_event(&mut self, run_id: &str, event: &RunEvent) -> Result<StoredEvent> {
        self.inner.append_event(run_id, event)
    }

    fn list_events(&self, run_id: &str) -> Result<Vec<StoredEvent>> {
        self.inner.list_events(run_id)
    }

    fn put_actor(&mut self, row: ActorRow) -> Result<()> {
        self.inner.put_actor(row)
    }

    fn get_actor(&self, run_id: &str, actor: &Ref) -> Result<Option<ActorRow>> {
        self.inner.get_actor(run_id, actor)
    }

    fn list_actors(&self, run_id: &str) -> Result<Vec<ActorRow>> {
        self.inner.list_actors(run_id)
    }

    fn put_node(&mut self, row: NodeRow) -> Result<()> {
        self.inner.put_node(row)
    }

    fn get_node(&self, run_id: &str, instance: &Ref) -> Result<Option<NodeRow>> {
        self.inner.get_node(run_id, instance)
    }

    fn list_nodes(&self, run_id: &str) -> Result<Vec<NodeRow>> {
        self.inner.list_nodes(run_id)
    }
}

#[derive(Default)]
struct CountingDriver {
    emitted: Vec<String>,
    disposed: u64,
}

impl WorkflowDriver for CountingDriver {
    fn create_actor_session(&mut self, _actor: &Ref, _persona: &Value) -> Result<String> {
        unreachable!("these tests create no actors")
    }

    fn start_ask(&mut self, _session: &str, _instance: &Ref, _message: &AskMessage) {
        unreachable!("these tests start no asks")
    }

    fn respond_to_submit(&mut self, _instance: &Ref, _verdict: &SubmitVerdict) {
        unreachable!("these tests submit nothing")
    }

    fn cancel_ask(&mut self, _instance: &Ref) {
        unreachable!("these tests cancel no asks")
    }

    fn emit(&mut self, event: &RunEvent) {
        self.emitted.push(event.payload_json());
    }

    fn dispose(&mut self) {
        self.disposed += 1;
    }
}

fn config(run_id: &str, max_concurrency: f64) -> EngineConfig {
    EngineConfig {
        run_id: run_id.to_owned(),
        caps: Caps { max_concurrency },
        ..Default::default()
    }
}

fn payloads(journal: &FlakyJournal, run_id: &str) -> Vec<String> {
    journal
        .list_events(run_id)
        .expect("events")
        .into_iter()
        .map(|stored| stored.payload_json)
        .collect()
}

#[test]
fn failed_status_write_latches_the_settlement() {
    let next = Rc::new(Cell::new(None));
    let mut journal = FlakyJournal::new(next.clone());
    let mut driver = CountingDriver::default();
    let (first, retry_complete, retry_stop, retry_fail, settlement) = {
        let mut engine =
            WorkflowEngine::new(config("run_latch", 4.0), &mut journal, &mut driver).expect("new");
        engine.log("before").expect("log");
        next.set(Some(Fail::Status));
        let first = engine.complete(json!({"ok": true}));
        // The latch is set before the write, so the engine is settled even though the write failed.
        let settlement = engine.settlement().cloned();
        let retry_complete = engine.complete(json!("again"));
        let retry_stop = engine.stop(StopReason::User, None, None);
        let retry_fail = engine.fail(WorkflowError::new(ErrorCode::DriverError, "late"));
        (first, retry_complete, retry_stop, retry_fail, settlement)
    };

    assert!(first.is_err(), "the failed status write is reported");
    assert!(
        retry_complete.is_ok(),
        "a retry after settlement is a no-op"
    );
    assert!(
        retry_stop.is_ok(),
        "stop after a latched settlement is a no-op"
    );
    assert!(
        retry_fail.is_ok(),
        "fail after a latched settlement is a no-op"
    );
    assert_eq!(
        settlement,
        Some(RunSettlement::Completed {
            artifact: json!({"ok": true}),
        }),
        "the first settlement wins; the retry's artifact is never recorded"
    );
    let row = journal.get_run("run_latch").expect("get_run").expect("row");
    assert_eq!(
        row.status,
        RunStatus::Running,
        "the failed write left the row running"
    );
    assert_eq!(row.result, None);
    let events = payloads(&journal, "run_latch");
    assert_eq!(events.len(), 2, "run-started and log only: {events:?}");
    assert!(
        events.iter().all(|text| !text.contains("run-settled")),
        "no run-settled event after a failed status write: {events:?}"
    );
    assert_eq!(
        driver.disposed, 0,
        "dispose is not called when settlement fails"
    );
    assert!(
        driver
            .emitted
            .iter()
            .all(|text| !text.contains("run-settled")),
        "the driver saw no run-settled event"
    );
}

#[test]
fn failed_usage_write_leaves_the_total_ahead_of_the_row() {
    let next = Rc::new(Cell::new(None));
    let mut journal = FlakyJournal::new(next.clone());
    let mut driver = CountingDriver::default();
    let (failed, spent_after_failure, settled_after_failure, retried) = {
        let mut engine =
            WorkflowEngine::new(config("run_usage", 4.0), &mut journal, &mut driver).expect("new");
        next.set(Some(Fail::Usage));
        let failed = engine.record_usage(5.0);
        let spent_after_failure = engine.spent_tokens();
        let settled_after_failure = engine.settlement().is_some();
        let retried = engine.record_usage(2.0);
        (failed, spent_after_failure, settled_after_failure, retried)
    };

    assert!(failed.is_err(), "the failed usage write is reported");
    assert_eq!(
        spent_after_failure, 5.0,
        "the total is added before the write, as in Node"
    );
    assert!(
        !settled_after_failure,
        "a usage failure does not settle the run"
    );
    assert!(retried.is_ok());
    let row = journal.get_run("run_usage").expect("get_run").expect("row");
    assert_eq!(
        row.spent_tokens, 7.0,
        "the retry writes the full total, not the increment"
    );
    let events = payloads(&journal, "run_usage");
    assert_eq!(
        events.len(),
        2,
        "run-started and one usage-updated: {events:?}"
    );
    assert!(
        events[1].contains("usage-updated") && events[1].contains("\"spentTokens\":7"),
        "the failed call appended no usage event; the retry carries the full total: {events:?}"
    );
}

#[test]
fn failed_caps_write_keeps_the_new_cap_and_a_same_value_retry_is_a_no_op() {
    let next = Rc::new(Cell::new(None));
    let mut journal = FlakyJournal::new(next.clone());
    let mut driver = CountingDriver::default();
    let (failed, cap_after_failure, retry_same, change_after) = {
        let mut engine =
            WorkflowEngine::new(config("run_caps", 4.0), &mut journal, &mut driver).expect("new");
        next.set(Some(Fail::Caps));
        let failed = engine.set_max_concurrency(8.0);
        let cap_after_failure = engine.caps().max_concurrency;
        // Node: the engine already holds 8, so the retry returns false and the row stays at 4.
        let retry_same = engine.set_max_concurrency(8.0);
        let change_after = engine.set_max_concurrency(6.0);
        (failed, cap_after_failure, retry_same, change_after)
    };

    assert!(failed.is_err(), "the failed caps write is reported");
    assert_eq!(
        cap_after_failure, 8.0,
        "the cap is replaced before the write, as in Node"
    );
    assert!(
        !retry_same.expect("retry is Ok"),
        "the same value is a no-op for the engine"
    );
    assert!(
        change_after.expect("change is Ok"),
        "a different value is applied"
    );
    let row = journal.get_run("run_caps").expect("get_run").expect("row");
    assert_eq!(
        row.caps.max_concurrency, 6.0,
        "the later real change reaches the row"
    );
    let events = payloads(&journal, "run_caps");
    let changed: Vec<&String> = events
        .iter()
        .filter(|text| text.contains("run-caps-changed"))
        .collect();
    assert_eq!(
        changed.len(),
        1,
        "only the successful change is announced: {events:?}"
    );
    assert!(
        changed[0].contains("\"maxConcurrency\":6"),
        "the announced change is the one that reached the row: {events:?}"
    );
}
