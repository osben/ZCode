//! The turn side of the session close (W6b part 6): an idle session is closed at once, a session whose turn runs is closed
//! when the turn lands, and a close is requested once per session (Node driver tests rows 31, 32, 34 and 35, turn side).
//! Also: a refused close can be requested again, a deferred refusal is reported, a turn cannot start on a session that is
//! closing, and a turn side with no closer wired refuses to close.
use crate::actor_mailbox::ActorMailbox;
use crate::actor_sessions::ActorTurns;
use crate::actor_turns::{MailboxTurns, SessionCloser, TurnInput, TurnRunner};
use crate::model::Ref;
use crate::model_failure::TurnFailure;
use anyhow::{Result, anyhow};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// A turn that runs until the test releases it, then ends with text (whether or not it was cancelled).
struct GatedRunner {
    release: Mutex<Receiver<()>>,
}

impl TurnRunner for GatedRunner {
    fn run_turn(
        &self,
        _session: &str,
        _interaction: &str,
        _turn: &TurnInput,
        _cancel: &AtomicBool,
    ) -> std::result::Result<String, TurnFailure> {
        let gate = self
            .release
            .lock()
            .map_err(|_| TurnFailure::plain("gate poisoned"))?;
        let _ = gate.recv();
        Ok("done".to_owned())
    }
}

/// Records each session the close was run for. The first `refusals` closes are refused.
struct RecordingCloser {
    closed: Arc<Mutex<Vec<String>>>,
    refusals: Mutex<usize>,
}

impl SessionCloser for RecordingCloser {
    fn close(&self, session: &str) -> Result<()> {
        self.closed.lock().expect("closed").push(session.to_owned());
        let mut refusals = self.refusals.lock().expect("refusals");
        if *refusals > 0 {
            *refusals -= 1;
            return Err(anyhow!("close refused"));
        }
        Ok(())
    }
}

fn input() -> TurnInput {
    TurnInput {
        text: "do it".to_owned(),
        epilogue_start: 0,
        submit_schema: None,
    }
}

fn instance() -> Ref {
    Ref::new("site", 1)
}

fn turns_with(
    release: Receiver<()>,
    closed: &Arc<Mutex<Vec<String>>>,
    refusals: usize,
) -> (MailboxTurns, ActorMailbox) {
    let (mailbox, handle) = ActorMailbox::new();
    let runner = Arc::new(GatedRunner {
        release: Mutex::new(release),
    });
    let closer = Arc::new(RecordingCloser {
        closed: closed.clone(),
        refusals: Mutex::new(refusals),
    });
    (MailboxTurns::with_closer(runner, handle, closer), mailbox)
}

fn wait_for_close(closed: &Arc<Mutex<Vec<String>>>, expected: usize) {
    let started = Instant::now();
    while closed.lock().expect("closed").len() < expected {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the deferred close never ran"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

/// Row 31 (turn side): a session with no turn running is closed at once, inside the close call.
#[test]
fn row_31_turn_side_an_idle_session_is_closed_at_once() {
    let closed = Arc::new(Mutex::new(Vec::new()));
    let (_release_tx, release_rx) = channel::<()>();
    let (mut turns, _mailbox) = turns_with(release_rx, &closed, 0);
    turns.close_session("ses_idle").expect("close");
    assert_eq!(*closed.lock().expect("closed"), vec!["ses_idle".to_owned()]);
}

/// Row 32 (turn side): a session closed while its turn runs waits for the turn to land, then is closed once.
#[test]
fn row_32_turn_side_a_session_closed_mid_turn_is_closed_when_the_turn_lands() {
    let closed = Arc::new(Mutex::new(Vec::new()));
    let (release_tx, release_rx) = channel::<()>();
    let (mut turns, _mailbox) = turns_with(release_rx, &closed, 0);
    turns
        .start_turn("ses_busy", &instance(), &input(), "worker (site@1)")
        .expect("start");
    turns.cancel_turn("ses_busy", &instance()).expect("cancel");
    turns.close_session("ses_busy").expect("close requested");
    assert!(
        closed.lock().expect("closed").is_empty(),
        "the turn is still running"
    );
    release_tx.send(()).expect("release the turn");
    wait_for_close(&closed, 1);
    assert_eq!(*closed.lock().expect("closed"), vec!["ses_busy".to_owned()]);
}

/// Row 34 (turn side): two close requests on a busy session close it once.
#[test]
fn row_34_turn_side_two_close_requests_close_the_session_once() {
    let closed = Arc::new(Mutex::new(Vec::new()));
    let (release_tx, release_rx) = channel::<()>();
    let (mut turns, _mailbox) = turns_with(release_rx, &closed, 0);
    turns
        .start_turn("ses_busy", &instance(), &input(), "worker (site@1)")
        .expect("start");
    turns.cancel_turn("ses_busy", &instance()).expect("cancel");
    turns.close_session("ses_busy").expect("first close");
    turns.close_session("ses_busy").expect("second close");
    release_tx.send(()).expect("release the turn");
    wait_for_close(&closed, 1);
    // Give a second, wrongly scheduled close time to show itself before counting.
    thread::sleep(Duration::from_millis(50));
    assert_eq!(closed.lock().expect("closed").len(), 1);
}

/// Row 35 (turn side): a refused close is returned when the session is idle.
#[test]
fn row_35_turn_side_a_refused_idle_close_is_returned_to_the_caller() {
    let closed = Arc::new(Mutex::new(Vec::new()));
    let (_release_tx, release_rx) = channel::<()>();
    let (mut turns, _mailbox) = turns_with(release_rx, &closed, 1);
    let error = turns
        .close_session("ses_idle")
        .expect_err("the refused close is reported");
    assert!(error.to_string().contains("close refused"), "{error}");
}

/// A refused close does not count as done: the session can be asked to close again, and the second close runs.
#[test]
fn a_refused_idle_close_can_be_requested_again() {
    let closed = Arc::new(Mutex::new(Vec::new()));
    let (_release_tx, release_rx) = channel::<()>();
    let (mut turns, _mailbox) = turns_with(release_rx, &closed, 1);
    assert!(turns.close_session("ses_retry").is_err());
    turns
        .close_session("ses_retry")
        .expect("the second request runs the close again");
    assert_eq!(
        *closed.lock().expect("closed"),
        vec!["ses_retry".to_owned(), "ses_retry".to_owned()]
    );
}

/// A refused deferred close (the turn had not landed yet) is kept in the turn side's failure ledger, which the owner
/// drains; the session can then be asked to close again.
#[test]
fn a_refused_deferred_close_is_reported_and_can_be_requested_again() {
    let closed = Arc::new(Mutex::new(Vec::new()));
    let (release_tx, release_rx) = channel::<()>();
    let (mut turns, _mailbox) = turns_with(release_rx, &closed, 1);
    turns
        .start_turn("ses_busy", &instance(), &input(), "worker (site@1)")
        .expect("start");
    turns.cancel_turn("ses_busy", &instance()).expect("cancel");
    turns.close_session("ses_busy").expect("close requested");
    release_tx.send(()).expect("release the turn");
    wait_for_close(&closed, 1);

    let mut failures = Vec::new();
    let started = Instant::now();
    while failures.is_empty() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the refused deferred close was never reported"
        );
        failures.extend(turns.take_close_failures());
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert_eq!(failures[0].0, "ses_busy");
    assert!(failures[0].1.contains("close refused"), "{}", failures[0].1);
    assert!(
        turns.take_close_failures().is_empty(),
        "taking drains the ledger"
    );

    turns
        .close_session("ses_busy")
        .expect("the session is requested again after its refusal");
    assert_eq!(closed.lock().expect("closed").len(), 2);
}

/// Once a close is requested, no turn may start on the session: an idle session refuses at once, and a session whose
/// turn is still running refuses too, since its close will not wait for a turn that begins later.
#[test]
fn a_turn_cannot_start_once_its_session_is_asked_to_close() {
    let closed = Arc::new(Mutex::new(Vec::new()));
    let (release_tx, release_rx) = channel::<()>();
    let (mut turns, _mailbox) = turns_with(release_rx, &closed, 0);
    turns.close_session("ses_idle").expect("idle close");
    let idle = turns
        .start_turn("ses_idle", &instance(), &input(), "worker (site@1)")
        .expect_err("an idle session that is closed takes no turn");
    assert!(idle.to_string().contains("closing"), "{idle}");

    turns
        .start_turn("ses_busy", &instance(), &input(), "worker (site@1)")
        .expect("start");
    turns
        .close_session("ses_busy")
        .expect("close requested mid-turn");
    let busy = turns
        .start_turn(
            "ses_busy",
            &Ref::new("site", 2),
            &input(),
            "worker (site@1)",
        )
        .expect_err("a closing session takes no second turn");
    assert!(busy.to_string().contains("closing"), "{busy}");
    release_tx.send(()).expect("release the turn");
}

/// A turn side built without a closer (`MailboxTurns::new`) does not pretend to close: the close is an error.
#[test]
fn a_turn_side_without_a_closer_refuses_to_close() {
    let (_release_tx, release_rx) = channel::<()>();
    let (mailbox, handle) = ActorMailbox::new();
    let runner = Arc::new(GatedRunner {
        release: Mutex::new(release_rx),
    });
    let mut turns = MailboxTurns::new(runner, handle);
    let error = turns
        .close_session("ses_unwired")
        .expect_err("no closer is wired");
    assert!(error.to_string().contains("no runtime closer"), "{error}");
    drop(mailbox);
}

/// Builds a turn side and returns the answer store its mailbox handle shares.
fn turns_and_parked(
    refusals: usize,
) -> (
    MailboxTurns,
    ActorMailbox,
    Arc<crate::parked_answers::ParkedAnswers>,
) {
    let closed = Arc::new(Mutex::new(Vec::new()));
    let (_release_tx, release_rx) = channel::<()>();
    let (mailbox, handle) = ActorMailbox::new();
    let parked = handle.parked();
    let runner = Arc::new(GatedRunner {
        release: Mutex::new(release_rx),
    });
    let closer = Arc::new(RecordingCloser {
        closed,
        refusals: Mutex::new(refusals),
    });
    (
        MailboxTurns::with_closer(runner, handle, closer),
        mailbox,
        parked,
    )
}

/// An answer delivered for a session whose turn is gone waits for a take that never comes. Closing the session drops it
/// and leaves the answers of other sessions alone.
#[test]
fn a_session_close_drops_its_parked_answers() {
    let (mut turns, _mailbox, parked) = turns_and_parked(0);
    parked.deliver("ses_gone", "dwfq-1", "late answer");
    parked.deliver("ses_other", "dwfq-2", "other answer");
    turns.close_session("ses_gone").expect("close");
    assert_eq!(
        parked.len(),
        1,
        "only the closed session's answer is dropped"
    );
}

/// A refused close leaves the session open, so its parked answers stay.
#[test]
fn a_refused_close_keeps_the_parked_answers() {
    let (mut turns, _mailbox, parked) = turns_and_parked(1);
    parked.deliver("ses_gone", "dwfq-1", "late answer");
    assert!(turns.close_session("ses_gone").is_err());
    assert_eq!(parked.len(), 1);
}
