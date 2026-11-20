//! Fork (specs/fork-rust-workflow-engine.md, 9.47, W7-14): the session's workflow gate is rebuilt on every cold open, on the
//! v4 open path as well as the legacy resume, and the on-demand activation is restored with it. Composed through the real
//! open paths (`Server::live`, the create and the Host's fact); a process restart is a new server over the same store.

use std::sync::Arc;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::dynamic_workflow::DynamicWorkflowGate;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::Kernel;
use rust_cli_kernel_api::store::FrontendRecord;
use serde_json::json;

use super::legacy_session::tests::{
    Levels, TestKernel, automation_create, call, server, server_over,
};
use super::workflow_activation::{KIND, entry_key};
use super::workflow_progress::WorkflowNotices;
use super::workflow_reminder_host::{ReminderTimers, WorkflowReminders};
use crate::server::Server;

/// The session's stored row (persisted at once, so its records can be written), made by the create the Host sends.
async fn stored_session(server: &Server, id: &str) -> SessionId {
    let mut params = automation_create(id);
    params["persistence"] = json!("immediate");
    call(server, "session/create", params)
        .await
        .expect("the session is created");
    SessionId::new(id)
}

/// A process restart over the same store: a new server, so an empty gate table and no open session. Every session it opens
/// is a cold open.
fn restarted(kernel: &Arc<TestKernel>) -> (TaskScope, Arc<Server>) {
    let (scope, server) = server_over(kernel.clone());
    server.context.set_models(Arc::new(Levels));
    (scope, server)
}

/// The Host's cached dynamic-workflow fact, as the Host sends it (`workspace/updateDynamicWorkflowPolicy`).
async fn host_fact(server: &Server, enabled: bool, mode: Option<&str>) {
    let mut params = json!({
        "workspace": {"workspacePath": "/w", "workspaceKey": "/w"},
        "enabled": enabled,
    });
    if let Some(mode) = mode {
        params["mode"] = json!(mode);
    }
    call(server, "workspace/updateDynamicWorkflowPolicy", params)
        .await
        .expect("the Host's fact is cached");
}

fn on_demand_open() -> DynamicWorkflowGate {
    DynamicWorkflowGate {
        enabled: true,
        tools_on_demand: true,
    }
}

async fn put_entry(kernel: &TestKernel, session: &SessionId) {
    let record = FrontendRecord {
        kind: KIND.to_owned(),
        key: entry_key(session),
        data: json!({"activated": true, "source": "command"}),
    };
    kernel
        .queries()
        .put_record(session, &record)
        .await
        .expect("stored");
}

#[tokio::test]
async fn a_cold_v4_open_rebuilds_the_gate_from_the_hosts_cached_fact() {
    let (_scope, first, kernel) = server();
    let session = stored_session(&first, "ses_cold_open").await;
    let (_restart, server) = restarted(&kernel);
    assert_eq!(
        server.dynamic_workflow_gate(&session),
        None,
        "a restart leaves no record behind"
    );
    host_fact(&server, true, Some("onDemand")).await;
    server.live(&session).await.expect("the session opens cold");
    assert_eq!(
        server.dynamic_workflow_gate(&session),
        Some(on_demand_open()),
        "the cold open records the gate the Host's fact resolves to, as Node's cold recovery does"
    );
}

#[tokio::test]
async fn a_cold_v4_open_with_the_gate_closed_records_a_closed_gate_and_never_activates() {
    let (_scope, first, kernel) = server();
    let session = stored_session(&first, "ses_cold_closed").await;
    put_entry(&kernel, &session).await;
    let (_restart, server) = restarted(&kernel);
    host_fact(&server, false, None).await;
    server.live(&session).await.expect("the session opens cold");
    assert_eq!(
        server.dynamic_workflow_gate(&session),
        Some(DynamicWorkflowGate {
            enabled: false,
            tools_on_demand: false,
        })
    );
    assert!(!server.dynamic_workflow_activated(&session));
}

#[tokio::test]
async fn a_cold_v4_open_of_an_on_demand_session_activates_from_its_entry_and_leaves_it_alone() {
    let (_scope, first, kernel) = server();
    let session = stored_session(&first, "ses_cold_entry").await;
    put_entry(&kernel, &session).await;
    let (_restart, server) = restarted(&kernel);
    host_fact(&server, true, Some("onDemand")).await;
    server.live(&session).await.expect("the session opens cold");
    assert!(
        server.dynamic_workflow_activated(&session),
        "the cold v4 open restores the activation, as the legacy resume does"
    );
    let rows = kernel
        .queries()
        .records(&session, KIND)
        .await
        .expect("the records read");
    assert_eq!(rows.len(), 1, "the entry is read, not written again");
}

/// A timer that never fires: the close test reads the clock map, not the reminders.
pub(crate) struct QuietTimers;

impl ReminderTimers for QuietTimers {
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

pub(crate) struct SilentNotices;

impl WorkflowNotices for SilentNotices {
    fn post(&self, _parent_session_id: &str, _text: String) {}
}

/// Fork (W7-14, 9.47, finding on PR #603): a submission reservation that is not active yet takes no gate record on its cold
/// open, as a prepared worktree does. Its activation records the gate, past its refusal points (9.2).
#[tokio::test]
async fn a_cold_open_of_a_reserved_submission_takes_no_gate_record_until_its_activation() {
    let (_scope, first, kernel) = server();
    let session = stored_session(&first, "ses_reserved").await;
    crate::preparation::save(
        &first,
        &session,
        &crate::preparation::Marker::preparing("sub-1", 1),
    )
    .await
    .expect("the reservation is stored");
    let (_restart, server) = restarted(&kernel);
    host_fact(&server, true, Some("onDemand")).await;
    server.live(&session).await.expect("the session opens cold");
    assert_eq!(
        server.dynamic_workflow_gate(&session),
        None,
        "a reserved session has no record until its activation records the gate"
    );
}

#[tokio::test]
async fn a_plain_close_stops_the_session_reminder_clock_as_node_does() {
    let (_scope, server, _kernel) = server();
    let session = stored_session(&server, "ses_close_clock").await;
    server.record_dynamic_workflow_gate(&session, on_demand_open());
    let reminders = Arc::new(WorkflowReminders::new(
        server.context.dynamic_workflow_gates().clone(),
        Arc::new(QuietTimers),
        Arc::new(SilentNotices),
    ));
    server.context.set_workflow_reminders(reminders.clone());
    reminders.turn_finished(session.as_str());
    assert!(
        reminders.has_session(session.as_str()),
        "a turn edge makes the session's clock"
    );
    call(
        &server,
        "session/close",
        json!({"sessionId": "ses_close_clock"}),
    )
    .await
    .expect("the session closes");
    assert!(
        !reminders.has_session(session.as_str()),
        "a plain close stops the clock (Node beginShutdown), so no reminder fires for a closed session"
    );
}

/// Divergence 482 (9.44): a create whose first input is the `/workflow` command activates the new session, through the create's
/// own open (the cold open that rebuilds the record runs first, and the activation follows it).
#[tokio::test]
async fn a_create_whose_first_input_is_the_workflow_command_activates_an_on_demand_session() {
    let (_scope, server, kernel) = server();
    let envelope = crate::inbox::Envelope {
        command_id: "cmd_first_wf".to_owned(),
        client_id: "client".to_owned(),
        session_id: Some("ses_first_wf".to_owned()),
        base_revision: None,
        kind: "createSession".to_owned(),
        payload: json!({
            "sessionId": "ses_first_wf",
            "workspace": {"workspacePath": "/w", "workspaceKey": "/w"},
            "mode": "edit",
            "persistence": "immediate",
            "dynamicWorkflowEnabled": true,
            "dynamicWorkflowMode": "onDemand",
            "firstInput": {"text": "/workflow build a report"},
        }),
        input_origin: None,
    };
    let ack = crate::commands::create_session(&server, &envelope).await;
    assert!(
        matches!(ack.status, crate::inbox::Status::Accepted),
        "{ack:?}"
    );
    let session = SessionId::new("ses_first_wf");
    assert!(server.dynamic_workflow_activated(&session));
    let rows = kernel
        .queries()
        .records(&session, KIND)
        .await
        .expect("the records read");
    assert_eq!(
        rows.into_iter().map(|row| row.data).collect::<Vec<_>>(),
        [json!({"activated": true, "source": "command"})],
        "the command writes its entry once"
    );
}

#[tokio::test]
async fn a_create_keeps_the_gate_its_own_params_recorded_through_its_open() {
    let (_scope, server, _kernel) = server();
    // The v4 `createSession` carries the Host's rollout fields (the legacy create does not).
    let envelope = crate::inbox::Envelope {
        command_id: "cmd_create_gate".to_owned(),
        client_id: "client".to_owned(),
        session_id: Some("ses_create_gate".to_owned()),
        base_revision: None,
        kind: "createSession".to_owned(),
        payload: json!({
            "sessionId": "ses_create_gate",
            "workspace": {"workspacePath": "/w", "workspaceKey": "/w"},
            "mode": "edit",
            "persistence": "immediate",
            "dynamicWorkflowEnabled": true,
            "dynamicWorkflowMode": "onDemand",
        }),
        input_origin: None,
    };
    let ack = crate::commands::create_session(&server, &envelope).await;
    assert!(
        matches!(ack.status, crate::inbox::Status::Accepted),
        "{ack:?}"
    );
    assert_eq!(
        server.dynamic_workflow_gate(&SessionId::new("ses_create_gate")),
        Some(on_demand_open()),
        "the create's own open is a cold open and must not replace the record its params made"
    );
}
