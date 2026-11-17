//! Kernel-level mirror of Node's `bootstrap/tests/context-composition/protocol.test.ts` (spec "Rust port", step 4): a
//! draft preview before any turn, the request composition after a turn with the provider's usage, the change stream
//! (`contextCompositionChanged`), and a model switch that drops the request record. The real LocalKernel with a
//! ScriptedModel stands in for the App's runtime; the protocol framing is covered by protocol-zcode's tests.
#[cfg(test)]
mod flow {
    use std::sync::Arc;
    use std::time::Duration;

    use futures_util::StreamExt;
    use rust_cli_kernel_api::context_composition::{CompositionPhase, CompositionChange};
    use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
    use rust_cli_kernel_api::ids::{CommandId, EnvironmentId};
    use rust_cli_kernel_api::message::Usage;
    use rust_cli_kernel_api::model::{ModelEvent, ModelSelection};
    use rust_cli_kernel_api::permission::PermissionMode;
    use rust_cli_kernel_api::session_api::{
        Command, CommandEnvelope, CreateSession, Delivery, Kernel, KernelEvent, SessionHandle,
        TurnOutcome,
    };
    use rust_cli_kernel_api::testing::{
        FixedClock, MemoryStore, ScriptedModel, SequentialIds, UnusedEnvironment, environments,
        selection, text_response,
    };
    use rust_cli_runtime::{Defaults, LocalKernel, Ports};

    /// A text answer whose provider usage is the Node test's: 4321 input, 3 output tokens.
    fn answer_with_usage() -> Vec<Result<ModelEvent, rust_cli_kernel_api::model::ModelError>> {
        let mut events = text_response(&["answer"]);
        for event in &mut events {
            if let Ok(ModelEvent::MessageDelta { usage, .. }) = event {
                *usage = Usage {
                    input_tokens: 4_321,
                    output_tokens: 3,
                    ..Default::default()
                };
            }
        }
        events
    }

    fn command(id: &str, command: Command) -> CommandEnvelope {
        CommandEnvelope {
            id: CommandId::new(id),
            command,
        }
    }

    async fn finish(session: &Arc<dyn SessionHandle>, after: u64) -> (TurnOutcome, u64) {
        let mut events = session.subscribe(Some(after));
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), events.next())
                .await
                .unwrap()
                .unwrap();
            if let KernelEvent::TurnFinished { outcome, .. } = event.event {
                return (outcome, event.seq);
            }
        }
    }

    fn drain(
        changes: &mut tokio::sync::broadcast::Receiver<CompositionChange>,
    ) -> Vec<CompositionChange> {
        let mut out = Vec::new();
        while let Ok(change) = changes.try_recv() {
            out.push(change);
        }
        out
    }

    #[tokio::test]
    async fn draft_then_request_then_model_switch_as_node_protocol_test() {
        let model = Arc::new(ScriptedModel::new(vec![answer_with_usage()]));
        let store = Arc::new(MemoryStore::default());
        let kernel = LocalKernel::new(
            Ports {
                model: model.clone(),
                environments: environments(Arc::new(UnusedEnvironment)),
                store: store.clone(),
                artifacts: store,
                clock: Arc::new(FixedClock(1_000)),
                ids: Arc::new(SequentialIds::default()),
            },
            Defaults {
                selection: selection().into(),
                mode: PermissionMode::Default,
                max_turns: None,
                search_tools: false,
                task_tools: None,
                limits: Default::default(),
            },
        );
        let id = kernel
            .create_session(CreateSession {
                id: None,
                workspace: WorkspaceRef {
                    environment: EnvironmentId::new("local"),
                    root: EnvPath::new("/Users/dev/project"),
                },
                selection: selection(),
                mode: PermissionMode::Default,
                plan: false,
                incognito: None,
            })
            .await
            .unwrap();
        let session = kernel.open_session(&id).await.unwrap();
        let mut changes = kernel.context_composition_changes().expect("changes");

        // A draft preview before any turn: the system prompt and the tool schemas are counted, nothing is sent.
        let draft = kernel
            .context_composition(&id, None)
            .await
            .unwrap()
            .expect("an open session answers");
        assert_eq!(draft.phase, CompositionPhase::DraftPreview);
        assert!(category_tokens(&draft.record, "system_prompt") > 0);
        assert!(category_tokens(&draft.record, "system_tool_schemas") > 0);
        assert_eq!(model.requests().len(), 0);
        assert_eq!(draft.context_window, None);

        // A turn: the request composition is kept with the provider's usage (input 4321, context 4324).
        session
            .send(command(
                "c1",
                Command::Submit {
                    text: "hello".to_owned(),
                    attachments: Vec::new(),
                    delivery: Delivery::Queue,
                },
            ))
            .await;
        let (outcome, seq) = finish(&session, 0).await;
        assert_eq!(outcome, TurnOutcome::Success);
        let measured = kernel
            .context_composition(&id, None)
            .await
            .unwrap()
            .expect("an open session answers");
        assert_eq!(measured.phase, CompositionPhase::Request);
        let usage = measured.record.provider_usage.expect("usage attached");
        assert_eq!(usage.input_tokens, 4_321);
        assert_eq!(usage.context_tokens, 4_324);
        assert!(category_tokens(&measured.record, "messages") > 0);

        // Every change reached the stream, and the last one carries the answer's revision (Node: the notification's
        // revision equals the query's).
        let seen = drain(&mut changes);
        let last = seen.iter().filter(|c| c.session == id).last().expect("a change");
        assert_eq!(last.revision, measured.revision);

        // A model switch: a larger revision, the request record is dropped, the query answers a draft for the new model.
        let before = measured.revision;
        let other = ModelSelection::new("fixture".to_owned(), "other".to_owned());
        session
            .send(command("c2", Command::SetModel { selection: other.clone() }))
            .await;
        let switched = kernel
            .context_composition(&id, Some(other))
            .await
            .unwrap()
            .expect("an open session answers");
        assert_eq!(switched.phase, CompositionPhase::DraftPreview);
        assert_eq!(switched.revision, before + 1);
        let seen = drain(&mut changes);
        assert!(seen.iter().any(|c| c.session == id && c.revision == before + 1));
        let _ = seq;
    }

    fn category_tokens(record: &rust_cli_kernel_api::context_composition::CompositionRecord, id: &str) -> u64 {
        record
            .categories
            .iter()
            .find(|category| category.id == id)
            .map_or(0, |category| category.tokens)
    }
}
