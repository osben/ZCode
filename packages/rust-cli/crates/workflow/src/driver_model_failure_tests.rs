//! W6b part 3: the owner applies the model-failure policy to an ask's turn failure (Node `handleModelTurnFailure`,
//! `workflow-driver-model-failure.ts`): a permanent failure stops the run, a context overflow fails only that ask, and
//! anything else is redriven after a backoff. The clock and the jitter are injected, so the delays are exact.

use crate::actor_mailbox::ActorMailbox;
use crate::driver_owner::ActorDriverOwner;
use crate::driver_owner_tests::{Recording, running_ask};
use crate::engine::RunSettlement;
use crate::error::ErrorCode;
use crate::journal::MemoryJournal;
use crate::model::StopReason;
use crate::model_failure::{RedriveClock, TRANSIENT_CONTINUE_PROMPT, TurnFailure};
use rust_cli_kernel_api::model::{ModelError, ProviderFailure};
use serde_json::Value;
use std::sync::{Arc, Mutex};

type Owner = ActorDriverOwner<MemoryJournal, Recording>;

/// A clock that keeps each job it is given. The test runs a job when it decides the delay has passed; the jitter is
/// fixed, so the delays are exact.
struct ManualClock {
    random: f64,
    delays: Mutex<Vec<u64>>,
    pending: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}

impl ManualClock {
    fn new(random: f64) -> Arc<Self> {
        Arc::new(Self {
            random,
            delays: Mutex::new(Vec::new()),
            pending: Mutex::new(Vec::new()),
        })
    }

    fn delays(&self) -> Vec<u64> {
        self.delays.lock().expect("delays").clone()
    }
}

impl RedriveClock for ManualClock {
    fn after(&self, delay_ms: u64, job: Box<dyn FnOnce() + Send>) {
        self.delays.lock().expect("delays").push(delay_ms);
        self.pending.lock().expect("pending").push(job);
    }

    fn random(&self) -> f64 {
        self.random
    }
}

fn attach(owner: &mut Owner, random: f64) -> (ActorMailbox, Arc<ManualClock>) {
    let (mailbox, handle) = ActorMailbox::new();
    let clock = ManualClock::new(random);
    owner.attach_redrive(handle, clock.clone());
    (mailbox, clock)
}

/// Runs the earliest pending redrive, then serves the request it posted (the owner's turn for the redrive).
fn fire_redrive(owner: &mut Owner, mailbox: &ActorMailbox, clock: &ManualClock) {
    let job = {
        let mut pending = clock.pending.lock().expect("pending");
        assert!(!pending.is_empty(), "a redrive was expected to be pending");
        pending.remove(0)
    };
    job();
    mailbox
        .serve_next(owner)
        .expect("the redrive request is served");
}

fn provider(code: &str, reason: &str, inner: ModelError) -> ModelError {
    ModelError::Provider {
        provider: Box::new(ProviderFailure::new(
            code,
            Some(429),
            false,
            reason,
            "zhipu",
        )),
        error: Box::new(inner),
    }
}

fn quota_error() -> ModelError {
    provider(
        "1308",
        "rate_limited",
        ModelError::QuotaExhausted {
            message: "[1308] usage limit".into(),
        },
    )
    .with_model("account:zhipu", "glm-5.3")
}

fn network_error() -> ModelError {
    ModelError::Network {
        message: "connection reset".into(),
    }
}

fn unrecognized_code_error() -> ModelError {
    provider(
        "1113",
        "unknown",
        ModelError::Protocol {
            message: "[1113] account".into(),
        },
    )
}

fn settled_stop(owner: &Owner) -> (StopReason, Value) {
    match owner.settlement() {
        Some(RunSettlement::Stopped {
            reason,
            error: Some(error),
            ..
        }) => (*reason, error.clone()),
        other => panic!("the run should be stopped with a provider error, got {other:?}"),
    }
}

#[test]
fn a_quota_failure_stops_the_run_as_provider_with_its_provider_stop_details() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let (_mailbox, _clock) = attach(&mut owner, 0.5);
    owner
        .turn_failed(
            &session,
            &TurnFailure::model("[1308] usage limit", quota_error()),
        )
        .expect("the failure is handled");
    let (reason, error) = settled_stop(&owner);
    assert_eq!(reason, StopReason::Provider);
    assert_eq!(error["code"], "ProviderStop");
    let details = &error["providerStop"];
    assert_eq!(details["kind"], "quota");
    assert_eq!(details["reason"], "rate_limited");
    assert_eq!(details["providerCode"], "1308");
    assert_eq!(details["providerId"], "account:zhipu");
    assert_eq!(details["modelId"], "glm-5.3");
    assert_eq!(details["rawMessage"], "[1308] usage limit");
    // The subagent is the actor that ran the ask, named as Node names it (`site@<ordinal>`).
    assert!(
        details["subagent"]
            .as_str()
            .is_some_and(|name| name.starts_with("site@")),
        "{details}"
    );
    // Node's `stop` aborts the in-flight ask with `Cancelled`; the ask carries no failure of its own.
    for outcome in owner.take_outcomes() {
        let error = outcome.result.expect_err("an aborted ask fails");
        assert_eq!(error.code, ErrorCode::Cancelled, "{}", error.message);
    }
}

#[test]
fn a_context_overflow_fails_only_that_ask_with_context_limit_and_the_run_goes_on() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let (_mailbox, _clock) = attach(&mut owner, 0.5);
    owner
        .turn_failed(
            &session,
            &TurnFailure::model(
                "prompt too long",
                ModelError::PromptTooLong {
                    message: "prompt too long".into(),
                },
            ),
        )
        .expect("the failure is handled");
    assert!(owner.settlement().is_none(), "the run keeps going");
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    let error = outcomes[0].result.as_ref().expect_err("the ask fails");
    assert_eq!(error.code, ErrorCode::ContextLimit);
    assert!(
        error.message.contains("context window"),
        "{}",
        error.message
    );
}

#[test]
fn a_transient_failure_is_redriven_after_its_backoff_and_the_ask_stays_live() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let (mailbox, clock) = attach(&mut owner, 0.5);
    let turns_before = sessions.0.borrow().turns.len();
    owner
        .turn_failed(&session, &TurnFailure::model("reset", network_error()))
        .expect("the failure is handled");
    // 2 s * (0.5 + 0.5 * 0.5): the first attempt's backoff, jittered.
    assert_eq!(clock.delays(), vec![1_500]);
    assert!(
        owner.take_outcomes().is_empty(),
        "the script never sees the transient failure"
    );
    assert!(owner.settlement().is_none());
    fire_redrive(&mut owner, &mailbox, &clock);
    let log = sessions.0.borrow();
    assert_eq!(log.turns.len(), turns_before + 1, "one redrive turn starts");
    assert_eq!(
        log.inputs.last(),
        Some(&(TRANSIENT_CONTINUE_PROMPT.to_owned(), 0)),
        "the redrive is a turn with the continue prompt and no epilogue"
    );
    assert_eq!(
        log.turns.last().map(|turn| turn.0.clone()),
        Some(session.clone())
    );
}

#[test]
fn redrives_double_to_a_minute_and_a_retry_after_takes_precedence() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    // random 1.0 gives the raw curve.
    let (mailbox, clock) = attach(&mut owner, 1.0);
    for _ in 0..6 {
        owner
            .turn_failed(&session, &TurnFailure::model("reset", network_error()))
            .expect("the failure is handled");
        fire_redrive(&mut owner, &mailbox, &clock);
    }
    assert_eq!(
        clock.delays(),
        vec![2_000, 4_000, 8_000, 16_000, 32_000, 60_000]
    );
    let rate_limited = ModelError::RateLimited {
        message: "slow down".into(),
        retry_after_ms: Some(7_000),
    };
    owner
        .turn_failed(&session, &TurnFailure::model("slow down", rate_limited))
        .expect("the failure is handled");
    assert_eq!(clock.delays().last(), Some(&7_000));
}

#[test]
fn the_tenth_unrecognized_code_in_a_row_stops_the_run_across_redrives() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let (mailbox, clock) = attach(&mut owner, 1.0);
    for attempt in 1..=10 {
        owner
            .turn_failed(
                &session,
                &TurnFailure::model("[1113] account", unrecognized_code_error()),
            )
            .expect("the failure is handled");
        if attempt < 10 {
            assert!(
                owner.settlement().is_none(),
                "stops only at the tenth, not at {attempt}"
            );
            fire_redrive(&mut owner, &mailbox, &clock);
        }
    }
    let (reason, error) = settled_stop(&owner);
    assert_eq!(reason, StopReason::Provider);
    assert_eq!(error["providerStop"]["kind"], "other");
    assert_eq!(error["providerStop"]["providerCode"], "1113");
}

#[test]
fn a_redrive_due_after_the_run_settled_starts_no_turn() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let (mailbox, clock) = attach(&mut owner, 0.5);
    owner
        .turn_failed(&session, &TurnFailure::model("reset", network_error()))
        .expect("the failure is handled");
    let turns = sessions.0.borrow().turns.len();
    owner.complete(Value::Null).expect("the run completes");
    fire_redrive(&mut owner, &mailbox, &clock);
    assert_eq!(
        sessions.0.borrow().turns.len(),
        turns,
        "no turn starts after settlement"
    );
}

#[test]
fn a_failure_with_no_model_error_still_fails_the_ask_with_the_driver_error() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let (_mailbox, clock) = attach(&mut owner, 0.5);
    owner
        .turn_failed(&session, &TurnFailure::plain("boom"))
        .expect("the failure is handled");
    assert!(clock.delays().is_empty(), "nothing is redriven");
    let outcomes = owner.take_outcomes();
    let error = outcomes[0].result.as_ref().expect_err("the ask fails");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert_eq!(error.message, "boom");
}

#[test]
fn a_retry_without_a_redrive_clock_fails_the_ask_as_a_driver_fault() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    owner
        .turn_failed(&session, &TurnFailure::model("reset", network_error()))
        .expect("the failure is handled");
    let outcomes = owner.take_outcomes();
    let error = outcomes[0].result.as_ref().expect_err("the ask fails");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert!(error.message.contains("redrive"), "{}", error.message);
}
