//! The driver owner (W6a part 2): the engine's port, the submit and turn-end routes, the escalation book, and the
//! session creation, pinned against the Node driver's port rules. The turn side is a recorder, so these tests run
//! without a child session; the turn loop itself is tested in the agents crate.
use crate::driver_owner::{ActorDriverOwner, ActorSessionRequest, ActorSessions, SubmitReply};
use crate::driver_rules::SubmitProfile;
use crate::driver_rules::{
    ESCALATION_BUDGET_EXHAUSTED, NO_ACTIVE_ASK_MESSAGE, UNTYPED_ASK_MESSAGE, actor_session_title,
};
use crate::engine::AskMessage;
use crate::engine::{AskSpec, EngineConfig, SubmitVerdict};
use crate::error::ErrorCode;
use crate::escalation::{EscalateOutcome, EscalationRequest, RefusalReason};
use crate::journal::{JournalPort, MemoryJournal};
use crate::model::{Ref, Violation};
use anyhow::Result;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::rc::Rc;

/// Everything the turn side was asked to do, in order.
#[derive(Default)]
struct Log {
    created: Vec<ActorSessionRequest>,
    turns: Vec<(String, Ref, AskMessage)>,
    cancelled: Vec<(String, Ref)>,
    rejected: Vec<(String, String)>,
    next: u64,
}

#[derive(Clone, Default)]
struct Recording(Rc<RefCell<Log>>);

impl ActorSessions for Recording {
    fn create_session(&mut self, request: &ActorSessionRequest) -> Result<String> {
        let mut log = self.0.borrow_mut();
        log.next += 1;
        log.created.push(request.clone());
        Ok(format!("sess_{}", log.next))
    }

    fn start_turn(&mut self, session: &str, instance: &Ref, message: &AskMessage) {
        self.0
            .borrow_mut()
            .turns
            .push((session.to_owned(), instance.clone(), message.clone()));
    }

    fn cancel_turn(&mut self, session: &str, instance: &Ref) {
        self.0
            .borrow_mut()
            .cancelled
            .push((session.to_owned(), instance.clone()));
    }

    fn reject_parked(&mut self, session: &str, qid: &str) {
        self.0
            .borrow_mut()
            .rejected
            .push((session.to_owned(), qid.to_owned()));
    }
}

/// A validator that accepts an object with an `ok` member and names the missing member otherwise.
fn needs_ok(_schema: &Value, value: &Value) -> Vec<Violation> {
    if value.get("ok").is_some() {
        Vec::new()
    } else {
        vec![Violation {
            path: "$.ok".into(),
            expected: "ok".into(),
            got: "missing".into(),
        }]
    }
}

fn config() -> EngineConfig {
    let mut config = EngineConfig {
        run_id: "run_1".into(),
        parent_session_id: Some("ses_parent".into()),
        validate: needs_ok,
        ..Default::default()
    };
    config.caps.max_concurrency = 4.0;
    config.ask_specs.insert(
        "site".into(),
        AskSpec {
            typed: true,
            schema: Some(json!({"type": "object"})),
        },
    );
    config.ask_specs.insert(
        "plain".into(),
        AskSpec {
            typed: false,
            schema: None,
        },
    );
    config
}

fn owner() -> (ActorDriverOwner<MemoryJournal, Recording>, Recording) {
    let sessions = Recording::default();
    let owner =
        ActorDriverOwner::new(config(), MemoryJournal::new(), sessions.clone()).expect("owner");
    (owner, sessions)
}

fn request(question: &str) -> EscalationRequest {
    EscalationRequest {
        actor: Ref::new("site", 1),
        actor_name: None,
        question: question.into(),
        context: None,
        asked_at: 1_700_000_000_000,
    }
}

/// One typed ask on a fresh actor, started and running. Returns the owner, the recorder, the actor id and session.
fn running_ask() -> (
    ActorDriverOwner<MemoryJournal, Recording>,
    Recording,
    String,
    String,
) {
    let (mut owner, sessions) = owner();
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    let session = owner.session_of(&actor).expect("session");
    (owner, sessions, actor, session)
}

#[test]
fn an_actor_session_carries_the_node_title_parent_and_link_path() {
    let (mut owner, sessions) = owner();
    let actor = owner
        .create_actor("site", Some("Ada"), None)
        .expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    let log = sessions.0.borrow();
    let created = &log.created[0];
    assert_eq!(created.run_id, "run_1");
    assert_eq!(created.parent_session_id.as_deref(), Some("ses_parent"));
    assert_eq!(created.actor, Ref::new("site", 1));
    assert_eq!(actor, "site@1");
    assert_eq!(created.title, actor_session_title("site", 1));
    assert_eq!(created.link_path, "dwf/run_1/site@1");
}

#[test]
fn a_submit_with_no_ask_in_flight_is_refused_and_the_engine_writes_nothing() {
    let (mut owner, _sessions) = owner();
    let session = "sess_unasked";
    let before = owner.events().expect("events").len();
    let reply = owner
        .submit_result(session, json!({"ok": true}))
        .expect("submit");
    assert_eq!(
        reply,
        SubmitReply::Refused(NO_ACTIVE_ASK_MESSAGE.to_owned())
    );
    assert_eq!(owner.events().expect("events").len(), before);
}

#[test]
fn a_submit_on_an_untyped_ask_is_refused_at_the_port() {
    let (mut owner, _sessions) = owner();
    let actor = owner.create_actor("plain", None, None).expect("actor");
    owner.ask("plain", &actor, "say hi").expect("ask");
    owner.drain().expect("drain");
    let session = owner.session_of(&actor).expect("session");
    let before = owner.events().expect("events").len();
    let reply = owner
        .submit_result(&session, json!({"ok": true}))
        .expect("submit");
    assert_eq!(reply, SubmitReply::Refused(UNTYPED_ASK_MESSAGE.to_owned()));
    assert_eq!(owner.events().expect("events").len(), before);
}

#[test]
fn a_valid_submit_settles_the_ask_and_the_session_has_no_ask_afterwards() {
    let (mut owner, _sessions, actor, session) = running_ask();
    let reply = owner
        .submit_result(&session, json!({"ok": true}))
        .expect("submit");
    assert_eq!(reply, SubmitReply::Verdict(SubmitVerdict::Accept));
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].result, Ok(json!({"ok": true})));
    let again = owner
        .submit_result(&session, json!({"ok": true}))
        .expect("submit");
    assert_eq!(
        again,
        SubmitReply::Refused(NO_ACTIVE_ASK_MESSAGE.to_owned())
    );
    assert!(!actor.is_empty());
}

#[test]
fn an_invalid_submit_is_rejected_with_its_violations_and_the_ask_stays_live() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let reply = owner
        .submit_result(&session, json!({"nope": 1}))
        .expect("submit");
    match reply {
        SubmitReply::Verdict(SubmitVerdict::Reject { violations }) => {
            assert_eq!(violations[0].path, "$.ok");
        }
        other => panic!("expected a rejection, got {other:?}"),
    }
    assert!(owner.take_outcomes().is_empty(), "the ask is still running");
    let reply = owner
        .submit_result(&session, json!({"ok": true}))
        .expect("submit");
    assert_eq!(reply, SubmitReply::Verdict(SubmitVerdict::Accept));
}

#[test]
fn a_turn_that_ends_without_a_submit_is_nudged_once_by_the_engine() {
    let (mut owner, _sessions, _actor, _session) = running_ask();
    let verdict = owner.turn_ended(&_session, "I am done.").expect("turn end");
    assert_eq!(verdict, Some(SubmitVerdict::Nudge));
    assert!(owner.take_outcomes().is_empty());
}

#[test]
fn a_mono_profile_that_misses_the_ask_falls_back_and_the_ask_still_runs() {
    let (mut owner, sessions) = owner();
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.set_actor_profile(
        &actor,
        SubmitProfile::Mono {
            schema: json!({"type": "array"}),
        },
    );
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    let session = owner.session_of(&actor).expect("session");
    assert_eq!(
        sessions.0.borrow().turns.len(),
        1,
        "the turn starts on the generic fallback"
    );
    assert!(owner.take_outcomes().is_empty());
    let reply = owner
        .submit_result(&session, json!({"ok": true}))
        .expect("submit");
    assert_eq!(reply, SubmitReply::Verdict(SubmitVerdict::Accept));
}

#[test]
fn an_untyped_profile_on_a_typed_ask_fails_the_ask_with_the_driver_error() {
    let (mut owner, sessions) = owner();
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.set_actor_profile(&actor, SubmitProfile::Untyped);
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    assert!(
        sessions.0.borrow().turns.is_empty(),
        "no turn starts for an unservable ask"
    );
    let outcomes = owner.take_outcomes();
    let error = outcomes[0].result.as_ref().expect_err("the ask fails");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert!(error.message.contains("untyped"), "{}", error.message);
}

#[test]
fn an_escalation_without_an_ask_is_refused_and_writes_nothing() {
    let (mut owner, _sessions) = owner();
    let session = "sess_unasked";
    let before = owner.events().expect("events").len();
    let outcome = owner
        .escalate(session, request("which?"))
        .expect("escalate");
    assert_eq!(
        outcome,
        EscalateOutcome::Refused {
            reason: RefusalReason::NoActiveAsk,
            message: crate::escalation::NO_ESCALATION_ASK_MESSAGE.to_owned(),
        }
    );
    assert_eq!(owner.events().expect("events").len(), before);
}

#[test]
fn a_parked_question_is_raised_in_the_journal_and_answered_with_a_resolved_event() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let qid = match owner
        .escalate(&session, request("which file?"))
        .expect("escalate")
    {
        EscalateOutcome::Parked { qid } => qid,
        other => panic!("expected a park, got {other:?}"),
    };
    let raised: Vec<String> = owner
        .events()
        .expect("events")
        .iter()
        .map(|stored| stored.payload_json.clone())
        .filter(|payload| payload.contains("escalation-raised"))
        .collect();
    assert_eq!(raised.len(), 1);
    assert!(raised[0].contains(&qid));

    let answered = owner
        .answer(&qid, "the second one")
        .expect("answer")
        .expect("parked");
    assert_eq!(answered.answer, "the second one");
    assert_eq!(answered.journal_warning, None);
    let resolved = owner
        .events()
        .expect("events")
        .iter()
        .filter(|stored| stored.payload_json.contains("escalation-resolved"))
        .count();
    assert_eq!(resolved, 1);
    assert_eq!(owner.answer(&qid, "again").expect("answer"), None);
}

#[test]
fn a_fourth_escalation_in_one_ask_is_refused_by_the_budget() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    for n in 0..3 {
        let outcome = owner
            .escalate(&session, request(&format!("question {n}")))
            .expect("escalate");
        assert!(matches!(outcome, EscalateOutcome::Parked { .. }));
    }
    let outcome = owner
        .escalate(&session, request("one more"))
        .expect("escalate");
    assert_eq!(
        outcome,
        EscalateOutcome::Refused {
            reason: RefusalReason::BudgetExhausted,
            message: ESCALATION_BUDGET_EXHAUSTED.to_owned(),
        }
    );
}

#[test]
fn an_accepted_ask_withdraws_its_parked_questions_and_rejects_them_on_the_turn_side() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let qid = match owner
        .escalate(&session, request("which?"))
        .expect("escalate")
    {
        EscalateOutcome::Parked { qid } => qid,
        other => panic!("expected a park, got {other:?}"),
    };
    owner
        .submit_result(&session, json!({"ok": true}))
        .expect("submit");
    assert_eq!(
        sessions.0.borrow().rejected,
        vec![(session.clone(), qid.clone())]
    );
    assert_eq!(owner.answer(&qid, "late").expect("answer"), None);
}

#[test]
fn completing_the_run_cancels_the_in_flight_turn_and_withdraws_its_questions() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let qid = match owner
        .escalate(&session, request("which?"))
        .expect("escalate")
    {
        EscalateOutcome::Parked { qid } => qid,
        other => panic!("expected a park, got {other:?}"),
    };
    owner.complete(json!("done")).expect("complete");
    let log = sessions.0.borrow();
    assert_eq!(log.cancelled.len(), 1);
    assert_eq!(log.cancelled[0].0, session);
    assert_eq!(log.rejected, vec![(session.clone(), qid)]);
}

#[test]
fn the_message_boundary_is_written_to_the_active_ask_node_and_nothing_else() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    owner
        .set_message_boundary("sess_unasked", 9)
        .expect("boundary");
    owner.set_message_boundary(&session, 5).expect("boundary");
    let instance = Ref::new("site", 2);
    let node = owner
        .journal()
        .get_node("run_1", &instance)
        .expect("node")
        .expect("the ask node exists");
    assert_eq!(node.message_boundary, Some(5));
}

#[test]
fn a_mutating_tool_on_a_fresh_run_writes_no_event_and_an_idle_session_is_ignored() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let before = owner.events().expect("events").len();
    owner.ask_mutating(&session).expect("mutating");
    owner.ask_mutating("sess_unasked").expect("idle");
    assert_eq!(owner.events().expect("events").len(), before);
}
