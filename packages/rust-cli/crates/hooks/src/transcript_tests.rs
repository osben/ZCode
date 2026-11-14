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
    /// `create` / `remove` / `remove_blocking`, in the order they finished.
    order: Arc<Mutex<Vec<&'static str>>>,
    /// The write runs this long on the blocking pool, which a dropped caller does not stop and a shutting-down runtime
    /// waits for.
    write_ms: u64,
    /// The removal runs this long in its own task, which a dropped caller does not stop (as tokio's `remove_dir_all`
    /// on `spawn_blocking`).
    remove_ms: u64,
    /// The removal runs this long on the blocking pool (as tokio's `remove_dir_all`), which a shutting-down runtime
    /// waits for.
    remove_blocking_pool_ms: u64,
}

impl MemoryTranscripts {
    fn created(&self) -> Vec<(HookTranscript, String)> {
        self.created.lock_unpoisoned().clone()
    }

    fn removed(&self) -> Vec<HookTranscript> {
        self.removed.lock_unpoisoned().clone()
    }

    fn order(&self) -> Vec<&'static str> {
        self.order.lock_unpoisoned().clone()
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

    fn create(&self, transcript: &HookTranscript, text: &str) -> std::io::Result<()> {
        self.created
            .lock_unpoisoned()
            .push((transcript.clone(), text.to_owned()));
        if self.write_ms > 0 {
            std::thread::sleep(Duration::from_millis(self.write_ms));
        }
        self.order.lock_unpoisoned().push("create");
        Ok(())
    }

    async fn remove(&self, transcript: &HookTranscript) -> std::io::Result<()> {
        self.removed.lock_unpoisoned().push(transcript.clone());
        let order = self.order.clone();
        if self.remove_blocking_pool_ms > 0 {
            let wait = Duration::from_millis(self.remove_blocking_pool_ms);
            let removal = tokio::task::spawn_blocking(move || {
                std::thread::sleep(wait);
                order.lock_unpoisoned().push("remove");
            });
            let _ = removal.await;
            return Ok(());
        }
        let remove_ms = self.remove_ms;
        let removal = tokio::spawn(async move {
            if remove_ms > 0 {
                tokio::time::sleep(Duration::from_millis(remove_ms)).await;
            }
            order.lock_unpoisoned().push("remove");
        });
        let _ = removal.await;
        Ok(())
    }

    fn remove_blocking(&self, transcript: &HookTranscript) -> std::io::Result<()> {
        self.removed.lock_unpoisoned().push(transcript.clone());
        self.order.lock_unpoisoned().push("remove_blocking");
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

/// N3: a run dropped while its transcript is being written removes the directory only after the write ends (the
/// write keeps going after the drop, so a removal before it would leave the file behind).
#[tokio::test]
async fn a_run_dropped_during_the_write_removes_after_the_write() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", slow(60_000))]));
    let transcripts = Arc::new(MemoryTranscripts {
        write_ms: 50,
        ..MemoryTranscripts::default()
    });
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
    assert!(ran.is_err(), "the run should still be writing");
    tokio::time::sleep(Duration::from_millis(100)).await;
    settle().await;
    assert_eq!(transcripts.order(), ["create", "remove"]);
}

/// N2: a dropped run cancels its hook process too (dropping the event stream does not stop the command).
#[tokio::test(start_paused = true)]
async fn a_dropped_run_cancels_its_hook_process() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", slow(60_000))]));
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env.clone(),
        transcripts,
        json!({"type": "command", "command": "stop.sh"}),
    );
    let ran = tokio::time::timeout(
        Duration::from_millis(10),
        engine.run(stop(), CancellationToken::new()),
    )
    .await;
    assert!(ran.is_err(), "the run should still be going");
    settle().await;
    let started = env.started();
    assert_eq!(started.len(), 1);
    assert_eq!(env.cancelled(), [started[0].0.operation.clone()]);
}

/// N2: a run that finished sends no cancel.
#[tokio::test]
async fn a_finished_run_sends_no_cancel() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", script("", "", 0))]));
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env.clone(),
        transcripts,
        json!({"type": "command", "command": "stop.sh"}),
    );
    engine.run(stop(), CancellationToken::new()).await;
    settle().await;
    assert!(env.cancelled().is_empty());
}

/// A run dropped while its command starts cancels it too: the operation id is known before the start.
#[tokio::test(start_paused = true)]
async fn a_run_dropped_while_its_command_starts_cancels_it() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", slow(60_000))]).starting_in(50));
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env.clone(),
        transcripts,
        json!({"type": "command", "command": "stop.sh"}),
    );
    let ran = tokio::time::timeout(
        Duration::from_millis(10),
        engine.run(stop(), CancellationToken::new()),
    )
    .await;
    assert!(ran.is_err(), "the run should still be starting");
    settle().await;
    assert!(env.started().is_empty());
    assert_eq!(env.cancelled().len(), 1, "{:?}", env.cancelled());
}

/// A run dropped after the token's cancel was sent sends no second one.
#[tokio::test(start_paused = true)]
async fn a_run_dropped_after_its_cancel_sends_no_second_cancel() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", slow(60_000))]).ignoring_cancel());
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env.clone(),
        transcripts,
        json!({"type": "command", "command": "stop.sh"}),
    );
    let cancel = CancellationToken::new();
    let run = engine.run(stop(), cancel.clone());
    let cancelling = async {
        tokio::time::sleep(Duration::from_millis(5)).await;
        cancel.cancel();
    };
    let ran = tokio::time::timeout(Duration::from_millis(10), async {
        tokio::join!(run, cancelling)
    })
    .await;
    assert!(ran.is_err(), "the command ignores the cancel");
    settle().await;
    assert_eq!(env.started().len(), 1);
    assert_eq!(env.cancelled(), [env.started()[0].0.operation.clone()]);
}

/// A `remove` dropped mid-way removes the directory once: the removal it started goes on, and no second one runs
/// beside it.
#[tokio::test(start_paused = true)]
async fn a_removal_dropped_mid_way_removes_once() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", script("", "", 0))]));
    let transcripts = Arc::new(MemoryTranscripts {
        remove_ms: 50,
        ..MemoryTranscripts::default()
    });
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
    assert!(ran.is_err(), "the run should still be removing");
    tokio::time::sleep(Duration::from_millis(100)).await;
    settle().await;
    assert_eq!(transcripts.order(), ["create", "remove"]);
}

/// A removal in flight when the runtime shuts down is not repeated: the blocking removal goes on (the shutdown waits
/// for it), and the dropped removal task does not remove the directory a second time.
#[test]
fn a_removal_in_flight_at_runtime_shutdown_removes_once() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", script("", "", 0))]));
    let transcripts = Arc::new(MemoryTranscripts {
        remove_blocking_pool_ms: 100,
        ..MemoryTranscripts::default()
    });
    let engine = engine(
        env,
        transcripts.clone(),
        json!({"type": "command", "command": "stop.sh"}),
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let ran = runtime.block_on(async {
        tokio::time::timeout(
            Duration::from_millis(20),
            engine.run(stop(), CancellationToken::new()),
        )
        .await
    });
    assert!(ran.is_err(), "the run should still be removing");
    drop(runtime);
    assert_eq!(transcripts.order(), ["create", "remove"]);
}

/// A run dropped at runtime shutdown while its write is on the blocking pool leaves the removal to the write: the
/// shutdown waits for the running write, which then removes the directory (a removal before it would leave the
/// directory the write creates).
#[test]
fn a_run_dropped_at_runtime_shutdown_during_the_write_removes_after_it() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", slow(60_000))]));
    let transcripts = Arc::new(MemoryTranscripts {
        write_ms: 100,
        ..MemoryTranscripts::default()
    });
    let engine = engine(
        env,
        transcripts.clone(),
        json!({"type": "command", "command": "stop.sh"}),
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let ran = runtime.block_on(async {
        tokio::time::timeout(
            Duration::from_millis(20),
            engine.run(stop(), CancellationToken::new()),
        )
        .await
    });
    assert!(ran.is_err(), "the run should still be writing");
    drop(runtime);
    assert_eq!(transcripts.order(), ["create", "remove_blocking"]);
}

/// N4: a run dropped while the runtime shuts down still removes its transcript (the spawned removal never runs, so
/// the guard removes it synchronously).
#[test]
fn a_run_dropped_at_runtime_shutdown_removes_its_transcript() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", slow(60_000))]));
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env,
        transcripts.clone(),
        json!({"type": "command", "command": "stop.sh"}),
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .start_paused(true)
        .build()
        .unwrap();
    let ran = runtime.block_on(async {
        tokio::time::timeout(
            Duration::from_millis(10),
            engine.run(stop(), CancellationToken::new()),
        )
        .await
    });
    assert!(ran.is_err(), "the run should still be going");
    drop(runtime);
    assert_eq!(transcripts.order(), ["create", "remove_blocking"]);
}

/// N5: an async hook is cancelled with the turn (Node passes the turn's signal to `runBackgroundHook`); its transcript
/// goes once the process ends.
#[tokio::test(start_paused = true)]
async fn an_async_hook_is_cancelled_with_the_turn() {
    let env = Arc::new(ScriptedEnv::with(&[("stop.sh", slow(60_000))]));
    let transcripts = Arc::new(MemoryTranscripts::default());
    let engine = engine(
        env.clone(),
        transcripts.clone(),
        json!({"type": "command", "command": "stop.sh", "async": true}),
    );
    let turn = CancellationToken::new();
    engine.run(stop(), turn.clone()).await;
    settle().await;
    assert!(env.cancelled().is_empty());
    assert!(transcripts.removed().is_empty());
    turn.cancel();
    settle().await;
    let started = env.started();
    assert_eq!(env.cancelled(), [started[0].0.operation.clone()]);
    assert_eq!(transcripts.removed().len(), 1);
}
