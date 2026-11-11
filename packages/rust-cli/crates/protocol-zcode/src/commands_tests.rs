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
        parse(json!({"workspaceId": "/w", "incognito": profile, "worktreePreparation": {}})),
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
