//! Cases from the ocr review of PR #563 (round 1) for the owner's world wiring: the panic message, the worker bound, and
//! the mailbox shutdown with wiring attached.

#![allow(clippy::result_large_err)]

use crate::actor_mailbox::ActorMailbox;
use crate::driver_owner_tests::owner;
use crate::error::ErrorCode;
use crate::world_host::{WORLD_JOB_LIMIT, WorldWiring};
use crate::world_read::{GlobHits, GrepHits, RunOutcome, RunRequest, WorldReadPorts};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

/// A read port that counts how many glob calls run at once and sleeps, so overlap would show.
struct Counting {
    active: AtomicUsize,
    peak: AtomicUsize,
    panic_message: Option<&'static str>,
}

impl WorldReadPorts for Counting {
    fn glob(&self, _pattern: &str, _limit: usize) -> Result<GlobHits, String> {
        let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(30));
        self.active.fetch_sub(1, Ordering::SeqCst);
        if let Some(message) = self.panic_message {
            panic!("{message}");
        }
        Ok(GlobHits::default())
    }

    fn read_text(&self, _path: &str) -> Result<String, String> {
        Ok(String::new())
    }

    fn grep(
        &self,
        _pattern: &str,
        _glob: Option<&str>,
        _head_limit: usize,
    ) -> Result<GrepHits, String> {
        Ok(GrepHits::default())
    }

    fn run(&self, _request: &RunRequest) -> Result<RunOutcome, String> {
        Err("not used".to_owned())
    }
}

fn counting(panic_message: Option<&'static str>) -> Arc<Counting> {
    Arc::new(Counting {
        active: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
        panic_message,
    })
}

/// Serve requests until the outcome of `ticket` is in.
fn settle(
    mailbox: &ActorMailbox,
    owner: &mut crate::driver_owner::ActorDriverOwner<
        crate::journal::MemoryJournal,
        crate::driver_owner_tests::Recording,
    >,
    ticket: u64,
) -> Result<Value, crate::error::WorkflowError> {
    for _ in 0..200 {
        if let Some(outcome) = owner
            .take_outcomes()
            .into_iter()
            .find(|o| o.ticket == ticket)
        {
            return outcome.result;
        }
        mailbox.serve_next(owner).expect("served");
    }
    panic!("the ticket never settled");
}

/// Finding 10: a panic in a port reaches the node's error message, so the reason is not lost.
#[test]
fn a_panic_message_from_the_port_is_kept_in_the_node_error() {
    let (mailbox, handle) = ActorMailbox::new();
    let (owner, _sessions) = owner();
    let mut owner = owner.with_world(WorldWiring {
        reads: counting(Some("the port broke on purpose")),
        cwd: PathBuf::from("/ws/root"),
        artifacts: None,
        done: handle,
    });
    let ticket = owner
        .world_read("site", "glob", vec![json!("*")])
        .expect("admitted");
    let error = settle(&mailbox, &mut owner, ticket).expect_err("the panic is a failure");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert!(
        error.message.contains("the port broke on purpose"),
        "{}",
        error.message
    );
}

/// Finding 5: world jobs run at most `WORLD_JOB_LIMIT` at a time; the rest wait in the owner's queue.
#[test]
fn world_jobs_are_bounded_and_the_rest_wait() {
    let (mailbox, handle) = ActorMailbox::new();
    let (owner, _sessions) = owner();
    let port = counting(None);
    let mut owner = owner.with_world(WorldWiring {
        reads: port.clone(),
        cwd: PathBuf::from("/ws/root"),
        artifacts: None,
        done: handle,
    });
    let jobs = WORLD_JOB_LIMIT * 3;
    let tickets: Vec<u64> = (0..jobs)
        .map(|_| {
            owner
                .world_read("site", "glob", vec![json!("*")])
                .expect("admitted")
        })
        .collect();
    // Collect every outcome: `take_outcomes` drains all of them, so a per-ticket helper would drop the others.
    let mut settled = std::collections::HashMap::new();
    for _ in 0..(jobs * 4) {
        for outcome in owner.take_outcomes() {
            settled.insert(outcome.ticket, outcome.result);
        }
        if settled.len() == jobs {
            break;
        }
        mailbox.serve_next(&mut owner).expect("served");
    }
    assert_eq!(settled.len(), jobs, "every glob settles");
    for ticket in tickets {
        assert!(settled[&ticket].is_ok());
    }
    let peak = port.peak.load(Ordering::SeqCst);
    assert!(
        (1..=WORLD_JOB_LIMIT).contains(&peak),
        "peak concurrency {peak} is over the limit {WORLD_JOB_LIMIT}"
    );
}

/// Finding 7: with wiring attached, the mailbox still closes after the run settles and every handle is gone. The owner
/// must not keep a handle once the run is settled and no world job is in flight.
#[test]
fn the_mailbox_closes_after_the_run_settles_with_wiring_attached() {
    let (mailbox, handle) = ActorMailbox::new();
    let (owner, _sessions) = owner();
    let mut owner = owner.with_world(WorldWiring {
        reads: counting(None),
        cwd: PathBuf::from("/ws/root"),
        artifacts: None,
        done: handle,
    });
    owner
        .complete(json!({"text": "done"}))
        .expect("the run completes");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let closed = mailbox.take().is_err();
        let _ = tx.send(closed);
    });
    let closed = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("the mailbox loop ends, so the owner does not keep a handle alive");
    assert!(closed);
}
