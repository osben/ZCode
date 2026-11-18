//! The answers to parked questions (the store behind the blocked escalate call): an answer that comes before its wait is
//! kept, a wait wakes when its answer or its withdrawal arrives, each question has its own slot, and the slots of a session
//! that ended are dropped without touching the others.
use crate::parked_answers::ParkedAnswers;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

#[test]
fn an_answer_delivered_before_the_wait_is_not_lost() {
    let parked = ParkedAnswers::new();
    parked.deliver("sess", "q1", "yes");
    assert_eq!(parked.wait("q1"), Ok("yes".to_owned()));
}

#[test]
fn a_wait_wakes_when_the_answer_arrives_from_another_thread() {
    let parked = Arc::new(ParkedAnswers::new());
    let waiter = {
        let parked = parked.clone();
        thread::spawn(move || parked.wait("q1"))
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
        thread::spawn(move || parked.wait("q1"))
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
    assert_eq!(parked.wait("q1"), Ok("mine".to_owned()));
    assert_eq!(parked.wait("q2"), Ok("other".to_owned()));
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
    assert_eq!(parked.wait("q3"), Ok("still wanted".to_owned()));
    assert_eq!(parked.len(), 0);
}
