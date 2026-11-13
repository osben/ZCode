//! Test double of an ACP agent: a port of `packages/services/test/fixtures/acp-mock-agent.mjs` (same markers,
//! flags, session id and method log), so Rust tests drive the runtime the way the Node tests drive theirs.
//!
//! Prompt markers, checked in order: "crash" (exit 3 without answering; Rust-only), "last words" (answer "end_turn",
//! then exit 0 at once; Rust-only), "slow" (stream "partial", then answer "end_turn" with usage after 300 ms without reading stdin; Rust-only),
//! "narrate" (text, a tool call, more text; Rust-only), "hang" (wait for
//! `session/cancel`), "tool", "plan", "title", "permission", "remember <word>", "recall", anything else "pong".
//! Flags: `--state <file>` (memory and method log), `--config options|legacy` (or `ACP_MOCK_CONFIG`),
//! `--refuse-load` (Rust-only: `session/load` fails, so a resume becomes a reset), `--pid-file <file>` (Rust-only: the
//! process id is written there at start, so a test can see the process end), `--deaf-after-session` (Rust-only: after
//! answering `session/new` it stops reading stdin and stays alive, so the client's writes block), `--silent-initialize`
//! (Rust-only: `initialize` is never answered, so the start hangs), `--close-stdin-after-session` (Rust-only: it
//! closes its stdin, then answers `session/new` and stays alive with stdout open, so the client's next write fails).
#![allow(
    clippy::disallowed_methods,
    reason = "a test double binary: it reads its own argv/env and writes its state file directly"
)]

use std::collections::HashMap;
use std::io::{BufRead, Write};

use serde_json::{Value, json};

const SESSION_ID: &str = "services-mock-session";

struct Mock {
    state_file: Option<String>,
    config_mode: String,
    refuse_load: bool,
    deaf_after_session: bool,
    silent_initialize: bool,
    close_stdin_after_session: bool,
    mode: String,
    model: String,
    current_mode_id: String,
    hang_id: Option<Value>,
    /// Permission asks this mock sent: request id → (prompt id, session id).
    asks: HashMap<u64, (Value, String)>,
    next_request_id: u64,
}

fn send(message: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

fn notify(session_id: &str, update: Value) {
    send(&json!({"jsonrpc": "2.0", "method": "session/update",
                 "params": {"sessionId": session_id, "update": update}}));
}

fn message(text: &str) -> Value {
    json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}})
}

#[cfg(unix)]
#[allow(
    unsafe_code,
    reason = "a test double closes its own stdin; std has no safe way to close fd 0"
)]
fn close_stdin() {
    use std::os::fd::FromRawFd as _;
    // SAFETY: fd 0 belongs to this process and is never read again: the caller sleeps until it is killed.
    drop(unsafe { std::os::fd::OwnedFd::from_raw_fd(0) });
}

#[cfg(not(unix))]
fn close_stdin() {
    panic!("--close-stdin-after-session is supported on unix only");
}

fn done(id: &Value, stop_reason: &str) {
    send(&json!({"jsonrpc": "2.0", "id": id, "result": {"stopReason": stop_reason}}));
}

fn fail(id: &Value, text: &str) {
    send(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": text}}));
}

impl Mock {
    fn read_state(&self) -> Value {
        self.state_file
            .as_ref()
            .and_then(|file| std::fs::read_to_string(file).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_else(|| json!({"memory": null, "methods": []}))
    }

    fn write_state(&self, state: &Value) {
        if let Some(file) = &self.state_file {
            let _ = std::fs::write(file, state.to_string());
        }
    }

    fn record(&self, method: &str) {
        if self.state_file.is_none() {
            return;
        }
        let mut state = self.read_state();
        if let Some(methods) = state.get_mut("methods").and_then(Value::as_array_mut) {
            methods.push(json!(method));
        }
        self.write_state(&state);
    }

    fn config_options(&self) -> Value {
        json!([
            {"id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": self.mode,
             "options": [{"value": "agent", "name": "Agent"}, {"value": "plan", "name": "Plan"},
                         {"value": "ask", "name": "Ask"}]},
            {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": self.model,
             "options": [{"value": "m1", "name": "Model 1"}, {"value": "m2", "name": "Model 2"}]}
        ])
    }

    fn session_config(&self) -> Value {
        match self.config_mode.as_str() {
            "options" => json!({"configOptions": self.config_options()}),
            "legacy" => json!({"modes": {"currentModeId": self.current_mode_id, "availableModes": [
                {"id": "build", "name": "Build"}, {"id": "plan", "name": "Plan"}]}}),
            _ => json!({}),
        }
    }

    fn prompt(&mut self, id: Value, params: &Value) {
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or(SESSION_ID)
            .to_owned();
        let text = params
            .get("prompt")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        if text.contains("crash") {
            std::process::exit(3);
        }
        if text.contains("last words") {
            done(&id, "end_turn");
            std::process::exit(0);
        }
        if text.contains("slow") {
            // Answers after a pause without reading stdin, so a `session/cancel` sent meanwhile is read too late.
            notify(&session_id, message("partial"));
            std::thread::sleep(std::time::Duration::from_millis(300));
            return send(&json!({"jsonrpc": "2.0", "id": id, "result": {
                "stopReason": "end_turn", "usage": {"inputTokens": 7, "outputTokens": 3}}}));
        }
        if text.contains("narrate") {
            notify(&session_id, message("let me look"));
            notify(
                &session_id,
                json!({"sessionUpdate": "tool_call", "toolCallId": "tool-1",
                "title": "Read a.txt", "kind": "read", "status": "in_progress"}),
            );
            notify(&session_id, message("done looking"));
            return done(&id, "end_turn");
        }
        if text.contains("hang") {
            self.hang_id = Some(id);
            return;
        }
        if text.contains("tool") {
            notify(
                &session_id,
                json!({"sessionUpdate": "tool_call", "toolCallId": "tool-1",
                "title": "Read a.txt", "kind": "read", "status": "in_progress", "rawInput": {"path": "a.txt"}}),
            );
            notify(
                &session_id,
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "tool-1",
                "status": "completed",
                "content": [{"type": "content", "content": {"type": "text", "text": "file body"}}]}),
            );
            notify(&session_id, message("tool finished"));
            return done(&id, "end_turn");
        }
        if text.contains("plan") {
            notify(
                &session_id,
                json!({"sessionUpdate": "plan", "entries": [
                {"content": "Read the spec", "priority": "high", "status": "completed"},
                {"content": "Write the tests", "priority": "medium", "status": "in_progress"},
                {"content": "Ship the change", "priority": "low", "status": "pending"}]}),
            );
            notify(&session_id, message("planned"));
            return done(&id, "end_turn");
        }
        if text.contains("title") {
            notify(
                &session_id,
                json!({"sessionUpdate": "session_info_update", "title": "Parser fix from ACP"}),
            );
            notify(&session_id, message("titled"));
            return done(&id, "end_turn");
        }
        if text.contains("permission") {
            let request_id = self.next_request_id;
            self.next_request_id += 1;
            self.asks.insert(request_id, (id, session_id.clone()));
            send(
                &json!({"jsonrpc": "2.0", "id": request_id, "method": "session/request_permission",
                "params": {"sessionId": session_id,
                    "toolCall": {"toolCallId": "perm-tool", "title": "Run the tests", "kind": "execute",
                        "status": "pending",
                        "content": [{"type": "content", "content": {"type": "text", "text": "pnpm test"}}]},
                    "options": [
                        {"optionId": "opt-allow", "name": "Allow once", "kind": "allow_once"},
                        {"optionId": "opt-always", "name": "Always allow", "kind": "allow_always"},
                        {"optionId": "opt-reject", "name": "Reject", "kind": "reject_once"}]}}),
            );
            return;
        }
        if let Some(word) = text
            .split("remember ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
        {
            let mut state = self.read_state();
            state["memory"] = json!(word);
            self.write_state(&state);
            notify(&session_id, message("remembered"));
            return done(&id, "end_turn");
        }
        if text.contains("recall") {
            let state = self.read_state();
            let memory = state
                .get("memory")
                .and_then(Value::as_str)
                .unwrap_or("nothing")
                .to_owned();
            notify(&session_id, message(&format!("recalled {memory}")));
            return done(&id, "end_turn");
        }
        notify(&session_id, message("pong"));
        done(&id, "end_turn");
    }

    fn answered(&mut self, id: u64, result: Option<&Value>) {
        let Some((prompt_id, session_id)) = self.asks.remove(&id) else {
            return;
        };
        let outcome = result.and_then(|result| result.get("outcome"));
        let option = (outcome
            .and_then(|outcome| outcome.get("outcome"))
            .and_then(Value::as_str)
            == Some("selected"))
        .then(|| {
            outcome
                .and_then(|outcome| outcome.get("optionId"))
                .and_then(Value::as_str)
        })
        .flatten();
        match option {
            Some("opt-allow") => {
                notify(&session_id, message("permission granted"));
                done(&prompt_id, "end_turn");
            }
            Some("opt-reject") => {
                notify(&session_id, message("permission denied"));
                done(&prompt_id, "end_turn");
            }
            _ => {
                self.record("permission-cancelled");
                done(&prompt_id, "cancelled");
            }
        }
    }

    fn handle(&mut self, request: &Value) {
        let id = request.get("id").cloned();
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let Some(method) = request.get("method").and_then(Value::as_str) else {
            if let Some(id) = id.as_ref().and_then(Value::as_u64) {
                self.answered(id, request.get("result"));
            }
            return;
        };
        let id = id.unwrap_or(Value::Null);
        match method {
            "initialize" if self.silent_initialize => self.record("initialize"),
            "initialize" => send(
                &json!({"jsonrpc": "2.0", "id": id, "result": {"protocolVersion": 1,
                "agentCapabilities": {"loadSession": true, "promptCapabilities": {"image": true}},
                "authMethods": []}}),
            ),
            "session/new" => {
                self.record("session/new");
                let mut result = self.session_config();
                result["sessionId"] = json!(SESSION_ID);
                if self.close_stdin_after_session {
                    // Closed before the answer: the client's first write after the handshake meets a closed pipe.
                    close_stdin();
                    send(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(3600));
                    }
                }
                send(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
                if self.deaf_after_session {
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(3600));
                    }
                }
            }
            "session/load" => {
                self.record("session/load");
                if self.refuse_load {
                    return fail(&id, "session not found");
                }
                let session = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or(SESSION_ID);
                notify(session, message("replayed history"));
                send(&json!({"jsonrpc": "2.0", "id": id, "result": self.session_config()}));
            }
            "session/set_config_option" => {
                let config_id = params
                    .get("configId")
                    .and_then(Value::as_str)
                    .unwrap_or("undefined");
                let value = params
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or("undefined");
                self.record(&format!("session/set_config_option {config_id}={value}"));
                let offered = match config_id {
                    "mode" => ["agent", "plan", "ask"].contains(&value),
                    "model" => ["m1", "m2"].contains(&value),
                    _ => return fail(&id, &format!("unknown config option {config_id}")),
                };
                if self.config_mode != "options" {
                    return fail(&id, &format!("unknown config option {config_id}"));
                }
                if !offered {
                    return fail(&id, &format!("invalid value {value} for {config_id}"));
                }
                if config_id == "mode" {
                    self.mode = value.to_owned();
                } else {
                    self.model = value.to_owned();
                }
                send(
                    &json!({"jsonrpc": "2.0", "id": id, "result": {"configOptions": self.config_options()}}),
                );
            }
            "session/set_mode" => {
                let mode = params
                    .get("modeId")
                    .and_then(Value::as_str)
                    .unwrap_or("undefined");
                self.record(&format!("session/set_mode {mode}"));
                if self.config_mode != "legacy" || !["build", "plan"].contains(&mode) {
                    return fail(&id, &format!("invalid mode {mode}"));
                }
                self.current_mode_id = mode.to_owned();
                send(&json!({"jsonrpc": "2.0", "id": id, "result": {}}));
            }
            "session/prompt" => {
                self.record("session/prompt");
                self.prompt(id, &params);
            }
            "session/cancel" => {
                if let Some(hang) = self.hang_id.take() {
                    done(&hang, "cancelled");
                }
            }
            _ if !id.is_null() => send(&json!({"jsonrpc": "2.0", "id": id, "result": {}})),
            _ => {}
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    let mut mock = Mock {
        state_file: flag("--state"),
        config_mode: flag("--config")
            .or_else(|| std::env::var("ACP_MOCK_CONFIG").ok())
            .unwrap_or_default(),
        refuse_load: args.iter().any(|arg| arg == "--refuse-load"),
        deaf_after_session: args.iter().any(|arg| arg == "--deaf-after-session"),
        silent_initialize: args.iter().any(|arg| arg == "--silent-initialize"),
        close_stdin_after_session: args.iter().any(|arg| arg == "--close-stdin-after-session"),
        mode: "agent".to_owned(),
        model: "m1".to_owned(),
        current_mode_id: "build".to_owned(),
        hang_id: None,
        asks: HashMap::new(),
        next_request_id: 1000,
    };
    if let Some(file) = flag("--pid-file") {
        let _ = std::fs::write(file, std::process::id().to_string());
    }
    let _ = writeln!(std::io::stderr(), "acp-mock-agent ready");
    mock.record("process-start");
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(request) = serde_json::from_str::<Value>(&line) {
            mock.handle(&request);
        }
    }
}
