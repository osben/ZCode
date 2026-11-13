//! Tests of the Node helper client against a fake helper over `tokio::io::duplex`. The fake speaks the same line
//! framing; its behaviour per method is scripted by the test.

use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
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
    /// Never answers.
    Hang,
    /// Sends a request of its own, then answers the forwarded call with `{}`.
    AskHost,
}

type Behaviour = dyn Fn(usize, &str, &Value) -> Act + Send + Sync;

/// A fake launcher: each launch starts a fake helper whose behaviour sees the launch index.
struct Fake {
    advertised: Vec<String>,
    version: u64,
    fail_launch: bool,
    behaviour: Arc<Behaviour>,
    launches: Arc<AtomicUsize>,
    /// Incremented when a launched process's guard is dropped (the process tree is killed).
    stopped: Arc<AtomicUsize>,
    /// Responses the helper received for its own requests.
    answers: Arc<StdMutex<Vec<Value>>>,
}

struct Stop(Arc<AtomicUsize>);

impl Drop for Stop {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl NodeHelperLauncher for Fake {
    async fn launch(&self) -> io::Result<NodeHelperProcess> {
        let index = self.launches.fetch_add(1, Ordering::SeqCst);
        if self.fail_launch {
            return Err(io::Error::new(io::ErrorKind::NotFound, "no such file"));
        }
        let (to_helper, helper_in) = duplex(1 << 16);
        let (helper_out, from_helper) = duplex(1 << 16);
        let script = Script {
            index,
            advertised: self.advertised.clone(),
            version: self.version,
            behaviour: self.behaviour.clone(),
            answers: self.answers.clone(),
        };
        tokio::spawn(run_helper(script, helper_in, helper_out));
        Ok(NodeHelperProcess {
            stdin: Box::new(to_helper),
            stdout: Box::new(BufReader::new(from_helper)),
            guard: Box::new(Stop(self.stopped.clone())),
        })
    }
}

struct Script {
    index: usize,
    advertised: Vec<String>,
    version: u64,
    behaviour: Arc<Behaviour>,
    answers: Arc<StdMutex<Vec<Value>>>,
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
            let result = json!({"protocolVersion": script.version, "methods": script.advertised});
            write_line(&mut output, rpc::response(&id, &Ok(result))).await;
            continue;
        }
        match (script.behaviour)(script.index, method, &params) {
            Act::Reply { notes, result } => {
                for (note, note_params) in notes {
                    write_line(&mut output, rpc::notification(note, &note_params)).await;
                }
                write_line(&mut output, rpc::response(&id, &Ok(result))).await;
            }
            Act::Fail(error) => write_line(&mut output, rpc::response(&id, &Err(error))).await,
            Act::Crash => return,
            Act::Hang => std::future::pending::<()>().await,
            Act::AskHost => {
                write_line(
                    &mut output,
                    rpc::request(&json!("h-1"), "host/askSomething", &json!({})),
                )
                .await;
                write_line(&mut output, rpc::response(&id, &Ok(json!({})))).await;
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
        behaviour,
        launches: Arc::new(AtomicUsize::new(0)),
        stopped: Arc::new(AtomicUsize::new(0)),
        answers: Arc::new(StdMutex::new(Vec::new())),
    }
}

fn timing() -> Timing {
    Timing {
        request: Duration::from_secs(5),
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
    Rig {
        helper,
        fake,
        host: BufReader::new(host_in).lines(),
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
    assert_eq!(FORWARDED_METHODS.len(), 35);
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
    assert_eq!((plugins, workflows, runs), (20, 8, 7));
    // F3 and F4 methods and the sessionless catalog that Rust answers itself stay out.
    assert!(!FORWARDED_METHODS.contains(&"plugins/mentionItems"));
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
