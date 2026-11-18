//! The answers to parked questions (the store behind the blocked escalate call): an answer that comes before its wait is
//! kept, a wait wakes when its answer or its withdrawal arrives, and each question has its own slot.
use crate::parked_answers::ParkedAnswers;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

#[test]
fn an_answer_delivered_before_the_wait_is_not_lost() {
    let parked = ParkedAnswers::new();
    parked.deliver("q1", "yes");
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
    parked.deliver("q1", "later");
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
    parked.reject("q1", "the question was withdrawn");
    assert_eq!(
        waiter.join().expect("join"),
        Err("the question was withdrawn".to_owned())
    );
}

#[test]
fn each_question_has_its_own_answer() {
    let parked = ParkedAnswers::new();
    parked.deliver("q2", "other");
    parked.deliver("q1", "mine");
    assert_eq!(parked.wait("q1"), Ok("mine".to_owned()));
    assert_eq!(parked.wait("q2"), Ok("other".to_owned()));
}
