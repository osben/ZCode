//! The mailbox between the actor turns and the owner (W6a part 2c-1). Turns run on their own threads and block on their
//! reply; the owner thread serves the mailbox. These tests serve it from the test thread.
use crate::actor_mailbox::{ActorHandle, ActorMailbox, MailboxError};
use crate::artifact_publish::{
    ArtifactFsPort, ArtifactStorePort, FsFault, StoreContent, StoreReceipt, StoreWrite,
};
use crate::driver_owner::{ActorDriverOwner, SubmitReply, TurnEndReply};
use crate::driver_owner_tests::{Recording, config, owner, request, running_ask};
use crate::engine::{RunSettlement, SubmitVerdict};
use crate::error::{ErrorCode, WorkflowError};
use crate::escalation::EscalateOutcome;
use crate::event::RunEvent;
use crate::journal::{JournalPort, MemoryJournal};
use crate::model::{ActorRow, Caps, NodeRow, Ref, RunRow, RunStatus, Settlement, StoredEvent};
use crate::world_host::{ArtifactWiring, WorldWiring};
use crate::world_read::{GlobHits, GrepHits, RunOutcome, RunRequest, WorldReadPorts};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[test]
fn a_submit_through_the_mailbox_gets_the_engine_verdict() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let (mailbox, handle) = ActorMailbox::new();
    let turn = thread::spawn(move || handle.submit(&session, json!({"ok": true})));
    mailbox.serve_next(&mut owner).expect("serve");
    let reply = turn.join().expect("turn thread").expect("reply");
    assert_eq!(reply, SubmitReply::Verdict(SubmitVerdict::Accept));
}

#[test]
fn a_turn_end_through_the_mailbox_gets_the_nudge() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let (mailbox, handle) = ActorMailbox::new();
    let turn = thread::spawn(move || handle.turn_ended(&session, "done"));
    mailbox.serve_next(&mut owner).expect("serve");
    let reply = turn.join().expect("turn thread").expect("reply");
    assert_eq!(reply, TurnEndReply::Verdict(SubmitVerdict::Nudge));
}

#[test]
fn an_escalation_through_the_mailbox_parks_and_the_answer_is_delivered_to_its_session() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let (mailbox, handle) = ActorMailbox::new();

    let asking = session.clone();
    let escalate_handle = handle.clone();
    let turn = thread::spawn(move || escalate_handle.escalate(&asking, request("which?")));
    mailbox.serve_next(&mut owner).expect("serve the escalate");
    let qid = match turn.join().expect("turn thread").expect("reply") {
        EscalateOutcome::Parked { qid } => qid,
        other => panic!("expected a park, got {other:?}"),
    };

    let answering = qid.clone();
    let main_agent = thread::spawn(move || handle.answer(&answering, "the second one"));
    mailbox.serve_next(&mut owner).expect("serve the answer");
    let answered = main_agent
        .join()
        .expect("main agent thread")
        .expect("reply")
        .expect("the question was parked");
    assert_eq!(answered.answer, "the second one");
    assert_eq!(
        sessions.0.borrow().answered,
        vec![(session, qid, "the second one".to_owned())]
    );
}

#[test]
fn a_request_after_the_owner_is_gone_is_not_delivered_and_says_so() {
    let (mailbox, handle) = ActorMailbox::new();
    drop(mailbox);
    let error = handle
        .submit("sess_x", json!({}))
        .expect_err("no owner serves a dropped mailbox");
    assert!(matches!(error, MailboxError::NotDelivered), "{error}");
    assert!(error.to_string().contains("not delivered"), "{error}");
}

#[test]
fn when_every_handle_is_dropped_the_owner_loop_sees_a_closed_mailbox() {
    let (mut owner, _sessions) = owner();
    let (mailbox, handle) = ActorMailbox::new();
    let second = handle.clone();
    drop(handle);
    drop(second);
    let error = mailbox
        .serve_next(&mut owner)
        .expect_err("nothing can send any more");
    assert!(matches!(error, MailboxError::Closed), "{error}");
}

#[test]
fn a_request_the_owner_received_but_never_answered_tells_its_turn_it_may_have_been_applied() {
    let (mailbox, handle) = ActorMailbox::new();
    let turn = thread::spawn(move || handle.submit("sess_x", json!({})));
    // The owner takes the request and dies before it replies: the request's reply sender is dropped with it.
    let received = mailbox.take().expect("the request arrives");
    drop(received);
    let error = turn
        .join()
        .expect("turn thread")
        .expect_err("no answer comes");
    assert!(matches!(error, MailboxError::NoAnswer), "{error}");
    assert!(
        error.to_string().contains("may already have been applied"),
        "{error}"
    );
}

/// A journal whose appends can be made to fail after the owner is running, to reach an owner error through the
/// mailbox. Every other call delegates to a memory journal.
struct RefusingAppends {
    inner: MemoryJournal,
    refuse: Rc<Cell<bool>>,
}

impl JournalPort for RefusingAppends {
    fn create_run(&mut self, row: RunRow) -> Result<()> {
        self.inner.create_run(row)
    }
    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>> {
        self.inner.get_run(run_id)
    }
    fn update_run_status(
        &mut self,
        run_id: &str,
        status: RunStatus,
        settlement: &Settlement,
    ) -> Result<()> {
        self.inner.update_run_status(run_id, status, settlement)
    }
    fn update_run_usage(&mut self, run_id: &str, spent_tokens: f64) -> Result<()> {
        self.inner.update_run_usage(run_id, spent_tokens)
    }
    fn update_run_caps(&mut self, run_id: &str, caps: Caps) -> Result<()> {
        self.inner.update_run_caps(run_id, caps)
    }
    fn update_run_script(
        &mut self,
        run_id: &str,
        script_text: &str,
        script_hash: &str,
    ) -> Result<()> {
        self.inner
            .update_run_script(run_id, script_text, script_hash)
    }
    fn put_actor(&mut self, row: ActorRow) -> Result<()> {
        self.inner.put_actor(row)
    }
    fn get_actor(&self, run_id: &str, actor: &Ref) -> Result<Option<ActorRow>> {
        self.inner.get_actor(run_id, actor)
    }
    fn list_actors(&self, run_id: &str) -> Result<Vec<ActorRow>> {
        self.inner.list_actors(run_id)
    }
    fn put_node(&mut self, row: NodeRow) -> Result<()> {
        self.inner.put_node(row)
    }
    fn get_node(&self, run_id: &str, instance: &Ref) -> Result<Option<NodeRow>> {
        self.inner.get_node(run_id, instance)
    }
    fn list_nodes(&self, run_id: &str) -> Result<Vec<NodeRow>> {
        self.inner.list_nodes(run_id)
    }
    fn append_event(&mut self, run_id: &str, event: &RunEvent) -> Result<StoredEvent> {
        if self.refuse.get() {
            bail!("journal refused the append");
        }
        self.inner.append_event(run_id, event)
    }
    fn list_events(&self, run_id: &str) -> Result<Vec<StoredEvent>> {
        self.inner.list_events(run_id)
    }
}

#[test]
fn an_owner_error_reaches_the_turn_with_its_context() {
    let refuse = Rc::new(Cell::new(false));
    let journal = RefusingAppends {
        inner: MemoryJournal::new(),
        refuse: refuse.clone(),
    };
    let sessions = Recording::default();
    let mut owner = ActorDriverOwner::new(config(), journal, sessions).expect("owner");
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    let session = owner.session_of(&actor).expect("session");

    let (mailbox, handle) = ActorMailbox::new();
    let turn = thread::spawn(move || handle.escalate(&session, request("which?")));
    refuse.set(true);
    mailbox.serve_next(&mut owner).expect("serve");
    let error = turn
        .join()
        .expect("turn thread")
        .expect_err("the owner's error reaches the turn");
    match &error {
        MailboxError::Owner(inner) => {
            let text = format!("{inner:#}");
            assert!(text.contains("journal refused the append"), "{text}");
        }
        other => panic!("expected the owner's error, got {other:?}"),
    }
}

// W7-5a-2: the child's calls over the mailbox. A ticketed call (ask, world read, publish) is answered when its outcome
// settles, not when the ticket is issued. A stop or the owner's shutdown answers every pending ticket with an error.

/// Runs one call on a turn thread, serves its request on the owner, and returns the reply.
fn serve_call<T: Send + 'static>(
    mailbox: &ActorMailbox,
    owner: &mut ActorDriverOwner<MemoryJournal, Recording>,
    call: impl FnOnce() -> T + Send + 'static,
) -> T {
    let turn = thread::spawn(call);
    mailbox.serve_next(owner).expect("serve the call");
    turn.join().expect("turn thread")
}

/// A read port whose first `read_text` waits until the test drops the sender of its gate, so a world read stays pending.
/// The gate is taken out of its lock before the wait, so no second read waits on the first one's lock; a read that finds
/// no gate (none was given, or it was already taken) answers at once.
struct HeldRead(Mutex<Option<Receiver<()>>>);

impl WorldReadPorts for HeldRead {
    fn glob(&self, _pattern: &str, _limit: usize) -> Result<GlobHits, String> {
        Ok(GlobHits {
            total: 0,
            files: Vec::new(),
        })
    }
    fn read_text(&self, _path: &str) -> Result<String, String> {
        let gate = self.0.lock().expect("the gate").take();
        if let Some(gate) = gate {
            let _ = gate.recv();
        }
        Ok("text".to_owned())
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

struct NoFiles;

impl ArtifactFsPort for NoFiles {
    fn read_file(&self, _path: &Path, _max_bytes: usize) -> Result<Vec<u8>, FsFault> {
        Err(FsFault::NotFound)
    }
    fn real_path(&self, path: &Path) -> Result<PathBuf, FsFault> {
        Ok(path.to_path_buf())
    }
}

struct Store;

impl ArtifactStorePort for Store {
    fn supports_binary(&self) -> bool {
        false
    }
    fn write(&self, write: &StoreWrite<'_>) -> Result<StoreReceipt, String> {
        Ok(StoreReceipt {
            bytes: match write.content {
                StoreContent::Text(text) => text.len(),
                StoreContent::Binary(bytes) => bytes.len(),
            },
            uri: format!(
                "zcode-artifact://{}/{}",
                write.session_id, write.tool_call_id
            ),
        })
    }
}

fn now() -> u64 {
    1_700_000_000_123
}

/// A gate whose sender the test keeps: the receiver blocks for as long as the sender lives.
fn held_gate() -> (Sender<()>, Receiver<()>) {
    channel()
}

type PendingAsk = thread::JoinHandle<Result<Result<Value, WorkflowError>, MailboxError>>;

/// An untyped ask on a fresh actor, started by a drain, so its turn is in flight. Returns the actor id, the session
/// and the turn thread that waits on the ask.
fn started_plain_ask(
    mailbox: &ActorMailbox,
    handle: &ActorHandle,
    owner: &mut ActorDriverOwner<MemoryJournal, Recording>,
) -> (String, String, PendingAsk) {
    let creating = handle.clone();
    let actor = serve_call(mailbox, owner, move || {
        creating.create_actor("plain", None, None)
    })
    .expect("the actor is created");
    let asking = handle.clone();
    let for_ask = actor.clone();
    let ask = thread::spawn(move || asking.ask("plain", &for_ask, "go"));
    mailbox.serve_next(owner).expect("serve the ask");
    let draining = handle.clone();
    serve_call(mailbox, owner, move || draining.drain()).expect("the drain starts the turn");
    let session = owner.session_of(&actor).expect("the ask started a session");
    (actor, session, ask)
}

#[test]
fn an_ask_through_the_mailbox_is_answered_when_its_ask_settles_not_when_it_is_issued() {
    let (mut owner, _sessions) = owner();
    let (mailbox, handle) = ActorMailbox::new();
    let (_actor, session, ask) = started_plain_ask(&mailbox, &handle, &mut owner);

    // The ask is issued and its turn runs: nothing can answer it yet.
    thread::sleep(Duration::from_millis(50));
    assert!(!ask.is_finished(), "the ask waits for its settlement");

    let ending = handle.clone();
    let settled = serve_call(&mailbox, &mut owner, move || {
        ending.turn_ended(&session, "finished")
    });
    assert!(settled.is_ok(), "{settled:?}");
    let answer = ask
        .join()
        .expect("ask thread")
        .expect("the ask is answered");
    assert_eq!(answer, Ok(json!("finished")));
    assert!(
        owner.take_outcomes().is_empty(),
        "the mailbox reply claimed the settlement, so none is left for take_outcomes"
    );
}

#[test]
fn a_settlement_a_mailbox_reply_claims_is_not_left_for_take_outcomes_and_a_direct_one_is() {
    let (mut owner, _sessions) = owner();
    let (mailbox, handle) = ActorMailbox::new();
    let (_actor, session_a, ask_a) = started_plain_ask(&mailbox, &handle, &mut owner);
    let direct_actor = owner
        .create_actor("plain", None, None)
        .expect("the direct actor");
    let direct_ticket = owner
        .ask("plain", &direct_actor, "go")
        .expect("the direct ask");
    let draining = handle.clone();
    serve_call(&mailbox, &mut owner, move || draining.drain())
        .expect("the drain starts both turns");
    let session_b = owner
        .session_of(&direct_actor)
        .expect("the direct ask started a session");

    let ending = handle.clone();
    serve_call(&mailbox, &mut owner, move || {
        ending.turn_ended(&session_a, "mailboxed done")
    })
    .expect("the mailbox turn ends");
    owner
        .turn_ended(&session_b, "direct done")
        .expect("the direct turn ends");

    let answer = ask_a
        .join()
        .expect("ask thread")
        .expect("the mailbox ask is answered");
    assert_eq!(answer, Ok(json!("mailboxed done")));
    let left = owner.take_outcomes();
    assert_eq!(
        left.len(),
        1,
        "only the direct settlement is left: {left:?}"
    );
    assert_eq!(left[0].ticket, direct_ticket);
    assert_eq!(left[0].result, Ok(json!("direct done")));
}

#[test]
fn a_refused_ask_through_the_mailbox_is_answered_with_its_error_at_once() {
    let (mut owner, _sessions) = owner();
    let (mailbox, handle) = ActorMailbox::new();
    let ask = thread::spawn(move || handle.ask("plain", "plain@404", "go"));
    mailbox.serve_next(&mut owner).expect("serve the ask");
    let answer = ask
        .join()
        .expect("ask thread")
        .expect("the ask is answered");
    let error = answer.expect_err("an unknown actor refuses the ask");
    assert_eq!(error.code, ErrorCode::UnknownActor);
}

#[test]
fn create_actor_through_the_mailbox_returns_the_engine_actor_id() {
    let (mut owner, _sessions) = owner();
    let (mailbox, handle) = ActorMailbox::new();
    let id = serve_call(&mailbox, &mut owner, move || {
        handle.create_actor("plain", Some("worker"), None)
    })
    .expect("the actor is created");
    assert_eq!(id, Ref::new("plain", 1).key());
    // The journal's actor-created event carries the name the child passed.
    let created: Vec<Value> = journaled(&owner)
        .into_iter()
        .filter(|event| event["type"] == "actor-created")
        .collect();
    assert_eq!(created.len(), 1, "{created:?}");
    assert_eq!(created[0]["name"], "worker");
}

/// The owner's journaled events, parsed from their payloads.
fn journaled(owner: &ActorDriverOwner<MemoryJournal, Recording>) -> Vec<Value> {
    owner
        .events()
        .expect("events")
        .iter()
        .map(|event| serde_json::from_str(&event.payload_json).expect("a JSON payload"))
        .collect()
}

#[test]
fn a_world_read_through_the_mailbox_is_answered_when_the_worker_settles() {
    let (mailbox, handle) = ActorMailbox::new();
    let (owner, _sessions) = owner();
    let (_hold, gate) = held_gate();
    let mut owner = owner.with_world(WorldWiring {
        reads: Arc::new(HeldRead(Mutex::new(Some(gate)))),
        cwd: PathBuf::from("/ws/root"),
        artifacts: None,
        done: handle.clone(),
    });
    let read = thread::spawn(move || handle.world_read("site", "read", vec![json!("a.md")]));
    mailbox
        .serve_next(&mut owner)
        .expect("serve the world read");
    // The worker waits on its gate, so the read has no settlement yet.
    thread::sleep(Duration::from_millis(50));
    assert!(!read.is_finished(), "the read waits for its worker");
    drop(_hold);
    // The worker posts its settlement to this mailbox; serving it answers the read.
    mailbox
        .serve_next(&mut owner)
        .expect("serve the settlement");
    let answer = read.join().expect("read thread").expect("reply");
    assert_eq!(answer, Ok(json!("text")));
}

#[test]
fn an_artifact_publish_through_the_mailbox_is_answered_when_its_store_settles() {
    let (mailbox, handle) = ActorMailbox::new();
    let (owner, _sessions) = owner();
    // A publish never reads, so its read port is a double that does not block: the store's settlement is the only wait.
    let mut owner = owner.with_world(WorldWiring {
        reads: Arc::new(HeldRead(Mutex::new(None))),
        cwd: PathBuf::from("/ws/root"),
        artifacts: Some(ArtifactWiring {
            fs: Arc::new(NoFiles),
            store: Some(Arc::new(Store)),
            parent_session_id: Some("ses_parent".to_owned()),
            now_ms: now,
        }),
        done: handle.clone(),
    });
    let publish = thread::spawn(move || {
        handle.publish_artifact("site", "markdown", vec![json!("report"), json!("# hi")])
    });
    mailbox.serve_next(&mut owner).expect("serve the publish");
    mailbox
        .serve_next(&mut owner)
        .expect("serve the store's settlement");
    let answer = publish.join().expect("publish thread").expect("reply");
    assert_eq!(answer, Ok(json!({"id": "report", "version": 1})));
}

#[test]
fn a_stop_through_the_mailbox_answers_a_pending_ask_with_run_stopped() {
    let (mut owner, _sessions) = owner();
    let (mailbox, handle) = ActorMailbox::new();
    let (_actor, _session, ask) = started_plain_ask(&mailbox, &handle, &mut owner);
    assert!(handle.stop_interrupted(), "the stop is posted");
    mailbox.serve_next(&mut owner).expect("serve the stop");
    let answer = ask
        .join()
        .expect("ask thread")
        .expect("the ask is answered");
    let error = answer.expect_err("a stopped run rejects its pending ask");
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert_eq!(error.message, "Run stopped.");
}

#[test]
fn a_stop_leaves_a_pending_world_read_to_its_worker_which_then_rejects_with_the_run_error() {
    let (mailbox, handle) = ActorMailbox::new();
    let (owner, _sessions) = owner();
    let (_hold, gate) = held_gate();
    let mut owner = owner.with_world(WorldWiring {
        reads: Arc::new(HeldRead(Mutex::new(Some(gate)))),
        cwd: PathBuf::from("/ws/root"),
        artifacts: None,
        done: handle.clone(),
    });
    let reading = handle.clone();
    let read = thread::spawn(move || reading.world_read("site", "read", vec![json!("a.md")]));
    mailbox
        .serve_next(&mut owner)
        .expect("serve the world read");
    assert!(handle.stop_interrupted(), "the stop is posted");
    mailbox.serve_next(&mut owner).expect("serve the stop");
    // Node: a world read is not an abortInFlight entry, so the stop does not reject it. It waits for its worker.
    thread::sleep(Duration::from_millis(50));
    assert!(!read.is_finished(), "the stop does not answer a world read");
    drop(_hold);
    mailbox
        .serve_next(&mut owner)
        .expect("serve the worker's settlement");
    let answer = read.join().expect("read thread").expect("reply");
    let error = answer.expect_err("a stopped run rejects its pending read");
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert_eq!(error.message, "Run already settled.");
}

#[test]
fn shutting_the_owner_down_answers_a_pending_ask_with_an_error() {
    let (mut owner, _sessions) = owner();
    let (mailbox, handle) = ActorMailbox::new();
    let (_actor, _session, ask) = started_plain_ask(&mailbox, &handle, &mut owner);
    drop(owner);
    let answer = ask
        .join()
        .expect("ask thread")
        .expect("the ask is answered");
    let error = answer.expect_err("the owner is gone before the ask settled");
    assert!(error.message.contains("shut down"), "{}", error.message);
}

#[test]
fn complete_through_the_mailbox_settles_the_run() {
    let (mut owner, _sessions) = owner();
    let (mailbox, handle) = ActorMailbox::new();
    serve_call(&mailbox, &mut owner, move || handle.complete(json!("done")))
        .expect("the run completes");
    match owner.settlement() {
        Some(RunSettlement::Completed { artifact }) => assert_eq!(artifact, &json!("done")),
        other => panic!("expected the run to complete, got {other:?}"),
    }
}

#[test]
fn log_and_phase_posted_through_the_mailbox_are_recorded_in_order() {
    let (mut owner, _sessions) = owner();
    let (mailbox, handle) = ActorMailbox::new();
    assert!(handle.log("the first note"));
    assert!(handle.enter_phase("phase one"));
    mailbox.serve_next(&mut owner).expect("serve the log");
    mailbox.serve_next(&mut owner).expect("serve the phase");
    let events = owner.events().expect("events");
    let payloads: Vec<&str> = events
        .iter()
        .map(|event| event.payload_json.as_str())
        .collect();
    let log = payloads
        .iter()
        .position(|text| text.contains("the first note"))
        .expect("the log is journaled");
    let phase = payloads
        .iter()
        .position(|text| text.contains("phase one"))
        .expect("the phase is journaled");
    assert!(log < phase, "the child's order is kept");
}

#[test]
fn report_through_the_mailbox_is_journaled_under_its_site_without_an_artifact_id() {
    let (mut owner, _sessions) = owner();
    let (mailbox, handle) = ActorMailbox::new();
    assert!(handle.report("site", json!({"n": 1}), None));
    mailbox.serve_next(&mut owner).expect("serve the report");
    let reports: Vec<Value> = journaled(&owner)
        .into_iter()
        .filter(|event| event["type"] == "report")
        .collect();
    assert_eq!(reports.len(), 1, "{reports:?}");
    assert_eq!(reports[0]["instance"]["siteId"], "site");
    assert_eq!(reports[0]["item"], json!({"n": 1}));
    assert!(
        reports[0].get("artifactId").is_none(),
        "an untagged report names no preset"
    );
}

#[test]
fn a_report_tagged_with_an_undeclared_preset_fails_the_run_through_the_mailbox() {
    let (mut owner, _sessions) = owner();
    let (mailbox, handle) = ActorMailbox::new();
    assert!(handle.report("site", json!({"n": 2}), Some("chart")));
    mailbox.serve_next(&mut owner).expect("serve the report");
    match owner.settlement() {
        Some(RunSettlement::Errored { error }) => {
            assert_eq!(error["code"], "ArtifactUndeclared", "{error}");
        }
        other => panic!("expected the run to fail, got {other:?}"),
    }
}
