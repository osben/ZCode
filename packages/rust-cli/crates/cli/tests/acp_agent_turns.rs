//! Fork: ACP external agent turns through a real `zcode-rs app-server --stdio` process
//! (specs/fork-rust-agent-parity.md "ACP external agents"). The agent is the `acp-mock-agent` test double of the
//! `rust-cli-acp` crate, configured in `fork_acp_agents.json` like the Host writes it.
// Unix-only like the sibling process tests: liveness is read with `/bin/kill` and the server's PATH is unix.
#![cfg(unix)]
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

/// The mock agent binary of `rust-cli-acp`, built once per test process (a no-op when it is current), so a binary left
/// by an earlier build never runs with flags it does not know.
fn mock_agent() -> PathBuf {
    static BUILT: std::sync::Once = std::sync::Once::new();
    let server = Path::new(env!("CARGO_BIN_EXE_zcode-rs"));
    let name = format!("acp-mock-agent{}", std::env::consts::EXE_SUFFIX);
    let path = server.with_file_name(&name);
    BUILT.call_once(|| {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
        let status = std::process::Command::new(cargo)
            .args(["build", "-p", "rust-cli-acp", "--bin", "acp-mock-agent"])
            .args(profile_args(server.parent().unwrap()))
            .status()
            .unwrap();
        assert!(status.success(), "building acp-mock-agent failed");
    });
    assert!(path.exists(), "{} is missing", path.display());
    path
}

/// The cargo profile flag that builds into `dir` (`target/<dir>`), the directory of the running test's binaries.
fn profile_args(dir: &Path) -> Vec<String> {
    match dir.file_name().and_then(|name| name.to_str()) {
        Some("debug") | None => Vec::new(),
        Some(profile) => vec!["--profile".to_owned(), profile.to_owned()],
    }
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

    /// The server exits on stdin EOF; one that does not within `WAIT` is killed and fails the test.
    fn stop(mut self) {
        drop(self.stdin);
        let deadline = Instant::now() + WAIT;
        while self.child.try_wait().unwrap().is_none() {
            if Instant::now() > deadline {
                let _ = self.child.kill();
                let _ = self.child.wait();
                panic!("the app-server did not exit on stdin EOF");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
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

/// Answers the agent's permission ask with `option` and waits for the agent's reply text and the turn's end.
fn permission_round(option: &str, reply: &str) {
    let (_dir, home, work) = dirs();
    write_agents(&home, &mock_agent(), true, &[]);
    let model = ModelStub::start();
    let mut server = Server::start(&home, &work, &model);
    let session = open_session(&mut server, &work);

    let ack = server.command(send_text(&session, "c-ask", "permission"));
    assert_eq!(ack["status"], "accepted", "{ack}");
    let asked = server.wait_for(|frame| contains(frame, "\"kind\":\"permission\""));
    let text = asked.to_string();
    // A user-once ask: no "always allow" option.
    assert!(!text.contains("allowAlways"), "{text}");
    assert!(text.contains("Run the tests"), "{text}");
    let interaction = text
        .split("\"interactionId\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap()
        .to_owned();
    let ack = server.command(json!({
        "commandId": "c-answer", "clientId": "k", "sessionId": session, "type": "resolveInteraction",
        "issuedAt": 1, "payload": {"interactionId": interaction, "answer": {"optionId": option}},
    }));
    assert_eq!(ack["status"], "accepted", "{ack}");
    let finished = server.wait_for(turn_finished);
    assert!(
        contains(&finished, "\"phase\":\"completedSuccess\""),
        "{finished}"
    );
    assert!(
        server.seen.iter().any(|frame| frame.contains(reply)),
        "no {reply:?}"
    );
    server.stop();
}

#[test]
fn an_allowed_ask_reaches_the_agent_as_allow_once() {
    permission_round("allowOnce", "permission granted");
}

#[test]
fn a_denied_ask_reaches_the_agent_as_reject_once() {
    permission_round("deny", "permission denied");
}

#[test]
fn stop_while_the_agent_starts_ends_the_turn_at_once() {
    let (dir, home, work) = dirs();
    let pid_file = dir.path().join("agent.pid");
    write_agents(
        &home,
        &mock_agent(),
        true,
        &[
            "--silent-initialize",
            "--pid-file",
            pid_file.to_str().unwrap(),
        ],
    );
    let model = ModelStub::start();
    let mut server = Server::start(&home, &work, &model);
    let session = open_session(&mut server, &work);

    let ack = server.command(send_text(&session, "c-start", "hello"));
    assert_eq!(ack["status"], "accepted", "{ack}");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !pid_file.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "the agent never started"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let stopped_at = std::time::Instant::now();
    let ack = server.command(json!({
        "commandId": "c-stop", "clientId": "k", "sessionId": session, "type": "stop",
        "issuedAt": 1, "payload": {},
    }));
    assert_eq!(ack["status"], "accepted", "{ack}");
    let finished = server.wait_for(turn_finished);
    assert!(
        contains(&finished, "\"phase\":\"completedInterrupted\""),
        "{finished}"
    );
    // The handshake timeout is 30 s; Stop must not wait for it.
    assert!(
        stopped_at.elapsed() < std::time::Duration::from_secs(10),
        "Stop waited {:?} for the agent start",
        stopped_at.elapsed()
    );
    let pid = std::fs::read_to_string(&pid_file).unwrap();
    server.stop();
    assert!(
        ends(&pid),
        "the starting agent process ends with the app server"
    );
}

/// Runs one turn with `text` and answers its finished frame.
fn finish_turn(server: &mut Server, session: &str, command: &str, text: &str) -> Value {
    let ack = server.command(send_text(session, command, text));
    assert_eq!(ack["status"], "accepted", "{ack}");
    server.wait_for(turn_finished)
}

#[test]
fn a_changed_launch_replaces_the_agent_process() {
    let (dir, home, work) = dirs();
    let pid_file = dir.path().join("agent.pid");
    let pid_arg = pid_file.to_str().unwrap();
    write_agents(&home, &mock_agent(), true, &["--pid-file", pid_arg]);
    let model = ModelStub::start();
    let mut server = Server::start(&home, &work, &model);
    let session = open_session(&mut server, &work);

    let first = run_turn(&mut server, &session, &pid_file);
    // The record is read every turn; new args are a new launch key.
    write_agents(
        &home,
        &mock_agent(),
        true,
        &["--pid-file", pid_arg, "--config", "options"],
    );
    let finished = finish_turn(&mut server, &session, "c-second", "hello again");
    assert!(
        contains(&finished, "\"phase\":\"completedSuccess\""),
        "{finished}"
    );
    let second = std::fs::read_to_string(&pid_file).unwrap();
    assert_ne!(first, second, "a changed launch starts a new agent process");
    assert!(ends(&first), "the replaced agent process is stopped");
    assert!(alive(&second));
    server.stop();
}

#[test]
fn a_crashed_agent_fails_the_turn_and_the_next_turn_restarts_it() {
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

    let finished = finish_turn(&mut server, &session, "c-crash", "please crash");
    assert!(
        contains(
            &finished,
            "mock stopped during the turn. Send the message again to restart it."
        ),
        "{finished}"
    );
    let crashed = std::fs::read_to_string(&pid_file).unwrap();
    assert!(ends(&crashed));
    let finished = finish_turn(&mut server, &session, "c-after", "hello");
    assert!(
        contains(&finished, "\"phase\":\"completedSuccess\""),
        "{finished}"
    );
    let restarted = std::fs::read_to_string(&pid_file).unwrap();
    assert_ne!(
        crashed, restarted,
        "the next turn starts a new agent process"
    );
    assert_eq!(model.requests(), 0);
    server.stop();
}

#[test]
fn stop_during_a_hang_ends_the_turn_and_the_next_turn_reuses_the_agent() {
    let (dir, home, work) = dirs();
    let pid_file = dir.path().join("agent.pid");
    let state_file = dir.path().join("agent-state.json");
    write_agents(
        &home,
        &mock_agent(),
        true,
        &[
            "--pid-file",
            pid_file.to_str().unwrap(),
            "--state",
            state_file.to_str().unwrap(),
        ],
    );
    let model = ModelStub::start();
    let mut server = Server::start(&home, &work, &model);
    let session = open_session(&mut server, &work);

    let ack = server.command(send_text(&session, "c-hang", "hang"));
    assert_eq!(ack["status"], "accepted", "{ack}");
    // Stop while the agent holds the prompt (a Stop during the start ends the turn before any prompt).
    let deadline = std::time::Instant::now() + WAIT;
    while !std::fs::read_to_string(&state_file).is_ok_and(|state| state.contains("session/prompt"))
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the agent never got the prompt"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let ack = server.command(json!({
        "commandId": "c-stop", "clientId": "k", "sessionId": session, "type": "stop",
        "issuedAt": 1, "payload": {},
    }));
    assert_eq!(ack["status"], "accepted", "{ack}");
    let finished = server.wait_for(turn_finished);
    assert!(
        contains(&finished, "\"phase\":\"completedInterrupted\""),
        "{finished}"
    );
    let pid = std::fs::read_to_string(&pid_file).unwrap();

    let ack = server.command(send_text(&session, "c-again", "hello"));
    assert_eq!(ack["status"], "accepted", "{ack}");
    let finished = server.wait_for(turn_finished);
    assert!(
        contains(&finished, "\"phase\":\"completedSuccess\""),
        "{finished}"
    );
    assert_eq!(
        std::fs::read_to_string(&pid_file).unwrap(),
        pid,
        "a cancelled prompt keeps the agent process"
    );
    server.stop();
}

#[test]
fn stop_while_an_ask_waits_withdraws_it_and_the_agent_hears_cancelled() {
    let (dir, home, work) = dirs();
    let state_file = dir.path().join("agent-state.json");
    write_agents(
        &home,
        &mock_agent(),
        true,
        &["--state", state_file.to_str().unwrap()],
    );
    let model = ModelStub::start();
    let mut server = Server::start(&home, &work, &model);
    let session = open_session(&mut server, &work);

    let ack = server.command(send_text(&session, "c-ask", "permission"));
    assert_eq!(ack["status"], "accepted", "{ack}");
    let asked = server.wait_for(|frame| contains(frame, "\"kind\":\"permission\""));
    let interaction = asked
        .to_string()
        .split("\"interactionId\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap()
        .to_owned();
    // The agent's `session/cancel` does not settle a prompt that waits for an ask: only the withdrawn ask (answered
    // `cancelled`) ends it.
    let ack = server.command(json!({
        "commandId": "c-stop", "clientId": "k", "sessionId": session, "type": "stop",
        "issuedAt": 1, "payload": {},
    }));
    assert_eq!(ack["status"], "accepted", "{ack}");
    let finished = server.wait_for(turn_finished);
    assert!(
        contains(&finished, "\"phase\":\"completedInterrupted\""),
        "{finished}"
    );
    let state = std::fs::read_to_string(&state_file).unwrap();
    assert!(state.contains("permission-cancelled"), "{state}");
    // The dialog closes: the pending list is emptied after the ask was shown.
    let shown = server
        .seen
        .iter()
        .position(|frame| frame.contains(&interaction))
        .expect("the ask was shown");
    assert!(
        server.seen[shown + 1..]
            .iter()
            .any(|frame| frame.contains("\"pendingInteractions\":[]")),
        "the withdrawn ask stays pending"
    );
    server.stop();
}

/// Rules 5 and 8 end to end: a tool call is a live row, the agent's title names the session, and a fresh app-server
/// reads both back from the store (the cold projection keeps the row and every reply text).
#[test]
fn rows_and_the_agent_title_survive_a_restart() {
    let (_dir, home, work) = dirs();
    write_agents(&home, &mock_agent(), true, &[]);
    let model = ModelStub::start();
    let mut server = Server::start(&home, &work, &model);
    let session = open_session(&mut server, &work);

    finish_turn(&mut server, &session, "c-tool", "use a tool");
    assert!(
        server.seen.iter().any(
            |frame| frame.contains("\"toolName\":\"acp:read\"") && frame.contains("Read a.txt")
        ),
        "no live ACP row"
    );
    finish_turn(&mut server, &session, "c-title", "title");
    assert!(
        server.seen.iter().any(|frame| frame
            .contains(r#""meta":{"title":"Parser fix from ACP","titleSource":"generated"}"#)),
        "no agent title"
    );
    server.stop();

    let mut server = Server::start(&home, &work, &model);
    server.request(
        "v4/conversation/subscribe",
        json!({"topic": format!("conversation/{session}"), "connectionId": "k2", "clientMode": "desktop-continuous"}),
    );
    let snapshot = server.wait_for(|frame| {
        frame["method"] == "v4/conversation/frame" && contains(frame, "\"kind\":\"snapshot\"")
    });
    let text = snapshot.to_string();
    assert!(text.contains("\"toolName\":\"acp:read\""), "{text}");
    assert!(text.contains("file body"), "{text}");
    assert!(text.contains("tool finished"), "{text}");
    assert!(text.contains("Parser fix from ACP"), "{text}");
    server.stop();
}
