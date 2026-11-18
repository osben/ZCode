//! The escalation book (W6a): Node `workflow-driver-escalation.ts` and the escalation counters of
//! `workflow-driver-helpers.ts`. Node's driver is not callable here (it needs an AgentRuntime), so these
//! tests pin the behaviour its source states, one comment at a time.
use crate::driver_rules::{ESCALATION_BUDGET_EXHAUSTED, NO_ACTIVE_ASK_MESSAGE};
use crate::escalation::{
    AnswerOutcome, EscalateOutcome, EscalationBook, EscalationRequest, RefusalReason,
    mint_question_id,
};
use crate::event::RunEvent;
use crate::model::Ref;
use anyhow::{Result, anyhow};
use std::collections::BTreeSet;

fn request(question: &str) -> EscalationRequest {
    EscalationRequest {
        actor: Ref::new("plan#1", 2),
        actor_name: Some("Ada".into()),
        question: question.into(),
        context: None,
        asked_at: 1_700_000_000_000,
    }
}

fn accept(_: &RunEvent) -> Result<()> {
    Ok(())
}

fn parked(outcome: EscalateOutcome) -> String {
    match outcome {
        EscalateOutcome::Parked { qid } => qid,
        other => panic!("expected a parked question, got {other:?}"),
    }
}

#[test]
fn a_fourth_escalation_in_one_ask_is_an_ordinary_refusal_and_never_parks() {
    let mut book = EscalationBook::new("dwfrun-abc");
    book.start_ask("sess_a");
    for _ in 0..3 {
        parked(book.escalate("sess_a", request("q"), accept).unwrap());
    }
    let mut writes = 0;
    let outcome = book
        .escalate("sess_a", request("q4"), |_| {
            writes += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        outcome,
        EscalateOutcome::Refused {
            reason: RefusalReason::BudgetExhausted,
            message: ESCALATION_BUDGET_EXHAUSTED.into(),
        }
    );
    assert_eq!(writes, 0, "a refused escalation writes no event");
}

#[test]
fn an_escalation_with_no_ask_in_flight_is_refused_with_the_node_message() {
    let mut book = EscalationBook::new("dwfrun-abc");
    let outcome = book.escalate("sess_a", request("q"), accept).unwrap();
    assert_eq!(
        outcome,
        EscalateOutcome::Refused {
            reason: RefusalReason::NoActiveAsk,
            message: "No ask is in flight, so there is nowhere to park this question and nobody would answer it. Escalate only while working on an ask.".into(),
        }
    );
    assert_eq!(
        NO_ACTIVE_ASK_MESSAGE,
        "no active ask is awaiting a submitted result"
    );
}

#[test]
fn a_new_ask_withdraws_parked_questions_and_resets_the_budget() {
    let mut book = EscalationBook::new("dwfrun-abc");
    book.start_ask("sess_a");
    let first = parked(book.escalate("sess_a", request("q"), accept).unwrap());
    let withdrawn = book.start_ask("sess_a");
    assert_eq!(withdrawn, vec![first]);
    for _ in 0..3 {
        parked(book.escalate("sess_a", request("again"), accept).unwrap());
    }
}

#[test]
fn ending_an_ask_withdraws_its_questions_and_refuses_later_answers() {
    let mut book = EscalationBook::new("dwfrun-abc");
    book.start_ask("sess_a");
    let qid = parked(book.escalate("sess_a", request("q"), accept).unwrap());
    assert_eq!(book.end_ask("sess_a"), vec![qid.clone()]);
    assert_eq!(book.answer(&qid, "late", accept), None);
}

#[test]
fn a_failed_raise_write_revokes_the_park_and_returns_the_error() {
    let mut book = EscalationBook::new("dwfrun-abc");
    book.start_ask("sess_a");
    let result = book.escalate("sess_a", request("q"), |_| Err(anyhow!("disk full")));
    assert!(result.is_err(), "the write error reaches the caller");
    assert!(book.pending_questions("sess_a").is_empty());
}

#[test]
fn an_answer_resolves_the_park_and_writes_the_resolved_event_in_node_key_order() {
    let mut book = EscalationBook::new("dwfrun-abc");
    book.start_ask("sess_a");
    let qid = parked(book.escalate("sess_a", request("q"), accept).unwrap());
    let mut written = Vec::new();
    let outcome = book.answer(&qid, "yes", |event| {
        written.push(event.payload_json());
        Ok(())
    });
    assert_eq!(
        outcome,
        Some(AnswerOutcome {
            answer: "yes".into(),
            journal_warning: None,
            delivery_warning: None,
        })
    );
    assert_eq!(
        written,
        vec![format!(
            "{{\"type\":\"escalation-resolved\",\"qid\":\"{qid}\",\"answer\":\"yes\"}}"
        )]
    );
}

#[test]
fn a_failed_resolved_write_still_delivers_the_answer_and_reports_a_warning() {
    let mut book = EscalationBook::new("dwfrun-abc");
    book.start_ask("sess_a");
    let qid = parked(book.escalate("sess_a", request("q"), accept).unwrap());
    let outcome = book
        .answer(&qid, "yes", |_| Err(anyhow!("journal closed")))
        .expect("the answer is delivered");
    assert_eq!(outcome.answer, "yes");
    assert_eq!(outcome.journal_warning.as_deref(), Some("journal closed"));
}

#[test]
fn the_raised_event_carries_the_node_fields_in_node_order() {
    let mut book = EscalationBook::new("dwfrun-abc");
    book.start_ask("sess_a");
    let mut request = request("q?");
    request.context = Some("why".into());
    let mut text = String::new();
    let qid = parked(
        book.escalate("sess_a", request, |event| {
            text = event.payload_json();
            Ok(())
        })
        .unwrap(),
    );
    assert_eq!(
        text,
        format!(
            "{{\"type\":\"escalation-raised\",\"qid\":\"{qid}\",\"actor\":{{\"siteId\":\"plan#1\",\"ordinal\":2}},\"actorName\":\"Ada\",\"question\":\"q?\",\"context\":\"why\",\"askedAt\":1700000000000}}"
        )
    );
}

#[test]
fn the_question_id_takes_the_first_free_fragment_and_fails_when_none_is_free() {
    let mut taken = BTreeSet::new();
    assert_eq!(
        mint_question_id("dwfrun-abcdefghijklmnop", 1, &taken).unwrap(),
        "dwfq-abcdefgh-1"
    );
    taken.insert("dwfq-abcdefgh-1".to_string());
    assert_eq!(
        mint_question_id("dwfrun-abcdefghijklmnop", 1, &taken).unwrap(),
        "dwfq-abcdefghijklmnop-1"
    );
    taken.insert("dwfq-abcdefghijklmnop-1".to_string());
    let error = mint_question_id("dwfrun-abcdefghijklmnop", 1, &taken).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Cannot mint a free escalation question id")
    );
}
