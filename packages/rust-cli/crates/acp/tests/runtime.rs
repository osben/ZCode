//! The runtime against the Rust port of the Node mock agent (`src/bin/acp_mock_agent.rs`).
#![allow(
    clippy::expect_used,
    clippy::disallowed_methods,
    reason = "integration test helpers: they read the mock's state file and fail loudly"
)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use rust_cli_proc::ledger::Ledger;
use serde_json::{Value, json};

use rust_cli_acp::{
    AcpError, AcpErrorCode, AcpLaunch, AcpRuntime, AcpRuntimeOptions, AcpState, AcpTimeouts,
    PermissionAnswer, PromptResponse, RuntimeEvent, SessionStart,
};

const MOCK: &str = env!("CARGO_BIN_EXE_acp-mock-agent");

struct Fixture {
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("tempdir"),
        }
    }

    fn state_file(&self) -> String {
        self.dir.path().join("state.json").display().to_string()
    }

    fn options(&self, args: &[&str], env: &[(&str, &str)]) -> AcpRuntimeOptions {
        let mut all = vec!["--state".to_owned(), self.state_file()];
        all.extend(args.iter().map(|arg| (*arg).to_owned()));
        let env: BTreeMap<String, String> = env
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        AcpRuntimeOptions {
            launch: AcpLaunch {
                agent_id: "mock".to_owned(),
                command: MOCK.to_owned(),
                args: all,
                env: (!env.is_empty()).then_some(env),
                cwd: self.dir.path().display().to_string(),
            },
            env_snapshot: Arc::from(Vec::new()),
            ledger: Ledger::open(self.dir.path().join("ledger")),
            resume_session_id: None,
            timeouts: AcpTimeouts {
                cancel_grace: Duration::from_secs(5),
                stop_grace: Duration::from_millis(500),
                ..AcpTimeouts::default()
            },
        }
    }

    fn methods(&self) -> Vec<String> {
        let text = std::fs::read_to_string(self.state_file()).unwrap_or_default();
        let state: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        state["methods"]
            .as_array()
            .map(|methods| {
                methods
                    .iter()
                    .filter_map(|method| method.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn text(prompt: &str) -> Vec<Value> {
    vec![json!({"type": "text", "text": prompt})]
}

/// Runs one prompt and collects its events; permission asks are answered with `answer`.
async fn run(
    runtime: &AcpRuntime,
    prompt: &str,
    answer: Option<PermissionAnswer>,
) -> (Result<PromptResponse, AcpError>, Vec<String>) {
    let (mut events, _guard) = runtime.bind();
    let request = runtime.prompt(text(prompt));
    tokio::pin!(request);
    let mut seen = Vec::new();
    let result = loop {
        tokio::select! {
            result = &mut request => break result,
            Some(event) = events.recv() => seen.push(describe(event, answer.clone())),
        }
    };
    while let Ok(event) = events.try_recv() {
        seen.push(describe(event, answer.clone()));
    }
    (result, seen)
}

fn describe(event: RuntimeEvent, answer: Option<PermissionAnswer>) -> String {
    match event {
        RuntimeEvent::MessageChunk(text) => format!("message:{text}"),
        RuntimeEvent::ThoughtChunk(text) => format!("thought:{text}"),
        RuntimeEvent::ToolCall(info) => format!(
            "tool:{}:{}:{}",
            info.tool_call_id,
            info.title,
            info.status.unwrap_or_default()
        ),
        RuntimeEvent::ToolCallUpdate(info) => format!(
            "tool_update:{}:{}:{}",
            info.tool_call_id,
            info.status.clone().unwrap_or_default(),
            info.output_text().unwrap_or_default()
        ),
        RuntimeEvent::Plan(entries) => format!("plan:{}", entries.len()),
        RuntimeEvent::SessionTitle(title) => format!("title:{title}"),
        RuntimeEvent::AvailableCommands(count) => format!("commands:{count}"),
        RuntimeEvent::ConfigOptions(options) => format!("config:{}", options.len()),
        RuntimeEvent::Stalled { .. } => "stalled".to_owned(),
        RuntimeEvent::Resumed => "resumed".to_owned(),
        RuntimeEvent::Permission { ask, reply } => {
            if let Some(answer) = answer {
                let _ = reply.send(answer);
            }
            format!(
                "permission:{}:{}",
                ask.title,
                ask.detail.unwrap_or_default()
            )
        }
    }
}

#[tokio::test]
async fn a_prompt_streams_the_reply_and_ends_the_turn() {
    let fixture = Fixture::new();
    let runtime = AcpRuntime::start(fixture.options(&[], &[]))
        .await
        .expect("start");
    assert_eq!(runtime.state(), AcpState::Ready);
    assert_eq!(
        runtime.session_id().as_deref(),
        Some("services-mock-session")
    );
    assert_eq!(runtime.take_session_start(), Some(SessionStart::Created));
    assert_eq!(runtime.take_session_start(), None);
    let (result, events) = run(&runtime, "hello", None).await;
    assert_eq!(result.expect("prompt").stop_reason, "end_turn");
    assert_eq!(events, ["message:pong"]);
    assert_eq!(runtime.state(), AcpState::Ready);
    runtime.stop().await;
    assert_eq!(runtime.state(), AcpState::Stopped);
    assert_eq!(
        fixture.methods(),
        ["process-start", "session/new", "session/prompt"]
    );
}

#[tokio::test]
async fn tools_plans_and_titles_arrive_in_order() {
    let fixture = Fixture::new();
    let runtime = AcpRuntime::start(fixture.options(&[], &[]))
        .await
        .expect("start");
    let (_, tool) = run(&runtime, "use a tool", None).await;
    assert_eq!(
        tool,
        [
            "tool:tool-1:Read a.txt:in_progress",
            "tool_update:tool-1:completed:file body",
            "message:tool finished"
        ]
    );
    let (_, plan) = run(&runtime, "make a plan", None).await;
    assert_eq!(plan, ["plan:3", "message:planned"]);
    let (_, title) = run(&runtime, "set a title", None).await;
    assert_eq!(title, ["title:Parser fix from ACP", "message:titled"]);
    runtime.stop().await;
}

#[tokio::test]
async fn permission_answers_reach_the_agent() {
    let fixture = Fixture::new();
    let runtime = AcpRuntime::start(fixture.options(&[], &[]))
        .await
        .expect("start");
    let allow = PermissionAnswer::Selected {
        kind: "allow_once".to_owned(),
    };
    let (result, events) = run(&runtime, "permission please", Some(allow)).await;
    assert_eq!(result.expect("prompt").stop_reason, "end_turn");
    assert_eq!(
        events,
        [
            "permission:Run the tests:pnpm test",
            "message:permission granted"
        ]
    );
    let reject = PermissionAnswer::Selected {
        kind: "reject_once".to_owned(),
    };
    let (_, events) = run(&runtime, "permission please", Some(reject)).await;
    assert_eq!(events[1], "message:permission denied");
    // A dropped reply answers cancelled.
    let (result, _) = run(&runtime, "permission please", None).await;
    assert_eq!(result.expect("prompt").stop_reason, "cancelled");
    // No bound turn: the ask is cancelled without reaching anyone.
    let result = runtime.prompt(text("permission please")).await;
    assert_eq!(result.expect("prompt").stop_reason, "cancelled");
    runtime.stop().await;
}

#[tokio::test]
async fn cancel_settles_a_hanging_prompt_and_reports_the_stall() {
    let fixture = Fixture::new();
    let mut options = fixture.options(&[], &[]);
    options.timeouts.stall_warning = Duration::from_millis(200);
    let runtime = AcpRuntime::start(options).await.expect("start");
    let (mut events, _guard) = runtime.bind();
    let request = runtime.prompt(text("please hang"));
    tokio::pin!(request);
    let mut seen = Vec::new();
    let stalled = loop {
        tokio::select! {
            result = &mut request => panic!("settled early: {result:?}"),
            Some(event) = events.recv() => {
                let described = describe(event, None);
                if described == "stalled" { break described; }
                seen.push(described);
            }
        }
    };
    assert_eq!(stalled, "stalled");
    let canceller = runtime.clone();
    let cancel = tokio::spawn(async move { canceller.cancel().await });
    let result = request.await.expect("prompt");
    assert_eq!(result.stop_reason, "cancelled");
    cancel.await.expect("cancel");
    assert_eq!(
        describe(events.recv().await.expect("event"), None),
        "resumed"
    );
    assert_eq!(runtime.state(), AcpState::Ready);
    runtime.stop().await;
}

#[tokio::test]
async fn a_crash_fails_the_prompt_and_the_next_prompt_loads_the_session() {
    let fixture = Fixture::new();
    let runtime = AcpRuntime::start(fixture.options(&[], &[]))
        .await
        .expect("start");
    let _ = runtime.take_session_start();
    let (result, _) = run(&runtime, "crash now", None).await;
    let error = result.expect_err("crash");
    assert_eq!(error.code, AcpErrorCode::AgentDied, "{error}");
    assert_eq!(runtime.state(), AcpState::Failed);
    let (result, events) = run(&runtime, "hello again", None).await;
    assert_eq!(result.expect("prompt").stop_reason, "end_turn");
    // The replay of the loaded session is never surfaced.
    assert_eq!(events, ["message:pong"]);
    assert_eq!(runtime.take_session_start(), Some(SessionStart::Loaded));
    assert!(runtime.ignored_updates() >= 1);
    runtime.stop().await;
    assert_eq!(
        fixture.methods(),
        [
            "process-start",
            "session/new",
            "session/prompt",
            "process-start",
            "session/load",
            "session/prompt"
        ]
    );
}

#[tokio::test]
async fn a_session_that_cannot_be_loaded_is_reset() {
    let fixture = Fixture::new();
    let mut options = fixture.options(&["--refuse-load"], &[]);
    options.resume_session_id = Some("earlier".to_owned());
    let runtime = AcpRuntime::start(options).await.expect("start");
    assert_eq!(runtime.take_session_start(), Some(SessionStart::Reset));
    let mut options = fixture.options(&[], &[]);
    options.resume_session_id = Some("earlier".to_owned());
    let loaded = AcpRuntime::start(options).await.expect("start");
    assert_eq!(loaded.take_session_start(), Some(SessionStart::Loaded));
    assert_eq!(loaded.session_id().as_deref(), Some("earlier"));
    runtime.stop().await;
    loaded.stop().await;
}

#[tokio::test]
async fn config_options_are_validated_and_applied() {
    let fixture = Fixture::new();
    let runtime = AcpRuntime::start(fixture.options(&["--config", "options"], &[]))
        .await
        .expect("start");
    assert_eq!(runtime.config_options().len(), 2);
    let options = runtime.set_config_option("model", "m2").await.expect("set");
    assert_eq!(options[1].current_value, "m2");
    assert_eq!(runtime.handshake_config_options()[1].current_value, "m1");
    let error = runtime
        .set_config_option("model", "m9")
        .await
        .expect_err("not offered");
    assert_eq!(error.code, AcpErrorCode::InvalidConfig);
    runtime.stop().await;

    let legacy = AcpRuntime::start(fixture.options(&[], &[("ACP_MOCK_CONFIG", "legacy")]))
        .await
        .expect("start");
    assert_eq!(legacy.config_options()[0].id, "mode");
    let options = legacy.set_config_option("mode", "plan").await.expect("set");
    assert_eq!(options[0].current_value, "plan");
    legacy.stop().await;
    assert!(
        fixture
            .methods()
            .contains(&"session/set_config_option model=m2".to_owned())
    );
    assert!(
        fixture
            .methods()
            .contains(&"session/set_mode plan".to_owned())
    );
}

#[tokio::test]
async fn a_missing_command_fails_to_spawn() {
    let fixture = Fixture::new();
    let mut options = fixture.options(&[], &[]);
    options.launch.command = "/nonexistent/acp-agent".to_owned();
    let error = AcpRuntime::start(options).await.err().expect("spawn error");
    assert_eq!(error.code, AcpErrorCode::SpawnFailed);
    assert!(
        error
            .message
            .starts_with("Failed to spawn /nonexistent/acp-agent")
    );
}

#[tokio::test]
async fn stop_ends_a_runtime_whose_agent_stopped_reading() {
    let fixture = Fixture::new();
    let runtime = AcpRuntime::start(fixture.options(&["--deaf-after-session"], &[]))
        .await
        .expect("start");
    // Larger than any pipe buffer: the write blocks while the agent does not read.
    let prompt = runtime.prompt(text(&"x".repeat(4 << 20)));
    tokio::pin!(prompt);
    assert!(
        tokio::time::timeout(Duration::from_millis(300), &mut prompt)
            .await
            .is_err(),
        "the prompt cannot settle while the agent does not read"
    );
    tokio::time::timeout(Duration::from_secs(10), runtime.stop())
        .await
        .expect("stop ends even while a write to the agent is blocked");
    let error = tokio::time::timeout(Duration::from_secs(5), prompt)
        .await
        .expect("the prompt settles after stop")
        .expect_err("stopped");
    assert_ne!(error.code, AcpErrorCode::State);
}

#[tokio::test]
async fn an_answer_written_just_before_exit_settles_the_prompt() {
    let fixture = Fixture::new();
    let runtime = AcpRuntime::start(fixture.options(&[], &[]))
        .await
        .expect("start");
    // Each round the agent answers and exits at once; the next prompt restarts it.
    for round in 0..20 {
        let (result, _) = run(&runtime, "last words", None).await;
        let response = result.unwrap_or_else(|error| panic!("round {round}: {error:?}"));
        assert_eq!(response.stop_reason, "end_turn");
        // The exit is seen after the answer; the next prompt restarts the failed runtime.
        tokio::time::timeout(Duration::from_secs(5), async {
            while runtime.state() != AcpState::Failed {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the exit marks the runtime failed");
    }
    runtime.stop().await;
}

#[tokio::test]
async fn a_prompt_fails_when_the_agent_closed_its_stdin() {
    let fixture = Fixture::new();
    let runtime = AcpRuntime::start(fixture.options(&["--close-stdin-after-session"], &[]))
        .await
        .expect("start");
    let (result, _) = tokio::time::timeout(Duration::from_secs(10), run(&runtime, "hello", None))
        .await
        .expect("a write the agent can no longer read fails the prompt instead of hanging");
    let error = result.expect_err("stdin closed");
    assert_ne!(error.code, AcpErrorCode::State, "{error:?}");
    runtime.stop().await;
}

#[tokio::test]
async fn a_stopped_runtime_refuses_prompts() {
    let fixture = Fixture::new();
    let runtime = AcpRuntime::start(fixture.options(&[], &[]))
        .await
        .expect("start");
    runtime.stop().await;
    runtime.stop().await;
    let error = runtime.prompt(text("hello")).await.expect_err("stopped");
    assert_eq!(error.code, AcpErrorCode::State);
}
