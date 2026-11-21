//! Engine behaviour when a journal write fails. Node has the same ordering, so these pin the outcome
//! of a failed write rather than a choice made in Rust:
//! - settlement latches before the journal status write (`finish_run`): a failed write leaves the engine
//!   settled, no `run-settled` event, no dispose, and a retry is a no-op;
//! - usage and caps are replaced in memory before the journal write: a failed write leaves the engine
//!   ahead of the row (see the doc comments on `record_usage` and `set_max_concurrency`).
use crate::engine::{
    AskMessage, AskSpec, EngineConfig, RunSettlement, SubmitVerdict, WorkflowDriver,
    WorkflowEngine, describe_cause,
};
use crate::error::{ErrorCode, WorkflowError};
use crate::event::RunEvent;
use crate::journal::{JournalPort, MemoryJournal};
use crate::model::{
    ActorRow, AskWait, Caps, ConcurrencyChange, NodeKind, NodeRow, NodeStatus, Ref, RunRow,
    RunStatus, Settlement, StopReason, StoredEvent, WaitCause,
};
use crate::resume::recover_settle_order;
use crate::scheduler::instructions_head;
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
    NodeSettled,
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

    fn update_run_script(
        &mut self,
        run_id: &str,
        script_text: &str,
        script_hash: &str,
    ) -> Result<()> {
        self.inner
            .update_run_script(run_id, script_text, script_hash)
    }

    fn append_event(&mut self, run_id: &str, event: &RunEvent) -> Result<StoredEvent> {
        if matches!(event, RunEvent::NodeSettled { .. }) {
            self.take(Fail::NodeSettled)?;
        }
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
    fn create_actor_session(
        &mut self,
        _actor: &Ref,
        _persona: &Value,
        _seed: Option<&crate::imported_cache::ActorSessionSeed>,
    ) -> Result<String> {
        unreachable!("these tests create no actors")
    }

    fn start_world_read(&mut self, _instance: &Ref, _op: &str, _args: &Value) {
        unreachable!("world reads are not used by this driver");
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

/// A driver that accepts asks: sessions are created and nothing settles on its own.
#[derive(Default)]
struct AskDriver {
    emitted: Vec<String>,
    disposed: u64,
    sessions: u64,
}

impl WorkflowDriver for AskDriver {
    fn create_actor_session(
        &mut self,
        _actor: &Ref,
        _persona: &Value,
        _seed: Option<&crate::imported_cache::ActorSessionSeed>,
    ) -> Result<String> {
        self.sessions += 1;
        Ok(format!("session-{}", self.sessions))
    }

    fn start_world_read(&mut self, _instance: &Ref, _op: &str, _args: &Value) {
        unreachable!("world reads are not used by this driver");
    }

    fn start_ask(&mut self, _session: &str, _instance: &Ref, _message: &AskMessage) {}

    fn respond_to_submit(&mut self, _instance: &Ref, _verdict: &SubmitVerdict) {}

    fn cancel_ask(&mut self, _instance: &Ref) {}

    fn emit(&mut self, event: &RunEvent) {
        self.emitted.push(event.payload_json());
    }

    fn dispose(&mut self) {
        self.disposed += 1;
    }
}

/// A failed `node-settled` write while settlement cancels two in-flight asks. Node rejects every in-flight
/// promise and disposes once after `run-settled`. The engine must still settle, hand out every ticket's
/// outcome, and make a retry a no-op that writes nothing.
#[test]
fn a_failed_cancel_write_during_settlement_still_settles_every_ask() {
    let next = Rc::new(Cell::new(None));
    let mut journal = FlakyJournal::new(next.clone());
    let mut driver = AskDriver::default();
    let mut config = config("run_abort", 4.0);
    config.ask_specs.insert(
        "site".to_owned(),
        AskSpec {
            typed: false,
            schema: None,
        },
    );
    let (complete, settled, outcomes, tickets, retry, before_retry, after_retry) = {
        let mut engine = WorkflowEngine::new(config, &mut journal, &mut driver).expect("new");
        let actor = engine.create_actor("site", None, None).expect("actor");
        let first = engine.ask("site", &actor, "one").expect("ask");
        let second = engine.ask("site", &actor, "two").expect("ask");
        engine.drain().expect("drain");
        next.set(Some(Fail::NodeSettled));
        let complete = engine.complete(json!("done"));
        let settled = engine.settlement().cloned();
        let outcomes = engine.take_outcomes();
        let before_retry = engine.events().expect("events");
        let retry = engine.complete(json!("again"));
        let after_retry = engine.events().expect("events");
        (
            complete,
            settled,
            outcomes,
            (first, second),
            retry,
            before_retry,
            after_retry,
        )
    };

    assert!(
        complete.is_err(),
        "the failed node-settled write is reported"
    );
    assert_eq!(
        settled,
        Some(RunSettlement::Completed {
            artifact: json!("done"),
        }),
        "the settlement is recorded even though a write failed"
    );
    let mut seen: Vec<u64> = outcomes.iter().map(|outcome| outcome.ticket).collect();
    seen.sort_unstable();
    assert_eq!(
        seen,
        vec![tickets.0, tickets.1],
        "every ticket gets an outcome"
    );
    for outcome in &outcomes {
        let error = outcome.result.as_ref().expect_err("cancelled");
        assert_eq!(error.code, ErrorCode::Cancelled);
    }
    assert!(retry.is_ok(), "a retry after settlement is a no-op");
    assert_eq!(before_retry, after_retry, "the retry writes nothing");
    assert_eq!(driver.disposed, 1, "dispose runs once, after run-settled");
    let row = journal.get_run("run_abort").expect("get_run").expect("row");
    assert_eq!(row.status, RunStatus::Completed);
}

/// Node `describeCause` bounds by UTF-16 units: 302 units cut to 300 (150 emoji); 300 units are kept.
#[test]
fn describe_cause_bounds_by_utf16_units() {
    let emoji = "\u{1F600}";
    assert_eq!(
        describe_cause(&emoji.repeat(151)),
        format!("{}…", emoji.repeat(150))
    );
    assert_eq!(describe_cause(&emoji.repeat(150)), emoji.repeat(150));
}

/// Node `String.prototype.trim` strips U+FEFF and keeps U+0085.
#[test]
fn trimming_follows_javascript_whitespace() {
    assert_eq!(describe_cause("\u{FEFF}x\u{FEFF}"), "x");
    assert_eq!(describe_cause("\u{85}x"), "\u{85}x");
    assert_eq!(instructions_head("\u{FEFF}\u{FEFF}"), None);
    assert_eq!(instructions_head("\u{85}"), Some("\u{85}".to_owned()));
}

/// Node `enterPhase` trims the name and writes nothing when the trimmed name is empty.
#[test]
fn an_all_feff_phase_name_writes_nothing() {
    let next = Rc::new(Cell::new(None));
    let mut journal = FlakyJournal::new(next);
    let mut driver = CountingDriver::default();
    {
        let mut engine =
            WorkflowEngine::new(config("run_phase", 4.0), &mut journal, &mut driver).expect("new");
        engine.enter_phase("\u{FEFF}").expect("phase");
    }
    let events = payloads(&journal, "run_phase");
    assert_eq!(events.len(), 1, "only run-started: {events:?}");
}

/// The instructions head is at most 240 UTF-16 units. A pair that straddles the cut is not split, so the
/// head is one unit shorter than Node's (Node keeps the lone high surrogate); see the spec.
#[test]
fn instructions_head_cuts_by_utf16_units() {
    let emoji = "\u{1F600}";
    let head = instructions_head(&format!("a{}", emoji.repeat(120))).expect("head");
    assert_eq!(head, format!("a{}", emoji.repeat(119)));
    assert_eq!(
        instructions_head(&emoji.repeat(120)),
        Some(emoji.repeat(120))
    );
}

/// A corrupt settlement event fails the resume, and the message names the run and the event sequence.
#[test]
fn a_corrupt_settle_event_names_the_run_and_sequence() {
    let rows = vec![NodeRow {
        run_id: "run_bad".to_owned(),
        site_id: "s".to_owned(),
        ordinal: 1,
        kind: NodeKind::Ask,
        actor_site_id: None,
        actor_ordinal: None,
        actor_seq: None,
        input_hash: "h".to_owned(),
        status: NodeStatus::Completed,
        result: None,
        error: None,
        stats: None,
        input: None,
        message_boundary: None,
        artifact_id: None,
    }];
    let events = vec![StoredEvent {
        sequence: 7,
        payload_json: "{not json".to_owned(),
        time_created: None,
    }];
    let message = match recover_settle_order("run_bad", &rows, &events) {
        Ok(_) => panic!("a corrupt event must fail the resume"),
        Err(error) => error.to_string(),
    };
    assert!(message.contains("run_bad"), "names the run: {message}");
    assert!(
        message.contains("sequence 7"),
        "names the sequence: {message}"
    );
}

/// Node `askWaiting` / `askExecuting` / `concurrencyChanged` (engine-concurrency-observations.test.ts): each
/// observation of a live ask journals one event; the node row stays `running` (no `dwf_node` write).
#[test]
fn concurrency_observations_journal_one_event_each_for_a_live_ask() {
    let next = Rc::new(Cell::new(None));
    let mut journal = FlakyJournal::new(next);
    let mut driver = AskDriver::default();
    let mut config = config("run_observe", 16.0);
    config.ask_specs.insert(
        "site".to_owned(),
        AskSpec {
            typed: false,
            schema: None,
        },
    );
    let instance = Ref::new("site", 2);
    {
        let mut engine = WorkflowEngine::new(config, &mut journal, &mut driver).expect("new");
        let actor = engine.create_actor("site", None, None).expect("actor");
        let _ask = engine.ask("site", &actor, "A").expect("ask");
        engine.drain().expect("drain");

        engine
            .ask_waiting(&instance, AskWait::slot())
            .expect("waiting");
        engine.ask_executing(&instance).expect("executing");
        engine
            .ask_waiting(
                &instance,
                AskWait {
                    cause: WaitCause::Backoff,
                    reason: Some("rate_limited".into()),
                    attempt: Some(2),
                    delay_ms: Some(20_000),
                    retry_after_ms: Some(20_000),
                },
            )
            .expect("backoff");
        engine
            .concurrency_changed(&ConcurrencyChange {
                key: "p/m".into(),
                previous: 8,
                next: 4,
                reason: "rate_limited".into(),
                last_good: Some(4),
                last_bad: None,
                cooldown_ms: Some(20_000),
            })
            .expect("changed");
        engine.ask_executing(&instance).expect("executing again");
    }

    let texts = payloads(&journal, "run_observe");
    let count = |prefix: &str| texts.iter().filter(|t| t.starts_with(prefix)).count();
    assert_eq!(
        texts
            .iter()
            .filter(|t| t.starts_with(r#"{"type":"node-waiting""#))
            .cloned()
            .collect::<Vec<_>>(),
        vec![
            r#"{"type":"node-waiting","instance":{"siteId":"site","ordinal":2},"cause":"slot"}"#
                .to_owned(),
            r#"{"type":"node-waiting","instance":{"siteId":"site","ordinal":2},"cause":"backoff","reason":"rate_limited","attempt":2,"delayMs":20000,"retryAfterMs":20000}"#
                .to_owned(),
        ]
    );
    assert_eq!(count(r#"{"type":"node-executing""#), 2, "{texts:?}");
    assert_eq!(
        texts
            .iter()
            .filter(|t| t.starts_with(r#"{"type":"concurrency-changed""#))
            .cloned()
            .collect::<Vec<_>>(),
        vec![
            r#"{"type":"concurrency-changed","key":"p/m","previous":8,"next":4,"reason":"rate_limited","lastGood":4,"cooldownMs":20000}"#
                .to_owned(),
        ]
    );
    let node = journal
        .get_node("run_observe", &instance)
        .expect("node read")
        .expect("node row");
    assert_eq!(node.status, NodeStatus::Running);
}

/// Node: a late observation (unknown or settled instance, settled run) is ignored; `concurrency-changed` only
/// waits for the run to settle, and a run with no live ask still records it.
#[test]
fn concurrency_observations_are_ignored_after_their_ask_or_run_settles() {
    let next = Rc::new(Cell::new(None));
    let mut journal = FlakyJournal::new(next);
    let mut driver = AskDriver::default();
    let mut config = config("run_late", 16.0);
    config.ask_specs.insert(
        "site".to_owned(),
        AskSpec {
            typed: false,
            schema: None,
        },
    );
    let instance = Ref::new("site", 2);
    {
        let mut engine = WorkflowEngine::new(config, &mut journal, &mut driver).expect("new");
        let change = ConcurrencyChange {
            key: "p/m".into(),
            previous: 4,
            next: 5,
            reason: "recovered".into(),
            last_good: None,
            last_bad: None,
            cooldown_ms: None,
        };
        engine.concurrency_changed(&change).expect("no ask yet");
        engine
            .ask_waiting(&Ref::new("nope", 1), AskWait::slot())
            .expect("unknown");
        engine.ask_executing(&Ref::new("nope", 1)).expect("unknown");
        let actor = engine.create_actor("site", None, None).expect("actor");
        let _ask = engine.ask("site", &actor, "A").expect("ask");
        engine.drain().expect("drain");
        // The live ask records its waiting; the same ask after it settles does not.
        engine
            .ask_waiting(&instance, AskWait::slot())
            .expect("live ask");
        engine.complete(json!("done")).expect("complete");
        engine
            .ask_waiting(&instance, AskWait::slot())
            .expect("settled ask");
        engine.ask_executing(&instance).expect("settled ask");
        engine.concurrency_changed(&change).expect("settled run");
    }

    let texts = payloads(&journal, "run_late");
    let count = |prefix: &str| texts.iter().filter(|t| t.starts_with(prefix)).count();
    assert_eq!(count(r#"{"type":"concurrency-changed""#), 1, "{texts:?}");
    assert_eq!(count(r#"{"type":"node-waiting""#), 1, "{texts:?}");
    assert_eq!(count(r#"{"type":"node-executing""#), 0, "{texts:?}");
}
