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

/// Fork: Node `resolveExecutionState(input, current)` (`packages/shared/src/execution-state.ts`) case by case.
#[test]
fn execution_state_resolves_like_node() {
    use rust_cli_kernel_api::permission::ExecutionState;
    let state = |mode, plan| ExecutionState { mode, plan };
    let current = state(PermissionMode::AcceptEdits, true);
    let cases: [(Option<&str>, Option<bool>, Option<ExecutionState>); 8] = [
        (None, None, None),
        (Some("unknown"), None, None),
        // The legacy plan is no mode: the current mode stays, plan turns on unless planEnabled says otherwise.
        (
            Some("plan"),
            None,
            Some(state(PermissionMode::AcceptEdits, true)),
        ),
        (
            Some("plan"),
            Some(false),
            Some(state(PermissionMode::AcceptEdits, false)),
        ),
        // A known mode turns plan off unless planEnabled says otherwise.
        (
            Some("build"),
            None,
            Some(state(PermissionMode::Default, false)),
        ),
        (
            Some("yolo"),
            Some(true),
            Some(state(PermissionMode::BypassPermissions, true)),
        ),
        (
            None,
            Some(false),
            Some(state(PermissionMode::AcceptEdits, false)),
        ),
        (
            Some("unknown"),
            Some(false),
            Some(state(PermissionMode::AcceptEdits, false)),
        ),
    ];
    for (mode, plan, expected) in cases {
        assert_eq!(
            resolve_execution(mode, plan, current),
            expected,
            "{mode:?} {plan:?}"
        );
    }
    // Node's default current (build, plan off): `{mode: "plan"}` alone is build with plan on.
    assert_eq!(
        resolve_execution(Some("plan"), None, ExecutionState::default()),
        Some(state(PermissionMode::Default, true))
    );
}

/// Fork: Node `inputIntentMetadata`: the admitted facts in Node's key order; the quotes as sent (absent stays absent,
/// `[]` stays `[]`); `text` is the typed text, without the quote block (the session composes it after slash
/// expansion and the prompt hook).
#[test]
fn an_app_input_is_admitted_with_nodes_intent() {
    let envelope = |client: &str, origin: Option<&str>| -> Envelope {
        let mut value = json!({
            "commandId": "c1",
            "clientId": client,
            "sessionId": "s1",
            "type": "sendText",
            "payload": {},
        });
        if let Some(origin) = origin {
            value["inputOrigin"] = json!(origin);
        }
        serde_json::from_value(value).unwrap()
    };
    let input: Input = serde_json::from_value(json!({
        "text": "explain this",
        "mode": "default",
        "planEnabled": false,
        "conversationQuotes": [{"text": "E2E selection"}],
        "attachments": [{"kind": "file", "reference": "r1"}],
    }))
    .unwrap();
    let intent = input_intent(
        &envelope("desktop-client", Some("desktop")),
        &input,
        QueuedKind::Text,
        input.conversation_quotes.as_deref(),
        ("queue", "queue"),
        (3, 1500),
    );
    assert_eq!(
        serde_json::to_string(&intent).unwrap(),
        serde_json::to_string(&json!({
            "inputOrigin": "desktop",
            "conversationQuotes": [{"text": "E2E selection"}],
            "sourceCommandId": "c1",
            "queueItemId": "queue_c1",
            "clientId": "desktop-client",
            "kind": "sendText",
            "text": "explain this",
            "mode": "default",
            "planEnabled": false,
            "admissionSeq": 3,
            "admittedAt": 1500,
            "requestedDelivery": "queue",
            "admittedDelivery": "queue",
            "attachmentRefs": [{"kind": "file", "reference": "r1"}],
        }))
        .unwrap()
    );

    let empty: Input =
        serde_json::from_value(json!({"text": "objective", "conversationQuotes": []})).unwrap();
    let goal = input_intent(
        &envelope("", Some("web")),
        &empty,
        QueuedKind::Goal,
        empty.conversation_quotes.as_deref(),
        ("startNow", "startNow"),
        (1, 1),
    );
    assert_eq!(goal.quotes(), Some(Vec::new()));
    assert_eq!(goal.str("kind"), Some("sendGoalCommand"));
    assert_eq!(goal.str("clientId"), Some("cli"));
    assert_eq!(goal.text(), Some("objective"));
    assert!(goal.get("inputOrigin").is_none());

    let plain: Input = serde_json::from_value(json!({"text": "hi"})).unwrap();
    assert_eq!(plain.conversation_quotes, None);
}
