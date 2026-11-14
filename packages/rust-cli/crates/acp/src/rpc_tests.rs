// The pump tests run a `sh -c` script as the agent.
#![cfg_attr(not(unix), allow(dead_code, unused_imports))]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_proc::ledger::{Containment, Isolation, Ledger, Purpose};
use serde_json::{Value, json};
use tokio::io::BufReader;
use tokio_util::sync::CancellationToken;

use super::{Answer, Inbound, Peer, Pump, PumpTimings, STDERR_LINE_BYTES, StderrLines, start};
use crate::error::{AcpError, AcpErrorCode};

#[tokio::test]
async fn a_stderr_line_is_capped_and_the_rest_of_it_dropped() {
    let mut input = b"first\n".to_vec();
    input.extend(std::iter::repeat_n(b'x', STDERR_LINE_BYTES * 8));
    input.extend_from_slice(b"\nlast");
    let mut lines = StderrLines::new(input.as_slice());
    assert_eq!(lines.next().await.as_deref(), Some("first"));
    let long = lines.next().await.expect("the long line");
    assert!(
        long.len() <= STDERR_LINE_BYTES + "… [truncated]".len(),
        "{}",
        long.len()
    );
    assert!(long.ends_with("… [truncated]"));
    assert_eq!(lines.next().await.as_deref(), Some("last"));
    assert_eq!(lines.next().await, None);
}

#[tokio::test]
async fn a_stderr_line_spanning_many_buffer_refills_is_capped_once() {
    // Production reads stderr through an 8 KiB `BufReader`; a 64-byte buffer makes every line span many refills.
    let mut input = std::iter::repeat_n(b'a', 20 * 1024).collect::<Vec<u8>>();
    input.push(b'\n');
    input.extend(std::iter::repeat_n(b'b', STDERR_LINE_BYTES));
    input.push(b'\n');
    input.extend_from_slice(b"short\n");
    let mut lines = StderrLines::new(BufReader::with_capacity(64, input.as_slice()));
    let long = lines.next().await.expect("the long line");
    assert_eq!(
        long,
        format!("{}… [truncated]", "a".repeat(STDERR_LINE_BYTES))
    );
    assert_eq!(
        lines.next().await,
        Some("b".repeat(STDERR_LINE_BYTES)),
        "a line of exactly the cap is kept whole"
    );
    assert_eq!(lines.next().await.as_deref(), Some("short"));
    assert_eq!(lines.next().await, None);
}

/// Records what the pump reports, in order.
#[derive(Default)]
struct Recorder {
    calls: Mutex<Vec<String>>,
}

impl Recorder {
    fn calls(&self) -> Vec<String> {
        self.calls.lock_unpoisoned().clone()
    }
}

impl Inbound for Recorder {
    fn activity(&self) {}
    fn notification(&self, _method: &str, _params: Value) {}
    fn request(&self, _method: &str, _params: Value) -> Option<Answer> {
        None
    }
    fn exited(&self, code: Option<i32>, _signal: Option<String>) {
        self.calls
            .lock_unpoisoned()
            .push(format!("exited:{code:?}"));
    }
    fn stream_failed(&self, error: AcpError) {
        self.calls
            .lock_unpoisoned()
            .push(format!("stream_failed:{}", error.message));
    }
}

/// Starts a pump over `sh -c script`; the script closes its stdin and says so on stderr before anything else.
#[cfg(unix)]
async fn pump_over(
    script: &str,
    death_grace: Duration,
) -> (
    Arc<Peer>,
    Arc<Recorder>,
    super::PumpHandle,
    Arc<Mutex<String>>,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().expect("tempdir");
    let ledger = Ledger::open(dir.path().join("ledger"));
    let mut command = rust_cli_proc::command("sh");
    command
        .args(["-c", script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut tracked = ledger
        .spawn(
            &mut command,
            Purpose::Acp,
            Isolation::Group,
            Containment::ProcessJob,
        )
        .await
        .expect("spawn sh");
    let child = tracked.child();
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        panic!("stdio pipes");
    };
    let (peer, inbox) = Peer::new();
    let recorder = Arc::new(Recorder::default());
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let handle = start(Pump {
        tracked,
        stdin,
        stdout,
        stderr,
        peer: peer.clone(),
        inbox,
        inbound: recorder.clone(),
        shutdown: CancellationToken::new(),
        timings: PumpTimings {
            death_grace,
            stop_grace: Duration::from_millis(200),
        },
        stderr_tail: stderr_tail.clone(),
    });
    (peer, recorder, handle, stderr_tail, dir)
}

/// Waits until the script reported on stderr that its stdin is closed, so the next write cannot land in the pipe.
#[cfg(unix)]
async fn wait_for_closed_stdin(tail: &Mutex<String>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !tail.lock_unpoisoned().contains("stdin closed") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the script closes its stdin");
}

#[cfg(unix)]
async fn wait_until_done(handle: &super::PumpHandle) {
    let mut done = handle.done.clone();
    tokio::time::timeout(Duration::from_secs(10), done.wait_for(|finished| *finished))
        .await
        .expect("the pump ends")
        .expect("pump state");
}

#[cfg(unix)]
#[tokio::test]
async fn a_write_after_the_agent_closed_its_stdin_fails_the_request_at_once() {
    let (peer, recorder, handle, tail, _dir) = pump_over(
        "exec 0<&-; echo 'stdin closed' >&2; sleep 30",
        Duration::from_secs(5),
    )
    .await;
    wait_for_closed_stdin(&tail).await;
    let error = tokio::time::timeout(
        Duration::from_secs(2),
        peer.request("session/prompt", json!({}), None),
    )
    .await
    .expect("the request fails before the death grace ends")
    .expect_err("stdin is closed");
    assert_eq!(error.code, AcpErrorCode::StreamClosed);
    assert_eq!(error.message, "ACP agent stdin closed");
    // The agent stays alive: after the death grace the stream fails with the stdin error.
    wait_until_done(&handle).await;
    assert_eq!(
        recorder.calls(),
        vec!["stream_failed:ACP agent stdin closed".to_owned()]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn an_agent_that_exits_after_closing_its_stdin_is_reported_as_exited() {
    let (peer, recorder, handle, tail, _dir) = pump_over(
        "exec 0<&-; echo 'stdin closed' >&2; sleep 0.3; exit 5",
        Duration::from_secs(5),
    )
    .await;
    wait_for_closed_stdin(&tail).await;
    let error = peer
        .request("session/prompt", json!({}), None)
        .await
        .expect_err("stdin is closed");
    assert_eq!(error.code, AcpErrorCode::StreamClosed);
    wait_until_done(&handle).await;
    // The exit inside the death grace keeps its code (Node: a closed stream is a death when the exit follows).
    assert_eq!(recorder.calls(), vec!["exited:Some(5)".to_owned()]);
}
