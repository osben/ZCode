//! W6b part 5, through the owner: the run-level stall clock is wired to the owner's turn and retry reports, and a
//! scripted provider's quota failure reaches the quota timer through the run's own journal row.

use crate::actor_mailbox::{ActorMailbox, MailboxError};
use crate::driver_owner::ActorDriverOwner;
use crate::driver_owner_tests::{Recording, first_turn_instance, running_ask};
use crate::engine::AskStats;
use crate::journal::{JournalPort, MemoryJournal};
use crate::model::{ConcurrencyChange, RunRow, RunStatus, StopReason};
use crate::model_failure::TurnFailure;
use crate::quota_resume::{
    QuotaAutoResume, QuotaResumePort, ResumeAnswer, WORKFLOW_QUOTA_RESUME_MARGIN_MS,
};
use crate::test_clock::AdvancingClock;
use rust_cli_kernel_api::model::{ModelError, ProviderFailure};
use serde_json::Value;
use std::sync::{Arc, Mutex};

type Owner = ActorDriverOwner<MemoryJournal, Recording>;

const MIN: u64 = 60_000;
/// 2026-10-15T08:00:00Z (16:00 in Beijing).
const START: u64 = 1_792_051_200_000;
/// The reset the scripted provider reports: 18:00 in Beijing, two hours after the clock starts.
const RESET: u64 = START + 2 * 60 * MIN;

/// Attaches the redrive wiring (and with it the stall clock) on a clock this test drives.
fn attach(owner: &mut Owner) -> (ActorMailbox, Arc<AdvancingClock>) {
    let (mailbox, handle) = ActorMailbox::new();
    let clock = AdvancingClock::new(START);
    owner.attach_redrive(handle, clock.clone());
    (mailbox, clock)
}

/// Every event of the run, parsed from its journal payload, in sequence order.
fn events_of(owner: &Owner) -> Vec<Value> {
    owner
        .events()
        .expect("events")
        .into_iter()
        .map(|stored| serde_json::from_str(&stored.payload_json).expect("event json"))
        .collect()
}

fn of_type(events: &[Value], kind: &str) -> Vec<Value> {
    events
        .iter()
        .filter(|event| event["type"] == kind)
        .cloned()
        .collect()
}

fn run_id_of(owner: &Owner) -> String {
    events_of(owner)
        .iter()
        .find_map(|event| event["runId"].as_str().map(str::to_owned))
        .expect("the run has a run id")
}

/// The stall clock fires on the owner's thread: the job posts, the test serves the request.
fn serve_stall(owner: &mut Owner, mailbox: &ActorMailbox) {
    mailbox
        .serve_next(owner)
        .expect("the stall request is served");
}

/// True when no handle is left to post: the owner dropped the mailbox slot at settlement, so the mailbox is closed.
fn nothing_is_posted(owner: &mut Owner, mailbox: &ActorMailbox) -> bool {
    matches!(mailbox.serve_next(owner), Err(MailboxError::Closed))
}

fn quota_failure() -> TurnFailure {
    let quota = ModelError::Provider {
        provider: Box::new(ProviderFailure::new(
            "1308",
            Some(429),
            false,
            "rate_limited",
            "zhipu",
        )),
        error: Box::new(ModelError::QuotaExhausted {
            message: "[1308] usage limit".into(),
        }),
    }
    .with_model("account:zhipu", "glm-5.3");
    TurnFailure::model("您的限额将在 2026-10-15 18:00:00 重置", quota)
}

#[test]
fn a_run_whose_retries_never_succeed_records_one_stall_notice_after_twenty_minutes() {
    let (mut owner, _sessions, _actor, _session) = running_ask();
    let (mailbox, clock) = attach(&mut owner);
    owner.model_retry_scheduled("rate_limited");
    clock.advance(20 * MIN - 1);
    assert!(
        events_of(&owner).iter().all(|e| e["type"] != "run-stalled"),
        "no notice a moment early"
    );
    clock.advance(1);
    serve_stall(&mut owner, &mailbox);
    let stalls = of_type(&events_of(&owner), "run-stalled");
    assert_eq!(stalls.len(), 1, "{stalls:?}");
    assert_eq!(stalls[0]["sinceMs"], 20 * MIN);
    assert_eq!(stalls[0]["reason"], "rate_limited");
    assert!(stalls[0].get("cap").is_none(), "no cap was seen");
}

#[test]
fn a_successful_request_before_the_window_keeps_the_run_from_a_notice() {
    let (mut owner, _sessions, _actor, _session) = running_ask();
    let (mailbox, clock) = attach(&mut owner);
    owner.model_retry_scheduled("rate_limited");
    clock.advance(10 * MIN);
    owner.model_request_completed();
    // The timer armed by the retry still wakes at its window, and is ignored.
    clock.advance(10 * MIN + 1);
    serve_stall(&mut owner, &mailbox);
    assert!(of_type(&events_of(&owner), "run-stalled").is_empty());
}

#[test]
fn a_retry_for_a_non_failure_reason_does_not_arm_the_stall_clock() {
    let (mut owner, _sessions, _actor, _session) = running_ask();
    let (_mailbox, clock) = attach(&mut owner);
    owner.model_retry_scheduled("reasoning_signature_repair");
    owner.model_retry_scheduled("auth_refresh");
    assert_eq!(clock.pending(), 0, "those retries are not failures");
}

#[test]
fn the_cap_the_run_last_fanned_out_is_carried_in_the_notice() {
    let (mut owner, _sessions, _actor, _session) = running_ask();
    let (mailbox, clock) = attach(&mut owner);
    owner
        .concurrency_changed(&ConcurrencyChange {
            key: "zhipu/glm-5.3".into(),
            previous: 4,
            next: 2,
            reason: "rate_limited".into(),
            last_good: None,
            last_bad: None,
            cooldown_ms: None,
        })
        .expect("the cap change is recorded");
    owner.model_retry_scheduled("rate_limited");
    clock.advance(20 * MIN);
    serve_stall(&mut owner, &mailbox);
    let stalls = of_type(&events_of(&owner), "run-stalled");
    assert_eq!(stalls.len(), 1);
    assert_eq!(stalls[0]["cap"], 2);
}

#[test]
fn a_settled_run_records_no_stall_notice() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let (mailbox, clock) = attach(&mut owner);
    owner.model_retry_scheduled("rate_limited");
    // A quota stop settles the run before the window closes.
    owner
        .turn_failed(&session, &quota_failure())
        .expect("the failure is handled");
    // Settlement cleared the mailbox slot, so the window's job posts nothing: nothing is served, nothing is recorded.
    clock.advance(30 * MIN);
    assert!(
        nothing_is_posted(&mut owner, &mailbox),
        "the settled run holds no mailbox handle"
    );
    assert!(of_type(&events_of(&owner), "run-stalled").is_empty());
}

#[test]
fn the_ask_progress_is_recorded_per_resolved_turn_before_its_usage() {
    let (mut owner, sessions, _actor, _session) = running_ask();
    let _ = attach(&mut owner);
    let instance = first_turn_instance(&sessions);
    owner
        .ask_stats(
            &instance,
            AskStats {
                tokens: 10.0,
                tool_calls: 3.0,
                turns: 1.0,
                world_tool_calls: None,
            },
        )
        .expect("the stats are recorded");
    let kinds: Vec<String> = events_of(&owner)
        .iter()
        .filter_map(|e| e["type"].as_str())
        .filter(|kind| *kind == "node-progress" || *kind == "usage-updated")
        .map(str::to_owned)
        .collect();
    assert_eq!(kinds, ["node-progress", "usage-updated"]);
    let progress = of_type(&events_of(&owner), "node-progress");
    assert_eq!(progress[0]["turn"], 1);
    assert_eq!(progress[0]["toolCalls"], 3);
    assert!(
        progress[0].get("lastTool").is_none(),
        "no tool name is reported yet"
    );

    owner
        .ask_stats(
            &instance,
            AskStats {
                tokens: 5.0,
                tool_calls: 1.0,
                turns: 1.0,
                world_tool_calls: None,
            },
        )
        .expect("the next turn's stats are recorded");
    let progress = of_type(&events_of(&owner), "node-progress");
    assert_eq!(progress.len(), 2);
    assert_eq!(
        progress[1]["turn"], 2,
        "the turn count runs across the ask's turns"
    );
}

/// A fake port holding the one row the scripted run wrote.
struct RowPort {
    row: RunRow,
    resumes: Mutex<Vec<String>>,
}

impl QuotaResumePort for RowPort {
    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>, String> {
        Ok((self.row.run_id == run_id).then(|| self.row.clone()))
    }

    fn list_session_runs(&self, _limit: usize) -> Result<Vec<RunRow>, String> {
        Ok(Vec::new())
    }

    fn resume(&self, run_id: &str) -> Result<ResumeAnswer, String> {
        self.resumes
            .lock()
            .expect("resumes")
            .push(run_id.to_owned());
        Ok(ResumeAnswer::Resumed)
    }
}

#[test]
fn a_scripted_quota_failure_is_resumed_once_by_the_timer_at_its_reset_plus_one_minute() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let (_mailbox, clock) = attach(&mut owner);
    owner
        .turn_failed(&session, &quota_failure())
        .expect("the failure is handled");

    // The run stopped on the provider with the quota reset the provider's text named.
    let run = run_id_of(&owner);
    let row = owner
        .journal()
        .get_run(&run)
        .expect("the row reads")
        .expect("the row exists");
    assert_eq!(row.status, RunStatus::Stopped);
    assert_eq!(row.stop_reason, Some(StopReason::Provider));
    assert_eq!(
        row.failure.as_ref().expect("failure")["providerStop"]["kind"],
        "quota"
    );
    assert_eq!(
        row.failure.as_ref().expect("failure")["providerStop"]["resetAt"],
        RESET
    );

    let port = Arc::new(RowPort {
        row,
        resumes: Mutex::new(Vec::new()),
    });
    let quota = QuotaAutoResume::new(port.clone(), clock.clone());
    quota.on_run_settled(&run);
    clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS - 1);
    assert!(port.resumes.lock().expect("resumes").is_empty());
    clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(*port.resumes.lock().expect("resumes"), vec![run]);
    clock.advance(5 * 60 * MIN);
    assert_eq!(port.resumes.lock().expect("resumes").len(), 1, "once");
}
