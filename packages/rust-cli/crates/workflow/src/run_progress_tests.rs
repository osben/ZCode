//! 9.31 W7-5b: the run progress sink, ported from Node `bootstrap/tests/dynamic-workflow-run-progress-sink.test.ts`.
//! The recording port answers each call with the next scripted behaviour. Logs are not asserted (Rust has no injected
//! logger; the event names are in the code), so the Node "logger absent" case has no Rust counterpart.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use rust_cli_node_store::{LiveProjection, RunProgressFields, WORKFLOW_RUN_LIMITS};
use serde_json::{Value, json};

use super::{ProgressSink, RunProgress};
use crate::event::RunEvent;
use crate::model::{Caps, StoredEvent};

#[derive(Debug, Clone, Copy)]
enum Behaviour {
    Accept,
    Reject,
    /// The port answers with an error: the runtime is not constructed yet (Node's `getRuntime` throws).
    Unbuilt,
    Panic,
}

#[derive(Default)]
struct RecordingPort {
    script: Mutex<VecDeque<Behaviour>>,
    recorded: Mutex<Vec<(String, Value, Vec<Value>)>>,
}

impl RecordingPort {
    fn scripted(behaviours: &[Behaviour]) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(behaviours.iter().copied().collect()),
            recorded: Mutex::new(Vec::new()),
        })
    }

    fn calls(&self) -> Vec<(String, Value, Vec<Value>)> {
        self.recorded.lock().unwrap().clone()
    }
}

impl WorkflowRunProgressPort for RecordingPort {
    fn record(
        &self,
        parent_session_id: &str,
        progress: &Value,
        deltas: &[Value],
    ) -> Result<(), String> {
        let behaviour = self
            .script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Behaviour::Accept);
        match behaviour {
            Behaviour::Accept => {
                self.recorded.lock().unwrap().push((
                    parent_session_id.to_owned(),
                    progress.clone(),
                    deltas.to_vec(),
                ));
                Ok(())
            }
            Behaviour::Reject => Err("the session is closed".to_owned()),
            Behaviour::Unbuilt => Err("the runtime is not constructed".to_owned()),
            Behaviour::Panic => panic!("the runtime is not constructed"),
        }
    }
}

const SESSION: &str = "session-1";
const RUN: &str = "run_1";

fn fields(run: &str) -> RunProgressFields {
    RunProgressFields {
        run_id: run.to_owned(),
        tool_call_id: Some("call-1".to_owned()),
        default_concurrency: 4.0,
        ..Default::default()
    }
}

fn sink(
    port: Arc<RecordingPort>,
    owned: &str,
    parent: Option<&str>,
    run: &str,
    projection: Arc<Mutex<LiveProjection>>,
) -> ProgressSink {
    ProgressSink::new(
        owned.to_owned(),
        parent.map(str::to_owned),
        fields(run),
        projection,
        port,
    )
}

fn fresh_projection() -> Arc<Mutex<LiveProjection>> {
    Arc::new(Mutex::new(LiveProjection::new(WORKFLOW_RUN_LIMITS)))
}

fn started(sequence: u64, run: &str) -> StoredEvent {
    let event = RunEvent::RunStarted {
        run_id: run.to_owned(),
        caps: Caps::default(),
    };
    StoredEvent {
        sequence,
        payload_json: event.payload_json(),
        time_created: None,
    }
}

#[test]
fn appends_the_payload_to_this_apps_runtime() {
    let port = RecordingPort::scripted(&[]);
    let mut sink = sink(
        port.clone(),
        SESSION,
        Some(SESSION),
        RUN,
        fresh_projection(),
    );
    sink.progress(&started(1, RUN));
    let calls = port.calls();
    assert_eq!(calls.len(), 1, "one event, one record");
    let (parent, progress, _) = &calls[0];
    assert_eq!(parent, SESSION);
    assert_eq!(progress["runId"], json!(RUN));
    assert_eq!(progress["toolCallId"], json!("call-1"));
    assert_eq!(progress["sequence"], json!(1));
    assert_eq!(progress["eventType"], json!("run-started"));
}

#[test]
fn appends_when_the_routing_parent_is_absent() {
    let port = RecordingPort::scripted(&[]);
    let mut sink = sink(port.clone(), SESSION, None, RUN, fresh_projection());
    sink.progress(&started(1, RUN));
    let calls = port.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, SESSION, "the owned session receives it");
}

#[test]
fn drops_an_event_whose_parent_is_not_this_app_and_records_nothing() {
    let port = RecordingPort::scripted(&[]);
    let mut sink = sink(
        port.clone(),
        SESSION,
        Some("other-session"),
        RUN,
        fresh_projection(),
    );
    sink.progress(&started(1, RUN));
    assert!(
        port.calls().is_empty(),
        "an explicit mismatch is never appended"
    );
}

#[test]
fn a_port_that_is_not_constructed_yet_is_a_no_op_and_the_run_is_not_failed() {
    let port = RecordingPort::scripted(&[Behaviour::Unbuilt]);
    let mut sink = sink(
        port.clone(),
        SESSION,
        Some(SESSION),
        RUN,
        fresh_projection(),
    );
    sink.progress(&started(1, RUN));
    assert!(port.calls().is_empty());
}

#[test]
fn a_rejected_append_is_a_logged_no_op() {
    let port = RecordingPort::scripted(&[Behaviour::Reject]);
    let mut sink = sink(
        port.clone(),
        SESSION,
        Some(SESSION),
        RUN,
        fresh_projection(),
    );
    sink.progress(&started(1, RUN));
    assert!(port.calls().is_empty());
}

#[test]
fn a_synchronous_failure_in_record_is_swallowed() {
    let port = RecordingPort::scripted(&[Behaviour::Panic]);
    let mut sink = sink(
        port.clone(),
        SESSION,
        Some(SESSION),
        RUN,
        fresh_projection(),
    );
    sink.progress(&started(1, RUN));
    assert!(port.calls().is_empty());
}

#[test]
fn one_failure_does_not_affect_later_events() {
    let port = RecordingPort::scripted(&[Behaviour::Reject, Behaviour::Panic]);
    let mut sink = sink(
        port.clone(),
        SESSION,
        Some(SESSION),
        RUN,
        fresh_projection(),
    );
    sink.progress(&started(1, RUN));
    sink.progress(&started(2, RUN));
    sink.progress(&started(3, RUN));
    let calls = port.calls();
    assert_eq!(calls.len(), 1, "the third event lands after two failures");
    assert_eq!(calls[0].1["sequence"], json!(3));
}

#[test]
fn the_projection_deltas_travel_with_the_progress() {
    let port = RecordingPort::scripted(&[]);
    let mut sink = sink(
        port.clone(),
        SESSION,
        Some(SESSION),
        RUN,
        fresh_projection(),
    );
    sink.progress(&started(1, RUN));
    let calls = port.calls();
    let deltas = &calls[0].2;
    assert!(
        !deltas.is_empty(),
        "a run's first event changes the snapshot"
    );
    assert!(deltas.iter().all(|delta| delta.get("op").is_some()));
}

#[test]
fn two_runs_of_one_session_share_one_projection() {
    let port = RecordingPort::scripted(&[]);
    let projection = fresh_projection();
    let mut first = sink(
        port.clone(),
        SESSION,
        Some(SESSION),
        "run_a",
        projection.clone(),
    );
    let mut second = sink(port, SESSION, Some(SESSION), "run_b", projection.clone());
    first.progress(&started(1, "run_a"));
    second.progress(&started(2, "run_b"));
    let runs = projection.lock().unwrap().snapshot();
    assert_eq!(runs["runs"].as_array().map(Vec::len), Some(2));
}

/// Finding 7: `LaunchProgress::into_sink` threads the launch facts (tool call, subagent model, default concurrency)
/// into the envelopes it records, under the owned session.
#[test]
fn a_launch_progress_records_under_its_session_with_the_launched_fields() {
    use super::LaunchProgress;
    let port = RecordingPort::scripted(&[]);
    let mut sink = LaunchProgress {
        owned_session: SESSION.into(),
        parent_session_id: Some(SESSION.into()),
        run_id: RUN.into(),
        tool_call_id: Some("call-9".into()),
        resumed_from: None,
        subagent_model: Some("claude-sonnet".into()),
        model_bindings: None,
        default_concurrency: 6.0,
        run_name: Some("E2E 提问工作流".into()),
        projection: fresh_projection(),
        port: port.clone(),
    }
    .into_sink();
    sink.progress(&started(1, RUN));
    let calls = port.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, SESSION);
    assert_eq!(calls[0].1["toolCallId"], json!("call-9"));
    assert_eq!(
        calls[0].1["payload"]["subagentModel"],
        json!("claude-sonnet")
    );
    assert_eq!(calls[0].1["payload"]["concurrencyCeiling"], json!(6));
    // 9.61: the run's name rides on the progress for the host's notices.
    assert_eq!(calls[0].1["runName"], json!("E2E 提问工作流"));
}

#[test]
fn an_unreadable_payload_is_dropped_without_a_record() {
    let port = RecordingPort::scripted(&[]);
    let mut sink = sink(
        port.clone(),
        SESSION,
        Some(SESSION),
        RUN,
        fresh_projection(),
    );
    sink.progress(&StoredEvent {
        sequence: 1,
        payload_json: "not json".to_owned(),
        time_created: None,
    });
    assert!(port.calls().is_empty());
}

/// 9.62 (DWH-02): a live `hole-reached` carries the journal's stamp as `reachedAt` (Node `withHoleFacts` from
/// `sequenceCapture.timeCreatedOf`), the same number cold replay reads back, so the hole notice can count the wait.
#[test]
fn a_live_hole_reached_carries_the_journal_stamp_as_reached_at() {
    let port = RecordingPort::scripted(&[]);
    let mut sink = sink(
        port.clone(),
        SESSION,
        Some(SESSION),
        RUN,
        fresh_projection(),
    );
    sink.progress(&started(1, RUN));
    let reached = RunEvent::HoleReached {
        instance: crate::model::Ref {
            site_id: "hole#1".to_owned(),
            ordinal: 1,
        },
        name: "decide".to_owned(),
        prompt: None,
        phase: None,
    };
    sink.progress(&StoredEvent {
        sequence: 2,
        payload_json: reached.payload_json(),
        time_created: Some(1_795_280_200_123),
    });
    let calls = port.calls();
    assert_eq!(calls.len(), 2);
    let (_, progress, _) = &calls[1];
    assert_eq!(progress["eventType"], json!("hole-reached"));
    assert_eq!(
        progress["payload"]["reachedAt"],
        json!(1_795_280_200_123_i64)
    );
}
