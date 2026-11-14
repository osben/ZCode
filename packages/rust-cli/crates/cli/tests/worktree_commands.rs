//! Fork: the prepared execution worktree commands through a real `zcode-rs app-server --stdio` process
//! (specs/fork-rust-agent-parity.md "Execution worktree"): `createSession` with `worktreePreparation`, then
//! `updateWorktreePreparation` failed and cancelled as `v4/command` requests. Before the inbound schema knew the
//! update, every one was refused as `unknown command type`.
#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    reason = "integration test: temporary directories, a real process, its standard output"
)]

mod system_env;
use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;
use system_env::KeepSystem as _;

use rust_cli_base::models::GLM_5_3;
use serde_json::{Value, json};

/// How long to wait for one reply (normally well under a second).
const REPLY_WAIT: Duration = Duration::from_secs(60);

#[test]
fn prepared_worktree_updates_pass_the_real_command_path() {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let (home, work) = (base.join("home"), base.join("work"));
    std::fs::create_dir_all(work.join(".git")).unwrap();
    std::fs::create_dir_all(home.join(".zcode/cli")).unwrap();
    let mut child = rust_cli_proc::std_command(env!("CARGO_BIN_EXE_zcode-rs"))
        .args(["app-server", "--stdio"])
        .current_dir(&work)
        .env_clear()
        .keep_system()
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("PATH", "/usr/bin:/bin")
        .env("ZCODE_DATA_BASE_DIR", &home)
        // No model request is made; a configured model keeps session creation from waiting for a default.
        .env("ZCODE_MODEL_BASE_URL", "http://127.0.0.1:9")
        .env("ZCODE_API_KEY", "test-key")
        .env("ZCODE_MODEL", GLM_5_3)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (lines, frames) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if lines.send(line).is_err() {
                break;
            }
        }
    });
    let mut next = 0;
    let mut command = |envelope: Value| -> Value {
        next += 1;
        let request =
            json!({"jsonrpc": "2.0", "id": next, "method": "v4/command", "params": envelope});
        writeln!(stdin, "{request}").unwrap();
        stdin.flush().unwrap();
        loop {
            let line = frames.recv_timeout(REPLY_WAIT).unwrap();
            let frame: Value = serde_json::from_str(&line).unwrap();
            if frame["id"] == next && frame.get("method").is_none() {
                assert!(frame.get("error").is_none(), "{frame}");
                return frame["result"].clone();
            }
        }
    };

    let workspace = work.to_str().unwrap();
    let target = base.join("work-worktrees/zcode-a");
    let ack = command(json!({
        "commandId": "c-prepare", "clientId": "k", "sessionId": null, "type": "createSession", "issuedAt": 1,
        "payload": {"workspaceId": workspace, "worktreePreparation": {
            "branchName": "zcode/a", "targetPath": target, "attemptId": "a1"}},
    }));
    assert_eq!(ack["status"], "accepted", "{ack}");
    let session = ack["result"]["sessionId"].as_str().unwrap().to_owned();
    let update = |id: &str, payload: Value| {
        json!({"commandId": id, "clientId": "k", "sessionId": session,
            "type": "updateWorktreePreparation", "issuedAt": 1, "payload": payload})
    };

    let ack = command(update(
        "c-failed",
        json!({"status": "failed", "failureMessage": "git worktree add failed", "expectedAttemptId": "a1"}),
    ));
    assert_eq!(ack["status"], "accepted", "{ack}");
    assert_eq!(ack["result"]["status"], "failed");

    let ack = command(update(
        "c-cancelled",
        json!({"status": "cancelled", "expectedAttemptId": "a1"}),
    ));
    assert_eq!(ack["status"], "accepted", "{ack}");
    assert_eq!(ack["result"]["status"], "cancelled");

    // Cancelled is final for this attempt: a further update without a new attempt is refused.
    let ack = command(update(
        "c-late",
        json!({"status": "failed", "expectedAttemptId": "a1"}),
    ));
    assert_eq!(ack["status"], "failed", "{ack}");

    drop(stdin);
    child.wait().unwrap();
}
