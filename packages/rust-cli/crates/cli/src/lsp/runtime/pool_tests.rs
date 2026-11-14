use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_ext::plugins::lsp::ResolvedLspServer;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::{mpsc, watch};

use super::{
    Acquired, Event, Limits, Pool, ServerKey, State, decode_stderr, finish_stderr, merge_env,
};
use crate::lsp::runtime::process::{Launch, LaunchError, Launched, Launcher, Process};
use crate::lsp::runtime::rpc::{Decoder, encode};
use crate::lsp::runtime::test_server;

/// The test's end of one launched process.
pub(crate) struct FakeProcess {
    pub(crate) launch: Launch,
    stream: DuplexStream,
    pub(crate) stderr: DuplexStream,
    decoder: Decoder,
    queued: Vec<Map<String, Value>>,
    exit: watch::Sender<Option<String>>,
    pub(crate) terminated: Arc<AtomicBool>,
}

impl FakeProcess {
    pub(crate) async fn next(&mut self) -> Map<String, Value> {
        loop {
            if !self.queued.is_empty() {
                return self.queued.remove(0);
            }
            let mut buffer = [0_u8; 8_192];
            let read = self.stream.read(&mut buffer).await.unwrap();
            assert!(read > 0, "client closed stdin");
            self.queued = self.decoder.push(&buffer[..read]).unwrap();
        }
    }

    /// The next message named `method`, skipping others.
    pub(crate) async fn expect(&mut self, method: &str) -> Map<String, Value> {
        loop {
            let message = self.next().await;
            if message.get("method").and_then(Value::as_str) == Some(method) {
                return message;
            }
        }
    }

    pub(crate) async fn send(&mut self, message: Value) {
        self.stream.write_all(&encode(&message)).await.unwrap();
    }

    pub(crate) async fn reply(&mut self, request: &Map<String, Value>, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": request["id"], "result": result}))
            .await;
    }

    /// Answers `initialize` with `capabilities`.
    pub(crate) async fn initialize(&mut self, capabilities: Value) {
        let request = self.expect("initialize").await;
        self.reply(&request, json!({"capabilities": capabilities}))
            .await;
        self.expect("initialized").await;
    }

    pub(crate) fn exit(&self, detail: &str) {
        let _ = self.exit.send(Some(detail.to_owned()));
    }
}

struct FakeChild {
    exit: watch::Receiver<Option<String>>,
    terminated: Arc<AtomicBool>,
}

#[async_trait]
impl Process for FakeChild {
    async fn wait(&mut self) -> String {
        let detail = self
            .exit
            .wait_for(Option::is_some)
            .await
            .ok()
            .and_then(|detail| detail.clone());
        match detail {
            Some(detail) => detail,
            None => std::future::pending().await,
        }
    }

    async fn terminate(&mut self) {
        self.terminated.store(true, Ordering::SeqCst);
    }
}

/// Hands each launch to the test; `missing` commands fail with `NotFound`.
pub(crate) struct FakeLauncher {
    launched: mpsc::UnboundedSender<FakeProcess>,
    pub(crate) missing: Mutex<Vec<String>>,
}

#[async_trait]
impl Launcher for FakeLauncher {
    async fn launch(&self, launch: Launch) -> Result<Launched, LaunchError> {
        if self.missing.lock_unpoisoned().contains(&launch.command) {
            return Err(LaunchError::NotFound);
        }
        let (client, server) = tokio::io::duplex(1 << 16);
        let (stderr_read, stderr_write) = tokio::io::duplex(1 << 12);
        let (read, write) = tokio::io::split(client);
        let (exit, exit_rx) = watch::channel(None);
        let terminated = Arc::new(AtomicBool::new(false));
        let _ = self.launched.send(FakeProcess {
            launch,
            stream: server,
            stderr: stderr_write,
            decoder: Decoder::default(),
            queued: Vec::new(),
            exit,
            terminated: Arc::clone(&terminated),
        });
        Ok(Launched {
            stdin: Box::new(write),
            stdout: Box::new(read),
            stderr: Box::new(stderr_read),
            pid: 4_242,
            process: Box::new(FakeChild {
                exit: exit_rx,
                terminated,
            }),
        })
    }
}

pub(crate) fn fake_launcher() -> (Arc<FakeLauncher>, mpsc::UnboundedReceiver<FakeProcess>) {
    let (launched, receiver) = mpsc::unbounded_channel();
    let launcher = Arc::new(FakeLauncher {
        launched,
        missing: Mutex::default(),
    });
    (launcher, receiver)
}

pub(crate) fn fake_pool() -> (
    Pool,
    Arc<FakeLauncher>,
    mpsc::UnboundedReceiver<FakeProcess>,
) {
    let (launcher, receiver) = fake_launcher();
    let base = vec![("PATH".to_owned(), "/bin".to_owned())];
    let pool = Pool::new(
        Arc::clone(&launcher) as Arc<dyn Launcher>,
        base,
        false,
        Limits::default(),
    );
    (pool, launcher, receiver)
}

pub(crate) fn key() -> ServerKey {
    ServerKey {
        identity: "/w".to_owned(),
        workspace: "/w".to_owned(),
    }
}

fn events(pool: &Pool) -> mpsc::UnboundedReceiver<Event> {
    let (sender, receiver) = mpsc::unbounded_channel();
    pool.subscribe(Arc::new(move |event: &Event| {
        let _ = sender.send(event.clone());
    }));
    receiver
}

fn state_of(pool: &Pool, server: &str) -> State {
    pool.status()
        .into_iter()
        .find(|status| status.server_id == server)
        .map_or(State::Stopped, |status| status.state)
}

/// Lets the driver tasks run until the entry reaches `state` (each step advances the paused clock by 1 ms).
async fn settle(pool: &Pool, server: &str, state: State) {
    for _ in 0..200 {
        if state_of(pool, server) == state {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!(
        "{server} never reached {state:?}; it is {:?}",
        state_of(pool, server)
    );
}

fn failed(acquired: Acquired) -> (&'static str, String) {
    match acquired {
        Acquired::Failed(error) => (error.code, error.message),
        Acquired::Ready(_) => panic!("ready, not failed"),
        Acquired::Starting => panic!("starting, not failed"),
    }
}

fn server(name: &str) -> Arc<ResolvedLspServer> {
    Arc::new(test_server(name))
}

#[tokio::test(start_paused = true)]
async fn a_start_initializes_and_becomes_ready() {
    let (pool, _launcher, mut launched) = fake_pool();
    let mut events = events(&pool);
    let mut declared = test_server("ts");
    declared.settings = Some(json!({"ts": {"x": 1}}));
    declared.env = vec![("PATH".to_owned(), "/opt/bin".to_owned())];
    let ts = Arc::new(declared);
    assert!(matches!(pool.acquire(&ts, &key()), Acquired::Starting));
    let mut process = launched.recv().await.unwrap();
    assert_eq!(process.launch.command, "ts-server");
    assert_eq!(process.launch.args, ["--stdio"]);
    assert_eq!(process.launch.cwd, "/w");
    assert_eq!(
        process.launch.env,
        [("PATH".to_owned(), "/opt/bin".to_owned())]
    );
    // Still starting: acquire does not start a second process.
    assert!(matches!(pool.acquire(&ts, &key()), Acquired::Starting));
    let initialize = process.expect("initialize").await;
    assert_eq!(initialize["params"]["rootUri"], "file:///w");
    assert_eq!(initialize["params"]["processId"], std::process::id());
    process
        .reply(
            &initialize,
            json!({"capabilities": {"diagnosticProvider": {"interFileDependencies": false}}}),
        )
        .await;
    process.expect("initialized").await;
    let configuration = process.expect("workspace/didChangeConfiguration").await;
    assert_eq!(
        configuration["params"],
        json!({"settings": {"ts": {"x": 1}}})
    );
    let Event::Ready {
        server_id,
        key: ready_key,
        connection,
    } = events.recv().await.unwrap()
    else {
        panic!("not a ready event");
    };
    assert_eq!((server_id.as_str(), ready_key), ("p/ts", key()));
    assert!(connection.supports_pull());
    let Acquired::Ready(again) = pool.acquire(&ts, &key()) else {
        panic!("not ready");
    };
    assert_eq!(again.id, connection.id);
    let status = &pool.status()[0];
    assert_eq!(
        (status.state, status.pull, status.restarts),
        (State::Ready, true, 0)
    );
}

#[tokio::test(start_paused = true)]
async fn crashes_restart_within_the_budget_then_the_server_is_unavailable() {
    let (pool, _launcher, mut launched) = fake_pool();
    let mut events = events(&pool);
    let mut declared = test_server("ts");
    declared.max_restarts = 1;
    let ts = Arc::new(declared);
    let _ = pool.acquire(&ts, &key());
    let mut first = launched.recv().await.unwrap();
    first.initialize(json!({})).await;
    assert!(matches!(events.recv().await, Some(Event::Ready { .. })));
    first.exit("exited (code 1, signal none)");
    assert!(matches!(events.recv().await, Some(Event::Crashed { .. })));
    assert!(first.terminated.load(Ordering::SeqCst));
    let status = &pool.status()[0];
    assert_eq!(
        (status.state, status.last_error_code),
        (State::Crashed, Some("lsp_server_crashed"))
    );
    // One restart is in the budget.
    assert!(matches!(pool.acquire(&ts, &key()), Acquired::Starting));
    let second = launched.recv().await.unwrap();
    assert_eq!(pool.status()[0].restarts, 1);
    // It dies before `initialize` answers, with something on stderr.
    let mut second = second;
    second
        .stderr
        .write_all(b"boom: no tsconfig\n")
        .await
        .unwrap();
    second.expect("initialize").await;
    tokio::time::sleep(Duration::from_millis(5)).await;
    second.exit("exited (code 2, signal none)");
    settle(&pool, "p/ts", State::Crashed).await;
    let (code, message) = failed(pool.acquire(&ts, &key()));
    assert_eq!(code, "lsp_server_unavailable");
    assert_eq!(
        message,
        "p/ts is unavailable after 1 restarts (last error: lsp_server_start_failed)"
    );
    assert_eq!(state_of(&pool, "p/ts"), State::Unavailable);
    // Within the 30 s window nothing starts.
    tokio::time::advance(Duration::from_secs(29)).await;
    assert_eq!(
        failed(pool.acquire(&ts, &key())).0,
        "lsp_server_unavailable"
    );
    tokio::time::advance(Duration::from_secs(2)).await;
    assert!(matches!(pool.acquire(&ts, &key()), Acquired::Starting));
    assert!(launched.recv().await.is_some());
}

#[tokio::test(start_paused = true)]
async fn the_stderr_tail_is_in_the_last_error_message() {
    let (pool, _launcher, mut launched) = fake_pool();
    let mut declared = test_server("ts");
    declared.restart_on_crash = false;
    let ts = Arc::new(declared);
    let _ = pool.acquire(&ts, &key());
    let mut process = launched.recv().await.unwrap();
    process
        .stderr
        .write_all(b"  boom: no tsconfig\n")
        .await
        .unwrap();
    process.expect("initialize").await;
    tokio::time::sleep(Duration::from_millis(5)).await;
    process.exit("exited (code 2, signal none)");
    settle(&pool, "p/ts", State::Crashed).await;
    // The unavailable failure names only the code; the message stays on the entry (Node `lastErrorMessage`).
    let entries = pool.0.entries.lock_unpoisoned();
    let entry = entries.values().next().unwrap();
    let error = entry.last_error.clone().unwrap();
    assert_eq!(error.code, "lsp_server_start_failed");
    assert_eq!(
        error.message,
        "p/ts exited (code 2, signal none) before initialization; stderr tail: boom: no tsconfig"
    );
}

#[tokio::test(start_paused = true)]
async fn without_restart_on_crash_unavailable_is_final() {
    let (pool, _launcher, mut launched) = fake_pool();
    let mut declared = test_server("ts");
    declared.restart_on_crash = false;
    let ts = Arc::new(declared);
    let _ = pool.acquire(&ts, &key());
    let mut process = launched.recv().await.unwrap();
    process.initialize(json!({})).await;
    settle(&pool, "p/ts", State::Ready).await;
    process.exit("exited (code null, signal SIGKILL)");
    settle(&pool, "p/ts", State::Crashed).await;
    assert_eq!(
        failed(pool.acquire(&ts, &key())).0,
        "lsp_server_unavailable"
    );
    tokio::time::advance(Duration::from_secs(120)).await;
    let (code, message) = failed(pool.acquire(&ts, &key()));
    assert_eq!(code, "lsp_server_unavailable");
    assert_eq!(
        message,
        "p/ts is unavailable after 0 restarts (last error: lsp_server_crashed)"
    );
}

#[tokio::test(start_paused = true)]
async fn a_missing_command_is_retried_after_thirty_seconds() {
    let (pool, launcher, mut launched) = fake_pool();
    launcher
        .missing
        .lock_unpoisoned()
        .push("ts-server".to_owned());
    let ts = server("ts");
    // Node's spawn error arrives after acquire returned.
    assert!(matches!(pool.acquire(&ts, &key()), Acquired::Starting));
    settle(&pool, "p/ts", State::NotInstalled).await;
    let (code, message) = failed(pool.acquire(&ts, &key()));
    assert_eq!(code, "lsp_server_not_installed");
    assert_eq!(message, "command \"ts-server\" was not found");
    launcher.missing.lock_unpoisoned().clear();
    tokio::time::advance(Duration::from_secs(30)).await;
    assert!(matches!(pool.acquire(&ts, &key()), Acquired::Starting));
    assert!(launched.recv().await.is_some());
}

#[tokio::test(start_paused = true)]
async fn an_idle_server_stops_gracefully_after_ten_minutes() {
    let (pool, _launcher, mut launched) = fake_pool();
    let mut events = events(&pool);
    let ts = server("ts");
    let _ = pool.acquire(&ts, &key());
    let mut process = launched.recv().await.unwrap();
    process.initialize(json!({})).await;
    assert!(matches!(events.recv().await, Some(Event::Ready { .. })));
    tokio::time::advance(Duration::from_secs(9 * 60)).await;
    // Used at 9 minutes: the check at 10 minutes reschedules for 9 more.
    let _ = pool.acquire(&ts, &key());
    tokio::time::advance(Duration::from_secs(61)).await;
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert_eq!(state_of(&pool, "p/ts"), State::Ready);
    tokio::time::advance(Duration::from_secs(9 * 60)).await;
    let shutdown = process.expect("shutdown").await;
    process.reply(&shutdown, Value::Null).await;
    process.expect("exit").await;
    process.exit("exited (code 0, signal none)");
    assert!(matches!(events.recv().await, Some(Event::Stopped { .. })));
    assert_eq!(state_of(&pool, "p/ts"), State::Stopped);
    assert!(process.terminated.load(Ordering::SeqCst));
    // A later acquire starts it again.
    assert!(matches!(pool.acquire(&ts, &key()), Acquired::Starting));
}

#[tokio::test(start_paused = true)]
async fn the_fifth_start_stops_the_least_recently_used_idle_server() {
    let (pool, _launcher, mut launched) = fake_pool();
    let mut processes = Vec::new();
    for name in ["a", "b", "c", "d"] {
        let declared = server(name);
        let _ = pool.acquire(&declared, &key());
        let mut process = launched.recv().await.unwrap();
        process.initialize(json!({})).await;
        settle(&pool, &format!("p/{name}"), State::Ready).await;
        processes.push((declared, process));
        tokio::time::advance(Duration::from_secs(1)).await;
    }
    // `a` is used again; `b` is now the least recently used.
    let _ = pool.acquire(&processes[0].0, &key());
    let _ = pool.acquire(&server("e"), &key());
    let shutdown = processes[1].1.expect("shutdown").await;
    processes[1].1.reply(&shutdown, Value::Null).await;
    processes[1].1.expect("exit").await;
    processes[1].1.exit("exited (code 0, signal none)");
    settle(&pool, "p/b", State::Stopped).await;
    for name in ["p/a", "p/c", "p/d"] {
        assert_eq!(state_of(&pool, name), State::Ready);
    }
    assert!(launched.recv().await.is_some());
}

#[tokio::test(start_paused = true)]
async fn stop_all_stops_every_server_and_concurrent_stops_share_one() {
    let (pool, _launcher, mut launched) = fake_pool();
    let ts = server("ts");
    let _ = pool.acquire(&ts, &key());
    let mut process = launched.recv().await.unwrap();
    process.initialize(json!({})).await;
    settle(&pool, "p/ts", State::Ready).await;
    let serve = async {
        let shutdown = process.expect("shutdown").await;
        process.reply(&shutdown, Value::Null).await;
        process.expect("exit").await;
        process.exit("exited (code 0, signal none)");
    };
    let ((), (), ()) = tokio::join!(serve, pool.stop_all(), pool.stop_all());
    assert_eq!(state_of(&pool, "p/ts"), State::Stopped);
    // Stopping while starting: acquire answers starting until the stop is done.
    let _ = pool.acquire(&ts, &key());
    let _process = launched.recv().await.unwrap();
    let stop = pool.stop_all();
    tokio::pin!(stop);
    // Not initialized: no shutdown request, the tree just ends.
    stop.await;
    assert_eq!(state_of(&pool, "p/ts"), State::Stopped);
}

#[test]
fn a_server_env_replaces_keys_case_insensitively_on_windows() {
    let base = vec![
        ("Path".to_owned(), "a".to_owned()),
        ("HOME".to_owned(), "h".to_owned()),
    ];
    let server = vec![("PATH".to_owned(), "b".to_owned())];
    assert_eq!(
        merge_env(&base, &server, true),
        [
            ("HOME".to_owned(), "h".to_owned()),
            ("PATH".to_owned(), "b".to_owned())
        ]
    );
    assert_eq!(
        merge_env(&base, &server, false),
        [
            ("Path".to_owned(), "a".to_owned()),
            ("HOME".to_owned(), "h".to_owned()),
            ("PATH".to_owned(), "b".to_owned())
        ]
    );
}

/// A character split across two stderr reads is kept whole (Node decodes the stream incrementally).
#[test]
fn stderr_keeps_a_character_split_between_reads() {
    let mut pending = Vec::new();
    let bytes = "aé✓".as_bytes();
    let mut text = String::new();
    for chunk in [&bytes[..2], &bytes[2..4], &bytes[4..]] {
        text.push_str(&decode_stderr(&mut pending, chunk));
    }
    assert_eq!(text, "aé✓");
    assert!(pending.is_empty());
    // Invalid bytes are replaced, and only they are.
    assert_eq!(decode_stderr(&mut pending, b"x\xffy"), "x\u{fffd}y");
    // An incomplete character at the end is one replacement character.
    assert_eq!(decode_stderr(&mut pending, b"a\xc3"), "a");
    assert_eq!(finish_stderr(&pending), "\u{fffd}");
    assert_eq!(finish_stderr(&[]), "");
}

/// The enabled gate is read under the entries lock, so a concurrent `stop_all` either runs first (the gate then reads
/// closed and nothing starts) or runs after the start and stops it. A gate read outside the lock left a window where a
/// server started after code intelligence was turned off and lived until the idle stop.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_gate_is_read_under_the_lock_that_stop_all_takes() {
    let (pool, _launcher, mut launched) = fake_pool();
    let enabled = Arc::new(AtomicBool::new(true));
    let (entered, entered_rx) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel::<()>();
    let acquiring = {
        let pool = pool.clone();
        let runtime = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            let _runtime = runtime.enter();
            // The gate reads "on", then stalls inside the lock as a preempted check would.
            pool.acquire_when(&server("ts"), &key(), || {
                entered.send(()).unwrap();
                release_rx.recv().unwrap();
                true
            })
        })
    };
    entered_rx.recv().unwrap();
    // Turned off while the gate is stalled: stop_all must wait for the lock.
    enabled.store(false, Ordering::SeqCst);
    let stop = tokio::spawn({
        let pool = pool.clone();
        async move { pool.stop_all().await }
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        !stop.is_finished(),
        "stop_all passed the lock the gate holds"
    );
    release.send(()).unwrap();
    assert!(matches!(
        acquiring.join().unwrap(),
        Some(Acquired::Starting)
    ));
    let _process = launched.recv().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), stop)
        .await
        .expect("stop_all ends the server that started")
        .unwrap();
    assert_eq!(state_of(&pool, "p/ts"), State::Stopped);
    // After the switch the gate reads closed: nothing starts and no entry is made.
    let gate = Arc::clone(&enabled);
    assert!(
        pool.acquire_when(&server("ts"), &key(), || gate.load(Ordering::SeqCst))
            .is_none()
    );
    assert!(launched.try_recv().is_err());
}
