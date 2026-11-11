use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{CommandId, EnvironmentId};
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::session_api::{
    Command, CommandEnvelope, CreateSession, Delivery, KernelEvent, TurnOutcome,
};
use rust_cli_kernel_api::testing::{
    FixedClock, MemoryStore, ScriptedModel, SequentialIds, UnusedEnvironment, environments,
    selection, text_response,
};

use super::*;
use rust_cli_kernel_api::default_model::DefaultModel;

fn kernel(store: Arc<MemoryStore>, model: Arc<ScriptedModel>) -> LocalKernel {
    kernel_with(store, model, selection().into())
}

fn kernel_with(
    store: Arc<MemoryStore>,
    model: Arc<ScriptedModel>,
    default: DefaultModel,
) -> LocalKernel {
    LocalKernel::new(
        Ports {
            model,
            environments: environments(Arc::new(UnusedEnvironment)),
            store: store.clone(),
            artifacts: store,
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: default,
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
    )
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/work"),
    }
}

#[tokio::test]
async fn a_created_session_runs_a_turn_and_reloads_after_restart() {
    let store = Arc::new(MemoryStore::default());
    let first = kernel(
        store.clone(),
        Arc::new(ScriptedModel::new(vec![text_response(&["hi"])])),
    );
    let id = first
        .create_session(CreateSession {
            id: None,
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
            incognito: None,
        })
        .await
        .unwrap();
    let session = first.open_session(&id).await.unwrap();
    let again = first.open_session(&id).await.unwrap();
    assert!(Arc::ptr_eq(&session, &again));
    let mut events = session.subscribe(Some(0));
    session
        .send(CommandEnvelope {
            id: CommandId::new("c1"),
            command: Command::Submit {
                text: "hello".to_owned(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            },
        })
        .await;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .unwrap()
            .unwrap();
        if let KernelEvent::TurnFinished { outcome, .. } = event.event {
            assert_eq!(outcome, TurnOutcome::Success);
            break;
        }
    }
    drop(first);

    let second = kernel(store, Arc::new(ScriptedModel::new(Vec::new())));
    let reopened = second.open_session(&id).await.unwrap();
    // 一问一答之外，还有上下文这一步宣布的 attachment（模型身份、延迟工具清单（本地 ToolSearch，工作线 F84：
    // 测试替身答不出能力、模型没有卡片）、agent 清单（有 Agent 工具）、剩余 token、日期；内置工具里有 Bash，所以也宣布
    // 署名），它们与对话一起落库、resume 后重放。
    let messages = reopened.view().await.unwrap().messages;
    let dialogue = messages
        .iter()
        .filter(|message| matches!(message, Message::User(_) | Message::Assistant(_)))
        .count();
    assert_eq!(dialogue, 2);
    let sources: Vec<&str> = messages
        .iter()
        .filter_map(|message| match message {
            Message::Attachment(attachment) => Some(attachment.source.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        sources,
        [
            "model",
            "deferred_tools_delta",
            "agent_listing_delta",
            "total_tokens_reminder",
            "date",
            "remote_session_change"
        ]
    );
}

/// 复现（R1-1）：以前关闭后会话还留在 `sessions` 表里（actor 活着），再打开拿到的是旧 actor——不跑
/// SessionStart(resume)，按会话的表也不释放。关闭之后它离开内核，再打开是新的 actor。
#[tokio::test]
async fn a_closed_session_leaves_the_kernel_and_reopens_with_a_new_actor() {
    use rust_cli_kernel_api::session_api::{EndReason, StartSource};
    let store = Arc::new(MemoryStore::default());
    let kernel = kernel(store, Arc::new(ScriptedModel::new(Vec::new())));
    let id = kernel
        .create_session(CreateSession {
            id: None,
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
            incognito: None,
        })
        .await
        .unwrap();
    let first = kernel.open_session(&id).await.unwrap();
    first.close(EndReason::Resume).await;
    assert!(
        !kernel.sessions().contains_key(&id),
        "a closed session must leave the kernel"
    );
    assert!(first.view().await.is_err(), "the old actor has stopped");
    let again = kernel
        .open_session_as(&id, StartSource::Resume)
        .await
        .unwrap();
    assert!(!Arc::ptr_eq(&first, &again));
    again.view().await.unwrap();
}

/// 工作线 F140（performance.md §12.3）：缺省模型定下之前，建会话与开会话都等着（内核唯一的等待点）；定下后照常。
#[tokio::test]
async fn sessions_wait_for_the_default_model_to_settle() {
    let store = Arc::new(MemoryStore::default());
    let id = kernel(store.clone(), Arc::new(ScriptedModel::new(Vec::new())))
        .create_session(CreateSession {
            id: None,
            workspace: workspace(),
            selection: selection(),
            mode: PermissionMode::Default,
            plan: false,
            incognito: None,
        })
        .await
        .unwrap();
    let (settle, default) = DefaultModel::pending();
    let late = Arc::new(kernel_with(
        store,
        Arc::new(ScriptedModel::new(Vec::new())),
        default,
    ));
    let creating = tokio::spawn({
        let late = late.clone();
        async move {
            late.create_session(CreateSession {
                id: None,
                workspace: workspace(),
                selection: selection(),
                mode: PermissionMode::Default,
                plan: false,
                incognito: None,
            })
            .await
        }
    });
    let opening = tokio::spawn({
        let (late, id) = (late.clone(), id.clone());
        async move { late.open_session(&id).await.map(|_| ()) }
    });
    // 单线程运行时：让出几次，两个任务都已跑到各自的等待点。
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
    assert!(!creating.is_finished() && !opening.is_finished());
    settle.settle(selection());
    creating.await.unwrap().unwrap();
    opening.await.unwrap().unwrap();
}

/// Fork (specs/fork-rust-agent-parity.md, "Incognito sessions"): a prepared execution worktree runs nothing before its
/// activation (no model request, no message, no title), and the profile its activation freezes gates the first
/// request exactly like a session created incognito: no environment and no identity reach the model.
#[tokio::test]
async fn a_prepared_session_frozen_incognito_at_activation_sends_the_incognito_request() {
    use rust_cli_kernel_api::incognito::IncognitoProfile;
    async fn first_turn(
        kernel: &LocalKernel,
        id: &rust_cli_kernel_api::ids::SessionId,
    ) -> Arc<dyn rust_cli_kernel_api::session_api::SessionHandle> {
        let session = kernel.open_session(id).await.unwrap();
        let mut events = session.subscribe(Some(0));
        session
            .send(CommandEnvelope {
                id: CommandId::new("c-first"),
                command: Command::Submit {
                    text: "hello".to_owned(),
                    attachments: Vec::new(),
                    delivery: Delivery::Queue,
                },
            })
            .await;
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), events.next())
                .await
                .unwrap()
                .unwrap();
            if let KernelEvent::TurnFinished { outcome, .. } = event.event {
                assert_eq!(outcome, TurnOutcome::Success);
                return session;
            }
        }
    }
    let request = |incognito| CreateSession {
        id: None,
        workspace: workspace(),
        selection: selection(),
        mode: PermissionMode::Default,
        plan: false,
        incognito,
    };

    // The reference: a session created with the lockdown profile.
    let direct_model = Arc::new(ScriptedModel::new(vec![text_response(&["hi"])]));
    let direct = kernel(Arc::new(MemoryStore::default()), direct_model.clone());
    let id = direct
        .create_session(request(Some(IncognitoProfile::LOCKDOWN)))
        .await
        .unwrap();
    first_turn(&direct, &id).await;
    let expected = direct_model.requests().remove(0);

    let model = Arc::new(ScriptedModel::new(vec![text_response(&["hi"])]));
    let store = Arc::new(MemoryStore::default());
    let prepared = kernel(store.clone(), model.clone());
    let id = prepared
        .create_prepared_session(request(None))
        .await
        .unwrap();
    let session = prepared.open_session(&id).await.unwrap();
    // Before the activation: nothing reached the model, the conversation or the title, and no turn started (every
    // conversation telemetry fact and the memory extraction come from a turn).
    let mut early = session.subscribe(Some(0));
    while let Ok(Some(event)) = tokio::time::timeout(Duration::from_millis(50), early.next()).await
    {
        assert!(
            !matches!(
                event.event,
                KernelEvent::TurnStarted { .. } | KernelEvent::TurnFinished { .. }
            ),
            "{:?}",
            event.event
        );
    }
    assert!(model.requests().is_empty());
    let view = session.view().await.unwrap();
    assert!(view.messages.is_empty(), "{:?}", view.messages);
    assert!(view.meta.title.is_empty());
    assert_eq!(view.meta.incognito, None);

    // The activation's order: freeze (row, kernel profile), the actor's meta, then the move releases SessionStart.
    prepared
        .freeze_incognito(&id, IncognitoProfile::LOCKDOWN)
        .await
        .unwrap();
    let send = |command| CommandEnvelope {
        id: CommandId::new("c-activate"),
        command,
    };
    session
        .send(send(Command::SetIncognito {
            profile: IncognitoProfile::LOCKDOWN,
        }))
        .await;
    session
        .send(send(Command::SetExecutionRoot {
            root: workspace().root,
        }))
        .await;
    first_turn(&prepared, &id).await;
    let sent = model.requests().remove(0);
    assert_eq!(sent.system, expected.system);
    assert_eq!(sent.messages, expected.messages);
    assert_eq!(
        session.view().await.unwrap().meta.incognito,
        Some(IncognitoProfile::LOCKDOWN)
    );
    assert_eq!(
        store.meta(&id).unwrap().incognito,
        Some(IncognitoProfile::LOCKDOWN)
    );

    // A normal session's first request differs (environment and identity), so the comparison above is not vacuous.
    let normal_model = Arc::new(ScriptedModel::new(vec![text_response(&["hi"])]));
    let normal = kernel(Arc::new(MemoryStore::default()), normal_model.clone());
    let id = normal.create_session(request(None)).await.unwrap();
    first_turn(&normal, &id).await;
    let plain = normal_model.requests().remove(0);
    assert_ne!(plain.system, expected.system);
    assert_ne!(plain.messages, expected.messages);
}
