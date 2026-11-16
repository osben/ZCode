//! Tests of the Node helper client against a fake helper over `tokio::io::duplex`. The fake speaks the same line
//! framing; its behaviour per method is scripted by the test.

use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::Duration;

use rust_cli_base::Task;
use rust_cli_base::TaskScope;
use rust_cli_protocol_core::connection::{self, Options};
use rust_cli_protocol_core::rpc::{self, RpcError};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, duplex};

use super::*;

/// What the fake helper does with one forwarded request.
#[derive(Clone)]
enum Act {
    /// Sends the notifications first, then answers `result`.
    Reply {
        notes: Vec<(&'static str, Value)>,
        result: Value,
    },
    Fail(RpcError),
    /// Stops answering and closes its stdout, as a crashed process does.
    Crash,
    /// Never answers this request; later requests are still served.
    Hang,
    /// Answers `result` after `after`, holding the helper's loop meanwhile.
    Delay {
        after: Duration,
        result: Value,
    },
    /// Sends a request of its own, then answers the forwarded call with `{}`.
    AskHost,
    /// Sends the notifications and answers nothing (a notification from Rust, such as `helper/mcp/send`).
    Notify(Vec<(&'static str, Value)>),
    /// Sends `count` `plugins/operationProgress` notifications `every` apart, then answers `result`, holding the
    /// helper's loop meanwhile (a long install reporting progress).
    Stream {
        every: Duration,
        count: usize,
        result: Value,
    },
}

type Behaviour = dyn Fn(usize, &str, &Value) -> Act + Send + Sync;

/// A fake launcher: each launch starts a fake helper whose behaviour sees the launch index.
struct Fake {
    advertised: Vec<String>,
    version: u64,
    fail_launch: bool,
    /// The first launch panics, as a buggy launcher would.
    panic_first_launch: bool,
    /// Each launch takes this long before the process exists.
    launch_delay: Duration,
    /// The helper never answers `helper/initialize`.
    hang_initialize: bool,
    behaviour: Arc<Behaviour>,
    launches: Arc<AtomicUsize>,
    /// Incremented when a launched process's guard is dropped (the process tree is killed).
    stopped: Arc<AtomicUsize>,
    /// Responses the helper received for its own requests.
    answers: Arc<StdMutex<Vec<Value>>>,
    /// Every forwarded request the helper received, as `(method, params)`.
    received: Arc<StdMutex<Vec<(String, Value)>>>,
    /// The helper under test, so a guard can check how it is dropped.
    helper: Arc<OnceLock<Weak<NodeHelper>>>,
    /// Incremented when a guard is dropped while the helper's state lock is held.
    dropped_under_lock: Arc<AtomicUsize>,
}

struct Stop {
    stopped: Arc<AtomicUsize>,
    helper: Arc<OnceLock<Weak<NodeHelper>>>,
    dropped_under_lock: Arc<AtomicUsize>,
}

impl Drop for Stop {
    fn drop(&mut self) {
        self.stopped.fetch_add(1, Ordering::SeqCst);
        // A guard comes from an injected launcher and may block, so it must not run under the state lock.
        if let Some(helper) = self.helper.get().and_then(Weak::upgrade)
            && helper.state.try_lock().is_err()
        {
            self.dropped_under_lock.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[async_trait]
impl NodeHelperLauncher for Fake {
    async fn launch(&self) -> io::Result<NodeHelperProcess> {
        let index = self.launches.fetch_add(1, Ordering::SeqCst);
        assert!(
            !(self.panic_first_launch && index == 0),
            "the launcher panics"
        );
        tokio::time::sleep(self.launch_delay).await;
        if self.fail_launch {
            return Err(io::Error::new(io::ErrorKind::NotFound, "no such file"));
        }
        let (to_helper, helper_in) = duplex(1 << 16);
        let (helper_out, from_helper) = duplex(1 << 16);
        let script = Script {
            index,
            advertised: self.advertised.clone(),
            version: self.version,
            hang_initialize: self.hang_initialize,
            behaviour: self.behaviour.clone(),
            answers: self.answers.clone(),
            received: self.received.clone(),
        };
        tokio::spawn(run_helper(script, helper_in, helper_out));
        Ok(NodeHelperProcess {
            stdin: Box::new(to_helper),
            stdout: Box::new(BufReader::new(from_helper)),
            guard: Box::new(Stop {
                stopped: self.stopped.clone(),
                helper: self.helper.clone(),
                dropped_under_lock: self.dropped_under_lock.clone(),
            }),
        })
    }
}

struct Script {
    index: usize,
    advertised: Vec<String>,
    version: u64,
    hang_initialize: bool,
    behaviour: Arc<Behaviour>,
    answers: Arc<StdMutex<Vec<Value>>>,
    received: Arc<StdMutex<Vec<(String, Value)>>>,
}

async fn write_line(output: &mut DuplexStream, line: String) {
    output.write_all(format!("{line}\n").as_bytes()).await.ok();
    output.flush().await.ok();
}

async fn run_helper(script: Script, input: DuplexStream, mut output: DuplexStream) {
    let mut lines = BufReader::new(input).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(method) = message["method"].as_str() else {
            // A response to a request the helper made.
            script.answers.lock().unwrap().push(message);
            continue;
        };
        let id = message["id"].clone();
        let params = message["params"].clone();
        if method == "helper/initialize" {
            if script.hang_initialize {
                continue;
            }
            let result = json!({"protocolVersion": script.version, "methods": script.advertised});
            write_line(&mut output, rpc::response(&id, &Ok(result))).await;
            continue;
        }
        script
            .received
            .lock()
            .unwrap()
            .push((method.to_owned(), params.clone()));
        match (script.behaviour)(script.index, method, &params) {
            Act::Reply { notes, result } => {
                for (note, note_params) in notes {
                    write_line(&mut output, rpc::notification(note, &note_params)).await;
                }
                write_line(&mut output, rpc::response(&id, &Ok(result))).await;
            }
            Act::Fail(error) => write_line(&mut output, rpc::response(&id, &Err(error))).await,
            Act::Crash => return,
            Act::Notify(notes) => {
                for (note, note_params) in notes {
                    write_line(&mut output, rpc::notification(note, &note_params)).await;
                }
            }
            Act::Hang => {}
            Act::Delay { after, result } => {
                tokio::time::sleep(after).await;
                write_line(&mut output, rpc::response(&id, &Ok(result))).await;
            }
            Act::AskHost => {
                write_line(
                    &mut output,
                    rpc::request(&json!("h-1"), "host/askSomething", &json!({})),
                )
                .await;
                write_line(&mut output, rpc::response(&id, &Ok(json!({})))).await;
            }
            Act::Stream {
                every,
                count,
                result,
            } => {
                for step in 0..count {
                    tokio::time::sleep(every).await;
                    write_line(
                        &mut output,
                        rpc::notification("plugins/operationProgress", &json!({"step": step})),
                    )
                    .await;
                }
                write_line(&mut output, rpc::response(&id, &Ok(result))).await;
            }
        }
    }
}

fn behaviour(f: impl Fn(usize, &str, &Value) -> Act + Send + Sync + 'static) -> Arc<Behaviour> {
    Arc::new(f)
}

/// Echoes the params back, for every method, on every launch.
fn echo() -> Arc<Behaviour> {
    behaviour(|_, _, params| Act::Reply {
        notes: Vec::new(),
        result: params.clone(),
    })
}

fn fake(advertised: &[&str], behaviour: Arc<Behaviour>) -> Fake {
    Fake {
        advertised: advertised
            .iter()
            .map(|method| (*method).to_owned())
            .collect(),
        version: PROTOCOL_VERSION,
        fail_launch: false,
        panic_first_launch: false,
        launch_delay: Duration::ZERO,
        hang_initialize: false,
        behaviour,
        launches: Arc::new(AtomicUsize::new(0)),
        stopped: Arc::new(AtomicUsize::new(0)),
        answers: Arc::new(StdMutex::new(Vec::new())),
        received: Arc::new(StdMutex::new(Vec::new())),
        helper: Arc::new(OnceLock::new()),
        dropped_under_lock: Arc::new(AtomicUsize::new(0)),
    }
}

fn timing() -> Timing {
    Timing {
        request: Duration::from_secs(5),
        sampling: Duration::from_secs(5),
        default_request: Duration::from_secs(5),
        ping: Duration::from_secs(1),
        initialize: Duration::from_secs(2),
        cancel: Duration::from_secs(1),
        idle: Duration::from_secs(300),
        crash_window: Duration::from_secs(60),
        crash_limit: 3,
        start_cooldown: Duration::from_secs(30),
    }
}

struct Rig {
    helper: Arc<NodeHelper>,
    fake: Arc<Fake>,
    host: Lines<BufReader<DuplexStream>>,
    clock: Arc<rust_cli_kernel_api::testing::FixedClock>,
    _writer: Task<()>,
    _scope: TaskScope,
}

/// The Rust side: a NodeHelper whose host peer writes to `host`.
fn rig(fake: Fake, timing: Timing) -> Rig {
    let scope = TaskScope::root("node-helper-test", |_| {});
    let (host_out, host_in) = duplex(1 << 16);
    let (host_peer, writer) = connection::start(host_out, &scope.spawner(), Options::default());
    let fake = Arc::new(fake);
    let helper = NodeHelper::new(fake.clone(), scope.spawner(), host_peer, timing);
    fake.helper
        .set(Arc::downgrade(&helper))
        .expect("one rig per fake");
    Rig {
        helper,
        fake,
        host: BufReader::new(host_in).lines(),
        clock: Arc::new(rust_cli_kernel_api::testing::FixedClock(0)),
        _writer: writer,
        _scope: scope,
    }
}

fn expect_unavailable(error: &RpcError) {
    assert_eq!(
        error.data,
        Some(json!({"reasonCode": NODE_HELPER_UNAVAILABLE})),
        "unexpected error: {error:?}"
    );
}

async fn forward_ok(helper: &NodeHelper, method: &str, params: Value) -> Value {
    helper
        .forward(method, &params)
        .await
        .expect("the method is forwarded")
        .expect("the call succeeds")
}

#[test]
fn forwarded_table_is_the_spec_list() {
    assert_eq!(FORWARDED_METHODS.len(), 53);
    let plugins = FORWARDED_METHODS
        .iter()
        .filter(|method| method.starts_with("plugins/"))
        .count();
    let workflows = FORWARDED_METHODS
        .iter()
        .filter(|method| method.starts_with("workflows/"))
        .count();
    let runs = FORWARDED_METHODS
        .iter()
        .filter(|method| method.starts_with("v4/conversation/workflowRun"))
        .count();
    let session = FORWARDED_METHODS
        .iter()
        .filter(|method| method.starts_with("mcp/"))
        .count();
    assert_eq!((plugins, workflows, runs, session), (21, 8, 7, 17));
    // F3 adds the session-scoped methods (`plugins/mentionItems` among them); the sessionless skills catalog that Rust
    // answers itself stays out.
    assert!(FORWARDED_METHODS.contains(&"plugins/mentionItems"));
    assert!(!FORWARDED_METHODS.contains(&"skills/referenceCatalog"));
    assert_eq!(RELAYED_NOTIFICATIONS, &["plugins/operationProgress"]);
}

#[tokio::test]
async fn only_allowlisted_and_advertised_methods_are_forwarded() {
    let rig = rig(fake(&["plugins/list"], echo()), timing());
    let listed = forward_ok(&rig.helper, "plugins/list", json!({"workspace": "w"})).await;
    assert_eq!(listed, json!({"workspace": "w"}));
    // Allowlisted but not advertised by the helper: not forwarded.
    assert!(
        rig.helper
            .forward("plugins/install", &json!({}))
            .await
            .is_none()
    );
    // Not allowlisted at all.
    assert!(
        rig.helper
            .forward("session/list", &json!({}))
            .await
            .is_none()
    );
    assert!(
        rig.helper
            .forward("helper/initialize", &json!({}))
            .await
            .is_none()
    );
}

#[tokio::test]
async fn helper_errors_pass_through_verbatim() {
    let error = RpcError::new(-32010, "plugin is busy").with_data(json!({"pluginId": "p"}));
    let behaviour = behaviour(move |_, _, _| Act::Fail(error.clone()));
    let rig = rig(fake(&["plugins/install"], behaviour), timing());
    let failure = rig
        .helper
        .forward("plugins/install", &json!({}))
        .await
        .expect("forwarded")
        .expect_err("the helper failed");
    assert_eq!(failure.code, -32010);
    assert_eq!(failure.message, "plugin is busy");
    assert_eq!(failure.data, Some(json!({"pluginId": "p"})));
    // A helper error is an answer, not a crash: the helper stays up.
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 1);
    assert_eq!(rig.helper.crash_count(), 0);
}

#[tokio::test]
async fn concurrent_first_calls_share_one_start() {
    let rig = rig(fake(&["plugins/list"], echo()), timing());
    let calls = (0..4).map(|n| forward_ok(&rig.helper, "plugins/list", json!({"n": n})));
    let answers = futures_util::future::join_all(calls).await;
    assert_eq!(answers.len(), 4);
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn launch_failure_is_unavailable() {
    let mut launcher = fake(&["plugins/list"], echo());
    launcher.fail_launch = true;
    let rig = rig(launcher, timing());
    let error = rig
        .helper
        .forward("plugins/list", &json!({}))
        .await
        .expect("forwarded")
        .expect_err("the launch failed");
    expect_unavailable(&error);
}

#[tokio::test(start_paused = true)]
async fn a_failed_start_fails_fast_until_the_cooldown_ends() {
    let mut launcher = fake(&["plugins/list"], echo());
    launcher.fail_launch = true;
    let rig = rig(launcher, timing());
    for _ in 0..3 {
        let error = rig
            .helper
            .forward("plugins/list", &json!({}))
            .await
            .expect("forwarded")
            .expect_err("no helper");
        expect_unavailable(&error);
    }
    // A broken bundle is launched once per cooldown, not once per call.
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 1);
    assert_eq!(rig.helper.crash_count(), 0);

    tokio::time::sleep(Duration::from_secs(31)).await;
    let error = rig
        .helper
        .forward("plugins/list", &json!({}))
        .await
        .expect("forwarded")
        .expect_err("still no helper");
    expect_unavailable(&error);
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn cancel_operation_without_a_running_helper_starts_none() {
    let rig = rig(fake(&["plugins/cancelOperation"], echo()), timing());
    assert_eq!(
        forward_ok(
            &rig.helper,
            "plugins/cancelOperation",
            json!({"operationId": "op-1"})
        )
        .await,
        json!({"operationId": "op-1", "cancelled": false})
    );
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn a_start_whose_caller_is_dropped_still_completes() {
    let rig = rig(fake(&["plugins/list"], echo()), timing());
    // The caller gives up while the helper is still starting.
    let dropped = tokio::time::timeout(
        Duration::ZERO,
        rig.helper.forward("plugins/list", &json!({})),
    )
    .await;
    assert!(dropped.is_err(), "the call was still starting");

    // The start ran on its own: the helper became the running process and its idle timer reclaims it.
    tokio::time::sleep(Duration::from_secs(302)).await;
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 1);
    assert_eq!(rig.fake.stopped.load(Ordering::SeqCst), 1);
    assert_eq!(rig.helper.crash_count(), 0);
}

#[tokio::test]
async fn initialize_version_mismatch_is_unavailable_and_not_retried() {
    let mut launcher = fake(&["plugins/list"], echo());
    launcher.version = PROTOCOL_VERSION + 1;
    let rig = rig(launcher, timing());
    for _ in 0..2 {
        let error = rig
            .helper
            .forward("plugins/list", &json!({}))
            .await
            .expect("forwarded")
            .expect_err("the versions differ");
        expect_unavailable(&error);
    }
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn crash_fails_the_call_in_flight_and_the_next_call_respawns() {
    let behaviour = behaviour(|launch, _, _| {
        if launch == 0 {
            Act::Crash
        } else {
            Act::Reply {
                notes: Vec::new(),
                result: json!({"ok": true}),
            }
        }
    });
    let rig = rig(fake(&["plugins/list"], behaviour), timing());
    let error = rig
        .helper
        .forward("plugins/list", &json!({}))
        .await
        .expect("forwarded")
        .expect_err("the helper crashed during the call");
    expect_unavailable(&error);
    assert_eq!(rig.helper.crash_count(), 1);

    let answer = forward_ok(&rig.helper, "plugins/list", json!({})).await;
    assert_eq!(answer, json!({"ok": true}));
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn three_crashes_within_the_window_keep_the_helper_down() {
    let behaviour = behaviour(|_, _, _| Act::Crash);
    let rig = rig(fake(&["plugins/list"], behaviour), timing());
    for _ in 0..3 {
        let error = rig
            .helper
            .forward("plugins/list", &json!({}))
            .await
            .expect("forwarded")
            .expect_err("the helper crashed");
        expect_unavailable(&error);
    }
    let error = rig
        .helper
        .forward("plugins/list", &json!({}))
        .await
        .expect("forwarded")
        .expect_err("the breaker is open");
    expect_unavailable(&error);
    // The breaker answers without starting another helper.
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 3);
}

#[tokio::test(start_paused = true)]
async fn idle_reclaim_drops_the_process_and_is_not_a_crash() {
    let rig = rig(fake(&["plugins/list"], echo()), timing());
    forward_ok(&rig.helper, "plugins/list", json!({"n": 1})).await;
    assert_eq!(rig.fake.stopped.load(Ordering::SeqCst), 0);

    tokio::time::sleep(Duration::from_secs(301)).await;
    assert_eq!(rig.fake.stopped.load(Ordering::SeqCst), 1, "reclaimed");
    assert_eq!(rig.helper.crash_count(), 0);

    forward_ok(&rig.helper, "plugins/list", json!({"n": 2})).await;
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 2);
    assert_eq!(rig.helper.crash_count(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_call_dropped_by_its_caller_does_not_keep_the_helper_alive() {
    let rig = rig(
        fake(&["plugins/list"], behaviour(|_, _, _| Act::Hang)),
        timing(),
    );
    // The Host side gives up before the helper answers and drops the forwarded call.
    let dropped = tokio::time::timeout(
        Duration::from_secs(1),
        rig.helper.forward("plugins/list", &json!({})),
    )
    .await;
    assert!(dropped.is_err(), "the call was still waiting");

    tokio::time::sleep(Duration::from_secs(302)).await;
    assert_eq!(
        rig.fake.stopped.load(Ordering::SeqCst),
        1,
        "the dropped call no longer counts as in flight, so the idle helper is reclaimed"
    );
    assert_eq!(rig.helper.crash_count(), 0);
}

#[tokio::test]
async fn a_timed_out_call_fails_unavailable_and_the_next_call_starts_again() {
    let behaviour = behaviour(|launch, _, _| {
        if launch == 0 {
            Act::Hang
        } else {
            Act::Reply {
                notes: Vec::new(),
                result: json!({"ok": true}),
            }
        }
    });
    let mut short = timing();
    short.request = Duration::from_millis(100);
    let rig = rig(fake(&["plugins/list"], behaviour), short);
    let error = rig
        .helper
        .forward("plugins/list", &json!({}))
        .await
        .expect("forwarded")
        .expect_err("the call times out");
    expect_unavailable(&error);
    // A hung helper is dropped with its process; a timeout is not counted as a crash.
    assert_eq!(rig.fake.stopped.load(Ordering::SeqCst), 1);
    assert_eq!(rig.helper.crash_count(), 0);

    assert_eq!(
        forward_ok(&rig.helper, "plugins/list", json!({})).await,
        json!({"ok": true})
    );
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn operation_progress_is_relayed_and_other_notifications_are_dropped() {
    let behaviour = behaviour(|_, _, _| Act::Reply {
        notes: vec![
            ("debug/streamChunk", json!({"chunk": 1})),
            ("plugins/operationProgress", json!({"operationId": "op-1"})),
        ],
        result: json!({}),
    });
    let mut rig = rig(fake(&["plugins/install"], behaviour), timing());
    forward_ok(&rig.helper, "plugins/install", json!({})).await;

    let line = tokio::time::timeout(Duration::from_secs(2), rig.host.next_line())
        .await
        .expect("the progress is relayed")
        .expect("the host stream reads")
        .expect("a line");
    let relayed: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(relayed["method"], "plugins/operationProgress");
    assert_eq!(relayed["params"], json!({"operationId": "op-1"}));

    // Nothing else reaches the host.
    let extra = tokio::time::timeout(Duration::from_millis(200), rig.host.next_line()).await;
    assert!(
        extra.is_err(),
        "no other notification is relayed: {extra:?}"
    );
}

#[tokio::test]
async fn a_request_from_the_helper_is_answered_method_not_found() {
    let behaviour = behaviour(|_, _, _| Act::AskHost);
    let rig = rig(fake(&["plugins/list"], behaviour), timing());
    forward_ok(&rig.helper, "plugins/list", json!({})).await;
    // The answer to the helper's request arrives after the forwarded reply; wait for it.
    for _ in 0..50 {
        if !rig.fake.answers.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let answers = rig.fake.answers.lock().unwrap().clone();
    assert_eq!(answers.len(), 1, "{answers:?}");
    assert_eq!(answers[0]["id"], "h-1");
    assert_eq!(answers[0]["error"]["code"], -32601);
}

async fn forward_err(helper: &NodeHelper, method: &str, params: Value) -> RpcError {
    helper
        .forward(method, &params)
        .await
        .expect("the method is forwarded")
        .expect_err("the call fails")
}

#[tokio::test(start_paused = true)]
async fn a_start_that_panics_cools_down_and_then_starts_again() {
    let mut launcher = fake(&["plugins/list"], echo());
    launcher.panic_first_launch = true;
    let rig = rig(launcher, timing());
    expect_unavailable(&forward_err(&rig.helper, "plugins/list", json!({})).await);
    // The interrupted start is a failed start: calls fail fast instead of awaiting a start that never ends.
    expect_unavailable(&forward_err(&rig.helper, "plugins/list", json!({})).await);
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 1);

    tokio::time::sleep(Duration::from_secs(31)).await;
    forward_ok(&rig.helper, "plugins/list", json!({})).await;
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn a_helper_that_advertises_no_methods_is_a_failed_start() {
    let rig = rig(fake(&[], echo()), timing());
    // Not `None` (-32601): a helper with an empty method list is a broken helper, reported as unavailable.
    expect_unavailable(&forward_err(&rig.helper, "plugins/list", json!({})).await);
    assert_eq!(
        rig.fake.stopped.load(Ordering::SeqCst),
        1,
        "its process is dropped"
    );
    expect_unavailable(&forward_err(&rig.helper, "plugins/list", json!({})).await);
    assert_eq!(
        rig.fake.launches.load(Ordering::SeqCst),
        1,
        "the cooldown applies"
    );
}

#[tokio::test(start_paused = true)]
async fn a_helper_that_never_initializes_fails_at_the_initialize_deadline() {
    let mut launcher = fake(&["plugins/list"], echo());
    launcher.hang_initialize = true;
    let mut slow = timing();
    slow.request = Duration::from_secs(300);
    let rig = rig(launcher, slow);
    let started = Instant::now();
    expect_unavailable(&forward_err(&rig.helper, "plugins/list", json!({})).await);
    // The handshake has its own short deadline, not the 300 s call timeout.
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(rig.fake.stopped.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_timed_out_call_leaves_a_responsive_process_and_its_other_calls_alone() {
    let behaviour = behaviour(|_, method, _| {
        if method == "plugins/install" {
            Act::Hang
        } else {
            Act::Delay {
                after: Duration::from_secs(1),
                result: json!({"ok": true}),
            }
        }
    });
    let mut short = timing();
    short.request = Duration::from_secs(10);
    let rig = rig(
        fake(
            &["plugins/install", "plugins/list", "plugins/cancelOperation"],
            behaviour,
        ),
        short,
    );
    let install = forward_err(
        &rig.helper,
        "plugins/install",
        json!({"operationId": " op-1 "}),
    );
    let lists = async {
        // Answered while the install runs: the process is alive.
        tokio::time::sleep(Duration::from_secs(2)).await;
        let first = forward_ok(&rig.helper, "plugins/list", json!({})).await;
        // Still in flight when the install times out at t = 10 s.
        tokio::time::sleep(Duration::from_millis(6500)).await;
        let second = async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            forward_ok(&rig.helper, "plugins/list", json!({})).await
        };
        let held = async {
            // Holds the helper's loop across t = 10 s so the second list is in flight then.
            forward_ok(&rig.helper, "plugins/list", json!({})).await
        };
        let (second, held) = tokio::join!(second, held);
        (first, second, held)
    };
    let (install, (first, second, held)) = tokio::join!(install, lists);
    expect_unavailable(&install);
    assert_eq!(first, json!({"ok": true}));
    assert_eq!(second, json!({"ok": true}));
    assert_eq!(held, json!({"ok": true}));
    assert_eq!(
        rig.fake.stopped.load(Ordering::SeqCst),
        0,
        "the process is kept"
    );
    assert_eq!(rig.helper.crash_count(), 0);
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 1);
    // The kept process still runs the abandoned install: it is cancelled in the helper, under the operation id the
    // helper registered it by (trimmed, as `getPluginOperationId` does).
    tokio::time::sleep(Duration::from_secs(2)).await;
    let cancels: Vec<Value> = rig
        .fake
        .received
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "plugins/cancelOperation")
        .map(|(_, params)| params.clone())
        .collect();
    assert_eq!(cancels, vec![json!({"operationId": "op-1"})]);
}

#[tokio::test(start_paused = true)]
async fn a_long_call_reporting_progress_keeps_the_process_when_a_neighbour_times_out() {
    let behaviour = behaviour(|_, method, params| match method {
        "plugins/install" => Act::Hang,
        "plugins/update" => Act::Stream {
            every: Duration::from_millis(500),
            count: 18,
            result: json!({"updated": true}),
        },
        _ => Act::Reply {
            notes: Vec::new(),
            result: params.clone(),
        },
    });
    let mut short = timing();
    short.request = Duration::from_secs(10);
    let rig = rig(
        fake(
            &["plugins/install", "plugins/update", "plugins/list"],
            behaviour,
        ),
        short,
    );
    // Answered at t = 0; nothing answers again before the install times out at t = 11 s.
    forward_ok(&rig.helper, "plugins/list", json!({})).await;
    let install = async {
        tokio::time::sleep(Duration::from_secs(1)).await;
        forward_err(&rig.helper, "plugins/install", json!({})).await
    };
    // Reports progress from t = 4.5 s and answers at t = 13 s.
    let update = async {
        tokio::time::sleep(Duration::from_secs(4)).await;
        forward_ok(&rig.helper, "plugins/update", json!({})).await
    };
    let (install, update) = tokio::join!(install, update);
    expect_unavailable(&install);
    assert_eq!(update, json!({"updated": true}));
    assert_eq!(
        rig.fake.stopped.load(Ordering::SeqCst),
        0,
        "a process that reports progress is alive"
    );
}

#[tokio::test(start_paused = true)]
async fn a_hung_process_is_dropped_even_with_other_calls_in_flight() {
    let rig = rig(
        fake(&["plugins/list"], behaviour(|_, _, _| Act::Hang)),
        timing(),
    );
    let first = forward_err(&rig.helper, "plugins/list", json!({}));
    let second = async {
        tokio::time::sleep(Duration::from_secs(2)).await;
        forward_err(&rig.helper, "plugins/list", json!({})).await
    };
    let (first, second) = tokio::join!(first, second);
    expect_unavailable(&first);
    expect_unavailable(&second);
    // The process answered nothing since the first call started, so its timeout drops it: the second call fails
    // with the closed connection instead of keeping a hung process alive.
    assert_eq!(rig.fake.stopped.load(Ordering::SeqCst), 1);
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn dropped_processes_are_released_outside_the_state_lock() {
    let behaviour = behaviour(|launch, _, params| match launch {
        0 => Act::Crash,
        1 => Act::Hang,
        _ => Act::Reply {
            notes: Vec::new(),
            result: params.clone(),
        },
    });
    let rig = rig(fake(&["plugins/list"], behaviour), timing());
    // Crash, then a timeout of the only call in flight, then an idle reclaim.
    expect_unavailable(&forward_err(&rig.helper, "plugins/list", json!({})).await);
    expect_unavailable(&forward_err(&rig.helper, "plugins/list", json!({})).await);
    forward_ok(&rig.helper, "plugins/list", json!({})).await;
    tokio::time::sleep(Duration::from_secs(301)).await;
    assert_eq!(rig.fake.stopped.load(Ordering::SeqCst), 3);
    assert_eq!(rig.fake.dropped_under_lock.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn version_mismatch_releases_the_process_outside_the_state_lock() {
    let mut launcher = fake(&["plugins/list"], echo());
    launcher.version = PROTOCOL_VERSION + 1;
    let rig = rig(launcher, timing());
    expect_unavailable(&forward_err(&rig.helper, "plugins/list", json!({})).await);
    assert_eq!(rig.fake.stopped.load(Ordering::SeqCst), 1);
    assert_eq!(rig.fake.dropped_under_lock.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn cancel_operation_while_the_helper_starts_waits_for_it() {
    let mut launcher = fake(&["plugins/install", "plugins/cancelOperation"], echo());
    launcher.launch_delay = Duration::from_secs(1);
    let rig = rig(launcher, timing());
    let install = forward_ok(
        &rig.helper,
        "plugins/install",
        json!({"operationId": "op-1"}),
    );
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        forward_ok(
            &rig.helper,
            "plugins/cancelOperation",
            json!({"operationId": "op-1"}),
        )
        .await
    };
    let (_, cancel) = tokio::join!(install, cancel);
    // Forwarded to the helper (the fake echoes the params), not answered `cancelled: false` locally.
    assert_eq!(cancel, json!({"operationId": "op-1"}));
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 1);
}

// ── F3: helper MCP pipes ────────────────────────────────────────────────────────────────────────────────────────────

/// A helper whose pipes answer every MCP request with `{"method": <its method>}`; `die` makes the helper report the
/// real server closed, `crash` crashes the helper.
fn mcp_echo() -> Arc<Behaviour> {
    behaviour(|_, method, params| match method {
        "helper/mcp/connect" => Act::Reply {
            notes: Vec::new(),
            result: json!({}),
        },
        "helper/mcp/send" => {
            let connection = params["connection"].clone();
            let message = &params["message"];
            match message["method"].as_str() {
                Some("crash") => Act::Crash,
                Some("die") => Act::Notify(vec![(
                    "helper/mcp/closed",
                    json!({"connection": connection, "reason": "gone"}),
                )]),
                Some(name) if message.get("id").is_some() => Act::Notify(vec![(
                    "helper/mcp/message",
                    json!({"connection": connection, "message": {"jsonrpc": "2.0", "id": message["id"], "result": {"method": name}}}),
                )]),
                _ => Act::Notify(Vec::new()),
            }
        }
        _ => Act::Notify(Vec::new()),
    })
}

fn workspace_params() -> Value {
    json!({"workspacePath": "/w", "workspaceIdentity": "id-w"})
}

async fn next_event(
    connection: &mut HelperMcpConnection,
) -> rust_cli_kernel_api::mcp::McpTransportEvent {
    tokio::time::timeout(Duration::from_secs(5), connection.events.recv())
        .await
        .expect("an event in time")
        .expect("the stream is open")
}

fn received(fake: &Fake, method: &str) -> Vec<Value> {
    fake.received
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| name == method)
        .map(|(_, params)| params.clone())
        .collect()
}

#[tokio::test]
async fn a_helper_mcp_connection_carries_messages_in_order() {
    let rig = rig(fake(&["plugins/list"], mcp_echo()), timing());
    let mut connection = rig
        .helper
        .mcp_connect(&workspace_params(), "plugin:viewer:view")
        .await
        .expect("connected");
    let connects = received(&rig.fake, "helper/mcp/connect");
    assert_eq!(
        connects,
        [
            json!({"connection": connection.id, "server": "plugin:viewer:view", "workspace": workspace_params()})
        ]
    );
    for (id, method) in [(1, "initialize"), (2, "tools/list"), (3, "tools/call")] {
        rig.helper
            .mcp_send(
                &connection.id,
                json!({"jsonrpc": "2.0", "id": id, "method": method}),
            )
            .await
            .expect("sent");
    }
    for (id, method) in [(1, "initialize"), (2, "tools/list"), (3, "tools/call")] {
        assert_eq!(
            next_event(&mut connection).await,
            rust_cli_kernel_api::mcp::McpTransportEvent::Message {
                message: json!({"jsonrpc": "2.0", "id": id, "result": {"method": method}}),
            }
        );
    }
}

#[tokio::test]
async fn the_helper_reports_a_closed_server_and_rust_closes_its_own() {
    let rig = rig(fake(&["plugins/list"], mcp_echo()), timing());
    let mut lost = rig
        .helper
        .mcp_connect(&workspace_params(), "plugin:a:s")
        .await
        .expect("connected");
    rig.helper
        .mcp_send(&lost.id, json!({"jsonrpc": "2.0", "method": "die"}))
        .await
        .expect("sent");
    assert!(matches!(
        next_event(&mut lost).await,
        rust_cli_kernel_api::mcp::McpTransportEvent::Closed { reason: Some(reason), .. } if reason == "gone"
    ));
    assert!(lost.events.recv().await.is_none(), "the stream ends");
    assert!(
        rig.helper
            .mcp_send(
                &lost.id,
                json!({"jsonrpc": "2.0", "id": 9, "method": "ping"})
            )
            .await
            .is_err(),
        "a closed pipe refuses sends"
    );

    let mut closed = rig
        .helper
        .mcp_connect(&workspace_params(), "plugin:a:s")
        .await
        .expect("connected");
    rig.helper.mcp_close(&closed.id).await;
    assert!(matches!(
        next_event(&mut closed).await,
        rust_cli_kernel_api::mcp::McpTransportEvent::Closed { .. }
    ));
    // The close notification reaches the helper (it is unanswered, so wait for it to arrive).
    tokio::time::timeout(Duration::from_secs(5), async {
        while received(&rig.fake, "helper/mcp/close").is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the helper hears the close");
    assert_eq!(
        received(&rig.fake, "helper/mcp/close"),
        [json!({"connection": closed.id})]
    );
}

#[tokio::test]
async fn a_helper_crash_closes_its_pipes_and_a_new_connection_starts_a_new_helper() {
    let rig = rig(fake(&["plugins/list"], mcp_echo()), timing());
    let mut first = rig
        .helper
        .mcp_connect(&workspace_params(), "plugin:a:s")
        .await
        .expect("connected");
    let mut second = rig
        .helper
        .mcp_connect(&workspace_params(), "plugin:a:t")
        .await
        .expect("connected");
    rig.helper
        .mcp_send(&first.id, json!({"jsonrpc": "2.0", "method": "crash"}))
        .await
        .expect("sent");
    for pipe in [&mut first, &mut second] {
        assert!(matches!(
            next_event(pipe).await,
            rust_cli_kernel_api::mcp::McpTransportEvent::Closed { .. }
        ));
    }
    assert_eq!(rig.helper.crash_count(), 1);
    rig.helper
        .mcp_connect(&workspace_params(), "plugin:a:s")
        .await
        .expect("a reconnect starts the next generation");
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_refused_connect_is_a_connect_error() {
    let behaviour = behaviour(|_, method, _| match method {
        "helper/mcp/connect" => Act::Fail(RpcError::internal("MCP server failed to start")),
        _ => Act::Notify(Vec::new()),
    });
    let rig = rig(fake(&["plugins/list"], behaviour), timing());
    let error = rig
        .helper
        .mcp_connect(&workspace_params(), "plugin:a:s")
        .await
        .expect_err("refused");
    assert!(
        matches!(&error, rust_cli_kernel_api::mcp::McpError::Connect { message } if message.contains("failed to start")),
        "{error:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn an_open_pipe_keeps_the_helper_from_idle_reclaim() {
    let rig = rig(fake(&["plugins/list"], mcp_echo()), timing());
    let connection = rig
        .helper
        .mcp_connect(&workspace_params(), "plugin:a:s")
        .await
        .expect("connected");
    tokio::time::sleep(Duration::from_secs(301)).await;
    assert_eq!(
        rig.fake.stopped.load(Ordering::SeqCst),
        0,
        "kept by the pipe"
    );
    rig.helper.mcp_close(&connection.id).await;
    tokio::time::sleep(Duration::from_secs(301)).await;
    assert_eq!(
        rig.fake.stopped.load(Ordering::SeqCst),
        1,
        "reclaimed once idle"
    );
    assert_eq!(rig.helper.crash_count(), 0);
}

#[tokio::test]
async fn the_routing_transport_sends_node_helper_servers_to_the_helper() {
    use futures_util::StreamExt;
    use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
    use rust_cli_kernel_api::ids::EnvironmentId;
    use rust_cli_kernel_api::mcp::{
        McpConnect, McpTransport, McpTransportConfig, McpTransportEvent, NoMcpTransport,
    };

    let rig = rig(fake(&["plugins/list"], mcp_echo()), timing());
    let routed = HelperRoutedMcp::new(
        Arc::new(NoMcpTransport),
        rig.helper.clone(),
        rig.clock.clone(),
    );
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new("primary"),
        root: EnvPath::new("/w"),
    };
    let local = routed
        .connect(
            &workspace,
            McpConnect {
                server: "plain".to_owned(),
                transport: McpTransportConfig::stdio("node", Vec::new()),
            },
        )
        .await;
    assert!(
        matches!(
            local,
            Err(rust_cli_kernel_api::mcp::McpError::Unsupported { .. })
        ),
        "other servers reach the inner transport"
    );
    let id = routed
        .connect(
            &workspace,
            McpConnect {
                server: "plugin:viewer:view".to_owned(),
                transport: McpTransportConfig::NodeHelper,
            },
        )
        .await
        .expect("connected through the helper");
    assert_eq!(
        received(&rig.fake, "helper/mcp/connect")[0]["workspace"],
        json!({"workspacePath": "/w"})
    );
    let mut events = routed.events(&id);
    assert!(
        routed.events(&id).next().await.is_none(),
        "events are taken once"
    );
    routed
        .send(
            &id,
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        )
        .await
        .expect("sent");
    let event = tokio::time::timeout(Duration::from_secs(5), events.next())
        .await
        .expect("in time");
    assert_eq!(
        event,
        Some(McpTransportEvent::Message {
            message: json!({"jsonrpc": "2.0", "id": 1, "result": {"method": "tools/list"}}),
        })
    );
    routed.close(&id).await.expect("closed");
    assert!(matches!(
        events.next().await,
        Some(McpTransportEvent::Closed { .. })
    ));
    assert!(events.next().await.is_none());
}

/// The agent's session rows for the pipe-workspace tests: `a` lives in `/home/One`, `b` in `/home/Two` under the
/// identity `two`, `gone` has no row.
struct PipeRows;

#[async_trait]
impl HelperRequests for PipeRows {
    async fn authorize_app_tool(
        &self,
        _params: Value,
        _cancel: tokio_util::sync::CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    async fn sample_model(
        &self,
        _params: Value,
        _cancel: tokio_util::sync::CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    fn session_delta(&self, _session: &str, _delta: Value) {}

    async fn session_workspace(&self, session: &str) -> Option<Value> {
        match session {
            "a" => Some(json!({"workspacePath": "/home/One"})),
            "b" => Some(json!({"workspacePath": "/home/Two", "workspaceIdentity": "two"})),
            _ => None,
        }
    }
}

/// Pipes echo as [`mcp_echo`]; `helper/session/open` answers `{}`; every other request echoes its params.
fn pipes_with_sessions() -> Arc<Behaviour> {
    let pipes = mcp_echo();
    behaviour(move |launch, method, params| match method {
        "helper/session/open" => Act::Reply {
            notes: Vec::new(),
            result: json!({}),
        },
        "helper/mcp/connect" | "helper/mcp/send" | "helper/mcp/close" => {
            pipes(launch, method, params)
        }
        _ => Act::Reply {
            notes: Vec::new(),
            result: params.clone(),
        },
    })
}

/// A rig whose helper answers through [`PipeRows`], scripted by `behaviour` ([`pipes_with_sessions`] is the usual).
fn pipe_rig(behaviour: Arc<Behaviour>) -> Rig {
    static ROWS: std::sync::LazyLock<Arc<PipeRows>> =
        std::sync::LazyLock::new(|| Arc::new(PipeRows));
    let rig = rig(fake(&["plugins/list"], behaviour), timing());
    rig.helper.set_catalog(HelperCatalog {
        plugin_ids: vec!["a@inline".to_owned()],
        helper_plugins: vec!["a@inline".to_owned()],
        servers: vec!["plugin:a:s".to_owned()],
    });
    let rows: Weak<dyn HelperRequests> = Arc::downgrade(&*ROWS) as _;
    rig.helper.set_requests(rows);
    rig
}

/// One `tools/call` of `session`, as Rust's MCP client sends it through a pipe.
fn helper_tool_call(id: u64, session: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": "open_doc", "arguments": {},
        "_meta": {"zcode/helperContext": {"sessionId": session, "turnId": "run_1", "runtimeScope": "main"}}}})
}

/// F3, "The pipe workspace is enforced": a session's call travels a pipe connected in its own row's workspace — the
/// store-row resolution the session open uses, identity included — so two workspaces get distinct pipes on one
/// connection, and the sessionless traffic keeps the connection's own pipe (its manager group's workspace).
#[tokio::test]
async fn each_workspaces_calls_travel_a_pipe_connected_in_that_workspace() {
    use futures_util::StreamExt;
    use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
    use rust_cli_kernel_api::ids::EnvironmentId;
    use rust_cli_kernel_api::mcp::{McpConnect, McpTransport, McpTransportConfig, NoMcpTransport};

    let rig = pipe_rig(pipes_with_sessions());
    let routed = HelperRoutedMcp::new(
        Arc::new(NoMcpTransport),
        rig.helper.clone(),
        rig.clock.clone(),
    );
    let group = WorkspaceRef {
        environment: EnvironmentId::new("primary"),
        root: EnvPath::new("/w"),
    };
    let connection = routed
        .connect(
            &group,
            McpConnect {
                server: "plugin:a:s".to_owned(),
                transport: McpTransportConfig::NodeHelper,
            },
        )
        .await
        .expect("connected");
    let mut events = routed.events(&connection);
    let answered = |id: u64| {
        let expected = json!(id);
        move |message: &Value| {
            assert_eq!(message["id"], expected, "{message:?}");
            assert!(message.get("error").is_none(), "{message:?}");
        }
    };
    for (id, message) in [
        (
            1u64,
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        ),
        (2, helper_tool_call(2, "a")),
        (3, helper_tool_call(3, "b")),
    ] {
        routed.send(&connection, message).await.expect("sent");
        match tokio::time::timeout(Duration::from_secs(5), events.next()).await {
            Ok(Some(rust_cli_kernel_api::mcp::McpTransportEvent::Message { message })) => {
                answered(id)(&message)
            }
            other => panic!("no answer for {id}: {other:?}"),
        }
    }
    let connects = received(&rig.fake, "helper/mcp/connect");
    let workspaces: Vec<Value> = connects
        .iter()
        .map(|params| params["workspace"].clone())
        .collect();
    assert_eq!(
        workspaces,
        [
            json!({"workspacePath": "/w"}),
            json!({"workspacePath": "/home/One"}),
            json!({"workspacePath": "/home/Two", "workspaceIdentity": "two"}),
        ]
    );
    let mut ids: Vec<&str> = connects
        .iter()
        .filter_map(|params| params["connection"].as_str())
        .collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 3, "each workspace gets its own pipe");

    // Closing the connection closes every pipe it connected, its own and the workspaces'.
    routed.close(&connection).await.expect("closed");
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .expect("closed in time"),
        Some(rust_cli_kernel_api::mcp::McpTransportEvent::Closed { .. })
    ));
    tokio::time::timeout(Duration::from_secs(5), async {
        while received(&rig.fake, "helper/mcp/close").len() < 3 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the helper hears every close");
    let mut closed: Vec<String> = received(&rig.fake, "helper/mcp/close")
        .iter()
        .filter_map(|params| params["connection"].as_str().map(str::to_owned))
        .collect();
    closed.sort();
    let mut ids: Vec<String> = ids.into_iter().map(str::to_owned).collect();
    ids.sort();
    assert_eq!(closed, ids);
}

/// F3: a pipe refuses the call of a session of another workspace; the call never reaches the helper.
#[tokio::test]
async fn a_pipe_refuses_the_call_of_a_session_of_another_workspace() {
    let rig = pipe_rig(pipes_with_sessions());
    let mut connection = rig
        .helper
        .mcp_connect(&json!({"workspacePath": "/w"}), "plugin:a:s")
        .await
        .expect("connected");
    rig.helper
        .mcp_send(&connection.id, helper_tool_call(5, "a"))
        .await
        .expect("sent");
    match next_event(&mut connection).await {
        rust_cli_kernel_api::mcp::McpTransportEvent::Message { message } => {
            assert_eq!(message["id"], json!(5));
            assert_eq!(message["error"]["code"], json!(-32603));
            assert_eq!(
                message["error"]["message"],
                json!("the session is in another workspace than the MCP connection")
            );
        }
        other => panic!("unexpected event: {other:?}"),
    }
    assert!(
        received(&rig.fake, "helper/mcp/send").is_empty(),
        "the call never reaches the helper"
    );
}

/// F3: a session whose workspace cannot be resolved gets no pipe — its call is refused fail-closed, as its session
/// open is, and nothing of it reaches the helper.
#[tokio::test]
async fn a_call_of_a_session_whose_workspace_is_unknown_is_refused() {
    let rig = pipe_rig(pipes_with_sessions());
    let mut connection = rig
        .helper
        .mcp_connect(&json!({"workspacePath": "/w"}), "plugin:a:s")
        .await
        .expect("connected");
    rig.helper
        .mcp_send(&connection.id, helper_tool_call(6, "gone"))
        .await
        .expect("sent");
    match next_event(&mut connection).await {
        rust_cli_kernel_api::mcp::McpTransportEvent::Message { message } => {
            assert_eq!(message["id"], json!(6));
            assert!(
                message["error"]["message"].as_str().is_some_and(
                    |message| message.starts_with("the session's workspace is unknown")
                ),
                "{}",
                message
            );
        }
        other => panic!("unexpected event: {other:?}"),
    }
    assert!(
        received(&rig.fake, "helper/mcp/send").is_empty()
            && received(&rig.fake, "helper/session/open").is_empty(),
        "neither the call nor an open reaches the helper"
    );
}

/// F3: a workspace pipe closing answers only its own in-flight calls on the connection — the connection lives on, a
/// cancel of the call follows its pipe, and the next call of that workspace reconnects the pipe.
#[tokio::test]
async fn a_closed_workspace_pipe_answers_its_calls_and_the_connection_lives_on() {
    use futures_util::StreamExt;
    use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
    use rust_cli_kernel_api::ids::EnvironmentId;
    use rust_cli_kernel_api::mcp::{
        McpConnect, McpTransport, McpTransportConfig, McpTransportEvent, NoMcpTransport,
    };

    // The call of id 2 never answers; everything else answers as [`pipes_with_sessions`] does.
    let sessions = pipes_with_sessions();
    let hanging = behaviour(move |_, method, params| {
        if method == "helper/mcp/send" && params["message"]["id"] == json!(2) {
            return Act::Hang;
        }
        sessions(0, method, params)
    });
    let rig = pipe_rig(hanging);

    let routed = HelperRoutedMcp::new(
        Arc::new(NoMcpTransport),
        rig.helper.clone(),
        rig.clock.clone(),
    );
    let group = WorkspaceRef {
        environment: EnvironmentId::new("primary"),
        root: EnvPath::new("/w"),
    };
    let connection = routed
        .connect(
            &group,
            McpConnect {
                server: "plugin:a:s".to_owned(),
                transport: McpTransportConfig::NodeHelper,
            },
        )
        .await
        .expect("connected");
    let mut events = routed.events(&connection);
    routed
        .send(&connection, helper_tool_call(2, "a"))
        .await
        .expect("sent");
    tokio::time::timeout(Duration::from_secs(5), async {
        while received(&rig.fake, "helper/mcp/send").is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the call is out");
    // The call and its cancel travel the workspace's pipe, not the connection's own.
    routed
        .send(
            &connection,
            json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
                "params": {"requestId": 2, "reason": "User interrupted"}}),
        )
        .await
        .expect("sent");
    tokio::time::timeout(Duration::from_secs(5), async {
        while received(&rig.fake, "helper/mcp/send").len() < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the cancel is out");
    let satellite = received(&rig.fake, "helper/mcp/connect")
        .iter()
        .find(|params| params["workspace"] == json!({"workspacePath": "/home/One"}))
        .and_then(|params| params["connection"].as_str())
        .expect("the workspace's pipe")
        .to_owned();
    let on_satellite = |message: &Value| {
        received(&rig.fake, "helper/mcp/send")
            .iter()
            .any(|params| params["connection"] == json!(satellite) && params["message"] == *message)
    };
    assert!(on_satellite(&helper_tool_call(2, "a")));
    assert!(
        on_satellite(
            &json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
            "params": {"requestId": 2, "reason": "User interrupted"}})
        ),
        "the cancel follows its call's pipe"
    );

    // The helper closes the workspace's pipe: the in-flight call is answered on the connection, which stays open.
    rig.helper
        .mcp_send(&satellite, json!({"jsonrpc": "2.0", "method": "die"}))
        .await
        .expect("sent");
    match tokio::time::timeout(Duration::from_secs(5), events.next()).await {
        Ok(Some(McpTransportEvent::Message { message })) => {
            assert_eq!(message["id"], json!(2));
            assert!(
                message["error"]["message"]
                    .as_str()
                    .is_some_and(|message| message.starts_with("connection closed: gone")),
                "{}",
                message
            );
        }
        other => panic!("no synthesized answer: {other:?}"),
    }
    routed
        .send(
            &connection,
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}),
        )
        .await
        .expect("the connection still sends");
    match tokio::time::timeout(Duration::from_secs(5), events.next()).await {
        Ok(Some(McpTransportEvent::Message { message })) => assert_eq!(message["id"], json!(3)),
        other => panic!("no answer through the own pipe: {other:?}"),
    }

    // The next call of that workspace reconnects its pipe.
    routed
        .send(&connection, helper_tool_call(4, "a"))
        .await
        .expect("sent");
    match tokio::time::timeout(Duration::from_secs(5), events.next()).await {
        Ok(Some(McpTransportEvent::Message { message })) => {
            assert_eq!(message["id"], json!(4));
            assert!(message.get("error").is_none(), "{message:?}");
        }
        other => panic!("no answer after the reconnect: {other:?}"),
    }
    assert_eq!(
        received(&rig.fake, "helper/mcp/connect")
            .iter()
            .filter(|params| params["workspace"] == json!({"workspacePath": "/home/One"}))
            .count(),
        2,
        "the workspace's pipe reconnected"
    );
}

/// The workspace of the first tool call, as the routed transport's pipe decision names it.
fn one_workspace() -> Value {
    json!({"workspacePath": "/home/One"})
}

/// F3: the first `tools/call` of a workspace key does not hold its cancel behind the key's connect. The connect runs as
/// its own task and the call parks in the key's mailbox, so `send` returns while the connect is still in flight (Rust's
/// MCP client awaits `send` before it watches a call's cancel); its cancel parks behind it, and both leave the
/// workspace's pipe in order once the connect resolves.
#[tokio::test(start_paused = true)]
async fn a_workspaces_first_call_parks_instead_of_holding_its_cancel() {
    use futures_util::StreamExt;
    use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
    use rust_cli_kernel_api::ids::EnvironmentId;
    use rust_cli_kernel_api::mcp::{McpConnect, McpTransport, McpTransportConfig, NoMcpTransport};

    // The workspace pipe's connect takes 2 s; everything else answers at once.
    let sessions = pipes_with_sessions();
    let gated = behaviour(move |_, method, params| {
        if method == "helper/mcp/connect" && params["workspace"] == one_workspace() {
            return Act::Delay {
                after: Duration::from_secs(2),
                result: json!({}),
            };
        }
        sessions(0, method, params)
    });
    let rig = pipe_rig(gated);
    let routed = HelperRoutedMcp::new(
        Arc::new(NoMcpTransport),
        rig.helper.clone(),
        rig.clock.clone(),
    );
    let group = WorkspaceRef {
        environment: EnvironmentId::new("primary"),
        root: EnvPath::new("/w"),
    };
    let connection = routed
        .connect(
            &group,
            McpConnect {
                server: "plugin:a:s".to_owned(),
                transport: McpTransportConfig::NodeHelper,
            },
        )
        .await
        .expect("connected");
    let mut events = routed.events(&connection);
    let cancel = json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
        "params": {"requestId": 2, "reason": "User interrupted"}});
    let started = tokio::time::Instant::now();
    routed
        .send(&connection, helper_tool_call(2, "a"))
        .await
        .expect("the call is parked");
    routed
        .send(&connection, cancel.clone())
        .await
        .expect("the cancel is not held behind the connect");
    // The connect task starts with the spawn (the sends returned without running it): let the runtime run it
    // until its request is out, then hold there — paused time stays under the connect's 2 s, so it cannot have
    // resolved, nothing of the call reached the helper, and neither send spent its connect's time.
    tokio::time::timeout(Duration::from_secs(5), async {
        while received(&rig.fake, "helper/mcp/connect")
            .iter()
            .filter(|params| params["workspace"] == one_workspace())
            .count()
            < 1
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the workspace's connect is in flight");
    assert_eq!(
        received(&rig.fake, "helper/mcp/connect")
            .iter()
            .filter(|params| params["workspace"] == one_workspace())
            .count(),
        1,
        "one connect, still in flight"
    );
    assert!(
        received(&rig.fake, "helper/mcp/send").is_empty(),
        "the call and its cancel wait in the key's mailbox"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "neither send awaited the connect"
    );

    tokio::time::sleep(Duration::from_secs(3)).await;
    let satellite = received(&rig.fake, "helper/mcp/connect")
        .iter()
        .find(|params| params["workspace"] == one_workspace())
        .and_then(|params| params["connection"].as_str())
        .expect("the workspace's pipe")
        .to_owned();
    let on_satellite: Vec<Value> = received(&rig.fake, "helper/mcp/send")
        .into_iter()
        .filter(|params| params["connection"] == json!(satellite))
        .map(|params| params["message"].clone())
        .collect();
    assert_eq!(
        on_satellite,
        [helper_tool_call(2, "a"), cancel],
        "the call leaves first, its cancel follows it on the same pipe"
    );
    match tokio::time::timeout(Duration::from_secs(5), events.next()).await {
        Ok(Some(rust_cli_kernel_api::mcp::McpTransportEvent::Message { message })) => {
            assert_eq!(message["id"], json!(2));
            assert!(message.get("error").is_none(), "{message:?}");
        }
        other => panic!("no answer for the parked call: {other:?}"),
    }
}

/// F3: a workspace key whose connect fails answers its parked calls on the connection with the failure, and the 30 s
/// cooldown refuses a later call of that key at once — no message of it reaches the helper, and no second connect runs.
#[tokio::test(start_paused = true)]
async fn a_failed_workspace_connect_answers_its_parked_calls_and_cools_down() {
    use futures_util::StreamExt;
    use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
    use rust_cli_kernel_api::ids::EnvironmentId;
    use rust_cli_kernel_api::mcp::{McpConnect, McpTransport, McpTransportConfig, NoMcpTransport};

    let sessions = pipes_with_sessions();
    let failing = behaviour(move |_, method, params| {
        if method == "helper/mcp/connect" && params["workspace"] == one_workspace() {
            return Act::Fail(RpcError::internal("MCP server failed to start"));
        }
        sessions(0, method, params)
    });
    let rig = pipe_rig(failing);
    let routed = HelperRoutedMcp::new(
        Arc::new(NoMcpTransport),
        rig.helper.clone(),
        rig.clock.clone(),
    );
    let group = WorkspaceRef {
        environment: EnvironmentId::new("primary"),
        root: EnvPath::new("/w"),
    };
    let connection = routed
        .connect(
            &group,
            McpConnect {
                server: "plugin:a:s".to_owned(),
                transport: McpTransportConfig::NodeHelper,
            },
        )
        .await
        .expect("connected");
    let mut events = routed.events(&connection);
    routed
        .send(&connection, helper_tool_call(7, "a"))
        .await
        .expect("parked");
    routed
        .send(
            &connection,
            json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
                "params": {"requestId": 7, "reason": "User interrupted"}}),
        )
        .await
        .expect("parked behind its call");
    match tokio::time::timeout(Duration::from_secs(5), events.next()).await {
        Ok(Some(rust_cli_kernel_api::mcp::McpTransportEvent::Message { message })) => {
            assert_eq!(message["id"], json!(7));
            assert_eq!(message["error"]["code"], json!(-32603));
            assert_eq!(
                message["error"]["message"],
                json!("MCP server failed to start")
            );
        }
        other => panic!("no answer for the parked call: {other:?}"),
    }
    assert!(
        !received(&rig.fake, "helper/mcp/send")
            .iter()
            .any(|params| params["message"] == helper_tool_call(7, "a")),
        "the call never reaches the helper"
    );

    // The cooldown (the rig's clock never moves) refuses the next call of that key at once.
    routed
        .send(&connection, helper_tool_call(8, "a"))
        .await
        .expect("sent");
    match tokio::time::timeout(Duration::from_secs(5), events.next()).await {
        Ok(Some(rust_cli_kernel_api::mcp::McpTransportEvent::Message { message })) => {
            assert_eq!(message["id"], json!(8));
            assert_eq!(
                message["error"]["message"],
                json!("connection closed: MCP server failed to start")
            );
        }
        other => panic!("no fail-fast answer: {other:?}"),
    }
    assert_eq!(
        received(&rig.fake, "helper/mcp/connect")
            .iter()
            .filter(|params| params["workspace"] == one_workspace())
            .count(),
        1,
        "no second connect inside the cooldown"
    );
}

/// F3: the session → workspace cache is bounded — a desktop-continuous agent serves sessions without end, so an
/// insert-only map would grow for the process's life. At the cap the oldest entry is evicted and only re-resolved
/// (a row never changes workspace, so an eviction is never wrong).
#[tokio::test]
async fn the_session_workspace_cache_evicts_its_oldest_at_the_cap() {
    /// Resolves `s<n>` to `/w/<n>`, counting each resolution.
    struct CountingRows(Arc<AtomicUsize>);
    #[async_trait]
    impl HelperRequests for CountingRows {
        async fn authorize_app_tool(
            &self,
            _params: Value,
            _cancel: tokio_util::sync::CancellationToken,
        ) -> Result<Value, RpcError> {
            Err(RpcError::internal("not used"))
        }

        async fn sample_model(
            &self,
            _params: Value,
            _cancel: tokio_util::sync::CancellationToken,
        ) -> Result<Value, RpcError> {
            Err(RpcError::internal("not used"))
        }

        fn session_delta(&self, _session: &str, _delta: Value) {}

        async fn session_workspace(&self, session: &str) -> Option<Value> {
            self.0.fetch_add(1, Ordering::SeqCst);
            let n = session.strip_prefix("s")?.parse::<u64>().ok()?;
            Some(json!({"workspacePath": format!("/w/{n}")}))
        }
    }

    let rig = rig(fake(&["plugins/list"], echo()), timing());
    let rows = Arc::new(CountingRows(Arc::new(AtomicUsize::new(0))));
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&rows) as _;
    rig.helper.set_requests(weak);
    let resolutions = || rows.0.load(Ordering::SeqCst);
    let session = |n: u64| format!("s{n}");
    for n in 0..mcp::REMEMBERED_WORKSPACES as u64 {
        let (_, key) = rig
            .helper
            .pipe_workspace(&session(n))
            .await
            .expect("resolved");
        assert_eq!(key, format!("/w/{n}"));
    }
    assert_eq!(resolutions(), mcp::REMEMBERED_WORKSPACES);
    // Inside the cap, a resolved session is served from the cache.
    rig.helper
        .pipe_workspace(&session(0))
        .await
        .expect("cached");
    assert_eq!(resolutions(), mcp::REMEMBERED_WORKSPACES);
    // One session beyond the cap evicts the oldest...
    rig.helper
        .pipe_workspace(&session(mcp::REMEMBERED_WORKSPACES as u64))
        .await
        .expect("resolved");
    assert_eq!(resolutions(), mcp::REMEMBERED_WORKSPACES + 1);
    // ...so it resolves again — and its re-insert at the cap evicts the next-oldest (s1), whose re-insert evicts
    // its next-oldest in turn (s2), while a younger entry (s3) is still cached.
    let (_, key) = rig
        .helper
        .pipe_workspace(&session(0))
        .await
        .expect("re-resolved");
    assert_eq!(key, "/w/0");
    assert_eq!(resolutions(), mcp::REMEMBERED_WORKSPACES + 2);
    rig.helper
        .pipe_workspace(&session(1))
        .await
        .expect("the next-oldest, re-resolved in turn");
    assert_eq!(resolutions(), mcp::REMEMBERED_WORKSPACES + 3);
    rig.helper
        .pipe_workspace(&session(2))
        .await
        .expect("evicted by s1's re-insert, re-resolved in turn");
    assert_eq!(resolutions(), mcp::REMEMBERED_WORKSPACES + 4);
    rig.helper
        .pipe_workspace(&session(4))
        .await
        .expect("cached");
    assert_eq!(resolutions(), mcp::REMEMBERED_WORKSPACES + 4);
}

#[test]
fn each_forwarded_method_uses_the_hosts_timeout_for_it() {
    let timing = Timing::default();
    let secs = |method: &str| timing.timeout_for(method).as_secs();
    assert_eq!(secs("plugins/list"), 300);
    assert_eq!(secs("plugins/mentionItems"), 300);
    assert_eq!(secs("workflows/save"), 300);
    assert_eq!(secs("mcp/uiSampling"), 65);
    assert_eq!(secs("mcp/uiCallTool"), 180);
    assert_eq!(secs("mcp/readResource"), 180);
    assert_eq!(secs("v4/conversation/workflowRuns"), 180);
    assert_eq!(secs(mcp::CONNECT), 180);
    assert_eq!(timing.ping.as_secs(), 5);
}

#[tokio::test(start_paused = true)]
async fn a_timed_out_call_keeps_a_process_that_answers_ping_and_its_pipes() {
    let pipes = mcp_echo();
    let behaviour = behaviour(move |launch, method, params| match method {
        "plugins/install" => Act::Hang,
        "helper/ping" => Act::Reply {
            notes: Vec::new(),
            result: json!({}),
        },
        _ => pipes(launch, method, params),
    });
    let rig = rig(fake(&["plugins/install"], behaviour), timing());
    let mut connection = rig
        .helper
        .mcp_connect(&workspace_params(), "plugin:a:s")
        .await
        .expect("connected");
    // The only call in flight, and nothing is heard from the process until it times out.
    expect_unavailable(&forward_err(&rig.helper, "plugins/install", json!({})).await);
    assert_eq!(received(&rig.fake, "helper/ping").len(), 1);
    assert_eq!(
        rig.fake.stopped.load(Ordering::SeqCst),
        0,
        "a process that answers ping is kept"
    );
    rig.helper
        .mcp_send(
            &connection.id,
            json!({"jsonrpc": "2.0", "id": 7, "method": "tools/list"}),
        )
        .await
        .expect("the pipe is open");
    match next_event(&mut connection).await {
        rust_cli_kernel_api::mcp::McpTransportEvent::Message { message } => {
            assert_eq!(message["id"], json!(7));
        }
        other => panic!("unexpected event: {other:?}"),
    }
    assert_eq!(rig.fake.launches.load(Ordering::SeqCst), 1);
    assert_eq!(rig.helper.crash_count(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_timed_out_call_drops_a_process_that_misses_the_ping_deadline() {
    let behaviour = behaviour(|_, method, _| match method {
        "helper/ping" => Act::Delay {
            after: Duration::from_secs(2),
            result: json!({}),
        },
        _ => Act::Hang,
    });
    let rig = rig(fake(&["plugins/install"], behaviour), timing());
    expect_unavailable(&forward_err(&rig.helper, "plugins/install", json!({})).await);
    assert_eq!(received(&rig.fake, "helper/ping").len(), 1);
    assert_eq!(rig.fake.stopped.load(Ordering::SeqCst), 1);
    assert_eq!(rig.helper.crash_count(), 0);
}

#[path = "node_helper_sessions_tests.rs"]
mod sessions;

#[path = "node_helper_requests_tests.rs"]
mod requests;

#[path = "node_helper_panels_tests.rs"]
mod panels;

/// A connect Rust gives up on (refused, timed out, or dropped by its caller) is closed in the helper and leaves no
/// pipe behind: otherwise a late connect keeps a lease and an MCP child, and the helper is never idle.
#[tokio::test(start_paused = true)]
async fn a_connect_rust_gives_up_on_is_closed_in_the_helper() {
    let behaviour = behaviour(|_, method, params| match method {
        "helper/mcp/connect" if params["server"] == "plugin:a:refused" => {
            Act::Fail(RpcError::internal("MCP server failed to start"))
        }
        "helper/mcp/connect" => Act::Hang,
        _ => Act::Notify(Vec::new()),
    });
    let rig = rig(fake(&["plugins/list"], behaviour), timing());
    rig.helper
        .mcp_connect(&workspace_params(), "plugin:a:refused")
        .await
        .expect_err("refused");
    rig.helper
        .mcp_connect(&workspace_params(), "plugin:a:slow")
        .await
        .expect_err("timed out");
    let dropped = tokio::time::timeout(
        Duration::from_secs(1),
        rig.helper.mcp_connect(&workspace_params(), "plugin:a:slow"),
    )
    .await;
    assert!(dropped.is_err(), "the caller gave up");
    tokio::time::sleep(Duration::from_millis(10)).await;
    let connections = |method: &str| -> Vec<Value> {
        received(&rig.fake, method)
            .into_iter()
            .map(|params| params["connection"].clone())
            .collect()
    };
    assert_eq!(connections("helper/mcp/connect").len(), 3);
    assert_eq!(
        connections("helper/mcp/close"),
        connections("helper/mcp/connect")
    );
    tokio::time::sleep(Duration::from_secs(301)).await;
    assert_eq!(
        rig.fake.stopped.load(Ordering::SeqCst),
        1,
        "no pipe keeps the helper"
    );
}
