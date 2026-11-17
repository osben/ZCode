//! Fork: `v4/telemetry/model-request-metrics` (Node `normalizeModelRequestMetrics`). One notification per completed
//! model request, with its own strict field set, separate from the `v4/telemetry/event` facts.

use rust_cli_kernel_api::ids::{CommandId, MessageId, TurnId};
use rust_cli_kernel_api::message::Usage;
use rust_cli_kernel_api::metering::{CallStatus, ModelCall};
use rust_cli_kernel_api::model::{ModelSelection, QuerySource};
use rust_cli_kernel_api::session_api::KernelEvent;
use rust_cli_kernel_api::side_request::SideSource;
use serde_json::{Value, json};

use super::{Observed, Provider, Role, Telemetry};

fn provider() -> Provider {
    Provider {
        provider: "e2e-upstream".into(),
        model: "deepseek-v4-flash".into(),
        kind: Some("anthropic".into()),
        host: Some("127.0.0.1".into()),
    }
}

fn selection() -> ModelSelection {
    ModelSelection::new("e2e-upstream".to_owned(), "deepseek-v4-flash".to_owned())
}

fn call(source: QuerySource, started: u64, completed: u64) -> ModelCall {
    ModelCall::new(
        MessageId::new("msg_1"),
        source,
        selection(),
        started,
        completed,
        CallStatus::Completed,
    )
}

/// A telemetry feed with its own sequence, as the live pump drives it.
struct Feed {
    telemetry: Telemetry,
    provider: Provider,
    seq: u64,
}

impl Feed {
    fn new(role: Role) -> Self {
        Self {
            telemetry: Telemetry::new("sess_main", role),
            provider: provider(),
            seq: 0,
        }
    }

    fn event(&mut self, event: &KernelEvent) -> Vec<Value> {
        self.seq += 1;
        let at = Observed {
            scope: "",
            seq: self.seq,
            now: 1_000 + self.seq,
            provider: &self.provider,
            automation: None,
        };
        self.telemetry.observe(event, &at)
    }

    fn metrics(&mut self, call: &ModelCall) -> Value {
        self.seq += 1;
        let at = Observed {
            scope: "",
            seq: self.seq,
            now: 5_000,
            provider: &self.provider,
            automation: None,
        };
        self.telemetry.model_request_metrics(call, &at)
    }
}

fn keys(value: &Value) -> Vec<String> {
    let mut keys: Vec<String> = value
        .as_object()
        .expect("an object")
        .keys()
        .cloned()
        .collect();
    keys.sort();
    keys
}

fn turn_started(turn: &str, command: &str) -> KernelEvent {
    KernelEvent::TurnStarted {
        turn: TurnId::new(turn),
        command: Some(CommandId::new(command)),
    }
}

#[test]
fn a_completed_main_request_reports_its_timing_and_usage() {
    let mut feed = Feed::new(Role::Main);
    feed.event(&turn_started("turn_1", "cmd-1"));
    let completed = ModelCall {
        first_content_at_ms: Some(1_250),
        usage: Some(Usage {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 30,
        }),
        ..call(QuerySource::MainThread, 1_000, 2_000)
    };
    let mut fact = feed.metrics(&completed);
    assert!(fact["eventId"].as_str().is_some_and(|id| !id.is_empty()));
    fact.as_object_mut().expect("an object").remove("eventId");
    assert_eq!(
        fact,
        json!({
            "version": 1,
            "eventSeq": 2,
            "occurredAt": 5_000,
            "sessionId": "sess_main",
            "kind": "model.request.metrics",
            "turnId": "turn_1",
            "sourceCommandId": "cmd-1",
            "requestId": "msg_1",
            "providerId": "e2e-upstream",
            "modelId": "deepseek-v4-flash",
            "querySource": "main_turn",
            "queryId": "cmd-1",
            "durationMs": 1_000,
            "timeToFirstContentMs": 250,
            // Node's inputTokens is the total input: the cache reads and writes are part of it.
            "inputTokens": 135,
            "outputTokens": 20,
            "cacheReadTokens": 30,
            "cacheWriteTokens": 5,
        })
    );
}

#[test]
fn unknown_values_are_omitted_not_zeroed() {
    let mut feed = Feed::new(Role::Main);
    let fact = feed.metrics(&call(QuerySource::MainThread, 1_000, 1_400));
    assert_eq!(
        keys(&fact),
        [
            "durationMs",
            "eventId",
            "eventSeq",
            "kind",
            "modelId",
            "occurredAt",
            "providerId",
            "querySource",
            "requestId",
            "sessionId",
            "version",
        ]
    );
    assert_eq!(fact["durationMs"], json!(400));
}

#[test]
fn only_the_main_thread_names_a_query_id_and_side_requests_use_node_names() {
    let mut feed = Feed::new(Role::Main);
    feed.event(&turn_started("turn_1", "cmd-1"));
    let subagent = feed.metrics(&call(QuerySource::Subagent("explore".into()), 1_000, 1_100));
    assert_eq!(subagent["querySource"], json!("subagent"));
    assert!(subagent.get("queryId").is_none());
    let side = feed.metrics(&call(
        QuerySource::Side(SideSource::SessionTitle),
        1_000,
        1_100,
    ));
    assert_eq!(side["querySource"], json!("session_title"));
    assert!(side.get("queryId").is_none());
}

#[test]
fn a_request_outside_a_turn_has_no_turn_or_command() {
    let mut feed = Feed::new(Role::Main);
    let fact = feed.metrics(&call(QuerySource::Compact, 1_000, 1_100));
    assert_eq!(fact["querySource"], json!("compact"));
    assert!(fact.get("turnId").is_none());
    assert!(fact.get("sourceCommandId").is_none());
    assert!(fact.get("queryId").is_none());
}

#[test]
fn a_child_session_reports_no_command_fields() {
    let mut feed = Feed::new(Role::Child);
    feed.event(&KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let fact = feed.metrics(&call(QuerySource::Subagent("explore".into()), 1_000, 1_100));
    assert!(fact.get("sourceCommandId").is_none());
    assert!(fact.get("queryId").is_none());
}

#[test]
fn duration_never_goes_negative() {
    let mut feed = Feed::new(Role::Main);
    let fact = feed.metrics(&call(QuerySource::MainThread, 2_000, 1_000));
    assert_eq!(fact["durationMs"], json!(0));
}

#[test]
fn the_request_is_not_a_telemetry_event_fact() {
    let mut feed = Feed::new(Role::Main);
    let facts = feed.event(&KernelEvent::ModelRequestCompleted {
        call: Box::new(call(QuerySource::MainThread, 1_000, 2_000)),
    });
    assert!(facts.is_empty());
}
