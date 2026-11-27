//! Fork (specs/fork-rust-hook-script-entry.md, D24): an admitted project hook's entry script is read again right
//! before each run; only the trusted content runs (Node `verifyHookBeforeDispatch`).

use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::hooks::{HookEventName, HookOutcome};
use rust_cli_kernel_api::permission::PermissionDecision;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::config::{HookCommand, HookSource, HooksConfig};
use crate::node_config::NodeHooks;
use crate::script_entry::{ScriptCheck, ScriptState, ScriptVerifier};
use crate::test_support::{ScriptedEnv, event, ports, script};
use crate::{HookEngine, HookRunner};

const TRUSTED: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const BLOCKED: &str =
    "PreToolUse hook failed and its onError is \"deny\", so the tool call is blocked: ";

/// Answers one state and records where it was asked.
struct Verifier {
    state: ScriptState,
    asked: StdMutex<Vec<(String, String)>>,
}

#[async_trait]
impl ScriptVerifier for Verifier {
    async fn state(&self, workspace: &WorkspaceRef, path: &str) -> ScriptState {
        self.asked
            .lock()
            .unwrap()
            .push((workspace.root.as_str().to_owned(), path.to_owned()));
        self.state.clone()
    }
}

fn verifier(state: ScriptState) -> Arc<Verifier> {
    Arc::new(Verifier {
        state,
        asked: StdMutex::new(Vec::new()),
    })
}

/// A `PreToolUse` hook `./guard.sh` whose trusted entry script is `guard.sh` with [`TRUSTED`] content.
fn engine(env: Arc<ScriptedEnv>, hook: Value, scripts: Option<Arc<Verifier>>) -> HookEngine {
    let (hooks, warnings) = NodeHooks::from_json(&json!({
        "enabled": true,
        "events": {"PreToolUse": [{"matcher": "Bash", "hooks": [hook]}]}
    }));
    assert!(warnings.is_empty(), "{warnings:?}");
    let (mut settings, warnings) = hooks.user_settings();
    assert!(warnings.is_empty(), "{warnings:?}");
    for (_, matchers) in &mut settings.hooks {
        for matcher in matchers {
            for command in &mut matcher.hooks {
                if let HookCommand::Command(command) = command {
                    command.script = Some(ScriptCheck {
                        path: "guard.sh".to_owned(),
                        sha256: TRUSTED.to_owned(),
                    });
                }
            }
        }
    }
    let engine = HookEngine::with_config(
        ports(env),
        HooksConfig {
            version: 1,
            sources: vec![(HookSource::Project, settings)],
            ..HooksConfig::default()
        },
    );
    if let Some(scripts) = scripts {
        engine.set_script_verifier(scripts);
    }
    engine
}

fn guard(on_error: Option<&str>) -> Value {
    let mut hook = json!({"type": "command", "command": "./guard.sh"});
    if let Some(value) = on_error {
        hook["onError"] = json!(value);
    }
    hook
}

async fn pre_tool_use(engine: &HookEngine) -> HookOutcome {
    let pre = event(
        HookEventName::PreToolUse,
        json!({"tool_name": "Bash", "tool_input": {"command": "ls"}, "tool_use_id": "toolu_1"}),
    );
    engine.run(pre, CancellationToken::new()).await
}

fn started(env: &ScriptedEnv) -> usize {
    env.started().len()
}

#[tokio::test]
async fn the_trusted_content_runs_after_a_read_at_the_workspace_root() {
    let env = Arc::new(ScriptedEnv::with(&[("./guard.sh", script("", "no rm", 2))]));
    let scripts = verifier(ScriptState::File(TRUSTED.to_owned()));
    let hooks = engine(env.clone(), guard(None), Some(scripts.clone()));
    let outcome = pre_tool_use(&hooks).await;
    assert_eq!(started(&env), 1);
    assert_eq!(
        outcome.decision,
        Some(PermissionDecision::Deny {
            message: "no rm".to_owned()
        })
    );
    let workspace = crate::test_support::workspace();
    assert_eq!(
        *scripts.asked.lock().unwrap(),
        [(workspace.root.as_str().to_owned(), "guard.sh".to_owned())]
    );
}

#[tokio::test]
async fn a_changed_missing_or_unread_script_never_runs() {
    for (state, reason) in [
        (
            ScriptState::File("2".repeat(64)),
            "workspace_hook_declaration_changed",
        ),
        (ScriptState::Missing, "workspace_hook_script_unavailable"),
        (
            ScriptState::Unverifiable,
            "workspace_hook_script_unavailable",
        ),
    ] {
        let env = Arc::new(ScriptedEnv::with(&[("./guard.sh", script("", "", 0))]));
        let hooks = engine(env.clone(), guard(None), Some(verifier(state.clone())));
        let outcome = pre_tool_use(&hooks).await;
        assert_eq!(started(&env), 0, "{reason}");
        // Without `onError: "deny"` a refused hook lets the tool run.
        assert_eq!(outcome.decision, None, "{reason}");

        // With it, the refusal is a hook failure that blocks the tool, naming the reason.
        let env = Arc::new(ScriptedEnv::with(&[("./guard.sh", script("", "", 0))]));
        let hooks = engine(env.clone(), guard(Some("deny")), Some(verifier(state)));
        let outcome = pre_tool_use(&hooks).await;
        assert_eq!(started(&env), 0, "{reason}");
        assert_eq!(
            outcome.decision,
            Some(PermissionDecision::Deny {
                message: format!("{BLOCKED}{reason}")
            })
        );
    }
}

#[tokio::test]
async fn without_a_reader_the_script_is_unverifiable() {
    let env = Arc::new(ScriptedEnv::with(&[("./guard.sh", script("", "", 0))]));
    let hooks = engine(env.clone(), guard(Some("deny")), None);
    let outcome = pre_tool_use(&hooks).await;
    assert_eq!(started(&env), 0);
    assert_eq!(
        outcome.decision,
        Some(PermissionDecision::Deny {
            message: format!("{BLOCKED}workspace_hook_script_unavailable")
        })
    );
}

#[tokio::test]
async fn a_background_hook_refused_never_blocks_the_tool() {
    // Node applies `onError: "deny"` to a refused re-check only for a hook that is not async.
    let env = Arc::new(ScriptedEnv::with(&[("./guard.sh", script("", "", 0))]));
    let mut hook = guard(Some("deny"));
    hook["async"] = json!(true);
    let hooks = engine(env.clone(), hook, Some(verifier(ScriptState::Missing)));
    let outcome = pre_tool_use(&hooks).await;
    assert_eq!(started(&env), 0);
    assert_eq!(outcome.decision, None);
}
