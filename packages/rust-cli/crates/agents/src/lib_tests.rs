//! Agent、ListAgents、SendMessage、TaskStop 与任务工具经 [`crate::Agents`] 的注册表调用。

use std::sync::Arc;

use futures_util::StreamExt;
use rust_cli_kernel_api::agents::{AgentSignal, TaskListStore};
use rust_cli_kernel_api::ids::{AgentId, SessionId};
use rust_cli_kernel_api::model::QuerySource;
use rust_cli_kernel_api::store::{Fact, SessionStore};
use serde_json::json;
use tokio::sync::Notify;

use crate::test_support::{desktop_harness, harness, text};

#[tokio::test]
async fn a_foreground_agent_runs_in_a_child_session_and_hands_back_its_report() {
    let harness = harness(None);
    let output = harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Say hello", "prompt": "Say hello from the subagent.", "subagent_type": "general-purpose", "run_in_background": false}),
        )
        .await;
    let text = text(&output);
    assert!(text.starts_with("[Subagent hand-back]"), "{text}");
    assert!(
        text.contains(
            "\n  Hello from the subagent.\nagentId: agent_1 (use SendMessage with to: 'agent_1'"
        ),
        "{text}"
    );
    assert!(
        text.ends_with("<usage>subagent_tokens: 13\ntool_uses: 0\nduration_ms: 0</usage>"),
        "{text}"
    );
    let seen = harness.seen();
    assert_eq!(seen.len(), 1);
    // 工具集去掉了 Workflow；system 段是子代理自己的。
    assert_eq!(
        seen[0].tools,
        [
            "Bash",
            "Read",
            "Edit",
            "Agent",
            "ListAgents",
            "SendMessage",
            "TaskStop",
            "TaskCreate",
            "TaskGet",
            "TaskList",
            "TaskUpdate"
        ]
    );
    assert!(
        seen[0].system[1]
            .text
            .starts_with("You are an agent for ZCode.")
    );
    assert_eq!(
        seen[0].request.source,
        QuerySource::Subagent("general-purpose".to_owned())
    );
    assert_eq!(
        seen[0].request.session,
        SessionId::new("sess_subagent_agent_1")
    );
    // 子会话：parent_id、模型、模式、第一条 user 消息与子代理的回复都在子会话里。
    let child = harness
        .store
        .load(&SessionId::new("sess_subagent_agent_1"))
        .await
        .unwrap();
    assert_eq!(child.meta.parent, Some(SessionId::new("sess_parent")));
    assert_eq!(child.messages.len(), 2);
    let facts = harness
        .store
        .facts(&SessionId::new("sess_subagent_agent_1"));
    assert!(matches!(facts[0], Fact::ModelSelected { .. }));
    // 子循环结束时在子会话写这一轮的 `turn_usage`（usage.md §2.4）。
    assert!(matches!(
        facts.last(),
        Some(Fact::TurnEnded {
            status: rust_cli_kernel_api::metering::CallStatus::Completed
        })
    ));
    assert!(
        harness
            .store
            .facts(&SessionId::new("sess_parent"))
            .is_empty()
    );
}

#[tokio::test]
async fn explore_is_one_shot_and_unknown_types_are_rejected() {
    let harness = harness(None);
    let output = harness
        .call("sess_parent", "Agent", json!({"description": "Find", "prompt": "List.", "subagent_type": "Explore", "run_in_background": false}))
        .await;
    assert!(text(&output).ends_with("The report follows:\n  Hello from the subagent."));
    let tool = harness.agents.registry().find("Agent").unwrap();
    let context = crate::test_support::tool_context(
        &SessionId::new("s"),
        &rust_cli_kernel_api::ids::RunId::new("r"),
    );
    let verdict = tool
        .validate_input(
            &json!({"description": "x", "prompt": "y", "subagent_type": "nope"}),
            &context,
        )
        .await;
    assert_eq!(
        verdict,
        rust_cli_kernel_api::tool::Validation::Invalid {
            message:
                "Agent type 'nope' not found. Available agents: general-purpose, Explore, Plan"
                    .to_owned(),
            error_code: None
        }
    );
}

#[tokio::test]
async fn a_background_agent_notifies_its_parent_once_it_finishes() {
    let gate = Arc::new(Notify::new());
    let harness = harness(Some(gate.clone()));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    let output = harness
        .call("sess_parent", "Agent", json!({"description": "Find files", "prompt": "List the files.", "subagent_type": "Explore"}))
        .await;
    assert!(text(&output).starts_with("Async agent launched successfully."));
    assert_eq!(signals.background(&parent).await, [AgentId::new("agent_1")]);
    let listed = text(&harness.call("sess_parent", "ListAgents", json!({})).await);
    // 段落格式（cross-session.md §1.3，F28）：没有同伴、跨会话关闭时只有子代理一段。
    assert_eq!(
        listed,
        "Subagents (1):\n  agent_1  ·  Explore  ·  running  ·  started 0s ago"
    );
    // 后台子代理只有异步白名单里的工具。
    assert_eq!(
        harness.started(1).await[0].tools,
        ["Bash", "Read", "SendMessage", "TaskStop"]
    );
    gate.notify_one();
    let Some(AgentSignal::Notice(notice)) = stream.next().await else {
        panic!("expected a notice");
    };
    assert_eq!(
        notice.status,
        rust_cli_kernel_api::env_shell::BackgroundStatus::Completed
    );
    assert!(
        notice
            .text
            .contains("<summary>Agent \"Find files\" finished</summary>")
    );
    assert!(
        notice
            .text
            .contains("<result>Hello from the subagent.</result>")
    );
    // 通知没有 ack 之前，后台列表里仍有它。
    assert_eq!(signals.background(&parent).await, [AgentId::new("agent_1")]);
    signals.ack(&parent, notice.seq).await;
    assert!(signals.background(&parent).await.is_empty());
}

#[tokio::test]
async fn task_stop_kills_a_running_agent_and_send_message_resumes_a_finished_one() {
    let gate = Arc::new(Notify::new());
    let harness = harness(Some(gate.clone()));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Long job", "prompt": "Work."}),
        )
        .await;
    harness.started(1).await;
    let stopped = text(
        &harness
            .call("sess_parent", "TaskStop", json!({"task_id": "agent_1"}))
            .await,
    );
    assert_eq!(
        stopped,
        r#"{"message":"Successfully stopped task: agent_1 (Long job)","task_id":"agent_1","task_type":"local_agent","command":"Long job"}"#
    );
    let Some(AgentSignal::Notice(notice)) = stream.next().await else {
        panic!("expected a notice");
    };
    assert_eq!(
        notice.status,
        rust_cli_kernel_api::env_shell::BackgroundStatus::Killed
    );
    assert!(
        notice
            .text
            .contains("<summary>Agent \"Long job\" was stopped by ZCode</summary>")
    );
    let again = harness
        .call("sess_parent", "TaskStop", json!({"task_id": "agent_1"}))
        .await;
    assert_eq!(
        text(&again),
        "<tool_use_error>Task agent_1 is not running (status: killed)</tool_use_error>"
    );
    let missing = harness
        .call(
            "sess_parent",
            "SendMessage",
            json!({"to": "agent_9", "message": "hi"}),
        )
        .await;
    // 打开跨会话后的文字（`success: false`，不标 is_error；cross-session.md §1.4，F28）。
    assert!(!missing.is_error);
    assert_eq!(
        text(&missing),
        "No agent named 'agent_9' is reachable.\nUse ListAgents to see everyone you can message."
    );
    let resumed = text(
        &harness
            .call(
                "sess_parent",
                "SendMessage",
                json!({"to": "agent_1", "message": "Go on."}),
            )
            .await,
    );
    assert!(
        resumed.starts_with(
            "Agent \"agent_1\" was stopped (killed); it was resumed in the background"
        ),
        "{resumed}"
    );
    // 续跑时子会话里有原来的消息与新的 user 消息。
    let seen = harness.started(2).await;
    assert_eq!(seen[1].request.messages.len(), 2);
    gate.notify_one();
    assert!(
        matches!(stream.next().await, Some(AgentSignal::Notice(notice)) if notice.status == rust_cli_kernel_api::env_shell::BackgroundStatus::Completed)
    );
}

#[tokio::test]
async fn task_tools_write_the_root_list_and_signal_the_root_session() {
    let harness = harness(None);
    let root = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&root);
    let created = text(
        &harness
            .call(
                "sess_parent",
                "TaskCreate",
                json!({"subject": "Write tests", "description": "Cover the parser"}),
            )
            .await,
    );
    assert_eq!(created, "Task #1 created successfully: Write tests");
    let Some(AgentSignal::TasksChanged { tasks }) = stream.next().await else {
        panic!("expected tasks");
    };
    assert_eq!(tasks[0]["subject"], "Write tests");
    assert_eq!(harness.tasks.load(&root).await.unwrap().tasks.len(), 1);
    let listed = text(&harness.call("sess_parent", "TaskList", json!({})).await);
    assert_eq!(listed, "#1 [pending] Write tests");
}

/// 子会话的当前轮随每个批次交给存储（node-store.md §4，修复线 F6）；续跑的输入开新的一轮。以前都不带锚点。
#[tokio::test]
async fn child_batches_name_the_prompt_of_their_run() {
    let gate = Arc::new(Notify::new());
    let harness = harness(Some(gate.clone()));
    let child = SessionId::new("sess_subagent_agent_1");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&SessionId::new("sess_parent"));
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Long job", "prompt": "Work."}),
        )
        .await;
    harness.started(1).await;
    harness
        .call("sess_parent", "TaskStop", json!({"task_id": "agent_1"}))
        .await;
    assert!(matches!(stream.next().await, Some(AgentSignal::Notice(_))));
    harness
        .call(
            "sess_parent",
            "SendMessage",
            json!({"to": "agent_1", "message": "Go on."}),
        )
        .await;
    harness.started(2).await;
    gate.notify_one();
    assert!(matches!(stream.next().await, Some(AgentSignal::Notice(_))));
    let prompts: Vec<_> = harness
        .store
        .facts(&child)
        .into_iter()
        .filter_map(|fact| match fact {
            Fact::MessageAppended {
                message: rust_cli_kernel_api::message::Message::User(user),
            } if rust_cli_kernel_api::user_input::opens_turn(&user) => Some(user.id),
            _ => None,
        })
        .collect();
    assert_eq!(prompts.len(), 2);
    let turns = harness.store.batch_turns(&child);
    assert!(turns.iter().all(Option::is_some), "{turns:?}");
    let named: Vec<_> = turns.into_iter().flatten().map(|t| t.prompt).collect();
    assert_eq!(named.first(), Some(&prompts[0]));
    assert_eq!(named.last(), Some(&prompts[1]));
}

/// R1-13：主线程注册表在构造时就接好（原来先建后接，取不到时给空注册表、子代理不带工具运行）；内核释放后取不到，
/// 子代理按失败结束。
#[tokio::test]
async fn the_main_registry_is_wired_at_construction() {
    let harness = crate::test_support::harness(None);
    let core = harness.agents.core.clone();
    let names: Vec<String> = core
        .registry()
        .expect("wired at construction")
        .tools()
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert!(names.iter().any(|name| name == "Agent"), "{names:?}");
    assert!(names.iter().any(|name| name == "Bash"), "{names:?}");
    drop(harness);
    assert!(core.registry().is_none());
}

/// 修复线 F51（用户决定 2026-10-22，agents.md §2）：Agent 没有 `model` 参数（不提供模型别名的枚举）；
/// 输入是宽松对象：schema 外的键由执行管线丢掉、不报错（`strips_unknown_keys`）。子代理总是继承父会话模型。
/// 描述与 schema 里没有模型的系列名由导出扫描保证（工作线 F121，export.md §4.1），这里不再反向断言。
#[tokio::test]
async fn the_agent_tool_has_no_model_parameter_and_drops_unknown_keys() {
    let harness = harness(None);
    let tool = harness.agents.registry().find("Agent").unwrap();
    let schema = tool.input_schema();
    assert!(schema["properties"].get("model").is_none(), "{schema}");
    assert_eq!(schema["additionalProperties"], false);
    assert!(tool.strips_unknown_keys());
    // 别的子代理工具仍按严格对象校验。
    let stop = harness.agents.registry().find("TaskStop").unwrap();
    assert!(!stop.strips_unknown_keys());
}

/// 修复线 F51b（用户决定 2026-10-22，agents.md §2）：本工程不支持 isolation，Agent 没有 `isolation` 参数，描述里
/// 不说明它，也不提 SDK 的 `agents` 选项；`validate_input` 不再拒绝 isolation（管线已丢掉这个键）。
#[tokio::test]
async fn the_agent_tool_has_no_isolation_and_no_sdk_wording() {
    let harness = harness(None);
    let tool = harness.agents.registry().find("Agent").unwrap();
    let schema = tool.input_schema();
    assert!(schema["properties"].get("isolation").is_none(), "{schema}");
    let prompt = rust_cli_kernel_api::tool::PromptContext {
        tool_names: Vec::new(),
        mode: rust_cli_kernel_api::permission::PermissionMode::Default,
    };
    let description = tool.description(&prompt);
    assert!(!description.contains("isolation"), "{description}");
    assert!(!description.contains("SDK"), "{description}");
    assert!(
        description.contains("come from its definition (`.zcode/agents/*.md` frontmatter).\n- Subagents run in the background by default;"),
        "{description}"
    );
    let context = crate::test_support::tool_context(
        &SessionId::new("s"),
        &rust_cli_kernel_api::ids::RunId::new("r"),
    );
    let verdict = tool
        .validate_input(
            &json!({"description": "x", "prompt": "y", "isolation": "worktree"}),
            &context,
        )
        .await;
    assert_eq!(verdict, rust_cli_kernel_api::tool::Validation::Ok);
}

/// 工作线 F69（tools-files.md §1.1.1）：基础注册表说某个名字要藏起来（整个工具的 deny 规则）时，本 crate 的工具同样
/// 不在主线程清单、快照与 `find` 里；基础工具由基础注册表自己去掉。
#[tokio::test]
async fn tools_hidden_by_the_base_registry_leave_the_main_list() {
    let harness = crate::test_support::hiding(&["Agent", "TaskStop", "Bash"]);
    let registry = harness.agents.registry();
    let names: Vec<String> = registry
        .tools()
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    for hidden in ["Agent", "TaskStop", "Bash"] {
        assert!(
            !names.iter().any(|name| name == hidden),
            "{hidden}: {names:?}"
        );
        assert!(registry.find(hidden).is_none(), "{hidden}");
    }
    assert!(names.iter().any(|name| name == "SendMessage"), "{names:?}");
    let snapshot = registry.snapshot(&SessionId::new("s"));
    assert!(snapshot.tools.iter().all(|tool| tool.name() != "Agent"));
}

/// 旧名按 kernel-api 的旧名表找到现在的工具（shell-permissions.md §4.2，F132）。缺陷：以前每个工具自己列旧名，
/// ListAgents 没有列 ListPeers，模型按旧名调用时找不到工具（表里有、工具上没有）。
#[tokio::test]
async fn legacy_names_find_the_current_tools() {
    let harness = harness(None);
    let registry = harness.agents.registry();
    let found = |name: &str| registry.find(name).map(|tool| tool.name().to_owned());
    for (old, new) in [
        ("ListPeers", "ListAgents"),
        ("Task", "Agent"),
        ("KillShell", "TaskStop"),
        ("KillBash", "TaskStop"),
    ] {
        assert_eq!(found(old).as_deref(), Some(new), "{old}");
    }
    let listed = harness.call("sess_parent", "ListPeers", json!({})).await;
    assert!(!listed.is_error, "{}", text(&listed));
}

/// Fork (node_desktop): like Node, an Agent call without `run_in_background` runs in the
/// foreground, and the child is announced (`agentId`, no event yet) before its first response.
#[tokio::test]
async fn a_desktop_agent_call_runs_in_the_foreground_by_default() {
    let harness = desktop_harness();
    let (output, progress) = harness
        .call_with_progress(
            "sess_parent",
            "Agent",
            json!({"description": "Find", "prompt": "List.", "subagent_type": "Explore"}),
        )
        .await;
    assert!(
        text(&output).ends_with("The report follows:\n  Hello from the subagent."),
        "{}",
        text(&output)
    );
    assert_eq!(output.display["agent"]["status"], "completed");
    assert_eq!(progress[0], json!({"agentId": "agent_1"}));
    // Asking for the background still launches it.
    let launched = harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Find", "prompt": "List.", "subagent_type": "Explore", "run_in_background": true}),
        )
        .await;
    assert!(text(&launched).starts_with("Async agent launched successfully."));
}

#[tokio::test]
async fn a_desktop_send_message_resume_reads_node_wording() {
    let harness = desktop_harness();
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Find", "prompt": "List."}),
        )
        .await;
    let resumed = text(
        &harness
            .call(
                "sess_parent",
                "SendMessage",
                json!({"to": "agent_1", "message": "Go on."}),
            )
            .await,
    );
    assert_eq!(
        resumed,
        "Agent \"agent_1\" was stopped (completed); resumed it in the background with your message. You'll be notified when it finishes."
    );
}

#[tokio::test]
async fn a_desktop_user_stop_of_a_resumed_agent_names_the_send_message_call() {
    let gate = Arc::new(Notify::new());
    let harness = crate::test_support::desktop_harness_gated(Some(gate.clone()));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    // A background launch that the gate holds, stopped by the model: the agent is finished.
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Long job", "prompt": "Work.", "run_in_background": true}),
        )
        .await;
    harness.started(1).await;
    harness
        .call("sess_parent", "TaskStop", json!({"task_id": "agent_1"}))
        .await;
    let Some(AgentSignal::Notice(_)) = stream.next().await else {
        panic!("expected the TaskStop notice");
    };
    harness
        .call_as(
            "sess_parent",
            "SendMessage",
            json!({"to": "agent_1", "message": "Go on."}),
            Some("toolu_send"),
        )
        .await;
    harness.started(2).await;
    let operation = rust_cli_kernel_api::testing::tool_use_context().operation;
    signals
        .stop_task(&parent, "agent_1", operation)
        .await
        .unwrap();
    let Some(AgentSignal::Notice(notice)) = stream.next().await else {
        panic!("expected the user stop notice");
    };
    assert!(
        notice
            .text
            .contains("<tool-use-id>toolu_send</tool-use-id>"),
        "{}",
        notice.text
    );
    assert!(
        notice.text.contains("<status>killed</status>"),
        "{}",
        notice.text
    );
    assert!(
        notice
            .text
            .contains("<summary>Agent \"Long job\" was stopped by user</summary>"),
        "{}",
        notice.text
    );
}

/// Fork (node_desktop): the model's TaskStop of a running agent returns after the agent has stopped, so its
/// `was stopped by ZCode` notice is already there for the same model request as the tool result (Node).
#[tokio::test]
async fn a_desktop_task_stop_returns_after_the_agent_notice() {
    use futures_util::FutureExt as _;
    let gate = Arc::new(Notify::new());
    let harness = crate::test_support::desktop_harness_gated(Some(gate.clone()));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Long job", "prompt": "Work.", "run_in_background": true}),
        )
        .await;
    harness.started(1).await;
    harness
        .call("sess_parent", "TaskStop", json!({"task_id": "agent_1"}))
        .await;
    let Some(Some(AgentSignal::Notice(notice))) = stream.next().now_or_never() else {
        panic!("the notice was not delivered before TaskStop returned");
    };
    assert!(
        notice
            .text
            .contains("<summary>Agent \"Long job\" was stopped by ZCode</summary>"),
        "{}",
        notice.text
    );
}

/// Fork: a Host snapshot source whose answer the test changes between runs.
struct ChangingHost(std::sync::Mutex<rust_cli_kernel_api::subagent_config::SubagentSnapshot>);

#[async_trait::async_trait]
impl rust_cli_kernel_api::subagent_config::SubagentConfigSource for ChangingHost {
    async fn read(
        &self,
        _session: &rust_cli_kernel_api::ids::SessionId,
    ) -> Result<Option<rust_cli_kernel_api::subagent_config::SubagentSnapshot>, String> {
        use rust_cli_base::sync::LockUnpoisoned;
        Ok(Some(self.0.lock_unpoisoned().clone()))
    }
}

fn reviewer_snapshot(
    prompt: Option<&str>,
) -> rust_cli_kernel_api::subagent_config::SubagentSnapshot {
    use rust_cli_kernel_api::subagent_config::{ProfileSource, SubagentProfile, SubagentSnapshot};
    SubagentSnapshot::Ready {
        profiles: prompt
            .map(|prompt| SubagentProfile {
                name: "reviewer".to_owned(),
                description: "Reviews.".to_owned(),
                source: ProfileSource::User,
                system_prompt: format!("You are the {prompt} reviewer."),
                selection: Some(rust_cli_kernel_api::model::ModelSelection::new(
                    "e2e-provider",
                    format!("{prompt}-model"),
                )),
                tools: None,
                disallowed_tools: Vec::new(),
                max_turns: None,
                background: false,
                permission_mode: None,
                inject_agents_md: true,
            })
            .into_iter()
            .collect(),
        explore: None,
        general_purpose: None,
        plugins: Default::default(),
    }
}

/// Fork (node_desktop, specs/fork-rust-subagent-runtime-config.md rule 13): like Node's
/// `resumeTerminalAgentInBackground`, a SendMessage resume runs with the agent's current profile, and a profile that
/// is gone refuses the resume with Node's text.
#[tokio::test]
async fn a_desktop_resume_uses_the_current_profile_and_refuses_a_removed_one() {
    use rust_cli_base::sync::LockUnpoisoned;
    let harness = desktop_harness();
    let host = Arc::new(ChangingHost(std::sync::Mutex::new(reviewer_snapshot(
        Some("old"),
    ))));
    harness.catalog.set_host(host.clone());
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&SessionId::new("sess_parent"));
    let spawned = harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Review", "prompt": "Review.", "subagent_type": "reviewer"}),
        )
        .await;
    assert!(!spawned.is_error, "{}", text(&spawned));
    assert_eq!(
        harness.started(1).await[0].request.selection.model,
        "old-model"
    );

    *host.0.lock_unpoisoned() = reviewer_snapshot(Some("new"));
    let resumed = harness
        .call(
            "sess_parent",
            "SendMessage",
            json!({"to": "agent_1", "message": "Go on."}),
        )
        .await;
    assert!(!resumed.is_error, "{}", text(&resumed));
    let seen = harness.started(2).await;
    assert_eq!(seen[1].request.selection.model, "new-model");
    let system = format!("{:?}", seen[1].system);
    assert!(system.contains("You are the new reviewer."), "{system}");
    assert!(!system.contains("You are the old reviewer."), "{system}");
    // The resumed run ends before the next message.
    loop {
        match stream.next().await {
            Some(AgentSignal::Notice(_)) => break,
            Some(_) => {}
            None => panic!("the signal stream ended before the resumed run's notice"),
        }
    }

    *host.0.lock_unpoisoned() = reviewer_snapshot(None);
    // The harness names a parent run after its tool, so both SendMessage calls share one run: drop the cached
    // snapshot as a new parent run would read again.
    harness.catalog.forget(&SessionId::new("sess_parent"));
    let refused = harness
        .call(
            "sess_parent",
            "SendMessage",
            json!({"to": "agent_1", "message": "Once more."}),
        )
        .await;
    assert!(!refused.is_error, "{}", text(&refused));
    assert_eq!(
        text(&refused),
        "Cannot resume local agent agent_1: profile reviewer is unavailable."
    );
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    assert_eq!(harness.seen().len(), 2);
}

/// Fork (specs/fork-rust-subagent-runtime-config.md rule 14): Node has no `Plan` agent, so on the desktop
/// `subagent_type: "Plan"` is an unknown type with Node's text.
#[tokio::test]
async fn a_desktop_agent_call_does_not_know_plan() {
    let harness = desktop_harness();
    let tool = harness.agents.registry().find("Agent").unwrap();
    let context = crate::test_support::tool_context(
        &SessionId::new("sess_parent"),
        &rust_cli_kernel_api::ids::RunId::new("r"),
    );
    let verdict = tool
        .validate_input(
            &json!({"description": "x", "prompt": "y", "subagent_type": "Plan"}),
            &context,
        )
        .await;
    assert_eq!(
        verdict,
        rust_cli_kernel_api::tool::Validation::Invalid {
            message: "Agent type 'Plan' not found. Available agents: general-purpose, Explore"
                .to_owned(),
            error_code: None
        }
    );
}

/// Fork (specs/fork-rust-subagent-runtime-config.md rule 15): the child's context gets the definition's
/// `injectAgentsMd`: the built-in Explore leaves the project instructions out, general-purpose keeps them.
#[tokio::test]
async fn a_child_context_follows_the_definitions_inject_agents_md() {
    let harness = harness(None);
    for (agent_type, inject) in [("Explore", false), ("general-purpose", true)] {
        harness.injected.lock().unwrap().clear();
        harness
            .call("sess_parent", "Agent", json!({"description": "Find", "prompt": "List.", "subagent_type": agent_type, "run_in_background": false}))
            .await;
        assert_eq!(*harness.injected.lock().unwrap(), [inject], "{agent_type}");
    }
}

/// Fork: a model catalog with one entry, `e2e-provider/old-model` at `low`.
struct OneModel;

#[async_trait::async_trait]
impl rust_cli_kernel_api::provider::ModelDirectory for OneModel {
    async fn catalog(&self) -> rust_cli_kernel_api::provider::ModelCatalog {
        rust_cli_kernel_api::provider::ModelCatalog {
            revision: 1,
            models: vec![rust_cli_kernel_api::provider::CatalogModel {
                provider: "e2e-provider".to_owned(),
                provider_name: "E2E".to_owned(),
                model: "old-model".to_owned(),
                protocol: rust_cli_kernel_api::provider::WireProtocol::OpenAiChatCompletions,
                reasoning_levels: vec!["low".to_owned()],
                context_window: 200_000,
                max_output_tokens: 32_000,
                capabilities: Default::default(),
                connection: None,
                host: None,
            }],
            default: None,
        }
    }
}

/// The reviewer profile on `e2e-provider/<model>` at `level`.
fn reviewer_on(model: &str, level: &str) -> rust_cli_kernel_api::subagent_config::SubagentSnapshot {
    let mut snapshot = reviewer_snapshot(Some("old"));
    if let rust_cli_kernel_api::subagent_config::SubagentSnapshot::Ready { profiles, .. } =
        &mut snapshot
    {
        profiles[0].selection = Some(rust_cli_kernel_api::model::ModelSelection {
            reasoning: Some(level.to_owned()),
            ..rust_cli_kernel_api::model::ModelSelection::new("e2e-provider", model)
        });
    }
    snapshot
}

/// Fork (node_desktop, specs/fork-rust-subagent-runtime-config.md rule 9): like Node's `resolveSubagentSelection`, an
/// own selection the catalog cannot serve fails the Agent call itself, in the foreground and in the background, with
/// Node's text; no child run starts and the parent's model is not used instead.
#[tokio::test]
async fn a_desktop_agent_with_an_unservable_selection_does_not_start() {
    let harness = desktop_harness();
    harness.catalog.set_models(Arc::new(OneModel));
    harness
        .catalog
        .set_host(Arc::new(ChangingHost(std::sync::Mutex::new(reviewer_on(
            "gone-model",
            "low",
        )))));
    for background in [false, true] {
        let refused = harness
            .call(
                "sess_parent",
                "Agent",
                json!({"description": "Review", "prompt": "Review.", "subagent_type": "reviewer", "run_in_background": background}),
            )
            .await;
        assert!(refused.is_error, "{}", text(&refused));
        assert_eq!(
            text(&refused),
            "Cannot start subagent: Model unavailable / 模型不存在或不可用 [reason=model-not-found; selection=e2e-provider/gone-model]",
            "background: {background}"
        );
    }
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    assert!(harness.seen().is_empty());
}

/// Fork (rule 9): a servable own selection starts; an agent without a selection is not checked.
#[tokio::test]
async fn a_desktop_agent_with_a_servable_selection_starts() {
    let harness = desktop_harness();
    harness.catalog.set_models(Arc::new(OneModel));
    harness
        .catalog
        .set_host(Arc::new(ChangingHost(std::sync::Mutex::new(reviewer_on(
            "old-model",
            "low",
        )))));
    let started = harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Review", "prompt": "Review.", "subagent_type": "reviewer"}),
        )
        .await;
    assert!(!started.is_error, "{}", text(&started));
    let inherited = harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Find", "prompt": "Find.", "subagent_type": "general-purpose"}),
        )
        .await;
    assert!(!inherited.is_error, "{}", text(&inherited));
    assert_eq!(harness.started(2).await.len(), 2);
}

/// Fork (rules 9 and 13): a SendMessage resume checks the current profile's selection and fails the call with Node's
/// text; no run starts.
#[tokio::test]
async fn a_desktop_resume_with_an_unservable_selection_fails() {
    use rust_cli_base::sync::LockUnpoisoned;
    let harness = desktop_harness();
    harness.catalog.set_models(Arc::new(OneModel));
    let host = Arc::new(ChangingHost(std::sync::Mutex::new(reviewer_on(
        "old-model",
        "low",
    ))));
    harness.catalog.set_host(host.clone());
    let spawned = harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Review", "prompt": "Review.", "subagent_type": "reviewer"}),
        )
        .await;
    assert!(!spawned.is_error, "{}", text(&spawned));
    harness.started(1).await;

    *host.0.lock_unpoisoned() = reviewer_on("old-model", "max");
    harness.catalog.forget(&SessionId::new("sess_parent"));
    let refused = harness
        .call(
            "sess_parent",
            "SendMessage",
            json!({"to": "agent_1", "message": "Go on."}),
        )
        .await;
    assert!(refused.is_error, "{}", text(&refused));
    assert_eq!(
        text(&refused),
        "Cannot start subagent: Reasoning level unsupported / 不支持所选思考档位 [reason=reasoning-level-not-supported; selection=e2e-provider/old-model]"
    );
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    assert_eq!(harness.seen().len(), 1);
}

/// Fork (node_desktop, specs/fork-rust-agent-parity.md "Subagents launch no subagents"): a desktop subagent's tools
/// have no Agent, SendMessage or ListAgents (Node child runtimes run with `subagents.enabled: false`); TaskStop stays.
#[tokio::test]
async fn a_desktop_subagent_gets_no_subagent_tools() {
    let harness = desktop_harness();
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Look around", "prompt": "Look around.", "subagent_type": "general-purpose"}),
        )
        .await;
    let tools = &harness.started(1).await[0].tools;
    for name in ["Agent", "SendMessage", "ListAgents"] {
        assert!(!tools.iter().any(|tool| tool == name), "{name}: {tools:?}");
    }
    assert!(tools.iter().any(|tool| tool == "TaskStop"), "{tools:?}");
}
