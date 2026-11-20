//! W7-7c: the blocked-run reminder clock (Node `workflow-blocked-reminder.ts`). The clock is driven through a fake host:
//! the fake holds the time, the timers and the reminders, and a test fires a timer by hand.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::{BlockedReminderClock, MINUTE_MS, OpenDecisions, OpenQuestion, Reminder, ReminderHost};

type Fire = Box<dyn FnOnce() + Send>;

struct Timer {
    delay: u64,
    fire: Option<Fire>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct Fake {
    live: Mutex<Vec<String>>,
    idle: AtomicBool,
    now: AtomicU64,
    open: Mutex<HashMap<String, OpenDecisions>>,
    reminds: Mutex<Vec<(String, usize)>>,
    timers: Mutex<Vec<Timer>>,
}

impl Fake {
    fn new(live: &[&str]) -> Arc<Self> {
        let fake = Self::default();
        *fake.live.lock().expect("live") = live.iter().map(|run| (*run).to_owned()).collect();
        fake.idle.store(true, Ordering::SeqCst);
        fake.open.lock().expect("open").insert(
            live.first().copied().unwrap_or_default().to_owned(),
            question_open(),
        );
        Arc::new(fake)
    }

    fn at(&self, ms: u64) {
        self.now.store(ms, Ordering::SeqCst);
    }

    fn reminds(&self) -> Vec<(String, usize)> {
        self.reminds.lock().expect("reminds").clone()
    }

    fn pending(&self) -> Vec<u64> {
        self.timers
            .lock()
            .expect("timers")
            .iter()
            .filter(|timer| timer.fire.is_some() && !timer.cancelled.load(Ordering::SeqCst))
            .map(|timer| timer.delay)
            .collect()
    }

    /// Fires the newest timer that has not been cancelled.
    fn fire_latest(&self) -> bool {
        self.fire_newest(false)
    }

    /// Fires the newest timer even if it was cancelled: the clock's own epoch check must make that a no-op.
    fn fire_cancelled_too(&self) -> bool {
        self.fire_newest(true)
    }

    fn fire_newest(&self, include_cancelled: bool) -> bool {
        let fire = {
            let mut timers = self.timers.lock().expect("timers");
            timers
                .iter_mut()
                .rev()
                .find(|timer| {
                    timer.fire.is_some()
                        && (include_cancelled || !timer.cancelled.load(Ordering::SeqCst))
                })
                .and_then(|timer| timer.fire.take())
        };
        match fire {
            Some(fire) => {
                fire();
                true
            }
            None => false,
        }
    }
}

fn question_open() -> OpenDecisions {
    OpenDecisions {
        questions: vec![OpenQuestion {
            qid: "dwfq-1-1".into(),
            subagent: "scout@3".into(),
            question: "Which branch?".into(),
            context: None,
            asked_at: Some(0),
        }],
        holes: Vec::new(),
        draft_path: None,
    }
}

impl ReminderHost for Fake {
    fn live_run_ids(&self) -> Vec<String> {
        self.live.lock().expect("live").clone()
    }

    fn is_idle(&self) -> bool {
        self.idle.load(Ordering::SeqCst)
    }

    fn read_open(&self, run_id: &str) -> Option<OpenDecisions> {
        self.open.lock().expect("open").get(run_id).cloned()
    }

    fn remind(&self, reminder: Reminder) {
        self.reminds
            .lock()
            .expect("reminds")
            .push((reminder.run_id, reminder.ordinal));
    }

    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }

    fn schedule(&self, delay_ms: u64, fire: Fire) -> Box<dyn FnOnce() + Send> {
        let cancelled = Arc::new(AtomicBool::new(false));
        self.timers.lock().expect("timers").push(Timer {
            delay: delay_ms,
            fire: Some(fire),
            cancelled: cancelled.clone(),
        });
        Box::new(move || cancelled.store(true, Ordering::SeqCst))
    }
}

fn clock(fake: &Arc<Fake>) -> Arc<BlockedReminderClock> {
    BlockedReminderClock::new(fake.clone())
}

#[test]
fn an_idle_session_arms_the_first_reminder_at_fifteen_minutes_and_sends_ordinal_one() {
    let fake = Fake::new(&["r1"]);
    let clock = clock(&fake);
    clock.session_idle();
    assert_eq!(fake.pending(), vec![15 * MINUTE_MS]);

    fake.at(15 * MINUTE_MS);
    assert!(fake.fire_latest());
    assert_eq!(fake.reminds(), vec![("r1".to_owned(), 1)]);
}

#[test]
fn a_busy_turn_cancels_the_pending_reminder() {
    let fake = Fake::new(&["r1"]);
    let clock = clock(&fake);
    clock.session_idle();
    clock.session_busy();
    assert!(fake.pending().is_empty(), "the busy turn cancels the timer");

    fake.at(15 * MINUTE_MS);
    fake.fire_cancelled_too();
    assert!(fake.reminds().is_empty(), "a stale timer sends nothing");
}

#[test]
fn a_second_reminder_follows_after_thirty_minutes_idle_and_then_the_run_is_quiet() {
    let fake = Fake::new(&["r1"]);
    let clock = clock(&fake);
    clock.session_idle();

    fake.at(15 * MINUTE_MS);
    fake.fire_latest();
    // The first reminder did not start a turn in this fake, so the idle clock keeps running to the second delay.
    assert_eq!(
        fake.pending(),
        vec![15 * MINUTE_MS],
        "the second delay is 30 minutes from the idle start"
    );

    fake.at(30 * MINUTE_MS);
    fake.fire_latest();
    assert_eq!(
        fake.reminds(),
        vec![("r1".to_owned(), 1), ("r1".to_owned(), 2)]
    );
    assert!(fake.pending().is_empty(), "two reminders is the limit");
}

#[test]
fn an_open_set_change_clears_the_count_and_restarts_the_idle_clock() {
    let fake = Fake::new(&["r1"]);
    let clock = clock(&fake);
    clock.session_idle();
    fake.at(15 * MINUTE_MS);
    fake.fire_latest();
    fake.at(30 * MINUTE_MS);
    fake.fire_latest();

    fake.at(40 * MINUTE_MS);
    clock.open_set_changed("r1");
    assert_eq!(
        fake.pending(),
        vec![15 * MINUTE_MS],
        "the idle clock restarts from the change"
    );

    fake.at(55 * MINUTE_MS);
    fake.fire_latest();
    assert_eq!(
        fake.reminds().last(),
        Some(&("r1".to_owned(), 1)),
        "the run gets a fresh pair"
    );
}

#[test]
fn an_open_set_change_while_busy_does_not_start_the_clock() {
    let fake = Fake::new(&["r1"]);
    let clock = clock(&fake);
    clock.open_set_changed("r1");
    assert!(
        fake.pending().is_empty(),
        "the clock only restarts in an idle session"
    );
}

#[test]
fn a_user_message_clears_the_counts_for_the_next_idle_period() {
    let fake = Fake::new(&["r1"]);
    let clock = clock(&fake);
    clock.session_idle();
    fake.at(15 * MINUTE_MS);
    fake.fire_latest();

    clock.user_spoke();
    clock.session_busy();
    fake.at(20 * MINUTE_MS);
    clock.session_idle();
    fake.at(35 * MINUTE_MS);
    fake.fire_latest();
    assert_eq!(fake.reminds().last(), Some(&("r1".to_owned(), 1)));
}

#[test]
fn a_run_with_nothing_open_is_not_reminded() {
    let fake = Fake::new(&["r1"]);
    fake.open.lock().expect("open").clear();
    let clock = clock(&fake);
    clock.session_idle();
    fake.at(15 * MINUTE_MS);
    fake.fire_latest();
    assert!(fake.reminds().is_empty());
}

#[test]
fn a_stopped_clock_is_silent() {
    let fake = Fake::new(&["r1"]);
    let clock = clock(&fake);
    clock.session_idle();
    clock.stop();
    fake.at(15 * MINUTE_MS);
    fake.fire_cancelled_too();
    clock.session_idle();
    assert!(fake.reminds().is_empty());
    assert!(fake.pending().is_empty());
}
