//! Fork: the session-only "always allow" (specs/fork-rust-node-helper.md F3b a). The grant lives in the session
//! actor: it answers later asks of the same tool in that session, and it reaches neither another session nor the
//! project rules.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{CommandId, EnvironmentId, SessionId, ToolUseId};
use rust_cli_kernel_api::orchestration::{
    Answer, InteractionRequest, Interactions, PermissionAnswer,
};
use rust_cli_kernel_api::session_api::{
    Command, CommandEnvelope, CreateSession, Kernel, KernelEvent, SessionHandle,
};
use rust_cli_kernel_api::store::LocalSettings;
use rust_cli_kernel_api::testing::{
    FixedClock, MemoryStore, ScriptedModel, SequentialIds, UnusedEnvironment, environments,
    selection,
};
use tokio_util::sync::CancellationToken;

use super::*;

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/work"),
    }
}

fn kernel_with(store: Arc<MemoryStore>) -> LocalKernel {
    LocalKernel::new(
        Ports {
            model: Arc::new(ScriptedModel::new(Vec::new())),
            environments: environments(Arc::new(UnusedEnvironment)),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection().into(),
            mode: rust_cli_kernel_api::permission::PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
    )
}

async fn open(kernel: &LocalKernel) -> (SessionId, Arc<dyn SessionHandle>) {
    let id = kernel
        .create_session(CreateSession {
            id: None,
            workspace: workspace(),
            selection: selection(),
            mode: rust_cli_kernel_api::permission::PermissionMode::Default,
            plan: false,
            incognito: None,
        })
        .await
        .unwrap();
    let handle = kernel.open_session(&id).await.unwrap();
    (id, handle)
}

fn ask(tool: &str, session_allow: bool) -> InteractionRequest {
    InteractionRequest::Permission {
        origin: None,
        tool_use: ToolUseId::new("tu"),
        tool: tool.to_owned(),
        input: serde_json::json!({"query": "q"}),
        message: "ask".to_owned(),
        suggestions: Vec::new(),
        rule_seed: None,
        asked_by: None,
        machine: Default::default(),
        once: false,
        independent: false,
        session_allow,
    }
}

/// The session's own interactions port, the one a model tool call asks through.
async fn port(kernel: &LocalKernel, id: &SessionId) -> Arc<dyn Interactions> {
    let session = kernel.settled(id).await.expect("the session is open");
    let context = session
        .app_tool_context(ToolUseId::new("tu"), CancellationToken::new())
        .await
        .unwrap();
    context.interactions
}

async fn asked(
    events: &mut futures_util::stream::BoxStream<
        'static,
        rust_cli_kernel_api::session_api::SequencedEvent,
    >,
) -> rust_cli_kernel_api::ids::InteractionId {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .expect("asked in time")
            .unwrap();
        if let KernelEvent::InteractionAsked { interaction, .. } = event.event {
            return interaction;
        }
    }
}

async fn answer(
    handle: &Arc<dyn SessionHandle>,
    interaction: rust_cli_kernel_api::ids::InteractionId,
    value: PermissionAnswer,
) {
    handle
        .send(CommandEnvelope {
            id: CommandId::new("c1"),
            command: Command::ResolveInteraction {
                interaction,
                answer: value.into(),
            },
        })
        .await;
}

/// "Always allow in this session" answers later asks of that tool in the same session, writes no project rule, and
/// does not reach another session or another tool.
#[tokio::test]
async fn the_session_grant_answers_later_asks_only_in_that_session() {
    let store = Arc::new(MemoryStore::default());
    let kernel = Arc::new(kernel_with(store.clone()));
    let (id, handle) = open(&kernel).await;
    let mut events = handle.subscribe(Some(0));
    let first = {
        let (port, request) = (port(&kernel, &id).await, ask("app__search", true));
        tokio::spawn(async move { port.ask(request).await })
    };
    let interaction = asked(&mut events).await;
    answer(&handle, interaction, PermissionAnswer::AllowSession).await;
    let first = first.await.unwrap().unwrap();
    assert!(matches!(
        first.answer,
        Answer::Permission(PermissionAnswer::Allow { .. })
    ));

    // The same tool in the same session: answered at once, nothing pending.
    let again = tokio::time::timeout(Duration::from_secs(5), async {
        port(&kernel, &id).await.ask(ask("app__search", true)).await
    })
    .await
    .expect("answered without a prompt")
    .unwrap();
    assert!(matches!(
        again.answer,
        Answer::Permission(PermissionAnswer::Allow { .. })
    ));
    assert!(handle.view().await.unwrap().pending.is_empty());

    // Another tool still asks.
    let other = {
        let (port, request) = (port(&kernel, &id).await, ask("app__other", true));
        tokio::spawn(async move { port.ask(request).await })
    };
    asked(&mut events).await;
    other.abort();

    // Another session asks for the same tool name: its own grant is empty, so it prompts.
    let (other_id, other_handle) = open(&kernel).await;
    let mut other_events = other_handle.subscribe(Some(0));
    let pending = {
        let (port, request) = (port(&kernel, &other_id).await, ask("app__search", true));
        tokio::spawn(async move { port.ask(request).await })
    };
    asked(&mut other_events).await;
    pending.abort();

    // The grant wrote no project rule.
    let rules = store.project_rules(&workspace()).await.unwrap();
    assert!(rules.sourced().is_empty(), "{rules:?}");
}

/// An "always allow in this session" answer to an ask that did not offer it is a deny, like any option not offered.
#[tokio::test]
async fn an_unoffered_session_answer_is_refused() {
    let store = Arc::new(MemoryStore::default());
    let kernel = Arc::new(kernel_with(store));
    let (id, handle) = open(&kernel).await;
    let mut events = handle.subscribe(Some(0));
    let asking = {
        let (port, request) = (port(&kernel, &id).await, ask("app__search", false));
        tokio::spawn(async move { port.ask(request).await })
    };
    let interaction = asked(&mut events).await;
    answer(&handle, interaction, PermissionAnswer::AllowSession).await;
    let refused = asking.await.unwrap().unwrap();
    assert!(
        matches!(
            refused.answer,
            Answer::Permission(PermissionAnswer::Deny { .. })
        ),
        "{refused:?}"
    );
}
