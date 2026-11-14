//! 管线里的 hooks（docs/specs/rust-cli/hooks.md §6）：PreToolUse 与判决链的先后、PermissionRequest、
//! PostToolUse 的替换与消息、停止请求。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvPath, OperationContext, Origin, WorkspaceRef};
use rust_cli_kernel_api::hooks::{HookEvent, HookOutcome};
use rust_cli_kernel_api::ids::{
    EnvironmentId, Generation, MessageId, OperationId, RunId, SessionId,
};
use rust_cli_kernel_api::message::{AttachmentMessage, Message};
use rust_cli_kernel_api::orchestration::InteractionRequest;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::{
    ScriptedInteractions, UnusedEnvironment, controller_services, machine,
};
use rust_cli_kernel_api::tool::PromptContext;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::*;

/// 回显 `command` 的工具；schema 要求 `command` 是字符串。
struct Echo;

#[async_trait]
impl Tool for Echo {
    fn name(&self) -> &str {
        "Bash"
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]})
    }
    fn description(&self, _context: &PromptContext) -> String {
        String::new()
    }
    async fn call(
        &self,
        input: Value,
        _context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        Ok(ToolOutput {
            content: vec![ToolResultContent::Text {
                text: format!("ran {}", input["command"].as_str().unwrap_or_default()),
            }],
            is_error: false,
            display: Value::Null,
        })
    }
}

/// 判决链替身：`decide` 与 `check_rules` 都是固定值，并记录 decide 是否被调用。
struct Gate {
    decide: PermissionDecision,
    rules: Option<PermissionDecision>,
    decided: Mutex<u32>,
}

impl Gate {
    fn new(decide: PermissionDecision, rules: Option<PermissionDecision>) -> Arc<Self> {
        Arc::new(Self {
            decide,
            rules,
            decided: Mutex::new(0),
        })
    }
}

#[async_trait]
impl PermissionGate for Gate {
    async fn decide(&self, _t: &dyn Tool, _i: &Value, _c: &ToolUseContext) -> PermissionDecision {
        *self.decided.lock().unwrap() += 1;
        self.decide.clone()
    }
    async fn local_rules_committed(&self, _w: &WorkspaceRef) {}
    async fn check_rules(
        &self,
        _t: &dyn Tool,
        _i: &Value,
        _c: &ToolUseContext,
    ) -> Option<PermissionDecision> {
        self.rules.clone()
    }
}

/// 按事件名回答固定结果的 hooks，并记录收到的事件。
#[derive(Default)]
struct Hooks {
    outcomes: HashMap<HookEventName, HookOutcome>,
    seen: Mutex<Vec<HookEvent>>,
}

#[async_trait]
impl HookRunner for Hooks {
    async fn run(&self, event: HookEvent, _cancel: CancellationToken) -> HookOutcome {
        let outcome = self.outcomes.get(&event.name).cloned().unwrap_or_default();
        self.seen.lock().unwrap().push(event);
        outcome
    }
}

fn context(asked: Arc<ScriptedInteractions>) -> ToolUseContext {
    let env = Arc::new(UnusedEnvironment);
    ToolUseContext {
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/work"),
        },
        mode: PermissionMode::AcceptEdits,
        base_mode: PermissionMode::AcceptEdits,
        machine: machine(env.clone()),
        controller: controller_services(env),
        interactions: asked,
        session_ops: Arc::new(rust_cli_kernel_api::testing::NoSession),
        operation: OperationContext::new(
            EnvironmentId::new("local"),
            Generation::new("g1"),
            OperationId::new("op_1"),
            Origin::Agent {
                session: SessionId::new("sess_1"),
                run: RunId::new("run_1"),
            },
        ),
        ..rust_cli_kernel_api::testing::tool_use_context()
    }
}

fn note(source: &str, text: &str) -> Message {
    Message::Attachment(AttachmentMessage {
        id: MessageId::new(text),
        source: source.to_owned(),
        text: text.to_owned(),
        data: Value::Null,
    })
}

struct Ran {
    execution: ToolExecution,
    asked: Vec<String>,
    decided: u32,
    events: Vec<HookEvent>,
}

async fn run(gate: Arc<Gate>, outcomes: &[(HookEventName, HookOutcome)]) -> Ran {
    run_ordered(gate, outcomes, false).await
}

async fn run_ordered(
    gate: Arc<Gate>,
    outcomes: &[(HookEventName, HookOutcome)],
    node_hooks: bool,
) -> Ran {
    let hooks = Arc::new(Hooks {
        outcomes: outcomes.iter().cloned().collect(),
        ..Hooks::default()
    });
    let asked = Arc::new(ScriptedInteractions::allowing());
    let pipeline = Pipeline::new(gate.clone(), hooks.clone()).with_node_hooks(node_hooks);
    let (progress, _updates) = mpsc::channel(4);
    let execution = pipeline
        .execute(
            Arc::new(Echo),
            json!({"command": "ls"}),
            context(asked.clone()),
            progress,
        )
        .await;
    let events = hooks.seen.lock().unwrap().drain(..).collect();
    let decided = *gate.decided.lock().unwrap();
    let asked = asked
        .asked()
        .into_iter()
        .filter_map(|request| match request {
            InteractionRequest::Permission { message, .. } => Some(message),
            _ => None,
        })
        .collect();
    Ran {
        execution,
        asked,
        decided,
        events,
    }
}

fn text(output: &ToolOutput) -> String {
    match &output.content[0] {
        ToolResultContent::Text { text } => text.clone(),
        other => panic!("{other:?}"),
    }
}

fn ask_gate() -> Arc<Gate> {
    Gate::new(PermissionDecision::ask("chain asks", Vec::new()), None)
}

fn pre(
    decision: Option<PermissionDecision>,
    updated: Option<Value>,
) -> (HookEventName, HookOutcome) {
    (
        HookEventName::PreToolUse,
        HookOutcome {
            decision,
            updated_input: updated,
            ..HookOutcome::default()
        },
    )
}

#[tokio::test]
async fn hook_allow_skips_the_prompt_unless_rules_say_otherwise() {
    let allow = Some(PermissionDecision::Allow {
        updated_input: None,
    });
    let ran = run(
        ask_gate(),
        &[pre(allow.clone(), Some(json!({"command": "pwd"})))],
    )
    .await;
    assert_eq!(text(&ran.execution.output), "ran pwd");
    assert!(ran.asked.is_empty() && ran.decided == 0);
    // deny 规则仍然生效。
    let denied = Gate::new(
        PermissionDecision::Passthrough,
        Some(PermissionDecision::Deny {
            message: "rule says no".to_owned(),
        }),
    );
    let ran = run(denied, &[pre(allow.clone(), None)]).await;
    assert_eq!(text(&ran.execution.output), "rule says no");
    // ask 规则：走完整判决链。
    let rule_ask = Gate::new(
        PermissionDecision::ask("chain asks", Vec::new()),
        Some(PermissionDecision::ask("rule", Vec::new())),
    );
    let ran = run(rule_ask, &[pre(allow, None)]).await;
    assert_eq!(
        (ran.decided, ran.asked.as_slice()),
        (1, ["chain asks".to_owned()].as_slice())
    );
}

#[tokio::test]
async fn hook_ask_and_deny() {
    let ask = Some(PermissionDecision::ask("hook asks", Vec::new()));
    let ran = run(ask_gate(), &[pre(ask, None)]).await;
    assert_eq!(ran.asked, ["hook asks"]);
    assert_eq!(ran.decided, 0);
    let deny = Some(PermissionDecision::Deny {
        message: "PreToolUse:Bash hook error: [g]: no".to_owned(),
    });
    let ran = run(ask_gate(), &[pre(deny, None)]).await;
    assert!(ran.execution.output.is_error);
    assert_eq!(
        text(&ran.execution.output),
        "PreToolUse:Bash hook error: [g]: no"
    );
    // 没有决定：完整判决链，passthrough 的 updatedInput 生效。
    let ran = run(ask_gate(), &[pre(None, Some(json!({"command": "whoami"})))]).await;
    assert_eq!(
        (ran.decided, text(&ran.execution.output).as_str()),
        (1, "ran whoami")
    );
}

#[tokio::test]
async fn invalid_updated_input_is_denied() {
    let ran = run(ask_gate(), &[pre(None, Some(json!({"command": 1})))]).await;
    assert!(text(&ran.execution.output).starts_with(
        "PreToolUse hook for Bash returned updatedInput that failed schema validation: "
    ));
}

#[tokio::test]
async fn permission_request_hooks_answer_before_the_user() {
    let allow = (
        HookEventName::PermissionRequest,
        HookOutcome {
            decision: Some(PermissionDecision::Allow {
                updated_input: None,
            }),
            updated_input: Some(json!({"command": "id"})),
            ..HookOutcome::default()
        },
    );
    let ran = run(ask_gate(), &[allow]).await;
    assert_eq!(text(&ran.execution.output), "ran id");
    assert!(ran.asked.is_empty());
    let deny = (
        HookEventName::PermissionRequest,
        HookOutcome {
            decision: Some(PermissionDecision::Deny {
                message: "Permission denied by hook".to_owned(),
            }),
            ..HookOutcome::default()
        },
    );
    let ran = run(ask_gate(), &[deny]).await;
    assert_eq!(text(&ran.execution.output), "Permission denied by hook");
    let names: Vec<_> = ran.events.iter().map(|e| e.name).collect();
    assert_eq!(
        names,
        [HookEventName::PreToolUse, HookEventName::PermissionRequest]
    );
    assert_eq!(
        ran.events[1].payload,
        json!({"tool_name": "Bash", "tool_input": {"command": "ls"}})
    );
}

#[tokio::test]
async fn hook_messages_and_stops_surround_the_result() {
    let allow_gate = Gate::new(
        PermissionDecision::Allow {
            updated_input: None,
        },
        None,
    );
    let pre_outcome = HookOutcome {
        messages: vec![note("hook_additional_context", "pre ctx")],
        after_result: vec![note("hook_stopped_continuation", "pre stop")],
        prevent_continuation: true,
        ..HookOutcome::default()
    };
    let post_outcome = HookOutcome {
        messages: vec![note("hook_additional_context", "post ctx")],
        updated_tool_output: Some(json!("rewritten")),
        ..HookOutcome::default()
    };
    let ran = run(
        allow_gate,
        &[
            (HookEventName::PreToolUse, pre_outcome),
            (HookEventName::PostToolUse, post_outcome),
        ],
    )
    .await;
    assert_eq!(text(&ran.execution.output), "rewritten");
    assert_eq!(ids(&ran.execution.before), ["pre ctx"]);
    assert_eq!(ids(&ran.execution.after), ["post ctx", "pre stop"]);
    assert!(ran.execution.prevent_continuation);
    // 公共字段：模式与运行。
    let context = &ran.events[0].context;
    assert_eq!(context.mode, Some(PermissionMode::AcceptEdits));
    assert_eq!(context.run.as_ref().map(RunId::as_str), Some("run_1"));
    assert_eq!(
        ran.events[1].payload["tool_response"],
        json!([{"type": "text", "text": "ran ls"}])
    );
}

fn ids(messages: &[Message]) -> Vec<String> {
    messages
        .iter()
        .map(|m| m.id().as_str().to_owned())
        .collect()
}

fn context_outcome(text: &str) -> HookOutcome {
    HookOutcome {
        messages: vec![note("hook_additional_context", text)],
        ..HookOutcome::default()
    }
}

/// Fork: Node delivers tool hook contexts after the tool result, PreToolUse before PostToolUse
/// (specs/fork-rust-agent-parity.md "Tool hook context after the tool result").
#[tokio::test]
async fn under_node_hooks_the_pre_tool_context_follows_the_result() {
    let allow_gate = Gate::new(
        PermissionDecision::Allow {
            updated_input: None,
        },
        None,
    );
    let pre_outcome = HookOutcome {
        after_result: vec![note("hook_stopped_continuation", "pre stop")],
        prevent_continuation: true,
        ..context_outcome("pre ctx")
    };
    let ran = run_ordered(
        allow_gate,
        &[
            (HookEventName::PreToolUse, pre_outcome),
            (HookEventName::PostToolUse, context_outcome("post ctx")),
        ],
        true,
    )
    .await;
    assert_eq!(text(&ran.execution.output), "ran ls");
    assert!(ran.execution.before.is_empty());
    assert_eq!(
        ids(&ran.execution.after),
        ["pre ctx", "post ctx", "pre stop"]
    );
    assert!(ran.execution.prevent_continuation);
}

/// Fork: a refused call keeps its PreToolUse context after the refusal: a hook deny, an `updatedInput` that fails the
/// schema, and a permission deny (E2E HK-EF-01).
#[tokio::test]
async fn under_node_hooks_a_refused_call_keeps_its_pre_tool_context_after_the_result() {
    let allow_gate = || {
        Gate::new(
            PermissionDecision::Allow {
                updated_input: None,
            },
            None,
        )
    };
    let denied = HookOutcome {
        decision: Some(PermissionDecision::Deny {
            message: "hook says no".to_owned(),
        }),
        ..context_outcome("deny ctx")
    };
    let invalid = HookOutcome {
        updated_input: Some(json!({"command": 7})),
        ..context_outcome("invalid ctx")
    };
    let chain_deny = Gate::new(
        PermissionDecision::Deny {
            message: "chain says no".to_owned(),
        },
        None,
    );
    for (gate, outcome, context) in [
        (allow_gate(), denied, "deny ctx"),
        (allow_gate(), invalid, "invalid ctx"),
        (chain_deny, context_outcome("chain ctx"), "chain ctx"),
    ] {
        let ran = run_ordered(gate, &[(HookEventName::PreToolUse, outcome)], true).await;
        assert!(ran.execution.output.is_error, "{context}");
        assert!(ran.execution.before.is_empty(), "{context}");
        assert_eq!(ids(&ran.execution.after), [context]);
    }
}

#[tokio::test]
async fn non_hook_rejections_drop_the_pre_tool_stop() {
    let deny_gate = Gate::new(
        PermissionDecision::Deny {
            message: "chain says no".to_owned(),
        },
        None,
    );
    let pre_outcome = HookOutcome {
        after_result: vec![note("hook_stopped_continuation", "pre stop")],
        prevent_continuation: true,
        ..HookOutcome::default()
    };
    let ran = run(deny_gate, &[(HookEventName::PreToolUse, pre_outcome)]).await;
    assert_eq!(text(&ran.execution.output), "chain says no");
    assert!(ran.execution.after.is_empty() && !ran.execution.prevent_continuation);
}

/// Node `processHookOutput` + `call-runner.ts`: a PreToolUse `continue: false` refuses the call. The fold hands the
/// pipeline a deny with the stop, so the tool handler (`Echo`, which answers `ran <command>`) is never invoked.
#[tokio::test]
async fn a_pre_tool_use_stop_refuses_before_the_tool_runs() {
    let allow_gate = Gate::new(
        PermissionDecision::Allow {
            updated_input: None,
        },
        None,
    );
    let pre_outcome = HookOutcome {
        decision: Some(PermissionDecision::Deny {
            message: "frozen".to_owned(),
        }),
        after_result: vec![note("hook_stopped_continuation", "pre stop")],
        prevent_continuation: true,
        ..HookOutcome::default()
    };
    let ran = run(allow_gate, &[(HookEventName::PreToolUse, pre_outcome)]).await;
    assert_eq!(text(&ran.execution.output), "frozen");
    assert_eq!(ids(&ran.execution.after), ["pre stop"]);
    assert!(ran.execution.prevent_continuation);
}

/// 修复线 F20：guarded 的危险命令只批准这一次（Node user-once）：PermissionRequest hook 不能替用户批准，
/// 不跑这个事件，直接问用户。工作线 F137：判决链的询问带 `once`（以前是单独的 `ask_once`）。
#[tokio::test]
async fn ask_once_questions_skip_permission_request_hooks() {
    let allow = (
        HookEventName::PermissionRequest,
        HookOutcome {
            decision: Some(PermissionDecision::Allow {
                updated_input: None,
            }),
            ..HookOutcome::default()
        },
    );
    let gate = Gate::new(
        PermissionDecision::Ask {
            message: "Dangerous command requires your approval for this execution".to_owned(),
            suggestions: Vec::new(),
            once: true,
            independent: false,
        },
        None,
    );
    let ran = run(gate, &[allow]).await;
    assert_eq!(
        ran.asked,
        ["Dangerous command requires your approval for this execution"]
    );
    let names: Vec<_> = ran.events.iter().map(|e| e.name).collect();
    assert!(
        !names.contains(&HookEventName::PermissionRequest),
        "{names:?}"
    );
}

/// An independent ask (Plan mode's MCP ask, Node `optionsPolicy: "no-always-allow"` without `user-once`) still runs
/// PermissionRequest hooks, and a hook may answer it before the user (Node `permission-flow.ts` `runHooks`).
#[tokio::test]
async fn an_independent_ask_runs_permission_request_hooks() {
    let allow = (
        HookEventName::PermissionRequest,
        HookOutcome {
            decision: Some(PermissionDecision::Allow {
                updated_input: None,
            }),
            ..HookOutcome::default()
        },
    );
    let gate = Gate::new(
        PermissionDecision::Ask {
            message: "Plan mode requires approval".to_owned(),
            suggestions: Vec::new(),
            once: false,
            independent: true,
        },
        None,
    );
    let ran = run(gate, &[allow]).await;
    assert!(ran.asked.is_empty(), "{:?}", ran.asked);
    assert_eq!(text(&ran.execution.output), "ran ls");
    let names: Vec<_> = ran.events.iter().map(|e| e.name).collect();
    assert!(
        names.contains(&HookEventName::PermissionRequest),
        "{names:?}"
    );
}

/// A tool whose call alone was stopped (`ToolError::Stopped`, a foreground subagent stopped by the user).
struct StoppedTool;

#[async_trait]
impl Tool for StoppedTool {
    fn name(&self) -> &str {
        "Agent"
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }
    fn description(&self, _context: &PromptContext) -> String {
        String::new()
    }
    async fn call(
        &self,
        _input: Value,
        _context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        Err(ToolError::Stopped {
            message: "Subagent was stopped by user".to_owned(),
            display: json!({"agent": {"agentId": "agent_1", "status": "killed"}}),
        })
    }
}

/// Codex review of #418 @dc4b08512 (1): a stopped call runs the failure hooks as an interrupt (Node `isInterrupt`), never
/// PostToolUse (whose `updatedToolOutput` could rewrite it), reaches the model as its own message and keeps its display.
#[tokio::test]
async fn a_stopped_call_is_an_interrupted_failure_that_keeps_its_display() {
    let hooks = Arc::new(Hooks::default());
    let pipeline = Pipeline::new(
        Gate::new(
            PermissionDecision::Allow {
                updated_input: None,
            },
            None,
        ),
        hooks.clone(),
    );
    let (progress, _updates) = mpsc::channel(4);
    let execution = pipeline
        .execute(
            Arc::new(StoppedTool),
            json!({}),
            context(Arc::new(ScriptedInteractions::allowing())),
            progress,
        )
        .await;
    let output = &execution.output;
    assert!(output.is_error);
    assert_eq!(text(output), "Subagent was stopped by user");
    assert_eq!(output.display["agent"]["status"], "killed");
    let events = hooks.seen.lock().unwrap().clone();
    assert!(
        events
            .iter()
            .all(|event| event.name != HookEventName::PostToolUse),
        "{events:?}"
    );
    let failure = events
        .iter()
        .find(|event| event.name == HookEventName::PostToolUseFailure)
        .expect("the failure hook ran");
    assert_eq!(failure.payload["is_interrupt"], true);
    assert_eq!(failure.payload["error"], "Subagent was stopped by user");
}

/// Fork: under Node hooks the PermissionRequest input names the call (Node `toolCallId` / `tool_use_id`); the
/// Claude Code input keeps it out (`permission_request_hooks_answer_before_the_user`).
#[tokio::test]
async fn under_node_hooks_the_permission_request_names_the_tool_call() {
    let deny = (
        HookEventName::PermissionRequest,
        HookOutcome {
            decision: Some(PermissionDecision::Deny {
                message: "Permission denied by hook".to_owned(),
            }),
            ..HookOutcome::default()
        },
    );
    let ran = run_ordered(ask_gate(), std::slice::from_ref(&deny), true).await;
    assert_eq!(ran.events[1].name, HookEventName::PermissionRequest);
    let id = &ran.events[0].payload["tool_use_id"];
    assert!(id.is_string(), "{id:?}");
    assert_eq!(&ran.events[1].payload["tool_use_id"], id);
    let claude = run_ordered(ask_gate(), &[deny], false).await;
    assert_eq!(claude.events[1].name, HookEventName::PermissionRequest);
    assert!(claude.events[1].payload.get("tool_use_id").is_none());
}

/// Fork: under Node hooks the failure input carries Node's `error_details` (`{message, type}`, the CoreError type);
/// the Claude Code input has only `error` (specs/fork-rust-agent-parity.md "Command hook stdin").
#[tokio::test]
async fn under_node_hooks_a_failure_names_its_error_type() {
    // Node passes the raw `error.message` (`hook-flow.ts` `runPostToolUseFailureHooks`, `configured-runner-input.ts`);
    // the model still gets the trimmed, length-limited text.
    let long = format!("  {}  ", "x".repeat(12_000));
    let failures = [
        (
            ToolError::Stopped {
                message: "stopped".to_owned(),
                display: Value::Null,
            },
            "tool_cancelled",
            "stopped".to_owned(),
        ),
        (
            ToolError::Cancelled,
            "tool_cancelled",
            "Tool execution cancelled".to_owned(),
        ),
        (
            ToolError::InvalidInput {
                message: "bad".to_owned(),
            },
            "invalid_input",
            "bad".to_owned(),
        ),
        (
            ToolError::Failed {
                message: "boom".to_owned(),
            },
            "tool_execution_failed",
            "boom".to_owned(),
        ),
        (
            ToolError::Failed {
                message: long.clone(),
            },
            "tool_execution_failed",
            long.clone(),
        ),
    ];
    for (failure, kind, message) in failures {
        for node_hooks in [true, false] {
            let hooks = Arc::new(Hooks::default());
            let pipeline = Pipeline::new(
                Gate::new(
                    PermissionDecision::Allow {
                        updated_input: None,
                    },
                    None,
                ),
                hooks.clone(),
            )
            .with_node_hooks(node_hooks);
            let (progress, _updates) = mpsc::channel(4);
            let tool = Arc::new(Failing(Mutex::new(Some(failure.clone()))));
            let executed = pipeline
                .execute(
                    tool,
                    json!({}),
                    context(Arc::new(ScriptedInteractions::allowing())),
                    progress,
                )
                .await;
            let events = hooks.seen.lock().unwrap().clone();
            let payload = &events
                .iter()
                .find(|event| event.name == HookEventName::PostToolUseFailure)
                .expect("the failure hook ran")
                .payload;
            if node_hooks {
                assert_eq!(payload["error_details"]["type"], kind);
                assert_eq!(payload["error_details"]["message"], message.as_str());
                assert_eq!(payload["error"], message.as_str());
            } else {
                assert!(payload.get("error_details").is_none(), "{payload}");
            }
            if message == long {
                // The model's text is limited either way.
                let text = serde_json::to_string(&executed.output.content).unwrap();
                assert!(text.contains("characters truncated"), "{node_hooks}");
                if !node_hooks {
                    assert_ne!(payload["error"], message.as_str());
                }
            }
        }
    }
}

/// A tool that fails once with the given error.
struct Failing(Mutex<Option<ToolError>>);

#[async_trait]
impl Tool for Failing {
    fn name(&self) -> &str {
        "Agent"
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }
    fn description(&self, _context: &PromptContext) -> String {
        String::new()
    }
    async fn call(
        &self,
        _input: Value,
        _context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        Err(self.0.lock().unwrap().take().expect("called once"))
    }
}
