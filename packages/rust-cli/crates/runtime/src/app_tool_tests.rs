//! Fork: specs/fork-rust-node-helper.md F3, `helper/authorizeAppTool`.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use rust_cli_kernel_api::app_tool::{AppToolCall, AppToolError, AppToolRefusal};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{CommandId, EnvironmentId, SessionId, ToolUseId};
use rust_cli_kernel_api::orchestration::PermissionAnswer;
use rust_cli_kernel_api::session_api::{
    Command, CommandEnvelope, CreateSession, Kernel, KernelError, KernelEvent, SessionHandle,
};
use rust_cli_kernel_api::testing::{
    FixedClock, MemoryStore, ScriptedModel, SequentialIds, UnusedEnvironment, environments,
    selection,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::super::*;

fn kernel() -> LocalKernel {
    let store = Arc::new(MemoryStore::default());
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
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
    )
}

async fn session(kernel: &LocalKernel, mode: PermissionMode) -> Arc<dyn SessionHandle> {
    let id = kernel
        .create_session(CreateSession {
            id: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/work"),
            },
            selection: selection(),
            mode,
            plan: false,
            incognito: None,
        })
        .await
        .unwrap();
    kernel.open_session(&id).await.unwrap()
}

fn call(session: &SessionId, input: Value, cancel: CancellationToken) -> AppToolCall {
    AppToolCall {
        session: session.clone(),
        server: "plugin:viewer:view".to_owned(),
        tool: "search".to_owned(),
        input,
        descriptor: json!({
            "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
        }),
        tool_use: ToolUseId::new("helper_req_1"),
        cancel,
    }
}

#[tokio::test]
async fn an_allowed_call_answers_its_input_and_bad_input_is_invalid_input() {
    let kernel = kernel();
    let handle = session(&kernel, PermissionMode::BypassPermissions).await;
    let input = json!({"query": "q"});
    let answered = kernel
        .authorize_app_tool(call(handle.id(), input.clone(), CancellationToken::new()))
        .await
        .unwrap();
    assert_eq!(answered, input);
    let refused = kernel
        .authorize_app_tool(call(handle.id(), json!({}), CancellationToken::new()))
        .await;
    assert!(matches!(
        refused,
        Err(AppToolError::Refused(AppToolRefusal::InvalidInput(_)))
    ));
}

#[tokio::test]
async fn a_session_that_is_not_open_is_not_found() {
    let kernel = kernel();
    let refused = kernel
        .authorize_app_tool(call(
            &SessionId::new("missing"),
            json!({"query": "q"}),
            CancellationToken::new(),
        ))
        .await;
    assert!(matches!(
        refused,
        Err(AppToolError::Kernel(KernelError::NotFound { .. }))
    ));
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

/// "Always allow" lands in the session's rules: the next App call of that tool, like a model call, does not ask.
#[tokio::test]
async fn an_always_allow_answer_stops_later_prompts_for_the_tool() {
    let kernel = Arc::new(kernel());
    let handle = session(&kernel, PermissionMode::Default).await;
    let mut events = handle.subscribe(Some(0));
    let input = json!({"query": "q"});
    let asking = {
        let (kernel, call) = (
            kernel.clone(),
            call(handle.id(), input.clone(), CancellationToken::new()),
        );
        tokio::spawn(async move { kernel.authorize_app_tool(call).await })
    };
    let interaction = asked(&mut events).await;
    let rule = rust_cli_kernel_api::permission::PermissionRule {
        tool: "mcp__plugin_viewer_view__search".to_owned(),
        content: None,
    };
    handle
        .send(CommandEnvelope {
            id: CommandId::new("c1"),
            command: Command::ResolveInteraction {
                interaction,
                answer: PermissionAnswer::Allow {
                    remember: vec![rule],
                }
                .into(),
            },
        })
        .await;
    assert_eq!(asking.await.unwrap().unwrap(), input);
    let again = tokio::time::timeout(
        Duration::from_secs(5),
        kernel.authorize_app_tool(call(handle.id(), input.clone(), CancellationToken::new())),
    )
    .await
    .expect("answered without a prompt");
    assert_eq!(again.unwrap(), input);
}

/// The session prompts like a model call of the tool; an approval answers the input, a cancel withdraws the prompt.
#[tokio::test]
async fn a_prompted_call_follows_the_answer_and_a_cancel_withdraws_it() {
    let kernel = Arc::new(kernel());
    let handle = session(&kernel, PermissionMode::Default).await;
    let mut events = handle.subscribe(Some(0));
    let input = json!({"query": "q"});
    let asking = {
        let (kernel, call) = (
            kernel.clone(),
            call(handle.id(), input.clone(), CancellationToken::new()),
        );
        tokio::spawn(async move { kernel.authorize_app_tool(call).await })
    };
    let interaction = asked(&mut events).await;
    handle
        .send(CommandEnvelope {
            id: CommandId::new("c1"),
            command: Command::ResolveInteraction {
                interaction,
                answer: PermissionAnswer::Allow {
                    remember: Vec::new(),
                }
                .into(),
            },
        })
        .await;
    assert_eq!(asking.await.unwrap().unwrap(), input);
    let cancel = CancellationToken::new();
    let asking = {
        let (kernel, call) = (
            kernel.clone(),
            call(handle.id(), input.clone(), cancel.clone()),
        );
        tokio::spawn(async move { kernel.authorize_app_tool(call).await })
    };
    asked(&mut events).await;
    cancel.cancel();
    assert!(matches!(
        asking.await.unwrap(),
        Err(AppToolError::Refused(AppToolRefusal::PermissionDenied(_)))
    ));
    assert!(handle.view().await.unwrap().pending.is_empty());
}
