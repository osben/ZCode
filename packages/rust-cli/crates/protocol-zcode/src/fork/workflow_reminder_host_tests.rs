//! The session's reminder host, composed into the progress host, over a fake clock (specs/fork-rust-workflow-engine.md, 9.41,
//! W7-8e; divergences 357 to 360 of 9.38). The fake timers fire in time order, and a cancelled timer does nothing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use serde_json::{Value, json};

use super::{ReminderTimers, RunDecisions, SessionReminders, TokioTimers};
use crate::fork::workflow_progress::{ProgressDelivery, WorkflowNotices, WorkflowProgressHost};
use crate::fork::workflow_reminder::{MINUTE_MS, OpenDecisions, OpenQuestion};
use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Pending {
    due: u64,
    cancelled: Arc<AtomicBool>,
    fire: Option<Box<dyn FnOnce() + Send>>,
}

/// A clock the test moves by hand. `advance_to` fires every timer that falls due on the way, in order.
#[derive(Default)]
struct FakeTimers {
    now: Mutex<u64>,
    pending: Mutex<Vec<Pending>>,
}

impl FakeTimers {
    fn advance_to(&self, to: u64) {
        loop {
            let due = {
                let mut pending = lock(&self.pending);
                let next = pending
                    .iter()
                    .enumerate()
                    .filter(|(_, timer)| timer.fire.is_some() && timer.due <= to)
                    .min_by_key(|(_, timer)| timer.due)
                    .map(|(index, _)| index);
                next.map(|index| {
                    let timer = &mut pending[index];
                    (timer.due, timer.cancelled.clone(), timer.fire.take())
                })
            };
            let Some((at, cancelled, fire)) = due else {
                break;
            };
            *lock(&self.now) = at;
            if !cancelled.load(Ordering::SeqCst)
                && let Some(fire) = fire
            {
                fire();
            }
        }
        *lock(&self.now) = to;
    }
}

impl ReminderTimers for FakeTimers {
    fn now_ms(&self) -> u64 {
        *lock(&self.now)
    }

    fn schedule(&self, delay_ms: u64, fire: Box<dyn FnOnce() + Send>) -> Box<dyn FnOnce() + Send> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let due = self.now_ms() + delay_ms;
        lock(&self.pending).push(Pending {
            due,
            cancelled: cancelled.clone(),
            fire: Some(fire),
        });
        Box::new(move || cancelled.store(true, Ordering::SeqCst))
    }
}

/// The live runs and what each still owes. A run's read can fail.
#[derive(Default)]
struct Runs {
    live: Mutex<Vec<String>>,
    open: Mutex<HashMap<String, Result<Option<OpenDecisions>, String>>>,
}

impl Runs {
    fn with_question(run: &str) -> Arc<Self> {
        let runs = Self::default();
        *lock(&runs.live) = vec![run.to_owned()];
        lock(&runs.open).insert(
            run.to_owned(),
            Ok(Some(OpenDecisions {
                questions: vec![OpenQuestion {
                    qid: "q1".to_owned(),
                    subagent: "reviewer".to_owned(),
                    question: "Which branch?".to_owned(),
                    context: None,
                    asked_at: Some(0),
                }],
                holes: Vec::new(),
                draft_path: None,
            })),
        );
        Arc::new(runs)
    }
}

impl RunDecisions for Runs {
    fn live_run_ids(&self) -> Vec<String> {
        lock(&self.live).clone()
    }

    fn open(&self, run_id: &str) -> Result<Option<OpenDecisions>, String> {
        lock(&self.open).get(run_id).cloned().unwrap_or(Ok(None))
    }
}

#[derive(Default)]
struct Notices {
    posted: Mutex<Vec<(String, String)>>,
}

impl WorkflowNotices for Notices {
    fn post(&self, parent_session_id: &str, text: String, _workflow: Option<serde_json::Value>) {
        lock(&self.posted).push((parent_session_id.to_owned(), text));
    }
}

impl Notices {
    fn texts(&self) -> Vec<String> {
        lock(&self.posted)
            .iter()
            .map(|(_, text)| text.clone())
            .collect()
    }
}

/// The injected clock of the tokio timers (their delays are real; the time they report is not read).
struct FixedClock;

impl rust_cli_kernel_api::clock::Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        0
    }

    fn time_zone(&self) -> String {
        "UTC".to_owned()
    }
}

struct Quiet;

impl ProgressDelivery for Quiet {
    fn deliver(&self, _parent_session_id: &str, _deltas: Vec<Value>) {}
}

struct Session {
    timers: Arc<FakeTimers>,
    notices: Arc<Notices>,
    reminders: Arc<SessionReminders>,
    progress: WorkflowProgressHost,
}

fn session(runs: Arc<dyn RunDecisions>) -> Session {
    let timers = Arc::new(FakeTimers::default());
    let notices = Arc::new(Notices::default());
    let reminders = SessionReminders::new("parent_1", runs, timers.clone(), notices.clone());
    let progress = WorkflowProgressHost::new(Arc::new(Quiet)).with_reminder(reminders.clock());
    Session {
        timers,
        notices,
        reminders,
        progress,
    }
}

fn minutes(count: u64) -> u64 {
    count * MINUTE_MS
}

#[test]
fn the_first_reminder_fires_after_fifteen_idle_minutes_and_names_the_question() {
    let fx = session(Runs::with_question("run_1"));
    fx.reminders.turn_finished();
    fx.timers.advance_to(minutes(15) - 1);
    assert!(
        fx.notices.texts().is_empty(),
        "nothing before 15 idle minutes"
    );
    fx.timers.advance_to(minutes(15));
    let texts = fx.notices.texts();
    assert_eq!(texts.len(), 1, "one reminder at 15 minutes");
    assert!(
        texts[0].contains("<reminder>1 of 2</reminder>"),
        "{}",
        texts[0]
    );
    assert!(texts[0].contains("Which branch?"), "{}", texts[0]);
    assert!(
        texts[0].contains(&format!("waited-ms=\"{}\"", minutes(15))),
        "{}",
        texts[0]
    );
    assert_eq!(lock(&fx.notices.posted)[0].0, "parent_1");
}

#[test]
fn a_turn_that_starts_before_the_delay_cancels_the_reminder() {
    let fx = session(Runs::with_question("run_1"));
    fx.reminders.turn_finished();
    fx.timers.advance_to(minutes(10));
    fx.reminders.turn_started();
    fx.timers.advance_to(minutes(60));
    assert!(
        fx.notices.texts().is_empty(),
        "a busy session is not reminded"
    );
}

#[test]
fn the_second_reminder_comes_thirty_minutes_after_the_idle_start_and_then_no_more() {
    let fx = session(Runs::with_question("run_1"));
    fx.reminders.turn_finished();
    fx.timers.advance_to(minutes(30));
    let texts = fx.notices.texts();
    assert_eq!(texts.len(), 2, "the first at 15 minutes, the second at 30");
    assert!(texts[0].contains("<reminder>1 of 2</reminder>"));
    assert!(texts[1].contains("<reminder>2 of 2</reminder>"));
    fx.timers.advance_to(minutes(240));
    assert_eq!(
        fx.notices.texts().len(),
        2,
        "a run gets two reminders, no third"
    );
}

#[test]
fn an_open_set_change_through_the_composed_progress_host_restarts_the_idle_clock() {
    let fx = session(Runs::with_question("run_1"));
    fx.reminders.turn_finished();
    fx.timers.advance_to(minutes(10));
    let event = json!({
        "eventType": "escalation-raised",
        "runId": "run_1",
        "payload": {"qid": "q1", "question": "Which branch?", "actorName": "reviewer"}
    });
    fx.progress
        .record("parent_1", &event, &[])
        .expect("the progress record succeeds");
    // The reminder is measured from the change, not from the idle start. No notice sink is set here, so the escalation
    // itself posts nothing and the count below counts reminders only.
    let before = fx.notices.texts().len();
    fx.timers.advance_to(minutes(24));
    assert_eq!(
        fx.notices.texts().len(),
        before,
        "no reminder before 15 minutes from the change"
    );
    fx.timers.advance_to(minutes(25));
    let texts = fx.notices.texts();
    assert_eq!(texts.len(), before + 1);
    assert!(
        texts[before].contains("<reminder>1 of 2</reminder>"),
        "{}",
        texts[before]
    );
}

#[test]
fn a_run_whose_read_fails_is_skipped_without_a_reminder() {
    let runs = Runs::with_question("run_1");
    lock(&runs.open).insert(
        "run_1".to_owned(),
        Err("the snapshot is unreadable".to_owned()),
    );
    let fx = session(runs);
    fx.reminders.turn_finished();
    fx.timers.advance_to(minutes(30));
    assert!(fx.notices.texts().is_empty(), "a failed read sends nothing");
}

#[test]
fn the_host_reads_busy_and_idle_from_the_session_edges() {
    let fx = session(Runs::with_question("run_1"));
    // Before any edge the session is not idle: a clock that is never told it is idle never arms.
    fx.timers.advance_to(minutes(20));
    assert!(fx.notices.texts().is_empty());
    // The idle period is measured from the idle edge (20 minutes), not from the start of the clock.
    fx.reminders.turn_finished();
    fx.timers.advance_to(minutes(34));
    assert!(
        fx.notices.texts().is_empty(),
        "15 minutes count from the idle edge"
    );
    fx.timers.advance_to(minutes(35));
    assert_eq!(fx.notices.texts().len(), 1);
    fx.timers.advance_to(minutes(50));
    assert_eq!(fx.notices.texts().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tokio_timers_fire_once_and_a_cancel_stops_the_timer() {
    let timers = TokioTimers::new(tokio::runtime::Handle::current(), Arc::new(FixedClock));
    let (tx, rx) = tokio::sync::oneshot::channel::<&'static str>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let fired = tx.clone();
    let _cancel = timers.schedule(
        10,
        Box::new(move || {
            if let Some(tx) = lock(&fired).take() {
                let _ = tx.send("fired");
            }
        }),
    );
    let answer = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
        .await
        .expect("the timer fires")
        .expect("the timer sends");
    assert_eq!(answer, "fired");

    let (tx2, rx2) = tokio::sync::oneshot::channel::<&'static str>();
    let tx2 = Arc::new(Mutex::new(Some(tx2)));
    let fired2 = tx2.clone();
    let cancel = timers.schedule(
        50,
        Box::new(move || {
            if let Some(tx) = lock(&fired2).take() {
                let _ = tx.send("fired");
            }
        }),
    );
    cancel();
    let waited = tokio::time::timeout(std::time::Duration::from_millis(300), rx2).await;
    assert!(waited.is_err(), "a cancelled timer does not fire");
}

// ---- Fork (W7-11, 9.44): the per-session registry, the open decisions of a run object, and the routing. ----

use super::{OpenHole, RunDecisionsSource, WorkflowReminders, open_decisions_of};
use rust_cli_kernel_api::dynamic_workflow::{DynamicWorkflowGate, DynamicWorkflowGates};
use rust_cli_kernel_api::ids::SessionId;
use std::collections::HashSet;

/// The run snapshots of several sessions, read the way the service reads them: per session, per run.
#[derive(Default)]
struct Sources {
    live: Mutex<HashMap<String, Vec<String>>>,
    open: Mutex<HashMap<(String, String), OpenDecisions>>,
}

impl Sources {
    /// A live run of `session` that owes one question.
    fn add(&self, session: &str, run: &str) {
        lock(&self.live)
            .entry(session.to_owned())
            .or_default()
            .push(run.to_owned());
        lock(&self.open).insert(
            (session.to_owned(), run.to_owned()),
            OpenDecisions {
                questions: vec![OpenQuestion {
                    qid: "q1".to_owned(),
                    subagent: "reviewer".to_owned(),
                    question: "Which branch?".to_owned(),
                    context: None,
                    asked_at: Some(0),
                }],
                holes: Vec::new(),
                draft_path: None,
            },
        );
    }
}

impl RunDecisionsSource for Sources {
    fn live_run_ids(&self, session: &str) -> Vec<String> {
        lock(&self.live).get(session).cloned().unwrap_or_default()
    }

    fn open(&self, session: &str, run_id: &str) -> Result<Option<OpenDecisions>, String> {
        Ok(lock(&self.open)
            .get(&(session.to_owned(), run_id.to_owned()))
            .cloned())
    }
}

/// The sessions whose gate is open. A session not listed has no record (closed).
struct Gates(HashSet<String>);

impl DynamicWorkflowGates for Gates {
    fn gate(&self, session: &SessionId) -> Option<DynamicWorkflowGate> {
        self.0
            .contains(session.as_str())
            .then_some(DynamicWorkflowGate {
                enabled: true,
                tools_on_demand: false,
            })
    }
}

fn gates(sessions: &[&str]) -> Arc<dyn DynamicWorkflowGates> {
    Arc::new(Gates(sessions.iter().map(|s| (*s).to_owned()).collect()))
}

fn escalation(run: &str) -> Value {
    json!({
        "eventType": "escalation-raised",
        "runId": run,
        "payload": {"qid": "q1", "question": "Which branch?", "actorName": "reviewer"}
    })
}

#[test]
fn a_run_object_yields_its_waiting_holes_and_pending_questions() {
    let run = json!({
        "runId": "run_1",
        "status": "running",
        "pendingQuestions": [{
            "qid": "q1",
            "actorName": "reviewer",
            "question": "Which branch?",
            "context": "the diff",
            "askedAt": 1000
        }],
        "holes": [
            {"siteId": "hole#1", "ordinal": 1, "name": "Verdict", "type": "Verdict", "state": "waiting", "since": 2000},
            {"siteId": "hole#2", "ordinal": 2, "name": "Done", "state": "filled"}
        ]
    });
    let open = open_decisions_of(&run);
    assert_eq!(
        open.questions,
        [OpenQuestion {
            qid: "q1".to_owned(),
            subagent: "reviewer".to_owned(),
            question: "Which branch?".to_owned(),
            context: Some("the diff".to_owned()),
            asked_at: Some(1000),
        }]
    );
    assert_eq!(
        open.holes,
        [OpenHole {
            site_id: "hole#1".to_owned(),
            name: "Verdict".to_owned(),
            type_name: "Verdict".to_owned(),
            line: None,
            since: Some(2000),
        }],
        "a filled hole owes nothing"
    );
}

#[test]
fn an_unnamed_actor_is_labelled_as_node_labels_it_and_a_run_without_fields_owes_nothing() {
    let run = json!({
        "runId": "run_1",
        "pendingQuestions": [{"qid": "q1", "actorSiteId": "site", "actorOrdinal": 2, "question": "?"}]
    });
    assert_eq!(open_decisions_of(&run).questions[0].subagent, "site@2");
    let empty = open_decisions_of(&json!({"runId": "run_2"}));
    assert!(empty.questions.is_empty() && empty.holes.is_empty());
}

#[test]
fn a_forgotten_session_posts_no_reminder_while_another_session_still_does() {
    let timers = Arc::new(FakeTimers::default());
    let notices = Arc::new(Notices::default());
    let registry = registry_over(&["parent_a", "parent_b"], &timers, &notices);
    let sources = Sources::default();
    sources.add("parent_a", "run_a");
    sources.add("parent_b", "run_b");
    assert!(registry.set_runs(Arc::new(sources)));
    registry.turn_finished("parent_a");
    registry.turn_finished("parent_b");
    registry.forget("parent_a");
    timers.advance_to(minutes(20));
    let texts = notices.texts();
    assert_eq!(
        texts.len(),
        1,
        "only the live session's reminder posts: {texts:?}"
    );
}

#[test]
fn user_spoke_gives_a_run_that_already_sent_its_pair_a_fresh_pair() {
    let timers = Arc::new(FakeTimers::default());
    let notices = Arc::new(Notices::default());
    let registry = registry_over(&["parent_a"], &timers, &notices);
    let sources = Sources::default();
    sources.add("parent_a", "run_a");
    assert!(registry.set_runs(Arc::new(sources)));
    registry.turn_finished("parent_a");
    timers.advance_to(minutes(16));
    timers.advance_to(minutes(46));
    timers.advance_to(minutes(200));
    assert_eq!(notices.texts().len(), 2, "the pair is spent");
    registry.turn_started("parent_a");
    registry.user_spoke("parent_a");
    registry.turn_finished("parent_a");
    timers.advance_to(minutes(216));
    assert_eq!(
        notices.texts().len(),
        3,
        "a user prompt re-arms the spent run"
    );
}

/// A run source that reads another session's clock while the first clock is being made: the re-entrant edge deadlocks if
/// the registry builds the clock under its map's lock.
struct Reentrant {
    registry: Arc<OnceLock<std::sync::Weak<WorkflowReminders>>>,
    /// The first read re-enters once; the re-entered clock's own read must not re-enter again (that would recurse).
    entered: AtomicBool,
}

impl RunDecisionsSource for Reentrant {
    fn live_run_ids(&self, _session: &str) -> Vec<String> {
        if !self.entered.swap(true, Ordering::SeqCst)
            && let Some(registry) = self.registry.get().and_then(std::sync::Weak::upgrade)
        {
            registry.turn_started("parent_b");
        }
        Vec::new()
    }

    fn open(&self, _session: &str, _run_id: &str) -> Result<Option<OpenDecisions>, String> {
        Ok(None)
    }
}

#[test]
fn a_clock_made_while_a_run_source_reads_another_session_does_not_deadlock() {
    let timers = Arc::new(FakeTimers::default());
    let notices = Arc::new(Notices::default());
    let registry = registry_over(&["parent_a", "parent_b"], &timers, &notices);
    let slot = Arc::new(OnceLock::new());
    assert!(registry.set_runs(Arc::new(Reentrant {
        registry: slot.clone(),
        entered: AtomicBool::new(false),
    })));
    let _ = slot.set(Arc::downgrade(&registry));
    let (done, finished) = std::sync::mpsc::channel();
    let worker = registry;
    std::thread::spawn(move || {
        worker.turn_finished("parent_a");
        let _ = done.send(());
    });
    assert!(
        finished
            .recv_timeout(std::time::Duration::from_secs(5))
            .is_ok(),
        "the edge returned: the map's lock was not held across the run source"
    );
}

fn registry_over(
    sessions: &[&str],
    timers: &Arc<FakeTimers>,
    notices: &Arc<Notices>,
) -> Arc<WorkflowReminders> {
    Arc::new(WorkflowReminders::new(
        gates(sessions),
        timers.clone(),
        notices.clone(),
    ))
}

#[test]
fn an_open_set_change_restarts_only_the_clock_of_its_own_session() {
    let timers = Arc::new(FakeTimers::default());
    let notices = Arc::new(Notices::default());
    let registry = registry_over(&["parent_a", "parent_b"], &timers, &notices);
    let sources = Sources::default();
    sources.add("parent_a", "run_a");
    sources.add("parent_b", "run_b");
    assert!(registry.set_runs(Arc::new(sources)));
    registry.turn_finished("parent_a");
    registry.turn_finished("parent_b");
    timers.advance_to(minutes(10));
    let progress = WorkflowProgressHost::new(Arc::new(Quiet)).with_reminders(registry);
    progress
        .record("parent_a", &escalation("run_a"), &[])
        .expect("recorded");
    // parent_b has been idle since 0, so its reminder is due at 15 minutes; parent_a restarted at 10, so its is due at 25.
    timers.advance_to(minutes(15));
    let posted = lock(&notices.posted).clone();
    assert_eq!(posted.len(), 1, "{posted:?}");
    assert_eq!(posted[0].0, "parent_b");
    timers.advance_to(minutes(25));
    let sessions: Vec<String> = lock(&notices.posted)
        .iter()
        .map(|(session, _)| session.clone())
        .collect();
    assert_eq!(sessions, ["parent_b", "parent_a"]);
}

#[test]
fn a_session_whose_gate_is_closed_gets_no_reminder() {
    let timers = Arc::new(FakeTimers::default());
    let notices = Arc::new(Notices::default());
    let registry = registry_over(&["parent_a"], &timers, &notices);
    let sources = Sources::default();
    sources.add("parent_b", "run_b");
    assert!(registry.set_runs(Arc::new(sources)));
    registry.turn_finished("parent_b");
    let progress = WorkflowProgressHost::new(Arc::new(Quiet)).with_reminders(registry);
    progress
        .record("parent_b", &escalation("run_b"), &[])
        .expect("recorded");
    timers.advance_to(minutes(60));
    assert!(lock(&notices.posted).is_empty(), "no record, no clock");
}

#[test]
fn a_clock_first_seen_at_an_open_set_change_starts_idle() {
    // No turn edge was seen for the session (a quota resume in an idle session): the change starts the idle clock.
    let timers = Arc::new(FakeTimers::default());
    let notices = Arc::new(Notices::default());
    let registry = registry_over(&["parent_a"], &timers, &notices);
    let sources = Sources::default();
    sources.add("parent_a", "run_a");
    assert!(registry.set_runs(Arc::new(sources)));
    let progress = WorkflowProgressHost::new(Arc::new(Quiet)).with_reminders(registry);
    progress
        .record("parent_a", &escalation("run_a"), &[])
        .expect("recorded");
    timers.advance_to(minutes(15));
    assert_eq!(lock(&notices.posted).len(), 1, "idle from the change");
}

#[test]
fn a_clock_first_seen_at_a_turn_start_is_busy() {
    let timers = Arc::new(FakeTimers::default());
    let notices = Arc::new(Notices::default());
    let registry = registry_over(&["parent_a"], &timers, &notices);
    let sources = Sources::default();
    sources.add("parent_a", "run_a");
    assert!(registry.set_runs(Arc::new(sources)));
    registry.turn_started("parent_a");
    let progress = WorkflowProgressHost::new(Arc::new(Quiet)).with_reminders(registry);
    progress
        .record("parent_a", &escalation("run_a"), &[])
        .expect("recorded");
    timers.advance_to(minutes(60));
    assert!(
        lock(&notices.posted).is_empty(),
        "a busy session is not reminded"
    );
}

#[test]
fn before_the_run_source_is_set_no_session_owes_a_reminder() {
    let timers = Arc::new(FakeTimers::default());
    let notices = Arc::new(Notices::default());
    let registry = registry_over(&["parent_a"], &timers, &notices);
    registry.turn_finished("parent_a");
    let progress = WorkflowProgressHost::new(Arc::new(Quiet)).with_reminders(registry);
    progress
        .record("parent_a", &escalation("run_a"), &[])
        .expect("recorded");
    timers.advance_to(minutes(60));
    assert!(lock(&notices.posted).is_empty(), "no run is live yet");
}
