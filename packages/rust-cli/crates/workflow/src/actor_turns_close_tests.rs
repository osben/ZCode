//! The turn side of the session close (W6b part 6): an idle session is closed at once, a session whose turn runs is closed
//! when the turn lands, and a close is requested once per session (Node driver tests rows 31, 32, 34 and 35, turn side).
use crate::actor_mailbox::ActorMailbox;
use crate::actor_sessions::ActorTurns;
use crate::actor_turns::{MailboxTurns, SessionCloser, TurnInput, TurnRunner};
use crate::model::Ref;
use crate::model_failure::TurnFailure;
use anyhow::{Result, bail};
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

/// Records each session the close was run for.
struct RecordingCloser {
    closed: Arc<Mutex<Vec<String>>>,
    refuse: bool,
}

impl SessionCloser for RecordingCloser {
    fn close(&self, session: &str) -> Result<()> {
        self.closed.lock().expect("closed").push(session.to_owned());
        if self.refuse {
            bail!("close refused");
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
    refuse: bool,
) -> (MailboxTurns, ActorMailbox) {
    let (mailbox, handle) = ActorMailbox::new();
    let runner = Arc::new(GatedRunner {
        release: Mutex::new(release),
    });
    let closer = Arc::new(RecordingCloser {
        closed: closed.clone(),
        refuse,
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
    let (mut turns, _mailbox) = turns_with(release_rx, &closed, false);
    turns.close_session("ses_idle").expect("close");
    assert_eq!(*closed.lock().expect("closed"), vec!["ses_idle".to_owned()]);
}

/// Row 32 (turn side): a session closed while its turn runs waits for the turn to land, then is closed once.
#[test]
fn row_32_turn_side_a_session_closed_mid_turn_is_closed_when_the_turn_lands() {
    let closed = Arc::new(Mutex::new(Vec::new()));
    let (release_tx, release_rx) = channel::<()>();
    let (mut turns, _mailbox) = turns_with(release_rx, &closed, false);
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
    let (mut turns, _mailbox) = turns_with(release_rx, &closed, false);
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
    let (mut turns, _mailbox) = turns_with(release_rx, &closed, true);
    let error = turns
        .close_session("ses_idle")
        .expect_err("the refused close is reported");
    assert!(error.to_string().contains("close refused"), "{error}");
}
