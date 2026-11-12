use super::*;
use rust_cli_kernel_api::permission::PermissionMode;

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

/// Fork: the incognito profile on createSession is strict, and cannot ride on a worktree reservation.
#[test]
fn an_incognito_profile_is_parsed_strictly() {
    let profile = json!({
        "projectInstructions": false, "skills": false, "hooks": false, "plugins": false, "mcp": true,
        "customAgents": false, "memory": false, "outputStyle": false, "systemPromptOverrides": false,
        "identity": false, "harness": false, "environment": false, "automationTools": false,
    });
    let parse = |payload: serde_json::Value| {
        let envelope = Envelope {
            command_id: "c1".to_owned(),
            client_id: "client".to_owned(),
            session_id: None,
            base_revision: None,
            kind: "createSession".to_owned(),
            payload: payload.clone(),
            input_origin: None,
        };
        let parsed: CreateSessionPayload = serde_json::from_value(payload).unwrap();
        incognito_of(&envelope, &parsed).map_err(|ack| ack.reason_code.clone())
    };
    assert_eq!(parse(json!({"workspaceId": "/w"})), Ok(None));
    assert_eq!(
        parse(json!({"workspaceId": "/w", "incognito": profile})),
        Ok(Some(IncognitoProfile {
            mcp: true,
            ..IncognitoProfile::LOCKDOWN
        }))
    );
    let mut versioned = profile.clone();
    versioned["version"] = json!(1);
    let invalid = Err(Some("proto.invalidPayload".to_owned()));
    assert_eq!(
        parse(json!({"workspaceId": "/w", "incognito": versioned})),
        invalid
    );
    assert_eq!(
        parse(
            json!({"workspaceId": "/w", "incognito": profile, "worktreePreparation": {"branchName": "b", "targetPath": "/t"}})
        ),
        invalid
    );
    // Node's `.optional()` refuses an explicit null; it must not create a normal session.
    assert_eq!(
        parse(json!({"workspaceId": "/w", "incognito": null})),
        invalid
    );
}

/// Fork: queries over a store whose only session `s1` is soft-deleted (Node `getSession` still returns the row).
struct DeletedRow(rust_cli_kernel_api::testing::MemoryStore);

#[async_trait::async_trait]
impl rust_cli_kernel_api::store::StoreQueries for DeletedRow {
    async fn metering(
        &self,
        session: &SessionId,
    ) -> Result<
        rust_cli_kernel_api::metering::SessionMetering,
        rust_cli_kernel_api::store::StoreError,
    > {
        self.0.metering(session).await
    }

    async fn request_stats(
        &self,
        session: &SessionId,
    ) -> Result<rust_cli_kernel_api::metering::RequestStats, rust_cli_kernel_api::store::StoreError>
    {
        self.0.request_stats(session).await
    }

    async fn activity(
        &self,
        query: rust_cli_kernel_api::metering::ActivityQuery,
    ) -> Result<rust_cli_kernel_api::metering::ActivityStats, rust_cli_kernel_api::store::StoreError>
    {
        self.0.activity(query).await
    }

    async fn put_record(
        &self,
        session: &SessionId,
        record: &rust_cli_kernel_api::store::FrontendRecord,
    ) -> Result<(), rust_cli_kernel_api::store::StoreError> {
        self.0.put_record(session, record).await
    }

    async fn records(
        &self,
        session: &SessionId,
        kind: &str,
    ) -> Result<
        Vec<rust_cli_kernel_api::store::FrontendRecord>,
        rust_cli_kernel_api::store::StoreError,
    > {
        self.0.records(session, kind).await
    }

    async fn reconcile_row(
        &self,
        session: &SessionId,
    ) -> Result<Option<serde_json::Value>, rust_cli_kernel_api::store::StoreError> {
        Ok((session.as_str() == "s1")
            .then(|| json!({"directory": "/w", "title": "kept", "timeDeleted": 4000})))
    }
}

/// Fork: a kernel where `s1` reads as not found (soft-deleted) and every create is recorded.
#[derive(Default)]
struct DeletedKernel {
    creates: std::sync::Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl rust_cli_kernel_api::session_api::Kernel for DeletedKernel {
    fn queries(&self) -> std::sync::Arc<dyn rust_cli_kernel_api::store::StoreQueries> {
        std::sync::Arc::new(DeletedRow(
            rust_cli_kernel_api::testing::MemoryStore::default(),
        ))
    }

    async fn create_session(
        &self,
        request: rust_cli_kernel_api::session_api::CreateSession,
    ) -> Result<SessionId, rust_cli_kernel_api::session_api::KernelError> {
        let id = request.id.unwrap_or_else(|| SessionId::new("generated"));
        self.creates.lock().unwrap().push(id.as_str().to_owned());
        Ok(id)
    }

    async fn open_session(
        &self,
        session: &SessionId,
    ) -> Result<
        std::sync::Arc<dyn rust_cli_kernel_api::session_api::SessionHandle>,
        rust_cli_kernel_api::session_api::KernelError,
    > {
        Err(rust_cli_kernel_api::session_api::KernelError::NotFound {
            session: session.clone(),
        })
    }

    async fn session_snapshot(
        &self,
        session: &SessionId,
    ) -> Result<
        rust_cli_kernel_api::session_api::SessionView,
        rust_cli_kernel_api::session_api::KernelError,
    > {
        Err(rust_cli_kernel_api::session_api::KernelError::NotFound {
            session: session.clone(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: rust_cli_kernel_api::store::SessionFilter,
    ) -> Result<
        Vec<rust_cli_kernel_api::store::SessionSummary>,
        rust_cli_kernel_api::session_api::KernelError,
    > {
        Ok(Vec::new())
    }
}

/// Fork (specs/fork-rust-agent-parity.md, "Incognito sessions"): a soft-deleted id is refused before any write, by a
/// plain create and by a reservation, like Node; before, it read as free and the kernel create upserted over the row.
#[tokio::test]
async fn a_soft_deleted_id_is_refused_before_any_write() {
    let scope = rust_cli_base::TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = rust_cli_protocol_core::connection::start(
        out,
        &scope.spawner(),
        rust_cli_protocol_core::connection::Options::default(),
    );
    let context = std::sync::Arc::new(crate::context::Context::new(
        peer,
        std::sync::Arc::new(rust_cli_kernel_api::testing::FixedClock(5)),
    ));
    let kernel = std::sync::Arc::new(DeletedKernel::default());
    let server = Server::new(
        context,
        kernel.clone(),
        scope.spawner(),
        crate::server::Defaults {
            selection: rust_cli_kernel_api::testing::selection(),
            mode: rust_cli_kernel_api::permission::PermissionMode::Default,
            environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
        },
    );
    let create = |payload: serde_json::Value| Envelope {
        command_id: "c1".to_owned(),
        client_id: "client".to_owned(),
        session_id: None,
        base_revision: None,
        kind: "createSession".to_owned(),
        payload,
        input_origin: None,
    };
    let plain = create_session(
        &server,
        &create(json!({"workspaceId": "/w", "sessionId": "s1"})),
    )
    .await;
    assert_eq!(plain.status, Status::Rejected);
    assert_eq!(plain.reason_code.as_deref(), Some("proto.invalidPayload"));
    let reserved = create_session(
        &server,
        &create(json!({
            "workspaceId": "/w",
            "sessionId": "s1",
            "submissionPreparation": {"submissionId": "sub-1"},
        })),
    )
    .await;
    assert_eq!(reserved.status, Status::Rejected);
    assert_eq!(
        reserved.reason_code.as_deref(),
        Some("proto.invalidPayload")
    );
    assert!(kernel.creates.lock().unwrap().is_empty());
    // A free id still reaches the kernel create (the double cannot open the session afterwards).
    create_session(
        &server,
        &create(json!({"workspaceId": "/w", "sessionId": "s2"})),
    )
    .await;
    assert_eq!(*kernel.creates.lock().unwrap(), ["s2"]);
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
            incognito: None,
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
