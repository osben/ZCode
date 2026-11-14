//! Fork: the run records of a dispatch (specs/fork-rust-agent-parity.md HK-UP-01).

use std::sync::Arc;

use rust_cli_kernel_api::hooks::{
    HookEventName, HookOutcome, HookRunOutcome, HookRunner, HookSourceKind,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::config::{HookSource, HooksConfig, HooksSettings};
use crate::mask;
use crate::plugin::PluginHooks;
use crate::test_support::{Script, ScriptedEnv, config, engine, event, script};

async fn prompt(engine: &crate::HookEngine) -> HookOutcome {
    engine
        .run(
            event(HookEventName::UserPromptSubmit, json!({"prompt": "hi"})),
            CancellationToken::new(),
        )
        .await
}

fn commands(hooks: &[serde_json::Value]) -> serde_json::Value {
    json!({"hooks": {"UserPromptSubmit": [{"hooks": hooks}]}})
}

#[tokio::test(start_paused = true)]
async fn each_hook_gets_a_record_with_its_outcome() {
    let env = Arc::new(ScriptedEnv::with(&[
        ("ok", script("", "", 0)),
        ("blk", script("out", "  nope \n", 2)),
        ("bad", script("", "boom", 1)),
        (
            "slow",
            Script {
                delay_ms: 60_000,
                ..Script::default()
            },
        ),
    ]));
    let settings = commands(&[
        json!({"type": "command", "command": "ok"}),
        json!({"type": "command", "command": "blk"}),
        json!({"type": "command", "command": "bad"}),
        json!({"type": "command", "command": "slow", "timeout": 1}),
    ]);
    let outcome = prompt(&engine(env, &settings)).await;
    assert!(outcome.invocation.is_some());
    let runs = &outcome.runs;
    assert_eq!(
        runs.iter()
            .map(|run| (run.index, run.outcome))
            .collect::<Vec<_>>(),
        [
            (0, HookRunOutcome::Success),
            (1, HookRunOutcome::Blocked),
            (2, HookRunOutcome::Failed),
            (3, HookRunOutcome::TimedOut),
        ]
    );
    // Node `createExitCodeBlockOutput`: the stderr preview is the reason; diagnostics only for the block, stdout
    // only on exit 2.
    assert_eq!(runs[1].block_reason.as_deref(), Some("nope"));
    assert_eq!(runs[1].stderr_preview.as_deref(), Some("nope"));
    assert_eq!(runs[1].error_message.as_deref(), Some("nope"));
    assert_eq!(runs[1].stdout_preview.as_deref(), Some("out"));
    assert_eq!(runs[2].block_reason, None);
    assert_eq!(runs[2].stderr_preview, None);
    assert!(
        runs.iter()
            .all(|run| run.source_kind == HookSourceKind::User)
    );
    let distinct: std::collections::HashSet<_> = runs.iter().map(|run| &run.run).collect();
    assert_eq!(distinct.len(), 4);
}

#[tokio::test]
async fn a_json_block_takes_its_reason_and_an_async_hook_reports_its_start() {
    let env = Arc::new(ScriptedEnv::with(&[(
        "node block.js",
        script(
            r#"{"continue": false, "reason": "hooks_prompt_block"}"#,
            "prompt blocked",
            0,
        ),
    )]));
    let settings = commands(&[
        json!({"type": "command", "command": "node async.js", "async": true}),
        json!({"type": "command", "command": "node block.js"}),
    ]);
    let outcome = prompt(&engine(env, &settings)).await;
    let runs = &outcome.runs;
    assert_eq!(runs[0].outcome, HookRunOutcome::Success);
    assert_eq!(runs[0].duration_ms, 0);
    assert_eq!(runs[1].outcome, HookRunOutcome::Blocked);
    assert_eq!(runs[1].block_reason.as_deref(), Some("hooks_prompt_block"));
    assert_eq!(runs[1].stderr_preview.as_deref(), Some("prompt blocked"));
    assert_eq!(runs[1].stdout_preview, None);
    assert_eq!(runs[1].display, "node block.js");
}

#[tokio::test]
async fn no_selected_hook_reports_no_dispatch() {
    let env = Arc::new(ScriptedEnv::default());
    let settings = json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x"}]}]}});
    let outcome = prompt(&engine(env, &settings)).await;
    assert_eq!(outcome.invocation, None);
    assert!(outcome.runs.is_empty());
}

#[tokio::test]
async fn the_source_kind_follows_the_settings_file_or_the_plugin() {
    let env = Arc::new(ScriptedEnv::default());
    let parsed = |command: &str| {
        let (settings, warnings) =
            HooksSettings::from_json(&commands(&[json!({"type": "command", "command": command})]));
        assert!(warnings.is_empty());
        settings
    };
    let hooks = crate::HookEngine::with_config(
        crate::test_support::ports(env),
        HooksConfig {
            version: 1,
            sources: vec![
                (HookSource::User, parsed("user")),
                (HookSource::Project, parsed("project")),
                (HookSource::Local, parsed("local")),
            ],
            ..config(&json!({}))
        },
    );
    hooks.register_plugins(vec![PluginHooks {
        plugin: "lint".into(),
        root: "/plugins/lint".into(),
        settings: parsed("plugin"),
    }]);
    let outcome = prompt(&hooks).await;
    let kinds: Vec<_> = outcome
        .runs
        .iter()
        .map(|run| {
            (
                run.display.clone(),
                run.source_kind,
                run.plugin_name.clone(),
            )
        })
        .collect();
    assert_eq!(
        kinds,
        [
            ("user".to_owned(), HookSourceKind::User, None),
            ("project".to_owned(), HookSourceKind::Project, None),
            ("local".to_owned(), HookSourceKind::Project, None),
            (
                "plugin".to_owned(),
                HookSourceKind::Plugin,
                Some("lint".to_owned())
            ),
        ]
    );
}

#[test]
fn display_text_is_masked_like_node() {
    for (raw, masked) in [
        (
            "curl https://me:pw@example.com/x",
            "curl https://••••:••••@example.com/x",
        ),
        (
            "Authorization: Bearer abc.def",
            "Authorization: Bearer ••••",
        ),
        // Node: the identifier pattern then takes the rest of the query too.
        ("GET /x?api_key=123&b=2", "GET /x?api_key=••••"),
        ("API_TOKEN=s3cret ./run", "API_TOKEN=•••• ./run"),
        (r#"{"password": "hunter2"}"#, r#"{"password": ••••}"#),
        ("run --token abc", "run --token ••••"),
        ("plain text", "plain text"),
    ] {
        assert_eq!(mask::text(raw), masked, "{raw}");
    }
}

#[test]
fn a_preview_is_trimmed_and_capped() {
    assert_eq!(mask::preview("  \n "), None);
    assert_eq!(mask::preview(" a "), Some("a".to_owned()));
    let long = "x".repeat(4001);
    assert_eq!(
        mask::preview(&long),
        Some(format!("{}...", "x".repeat(4000)))
    );
    assert_eq!(
        mask::diagnostic(&long).map(|text| text.chars().count()),
        Some(4000)
    );
}
