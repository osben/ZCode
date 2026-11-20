//! W7-7c: the progress path posts the model-visible run notices (Node `recordDynamicWorkflowRunProgress`): one notice per
//! raised escalation and per run stall, and nothing for the other events or for a malformed payload.

use std::sync::{Arc, Mutex};

use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use serde_json::{Value, json};

use super::{ProgressDelivery, WorkflowNotices, WorkflowProgressHost};

#[derive(Default)]
struct Posted(Mutex<Vec<(String, String)>>);

impl WorkflowNotices for Posted {
    fn post(&self, parent_session_id: &str, text: String) {
        self.0
            .lock()
            .expect("posted")
            .push((parent_session_id.to_owned(), text));
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

#[test]
fn a_host_without_a_notice_sink_still_records_the_deltas() {
    let host = WorkflowProgressHost::new(Arc::new(Quiet));
    host.record("ses_parent", &raised(), &[json!({"op": "x"})])
        .expect("recorded");
}
