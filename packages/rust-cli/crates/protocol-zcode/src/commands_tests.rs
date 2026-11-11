use super::*;

#[test]
fn a_guide_steers_only_into_a_running_turn() {
    let guide = Some(Requested::Guide);
    assert_eq!(
        admission(guide, Followup::Queue, Phase::Running, true, false),
        (Delivery::Steer, "guide")
    );
    assert_eq!(
        admission(None, Followup::Guide, Phase::Running, true, false),
        (Delivery::Steer, "guide")
    );
    // A session job without a turn (the goal completion verifier): a future queue item, like Node.
    assert_eq!(
        admission(guide, Followup::Queue, Phase::Running, false, false),
        (Delivery::Queue, "queue")
    );
    assert_eq!(
        admission(None, Followup::Guide, Phase::Running, false, false),
        (Delivery::Queue, "queue")
    );
}

#[test]
fn attachments_queue_and_an_idle_session_starts_now() {
    assert_eq!(
        admission(
            Some(Requested::Guide),
            Followup::Guide,
            Phase::Running,
            true,
            true
        ),
        (Delivery::Queue, "queue")
    );
    assert_eq!(
        admission(None, Followup::Queue, Phase::Running, true, false),
        (Delivery::Queue, "queue")
    );
    assert_eq!(
        admission(
            Some(Requested::Guide),
            Followup::Guide,
            Phase::CompletedSuccess,
            false,
            false
        ),
        (Delivery::Queue, "startNow")
    );
}

#[test]
fn only_an_explicit_start_now_preempts_a_running_turn() {
    let envelope = |payload: serde_json::Value| -> Envelope {
        serde_json::from_value(json!({
            "commandId": "c1",
            "clientId": "desktop",
            "sessionId": "s1",
            "type": "sendText",
            "payload": payload,
        }))
        .unwrap()
    };
    assert!(requests_start_now(&envelope(
        json!({"text": "now", "requestedDelivery": "startNow"})
    )));
    assert!(!requests_start_now(&envelope(
        json!({"text": "later", "requestedDelivery": "queue"})
    )));
    assert!(!requests_start_now(&envelope(json!({"text": "plain"}))));
}

/// Fork: each field of an input's execution state overrides the session's own (Node `resolveExecutionState`): a plan
/// switch without a mode turns plan on in the session's mode, so a plan-mode first input never runs with defaults.
#[test]
fn a_plan_switch_without_a_mode_keeps_the_session_mode() {
    let input: Input =
        serde_json::from_value(serde_json::json!({"text": "x", "planEnabled": true})).unwrap();
    let mut view = rust_cli_kernel_api::session_api::SessionView::new(
        rust_cli_kernel_api::store::SessionMeta {
            id: SessionId::new("s1"),
            kind: rust_cli_kernel_api::store::SessionKind::Interactive,
            parent: None,
            workspace: rust_cli_kernel_api::env::WorkspaceRef {
                environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
                root: rust_cli_kernel_api::env::EnvPath::new("/w"),
            },
            title: String::new(),
            trace: rust_cli_kernel_api::ids::TraceId::new("trace"),
            created_at_ms: 1000,
        },
        Vec::new(),
        rust_cli_kernel_api::testing::selection(),
        PermissionMode::AcceptEdits,
    );
    view.plan = false;
    let execution = input_execution(&input, Some(&view)).unwrap();
    assert_eq!(execution.state.mode, PermissionMode::AcceptEdits);
    assert!(execution.state.plan);
    let plain: Input = serde_json::from_value(serde_json::json!({"text": "x"})).unwrap();
    assert!(input_execution(&plain, Some(&view)).is_none());
}
