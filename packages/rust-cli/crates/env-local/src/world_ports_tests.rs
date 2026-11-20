//! The production world ports over real files, a real `git` and the real local environment (W7-4). Node cases:
//! `workflow-git-world-read-real.test.ts` (real git), the glob/read/grep and run cases of `workflow-world-read`, and the
//! symlink and containment cases of `workflow-artifact-publish`. Unix only: the tests use `/bin/sh` and `mkfifo`.
#![cfg(unix)]
#![expect(
    clippy::result_large_err,
    reason = "WorkflowError is the engine's error type; boxing it would split the type (as the workflow modules note)"
)]
#![expect(
    clippy::disallowed_methods,
    reason = "the tests prepare temporary files, a git repository and a fifo directly, as the other env-local tests do"
)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use rust_cli_kernel_api::ids::{ArtifactId, SessionId};
use rust_cli_kernel_api::store::{ArtifactPurpose, ArtifactRef, ArtifactStore, StoreError};
use rust_cli_workflow::artifact_publish::{
    ArtifactFsPort, ArtifactStorePort, FsFault, PublishDeps, StoreReceipt, StoreWrite,
    execute_artifact_publish,
};
use rust_cli_workflow::engine_artifacts::ArtifactPublishRequest;
use rust_cli_workflow::error::ErrorCode;
use rust_cli_workflow::world_read::{RunRequest, RunStatus, WorldReadPorts, execute_world_read};
use serde_json::{Value, json};

use crate::LocalEnvironment;
use crate::shell::ShellConfig;
use crate::world_ports::{StoreAdapter, WorldFs, WorldPorts};

struct Fixture {
    /// Holds the directory; the path is not canonicalized, so on macOS the workspace sits behind `/var` -> `/private/var`
    /// as the Node cases do.
    _dir: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    ports: Arc<WorldPorts>,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().to_path_buf();
    let root = base.join("work");
    std::fs::create_dir_all(root.join("sub")).unwrap();
    let path = std::env::var("PATH").unwrap_or_default();
    let env = LocalEnvironment::new(None).with_shell(ShellConfig {
        scratch: base.join("scratch"),
        ledger: base.join("ledger"),
        bash: Some(PathBuf::from("/bin/bash")),
        bwrap: None,
        embedded: None,
        env: vec![("PATH".to_owned(), path)].into(),
    });
    let ports = WorldPorts::new(
        Arc::new(env),
        root.clone(),
        tokio::runtime::Handle::current(),
    );
    Fixture {
        _dir: dir,
        base,
        root,
        ports: Arc::new(ports),
    }
}

/// Runs a blocking port call on a worker thread, as the owner does.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(f).await.unwrap()
}

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.invalid",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs");
    assert!(output.status.success(), "git {args:?} failed");
}

fn repository(root: &Path) {
    git(root, &["init", "-q"]);
    // `sub/` holds a tracked file as well, so git lists the untracked file by name rather than collapsing the directory.
    std::fs::write(root.join("tracked.txt"), "one\n").unwrap();
    std::fs::write(root.join("sub/kept.txt"), "kept\n").unwrap();
    git(root, &["add", "tracked.txt", "sub/kept.txt"]);
    git(root, &["commit", "-q", "-m", "first commit"]);
    std::fs::write(root.join("sub/new file.txt"), "two\n").unwrap();
}

fn run_request(root: &Path, file: &str, args: &[&str]) -> RunRequest {
    RunRequest {
        cwd: root.to_path_buf(),
        file: file.to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        timeout_ms: None,
        max_inline_bytes: 1024 * 1024,
        tail_bytes: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn glob_returns_absolute_paths_under_the_workspace_and_the_total() {
    let fx = fixture();
    std::fs::write(fx.root.join("a.txt"), "a").unwrap();
    std::fs::write(fx.root.join("sub/b.txt"), "b").unwrap();
    let ports = fx.ports.clone();
    let hits = blocking(move || ports.glob("**/*.txt", 10)).await.unwrap();
    assert_eq!(hits.total, 2);
    let canonical = std::fs::canonicalize(&fx.root).unwrap();
    for file in &hits.files {
        assert!(
            Path::new(file).starts_with(&canonical) || Path::new(file).starts_with(&fx.root),
            "{file} is not under the workspace"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn glob_keeps_the_total_past_the_limit() {
    let fx = fixture();
    for name in ["a.txt", "b.txt", "c.txt"] {
        std::fs::write(fx.root.join(name), "x").unwrap();
    }
    let ports = fx.ports.clone();
    let hits = blocking(move || ports.glob("*.txt", 2)).await.unwrap();
    assert_eq!(hits.files.len(), 2);
    assert_eq!(hits.total, 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn read_returns_the_exact_text_including_the_final_newline() {
    let fx = fixture();
    let file = fx.root.join("sub/exact.txt");
    std::fs::write(&file, "first\nsecond\n\n").unwrap();
    let ports = fx.ports.clone();
    let text = blocking(move || ports.read_text(file.to_str().unwrap()))
        .await
        .unwrap();
    assert_eq!(text, "first\nsecond\n\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn grep_returns_content_matches_and_flags_the_head_limit() {
    let fx = fixture();
    std::fs::write(fx.root.join("hay.txt"), "a\nneedle\nneedle\n").unwrap();
    let ports = fx.ports.clone();
    let ports2 = fx.ports.clone();
    let all = blocking(move || ports.grep("needle", None, 10))
        .await
        .unwrap();
    assert!(!all.truncated);
    let lines: Vec<_> = all
        .entries
        .iter()
        .map(|e| (e.line, e.text.clone()))
        .collect();
    assert_eq!(
        lines,
        vec![
            (Some(2), Some("needle".to_owned())),
            (Some(3), Some("needle".to_owned())),
        ]
    );
    let capped = blocking(move || ports2.grep("needle", None, 1))
        .await
        .unwrap();
    assert_eq!(capped.entries.len(), 1);
    assert!(capped.truncated);
}

#[tokio::test(flavor = "multi_thread")]
async fn run_passes_arguments_unexpanded_and_keeps_stderr_apart() {
    let fx = fixture();
    let ports = fx.ports.clone();
    // The argument reaches sh's script as `$1`: nothing outside the argv list expands it.
    let request = run_request(
        &fx.root,
        "/bin/sh",
        &[
            "-c",
            "printf '%s\\n' \"$1\"; echo bad >&2",
            "sh",
            "$HOME ;echo x",
        ],
    );
    let outcome = blocking(move || ports.run(&request)).await.unwrap();
    assert_eq!(outcome.status, RunStatus::Completed);
    assert_eq!(outcome.exit_code, Some(0));
    assert_eq!(outcome.stdout.text, "$HOME ;echo x\n");
    assert_eq!(outcome.stderr.text, "bad\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_nonzero_exit_is_a_failed_run_with_no_error() {
    let fx = fixture();
    let ports = fx.ports.clone();
    let request = run_request(&fx.root, "/bin/sh", &["-c", "exit 4"]);
    let outcome = blocking(move || ports.run(&request)).await.unwrap();
    assert_eq!(outcome.status, RunStatus::Failed);
    assert_eq!(outcome.exit_code, Some(4));
    assert_eq!(outcome.error, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_program_that_is_not_on_path_is_a_spawn_error_not_a_port_fault() {
    let fx = fixture();
    let ports = fx.ports.clone();
    let request = run_request(&fx.root, "no-such-program-w7-4", &[]);
    let outcome = blocking(move || ports.run(&request)).await.unwrap();
    assert_eq!(outcome.status, RunStatus::SpawnError);
    assert!(outcome.error.is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_past_its_timeout_is_timed_out() {
    let fx = fixture();
    let ports = fx.ports.clone();
    let mut request = run_request(&fx.root, "/bin/sh", &["-c", "sleep 5"]);
    request.timeout_ms = Some(200);
    let outcome = blocking(move || ports.run(&request)).await.unwrap();
    assert_eq!(outcome.status, RunStatus::TimedOut);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tail_is_the_last_bytes_and_an_over_limit_stream_is_flagged() {
    let fx = fixture();
    let ports = fx.ports.clone();
    let mut tail = run_request(&fx.root, "/bin/sh", &["-c", "printf abcdef"]);
    tail.tail_bytes = Some(3);
    tail.max_inline_bytes = 0;
    let outcome = blocking(move || ports.run(&tail)).await.unwrap();
    assert_eq!(outcome.stdout.tail.as_deref(), Some("def"));
    assert_eq!(outcome.stdout.bytes, 6);
    assert_eq!(outcome.stdout.text, "");
    assert!(outcome.stdout.truncated);

    let ports = fx.ports.clone();
    let mut small = run_request(&fx.root, "/bin/sh", &["-c", "printf abcdef"]);
    small.max_inline_bytes = 4;
    let outcome = blocking(move || ports.run(&small)).await.unwrap();
    assert_eq!(outcome.stdout.text, "abcd");
    assert_eq!(outcome.stdout.bytes, 6);
    assert!(outcome.stdout.truncated);
    assert_eq!(outcome.stdout.tail, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn git_status_inside_a_subdirectory_is_workspace_relative() {
    let fx = fixture();
    repository(&fx.root);
    let ports = fx.ports.clone();
    let root = fx.root.join("sub");
    let status = blocking(move || execute_world_read(&root, ports.as_ref(), "git-status", &[]))
        .await
        .unwrap();
    // git reports the repository-relative path; from `sub/` the workspace-relative one is `new file.txt`.
    assert_eq!(status["untracked"], json!(["new file.txt"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn git_log_returns_the_commit_with_a_full_hash_and_subject() {
    let fx = fixture();
    repository(&fx.root);
    let ports = fx.ports.clone();
    let root = fx.root.clone();
    let log = blocking(move || execute_world_read(&root, ports.as_ref(), "git-log", &[json!(1)]))
        .await
        .unwrap();
    let commit = &log.as_array().unwrap()[0];
    assert_eq!(commit["subject"], "first commit");
    assert_eq!(commit["hash"].as_str().unwrap().len(), 40);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_directory_that_is_not_a_repository_fails_the_git_read_catchably() {
    let fx = fixture();
    let ports = fx.ports.clone();
    let root = fx.root.clone();
    let failed = blocking(move || execute_world_read(&root, ports.as_ref(), "git-status", &[]))
        .await
        .unwrap_err();
    assert_eq!(failed.code, ErrorCode::DriverError);
}

/// A store that keeps what it was given, as the engine's artifact store does.
#[derive(Default)]
struct RecordingStore {
    writes: Mutex<Vec<(String, Vec<u8>)>>,
}

impl ArtifactStorePort for RecordingStore {
    fn supports_binary(&self) -> bool {
        true
    }
    fn write(&self, write: &StoreWrite<'_>) -> Result<StoreReceipt, String> {
        let bytes = match write.content {
            rust_cli_workflow::artifact_publish::StoreContent::Text(text) => {
                text.as_bytes().to_vec()
            }
            rust_cli_workflow::artifact_publish::StoreContent::Binary(bytes) => bytes.to_vec(),
        };
        let len = bytes.len();
        self.writes
            .lock()
            .unwrap()
            .push((write.session_id.to_owned(), bytes));
        Ok(StoreReceipt {
            bytes: len,
            uri: "zcode-artifact://test/one".to_owned(),
        })
    }
}

fn file_publish(path: &str) -> ArtifactPublishRequest {
    ArtifactPublishRequest {
        run_id: "run-1".to_owned(),
        site_id: "site".to_owned(),
        ordinal: 1,
        op: "file".to_owned(),
        id: "out".to_owned(),
        version: 1,
        path: Some(path.to_owned()),
        content: None,
        opts: None,
    }
}

fn publish(
    root: &Path,
    store: &RecordingStore,
    request: &ArtifactPublishRequest,
) -> Result<Value, rust_cli_workflow::error::WorkflowError> {
    let deps = PublishDeps {
        fs: &WorldFs,
        store: Some(store),
        parent_session_id: Some("parent"),
        cwd: root,
        now_ms: 1,
    };
    execute_artifact_publish(&deps, request)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_inside_the_workspace_is_published_with_its_bytes() {
    let fx = fixture();
    std::fs::write(fx.root.join("sub/report.md"), "# hi\n").unwrap();
    let store = RecordingStore::default();
    publish(&fx.root, &store, &file_publish("sub/report.md")).unwrap();
    let writes = store.writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].1, b"# hi\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_symlink_inside_the_workspace_that_points_outside_is_refused() {
    let fx = fixture();
    let outside = fx.base.join("outside.txt");
    std::fs::write(&outside, "secret").unwrap();
    std::os::unix::fs::symlink(&outside, fx.root.join("link.txt")).unwrap();
    let store = RecordingStore::default();
    let err = publish(&fx.root, &store, &file_publish("link.txt")).unwrap_err();
    assert_eq!(err.code, ErrorCode::ArtifactPathOutsideWorkspace);
    assert!(store.writes.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_symlink_inside_the_workspace_to_another_file_inside_is_published() {
    let fx = fixture();
    std::fs::write(fx.root.join("real.txt"), "inside").unwrap();
    std::os::unix::fs::symlink(fx.root.join("real.txt"), fx.root.join("alias.txt")).unwrap();
    let store = RecordingStore::default();
    publish(&fx.root, &store, &file_publish("alias.txt")).unwrap();
    assert_eq!(store.writes.lock().unwrap()[0].1, b"inside");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_path_and_a_directory_are_source_missing() {
    let fx = fixture();
    let store = RecordingStore::default();
    let missing = publish(&fx.root, &store, &file_publish("nope.txt")).unwrap_err();
    assert_eq!(missing.code, ErrorCode::ArtifactSourceMissing);
    let directory = publish(&fx.root, &store, &file_publish("sub")).unwrap_err();
    assert_eq!(directory.code, ErrorCode::ArtifactSourceMissing);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fifo_is_not_a_file_and_is_not_opened() {
    let fx = fixture();
    let fifo = fx.root.join("pipe");
    let status = Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("mkfifo runs");
    assert!(status.success());
    // Opening a fifo with no writer would block: the port must refuse it from its metadata alone.
    assert_eq!(WorldFs.read_file(&fifo, 1024), Err(FsFault::NotFile));
    let store = RecordingStore::default();
    let err = publish(&fx.root, &store, &file_publish("pipe")).unwrap_err();
    assert_eq!(err.code, ErrorCode::ArtifactSourceMissing);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_fs_port_bounds_reads_and_reports_each_fault() {
    let fx = fixture();
    std::fs::write(fx.root.join("big.txt"), vec![b'x'; 10]).unwrap();
    assert_eq!(
        WorldFs.read_file(&fx.root.join("big.txt"), 9),
        Err(FsFault::TooLarge)
    );
    assert_eq!(
        WorldFs
            .read_file(&fx.root.join("big.txt"), 10)
            .unwrap()
            .len(),
        10
    );
    assert_eq!(
        WorldFs.read_file(&fx.root.join("none"), 10),
        Err(FsFault::NotFound)
    );
    assert_eq!(WorldFs.read_file(&fx.root, 10), Err(FsFault::IsDirectory));
    assert_eq!(
        WorldFs.real_path(&fx.root.join("none")),
        Err(FsFault::NotFound)
    );
}

/// The store adapter writes through the kernel's artifact store and returns its URI.
#[derive(Default)]
struct KernelStore {
    refs: Mutex<Vec<(String, String, usize)>>,
}

#[async_trait::async_trait]
impl ArtifactStore for KernelStore {
    async fn put(
        &self,
        session: &SessionId,
        purpose: ArtifactPurpose,
        media_type: String,
        bytes: Vec<u8>,
    ) -> Result<ArtifactRef, StoreError> {
        assert_eq!(purpose, ArtifactPurpose::Deliverable);
        let id = ArtifactId::new(format!("tool-result-{}", bytes.len()));
        self.refs
            .lock()
            .unwrap()
            .push((media_type, session.as_str().to_owned(), bytes.len()));
        Ok(ArtifactRef {
            session: session.clone(),
            id,
            purpose,
            media_type: "text/markdown".to_owned(),
            size: bytes.len() as u64,
        })
    }

    async fn get(&self, _artifact: &ArtifactRef) -> Result<Vec<u8>, StoreError> {
        Err(StoreError::Unsupported {
            what: "artifact read in the world-port test store".to_owned(),
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_store_adapter_writes_through_the_kernel_store_and_returns_its_uri() {
    let fx = fixture();
    let kernel = Arc::new(KernelStore::default());
    let adapter = StoreAdapter::new(kernel.clone(), tokio::runtime::Handle::current());
    let write = StoreWrite {
        session_id: "parent",
        tool_call_id: "run-1:site@1",
        tool_name: "CreateWorkflow",
        retention: "project",
        content: rust_cli_workflow::artifact_publish::StoreContent::Text("hello"),
        content_type: "text/markdown",
        extension: Some("md"),
    };
    // The adapter blocks on the handle, so it runs on a worker thread.
    let receipt = blocking(move || adapter.write(&write)).await.unwrap();
    drop(fx);
    assert_eq!(receipt.bytes, 5);
    assert_eq!(receipt.uri, "zcode-artifact://parent/tool-result-5");
    assert_eq!(kernel.refs.lock().unwrap()[0].0, "text/markdown");
}

// ---- Node parity (W7-4 review): glob matching, VCS directories, grep globs, read decoding, run truncation. ----

#[tokio::test(flavor = "multi_thread")]
async fn glob_matches_the_basename_of_a_pattern_without_a_slash_as_node_does() {
    let fx = fixture();
    std::fs::write(fx.root.join("a.txt"), "a").unwrap();
    std::fs::write(fx.root.join("sub/b.txt"), "b").unwrap();
    let ports = fx.ports.clone();
    let any_depth = blocking(move || ports.glob("*.txt", 10)).await.unwrap();
    assert_eq!(
        any_depth.total, 2,
        "a bare *.txt matches the name at any depth"
    );
    let ports = fx.ports.clone();
    let scoped = blocking(move || ports.glob("sub/*.txt", 10)).await.unwrap();
    assert_eq!(
        scoped.total, 1,
        "a pattern with a slash matches the relative path only"
    );
    assert!(scoped.files[0].ends_with("sub/b.txt"));
}

#[tokio::test(flavor = "multi_thread")]
async fn glob_trims_the_pattern_and_refuses_an_empty_one() {
    let fx = fixture();
    std::fs::write(fx.root.join("a.txt"), "a").unwrap();
    let ports = fx.ports.clone();
    let trimmed = blocking(move || ports.glob("  *.txt \t", 10))
        .await
        .unwrap();
    assert_eq!(trimmed.total, 1);
    let ports = fx.ports.clone();
    let empty = blocking(move || ports.glob("   ", 10)).await;
    assert_eq!(empty.unwrap_err(), "Glob pattern must not be empty");
}

#[tokio::test(flavor = "multi_thread")]
async fn glob_keeps_hidden_files_and_skips_version_control_directories() {
    let fx = fixture();
    std::fs::create_dir_all(fx.root.join(".git")).unwrap();
    std::fs::write(fx.root.join(".git/config"), "x").unwrap();
    std::fs::write(fx.root.join(".hidden.txt"), "x").unwrap();
    std::fs::write(fx.root.join("a.txt"), "x").unwrap();
    let ports = fx.ports.clone();
    let hits = blocking(move || ports.glob("**/*", 10)).await.unwrap();
    assert_eq!(
        hits.total, 2,
        ".git contents are skipped; hidden files are kept"
    );
    assert!(hits.files.iter().all(|file| !file.contains("/.git/")));
}

#[tokio::test(flavor = "multi_thread")]
async fn grep_skips_version_control_directories() {
    let fx = fixture();
    std::fs::create_dir_all(fx.root.join(".git")).unwrap();
    std::fs::write(fx.root.join(".git/HEAD"), "needle\n").unwrap();
    std::fs::write(fx.root.join("a.txt"), "needle\n").unwrap();
    let ports = fx.ports.clone();
    let hits = blocking(move || ports.grep("needle", None, 10))
        .await
        .unwrap();
    assert_eq!(hits.entries.len(), 1);
    assert!(hits.entries[0].path.ends_with("a.txt"));
}

#[tokio::test(flavor = "multi_thread")]
async fn grep_splits_the_glob_on_whitespace_and_commas_as_node_does() {
    let fx = fixture();
    std::fs::write(fx.root.join("a.txt"), "needle\n").unwrap();
    std::fs::write(fx.root.join("b.md"), "needle\n").unwrap();
    std::fs::write(fx.root.join("c.rs"), "needle\n").unwrap();
    let ports = fx.ports.clone();
    let hits = blocking(move || ports.grep("needle", Some("*.txt *.md"), 10))
        .await
        .unwrap();
    assert_eq!(hits.entries.len(), 2);
    let ports = fx.ports.clone();
    let comma = blocking(move || ports.grep("needle", Some("*.rs,*.md"), 10))
        .await
        .unwrap();
    assert_eq!(comma.entries.len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn grep_line_text_has_no_line_ending() {
    let fx = fixture();
    std::fs::write(fx.root.join("crlf.txt"), "needle\r\nneedle").unwrap();
    let ports = fx.ports.clone();
    let hits = blocking(move || ports.grep("needle", None, 10))
        .await
        .unwrap();
    let texts: Vec<_> = hits
        .entries
        .iter()
        .map(|e| e.text.clone().unwrap())
        .collect();
    assert_eq!(texts, vec!["needle".to_owned(), "needle".to_owned()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn read_normalizes_crlf_to_lf() {
    let fx = fixture();
    let file = fx.root.join("crlf.txt");
    std::fs::write(&file, "a\r\nb\r\n").unwrap();
    let ports = fx.ports.clone();
    let text = blocking(move || ports.read_text(file.to_str().unwrap()))
        .await
        .unwrap();
    assert_eq!(text, "a\nb\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn read_keeps_a_utf8_byte_order_mark_as_node_does() {
    let fx = fixture();
    let file = fx.root.join("bom.txt");
    std::fs::write(&file, [0xEF, 0xBB, 0xBF, b'x']).unwrap();
    let ports = fx.ports.clone();
    let text = blocking(move || ports.read_text(file.to_str().unwrap()))
        .await
        .unwrap();
    assert_eq!(text, "\u{feff}x");
}

#[tokio::test(flavor = "multi_thread")]
async fn read_decodes_utf16le_with_a_byte_order_mark() {
    let fx = fixture();
    let file = fx.root.join("wide.txt");
    std::fs::write(&file, [0xFF, 0xFE, b'h', 0, b'i', 0]).unwrap();
    let ports = fx.ports.clone();
    let text = blocking(move || ports.read_text(file.to_str().unwrap()))
        .await
        .unwrap();
    assert_eq!(text, "\u{feff}hi");
}

#[tokio::test(flavor = "multi_thread")]
async fn read_refuses_binary_and_invalid_utf8() {
    let fx = fixture();
    let binary = fx.root.join("bin.dat");
    std::fs::write(&binary, [0x00, 0x01, 0x02]).unwrap();
    let invalid = fx.root.join("bad.txt");
    std::fs::write(&invalid, [0xC3, 0x28]).unwrap();
    let ports = fx.ports.clone();
    let bin_path = binary.to_str().unwrap().to_owned();
    let refused = blocking(move || ports.read_text(&bin_path)).await;
    assert!(
        refused
            .unwrap_err()
            .starts_with("Unsupported or binary text encoding")
    );
    let ports = fx.ports.clone();
    let bad_path = invalid.to_str().unwrap().to_owned();
    let refused = blocking(move || ports.read_text(&bad_path)).await;
    assert!(refused.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn discard_reports_truncated_only_when_output_was_dropped() {
    let fx = fixture();
    let ports = fx.ports.clone();
    let mut quiet = run_request(&fx.root, "/bin/sh", &["-c", "true"]);
    quiet.max_inline_bytes = 0;
    let outcome = blocking(move || ports.run(&quiet)).await.unwrap();
    assert!(!outcome.stdout.truncated, "no output, nothing dropped");
    let ports = fx.ports.clone();
    let mut noisy = run_request(&fx.root, "/bin/sh", &["-c", "printf x"]);
    noisy.max_inline_bytes = 0;
    let outcome = blocking(move || ports.run(&noisy)).await.unwrap();
    assert!(outcome.stdout.truncated);
    assert_eq!(outcome.stdout.bytes, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_ports_in_one_process_never_share_an_operation_or_task_id() {
    // Two instances share the scratch directory, so equal task ids would share output files.
    let fx = fixture();
    let second = WorldPorts::new(
        fx.ports.env(),
        fx.root.clone(),
        tokio::runtime::Handle::current(),
    );
    let (first_context, first_task) = fx.ports.operation();
    let (second_context, second_task) = second.operation();
    assert_ne!(first_task, second_task);
    assert_ne!(first_context.operation, second_context.operation);
}

#[test]
fn run_status_treats_a_missing_exit_code_as_a_failure() {
    use crate::world_ports::run_status;
    use rust_cli_kernel_api::env::Outcome;
    let (status, error) = run_status(Outcome::Completed, None, false, None);
    assert_eq!(status, RunStatus::Failed);
    assert!(error.is_some());
    assert_eq!(
        run_status(Outcome::Completed, Some(0), false, None).0,
        RunStatus::Completed
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_text_read_over_the_cap_is_refused() {
    let fx = fixture();
    let file = fx.root.join("big.txt");
    std::fs::write(&file, vec![b'x'; 11]).unwrap();
    let ports = fx.ports.clone();
    let path = file.to_str().unwrap().to_owned();
    let refused = blocking(move || ports.read_text_capped(&path, 10)).await;
    assert!(refused.unwrap_err().contains("over the 10-byte cap"));
    let ports = fx.ports.clone();
    let path = file.to_str().unwrap().to_owned();
    assert_eq!(
        blocking(move || ports.read_text_capped(&path, 11))
            .await
            .unwrap(),
        "x".repeat(11)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_path_to_a_fifo_is_refused_without_blocking_the_read() {
    let fx = fixture();
    let fifo = fx.root.join("pipe-read");
    let status = Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("mkfifo runs");
    assert!(status.success());
    // A blocking open of a fifo with no writer never returns; the bounded open must answer at once.
    let path = fifo.clone();
    let answer = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        blocking(move || WorldFs.read_file(&path, 1024)),
    )
    .await
    .expect("the read does not block on a fifo");
    assert_eq!(answer, Err(FsFault::NotFile));
}
