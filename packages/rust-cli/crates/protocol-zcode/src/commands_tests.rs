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

/// Fork (specs/fork-rust-automations.md, slice 1 item 4): `automationId` and `toolDisallowlist` ride on the input's
/// execution, so they apply to that turn only, queued or not; the session's state is unchanged.
#[test]
fn an_automation_input_carries_its_turn_limits() {
    let input: Input = serde_json::from_value(serde_json::json!({
        "text": "run", "automationId": " auto_1 ",
        "toolDisallowlist": ["CronCreate", "CronUpdate", "CronDelete"],
    }))
    .unwrap();
    let execution = input_execution(&input, None).expect("limits alone make an execution");
    assert_eq!(execution.state, ExecutionState::default());
    assert_eq!(execution.selection, None);
    assert_eq!(execution.limits.automation.as_deref(), Some("auto_1"));
    assert!(execution.limits.hides("CronCreate"));
    assert!(!execution.limits.hides("CronPauseSelf"));
    let blank: Input =
        serde_json::from_value(serde_json::json!({"text": "x", "automationId": "  "})).unwrap();
    assert!(
        input_execution(&blank, None).is_none(),
        "a blank id is no automation"
    );
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

/// B4 (specs/fork-rust-agent-parity.md): `sendText` and `createSession.firstInput` carry an extension source onto the
/// intent as Node's last key; an input without a source has no key.
/// B4: the stored source uses the schema's key order whatever order the Host sent (zod rebuilds the object).
#[test]
fn a_source_is_stored_in_the_schema_key_order() {
    let envelope: Envelope = serde_json::from_value(json!({
        "commandId": "c2",
        "clientId": "plugin-host",
        "sessionId": "s1",
        "type": "sendText",
        "payload": {},
    }))
    .unwrap();
    let reversed = json!({"pluginId": "p", "kind": "extension"});
    let input: Input = serde_json::from_value(json!({"text": "hi", "source": reversed})).unwrap();
    let intent = input_intent(
        &envelope,
        &input,
        QueuedKind::Text,
        None,
        ("startNow", "startNow"),
        (1, 1),
    );
    assert_eq!(
        serde_json::to_string(intent.get("source").unwrap()).unwrap(),
        r#"{"kind":"extension","pluginId":"p"}"#
    );
    let session = json!({"title": "t", "sessionId": "s", "kind": "session"});
    let input: Input = serde_json::from_value(json!({"text": "hi", "source": session})).unwrap();
    let intent = input_intent(
        &envelope,
        &input,
        QueuedKind::Text,
        None,
        ("startNow", "startNow"),
        (1, 1),
    );
    assert_eq!(
        serde_json::to_string(intent.get("source").unwrap()).unwrap(),
        r#"{"kind":"session","sessionId":"s","title":"t"}"#
    );
}

#[test]
fn an_extension_source_is_copied_onto_the_intent() {
    let source = json!({"kind": "extension", "pluginId": "gitlab@zcode-plugins-example"});
    let envelope: Envelope = serde_json::from_value(json!({
        "commandId": "c1",
        "clientId": "plugin-host",
        "sessionId": "s1",
        "type": "sendText",
        "payload": {},
    }))
    .unwrap();
    let input: Input = serde_json::from_value(json!({"text": "hi", "source": source})).unwrap();
    let intent = input_intent(
        &envelope,
        &input,
        QueuedKind::Text,
        None,
        ("queue", "queue"),
        (3, 1500),
    );
    assert_eq!(
        serde_json::to_string(&intent).unwrap(),
        serde_json::to_string(&json!({
            "sourceCommandId": "c1",
            "queueItemId": "queue_c1",
            "clientId": "plugin-host",
            "kind": "sendText",
            "text": "hi",
            "admissionSeq": 3,
            "admittedAt": 1500,
            "requestedDelivery": "queue",
            "admittedDelivery": "queue",
            "source": source,
        }))
        .unwrap()
    );

    let create: CreateSessionPayload = serde_json::from_value(json!({
        "workspaceId": "/w",
        "firstInput": {"text": "hi", "source": source},
    }))
    .unwrap();
    assert_eq!(
        create.first_input.and_then(|first| first.source),
        Some(source)
    );

    let plain: Input = serde_json::from_value(json!({"text": "hi"})).unwrap();
    let intent = input_intent(
        &envelope,
        &plain,
        QueuedKind::Text,
        None,
        ("queue", "queue"),
        (3, 1500),
    );
    assert!(intent.get("source").is_none());
}

/// B4 (specs/fork-rust-agent-parity.md): `sendGoalCommand` drops the source, valid or not, because Node's goal schema
/// has no `source` (zod strips it). A goal's intent and card carry no extension origin; `sendText` keeps it.
#[test]
fn a_goal_command_never_carries_a_source() {
    let valid = json!({"kind": "extension", "pluginId": "gitlab@zcode-plugins-example"});
    let invalid = json!({"kind": "extension"});
    let envelope: Envelope = serde_json::from_value(json!({
        "commandId": "g1",
        "clientId": "plugin-host",
        "sessionId": "s1",
        "type": "sendGoalCommand",
        "payload": {},
    }))
    .unwrap();
    for source in [valid.clone(), invalid] {
        let input: Input =
            serde_json::from_value(json!({"text": "objective", "source": source})).unwrap();
        let goal = without_goal_source(QueuedKind::Goal, input);
        let intent = input_intent(
            &envelope,
            &goal,
            QueuedKind::Goal,
            None,
            ("startNow", "startNow"),
            (1, 1),
        );
        assert_eq!(intent.str("kind"), Some("sendGoalCommand"));
        assert!(intent.get("source").is_none(), "{intent:?}");
        assert!(intent.fields().get("source").is_none());
    }
    let text: Input = serde_json::from_value(json!({"text": "hi", "source": valid})).unwrap();
    let text = without_goal_source(QueuedKind::Text, text);
    let intent = input_intent(
        &envelope,
        &text,
        QueuedKind::Text,
        None,
        ("startNow", "startNow"),
        (1, 1),
    );
    assert_eq!(intent.get("source"), Some(&valid));
}

/// Node `session-flow.ts` answers a `sendText` from Core's admission in both directions: a started input is
/// `startNow`, a queued one `queue`. The projection's prediction loses in both races: a turn that ended between the
/// snapshot and the submit (predicted `queue` or `guide`, the kernel started it) and a lease or turn that appeared
/// (predicted `startNow`, the kernel queued it). A queued guide stays `guide` (it steers into the running turn).
#[test]
fn the_ack_follows_the_kernels_admission_both_ways() {
    use rust_cli_kernel_api::session_api::{Ack as KernelAck, CommandResult};
    let started = KernelAck::Accepted {
        result: CommandResult::Done,
    };
    let queued = KernelAck::Accepted {
        result: CommandResult::Queued,
    };
    assert_eq!(acked_delivery("queue", &started), "startNow");
    assert_eq!(acked_delivery("guide", &started), "startNow");
    assert_eq!(acked_delivery("startNow", &started), "startNow");
    assert_eq!(acked_delivery("startNow", &queued), "queue");
    assert_eq!(acked_delivery("queue", &queued), "queue");
    assert_eq!(acked_delivery("guide", &queued), "guide");
}

/// A session stub that answers every command with one kernel ACK and records the commands it got.
struct GrantHandle {
    id: rust_cli_kernel_api::ids::SessionId,
    ack: rust_cli_kernel_api::session_api::Ack,
    sent: std::sync::Mutex<Vec<rust_cli_kernel_api::session_api::Command>>,
    /// The asks pending in this session (its view).
    pending: Vec<&'static str>,
}

#[async_trait::async_trait]
impl rust_cli_kernel_api::testing::HandleOverride for GrantHandle {
    fn id(&self) -> &rust_cli_kernel_api::ids::SessionId {
        &self.id
    }

    async fn send(
        &self,
        command: rust_cli_kernel_api::session_api::CommandEnvelope,
    ) -> rust_cli_kernel_api::session_api::Ack {
        self.sent.lock().unwrap().push(command.command);
        self.ack.clone()
    }

    fn subscribe(
        &self,
        _after: Option<u64>,
    ) -> futures_util::stream::BoxStream<'static, rust_cli_kernel_api::session_api::SequencedEvent>
    {
        Box::pin(futures_util::stream::empty())
    }

    async fn view(
        &self,
    ) -> Result<
        rust_cli_kernel_api::session_api::SessionView,
        rust_cli_kernel_api::session_api::KernelError,
    > {
        use rust_cli_kernel_api::ids::{InteractionId, ToolUseId};
        let meta = rust_cli_kernel_api::store::SessionMeta {
            id: self.id.clone(),
            kind: rust_cli_kernel_api::store::SessionKind::Interactive,
            parent: None,
            workspace: rust_cli_kernel_api::env::WorkspaceRef {
                environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
                root: rust_cli_kernel_api::env::EnvPath::new("/w"),
            },
            title: String::new(),
            trace: rust_cli_kernel_api::ids::TraceId::new("trace"),
            created_at_ms: 0,
            incognito: None,
        };
        let mut view = rust_cli_kernel_api::session_api::SessionView::new(
            meta,
            Vec::new(),
            rust_cli_kernel_api::testing::selection(),
            PermissionMode::Default,
        );
        view.pending = self
            .pending
            .iter()
            .map(|id| {
                let request = rust_cli_kernel_api::orchestration::InteractionRequest::Permission {
                    origin: None,
                    tool_use: ToolUseId::new("toolu_1"),
                    tool: "Bash".into(),
                    input: json!({}),
                    message: "ask".into(),
                    suggestions: Vec::new(),
                    rule_seed: None,
                    asked_by: None,
                    machine: Default::default(),
                    once: false,
                    independent: false,
                };
                (InteractionId::new(*id), request)
            })
            .collect();
        Ok(view)
    }
}

/// B3 (Node `resolvePermissionMode` through the gateway): the mode switch options send one
/// `GrantPermissionMode`; a real grant answers `resolvedBy` (the App's recent permission preference reads it); an ask
/// pending nowhere is a late answer, accepted without a result (Node's idempotent miss); an ask pending in another
/// session fails like Node's registry; a refusal is `failed` with `fault.command.executionFailed` and the broker's
/// reason.
#[tokio::test]
async fn a_mode_switch_answer_grants_through_one_command() {
    use rust_cli_kernel_api::session_api::{
        Ack as KernelAck, Command as KernelCommand, CommandResult,
    };
    let envelope: Envelope = serde_json::from_value(json!({
        "commandId": "cmd_1", "clientId": "client_a", "sessionId": "s1", "type": "resolveInteraction",
        "payload": {"interactionId": "int_1", "answer": {"optionId": "allowAndSwitchGuarded"}},
    }))
    .unwrap();
    assert_eq!(
        grant_mode("allowAndSwitchGuarded"),
        Some(PermissionMode::Guarded)
    );
    assert_eq!(
        grant_mode("fullAccess"),
        Some(PermissionMode::BypassPermissions)
    );
    assert_eq!(grant_mode("allowOnce"), None);
    let stub = |id: &str, ack: KernelAck, pending: Vec<&'static str>| GrantHandle {
        id: rust_cli_kernel_api::ids::SessionId::new(id),
        ack,
        sent: Default::default(),
        pending,
    };
    let run_with = |ack: KernelAck, elsewhere: Vec<&'static str>| {
        let envelope = envelope.clone();
        async move {
            let handle = stub("s1", ack.clone(), Vec::new());
            let other: std::sync::Arc<dyn SessionHandle> =
                std::sync::Arc::new(stub("s2", ack, elsewhere));
            let others = move || vec![other];
            let reply = grant(
                &handle,
                others,
                &envelope,
                7,
                "int_1",
                PermissionMode::Guarded,
            )
            .await;
            let sent = handle.sent.into_inner().unwrap();
            assert!(
                matches!(
                    sent.as_slice(),
                    [KernelCommand::GrantPermissionMode { interaction, mode: PermissionMode::Guarded }]
                        if interaction == "int_1"
                ),
                "{sent:?}"
            );
            reply
        }
    };
    let run = |ack: KernelAck| run_with(ack, Vec::new());
    let granted = run(KernelAck::Accepted {
        result: CommandResult::Done,
    })
    .await;
    assert_eq!(granted.status, Status::Accepted);
    assert_eq!(
        granted.result,
        Some(json!({"type": "resolveInteraction",
            "resolvedBy": {"clientId": "client_a", "optionId": "allowAndSwitchGuarded"}}))
    );
    let late = run(KernelAck::Accepted {
        result: CommandResult::NotPending,
    })
    .await;
    assert_eq!(
        (late.status, late.reason_code.as_deref(), late.result),
        (Status::Accepted, None, None)
    );
    let foreign = run_with(
        KernelAck::Accepted {
            result: CommandResult::NotPending,
        },
        vec!["int_1"],
    )
    .await;
    assert_eq!(
        (
            foreign.status,
            foreign.reason_code.as_deref(),
            foreign.message.as_deref()
        ),
        (
            Status::Failed,
            Some("fault.command.executionFailed"),
            Some("Full access is not supported for this interaction")
        )
    );
    let refused = run(KernelAck::Rejected {
        reason: "Already in autonomous mode".to_owned(),
    })
    .await;
    assert_eq!(
        (
            refused.status,
            refused.reason_code.as_deref(),
            refused.message.as_deref()
        ),
        (
            Status::Failed,
            Some("fault.command.executionFailed"),
            Some("Already in autonomous mode")
        )
    );
    assert_eq!(run(KernelAck::Duplicate).await.status, Status::Duplicate);
}

/// #422 review P2-1: `allowAlways` on an ask that offers no always-allow option (a `once` or
/// an independent ask) denies, like Node's broker for an option it did not offer; on a normal ask it remembers the
/// suggestions.
#[test]
fn allow_always_denies_an_ask_that_does_not_offer_it() {
    use rust_cli_kernel_api::interaction::PermissionAnswer;
    use rust_cli_kernel_api::permission::PermissionRule;
    let rule = PermissionRule {
        tool: "Bash".to_owned(),
        content: Some("ls:*".to_owned()),
    };
    let offered = |always: bool| Offered {
        suggestions: vec![rule.clone()],
        always,
    };
    assert_eq!(
        permission_answer(Some("allowAlways"), offered(true), None),
        PermissionAnswer::Allow {
            remember: vec![rule.clone()]
        }
    );
    assert_eq!(
        permission_answer(Some("allowAlways"), offered(false), Some(" no ")),
        PermissionAnswer::Deny {
            feedback: Some("no".to_owned())
        }
    );
    assert_eq!(
        permission_answer(Some("allowOnce"), offered(false), None),
        PermissionAnswer::Allow {
            remember: Vec::new()
        }
    );
}

/// #422 review P2-1: only an ask that is neither `once` nor independent offers always-allow.
#[test]
fn only_a_normal_ask_offers_always_allow() {
    use rust_cli_kernel_api::ids::ToolUseId;
    use rust_cli_kernel_api::orchestration::InteractionRequest;
    let ask = |once: bool, independent: bool| InteractionRequest::Permission {
        origin: None,
        tool_use: ToolUseId::new("toolu_1"),
        tool: "Bash".into(),
        input: json!({}),
        message: "ask".into(),
        suggestions: Vec::new(),
        rule_seed: None,
        asked_by: None,
        machine: Default::default(),
        once,
        independent,
    };
    let always = |request: InteractionRequest| {
        let (offered, tool) = Offered::of(&request).unwrap();
        assert_eq!(tool.as_str(), "toolu_1");
        offered.always
    };
    assert!(always(ask(false, false)));
    assert!(!always(ask(true, false)));
    assert!(!always(ask(false, true)));
}

#[test]
fn the_remembered_input_keeps_the_host_automation_for_the_telemetry_facts() {
    let envelope: Envelope = serde_json::from_value(json!({
        "commandId": "auto_1:manual:7f1c",
        "clientId": "host",
        "sessionId": "s1",
        "type": "sendText",
        "payload": {},
    }))
    .unwrap();
    let meta = |payload: serde_json::Value| {
        let input: Input = serde_json::from_value(payload).unwrap();
        input_meta(&envelope, &input, "startNow", "startNow").automation
    };
    assert_eq!(
        meta(json!({"text": "run", "automationId": " auto_1 "})).as_deref(),
        Some("auto_1")
    );
    assert_eq!(meta(json!({"text": "run", "automationId": "  "})), None);
    assert_eq!(meta(json!({"text": "run"})), None);
}
