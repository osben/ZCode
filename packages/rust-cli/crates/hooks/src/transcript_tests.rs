//! Fork: command hooks with the Node stdin and transcript file (specs/fork-rust-agent-parity.md "Command hook stdin").

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::CommandKind;
use rust_cli_kernel_api::hooks::{HookEventName, HookRunner, HookTranscript, HookTranscripts};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::test_support::{ScriptedEnv, config, event, ports, script};
use crate::{HookEngine, HookPorts};

#[derive(Default)]
struct MemoryTranscripts {
    created: Mutex<Vec<(String, String)>>,
    removed: Mutex<Vec<HookTranscript>>,
}

#[async_trait]
impl HookTranscripts for MemoryTranscripts {
    async fn create(&self, name: &str, text: &str) -> std::io::Result<HookTranscript> {
        self.created
            .lock_unpoisoned()
            .push((name.to_owned(), text.to_owned()));
        Ok(HookTranscript {
            path: format!("/tmp/{name}/transcript.jsonl"),
            dir: format!("/tmp/{name}"),
        })
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
            transcripts: Some(transcripts),
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

#[tokio::test]
async fn a_command_hook_reads_the_reply_from_a_transcript_removed_after_the_run() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", script("", "", 0))]));
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env.clone(),
        transcripts.clone(),
        json!({"type": "command", "command": "stop.sh"}),
    );
    engine.run(stop(), CancellationToken::new()).await;

    let created = transcripts.created.lock_unpoisoned().clone();
    assert_eq!(created.len(), 1);
    assert!(created[0].0.starts_with("zcode-hook-"), "{created:?}");
    assert!(created[0].1.contains("\"text\":\"STEP_0\""), "{created:?}");
    let path = format!("/tmp/{}/transcript.jsonl", created[0].0);
    let stdin = stdin_of(&env, 0);
    assert_eq!(stdin["transcript_path"], path.as_str());
    assert_eq!(stdin["transcriptPath"], path.as_str());
    assert_eq!(stdin["hookEventName"], "Stop");
    assert_eq!(stdin["last_assistant_message"], "STEP_0");
    let removed = transcripts.removed.lock_unpoisoned().clone();
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].path, path);
}

#[tokio::test]
async fn an_async_command_hook_gets_no_transcript_file() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", script("", "", 0))]));
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env.clone(),
        transcripts.clone(),
        json!({"type": "command", "command": "stop.sh", "async": true}),
    );
    engine.run(stop(), CancellationToken::new()).await;

    assert!(transcripts.created.lock_unpoisoned().is_empty());
    let stdin = stdin_of(&env, 0);
    assert_eq!(stdin["transcript_path"], "");
    assert_eq!(stdin["transcriptPath"], "");
    assert_eq!(stdin["sessionId"], "sess_1");
}
