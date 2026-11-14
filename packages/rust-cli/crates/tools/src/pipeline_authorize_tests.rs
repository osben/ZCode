//! Fork: specs/fork-rust-node-helper.md F3, `helper/authorizeAppTool`.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::app_tool::AppToolRefusal;
use rust_cli_kernel_api::env::{EnvPath, OperationContext, Origin, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, Generation, OperationId, RunId, SessionId};
use rust_cli_kernel_api::orchestration::{
    HookEvent, HookEventName, HookOutcome, HookRunner, PermissionAnswer,
};
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::testing::{
    FixedGate, ScriptedInteractions, UnusedEnvironment, controller_services, machine,
};
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::super::Pipeline;

/// An App tool: one required string; its call never runs.
struct AppTool;

#[async_trait]
impl Tool for AppTool {
    fn name(&self) -> &str {
        "mcp__plugin_viewer_view__search"
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]})
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
        unreachable!("authorization never runs the tool")
    }
}

/// Records the hook events; PreToolUse answers `pre`.
#[derive(Default)]
struct Hooks {
    seen: Mutex<Vec<HookEventName>>,
    pre: HookOutcome,
}

#[async_trait]
impl HookRunner for Hooks {
    async fn run(&self, event: HookEvent, _cancel: CancellationToken) -> HookOutcome {
        let name = event.name;
        self.seen.lock().unwrap().push(name);
        if name == HookEventName::PreToolUse {
            self.pre.clone()
        } else {
            HookOutcome::default()
        }
    }
}

fn context(answer: PermissionAnswer) -> ToolUseContext {
    let env = Arc::new(UnusedEnvironment);
    ToolUseContext {
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/work"),
        },
        machine: machine(env.clone()),
        controller: controller_services(env),
        interactions: Arc::new(ScriptedInteractions::always(answer)),
        session_ops: Arc::new(rust_cli_kernel_api::testing::NoSession),
        operation: OperationContext::new(
            EnvironmentId::new("local"),
            Generation::new("g1"),
            OperationId::new("op_1"),
            Origin::User {
                session: Some(SessionId::new("sess_1")),
            },
        ),
        run: RunId::new("run_1"),
        ..rust_cli_kernel_api::testing::tool_use_context()
    }
}

fn allow() -> PermissionAnswer {
    PermissionAnswer::Allow {
        remember: Vec::new(),
    }
}

async fn authorize(
    decision: PermissionDecision,
    hooks: Hooks,
    answer: PermissionAnswer,
    input: Value,
) -> (Result<Value, AppToolRefusal>, Vec<HookEventName>) {
    let hooks = Arc::new(hooks);
    let pipeline = Pipeline::new(Arc::new(FixedGate(decision)), hooks.clone());
    let result = pipeline.authorize(&AppTool, input, context(answer)).await;
    let seen = hooks.seen.lock().unwrap().clone();
    (result, seen)
}

fn allowed() -> PermissionDecision {
    PermissionDecision::Allow {
        updated_input: None,
    }
}

#[tokio::test]
async fn an_allowed_call_answers_its_input_after_pre_tool_use_only() {
    let input = json!({"query": "q"});
    let (result, seen) = authorize(allowed(), Hooks::default(), allow(), input.clone()).await;
    assert_eq!(result, Ok(input));
    assert_eq!(seen, [HookEventName::PreToolUse]);
}

#[tokio::test]
async fn invalid_input_is_invalid_input_before_any_hook() {
    let (result, seen) = authorize(allowed(), Hooks::default(), allow(), json!({})).await;
    match result {
        Err(AppToolRefusal::InvalidInput(message)) => {
            assert!(message.contains("`query` is missing"), "{message}")
        }
        other => panic!("unexpected: {other:?}"),
    }
    assert!(seen.is_empty());
}

#[tokio::test]
async fn a_gate_denial_and_a_user_denial_are_permission_denied() {
    let denied = PermissionDecision::Deny {
        message: "Permission to use mcp__plugin_viewer_view__search has been denied.".to_owned(),
    };
    let (result, _) = authorize(denied, Hooks::default(), allow(), json!({"query": "q"})).await;
    assert_eq!(
        result,
        Err(AppToolRefusal::PermissionDenied(
            "Permission to use mcp__plugin_viewer_view__search has been denied.".to_owned()
        ))
    );
    let ask = PermissionDecision::ask("search?", Vec::new());
    let (result, seen) = authorize(
        ask,
        Hooks::default(),
        PermissionAnswer::Deny { feedback: None },
        json!({"query": "q"}),
    )
    .await;
    assert!(matches!(result, Err(AppToolRefusal::PermissionDenied(_))));
    assert_eq!(
        seen,
        [HookEventName::PreToolUse, HookEventName::PermissionRequest]
    );
}

#[tokio::test]
async fn an_approved_prompt_answers_the_input() {
    let ask = PermissionDecision::ask("search?", Vec::new());
    let input = json!({"query": "q"});
    let (result, _) = authorize(ask, Hooks::default(), allow(), input.clone()).await;
    assert_eq!(result, Ok(input));
}

#[tokio::test]
async fn a_hook_updated_input_is_the_answer_and_a_hook_denial_is_permission_denied() {
    let updated = Hooks {
        pre: HookOutcome {
            updated_input: Some(json!({"query": "changed"})),
            ..HookOutcome::default()
        },
        ..Hooks::default()
    };
    let (result, _) = authorize(allowed(), updated, allow(), json!({"query": "q"})).await;
    assert_eq!(result, Ok(json!({"query": "changed"})));
    let denying = Hooks {
        pre: HookOutcome {
            decision: Some(PermissionDecision::Deny {
                message: "blocked by policy".to_owned(),
            }),
            ..HookOutcome::default()
        },
        ..Hooks::default()
    };
    let (result, _) = authorize(allowed(), denying, allow(), json!({"query": "q"})).await;
    assert_eq!(
        result,
        Err(AppToolRefusal::PermissionDenied(
            "blocked by policy".to_owned()
        ))
    );
}

#[tokio::test]
async fn an_incognito_gate_refuses_before_any_hook() {
    struct HidesAll;
    impl rust_cli_kernel_api::incognito::IncognitoToolGate for HidesAll {
        fn hides(&self, _session: &SessionId, _tool: &dyn Tool) -> bool {
            true
        }
    }
    let hooks = Arc::new(Hooks::default());
    let pipeline = Pipeline::new(Arc::new(FixedGate(allowed())), hooks.clone())
        .with_incognito(Arc::new(HidesAll));
    let result = pipeline
        .authorize(&AppTool, json!({"query": "q"}), context(allow()))
        .await;
    assert!(matches!(result, Err(AppToolRefusal::PermissionDenied(_))));
    assert!(hooks.seen.lock().unwrap().is_empty());
}
