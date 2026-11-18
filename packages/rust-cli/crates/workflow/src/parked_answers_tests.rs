//! The answers to parked questions (the store behind the blocked escalate call): an answer that comes before its wait is
//! kept, a wait wakes when its answer or its withdrawal arrives, each question has its own slot, and the slots of a session
//! that ended are dropped without touching the others. A session that ends while its turn is blocked withdraws that wait.
use crate::parked_answers::ParkedAnswers;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Long enough for a wake that works, short enough that a stranded waiter fails the test instead of hanging it.
const WAKE_WITHIN: Duration = Duration::from_secs(5);

/// The reason a cancelled turn's question is withdrawn with.
const CANCELLED: &str = "the ask was cancelled";

/// Starts a waiter for `q1` on a thread, and returns the channel its result arrives on.
fn spawn_waiter(
    parked: &Arc<ParkedAnswers>,
) -> (
    mpsc::Receiver<Result<String, String>>,
    thread::JoinHandle<()>,
) {
    let (tx, rx) = mpsc::channel();
    let parked = parked.clone();
    let handle = thread::spawn(move || {
        let _ = tx.send(parked.wait("sess", "q1"));
    });
    (rx, handle)
}

/// Waits until a waiter has registered for a question, so the next call happens while that waiter is blocked.
fn until_registered(parked: &ParkedAnswers) {
    let deadline = Instant::now() + WAKE_WITHIN;
    while parked.waiters() == 0 {
        assert!(Instant::now() < deadline, "the waiter never registered");
        thread::yield_now();
    }
}

#[test]
fn an_answer_delivered_before_the_wait_is_not_lost() {
    let parked = ParkedAnswers::new();
    parked.deliver("sess", "q1", "yes");
    assert_eq!(parked.wait("sess", "q1"), Ok("yes".to_owned()));
}

#[test]
fn a_wait_wakes_when_the_answer_arrives_from_another_thread() {
    let parked = Arc::new(ParkedAnswers::new());
    let waiter = {
        let parked = parked.clone();
        thread::spawn(move || parked.wait("sess", "q1"))
    };
    thread::sleep(Duration::from_millis(20));
    parked.deliver("sess", "q1", "later");
    assert_eq!(waiter.join().expect("join"), Ok("later".to_owned()));
}

#[test]
fn a_withdrawn_question_wakes_its_wait_with_the_reason() {
    let parked = Arc::new(ParkedAnswers::new());
    let waiter = {
        let parked = parked.clone();
        thread::spawn(move || parked.wait("sess", "q1"))
    };
    thread::sleep(Duration::from_millis(20));
    parked.reject("sess", "q1", "the question was withdrawn");
    assert_eq!(
        waiter.join().expect("join"),
        Err("the question was withdrawn".to_owned())
    );
}

#[test]
fn each_question_has_its_own_answer() {
    let parked = ParkedAnswers::new();
    parked.deliver("sess", "q2", "other");
    parked.deliver("sess", "q1", "mine");
    assert_eq!(parked.wait("sess", "q1"), Ok("mine".to_owned()));
    assert_eq!(parked.wait("sess", "q2"), Ok("other".to_owned()));
}

#[test]
fn discarding_a_session_drops_only_its_unwaited_slots() {
    let parked = ParkedAnswers::new();
    // Slots nobody waits for: the turn was cancelled before it waited, or its answer was never taken.
    parked.deliver("sess_a", "q1", "orphan");
    parked.reject("sess_a", "q2", "withdrawn");
    parked.deliver("sess_b", "q3", "still wanted");
    assert_eq!(parked.len(), 3);
    assert_eq!(parked.discard_session("sess_a"), 2);
    assert_eq!(parked.len(), 1);
    assert_eq!(parked.wait("sess_b", "q3"), Ok("still wanted".to_owned()));
    assert_eq!(parked.len(), 0);
}

#[test]
fn a_waiter_is_withdrawn_when_its_session_is_discarded_while_it_is_blocked() {
    // Interleaving 2 of the owner's cancel: the turn is blocked on its question, and no answer exists. The discard must wake
    // the waiter, or its escalate blocks for good.
    let parked = Arc::new(ParkedAnswers::new());
    let (result, waiter) = spawn_waiter(&parked);
    until_registered(&parked);
    parked.discard_session("sess");
    assert_eq!(
        result.recv_timeout(WAKE_WITHIN),
        Ok(Err(CANCELLED.to_owned())),
        "the blocked waiter wakes with the cancel reason"
    );
    waiter.join().expect("join");
    assert!(parked.is_empty());
    assert_eq!(parked.waiters(), 0, "the woken wait is deregistered");
}

#[test]
fn an_answer_put_before_a_discard_still_reaches_its_waiter() {
    // Interleaving 1: the answer is put and its wake is sent, and the cancel's discard runs before the woken waiter takes
    // its slot. Whichever runs first, the waiter must come back, and the answer it was given must not be lost.
    let parked = Arc::new(ParkedAnswers::new());
    let (result, waiter) = spawn_waiter(&parked);
    until_registered(&parked);
    parked.deliver("sess", "q1", "yes");
    parked.discard_session("sess");
    assert_eq!(
        result.recv_timeout(WAKE_WITHIN),
        Ok(Ok("yes".to_owned())),
        "the answer that was delivered reaches the waiter"
    );
    waiter.join().expect("join");
    assert!(parked.is_empty());
    assert_eq!(parked.waiters(), 0, "the woken wait is deregistered");
}

#[test]
fn a_turn_cancelled_before_its_wait_registers_is_withdrawn_by_the_cancel_check() {
    // The backstop: the cancel reached the turn before the question was waited on, so the discard found nothing to wake.
    let parked = ParkedAnswers::new();
    let cancelled = AtomicBool::new(true);
    assert_eq!(
        parked.wait_until("sess", "q1", &|| cancelled.load(Ordering::SeqCst)),
        Err(CANCELLED.to_owned())
    );
    assert!(parked.is_empty());
    assert_eq!(parked.waiters(), 0, "the cancelled wait is deregistered");
}

#[test]
fn a_cancel_check_does_not_override_an_answer_that_is_already_there() {
    let parked = ParkedAnswers::new();
    parked.deliver("sess", "q1", "yes");
    assert_eq!(
        parked.wait_until("sess", "q1", &|| true),
        Ok("yes".to_owned())
    );
}
