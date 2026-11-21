//! W7-7c: the progress path posts the model-visible run notices (Node `recordDynamicWorkflowRunProgress`): one notice per
//! raised escalation and per run stall, and nothing for the other events or for a malformed payload.

use std::sync::{Arc, Mutex};

use rust_cli_kernel_api::dynamic_workflow::{DynamicWorkflowGate, DynamicWorkflowGates};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use serde_json::{Value, json};

use super::{ProgressDelivery, WorkflowNotices, WorkflowProgressHost};
use crate::fork::workflow_reminder::{OpenDecisions, OpenHole};
use crate::fork::workflow_reminder_host::{ReminderTimers, RunDecisionsSource, WorkflowReminders};

/// The posted texts (`.0`) and their origin fragments, in order (`.1`).
#[derive(Default)]
struct Posted(Mutex<Vec<(String, String)>>, Mutex<Vec<Option<Value>>>);

impl WorkflowNotices for Posted {
    fn post(&self, parent_session_id: &str, text: String, workflow: Option<serde_json::Value>) {
        self.0
            .lock()
            .expect("posted")
            .push((parent_session_id.to_owned(), text));
        self.1.lock().expect("workflow").push(workflow);
    }
}

struct Quiet;

impl ProgressDelivery for Quiet {
    fn deliver(&self, _parent_session_id: &str, _deltas: Vec<Value>) {}
}

fn host(posted: &Arc<Posted>) -> WorkflowProgressHost {
    WorkflowProgressHost::new(Arc::new(Quiet)).with_notices(posted.clone())
}

/// Node's `DynamicWorkflowRunProgressPayload` for one run event.
fn event(event_type: &str, payload: Value) -> Value {
    json!({"runId": "dwfrun-7", "sequence": 3, "eventType": event_type, "payload": payload})
}

fn raised() -> Value {
    event(
        "escalation-raised",
        json!({
            "qid": "dwfq-1-1",
            "actor": {"siteId": "scout", "ordinal": 3},
            "question": "Which branch?",
            "context": "tried main",
            "askedAt": 1_700_000_000_000u64
        }),
    )
}

fn stalled(payload: Value) -> Value {
    event("run-stalled", payload)
}

#[test]
fn a_raised_escalation_posts_one_notice_to_the_parent() {
    let posted = Arc::new(Posted::default());
    host(&posted)
        .record("ses_parent", &raised(), &[])
        .expect("recorded");

    let posted = posted.0.lock().expect("posted");
    assert_eq!(posted.len(), 1, "one notice per raised escalation");
    assert_eq!(posted[0].0, "ses_parent");
    let text = &posted[0].1;
    assert!(text.contains("<workflow-escalation>"), "{text}");
    assert!(
        text.contains("<question-id>dwfq-1-1</question-id>"),
        "{text}"
    );
    assert!(text.contains("<subagent>scout@3</subagent>"), "{text}");
    assert!(
        text.contains("in workflow run dwfrun-7 (dwfrun-7) escalated"),
        "{text}"
    );
}

#[test]
fn a_resolved_escalation_posts_nothing() {
    let posted = Arc::new(Posted::default());
    let resolved = event(
        "escalation-resolved",
        json!({"qid": "dwfq-1-1", "answer": "main"}),
    );
    host(&posted)
        .record("ses_parent", &resolved, &[])
        .expect("recorded");
    assert!(posted.0.lock().expect("posted").is_empty());
}

#[test]
fn a_malformed_escalation_posts_nothing_and_does_not_panic() {
    let posted = Arc::new(Posted::default());
    let no_question = event("escalation-raised", json!({"qid": "dwfq-1-1"}));
    host(&posted)
        .record("ses_parent", &no_question, &[])
        .expect("recorded");
    assert!(posted.0.lock().expect("posted").is_empty());
}

#[test]
fn a_run_stall_posts_one_notice_with_its_minutes_reason_and_fan_out() {
    let posted = Arc::new(Posted::default());
    let stall = stalled(json!({"sinceMs": 1_200_000, "reason": "rate_limit", "cap": 4}));
    host(&posted)
        .record("ses_parent", &stall, &[])
        .expect("recorded");

    let posted = posted.0.lock().expect("posted");
    assert_eq!(posted.len(), 1, "one notice per stall");
    let text = &posted[0].1;
    assert!(
        text.contains("has not completed a model request in 20 minutes"),
        "{text}"
    );
    assert!(
        text.contains("the provider keeps answering rate_limit"),
        "{text}"
    );
    assert!(text.contains("(current fan-out 4)"), "{text}");
}

#[test]
fn a_malformed_stall_posts_nothing() {
    let posted = Arc::new(Posted::default());
    let host = host(&posted);
    host.record("ses_parent", &stalled(json!({"sinceMs": "soon"})), &[])
        .expect("recorded");
    host.record("ses_parent", &stalled(json!({"sinceMs": -5})), &[])
        .expect("recorded");
    assert!(posted.0.lock().expect("posted").is_empty());
}

#[test]
fn other_run_events_post_nothing() {
    let posted = Arc::new(Posted::default());
    let settled = event("node-settled", json!({"nodeId": "n1", "status": "done"}));
    host(&posted)
        .record("ses_parent", &settled, &[])
        .expect("recorded");
    assert!(posted.0.lock().expect("posted").is_empty());
}

/// A reminder host that only counts the timers the clock schedules, with one live run that owes a decision.
#[derive(Default)]
struct Timers {
    scheduled: std::sync::atomic::AtomicU64,
}

impl crate::fork::workflow_reminder::ReminderHost for Timers {
    fn live_run_ids(&self) -> Vec<String> {
        vec!["dwfrun-7".to_owned()]
    }
    fn is_idle(&self) -> bool {
        true
    }
    fn read_open(&self, _run_id: &str) -> Option<crate::fork::workflow_reminder::OpenDecisions> {
        None
    }
    fn remind(&self, _reminder: crate::fork::workflow_reminder::Reminder) {}
    fn now_ms(&self) -> u64 {
        0
    }
    fn schedule(
        &self,
        _delay_ms: u64,
        _fire: Box<dyn FnOnce() + Send>,
    ) -> Box<dyn FnOnce() + Send> {
        self.scheduled
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::new(|| {})
    }
}

/// The progress path hands an open-set event to the reminder clock, which restarts its idle clock; any other event leaves
/// the clock alone.
#[test]
fn an_open_set_event_restarts_the_reminder_clock_and_an_unrelated_event_does_not() {
    let timers = Arc::new(Timers::default());
    let clock = crate::fork::workflow_reminder::BlockedReminderClock::new(timers.clone());
    clock.session_idle();
    let armed = timers.scheduled.load(std::sync::atomic::Ordering::SeqCst);
    let host = WorkflowProgressHost::new(Arc::new(Quiet)).with_reminder(clock);

    host.record("ses_parent", &event("node-settled", json!({})), &[])
        .expect("recorded");
    assert_eq!(
        timers.scheduled.load(std::sync::atomic::Ordering::SeqCst),
        armed,
        "an unrelated event does not touch the clock"
    );

    host.record("ses_parent", &raised(), &[]).expect("recorded");
    assert_eq!(
        timers.scheduled.load(std::sync::atomic::Ordering::SeqCst),
        armed + 1,
        "an open-set event re-arms the idle clock"
    );
}

#[test]
fn a_host_without_a_notice_sink_still_records_the_deltas() {
    let host = WorkflowProgressHost::new(Arc::new(Quiet));
    host.record("ses_parent", &raised(), &[json!({"op": "x"})])
        .expect("recorded");
}

/// W8b (9.49, closes 353 and 518): a hole the run reaches posts one hole notice (Node `notifyHoleReached`).
fn reached(prompt: &str) -> Value {
    event(
        "hole-reached",
        json!({
            "instance": {"siteId": "scout", "ordinal": 2},
            "name": "Plan",
            "prompt": prompt,
            "phaseName": "write"
        }),
    )
}

#[test]
fn a_hole_reached_posts_one_hole_notice_to_the_parent() {
    let posted = Arc::new(Posted::default());
    host(&posted)
        .record("ses_parent", &reached("Draft the plan"), &[])
        .expect("recorded");

    let posted = posted.0.lock().expect("posted");
    assert_eq!(posted.len(), 1, "one notice per reached hole");
    assert_eq!(posted[0].0, "ses_parent");
    let text = &posted[0].1;
    assert!(text.contains("<workflow-hole>"), "{text}");
    assert!(text.contains("<hole-id>scout</hole-id>"), "{text}");
    assert!(text.contains("<name>Plan</name>"), "{text}");
    assert!(text.contains("<prompt>Draft the plan</prompt>"), "{text}");
    assert!(
        text.contains(
            "reached the hole \"Plan\" (scout) and is waiting for you to write its body."
        ),
        "{text}"
    );
    assert!(
        text.contains("call FillWorkflowHole with run_id=\"dwfrun-7\" and hole_id=\"scout\""),
        "{text}"
    );
}

#[test]
fn a_hole_filled_and_a_hole_with_no_instance_post_nothing() {
    let posted = Arc::new(Posted::default());
    let host = host(&posted);
    host.record(
        "ses_parent",
        &event("hole-filled", json!({"siteId": "scout"})),
        &[],
    )
    .expect("recorded");
    host.record(
        "ses_parent",
        &event("hole-reached", json!({"name": "Plan"})),
        &[],
    )
    .expect("recorded");
    assert!(posted.0.lock().expect("posted").is_empty());
}

#[test]
fn a_hole_prompt_over_four_thousand_units_is_cut_with_an_ellipsis() {
    let posted = Arc::new(Posted::default());
    let long = "a".repeat(5_000);
    host(&posted)
        .record("ses_parent", &reached(&long), &[])
        .expect("recorded");
    let posted = posted.0.lock().expect("posted");
    let cut = format!("<prompt>{}…</prompt>", "a".repeat(3_999));
    assert!(posted[0].1.contains(&cut), "{}", posted[0].1);
}

/// The run source the parent's reminders read (9.44): the hole waits in the run's projection with its type.
struct WaitingHole;

impl RunDecisionsSource for WaitingHole {
    fn live_run_ids(&self, _session: &str) -> Vec<String> {
        vec!["dwfrun-7".to_owned()]
    }

    fn open(&self, _session: &str, _run_id: &str) -> Result<Option<OpenDecisions>, String> {
        Ok(Some(OpenDecisions {
            questions: Vec::new(),
            holes: vec![OpenHole {
                site_id: "scout".to_owned(),
                name: "Plan".to_owned(),
                type_name: "Plan".to_owned(),
                line: None,
                since: Some(1_700_000_000_000),
            }],
            draft_path: None,
        }))
    }
}

/// The same waiting hole, with the run's script file the run store names (Node's snapshot `scriptPath`).
struct WaitingHoleWithDraft;

impl RunDecisionsSource for WaitingHoleWithDraft {
    fn live_run_ids(&self, _session: &str) -> Vec<String> {
        vec!["dwfrun-7".to_owned()]
    }

    fn open(&self, session: &str, run_id: &str) -> Result<Option<OpenDecisions>, String> {
        let mut open = WaitingHole.open(session, run_id)?.expect("open");
        open.draft_path = Some("/ws/.zcode/workflow-drafts/a.dwf.ts".to_owned());
        Ok(Some(open))
    }
}

/// 9.62 (DWH-02, closes 488 for the notice): Node `notifyHoleReached` falls back to the snapshot's `scriptPath` for the
/// draft and to the hole's `since` for `reachedAt`; the desktop's hole row shows both.
#[test]
fn a_hole_notice_names_the_runs_script_as_its_draft_and_carries_when_it_was_reached() {
    let posted = Arc::new(Posted::default());
    let notices: Arc<dyn WorkflowNotices> = posted.clone();
    let reminders = Arc::new(WorkflowReminders::new(
        Arc::new(NoGates),
        Arc::new(NoTimers),
        notices,
    ));
    assert!(reminders.set_runs(Arc::new(WaitingHoleWithDraft)));
    WorkflowProgressHost::new(Arc::new(Quiet))
        .with_notices(posted.clone())
        .with_reminders(reminders)
        .record("ses_parent", &reached("Draft the plan"), &[])
        .expect("recorded");
    let text = posted.0.lock().expect("posted")[0].1.clone();
    assert!(
        text.contains("  <draft>/ws/.zcode/workflow-drafts/a.dwf.ts</draft>"),
        "{text}"
    );
    assert!(
        text.contains(
            "Next step: Read the draft at /ws/.zcode/workflow-drafts/a.dwf.ts for the context"
        ),
        "{text}"
    );
    let workflow = posted.1.lock().expect("workflow")[0]
        .clone()
        .expect("a payload");
    assert_eq!(
        workflow["workflowNotification"]["draftPath"],
        "/ws/.zcode/workflow-drafts/a.dwf.ts"
    );
    assert_eq!(
        workflow["workflowNotification"]["reachedAt"],
        json!(1_700_000_000_000u64)
    );
}

struct NoGates;

impl DynamicWorkflowGates for NoGates {
    fn gate(&self, _session: &SessionId) -> Option<DynamicWorkflowGate> {
        None
    }
}

struct NoTimers;

impl ReminderTimers for NoTimers {
    fn now_ms(&self) -> u64 {
        0
    }

    fn schedule(
        &self,
        _delay_ms: u64,
        _fire: Box<dyn FnOnce() + Send>,
    ) -> Box<dyn FnOnce() + Send> {
        Box::new(|| {})
    }
}

#[test]
fn a_hole_notice_takes_its_type_from_the_run_the_parent_reads() {
    let posted = Arc::new(Posted::default());
    let notices: Arc<dyn WorkflowNotices> = posted.clone();
    let reminders = Arc::new(WorkflowReminders::new(
        Arc::new(NoGates),
        Arc::new(NoTimers),
        notices,
    ));
    assert!(reminders.set_runs(Arc::new(WaitingHole)));
    WorkflowProgressHost::new(Arc::new(Quiet))
        .with_notices(posted.clone())
        .with_reminders(reminders)
        .record("ses_parent", &reached("Draft the plan"), &[])
        .expect("recorded");
    let posted = posted.0.lock().expect("posted");
    assert_eq!(posted.len(), 1);
    assert!(posted[0].1.contains("<type>Plan</type>"), "{}", posted[0].1);
    assert!(
        !posted[0].1.contains("<type>unknown</type>"),
        "{}",
        posted[0].1
    );
}

/// Node `notifyHoleReached` reads each field payload-first (the payload wins when it carries one).
#[test]
fn a_payload_type_and_line_win_over_the_projection() {
    let posted = Arc::new(Posted::default());
    let notices: Arc<dyn WorkflowNotices> = posted.clone();
    let reminders = Arc::new(WorkflowReminders::new(
        Arc::new(NoGates),
        Arc::new(NoTimers),
        notices,
    ));
    assert!(reminders.set_runs(Arc::new(WaitingHole)));
    let payload = event(
        "hole-reached",
        json!({
            "instance": {"siteId": "scout", "ordinal": 2},
            "name": "Plan",
            "type": "Draft",
            "line": 7
        }),
    );
    WorkflowProgressHost::new(Arc::new(Quiet))
        .with_notices(posted.clone())
        .with_reminders(reminders)
        .record("ses_parent", &payload, &[])
        .expect("recorded");
    let posted = posted.0.lock().expect("posted");
    assert_eq!(posted.len(), 1);
    assert!(
        posted[0].1.contains("<type>Draft</type>"),
        "{}",
        posted[0].1
    );
    assert!(posted[0].1.contains("<line>7</line>"), "{}", posted[0].1);
}

#[test]
fn a_raised_escalation_carries_its_payload_which_the_text_does_not() {
    let posted = Arc::new(Posted::default());
    host(&posted)
        .record("ses_parent", &raised(), &[])
        .expect("recorded");
    let workflow = posted.1.lock().expect("workflow")[0]
        .clone()
        .expect("a payload");
    assert_eq!(workflow["workflowNotification"]["kind"], "escalation");
    assert_eq!(workflow["workflowNotification"]["qid"], "dwfq-1-1");
    assert_eq!(workflow["workflowNotification"]["actor"], "scout@3");
    assert_eq!(
        workflow["workflowNotification"]["askedAt"],
        json!(1_700_000_000_000u64)
    );
}

#[test]
fn a_stall_carries_its_time_reason_and_cap_in_the_payload() {
    let posted = Arc::new(Posted::default());
    let stall = stalled(json!({"sinceMs": 1_200_000, "reason": "rate_limit", "cap": 4}));
    host(&posted)
        .record("ses_parent", &stall, &[])
        .expect("recorded");
    let workflow = posted.1.lock().expect("workflow")[0]
        .clone()
        .expect("a payload");
    assert_eq!(workflow["workflowNotification"]["kind"], "stall");
    assert_eq!(workflow["workflowNotification"]["sinceMs"], 1_200_000);
    assert_eq!(workflow["workflowNotification"]["reason"], "rate_limit");
    assert_eq!(workflow["workflowNotification"]["cap"], 4);
}

#[test]
fn a_hole_carries_its_ordinal_which_the_text_does_not() {
    let posted = Arc::new(Posted::default());
    host(&posted)
        .record("ses_parent", &reached("Write it"), &[])
        .expect("recorded");
    let workflow = posted.1.lock().expect("workflow")[0]
        .clone()
        .expect("a payload");
    assert_eq!(workflow["workflowNotification"]["kind"], "hole");
    assert_eq!(workflow["workflowNotification"]["siteId"], "scout");
    assert_eq!(workflow["workflowNotification"]["ordinal"], 2);
    assert_eq!(workflow["workflowNotification"]["name"], "Plan");
    assert_eq!(workflow["workflowNotification"]["prompt"], "Write it");
}

/// 9.61: a named run's notices call it by its name (Node's registry description); an unnamed run keeps its id.
#[test]
fn a_named_runs_escalation_and_stall_call_it_by_its_name() {
    let posted = Arc::new(Posted::default());
    let mut named = raised();
    named["runName"] = json!("E2E 提问工作流");
    host(&posted)
        .record("ses_parent", &named, &[])
        .expect("recorded");
    let mut stall =
        stalled(json!({"sinceMs": 1_200_000, "dominantReason": "rate_limit", "cap": 4}));
    stall["runName"] = json!("E2E 提问工作流");
    host(&posted)
        .record("ses_parent", &stall, &[])
        .expect("recorded");

    let posted = posted.0.lock().expect("posted");
    assert_eq!(posted.len(), 2);
    for (_, text) in posted.iter() {
        assert!(text.contains("<run>E2E 提问工作流</run>"), "{text}");
        assert!(text.contains("<run-id>dwfrun-7</run-id>"), "{text}");
    }
}
