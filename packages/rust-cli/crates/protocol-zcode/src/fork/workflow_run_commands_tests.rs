//! Tests of the v4 run controls `startSavedWorkflow` and `amendWorkflowRunSettings` (specs/fork-rust-workflow-engine.md, 9.53,
//! W9a). The route tests call the real command path (`crate::commands::command`) on a session the legacy harness creates;
//! the run service is a fake port that answers as the run service would, so the mapping of each answer is what is under test.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::dynamic_workflow::DynamicWorkflowGate;
use rust_cli_kernel_api::ids::{SessionId, WorkflowRunId};
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, DynamicWorkflowRunPort, DynamicWorkflowRunSessions, LaunchTurn,
    SettingsAmend, SettingsOutcome, SettingsRefusal, SettingsRequest, SettingsTurn, StartRefusal,
    StartSavedOutcome, StartSavedRequest, WorkflowTurnSink,
};
use serde_json::{Value, json};

use super::{settings_ack_message, settings_refusal_code, settings_request, start_refusal_code};
use crate::fork::legacy_session::tests::server;

/// What the fake run service was asked, the answers it gives, and whether it drives the parent's sink as the run service does.
#[derive(Default)]
struct Fake {
    starts: Mutex<Vec<StartSavedRequest>>,
    start_answer: Mutex<Option<StartSavedOutcome>>,
    start_error: Mutex<Option<DynamicWorkflowRunError>>,
    amends: Mutex<Vec<SettingsRequest>>,
    amend_answer: Mutex<Option<SettingsOutcome>>,
    amend_error: Mutex<Option<DynamicWorkflowRunError>>,
    /// A successful start activates the parent and records its launch turn through the sink.
    drive_sink: bool,
    /// The run ids the GUI resume asked for, and the port's answer (Node's result union as JSON).
    resumes: Mutex<Vec<String>>,
    resume_answer: Mutex<Option<Value>>,
    resume_error: Mutex<Option<DynamicWorkflowRunError>>,
}

struct Port(Arc<Fake>);

#[async_trait]
impl DynamicWorkflowRunPort for Port {
    async fn resume(&self, run_id: &WorkflowRunId) -> Result<Value, DynamicWorkflowRunError> {
        self.0
            .resumes
            .lock()
            .expect("fake")
            .push(run_id.as_str().to_owned());
        if let Some(error) = self.0.resume_error.lock().expect("fake").clone() {
            return Err(error);
        }
        Ok(self
            .0
            .resume_answer
            .lock()
            .expect("fake")
            .clone()
            .unwrap_or_else(|| json!({"ok": false, "reason": "not_found"})))
    }

    async fn start_saved(
        &self,
        request: StartSavedRequest,
        sink: Arc<dyn WorkflowTurnSink>,
    ) -> Result<StartSavedOutcome, DynamicWorkflowRunError> {
        self.0.starts.lock().expect("fake").push(request);
        if let Some(error) = self.0.start_error.lock().expect("fake").clone() {
            return Err(error);
        }
        let answer = self
            .0
            .start_answer
            .lock()
            .expect("fake")
            .clone()
            .unwrap_or_else(|| {
                StartSavedOutcome::Refused(StartRefusal::NotFound {
                    message: "unset".to_owned(),
                })
            });
        if self.0.drive_sink
            && let StartSavedOutcome::Started {
                run_id,
                tool_call_id,
            } = &answer
        {
            sink.activate();
            sink.launch_turn(LaunchTurn {
                text: "launch text".to_owned(),
                run_id: run_id.clone(),
                tool_call_id: tool_call_id.clone(),
                name: "digest".to_owned(),
                scope: "project".to_owned(),
                path: "digest.ts".to_owned(),
                args: None,
                description: String::new(),
                display: None,
                script: "return 1".to_owned(),
            });
        }
        Ok(answer)
    }

    async fn amend_settings(
        &self,
        request: SettingsRequest,
        sink: Arc<dyn WorkflowTurnSink>,
    ) -> Result<SettingsOutcome, DynamicWorkflowRunError> {
        self.0.amends.lock().expect("fake").push(request);
        if let Some(error) = self.0.amend_error.lock().expect("fake").clone() {
            return Err(error);
        }
        let answer = self
            .0
            .amend_answer
            .lock()
            .expect("fake")
            .clone()
            .unwrap_or(SettingsOutcome::Refused(SettingsRefusal::NotConfigurable));
        if self.0.drive_sink
            && let SettingsOutcome::Retuned {
                run_id,
                tool_call_id,
            } = &answer
        {
            sink.settings_turn(SettingsTurn {
                text: "settings text".to_owned(),
                run_id: run_id.clone(),
                tool_call_id: tool_call_id.clone(),
                name: None,
                title_input: run_id.as_str().to_owned(),
                display: None,
                amend: SettingsAmend {
                    predecessor_run_id: None,
                    subagent_model: None,
                    max_concurrency: None,
                    default_concurrency: 6.0,
                },
            });
        }
        Ok(answer)
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
    send_as(server, &format!("cmd-{kind}"), kind, payload).await
}

/// One command with its own id: a repeated id is answered as a duplicate, not run again.
async fn send_as(server: &crate::server::Server, id: &str, kind: &str, payload: Value) -> Value {
    crate::commands::command(
        server,
        json!({
            "commandId": id, "clientId": "k", "sessionId": "s1", "type": kind,
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
async fn a_run_service_that_reports_the_capability_absent_answers_as_a_missing_capability() {
    let fake = Arc::new(Fake::default());
    *fake.start_error.lock().expect("fake") =
        Some(DynamicWorkflowRunError::unsupported("startSavedWorkflow"));
    let (_scope, server) = session(Some(true), Some(fake)).await;
    let ack = send(&server, "startSavedWorkflow", json!({"name": "digest"})).await;
    assert_eq!(ack["reasonCode"], unsupported(), "{ack}");
}

#[tokio::test]
async fn a_run_service_fault_is_a_start_failure_with_its_message() {
    let fake = Arc::new(Fake::default());
    *fake.start_error.lock().expect("fake") =
        Some(DynamicWorkflowRunError::new("the journal is closed"));
    let (_scope, server) = session(Some(true), Some(fake)).await;
    let ack = send(&server, "startSavedWorkflow", json!({"name": "digest"})).await;
    assert_eq!(ack["status"], json!("failed"), "{ack}");
    assert_eq!(
        ack["reasonCode"],
        json!("fault.command.savedWorkflowStartRejected.start_failed")
    );
    assert_eq!(ack["message"], json!("the journal is closed"));
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
async fn an_accepted_start_activates_the_parent_through_the_sink() {
    let fake = Arc::new(Fake {
        drive_sink: true,
        ..Fake::default()
    });
    *fake.start_answer.lock().expect("fake") = Some(StartSavedOutcome::Started {
        run_id: WorkflowRunId::new("dwfrun-1"),
        tool_call_id: "launch-1".to_owned(),
    });
    let (_scope, server) = session(Some(true), Some(fake)).await;
    assert!(!server.dynamic_workflow_activated(&SessionId::new("s1")));
    let ack = send(&server, "startSavedWorkflow", json!({"name": "digest"})).await;
    assert_eq!(ack["status"], json!("accepted"), "{ack}");
    assert!(
        server.dynamic_workflow_activated(&SessionId::new("s1")),
        "the sink activated the parent's workflow tools"
    );
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

/// The session `s1` of [`session`], with the kernel the test can reach (to make its actor busy or unable to answer).
async fn session_over_kernel(
    enabled: Option<bool>,
    fake: Option<Arc<Fake>>,
) -> (
    rust_cli_base::TaskScope,
    Arc<crate::server::Server>,
    Arc<crate::fork::legacy_session::tests::TestKernel>,
) {
    let (scope, server, kernel) = server();
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
    (scope, server, kernel)
}

/// W9b-1 (9.54, divergence 765): a start on a session whose actor reports a running turn is refused as busy, and the run
/// service is not asked.
#[tokio::test]
async fn a_start_on_a_session_with_a_turn_running_is_refused_as_session_busy() {
    let fake = Arc::new(Fake::default());
    let (_scope, server, kernel) = session_over_kernel(Some(true), Some(fake.clone())).await;
    crate::fork::legacy_session::tests::set_session_running(&kernel, "s1");
    let ack = send(&server, "startSavedWorkflow", json!({"name": "digest"})).await;
    assert_eq!(ack["status"], json!("failed"), "{ack}");
    assert_eq!(
        ack["reasonCode"],
        json!("fault.command.savedWorkflowStartRejected.session_busy")
    );
    assert_eq!(
        ack["message"],
        json!("the session has work in flight or its busy state is unknown")
    );
    assert!(fake.starts.lock().expect("fake").is_empty());
}

/// W9b-1 (9.54, divergence 803): a start on a session whose actor cannot answer is refused with the same reason code and
/// message as a busy session, and the run service is not asked.
#[tokio::test]
async fn a_start_on_a_session_whose_actor_cannot_answer_is_refused_as_session_busy() {
    let fake = Arc::new(Fake::default());
    let (_scope, server, kernel) = session_over_kernel(Some(true), Some(fake.clone())).await;
    crate::fork::legacy_session::tests::make_session_blind(&kernel, "s1");
    let ack = send(&server, "startSavedWorkflow", json!({"name": "digest"})).await;
    assert_eq!(ack["status"], json!("failed"), "{ack}");
    assert_eq!(
        ack["reasonCode"],
        json!("fault.command.savedWorkflowStartRejected.session_busy")
    );
    assert_eq!(
        ack["message"],
        json!("the session has work in flight or its busy state is unknown")
    );
    assert!(fake.starts.lock().expect("fake").is_empty());
}

#[tokio::test]
async fn a_start_payload_that_is_not_strict_is_an_invalid_payload_and_the_run_service_is_not_asked()
{
    let fake = Arc::new(Fake::default());
    let (_scope, server) = session(Some(true), Some(fake.clone())).await;
    for (index, bad) in [
        json!({"name": ""}),
        json!({"name": "digest", "extra": 1}),
        json!({"name": "digest", "scope": "Project"}),
        json!({"name": "digest", "scope": null}),
        json!({"name": "digest", "args": null}),
        json!({"name": "digest", "args": ["x"]}),
    ]
    .into_iter()
    .enumerate()
    {
        let ack = send_as(
            &server,
            &format!("bad-{index}"),
            "startSavedWorkflow",
            bad.clone(),
        )
        .await;
        assert_eq!(ack["status"], json!("rejected"), "{bad} -> {ack}");
        assert_eq!(ack["reasonCode"], json!("proto.invalidPayload"), "{bad}");
    }
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
async fn an_in_place_retune_answers_without_a_successor_field() {
    let fake = Arc::new(Fake::default());
    *fake.amend_answer.lock().expect("fake") = Some(SettingsOutcome::Retuned {
        run_id: WorkflowRunId::new("dwfrun-1"),
        tool_call_id: "settings-1".to_owned(),
    });
    let (_scope, server) = session(Some(true), Some(fake)).await;
    let ack = send(
        &server,
        "amendWorkflowRunSettings",
        json!({"workId": "dwfrun-1", "maxConcurrency": 3}),
    )
    .await;
    assert_eq!(ack["status"], json!("accepted"), "{ack}");
    assert_eq!(
        ack["result"],
        json!({"type": "amendWorkflowRunSettings", "runId": "dwfrun-1", "toolCallId": "settings-1"})
    );
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

#[tokio::test]
async fn a_settings_change_with_a_misspelt_key_is_an_invalid_payload() {
    let fake = Arc::new(Fake::default());
    let (_scope, server) = session(Some(true), Some(fake.clone())).await;
    let ack = send(
        &server,
        "amendWorkflowRunSettings",
        json!({"workId": "dwfrun-1", "maxConcurrenccy": 3}),
    )
    .await;
    assert_eq!(ack["status"], json!("rejected"), "{ack}");
    assert_eq!(ack["reasonCode"], json!("proto.invalidPayload"));
    assert!(fake.amends.lock().expect("fake").is_empty());
}

#[tokio::test]
async fn a_settings_run_service_fault_is_a_start_failed_refusal_with_its_message() {
    let fake = Arc::new(Fake::default());
    *fake.amend_error.lock().expect("fake") = Some(DynamicWorkflowRunError::new(
        "the successor could not start",
    ));
    let (_scope, server) = session(Some(true), Some(fake)).await;
    let ack = send(
        &server,
        "amendWorkflowRunSettings",
        json!({"workId": "dwfrun-1", "maxConcurrency": 3}),
    )
    .await;
    assert_eq!(
        ack["reasonCode"],
        json!("fault.command.workflowRunSettingsRejected.start_failed"),
        "{ack}"
    );
    assert_eq!(ack["message"], json!("the successor could not start"));
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
        json!({"workId": "dwfrun-1", "other": 1}),
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
    // 9.65 (918): a stored script that no longer compiles is Node's `compile_failed`, with its diagnostics.
    assert_eq!(
        settings_refusal_code(&SettingsRefusal::CompileFailed {
            message: "The stored script of run r has errors:".to_owned()
        }),
        (
            "compile_failed",
            Some("The stored script of run r has errors:".to_owned())
        )
    );
    let (code, message) = settings_refusal_code(&SettingsRefusal::ModelUnavailable {
        message: Some("the resolver's message".to_owned()),
    });
    assert_eq!(
        (code, message.as_deref()),
        ("model_unavailable", Some("the resolver's message"))
    );
}

/// 9.65 (closes 921): Node's shape. A refusal Node sends without a message (`model_unavailable` with no catalog, and the
/// reasons that never carry one) has none, so the ack's message is Node's `V4WorkflowRunSettingsRejectedError`
/// fallback, `workflow run settings rejected: <reason>`.
#[test]
fn a_settings_refusal_without_a_message_acks_with_nodes_fallback_text() {
    for refusal in [
        SettingsRefusal::ModelUnavailable { message: None },
        SettingsRefusal::NotFound,
        SettingsRefusal::NotConfigurable,
        SettingsRefusal::Unchanged,
        SettingsRefusal::ScriptMissing,
        SettingsRefusal::MissingBoundaries,
    ] {
        let (reason, message) = settings_refusal_code(&refusal);
        assert_eq!(message, None, "{refusal:?}");
        assert_eq!(
            settings_ack_message(reason, message),
            format!("workflow run settings rejected: {reason}")
        );
    }
    assert_eq!(
        settings_ack_message("start_failed", Some("boom".to_owned())),
        "boom"
    );
}

/// The sink's records reach the session in arrival order, each with its source, and are taken once.
mod deliver {
    use std::sync::Mutex;

    use rust_cli_kernel_api::session_api::{Ack as KernelAck, Command, CommandResult};
    use rust_cli_kernel_api::workflow_run::{
        LaunchTurn, SettingsAmend, SettingsTurn, WorkflowRecordSource, WorkflowTurnSink,
    };

    use crate::fork::workflow_run_commands::ParentTurns;

    /// A `ParentTurns` over its own gates, with its records queued the way the run service queues them.
    fn parent() -> ParentTurns {
        ParentTurns::for_test()
    }

    fn settings(text: &str) -> SettingsTurn {
        SettingsTurn {
            text: text.to_owned(),
            run_id: rust_cli_kernel_api::ids::WorkflowRunId::new("dwfrun-2"),
            tool_call_id: "settings-2".to_owned(),
            name: None,
            title_input: "dwfrun-2".to_owned(),
            display: None,
            amend: SettingsAmend {
                predecessor_run_id: None,
                subagent_model: None,
                max_concurrency: None,
                default_concurrency: 6.0,
            },
        }
    }

    fn launch(text: &str) -> LaunchTurn {
        LaunchTurn {
            text: text.to_owned(),
            run_id: rust_cli_kernel_api::ids::WorkflowRunId::new("dwfrun-1"),
            tool_call_id: "launch-1".to_owned(),
            name: "digest".to_owned(),
            scope: "project".to_owned(),
            path: "/work/.zcode/workflows/digest.ts".to_owned(),
            args: None,
            description: "Daily digest".to_owned(),
            display: Some(
                serde_json::json!({"kind": "create_workflow", "causalityGraph": {"steps": []}}),
            ),
            script: "return 1".to_owned(),
        }
    }

    /// 9.65 (closes 916): a hub launch's record carries Node's `workflowLaunch` metadata (`boundWorkflowLaunchMeta`),
    /// so the desktop draws the launch card with its graph and script.
    #[tokio::test]
    async fn a_launch_record_carries_nodes_workflow_launch_metadata() {
        let turns = parent();
        turns.launch_turn(launch("started"));
        let metas: Mutex<Vec<Option<serde_json::Value>>> = Mutex::new(Vec::new());
        turns
            .deliver_with(|_id, command| {
                let Command::RecordWorkflowTurn { meta, .. } = command else {
                    panic!("only the records are sent: {command:?}");
                };
                metas.lock().unwrap().push(meta);
                std::future::ready(accepted())
            })
            .await;
        assert_eq!(
            *metas.lock().unwrap(),
            vec![Some(serde_json::json!({
                "runId": "dwfrun-1",
                "toolCallId": "launch-1",
                "name": "digest",
                "scope": "project",
                "path": "/work/.zcode/workflows/digest.ts",
                "description": "Daily digest",
                "display": {"kind": "create_workflow", "causalityGraph": {"steps": []}},
                "script": "return 1",
            }))]
        );
    }

    /// 9.65 (916): Node's bounds. Arguments over 4096 bytes of JSON become a note, a description over 500 chars is cut
    /// with `…`, and a script over 256000 chars is left out.
    #[test]
    fn the_launch_metadata_is_bounded_as_node_bounds_it() {
        let mut turn = launch("started");
        let mut args = serde_json::Map::new();
        args.insert("blob".to_owned(), serde_json::json!("x".repeat(5_000)));
        let bytes = serde_json::to_string(&args).unwrap().len();
        turn.args = Some(args);
        turn.description = "d".repeat(600);
        turn.script = "s".repeat(256_001);
        let meta = turn.workflow_launch_meta();
        assert_eq!(
            meta["args"],
            serde_json::json!({"…": format!("arguments omitted ({bytes} bytes)")})
        );
        let description = meta["description"].as_str().unwrap();
        assert_eq!(description.chars().count(), 500);
        assert!(description.ends_with('…'));
        assert!(meta.get("script").is_none());
        let mut small = launch("started");
        small.args = Some(serde_json::Map::from_iter([(
            "topic".to_owned(),
            serde_json::json!("rust"),
        )]));
        assert_eq!(
            small.workflow_launch_meta()["args"],
            serde_json::json!({"topic": "rust"})
        );
    }

    fn accepted() -> KernelAck {
        KernelAck::Accepted {
            result: CommandResult::Done,
        }
    }

    use rust_cli_kernel_api::ids::SessionId;
    use rust_cli_kernel_api::metering::{
        ActivityQuery, ActivityStats, RequestStats, SessionMetering,
    };
    use rust_cli_kernel_api::store::{Admission, FrontendRecord, StoreError, StoreQueries};
    use std::sync::Arc;

    /// A store whose input admission writes `title`, or fails as a full disk would.
    struct AdmittingStore {
        title: Option<String>,
        fail: bool,
        inputs: Mutex<Vec<String>>,
    }

    fn double<T>() -> Result<T, StoreError> {
        Err(StoreError::Unsupported {
            what: "test double".to_owned(),
        })
    }

    #[async_trait::async_trait]
    impl StoreQueries for AdmittingStore {
        async fn metering(&self, _session: &SessionId) -> Result<SessionMetering, StoreError> {
            double()
        }

        async fn request_stats(&self, _session: &SessionId) -> Result<RequestStats, StoreError> {
            double()
        }

        async fn activity(&self, _query: ActivityQuery) -> Result<ActivityStats, StoreError> {
            double()
        }

        async fn put_record(
            &self,
            _session: &SessionId,
            _record: &FrontendRecord,
        ) -> Result<(), StoreError> {
            double()
        }

        async fn records(
            &self,
            _session: &SessionId,
            _kind: &str,
        ) -> Result<Vec<FrontendRecord>, StoreError> {
            Ok(Vec::new())
        }

        async fn persist_for_input(
            &self,
            _session: &SessionId,
            input: &str,
        ) -> Result<Admission, StoreError> {
            self.inputs.lock().unwrap().push(input.to_owned());
            if self.fail {
                return Err(StoreError::Storage {
                    message: "database or disk is full: /home/u/.zcode/cli/db/db.sqlite".to_owned(),
                });
            }
            Ok(Admission {
                persisted: true,
                title: self.title.clone(),
            })
        }
    }

    /// Node `ensureSessionPersisted(name)` (W9h, 9.64; closes 766): the hub start persists the parent with the workflow's
    /// name, and the title the store wrote reaches the session before the launch record, as `admit_input` sends it.
    #[tokio::test]
    async fn the_title_the_persistence_wrote_is_adopted_before_the_records() {
        let store = Arc::new(AdmittingStore {
            title: Some("digest".to_owned()),
            fail: false,
            inputs: Mutex::new(Vec::new()),
        });
        let turns = ParentTurns::for_test_with(store.clone());
        turns.persist_parent("digest").await.expect("persisted");
        turns.launch_turn(launch("started"));
        let sent: Mutex<Vec<String>> = Mutex::new(Vec::new());
        turns
            .deliver_with(|_id, command| {
                sent.lock().unwrap().push(match command {
                    Command::AdoptTitle { title } => format!("title:{title}"),
                    Command::RecordWorkflowTurn { text, .. } => format!("record:{text}"),
                    other => panic!("unexpected command: {other:?}"),
                });
                std::future::ready(accepted())
            })
            .await;
        assert_eq!(*store.inputs.lock().unwrap(), vec!["digest".to_owned()]);
        assert_eq!(
            *sent.lock().unwrap(),
            vec!["title:digest".to_owned(), "record:started".to_owned()]
        );
    }

    /// A persistence failure refuses the start with a text that names no storage detail.
    #[tokio::test]
    async fn a_failed_persistence_names_no_storage_detail() {
        let turns = ParentTurns::for_test_with(Arc::new(AdmittingStore {
            title: None,
            fail: true,
            inputs: Mutex::new(Vec::new()),
        }));
        let message = turns.persist_parent("digest").await.expect_err("refused");
        assert!(!message.contains("db.sqlite"), "{message}");
        assert!(message.contains("persisting the session"), "{message}");
    }

    #[tokio::test]
    async fn the_records_are_sent_in_arrival_order_with_their_sources_and_taken_once() {
        let turns = parent();
        turns.launch_turn(launch("started"));
        turns.settings_turn(settings("changed"));
        let sent: Mutex<Vec<(WorkflowRecordSource, String)>> = Mutex::new(Vec::new());
        turns
            .deliver_with(|_id, command| {
                let Command::RecordWorkflowTurn { text, source, .. } = command else {
                    panic!("only the records are sent: {command:?}");
                };
                sent.lock().unwrap().push((source, text));
                std::future::ready(accepted())
            })
            .await;
        assert_eq!(
            *sent.lock().unwrap(),
            vec![
                (WorkflowRecordSource::Launch, "started".to_owned()),
                (WorkflowRecordSource::Settings, "changed".to_owned()),
            ]
        );
        // A second delivery finds nothing left.
        turns
            .deliver_with(|_id, _command| -> std::future::Ready<KernelAck> {
                panic!("the records are taken once")
            })
            .await;
    }

    #[tokio::test]
    async fn a_record_the_session_refuses_is_logged_and_the_rest_still_go_out() {
        let turns = parent();
        turns.launch_turn(launch("first"));
        turns.launch_turn(launch("second"));
        let calls = Mutex::new(0usize);
        turns
            .deliver_with(|_id, _command| {
                let mut calls = calls.lock().unwrap();
                *calls += 1;
                let answer = if *calls == 1 {
                    KernelAck::Rejected {
                        reason: "the session is closed".to_owned(),
                    }
                } else {
                    accepted()
                };
                std::future::ready(answer)
            })
            .await;
        assert_eq!(
            *calls.lock().unwrap(),
            2,
            "the refusal does not stop the batch"
        );
    }

    #[tokio::test]
    async fn a_record_offered_after_the_delivery_is_dropped_not_sent() {
        let turns = parent();
        turns
            .deliver_with(|_id, _command| -> std::future::Ready<KernelAck> {
                panic!("nothing is queued")
            })
            .await;
        turns.launch_turn(launch("too late"));
        turns
            .deliver_with(|_id, _command| -> std::future::Ready<KernelAck> {
                panic!("a late record is never sent")
            })
            .await;
    }
}

/// W9b-1 (9.54, divergence 765): the start's busy decision is the session actor's answer (which counts its jobs), not the
/// protocol projection. The projection is updated only when the pump applies events, so it can miss an input the actor
/// already accepted; `busy_from` takes the actor's answer and nothing from the projection.
mod busy_decision {
    use super::super::busy_from;

    #[test]
    fn an_actor_that_is_busy_refuses_the_start_whatever_the_projection_says() {
        assert!(busy_from(Some(true), false));
    }

    #[test]
    fn an_idle_actor_with_nothing_preparing_is_free_to_start() {
        assert!(!busy_from(Some(false), false));
    }

    #[test]
    fn a_first_submission_still_preparing_is_busy_even_when_the_actor_is_idle() {
        assert!(busy_from(Some(false), true));
    }

    #[test]
    fn an_answer_the_actor_cannot_give_is_busy_so_the_start_fails_closed() {
        assert!(busy_from(None, false));
    }
}

// Fork (W9h, 9.64): the GUI Resume on a stopped run card (desktop E2E DWU-01). Node `resumeWorkflowRun`
// (`interaction-background.ts`): success is a plain accepted ack, a refusal is a `failed` ack with
// `fault.command.workflowRunResumeRejected.<reason>` and the port's message.

#[tokio::test]
async fn a_gui_resume_asks_the_run_service_and_is_accepted() {
    let fake = Arc::new(Fake::default());
    *fake.resume_answer.lock().expect("fake") =
        Some(json!({"ok": true, "runId": "run-1", "toolCallId": "tc-1"}));
    let (_scope, server) = session(Some(true), Some(fake.clone())).await;
    let ack = send(
        &server,
        "resumeWorkflowRun",
        json!({"workId": "run-1", "name": "digest"}),
    )
    .await;
    assert_eq!(ack["status"], json!("accepted"), "{ack}");
    assert_eq!(
        *fake.resumes.lock().expect("fake"),
        vec!["run-1".to_owned()]
    );
}

#[tokio::test]
async fn a_refused_gui_resume_carries_the_reason_code_and_the_message() {
    let fake = Arc::new(Fake::default());
    *fake.resume_answer.lock().expect("fake") = Some(json!({
        "ok": false, "reason": "compile_failed", "message": "line 3: oops",
    }));
    let (_scope, server) = session(Some(true), Some(fake)).await;
    let ack = send(&server, "resumeWorkflowRun", json!({"workId": "run-1"})).await;
    assert_eq!(ack["status"], json!("failed"), "{ack}");
    assert_eq!(
        ack["reasonCode"],
        json!("fault.command.workflowRunResumeRejected.compile_failed")
    );
    assert_eq!(ack["message"], json!("line 3: oops"));
}

#[tokio::test]
async fn a_gui_resume_with_the_gate_closed_answers_as_a_missing_capability() {
    let fake = Arc::new(Fake::default());
    let (_scope, server) = session(Some(false), Some(fake.clone())).await;
    let ack = send(&server, "resumeWorkflowRun", json!({"workId": "run-1"})).await;
    assert_eq!(ack["reasonCode"], unsupported(), "{ack}");
    assert!(fake.resumes.lock().expect("fake").is_empty());
}

#[tokio::test]
async fn a_gui_resume_without_a_work_id_is_an_invalid_payload() {
    let fake = Arc::new(Fake::default());
    let (_scope, server) = session(Some(true), Some(fake.clone())).await;
    let ack = send(&server, "resumeWorkflowRun", json!({"name": "digest"})).await;
    assert_eq!(ack["status"], json!("rejected"), "{ack}");
    assert_eq!(ack["reasonCode"], json!("proto.invalidPayload"));
    assert!(fake.resumes.lock().expect("fake").is_empty());
}

#[tokio::test]
async fn a_failed_gui_resume_answers_as_an_execution_failure() {
    let fake = Arc::new(Fake::default());
    *fake.resume_error.lock().expect("fake") = Some(DynamicWorkflowRunError::new(
        "the run has no working directory",
    ));
    let (_scope, server) = session(Some(true), Some(fake)).await;
    let ack = send(&server, "resumeWorkflowRun", json!({"workId": "run-1"})).await;
    assert_eq!(ack["status"], json!("failed"), "{ack}");
    assert_eq!(ack["reasonCode"], json!("fault.command.executionFailed"));
    assert_eq!(ack["message"], json!("the run has no working directory"));
}
