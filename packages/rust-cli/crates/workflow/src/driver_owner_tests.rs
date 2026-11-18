//! The driver owner (W6a part 2): the engine's port, the submit and turn-end routes, the escalation book, and the
//! session creation, pinned against the Node driver's port rules. The turn side is a recorder, so these tests run
//! without a child session; the turn loop itself is tested in the agents crate.
use crate::driver_owner::{
    ActorDriverOwner, ActorSessionRequest, ActorSessions, CANCELLED_BY_ENGINE_MESSAGE, SubmitReply,
    TurnEndReply,
};
use crate::driver_rules::{
    ESCALATION_BUDGET_EXHAUSTED, NO_ACTIVE_ASK_MESSAGE, SubmitProfile, UNTYPED_ASK_MESSAGE,
    actor_session_title,
};
use crate::engine::{AskMessage, AskSpec, EngineConfig, SubmitVerdict};
use crate::error::ErrorCode;
use crate::escalation::{EscalateOutcome, EscalationRequest, RefusalReason};
use crate::imported_cache::ImportedRunCache;
use crate::journal::{JournalPort, MemoryJournal};
use crate::model::{Ref, Violation};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::rc::Rc;

/// Everything the turn side was asked to do, in order.
#[derive(Default)]
pub(crate) struct Log {
    pub(crate) created: Vec<ActorSessionRequest>,
    pub(crate) turns: Vec<(String, Ref, AskMessage)>,
    pub(crate) cancelled: Vec<(String, Ref)>,
    pub(crate) rejected: Vec<(String, String)>,
    /// Answers delivered to blocked escalate calls: (session, qid, answer).
    pub(crate) answered: Vec<(String, String, String)>,
    /// When set, the next `start_turn` fails, as a refused send does.
    pub(crate) fail_next_start: bool,
    /// When set, the next `cancel_turn` fails.
    pub(crate) fail_next_cancel: bool,
    /// When set, the next `reject_parked` fails. Only that one withdrawal fails; the rest of the queue still applies.
    pub(crate) fail_next_reject: bool,
    pub(crate) next: u64,
}

#[derive(Clone, Default)]
pub(crate) struct Recording(pub(crate) Rc<RefCell<Log>>);

impl ActorSessions for Recording {
    fn create_session(&mut self, request: &ActorSessionRequest) -> Result<String> {
        let mut log = self.0.borrow_mut();
        log.next += 1;
        log.created.push(request.clone());
        Ok(format!("sess_{}", log.next))
    }

    fn start_turn(&mut self, session: &str, instance: &Ref, message: &AskMessage) -> Result<()> {
        let mut log = self.0.borrow_mut();
        if log.fail_next_start {
            log.fail_next_start = false;
            bail!("send refused");
        }
        log.turns
            .push((session.to_owned(), instance.clone(), message.clone()));
        Ok(())
    }

    fn cancel_turn(&mut self, session: &str, instance: &Ref) -> Result<()> {
        let mut log = self.0.borrow_mut();
        if log.fail_next_cancel {
            log.fail_next_cancel = false;
            bail!("cancel refused");
        }
        log.cancelled.push((session.to_owned(), instance.clone()));
        Ok(())
    }

    fn deliver_answer(&mut self, session: &str, qid: &str, answer: &str) -> Result<()> {
        self.0
            .borrow_mut()
            .answered
            .push((session.to_owned(), qid.to_owned(), answer.to_owned()));
        Ok(())
    }

    fn reject_parked(&mut self, session: &str, qid: &str) -> Result<()> {
        let mut log = self.0.borrow_mut();
        if log.fail_next_reject {
            log.fail_next_reject = false;
            bail!("reject refused");
        }
        log.rejected.push((session.to_owned(), qid.to_owned()));
        Ok(())
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

pub(crate) fn config() -> EngineConfig {
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

fn owner_with(config: EngineConfig) -> (ActorDriverOwner<MemoryJournal, Recording>, Recording) {
    let sessions = Recording::default();
    let owner =
        ActorDriverOwner::new(config, MemoryJournal::new(), sessions.clone()).expect("owner");
    (owner, sessions)
}

pub(crate) fn owner() -> (ActorDriverOwner<MemoryJournal, Recording>, Recording) {
    owner_with(config())
}

pub(crate) fn request(question: &str) -> EscalationRequest {
    EscalationRequest {
        actor: Ref::new("site", 1),
        actor_name: None,
        question: question.into(),
        context: None,
        asked_at: 1_700_000_000_000,
    }
}

/// One typed ask on a fresh actor, started and running. Returns the owner, the recorder, the actor id and session.
pub(crate) fn running_ask() -> (
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

/// The instance of the first turn the recorder saw, so the tests do not assume ordinals.
fn first_turn_instance(sessions: &Recording) -> Ref {
    sessions.0.borrow().turns[0].1.clone()
}

#[test]
fn an_actor_session_carries_the_node_title_parent_and_link_path() {
    let (mut owner, sessions) = owner();
    let actor = owner
        .create_actor("site", Some("Ada"), None)
        .expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    assert_eq!(actor, "site@1");
    let log = sessions.0.borrow();
    let created = &log.created[0];
    assert_eq!(created.run_id, "run_1");
    assert_eq!(created.parent_session_id.as_deref(), Some("ses_parent"));
    assert_eq!(created.actor, Ref::new("site", 1));
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
    let (mut owner, sessions, _actor, session) = running_ask();
    let turn = sessions.0.borrow().turns[0].clone();
    assert_eq!(turn.0, session);
    assert_eq!(turn.2.instructions, "do it");
    assert!(turn.2.typed);
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
fn an_exhausted_repair_budget_answers_the_submit_as_the_engine_cancelled_it_and_fails_the_ask() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    for _ in 0..3 {
        let reply = owner
            .submit_result(&session, json!({"nope": 1}))
            .expect("submit");
        assert!(matches!(
            reply,
            SubmitReply::Verdict(SubmitVerdict::Reject { .. })
        ));
    }
    // The fourth rejected submit exhausts the repair budget. Node rejects its pending submit with `Cancelled`.
    let reply = owner
        .submit_result(&session, json!({"nope": 1}))
        .expect("submit");
    assert_eq!(
        reply,
        SubmitReply::Cancelled(CANCELLED_BY_ENGINE_MESSAGE.to_owned())
    );
    let outcomes = owner.take_outcomes();
    let error = outcomes[0].result.as_ref().expect_err("the ask fails");
    assert_eq!(error.code, ErrorCode::ValidationFailed);
    let again = owner
        .submit_result(&session, json!({"ok": true}))
        .expect("submit");
    assert_eq!(
        again,
        SubmitReply::Refused(NO_ACTIVE_ASK_MESSAGE.to_owned())
    );
}

#[test]
fn a_turn_that_ends_without_a_submit_is_nudged_once_then_fails_with_result_not_submitted() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let first = owner.turn_ended(&session, "I am done.").expect("turn end");
    assert_eq!(first, TurnEndReply::Verdict(SubmitVerdict::Nudge));
    assert!(owner.take_outcomes().is_empty());

    let second = owner.turn_ended(&session, "Still done.").expect("turn end");
    assert_eq!(second, TurnEndReply::AskEnded);
    let outcomes = owner.take_outcomes();
    let error = outcomes[0].result.as_ref().expect_err("the ask fails");
    assert_eq!(error.code, ErrorCode::ResultNotSubmitted);
    assert_eq!(error.final_text.as_deref(), Some("Still done."));
    let instance = first_turn_instance(&sessions);
    assert_eq!(
        sessions.0.borrow().cancelled,
        vec![(session.clone(), instance)]
    );
}

#[test]
fn a_rejected_submit_keeps_the_ask_live_so_a_turn_end_is_nudged() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    owner
        .submit_result(&session, json!({"nope": 1}))
        .expect("submit");
    let verdict = owner
        .turn_ended(&session, "I repaired it.")
        .expect("turn end");
    assert_eq!(verdict, TurnEndReply::Verdict(SubmitVerdict::Nudge));
    assert!(owner.take_outcomes().is_empty());
}

#[test]
fn a_turn_end_on_an_untyped_ask_settles_it_with_its_text() {
    let (mut owner, _sessions) = owner();
    let actor = owner.create_actor("plain", None, None).expect("actor");
    owner.ask("plain", &actor, "say hi").expect("ask");
    owner.drain().expect("drain");
    let session = owner.session_of(&actor).expect("session");
    let reply = owner.turn_ended(&session, "hi").expect("turn end");
    assert_eq!(reply, TurnEndReply::AskEnded);
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes[0].result, Ok(json!("hi")));
}

#[test]
fn a_turn_end_with_no_ask_in_flight_is_reported_as_no_ask() {
    let (mut owner, _sessions) = owner();
    let reply = owner.turn_ended("sess_unasked", "hi").expect("turn end");
    assert_eq!(reply, TurnEndReply::NoAsk);
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
fn two_asks_that_fail_in_one_drain_both_get_their_outcome() {
    let (mut owner, _sessions) = owner();
    let first = owner.create_actor("site", None, None).expect("actor");
    let second = owner.create_actor("site", None, None).expect("actor");
    owner.set_actor_profile(&first, SubmitProfile::Untyped);
    owner.set_actor_profile(&second, SubmitProfile::Untyped);
    owner.ask("site", &first, "one").expect("ask");
    owner.ask("site", &second, "two").expect("ask");
    owner.drain().expect("drain");
    let outcomes = owner.take_outcomes();
    assert_eq!(
        outcomes.len(),
        2,
        "every failed ask is settled: {outcomes:?}"
    );
    assert!(outcomes.iter().all(|outcome| outcome.result.is_err()));
}

#[test]
fn a_turn_that_cannot_start_fails_the_ask_with_the_send_error_and_starts_nothing() {
    let (mut owner, sessions) = owner();
    let actor = owner.create_actor("site", None, None).expect("actor");
    sessions.0.borrow_mut().fail_next_start = true;
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    let session = owner.session_of(&actor).expect("session");
    assert!(sessions.0.borrow().turns.is_empty());
    let outcomes = owner.take_outcomes();
    let error = outcomes[0].result.as_ref().expect_err("the ask fails");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert!(error.message.contains("send refused"), "{}", error.message);
    let reply = owner
        .submit_result(&session, json!({"ok": true}))
        .expect("submit");
    assert_eq!(
        reply,
        SubmitReply::Refused(NO_ACTIVE_ASK_MESSAGE.to_owned())
    );
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
    let instance = first_turn_instance(&sessions);
    let log = sessions.0.borrow();
    assert_eq!(log.cancelled, vec![(session.clone(), instance)]);
    assert_eq!(log.rejected, vec![(session.clone(), qid)]);
}

#[test]
fn the_message_boundary_is_written_to_the_active_ask_node_and_nothing_else() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let instance = first_turn_instance(&sessions);
    owner
        .set_message_boundary("sess_unasked", 9)
        .expect("boundary");
    owner.set_message_boundary(&session, 5).expect("boundary");
    let node = owner
        .journal()
        .get_node("run_1", &instance)
        .expect("node")
        .expect("the ask node exists");
    assert_eq!(node.message_boundary, Some(5));
}

#[test]
fn a_mutating_tool_closes_the_import_cache_once_and_an_idle_session_is_ignored() {
    let mut config = config();
    config.imported_cache = Some(ImportedRunCache::default());
    let (mut owner, _sessions) = owner_with(config);
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    let session = owner.session_of(&actor).expect("session");
    let closed = |owner: &ActorDriverOwner<MemoryJournal, Recording>| {
        owner
            .events()
            .expect("events")
            .iter()
            .filter(|stored| stored.payload_json.contains("import-cache-closed"))
            .count()
    };
    assert_eq!(closed(&owner), 0);
    owner.ask_mutating(&session).expect("mutating");
    assert_eq!(closed(&owner), 1, "the active ask closes the cache");
    owner.ask_mutating(&session).expect("mutating again");
    assert_eq!(closed(&owner), 1, "the closure is written once");
    owner.ask_mutating("sess_unasked").expect("idle session");
    assert_eq!(closed(&owner), 1, "an idle session writes nothing");
}

#[test]
fn a_repair_exhausted_by_a_refused_cancel_still_answers_the_submit_and_fails_the_ask() {
    let (mut owner, sessions, _actor, session) = running_ask();
    for _ in 0..3 {
        owner
            .submit_result(&session, json!({"nope": 1}))
            .expect("submit");
    }
    sessions.0.borrow_mut().fail_next_cancel = true;
    let reply = owner
        .submit_result(&session, json!({"nope": 1}))
        .expect("the reply is the engine's, whatever the turn side does");
    assert_eq!(
        reply,
        SubmitReply::Cancelled(CANCELLED_BY_ENGINE_MESSAGE.to_owned())
    );
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1, "the ask settles once");
    assert_eq!(
        outcomes[0].result.as_ref().expect_err("fails").code,
        ErrorCode::ValidationFailed
    );
}

#[test]
// Parity with Node: a refused reject retires the question in the book anyway, as Node retires the registry entry
// before it rejects the deferred (workflow-driver-escalation.ts withdrawSessionEscalations). The error is logged/returned,
// not retried.
fn an_accept_with_a_refused_withdrawal_still_returns_the_accept_and_releases_the_rest() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let first = match owner.escalate(&session, request("one")).expect("escalate") {
        EscalateOutcome::Parked { qid } => qid,
        other => panic!("expected a park, got {other:?}"),
    };
    let second = match owner.escalate(&session, request("two")).expect("escalate") {
        EscalateOutcome::Parked { qid } => qid,
        other => panic!("expected a park, got {other:?}"),
    };
    sessions.0.borrow_mut().fail_next_reject = true;
    let reply = owner
        .submit_result(&session, json!({"ok": true}))
        .expect("the accept is returned even though a withdrawal failed");
    assert_eq!(reply, SubmitReply::Verdict(SubmitVerdict::Accept));
    assert_eq!(
        sessions.0.borrow().rejected,
        vec![(session.clone(), second.clone())],
        "the failed withdrawal is skipped, the other one is still released"
    );
    assert_eq!(owner.answer(&first, "late").expect("answer"), None);
    assert_eq!(owner.answer(&second, "late").expect("answer"), None);
}

#[test]
fn a_turn_end_that_settles_with_a_refused_cancel_still_returns_ask_ended() {
    let (mut owner, sessions, _actor, session) = running_ask();
    assert_eq!(
        owner.turn_ended(&session, "one").expect("turn end"),
        TurnEndReply::Verdict(SubmitVerdict::Nudge)
    );
    sessions.0.borrow_mut().fail_next_cancel = true;
    let reply = owner
        .turn_ended(&session, "two")
        .expect("the reply is the engine's");
    assert_eq!(reply, TurnEndReply::AskEnded);
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(
        outcomes[0].result.as_ref().expect_err("fails").code,
        ErrorCode::ResultNotSubmitted
    );
    assert_eq!(
        owner.turn_ended(&session, "three").expect("turn end"),
        TurnEndReply::NoAsk,
        "a retry is the next ask state, not a second settlement"
    );
}

#[test]
fn a_refused_cancel_on_complete_is_returned_and_the_rest_of_the_queue_still_applies() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let qid = match owner
        .escalate(&session, request("which?"))
        .expect("escalate")
    {
        EscalateOutcome::Parked { qid } => qid,
        other => panic!("expected a park, got {other:?}"),
    };
    sessions.0.borrow_mut().fail_next_cancel = true;
    let error = owner
        .complete(json!("done"))
        .expect_err("the refused cancel is returned to the caller of complete");
    assert!(error.to_string().contains("cancel refused"), "{error:#}");
    let log = sessions.0.borrow();
    assert!(log.cancelled.is_empty());
    assert_eq!(
        log.rejected,
        vec![(session.clone(), qid)],
        "the withdrawal after the failed cancel is still applied"
    );
}

#[test]
fn a_start_queued_for_an_ask_the_engine_already_settled_starts_no_turn() {
    // The race: the ask is admitted and its turn runs, then the engine settles it (complete cancels the turn). A start
    // the engine queued for that ask before it settled is applied afterwards and must not start a second turn.
    let (mut owner, sessions, _actor, session) = running_ask();
    let instance = first_turn_instance(&sessions);
    owner.complete(json!("done")).expect("complete");
    owner.queue_start_for_test(
        &session,
        &instance,
        AskMessage {
            instructions: "stale".into(),
            typed: true,
            schema: None,
        },
    );
    owner.drain().expect("drain");
    assert_eq!(
        sessions.0.borrow().turns.len(),
        1,
        "only the original turn ran; the settled ask starts no second turn"
    );
}

#[test]
fn an_accepted_answer_is_delivered_to_the_blocked_escalate_on_its_session() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let qid = match owner
        .escalate(&session, request("which?"))
        .expect("escalate")
    {
        EscalateOutcome::Parked { qid } => qid,
        other => panic!("expected a park, got {other:?}"),
    };
    owner
        .answer(&qid, "the second one")
        .expect("answer")
        .expect("parked");
    assert_eq!(
        sessions.0.borrow().answered,
        vec![(session.clone(), qid.clone(), "the second one".to_owned())]
    );
}

#[test]
fn an_answer_to_a_withdrawn_question_is_not_delivered() {
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
    assert_eq!(owner.answer(&qid, "late").expect("answer"), None);
    assert!(sessions.0.borrow().answered.is_empty());
}
