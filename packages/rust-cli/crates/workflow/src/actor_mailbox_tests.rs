//! The mailbox between the actor turns and the owner (W6a part 2c-1). Turns run on their own threads and block on their
//! reply; the owner thread serves the mailbox. These tests serve it from the test thread.
use crate::actor_mailbox::{ActorMailbox, MailboxError};
use crate::driver_owner::ActorDriverOwner;
use crate::driver_owner::{SubmitReply, TurnEndReply};
use crate::driver_owner_tests::{Recording, config, owner, request, running_ask};
use crate::engine::SubmitVerdict;
use crate::escalation::EscalateOutcome;
use crate::event::RunEvent;
use crate::journal::{JournalPort, MemoryJournal};
use crate::model::{ActorRow, Caps, NodeRow, Ref, RunRow, RunStatus, Settlement, StoredEvent};
use anyhow::{Result, bail};
use serde_json::json;
use std::cell::Cell;
use std::rc::Rc;
use std::thread;

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
