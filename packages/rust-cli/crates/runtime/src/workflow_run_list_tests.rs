//! 9.40 (ocr on #597, finding 1): the answer to a parked question goes to the first live run that accepts it. A run that
//! settled after the snapshot (its owner gone, `NotDelivered`) is skipped, not reported.

use rust_cli_workflow::actor_mailbox::MailboxError;

use super::list::first_answer;

#[test]
fn a_run_whose_owner_is_gone_does_not_stop_the_next_run_from_answering() {
    let outcomes = vec![Err(MailboxError::NotDelivered), Ok(Some(7_u32))];
    assert!(matches!(first_answer(outcomes), Ok(Some(7))));
}

#[test]
fn a_run_that_does_not_hold_the_question_is_passed_over() {
    let outcomes = vec![Ok(None), Err(MailboxError::NoAnswer), Ok(Some(1_u32))];
    assert!(matches!(first_answer(outcomes), Ok(Some(1))));
}

#[test]
fn no_run_accepting_and_only_gone_owners_is_an_unknown_question_not_an_error() {
    let outcomes: Vec<Result<Option<u32>, MailboxError>> = vec![Err(MailboxError::NotDelivered)];
    assert!(matches!(first_answer(outcomes), Ok(None)));
}

#[test]
fn an_owner_failure_is_reported_when_no_run_accepts_the_answer() {
    let outcomes: Vec<Result<Option<u32>, MailboxError>> = vec![
        Ok(None),
        Err(MailboxError::Owner(anyhow::anyhow!("the journal failed"))),
    ];
    assert!(matches!(
        first_answer(outcomes),
        Err(MailboxError::Owner(_))
    ));
}

#[test]
fn an_accepted_answer_wins_over_a_failure_of_a_later_run() {
    let outcomes: Vec<Result<Option<u32>, MailboxError>> = vec![
        Ok(Some(3)),
        Err(MailboxError::Owner(anyhow::anyhow!("never asked"))),
    ];
    assert!(matches!(first_answer(outcomes), Ok(Some(3))));
}
