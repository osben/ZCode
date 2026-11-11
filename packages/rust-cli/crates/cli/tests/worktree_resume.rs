//! Fork execution worktree, cold open of a session the Node agent stored (specs/fork-rust-agent-parity.md
//! "Execution worktree"): the row's `directory` is the parent workspace, `execution_directory` is the worktree.
//! A real `zcode-rs -p --resume` runs Bash and Write in the worktree. When the worktree is gone it fails closed:
//! nothing runs in or writes to the parent checkout, and the worktree is not recreated
//! (execution-worktree-missing-handling.md section 2).
#![cfg(unix)]
#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    reason = "integration test: temp dirs, a local HTTP fixture, reading written files"
)]

mod compacted;
mod sse;

use std::path::{Path, PathBuf};
use std::process::Stdio;

use compacted::SESSION;
use rust_cli_base::models::GLM_5_3;
use rust_cli_kernel_api::ids::SessionId;
use serde_json::{Value, json};

struct Sandbox {
    _dir: tempfile::TempDir,
    home: PathBuf,
    work: PathBuf,
    worktree: PathBuf,
}

/// A Node-stored worktree session: the parent `work` and the worktree path `wt` (created only when `exists`).
async fn node_worktree_session(exists: bool) -> Sandbox {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let (home, work, worktree) = (base.join("home"), base.join("work"), base.join("wt"));
    std::fs::create_dir_all(work.join(".git")).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    if exists {
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: ../work/.git/worktrees/wt\n").unwrap();
    }
    let store = compacted::store(&home);
    compacted::seed(&store, &work, 1, &[]).await;
    store
        .node_worktree_session(
            &SessionId::new(SESSION),
            worktree.to_str().unwrap(),
            "feat/wt",
        )
        .await
        .unwrap();
    Sandbox {
        _dir: dir,
        home,
        work,
        worktree,
    }
}

fn call(id: &str, name: &str, input: &Value) -> String {
    sse::tools_reply(&[sse::tool_block(0, id, name, &input.to_string())])
}

/// `pwd`, then a relative Write, then an answer.
fn script() -> Vec<String> {
    vec![
        call(
            "toolu_pwd",
            "Bash",
            &json!({"command": "pwd", "description": "where"}),
        ),
        // An edit with an empty `old_string` creates the file and its parent directories.
        call(
            "toolu_edit",
            "Edit",
            &json!({"file_path": "sub/y.txt", "old_string": "", "new_string": "edited\n"}),
        ),
        call(
            "toolu_write",
            "Write",
            &json!({"file_path": "x.txt", "content": "from the session\n"}),
        ),
        sse::text_reply("after tools"),
    ]
}

/// Resumes the session with `zcode-rs -p`, started from the parent checkout; returns each tool result's
/// (text, is_error) by tool use id.
fn resume(sandbox: &Sandbox, fixture: &sse::Fixture) -> Vec<(String, String, bool)> {
    let output = rust_cli_proc::std_command(env!("CARGO_BIN_EXE_zcode-rs"))
        .args([
            "-p",
            "--resume",
            SESSION,
            "go",
            // The resumed session keeps its stored mode (default): rules allow both tools.
            "--allowedTools",
            "Bash,Write,Edit",
        ])
        .current_dir(&sandbox.work)
        .env_clear()
        .env("HOME", &sandbox.home)
        .env("USERPROFILE", &sandbox.home)
        .env("PATH", "/usr/bin:/bin")
        .env("SHELL", "/bin/bash")
        .env("ZCODE_DATA_BASE_DIR", &sandbox.home)
        .env("ZCODE_MODEL_BASE_URL", &fixture.url)
        .env("ZCODE_API_KEY", "test-key")
        .env("ZCODE_MODEL", GLM_5_3)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let requests = fixture.main_requests();
    let mut found = Vec::new();
    for message in requests.last().unwrap()["messages"]
        .as_array()
        .into_iter()
        .flatten()
    {
        for block in message["content"].as_array().into_iter().flatten() {
            if block["type"] != "tool_result" {
                continue;
            }
            let text: String = match &block["content"] {
                Value::String(text) => text.clone(),
                Value::Array(parts) => parts
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .collect(),
                _ => String::new(),
            };
            found.push((
                block["tool_use_id"].as_str().unwrap().to_owned(),
                sse::tool_output(&text).to_owned(),
                block["is_error"].as_bool().unwrap_or(false),
            ));
        }
    }
    found
}

fn result<'a>(results: &'a [(String, String, bool)], id: &str) -> (&'a str, bool) {
    results
        .iter()
        .find(|(found, _, _)| found == id)
        .map(|(_, text, error)| (text.as_str(), *error))
        .unwrap()
}

fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Before the fix a cold open loaded `directory` (the parent): `pwd` was the parent and Write landed in it.
#[tokio::test]
async fn a_node_worktree_session_resumes_in_the_worktree() {
    let sandbox = node_worktree_session(true).await;
    let fixture = sse::serve(script());
    let results = resume(&sandbox, &fixture);

    let (pwd, error) = result(&results, "toolu_pwd");
    assert!(!error, "{pwd}");
    assert_eq!(pwd.trim(), sandbox.worktree.to_str().unwrap());
    assert_eq!(
        read(&sandbox.worktree.join("x.txt")).as_deref(),
        Some("from the session\n")
    );
    assert_eq!(
        read(&sandbox.worktree.join("sub/y.txt")).as_deref(),
        Some("edited\n")
    );
    assert_eq!(read(&sandbox.work.join("x.txt")), None);
}

/// The worktree directory is gone: Bash fails instead of running in the parent, and nothing is written to the
/// parent checkout.
#[tokio::test]
async fn a_missing_worktree_fails_closed() {
    let sandbox = node_worktree_session(false).await;
    let fixture = sse::serve(script());
    let results = resume(&sandbox, &fixture);

    let (pwd, error) = result(&results, "toolu_pwd");
    assert!(error, "{pwd}");
    assert_ne!(pwd.trim(), sandbox.work.to_str().unwrap());
    // Neither Edit nor Write lands in the parent or recreates the worktree as an ordinary directory.
    let (edit, error) = result(&results, "toolu_edit");
    assert!(error, "{edit}");
    assert!(
        edit.contains("Working directory is missing or unavailable"),
        "{edit}"
    );
    let (write, error) = result(&results, "toolu_write");
    assert!(error, "{write}");
    assert!(
        write.contains("Working directory is missing or unavailable"),
        "{write}"
    );
    assert_eq!(read(&sandbox.work.join("x.txt")), None);
    assert_eq!(read(&sandbox.work.join("sub/y.txt")), None);
    assert!(!sandbox.worktree.exists());
}
