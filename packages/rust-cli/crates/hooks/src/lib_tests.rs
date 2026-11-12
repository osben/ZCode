//! 引擎端到端：快照、匹配、输入 JSON 经 stdin、并发与合并顺序（spec §1、§4.3）。

use std::sync::Arc;

use rust_cli_kernel_api::env::CommandKind;
use rust_cli_kernel_api::hooks::{HookContext, HookEventName};
use rust_cli_kernel_api::ids::RunId;
use rust_cli_kernel_api::permission::{PermissionDecision, PermissionMode};
use serde_json::{Value, json};

use super::*;
use crate::test_support::{
    Script, ScriptedEnv, ScriptedHttp, command_settings, config, engine, event, ports, script,
};

fn stdin_of(env: &ScriptedEnv, index: usize) -> Value {
    let (_, request) = &env.started()[index];
    let CommandKind::Hook { hook } = &request.kind else {
        panic!("{:?}", request.kind);
    };
    serde_json::from_str(hook.stdin.trim_end()).unwrap()
}

#[tokio::test]
async fn pre_tool_use_runs_matching_hooks_with_the_input_on_stdin() {
    let env = Arc::new(
        ScriptedEnv::with(&[("guard.sh", script("", "no rm", 2))]).cwd("/Users/dev/project/sub"),
    );
    let engine = engine(
        env.clone(),
        &command_settings("PreToolUse", "Bash", "guard.sh"),
    );
    let mut pre = event(
        HookEventName::PreToolUse,
        json!({"tool_name": "Bash", "tool_input": {"command": "rm -rf x"}, "tool_use_id": "toolu_1"}),
    );
    pre.context = HookContext {
        mode: Some(PermissionMode::Default),
        run: Some(RunId::new("run_1")),
        ..HookContext::default()
    };
    let outcome = engine.run(pre.clone(), CancellationToken::new()).await;
    assert_eq!(
        outcome.decision,
        Some(PermissionDecision::Deny {
            message: "PreToolUse:Bash hook error: [guard.sh]: no rm".to_owned()
        })
    );
    assert_eq!(
        serde_json::to_string(&stdin_of(&env, 0)).unwrap(),
        r#"{"session_id":"sess_1","transcript_path":"","cwd":"/Users/dev/project/sub","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf x"},"tool_use_id":"toolu_1"}"#
    );
    let (operation, _) = &env.started()[0];
    assert!(
        matches!(&operation.origin, rust_cli_kernel_api::env::Origin::Agent { run, .. } if run.as_str() == "run_1")
    );
    // 不匹配的工具不运行。
    pre.payload = json!({"tool_name": "Read", "tool_input": {}, "tool_use_id": "toolu_2"});
    assert_eq!(
        engine.run(pre, CancellationToken::new()).await,
        HookOutcome::default()
    );
    assert_eq!(env.started().len(), 1);
}

#[tokio::test]
async fn untrusted_or_empty_configs_run_nothing() {
    let env = Arc::new(ScriptedEnv::default());
    let mut untrusted = config(&command_settings("Stop", "", "x"));
    untrusted.trusted = false;
    let engine = HookEngine::with_config(ports(env.clone()), untrusted);
    assert!(!engine.has_hooks(HookEventName::Stop));
    let stop = event(HookEventName::Stop, json!({"stop_hook_active": false}));
    assert_eq!(
        engine.run(stop.clone(), CancellationToken::new()).await,
        HookOutcome::default()
    );
    engine.replace(HooksConfig::default());
    assert_eq!(
        engine.run(stop.clone(), CancellationToken::new()).await,
        HookOutcome::default()
    );
    // 换上快照后生效。
    engine.replace(config(&command_settings("Stop", "", "x")));
    assert!(engine.has_hooks(HookEventName::Stop));
    assert!(!engine.has_hooks(HookEventName::SessionStart));
    let _ = engine.run(stop, CancellationToken::new()).await;
    assert_eq!(env.started().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn repl_results_merge_in_completion_order() {
    let slow = Script {
        delay_ms: 50,
        ..script(
            r#"{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"slow"}}"#,
            "",
            0,
        )
    };
    let fast = script(
        r#"{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"fast"}}"#,
        "",
        0,
    );
    let env = Arc::new(ScriptedEnv::with(&[("slow", slow), ("fast", fast)]));
    let settings = json!({"hooks": {"PostToolUse": [{"hooks": [
        {"type": "command", "command": "slow"}, {"type": "command", "command": "fast"}
    ]}]}});
    let engine = engine(env, &settings);
    let outcome = engine
        .run(
            event(HookEventName::PostToolUse, json!({"tool_name": "Bash", "tool_input": {}, "tool_response": [], "tool_use_id": "t"})),
            CancellationToken::new(),
        )
        .await;
    assert_eq!(outcome.additional_context, ["fast", "slow"]);
}

#[tokio::test(start_paused = true)]
async fn outside_results_keep_config_order() {
    let slow = Script {
        delay_ms: 50,
        ..script("first", "", 0)
    };
    let env = Arc::new(ScriptedEnv::with(&[
        ("a", slow),
        ("b", script("second", "", 0)),
    ]));
    let settings = json!({"hooks": {"PreCompact": [{"matcher": "auto", "hooks": [
        {"type": "command", "command": "a"}, {"type": "command", "command": "b"}
    ]}]}});
    let engine = engine(env.clone(), &settings);
    let outcome = engine
        .run(
            event(
                HookEventName::PreCompact,
                json!({"trigger": "auto", "custom_instructions": null}),
            ),
            CancellationToken::new(),
        )
        .await;
    assert_eq!(
        outcome.custom_instructions.as_deref(),
        Some("first\n\nsecond")
    );
    assert_eq!(stdin_of(&env, 0)["custom_instructions"], Value::Null);
}

#[tokio::test]
async fn timeouts_come_from_the_hook_or_the_event() {
    let env = Arc::new(ScriptedEnv::default());
    let settings = json!({"hooks": {
        "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "a"}, {"type": "command", "command": "b", "timeout": 2.5}]}],
        "SessionEnd": [{"hooks": [{"type": "command", "command": "c"}]}]
    }});
    let engine = engine(env.clone(), &settings);
    let _ = engine
        .run(
            event(HookEventName::UserPromptSubmit, json!({"prompt": "hi"})),
            CancellationToken::new(),
        )
        .await;
    let _ = engine
        .run(
            event(HookEventName::SessionEnd, json!({"reason": "other"})),
            CancellationToken::new(),
        )
        .await;
    let timeouts: Vec<_> = env
        .started()
        .iter()
        .map(|(_, r)| (r.command.clone(), r.timeout_ms))
        .collect();
    assert!(timeouts.contains(&("a".to_owned(), Some(30_000))));
    assert!(timeouts.contains(&("b".to_owned(), Some(2_500))));
    assert!(timeouts.contains(&("c".to_owned(), Some(1_500))));
}

#[tokio::test]
async fn http_and_agent_hooks() {
    let env = Arc::new(ScriptedEnv::default());
    let http = Arc::new(ScriptedHttp::answering(
        200,
        r#"{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"from http"}}"#,
    ));
    let settings = json!({"hooks": {"Stop": [{"hooks": [
        {"type": "http", "url": "https://hooks.example.com/stop"},
        {"type": "agent", "prompt": "verify"}
    ]}]}});
    let engine = HookEngine::with_config(
        HookPorts {
            http: Some(http.clone()),
            ..ports(env)
        },
        config(&settings),
    );
    let outcome = engine
        .run(
            event(HookEventName::Stop, json!({"stop_hook_active": false})),
            CancellationToken::new(),
        )
        .await;
    assert_eq!(outcome.additional_context, ["from http"]);
    let request = http.requests.lock().unwrap().remove(0);
    let body: Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(body["hook_event_name"], "Stop");
}

/// Fork (specs/fork-rust-agent-parity.md, "Incognito sessions"): without hooks an incognito session runs none;
/// without plugins it runs only the settings hooks. Other sessions are unchanged.
#[tokio::test]
async fn an_incognito_profile_drops_all_hooks_or_the_plugin_hooks() {
    use rust_cli_kernel_api::incognito::{IncognitoProfile, IncognitoProfiles};
    let env = Arc::new(ScriptedEnv::with(&[
        ("user.sh", script("", "", 0)),
        ("kit.sh", script("", "", 0)),
    ]));
    let profiles = IncognitoProfiles::default();
    let engine = engine(env.clone(), &command_settings("Stop", "", "user.sh"))
        .with_incognito(profiles.clone());
    let (kit, warnings) = PluginHooks::from_json(
        "kit",
        "/Users/dev/plugins/kit",
        &[json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "kit.sh"}]}]}})],
    );
    assert!(warnings.is_empty(), "{warnings:?}");
    engine.register_plugins(vec![kit]);
    let ran = |session: &'static str| {
        let engine = &engine;
        let env = env.clone();
        async move {
            let before = env.started().len();
            let mut stop = event(HookEventName::Stop, json!({"stop_hook_active": false}));
            stop.session = rust_cli_kernel_api::ids::SessionId::new(session);
            engine.run(stop, CancellationToken::new()).await;
            env.started().len() - before
        }
    };
    profiles.record(
        &rust_cli_kernel_api::ids::SessionId::new("no_hooks"),
        Some(IncognitoProfile {
            plugins: true,
            ..IncognitoProfile::LOCKDOWN
        }),
    );
    profiles.record(
        &rust_cli_kernel_api::ids::SessionId::new("no_plugins"),
        Some(IncognitoProfile {
            hooks: true,
            ..IncognitoProfile::LOCKDOWN
        }),
    );
    assert_eq!(ran("sess_1").await, 2);
    assert_eq!(ran("no_hooks").await, 0);
    assert_eq!(ran("no_plugins").await, 1);
}

/// #422 review P2-2: a PermissionRequest hook that answers `continue: false` denies the ask with its `stopReason`
/// (Node `hooks/output.ts` preventContinuation, checked first in `hook-flow.ts`), even when it also allows.
#[tokio::test]
async fn a_permission_request_hook_that_stops_denies_the_ask() {
    let stops = r#"{"continue": false, "stopReason": "not now", "hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}"#;
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", script(stops, "", 0))]));
    let engine = engine(
        env.clone(),
        &command_settings("PermissionRequest", "Bash", "stop.sh"),
    );
    let ask = event(
        HookEventName::PermissionRequest,
        json!({"tool_name": "Bash", "tool_input": {"command": "ls"}, "tool_use_id": "toolu_1"}),
    );
    let outcome = engine.run(ask, CancellationToken::new()).await;
    assert_eq!(
        outcome.decision,
        Some(PermissionDecision::Deny {
            message: "not now".to_owned()
        })
    );
    assert_eq!(outcome.updated_input, None);
}
