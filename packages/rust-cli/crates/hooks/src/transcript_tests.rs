//! Fork: command hooks with the Node stdin and transcript file (specs/fork-rust-agent-parity.md "Command hook stdin").

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::CommandKind;
use rust_cli_kernel_api::hooks::{HookEventName, HookRunner, HookTranscript, HookTranscripts};
use rust_cli_kernel_api::testing::FixedClock;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::test_support::{Script, ScriptedEnv, config, event, ports, script};
use crate::{HookEngine, HookPorts, NodeStdinPorts};

/// Records the files the engine writes and removes; the fake hook never opens them, so the tests check what the hook
/// is given (the path on its stdin) and when the file goes away.
#[derive(Default)]
struct MemoryTranscripts {
    created: Mutex<Vec<(HookTranscript, String)>>,
    removed: Mutex<Vec<HookTranscript>>,
}

impl MemoryTranscripts {
    fn created(&self) -> Vec<(HookTranscript, String)> {
        self.created.lock_unpoisoned().clone()
    }

    fn removed(&self) -> Vec<HookTranscript> {
        self.removed.lock_unpoisoned().clone()
    }
}

#[async_trait]
impl HookTranscripts for MemoryTranscripts {
    fn locate(&self, name: &str) -> std::io::Result<HookTranscript> {
        Ok(HookTranscript {
            path: format!("/tmp/{name}/transcript.jsonl"),
            dir: format!("/tmp/{name}"),
        })
    }

    async fn create(&self, transcript: &HookTranscript, text: &str) -> std::io::Result<()> {
        self.created
            .lock_unpoisoned()
            .push((transcript.clone(), text.to_owned()));
        Ok(())
    }

    async fn remove(&self, transcript: &HookTranscript) -> std::io::Result<()> {
        self.removed.lock_unpoisoned().push(transcript.clone());
        Ok(())
    }
}

fn stdin_of(env: &ScriptedEnv, index: usize) -> Value {
    let (_, request) = &env.started()[index];
    let CommandKind::Hook { hook } = &request.kind else {
        panic!("{:?}", request.kind);
    };
    serde_json::from_str(hook.stdin.trim_end()).unwrap()
}

fn engine(env: Arc<ScriptedEnv>, transcripts: Arc<MemoryTranscripts>, hook: Value) -> HookEngine {
    let settings = json!({"hooks": {"Stop": [{"hooks": [hook]}]}});
    HookEngine::with_config(
        HookPorts {
            node_stdin: Some(NodeStdinPorts {
                transcripts,
                clock: Arc::new(FixedClock(0)),
            }),
            ..ports(env)
        },
        config(&settings),
    )
}

fn stop() -> rust_cli_kernel_api::hooks::HookEvent {
    event(
        HookEventName::Stop,
        json!({"stop_hook_active": false, "last_assistant_message": "STEP_0"}),
    )
}

fn slow(delay_ms: u64) -> Script {
    Script {
        delay_ms,
        ..script("", "", 0)
    }
}

/// Lets spawned removals run (the test runtime is single-threaded).
async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn a_command_hook_is_given_the_reply_in_a_transcript_removed_after_the_run() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", script("", "", 0))]));
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env.clone(),
        transcripts.clone(),
        json!({"type": "command", "command": "stop.sh"}),
    );
    engine.run(stop(), CancellationToken::new()).await;

    let created = transcripts.created();
    assert_eq!(created.len(), 1);
    let (file, text) = &created[0];
    assert!(file.dir.starts_with("/tmp/zcode-hook-"), "{created:?}");
    assert!(text.contains("\"text\":\"STEP_0\""), "{created:?}");
    let stdin = stdin_of(&env, 0);
    assert_eq!(stdin["transcript_path"], file.path.as_str());
    assert_eq!(stdin["transcriptPath"], file.path.as_str());
    assert_eq!(stdin["hookEventName"], "Stop");
    assert_eq!(stdin["last_assistant_message"], "STEP_0");
    assert_eq!(stdin["timestamp"], "1970-01-01T00:00:00.000Z");
    assert_eq!(transcripts.removed(), std::slice::from_ref(file));
}

/// Node keeps an async hook's transcript for its background run; Rust removes it when the process ends.
#[tokio::test(start_paused = true)]
async fn an_async_command_hook_keeps_its_transcript_until_the_process_ends() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", slow(1_000))]));
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env.clone(),
        transcripts.clone(),
        json!({"type": "command", "command": "stop.sh", "async": true}),
    );
    engine.run(stop(), CancellationToken::new()).await;

    let created = transcripts.created();
    assert_eq!(created.len(), 1);
    let file = &created[0].0;
    assert_eq!(stdin_of(&env, 0)["transcript_path"], file.path.as_str());
    settle().await;
    assert!(transcripts.removed().is_empty(), "removed while running");
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    settle().await;
    assert_eq!(transcripts.removed(), std::slice::from_ref(file));
}

#[tokio::test]
async fn a_hook_that_fails_to_start_still_removes_its_transcript() {
    let env = Arc::new(ScriptedEnv::failing());
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env,
        transcripts.clone(),
        json!({"type": "command", "command": "stop.sh"}),
    );
    engine.run(stop(), CancellationToken::new()).await;

    let created = transcripts.created();
    assert_eq!(created.len(), 1);
    assert_eq!(transcripts.removed(), [created[0].0.clone()]);
}

#[tokio::test(start_paused = true)]
async fn a_cancelled_hook_removes_its_transcript() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", slow(60_000))]));
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env,
        transcripts.clone(),
        json!({"type": "command", "command": "stop.sh"}),
    );
    let cancel = CancellationToken::new();
    let stop_soon = cancel.clone();
    drop(tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(10)).await;
        stop_soon.cancel();
    }));
    engine.run(stop(), cancel).await;

    let created = transcripts.created();
    assert_eq!(created.len(), 1);
    assert_eq!(transcripts.removed(), [created[0].0.clone()]);
}

/// The run's future dropped mid-run (its task torn down): the guard's drop removes the transcript.
#[tokio::test(start_paused = true)]
async fn a_dropped_run_removes_its_transcript() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", slow(60_000))]));
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env,
        transcripts.clone(),
        json!({"type": "command", "command": "stop.sh"}),
    );
    let ran = tokio::time::timeout(
        Duration::from_millis(10),
        engine.run(stop(), CancellationToken::new()),
    )
    .await;
    assert!(ran.is_err(), "the run should still be going");

    let created = transcripts.created();
    assert_eq!(created.len(), 1);
    settle().await;
    assert_eq!(transcripts.removed(), [created[0].0.clone()]);
}
