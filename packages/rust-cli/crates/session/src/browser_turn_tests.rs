//! Fork D2 (specs/fork-rust-node-helper.md "D2 end-of-turn screenshot"): full-turn tests of `finish_turn`'s screenshot
//! path. Node's `browser-turn-screenshot.test.ts` is the oracle: a turn with a candidate captures once and stores one
//! entry; an aborted, failed or superseded turn consumes its candidate and captures nothing; the next model request
//! carries no trace of the stored screenshot.
//!
//! The candidate registry and the port are process-level, so every test here names its own session id.
//! Candidates are recorded for run ids `run_1..=200` (`SequentialIds` allocates `run_N`), and the count of pending
//! candidates shows how many a turn consumed.
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_kernel_api::browser_turn::{
    self, BrowserCandidate, CapturedScreenshot, TURN_SCREENSHOT_ENTRY_KIND, TurnScreenshotPort,
};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelError;
use rust_cli_kernel_api::session_api::{Command, KernelEvent, SessionHandle, TurnOutcome};
use rust_cli_kernel_api::store::SessionStore;
use rust_cli_kernel_api::testing::{ScriptedModel, text_response};
use tokio_util::sync::CancellationToken;

use crate::test_support::{Setup, envelope, finished, submit, until};

const SHOT: &str = "QkJCQg==";

/// Counts the captures a turn asked for, and answers `shot` (or nothing).
struct Fake {
    captures: Mutex<usize>,
    shot: Option<CapturedScreenshot>,
}

#[async_trait]
impl TurnScreenshotPort for Fake {
    async fn capture(
        &self,
        _session: &str,
        _turn: &str,
        _candidate: &BrowserCandidate,
        _cancel: CancellationToken,
    ) -> Option<CapturedScreenshot> {
        *self.captures.lock().unwrap() += 1;
        self.shot.clone()
    }
}

fn shot() -> CapturedScreenshot {
    CapturedScreenshot {
        base64: SHOT.to_owned(),
        mime_type: "image/png".to_owned(),
    }
}

fn candidate() -> BrowserCandidate {
    BrowserCandidate {
        browser_id: "iab-1".to_owned(),
        browser_generation: 2,
    }
}

/// Candidates for every run id a test session can allocate, so whichever run a turn gets, its candidate is there.
fn record_candidates(session: &str) {
    for n in 1..=200 {
        browser_turn::record(session, &format!("run_{n}"), candidate());
    }
}

fn bind_fake(session: &str, shot: Option<CapturedScreenshot>) -> std::sync::Arc<Fake> {
    let fake = std::sync::Arc::new(Fake {
        captures: Mutex::new(0),
        shot,
    });
    browser_turn::bind(session, fake.clone());
    fake
}

fn captures(fake: &Fake) -> usize {
    *fake.captures.lock().unwrap()
}

fn position(events: &[KernelEvent], wanted: impl Fn(&KernelEvent) -> bool) -> Option<usize> {
    events.iter().position(wanted)
}

#[tokio::test]
async fn a_successful_turn_captures_once_stores_one_entry_and_logs_the_row_before_turn_finished() {
    let session = "sess_d2_success";
    let fake = bind_fake(session, Some(shot()));
    record_candidates(session);
    let model = std::sync::Arc::new(ScriptedModel::new(vec![text_response(&["one"])]));
    let mut built = Setup::new(model);
    built.session_id = Some(session);
    let built = built.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "first")).await;
    let seen = until(&mut events, finished).await;

    assert_eq!(captures(&fake), 1, "one capture for the turn");
    let stored = built
        .store
        .entries(&SessionId::new(session), TURN_SCREENSHOT_ENTRY_KIND)
        .await
        .unwrap();
    assert_eq!(stored.len(), 1, "one entry per capture");
    let row = position(&seen, |event| {
        matches!(event, KernelEvent::BrowserTurnScreenshot { .. })
    });
    let turn_finished = position(&seen, |event| {
        matches!(
            event,
            KernelEvent::TurnFinished {
                outcome: TurnOutcome::Success,
                ..
            }
        )
    });
    assert!(row.is_some() && turn_finished.is_some(), "{seen:?}");
    assert!(row < turn_finished, "the row is logged before TurnFinished");
    assert_eq!(
        browser_turn::pending(session),
        199,
        "exactly one candidate was consumed"
    );
    browser_turn::forget_session(session);
}

#[tokio::test]
async fn the_next_model_request_carries_no_trace_of_the_stored_screenshot() {
    let session = "sess_d2_exclusion";
    bind_fake(session, Some(shot()));
    record_candidates(session);
    let model = std::sync::Arc::new(ScriptedModel::new(vec![
        text_response(&["one"]),
        text_response(&["two"]),
    ]));
    let mut built = Setup::new(model.clone());
    built.session_id = Some(session);
    let built = built.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "first")).await;
    until(&mut events, finished).await;
    built.session.send(submit("c2", "second")).await;
    until(&mut events, finished).await;

    let requests = model.requests();
    assert_eq!(requests.len(), 2, "one request per turn");
    let next = serde_json::to_string(&requests[1].messages).unwrap();
    for trace in [
        SHOT,
        "node_repl_images",
        "browser_turn_end",
        "fork_browser_turn_screenshot",
        "mcp__node_repl__js",
    ] {
        assert!(
            !next.contains(trace),
            "the next request contains {trace}: {next}"
        );
    }
    // The first turn's screenshot is stored before the second request is built, so the exclusion is by design. The
    // second turn captures too (it has its own candidate), so two entries exist after both turns.
    let stored = built
        .store
        .entries(&SessionId::new(session), TURN_SCREENSHOT_ENTRY_KIND)
        .await
        .unwrap();
    assert_eq!(stored.len(), 2);
    browser_turn::forget_session(session);
}

#[tokio::test]
async fn an_aborted_turn_consumes_its_candidate_and_captures_nothing() {
    let session = "sess_d2_abort";
    let fake = bind_fake(session, Some(shot()));
    record_candidates(session);
    let gate = std::sync::Arc::new(tokio::sync::Notify::new());
    let model = std::sync::Arc::new(crate::test_support::GatedModel::new(gate));
    let mut built = Setup::new(model);
    built.session_id = Some(session);
    let built = built.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "first")).await;
    until(&mut events, |event| {
        matches!(event, KernelEvent::TurnStarted { .. })
    })
    .await;
    built.session.send(envelope("c2", Command::Interrupt)).await;
    let seen = until(&mut events, finished).await;

    assert!(seen.iter().any(|event| matches!(
        event,
        KernelEvent::TurnFinished {
            outcome: TurnOutcome::Interrupted,
            ..
        }
    )));
    assert_eq!(captures(&fake), 0, "no capture for an aborted turn");
    assert_eq!(
        browser_turn::pending(session),
        199,
        "the candidate is consumed"
    );
    let stored = built
        .store
        .entries(&SessionId::new(session), TURN_SCREENSHOT_ENTRY_KIND)
        .await
        .unwrap();
    assert!(stored.is_empty(), "no entry for an aborted turn");
    browser_turn::forget_session(session);
}

#[tokio::test]
async fn a_failed_turn_consumes_its_candidate_and_captures_nothing() {
    let session = "sess_d2_error";
    let fake = bind_fake(session, Some(shot()));
    record_candidates(session);
    let model = std::sync::Arc::new(ScriptedModel::new(vec![vec![Err(
        ModelError::InvalidRequest {
            message: "refused".to_owned(),
        },
    )]]));
    let mut built = Setup::new(model);
    built.session_id = Some(session);
    let built = built.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "first")).await;
    let seen = until(&mut events, finished).await;

    assert!(
        seen.iter().any(|event| matches!(
            event,
            KernelEvent::TurnFinished {
                outcome: TurnOutcome::Failed { .. },
                ..
            }
        )),
        "{seen:?}"
    );
    assert_eq!(captures(&fake), 0, "no capture for a failed turn");
    assert_eq!(
        browser_turn::pending(session),
        199,
        "the candidate is consumed"
    );
    let stored = built
        .store
        .entries(&SessionId::new(session), TURN_SCREENSHOT_ENTRY_KIND)
        .await
        .unwrap();
    assert!(stored.is_empty(), "no entry for a failed turn");
    browser_turn::forget_session(session);
}

/// Rust has no "superseded" outcome: a turn replaced by a newer input ends interrupted. The first turn consumes its
/// candidate and captures nothing; the newer turn captures with its own.
#[tokio::test]
async fn a_turn_superseded_by_a_newer_input_does_not_leak_its_candidate_into_the_next() {
    let session = "sess_d2_superseded";
    let fake = bind_fake(session, Some(shot()));
    record_candidates(session);
    let gate = std::sync::Arc::new(tokio::sync::Notify::new());
    let model = std::sync::Arc::new(
        ScriptedModel::new(vec![text_response(&["one"]), text_response(&["two"])])
            .gated(gate.clone()),
    );
    let mut built = Setup::new(model);
    built.session_id = Some(session);
    let built = built.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "first")).await;
    until(&mut events, |event| {
        matches!(event, KernelEvent::TurnStarted { .. })
    })
    .await;
    built.session.send(envelope("c2", Command::Interrupt)).await;
    until(&mut events, finished).await;
    assert_eq!(captures(&fake), 0);
    gate.notify_one();
    built.session.send(submit("c3", "second")).await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    gate.notify_one();
    until(&mut events, finished).await;

    assert_eq!(captures(&fake), 1, "only the newer turn captures");
    assert_eq!(
        browser_turn::pending(session),
        198,
        "both turns consumed their candidate"
    );
    browser_turn::forget_session(session);
}
