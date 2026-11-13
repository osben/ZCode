//! Fork: ACP external agent turns through a real `zcode-rs app-server --stdio` process
//! (specs/fork-rust-agent-parity.md "ACP external agents"). The agent is the `acp-mock-agent` test double of the
//! `rust-cli-acp` crate, configured in `fork_acp_agents.json` like the Host writes it.
#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "integration test: temporary directories, a real process, its standard output"
)]

mod system_env;
use std::io::{BufRead, BufReader, Read as _, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};
use system_env::KeepSystem as _;

use rust_cli_base::models::GLM_5_3;
use serde_json::{Value, json};

/// How long to wait for one reply or one awaited frame (normally well under a second).
const WAIT: Duration = Duration::from_secs(60);

/// The mock agent binary. `cargo test --workspace` builds it with the `rust-cli-acp` tests; a narrower run builds it
/// here.
fn mock_agent() -> PathBuf {
    let server = Path::new(env!("CARGO_BIN_EXE_zcode-rs"));
    let name = format!("acp-mock-agent{}", std::env::consts::EXE_SUFFIX);
    let path = server.with_file_name(&name);
    if !path.exists() {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
        let status = std::process::Command::new(cargo)
            .args(["build", "-p", "rust-cli-acp", "--bin", "acp-mock-agent"])
            .status()
            .unwrap();
        assert!(status.success(), "building acp-mock-agent failed");
    }
    assert!(path.exists(), "{} is missing", path.display());
    path
}

/// A model endpoint that only counts connections (each answered 500): an ACP turn must not reach it.
struct ModelStub {
    url: String,
    requests: Arc<AtomicUsize>,
}

impl ModelStub {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let counted = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                counted.fetch_add(1, Ordering::SeqCst);
                let mut buffer = [0u8; 4096];
                let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                let _ = stream.read(&mut buffer);
                let _ = stream.write_all(
                    b"HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                );
            }
        });
        Self { url, requests }
    }

    fn requests(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}

struct Server {
    child: Child,
    stdin: ChildStdin,
    frames: mpsc::Receiver<Value>,
    next: u64,
    /// Every frame seen, for the failure message.
    seen: Vec<String>,
}

impl Server {
    fn start(home: &Path, work: &Path, model: &ModelStub) -> Self {
        let mut child = rust_cli_proc::std_command(env!("CARGO_BIN_EXE_zcode-rs"))
            .args(["app-server", "--stdio"])
            .current_dir(work)
            .env_clear()
            .keep_system()
            .env("HOME", home)
            .env("USERPROFILE", home)
            .env("PATH", "/usr/bin:/bin")
            .env("ZCODE_DATA_BASE_DIR", home)
            // The ACP turn never asks the model; a configured model keeps session creation from waiting.
            .env("ZCODE_MODEL_BASE_URL", &model.url)
            .env("ZCODE_API_KEY", "test-key")
            .env("ZCODE_MODEL", GLM_5_3)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, frames) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if sender.send(frame).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin,
            frames,
            next: 0,
            seen: Vec::new(),
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = self.next;
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(self.stdin, "{request}").unwrap();
        self.stdin.flush().unwrap();
        let reply = self.wait_for(|frame| frame["id"] == id && frame.get("method").is_none());
        assert!(reply.get("error").is_none(), "{reply}");
        reply["result"].clone()
    }

    fn command(&mut self, envelope: Value) -> Value {
        self.request("v4/command", envelope)
    }

    /// The first frame (from now on) that `matches`.
    fn wait_for(&mut self, matches: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let Ok(frame) = self.frames.recv_timeout(left) else {
                panic!("no matching frame; seen:\n{}", self.seen.join("\n"));
            };
            self.seen.push(frame.to_string());
            if matches(&frame) {
                return frame;
            }
        }
    }

    fn stop(mut self) {
        drop(self.stdin);
        self.child.wait().unwrap();
    }
}

fn contains(frame: &Value, needle: &str) -> bool {
    frame.to_string().contains(needle)
}

/// A conversation frame that ends the turn: the control phase is terminal.
fn turn_finished(frame: &Value) -> bool {
    frame["method"] == "v4/conversation/frame"
        && ["completedSuccess", "completedInterrupted", "error"]
            .iter()
            .any(|phase| contains(frame, &format!("\"phase\":\"{phase}\"")))
}

fn write_agents(home: &Path, command: &Path, enabled: bool, args: &[&str]) {
    let dir = home.join(".zcode/v2");
    std::fs::create_dir_all(&dir).unwrap();
    let file = json!({"schemaVersion": 1, "agents": [{
        "agentId": "mock", "providerName": "Mock Agent", "enabled": enabled,
        "command": command, "args": args,
    }]});
    std::fs::write(dir.join("fork_acp_agents.json"), file.to_string()).unwrap();
}

fn send_text(session: &str, command: &str, text: &str) -> Value {
    json!({
        "commandId": command, "clientId": "k", "sessionId": session, "type": "sendText", "issuedAt": 1,
        "payload": {"text": text, "modelSelection": {"providerId": "acp:mock", "modelId": "mock"}},
    })
}

fn open_session(server: &mut Server, work: &Path) -> String {
    let ack = server.command(json!({
        "commandId": "c-create", "clientId": "k", "sessionId": null, "type": "createSession", "issuedAt": 1,
        "payload": {"workspaceId": work.to_str().unwrap()},
    }));
    assert_eq!(ack["status"], "accepted", "{ack}");
    let session = ack["result"]["sessionId"].as_str().unwrap().to_owned();
    server.request(
        "v4/conversation/subscribe",
        json!({"topic": format!("conversation/{session}"), "connectionId": "k", "clientMode": "desktop-continuous"}),
    );
    session
}

/// Whether a process with this id still exists (signal 0 only checks).
fn alive(pid: &str) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", pid])
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Waits until the process is gone; false when it is still there after the deadline.
fn ends(pid: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Runs one "hello" turn to completion and answers the agent's process id.
fn run_turn(server: &mut Server, session: &str, pid_file: &Path) -> String {
    let ack = server.command(send_text(session, "c-hello", "hello"));
    assert_eq!(ack["status"], "accepted", "{ack}");
    let finished = server.wait_for(turn_finished);
    assert!(
        contains(&finished, "\"phase\":\"completedSuccess\""),
        "{finished}"
    );
    let pid = std::fs::read_to_string(pid_file).unwrap();
    assert!(alive(&pid), "the agent should stay resident after the turn");
    pid
}

fn dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let (home, work) = (base.join("home"), base.join("work"));
    std::fs::create_dir_all(&work).unwrap();
    std::fs::create_dir_all(home.join(".zcode/cli")).unwrap();
    (dir, home, work)
}

#[test]
fn an_acp_selection_runs_the_turn_on_the_agent() {
    let (_dir, home, work) = dirs();
    write_agents(&home, &mock_agent(), true, &[]);
    let model = ModelStub::start();
    let mut server = Server::start(&home, &work, &model);
    let session = open_session(&mut server, &work);

    let ack = server.command(send_text(&session, "c-hello", "hello"));
    assert_eq!(ack["status"], "accepted", "{ack}");
    let finished = server.wait_for(turn_finished);
    assert!(
        contains(&finished, "\"phase\":\"completedSuccess\""),
        "{finished}"
    );
    assert!(
        server
            .seen
            .iter()
            .any(|frame| frame.contains("\"append\":\"pong\""))
    );
    // Side work after the turn (a title, compaction, memory) would ask the model with the ACP selection.
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(model.requests(), 0, "an ACP turn must not reach the model");
    server.stop();
}

/// The agent process lives as long as the kernel session: `session/close` only detaches the bridge in zcode-rs (the
/// actor stays), so the process is released when the session itself closes, here by its deletion.
#[test]
fn deleting_the_session_stops_the_agent_process() {
    let (dir, home, work) = dirs();
    let pid_file = dir.path().join("agent.pid");
    write_agents(
        &home,
        &mock_agent(),
        true,
        &["--pid-file", pid_file.to_str().unwrap()],
    );
    let model = ModelStub::start();
    let mut server = Server::start(&home, &work, &model);
    let session = open_session(&mut server, &work);
    let pid = run_turn(&mut server, &session, &pid_file);

    let ack = server.command(json!({
        "commandId": "c-delete", "clientId": "k", "sessionId": session, "type": "deleteSession",
        "issuedAt": 1, "payload": {},
    }));
    assert_eq!(ack["status"], "accepted", "{ack}");
    assert!(ends(&pid), "the agent process outlived its session");
    server.stop();
}

#[test]
fn the_agent_process_ends_with_the_app_server() {
    let (dir, home, work) = dirs();
    let pid_file = dir.path().join("agent.pid");
    write_agents(
        &home,
        &mock_agent(),
        true,
        &["--pid-file", pid_file.to_str().unwrap()],
    );
    let model = ModelStub::start();
    let mut server = Server::start(&home, &work, &model);
    let session = open_session(&mut server, &work);
    let pid = run_turn(&mut server, &session, &pid_file);

    server.stop();
    assert!(ends(&pid), "the agent process outlived the app-server");
}

#[test]
fn a_disabled_agent_fails_the_turn_with_the_node_text() {
    let (_dir, home, work) = dirs();
    write_agents(&home, &mock_agent(), false, &[]);
    let model = ModelStub::start();
    let mut server = Server::start(&home, &work, &model);
    let session = open_session(&mut server, &work);

    let ack = server.command(send_text(&session, "c-hello", "hello"));
    assert_eq!(ack["status"], "accepted", "{ack}");
    server.wait_for(|frame| {
        contains(
            frame,
            "mock is turned off. Enable it in Settings > Model Providers to continue.",
        )
    });
    server.stop();
}
