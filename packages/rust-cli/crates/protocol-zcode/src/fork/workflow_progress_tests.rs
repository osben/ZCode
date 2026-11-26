//! W7-5e: the progress port hands a run's live deltas to the parent session's open stream. It writes no session row: Node
//! keeps the event in its in-memory store and cold reads replay the journal.

use std::sync::{Arc, Mutex};

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use serde_json::{Value, json};

use super::{BridgeDelivery, ProgressDelivery, WorkflowProgressHost};
use crate::fork::workspace_trust::tests::{fixture_reading, settled};
use crate::wire::Purpose;

#[derive(Default)]
struct Recording {
    calls: Mutex<Vec<(String, Vec<Value>)>>,
}

impl ProgressDelivery for Recording {
    fn deliver(&self, parent_session_id: &str, deltas: Vec<Value>) {
        self.calls
            .lock()
            .expect("calls")
            .push((parent_session_id.to_owned(), deltas));
    }
}

/// Node's `DynamicWorkflowRunProgressPayload` for one `node-settled` event.
fn node_payload() -> Value {
    json!({
        "runId": "dwfrun-7",
        "toolCallId": "toolu_9",
        "sequence": 12,
        "eventType": "node-settled",
        "payload": {"nodeId": "n1", "status": "done", "cached": false},
        "actorSessionId": "sess_dwf-dwfrun-7-a1"
    })
}

#[test]
fn the_port_hands_the_deltas_to_the_parent() {
    let recording = Arc::new(Recording::default());
    let host = WorkflowProgressHost::new(recording.clone());
    let delta = json!({"workflowRuns": {"dwfrun-7": {"status": "running"}}});

    host.record("ses_parent", &node_payload(), std::slice::from_ref(&delta))
        .expect("recorded");

    let calls = recording.calls.lock().expect("calls");
    assert_eq!(calls.len(), 1, "the Host hears the deltas once");
    assert_eq!(calls[0].0, "ses_parent");
    assert_eq!(calls[0].1, vec![delta]);
}

#[test]
fn a_record_with_no_deltas_hands_the_host_nothing() {
    let recording = Arc::new(Recording::default());
    let host = WorkflowProgressHost::new(recording.clone());
    host.record("ses_parent", &node_payload(), &[])
        .expect("recorded");
    assert!(recording.calls.lock().expect("calls").is_empty());
}

/// The production delivery reaches an open stream: the delta is a frame on the session's subscription, the projection is
/// unchanged, and a session with no open stream drops its delta without an error.
#[tokio::test]
async fn a_live_delta_reaches_the_open_stream_and_an_unopened_session_drops_it() {
    use tokio::io::AsyncBufReadExt;

    let (_scope, server, reader) = fixture_reading(None, false);
    let mut lines = tokio::io::BufReader::new(reader).lines();
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    live.sink.subscribe("sub-1", "conn-1");
    live.sink.start("sub-1", Purpose::Online).await;
    // The open's success-total seed runs in the pump (specs/fork-rust-completed-activity-count.md).
    settled(&live).await;
    let before = live.sink.snapshot();

    let delivery = BridgeDelivery::new(Arc::downgrade(&server.context));
    let delta = json!({"op": "workflowRuns.progress", "runId": "dwfrun-7"});
    delivery.deliver("s1", vec![delta.clone()]);
    delivery.deliver("not-open", vec![json!({"op": "workflowRuns.dropped"})]);
    settled(&live).await;

    assert_eq!(live.sink.snapshot(), before, "the projection is unchanged");
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let line = lines.next_line().await.unwrap().expect("a line");
            if line.contains("workflowRuns.progress") {
                return line;
            }
        }
    })
    .await
    .expect("the delta frame is sent");
    assert!(frame.contains("\"subscriptionId\":\"sub-1\""), "{frame}");
    assert!(frame.contains("\"kind\":\"deltas\""), "{frame}");
    let stray =
        tokio::time::timeout(std::time::Duration::from_millis(200), lines.next_line()).await;
    match stray {
        Err(_) => {}
        Ok(Ok(Some(line))) => assert!(
            !line.contains("workflowRuns.dropped"),
            "a session without a stream drops its delta: {line}"
        ),
        Ok(_) => {}
    }
}

/// W7-5e review (ocr 2): the context reaches the session bridge only weakly, so dropping the server drops the bridge.
/// A strong reference from the context would keep every open session alive past its server.
#[tokio::test]
async fn dropping_the_server_drops_its_session_bridge() {
    let (_scope, server, _reader) = fixture_reading(None, false);
    let bridge = Arc::downgrade(&server.bridge);
    drop(server);
    assert!(
        bridge.upgrade().is_none(),
        "the session bridge outlived its server"
    );
}

/// W7-5e review (ocr 3): a delivery does not keep the context alive. The run service holds the port, and the context
/// holds the run service, so a strong context here would be a cycle.
#[tokio::test]
async fn a_delivery_does_not_keep_the_context_alive() {
    let (_scope, server, _reader) = fixture_reading(None, false);
    let context = Arc::downgrade(&server.context);
    let delivery = BridgeDelivery::new(Arc::downgrade(&server.context));
    drop(server);
    drop(delivery);
    assert!(
        context.upgrade().is_none(),
        "the delivery kept the context alive"
    );
}
