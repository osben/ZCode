//! Tests of the protocol side of the child runner port (specs/fork-rust-workflow-engine.md, 9.22). The compile helper is
//! not started here: the tests begin from a compile's answer, and the fake launcher hands out duplex streams as the
//! sandbox child's stdio, the same way the host's own tests do.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::workflow_child::{
    ChildEvent, ChildRequest, Completion, CreateActor, Diagnostic, LaunchError, LaunchInput,
    WireError,
};
use serde_json::{Value, json};
use tokio::io::{
    AsyncBufRead, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, DuplexStream, duplex,
};

use super::*;
use crate::fork::workflow_entry::project_dir;

/// The child's side of the stdio: it writes its stdout, reads the host's stdin and writes its stderr.
struct ChildEnds {
    stdout: DuplexStream,
}

/// A launcher that starts no process. It records the entry it was asked to start, and counts its guard's drops.
struct FakeLauncher {
    refuse: bool,
    entries: StdMutex<Vec<PathBuf>>,
    child: StdMutex<Option<ChildEnds>>,
    guard_drops: Arc<AtomicUsize>,
}

struct TreeGuard(Arc<AtomicUsize>);

impl Drop for TreeGuard {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

impl FakeLauncher {
    fn new(refuse: bool) -> Arc<Self> {
        Arc::new(Self {
            refuse,
            entries: StdMutex::new(Vec::new()),
            child: StdMutex::new(None),
            guard_drops: Arc::new(AtomicUsize::new(0)),
        })
    }

    fn launches(&self) -> usize {
        self.entries.lock().unwrap().len()
    }

    fn drops(&self) -> usize {
        self.guard_drops.load(Ordering::SeqCst)
    }

    /// The child's stdout writer, once a launch has happened.
    fn child_stdout(&self) -> DuplexStream {
        self.child
            .lock()
            .unwrap()
            .take()
            .expect("a launched child")
            .stdout
    }
}

#[async_trait::async_trait]
impl ChildLauncher for FakeLauncher {
    async fn launch(&self, entry: &Path) -> io::Result<LaunchedChild> {
        if self.refuse {
            return Err(io::Error::other("the process cannot be contained"));
        }
        self.entries.lock().unwrap().push(entry.to_path_buf());
        let (child_stdout, host_stdout) = duplex(1 << 16);
        let (host_stdin, child_stdin) = duplex(1 << 16);
        let (child_stderr, host_stderr) = duplex(1 << 16);
        // The child's stdin and stderr stay open for the whole test: dropping them would read as an exit.
        std::mem::forget(child_stdin);
        std::mem::forget(child_stderr);
        *self.child.lock().unwrap() = Some(ChildEnds {
            stdout: child_stdout,
        });
        Ok(LaunchedChild {
            streams: ChildIo {
                stdout: Box::new(BufReader::new(host_stdout))
                    as Box<dyn AsyncBufRead + Send + Unpin>,
                stdin: Box::new(host_stdin) as Box<dyn AsyncWrite + Send + Unpin>,
                stderr: Box::new(host_stderr) as Box<dyn AsyncRead + Send + Unpin>,
            },
            guard: Box::new(TreeGuard(self.guard_drops.clone())),
        })
    }
}

/// Records the child's create-actor messages, and answers them.
#[derive(Default)]
struct Seen(StdMutex<Vec<String>>);

impl ChildHandler for Seen {
    fn create_actor(&self, actor: &CreateActor) -> Result<String, String> {
        self.0.lock().unwrap().push(actor.local_id.clone());
        Ok(format!("engine-{}", actor.local_id))
    }

    fn request(
        &self,
        _request: ChildRequest,
        _actor_id: Option<String>,
    ) -> futures_util::future::BoxFuture<'static, Result<Value, WireError>> {
        Box::pin(async { Ok(Value::Null) })
    }

    fn event(&self, _event: ChildEvent) {}
}

fn input(cwd: &Path, run_id: &str) -> LaunchInput {
    LaunchInput {
        script_text: "export default 1;".to_owned(),
        run_id: run_id.to_owned(),
        args: None,
        resumed_from: None,
        cwd: cwd.to_path_buf(),
    }
}

fn ready(entry_source: &str) -> Compiled {
    Compiled::Ready {
        script_hash: "hash-1".to_owned(),
        compiled: json!({"phases": ["review"]}),
        entry_source: entry_source.to_owned(),
    }
}

fn spawner() -> (TaskScope, Spawner) {
    let scope = TaskScope::root("workflow-runner-test", |_| {});
    let spawner = scope.spawner();
    (scope, spawner)
}

async fn send(stdout: &mut DuplexStream, line: Value) {
    stdout
        .write_all(format!("{line}\n").as_bytes())
        .await
        .unwrap();
}

#[tokio::test]
async fn a_rejected_compile_refuses_without_writing_an_entry_or_starting_a_child() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new(false);
    let (_scope, spawner) = spawner();
    let rejected = Compiled::Rejected {
        diagnostics: vec![Diagnostic {
            code: 2322,
            line: 1,
            column: 7,
            message: "Type string is not assignable".to_owned(),
        }],
        message: None,
    };
    let refused = launch_compiled(
        rejected,
        &input(dir.path(), "run-1"),
        Arc::new(Seen::default()),
        launcher.as_ref(),
        &spawner,
        &dir.path().join("fallback"),
    )
    .await;
    assert!(matches!(
        refused,
        Err(LaunchError::Rejected { ref diagnostics, message: None }) if diagnostics.len() == 1
    ));
    assert_eq!(launcher.launches(), 0);
    let entry = project_dir(dir.path()).join("run-1.mjs");
    assert!(rust_cli_fs::read_optional(&entry).await.unwrap().is_none());
}

#[tokio::test]
async fn a_ready_compile_writes_the_entry_under_the_project_and_starts_the_child() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new(false);
    let (_scope, spawner) = spawner();
    let running = launch_compiled(
        ready("export {};\n"),
        &input(dir.path(), "run-1"),
        Arc::new(Seen::default()),
        launcher.as_ref(),
        &spawner,
        &dir.path().join("fallback"),
    )
    .await
    .expect("the child starts");
    let expected = project_dir(dir.path()).join("run-1.mjs");
    assert_eq!(running.entry_path, expected);
    assert!(!running.entry_fallback);
    assert_eq!(running.script_hash, "hash-1");
    assert_eq!(running.compiled, json!({"phases": ["review"]}));
    let written = rust_cli_fs::read_optional(&expected)
        .await
        .unwrap()
        .expect("the entry is written");
    assert_eq!(String::from_utf8(written).unwrap(), "export {};\n");
    assert_eq!(*launcher.entries.lock().unwrap(), vec![expected]);
}

#[tokio::test]
async fn a_child_that_writes_its_messages_reaches_the_handler_and_completes() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new(false);
    let (_scope, spawner) = spawner();
    let handler = Arc::new(Seen::default());
    let running = launch_compiled(
        ready("export {};\n"),
        &input(dir.path(), "run-1"),
        handler.clone(),
        launcher.as_ref(),
        &spawner,
        &dir.path().join("fallback"),
    )
    .await
    .expect("the child starts");
    let mut stdout = launcher.child_stdout();
    send(
        &mut stdout,
        json!({"kind": "create-actor", "localId": "a1", "siteId": "s1"}),
    )
    .await;
    send(
        &mut stdout,
        json!({"kind": "complete", "ok": true, "value": "done"}),
    )
    .await;
    let outcome = running.outcome.await;
    assert_eq!(*handler.0.lock().unwrap(), vec!["a1".to_owned()]);
    assert!(matches!(
        outcome,
        Outcome::Completed(Completion { ok: true, .. })
    ));
    // The child has finished, so its process tree is ended with the host.
    assert_eq!(launcher.drops(), 1);
}

#[tokio::test]
async fn stopping_a_running_child_settles_it_as_interrupted_and_ends_its_tree() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new(false);
    let (_scope, spawner) = spawner();
    let running = launch_compiled(
        ready("export {};\n"),
        &input(dir.path(), "run-1"),
        Arc::new(Seen::default()),
        launcher.as_ref(),
        &spawner,
        &dir.path().join("fallback"),
    )
    .await
    .expect("the child starts");
    let stop = running.stop.clone();
    assert!(!stop.is_stopped());
    stop.stop();
    assert!(stop.is_stopped());
    let outcome = running.outcome.await;
    assert_eq!(
        outcome,
        Outcome::Stopped {
            reason: StopReason::Interrupted,
            cause: "the run was stopped".to_owned(),
        }
    );
    assert_eq!(launcher.drops(), 1);
}

#[tokio::test]
async fn dropping_the_outcome_before_it_settles_ends_the_tree() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new(false);
    let (_scope, spawner) = spawner();
    let running = launch_compiled(
        ready("export {};\n"),
        &input(dir.path(), "run-1"),
        Arc::new(Seen::default()),
        launcher.as_ref(),
        &spawner,
        &dir.path().join("fallback"),
    )
    .await
    .expect("the child starts");
    drop(running);
    tokio::time::timeout(Duration::from_secs(5), async {
        while launcher.drops() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the child's tree ends when its outcome is dropped");
}

#[tokio::test]
async fn a_launch_the_process_layer_refuses_is_reported_and_no_child_runs() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new(true);
    let (_scope, spawner) = spawner();
    let refused = launch_compiled(
        ready("export {};\n"),
        &input(dir.path(), "run-1"),
        Arc::new(Seen::default()),
        launcher.as_ref(),
        &spawner,
        &dir.path().join("fallback"),
    )
    .await;
    assert!(
        matches!(refused, Err(LaunchError::Failed(ref text)) if text.contains("cannot be contained"))
    );
    assert_eq!(launcher.drops(), 0);
}
