//! 桌面账号凭据的启动（specs/fork-rust-credential-cipher.md，启动死锁）：`credentials.json` 是 `enc:v2:`，装配时要解密
//! 才能定缺省模型。解密走反向请求 `interaction/requestCredentialCipher`，要 agent 在装配期间就读 stdin，否则 `ready`
//! 要等到超时。真实进程 `zcode-rs app-server --stdio`，假 Host 回答加解密请求。
#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    reason = "集成测试：准备临时目录、起真实进程、读它的标准输入输出"
)]

mod system_env;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use system_env::KeepSystem as _;

use serde_json::{Value, json};

/// 启动必须在这之内到达 `ready`（正常不到 1 s）。超时说明 agent 在等一个它自己没读的回复（死锁），而不是慢。
const READY_WITHIN: Duration = Duration::from_secs(10);

/// 假 Host 的可逆加解密：与 Host 的 `enc:v2:` 形状一致，只是密钥换成反转字符。
fn seal(plain: &str) -> String {
    let reversed: String = plain.chars().rev().collect();
    format!("enc:v2:os:0123456789abcdef01234567:{reversed}")
}

fn open(value: &str) -> Option<String> {
    let body = value.strip_prefix("enc:v2:os:0123456789abcdef01234567:")?;
    Some(body.chars().rev().collect())
}

/// How the fake Host acknowledges that it listens (specs/fork-rust-credential-cipher.md F1).
#[derive(Clone, Copy)]
enum Ack {
    /// No `ZCODE_HOST_ATTACH_ACK`: an older Host.
    Undeclared,
    /// Declared; `process/hostAttached` is sent after this delay.
    After(Duration),
}

/// 起 app-server，回答它的加解密请求，读到 `ready` 为止；返回收到的加解密请求数与耗时。
fn start(home: &Path, work: &Path) -> (String, usize, Duration) {
    let (status, asked, elapsed, _) = start_with(home, work, Ack::Undeclared);
    (status, asked, elapsed)
}

/// Like [`start`]; also returns how many cipher requests arrived before the acknowledgement was sent.
fn start_with(home: &Path, work: &Path, ack: Ack) -> (String, usize, Duration, usize) {
    let mut command = rust_cli_proc::std_command(env!("CARGO_BIN_EXE_zcode-rs"));
    command
        .args(["app-server", "--stdio", "--surface", "desktop"])
        .current_dir(work)
        .env_clear()
        .keep_system()
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("PATH", "/usr/bin:/bin")
        .env("ZCODE_DATA_BASE_DIR", home);
    if let Ack::After(_) = ack {
        command.env("ZCODE_HOST_ATTACH_ACK", "1");
    }
    let mut child = command
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
    let started = Instant::now();
    let mut asked = 0;
    let mut early = 0;
    let mut ready = None;
    let mut acked = matches!(ack, Ack::Undeclared);
    while ready.is_none() {
        if let Ack::After(delay) = ack
            && !acked
            && started.elapsed() >= delay
        {
            let frame =
                json!({"method": "process/hostAttached", "params": {"credentialCipher": true}});
            writeln!(stdin, "{frame}").unwrap();
            stdin.flush().unwrap();
            acked = true;
        }
        let remaining = READY_WITHIN.saturating_sub(started.elapsed());
        let wait = match ack {
            Ack::After(delay) if !acked => delay.saturating_sub(started.elapsed()).min(remaining),
            _ => remaining,
        };
        let line = match frames.recv_timeout(wait) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) if !acked && started.elapsed() < READY_WITHIN => {
                continue;
            }
            Err(_) => break,
        };
        let frame: Value = serde_json::from_str(&line).unwrap();
        if frame["method"] == "interaction/requestCredentialCipher" {
            asked += 1;
            if !acked {
                early += 1;
            }
            let params = &frame["params"];
            let value = params["value"].as_str().unwrap();
            let result = if params["operation"] == "decrypt" {
                match open(value) {
                    Some(plain) => json!({"ok": true, "value": plain}),
                    None => json!({"ok": true, "value": value}),
                }
            } else {
                json!({"ok": true, "value": seal(value)})
            };
            let reply = json!({"id": frame["id"], "result": {
                "requestId": params["requestId"], "result": result}});
            writeln!(stdin, "{reply}").unwrap();
            stdin.flush().unwrap();
        } else if frame["method"] == "startup/storageState" && frame["params"]["phase"] == "ready" {
            ready = Some(started.elapsed());
        }
    }
    let elapsed = ready.unwrap_or(READY_WITHIN);
    drop(stdin);
    child.kill().ok();
    child.wait().ok();
    (
        if ready.is_some() {
            "ready".to_owned()
        } else {
            "no ready".to_owned()
        },
        asked,
        elapsed,
        early,
    )
}

#[test]
fn an_encrypted_account_login_does_not_stall_startup() {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let (home, work) = (base.join("home"), base.join("work"));
    std::fs::create_dir_all(work.join(".git")).unwrap();
    std::fs::create_dir_all(home.join(".zcode/v2")).unwrap();
    let record = json!({
        "oauth:zai:user_info": seal(r#"{"id":"u-1","username":"a","displayName":"A"}"#),
        "oauth:zai:access_token": seal("login-token"),
    });
    std::fs::write(home.join(".zcode/v2/credentials.json"), record.to_string()).unwrap();

    let (status, asked, elapsed) = start(&home, &work);
    assert!(
        asked > 0,
        "the startup path must read the encrypted credentials through the Host"
    );
    assert_eq!(
        status, "ready",
        "no ready within {READY_WITHIN:?} (after {elapsed:?})"
    );
}

/// B4: with the acknowledgement declared, the agent sends no cipher request before the Host says it listens, and
/// reaches `ready` right after it.
#[test]
fn a_declared_host_gets_no_cipher_request_before_it_acknowledges() {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let (home, work) = (base.join("home"), base.join("work"));
    std::fs::create_dir_all(work.join(".git")).unwrap();
    std::fs::create_dir_all(home.join(".zcode/v2")).unwrap();
    let record = json!({
        "oauth:zai:user_info": seal(r#"{"id":"u-1","username":"a","displayName":"A"}"#),
        "oauth:zai:access_token": seal("login-token"),
    });
    std::fs::write(home.join(".zcode/v2/credentials.json"), record.to_string()).unwrap();

    let delay = Duration::from_millis(1500);
    let (status, asked, elapsed, early) = start_with(&home, &work, Ack::After(delay));
    assert_eq!(
        status, "ready",
        "no ready within {READY_WITHIN:?} (after {elapsed:?})"
    );
    assert_eq!(
        early, 0,
        "a cipher request arrived before the acknowledgement"
    );
    assert!(
        asked > 0,
        "the encrypted credentials are read through the Host"
    );
    assert!(elapsed >= delay, "ready came before the acknowledgement");
}
