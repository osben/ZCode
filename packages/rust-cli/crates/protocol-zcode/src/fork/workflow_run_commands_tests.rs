//! Tests of the v4 run controls `startSavedWorkflow` and `amendWorkflowRunSettings` (specs/fork-rust-workflow-engine.md, 9.53,
//! W9a). The route tests call the real command path (`crate::commands::command`) on a session the legacy harness creates;
//! the run service is a fake port that answers as the run service would, so the mapping of each answer is what is under test.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::dynamic_workflow::DynamicWorkflowGate;
use rust_cli_kernel_api::ids::{SessionId, WorkflowRunId};
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, DynamicWorkflowRunPort, DynamicWorkflowRunSessions, SettingsOutcome,
    SettingsRefusal, SettingsRequest, StartRefusal, StartSavedOutcome, StartSavedRequest,
    WorkflowTurnSink,
};
use serde_json::{Value, json};

use super::{settings_refusal_code, settings_request, start_refusal_code};
use crate::fork::legacy_session::tests::server;

/// What the fake run service was asked, and the answers it gives.
#[derive(Default)]
struct Fake {
    starts: Mutex<Vec<StartSavedRequest>>,
    start_answer: Mutex<Option<StartSavedOutcome>>,
    amends: Mutex<Vec<SettingsRequest>>,
    amend_answer: Mutex<Option<SettingsOutcome>>,
}

struct Port(Arc<Fake>);

#[async_trait]
impl DynamicWorkflowRunPort for Port {
    async fn start_saved(
        &self,
        request: StartSavedRequest,
        _sink: Arc<dyn WorkflowTurnSink>,
    ) -> Result<StartSavedOutcome, DynamicWorkflowRunError> {
        self.0.starts.lock().expect("fake").push(request);
        Ok(self
            .0
            .start_answer
            .lock()
            .expect("fake")
            .clone()
            .unwrap_or_else(|| {
                StartSavedOutcome::Refused(StartRefusal::NotFound {
                    message: "unset".to_owned(),
                })
            }))
    }

    async fn amend_settings(
        &self,
        request: SettingsRequest,
        _sink: Arc<dyn WorkflowTurnSink>,
    ) -> Result<SettingsOutcome, DynamicWorkflowRunError> {
        self.0.amends.lock().expect("fake").push(request);
        Ok(self
            .0
            .amend_answer
            .lock()
            .expect("fake")
            .clone()
            .unwrap_or(SettingsOutcome::Refused(SettingsRefusal::NotConfigurable)))
    }
}

struct Sessions(Arc<Fake>);

impl DynamicWorkflowRunSessions for Sessions {
    fn for_session(&self, _session: &SessionId) -> Arc<dyn DynamicWorkflowRunPort> {
        Arc::new(Port(self.0.clone()))
    }
}

/// A server with session `s1` open and its gate recorded as `enabled`. The fake run service is installed when given.
async fn session(
    enabled: Option<bool>,
    fake: Option<Arc<Fake>>,
) -> (rust_cli_base::TaskScope, Arc<crate::server::Server>) {
    let (scope, server, _kernel) = server();
    let created = crate::commands::command(
        &server,
        json!({
            "commandId": "create", "clientId": "k", "sessionId": null, "type": "createSession",
            "payload": {"sessionId": "s1", "workspaceId": "/w"},
            "issuedAt": 1, "baseRevision": 0, "baseLogEpoch": "e",
        }),
    )
    .await
    .expect("the create answers");
    assert_eq!(created["status"], json!("accepted"), "{created}");
    if let Some(enabled) = enabled {
        server.record_dynamic_workflow_gate(
            &SessionId::new("s1"),
            DynamicWorkflowGate {
                enabled,
                tools_on_demand: false,
            },
        );
    }
    if let Some(fake) = fake {
        server
            .context
            .set_dynamic_workflow_runs(Arc::new(Sessions(fake)));
    }
    (scope, server)
}

async fn send(server: &crate::server::Server, kind: &str, payload: Value) -> Value {
    crate::commands::command(
        server,
        json!({
            "commandId": format!("cmd-{kind}"), "clientId": "k", "sessionId": "s1", "type": kind,
            "payload": payload, "issuedAt": 2, "baseRevision": 0, "baseLogEpoch": "e",
        }),
    )
    .await
    .expect("the command answers")
}

fn unsupported() -> Value {
    json!("fault.command.capabilityUnsupported")
}

#[tokio::test]
async fn a_start_with_the_gate_closed_answers_as_a_missing_capability() {
    let fake = Arc::new(Fake::default());
    let (_scope, server) = session(Some(false), Some(fake.clone())).await;
    let ack = send(&server, "startSavedWorkflow", json!({"name": "digest"})).await;
    assert_eq!(ack["status"], json!("failed"), "{ack}");
    assert_eq!(ack["reasonCode"], unsupported());
    assert!(
        fake.starts.lock().expect("fake").is_empty(),
        "the run service is not asked"
    );
}

#[tokio::test]
async fn a_start_without_a_recorded_gate_answers_as_a_missing_capability() {
    let fake = Arc::new(Fake::default());
    let (_scope, server) = session(None, Some(fake.clone())).await;
    let ack = send(&server, "startSavedWorkflow", json!({"name": "digest"})).await;
    assert_eq!(ack["reasonCode"], unsupported(), "{ack}");
    assert!(fake.starts.lock().expect("fake").is_empty());
}

#[tokio::test]
async fn a_start_with_no_run_service_installed_answers_as_a_missing_capability() {
    let (_scope, server) = session(Some(true), None).await;
    let ack = send(&server, "startSavedWorkflow", json!({"name": "digest"})).await;
    assert_eq!(ack["status"], json!("failed"), "{ack}");
    assert_eq!(ack["reasonCode"], unsupported());
}

#[tokio::test]
async fn an_accepted_start_answers_with_the_run_and_its_tool_call_and_names_the_session_cwd() {
    let fake = Arc::new(Fake::default());
    *fake.start_answer.lock().expect("fake") = Some(StartSavedOutcome::Started {
        run_id: WorkflowRunId::new("dwfrun-1"),
        tool_call_id: "launch-1".to_owned(),
    });
    let (_scope, server) = session(Some(true), Some(fake.clone())).await;
    let ack = send(
        &server,
        "startSavedWorkflow",
        json!({"name": "digest", "scope": "global", "args": {"topic": "rust"}}),
    )
    .await;
    assert_eq!(ack["status"], json!("accepted"), "{ack}");
    assert_eq!(
        ack["result"],
        json!({"type": "startSavedWorkflow", "runId": "dwfrun-1", "toolCallId": "launch-1"})
    );
    let starts = fake.starts.lock().expect("fake");
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0].name, "digest");
    assert_eq!(starts[0].scope.as_deref(), Some("global"));
    assert_eq!(
        starts[0].args.as_ref().map(|args| args["topic"].clone()),
        Some(json!("rust"))
    );
    assert_eq!(starts[0].cwd, "/w");
}

#[tokio::test]
async fn a_refused_start_is_a_failed_ack_with_nodes_reason_code_and_message() {
    let fake = Arc::new(Fake::default());
    *fake.start_answer.lock().expect("fake") =
        Some(StartSavedOutcome::Refused(StartRefusal::NotFound {
            message: "No saved workflow named 'digest' in this project or globally.".to_owned(),
        }));
    let (_scope, server) = session(Some(true), Some(fake)).await;
    let ack = send(&server, "startSavedWorkflow", json!({"name": "digest"})).await;
    assert_eq!(ack["status"], json!("failed"), "{ack}");
    assert_eq!(
        ack["reasonCode"],
        json!("fault.command.savedWorkflowStartRejected.not_found")
    );
    assert_eq!(
        ack["message"],
        json!("No saved workflow named 'digest' in this project or globally.")
    );
}

#[tokio::test]
async fn a_start_with_an_empty_name_is_an_invalid_payload() {
    let fake = Arc::new(Fake::default());
    let (_scope, server) = session(Some(true), Some(fake.clone())).await;
    let ack = send(&server, "startSavedWorkflow", json!({"name": ""})).await;
    assert_eq!(ack["status"], json!("rejected"), "{ack}");
    assert_eq!(ack["reasonCode"], json!("proto.invalidPayload"));
    assert!(fake.starts.lock().expect("fake").is_empty());
}

#[tokio::test]
async fn a_settings_change_with_the_gate_closed_answers_as_a_missing_capability() {
    let fake = Arc::new(Fake::default());
    let (_scope, server) = session(Some(false), Some(fake.clone())).await;
    let ack = send(
        &server,
        "amendWorkflowRunSettings",
        json!({"workId": "dwfrun-1", "maxConcurrency": 2}),
    )
    .await;
    assert_eq!(ack["reasonCode"], unsupported(), "{ack}");
    assert!(fake.amends.lock().expect("fake").is_empty());
}

#[tokio::test]
async fn an_accepted_amendment_names_the_successor_and_the_superseded_run() {
    let fake = Arc::new(Fake::default());
    *fake.amend_answer.lock().expect("fake") = Some(SettingsOutcome::Amended {
        run_id: WorkflowRunId::new("dwfrun-2"),
        tool_call_id: "settings-2".to_owned(),
        superseded_run_id: Some(WorkflowRunId::new("dwfrun-1")),
    });
    let (_scope, server) = session(Some(true), Some(fake.clone())).await;
    let ack = send(
        &server,
        "amendWorkflowRunSettings",
        json!({"workId": "dwfrun-1", "maxConcurrency": 3}),
    )
    .await;
    assert_eq!(ack["status"], json!("accepted"), "{ack}");
    assert_eq!(
        ack["result"],
        json!({"type": "amendWorkflowRunSettings", "runId": "dwfrun-2", "toolCallId": "settings-2", "supersededRunId": "dwfrun-1"})
    );
    let amends = fake.amends.lock().expect("fake");
    assert_eq!(amends[0].run_id, WorkflowRunId::new("dwfrun-1"));
    assert_eq!(amends[0].max_concurrency, Some(Some(3.0)));
    assert_eq!(
        amends[0].subagent_model, None,
        "an absent setting keeps the run's"
    );
}

#[tokio::test]
async fn a_refused_settings_change_is_a_failed_ack_with_its_reason_code() {
    let fake = Arc::new(Fake::default());
    *fake.amend_answer.lock().expect("fake") =
        Some(SettingsOutcome::Refused(SettingsRefusal::Unchanged));
    let (_scope, server) = session(Some(true), Some(fake)).await;
    let ack = send(
        &server,
        "amendWorkflowRunSettings",
        json!({"workId": "dwfrun-1", "maxConcurrency": null}),
    )
    .await;
    assert_eq!(ack["status"], json!("failed"), "{ack}");
    assert_eq!(
        ack["reasonCode"],
        json!("fault.command.workflowRunSettingsRejected.unchanged")
    );
}

#[test]
fn the_settings_payload_keeps_absent_null_and_value_apart() {
    let absent = settings_request(&json!({"workId": "dwfrun-1"})).expect("a valid payload");
    assert_eq!(absent.max_concurrency, None);
    assert_eq!(absent.subagent_model, None);

    let null = settings_request(
        &json!({"workId": "dwfrun-1", "maxConcurrency": null, "subagentModel": null}),
    )
    .expect("a valid payload");
    assert_eq!(null.max_concurrency, Some(None));
    assert_eq!(null.subagent_model, Some(None));

    let value = settings_request(
        &json!({"workId": "dwfrun-1", "maxConcurrency": 4, "subagentModel": "p/m"}),
    )
    .expect("a valid payload");
    assert_eq!(value.max_concurrency, Some(Some(4.0)));
    assert_eq!(value.subagent_model, Some(Some("p/m".to_owned())));
}

#[test]
fn a_settings_payload_of_the_wrong_shape_is_refused() {
    for bad in [
        json!({}),
        json!({"workId": ""}),
        json!({"workId": "dwfrun-1", "maxConcurrency": 0}),
        json!({"workId": "dwfrun-1", "maxConcurrency": 2.5}),
        json!({"workId": "dwfrun-1", "maxConcurrency": "2"}),
        json!({"workId": "dwfrun-1", "subagentModel": ""}),
    ] {
        assert!(settings_request(&bad).is_none(), "{bad}");
    }
}

#[test]
fn the_refusal_codes_are_nodes_vocabulary() {
    assert_eq!(
        start_refusal_code(&StartRefusal::InvalidArgs {
            message: "x".to_owned()
        })
        .0,
        "invalid_args"
    );
    assert_eq!(
        start_refusal_code(&StartRefusal::CompileFailed {
            message: "x".to_owned()
        })
        .0,
        "compile_failed"
    );
    assert_eq!(
        settings_refusal_code(&SettingsRefusal::MissingBoundaries).0,
        "missing_boundaries"
    );
    let (code, message) = settings_refusal_code(&SettingsRefusal::ModelUnavailable {
        message: "the host's message".to_owned(),
    });
    assert_eq!(
        (code, message.as_str()),
        ("model_unavailable", "the host's message")
    );
}
