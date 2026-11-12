//! Fork (node_desktop): the desktop output layout — `<root>/<session>/<task>-stdout.log` (the
//! task id is the model's tool-call id there), merged streams in write order, Node's retention
//! (small foreground files deleted after the settlement read, larger ones and background files
//! kept without the terminal line), and the errno-named open failure (`EISDIR`).
#![cfg(unix)]
#![allow(
    clippy::disallowed_methods,
    reason = "tests prepare and inspect output files synchronously"
)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use rust_cli_kernel_api::env::{
    CommandEvent, CommandKind, EnvError, EnvPath, Outcome, StartCommand,
};
use rust_cli_kernel_api::env_shell::{BackgroundCommand, CwdScope};
use rust_cli_kernel_api::ids::{SessionId, ShellTaskId};
use rust_cli_kernel_api::machine::CommandEvents;

use super::tests::context;
use super::*;

/// A fixture with the private scratch and the desktop output root configured.
struct Desktop {
    _dir: tempfile::TempDir,
    base: PathBuf,
    shells: Shells,
}

impl Desktop {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(base.join("work")).unwrap();
        let mut shells = Shells::new(ShellConfig {
            scratch: base.join("scratch"),
            ledger: base.join("ledger"),
            bash: Some(PathBuf::from("/bin/bash")),
            bwrap: None,
            embedded: None,
            env: vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())].into(),
        });
        shells.set_bash_outputs(Some(base.join("bash-root")));
        Self {
            _dir: dir,
            base,
            shells,
        }
    }

    fn root(&self) -> PathBuf {
        self.base.join("bash-root")
    }

    fn work(&self) -> EnvPath {
        EnvPath::new(self.base.join("work").to_string_lossy())
    }

    /// The session's directory under the desktop root (`sanitize("s1") == "s1"`).
    fn session_dir(&self) -> PathBuf {
        self.root().join("s1")
    }

    fn link(&self, task: &str) -> PathBuf {
        self.base
            .join("scratch")
            .join("s1")
            .join("tasks")
            .join(format!("{task}.output"))
    }
}

fn request(desktop: &Desktop, command: &str, task: &str) -> StartCommand {
    StartCommand {
        timeout_ms: Some(10_000),
        cwd_scope: CwdScope::Pinned,
        ..StartCommand::new(command.to_owned(), desktop.work(), ShellTaskId::new(task))
    }
}

/// Read the stream to the end: the `Started` output path, the merged output and the terminal
/// event.
async fn read_all(events: CommandEvents) -> (String, Vec<u8>, CommandEvent) {
    let mut events = events;
    let mut output = Vec::new();
    let mut started = String::new();
    while let Some(event) = events.next().await {
        match event.unwrap() {
            CommandEvent::Started { output } => started = output.as_str().to_owned(),
            CommandEvent::Output { data, .. } => output.extend(data),
            finished @ CommandEvent::Finished { .. } => return (started, output, finished),
            CommandEvent::Backgrounded | CommandEvent::BackgroundedBy { .. } => {}
        }
    }
    panic!("no terminal event");
}

async fn run(
    desktop: &Desktop,
    operation: &str,
    start: StartCommand,
) -> (String, Vec<u8>, CommandEvent) {
    let events = desktop
        .shells
        .start(context(operation), start)
        .await
        .unwrap();
    read_all(events).await
}

/// The desktop layout: `<root>/<session>/<toolCallId>-stdout.log`, 0600 inside a private 0700
/// root, with stdout and stderr merged in write order.
#[tokio::test]
async fn desktop_commands_write_the_node_layout_with_merged_streams() {
    let desktop = Desktop::new();
    let (started, output, _) = run(
        &desktop,
        "op1",
        request(&desktop, "printf A; printf B >&2", "toolu_bdo_small"),
    )
    .await;
    assert_eq!(output, b"AB".to_vec());
    let file = desktop.session_dir().join("toolu_bdo_small-stdout.log");
    assert_eq!(
        started,
        file.to_string_lossy().into_owned(),
        "the Started event names the desktop layout path"
    );
    use std::os::unix::fs::PermissionsExt;
    let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&desktop.root()), 0o700);
    // Node deletes a foreground file that fit inline, together with the compatibility link.
    assert!(!file.exists());
    assert!(!desktop.link("toolu_bdo_small").exists());
}

/// A foreground output past the inline cap is kept (the tool result names the path) and the
/// scratch link keeps resolving the task name.
#[tokio::test]
async fn a_large_foreground_output_is_kept_with_its_link() {
    let desktop = Desktop::new();
    let (_, output, _) = run(
        &desktop,
        "op1",
        request(
            &desktop,
            "printf HEAD; head -c 30010 /dev/zero | tr '\\0' x; printf TAIL",
            "toolu_bdo_large",
        ),
    )
    .await;
    assert_eq!(output.len(), 4 + 30_010 + 4);
    let file = desktop.session_dir().join("toolu_bdo_large-stdout.log");
    let kept = std::fs::read(&file).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(kept.len(), output.len());
    assert!(kept.starts_with(b"HEAD"));
    assert!(kept.ends_with(b"TAIL"));
    let link = desktop.link("toolu_bdo_large");
    assert!(link.symlink_metadata().is_ok());
    assert_eq!(std::fs::read(&link).unwrap(), kept);
}

/// A background command keeps its file and, unlike the CLI layout, no terminal line is appended
/// (the desktop reads the merged file exactly as the child wrote it).
#[tokio::test]
async fn background_commands_keep_the_exact_file_without_a_terminal_line() {
    let desktop = Desktop::new();
    let start = StartCommand {
        kind: CommandKind::Background {
            background: BackgroundCommand {
                description: "wait".to_owned(),
                tool_use: None,
                kind: Default::default(),
            },
        },
        ..request(&desktop, "printf BG", "toolu_bdo_background")
    };
    let (_, output, finished) = run(&desktop, "op1", start).await;
    assert_eq!(output, b"BG".to_vec());
    assert!(matches!(
        finished,
        CommandEvent::Finished {
            outcome: Outcome::Completed,
            exit_code: Some(0),
            ..
        }
    ));
    let file = desktop
        .session_dir()
        .join("toolu_bdo_background-stdout.log");
    assert_eq!(std::fs::read(&file).unwrap(), b"BG".to_vec());
}

/// Opening the output file fails with the errno name in the message (`EISDIR` when the path is
/// a directory), and the next command still runs.
#[tokio::test]
async fn an_open_failure_reports_the_errno_name_and_the_next_command_runs() {
    let desktop = Desktop::new();
    std::fs::create_dir_all(desktop.session_dir().join("toolu_open-stdout.log")).unwrap();
    let Err(error) = desktop
        .shells
        .start(context("op1"), request(&desktop, "echo hi", "toolu_open"))
        .await
    else {
        panic!("opening a directory as the output file must fail");
    };
    match &error {
        EnvError::Io { message } => assert!(message.contains("EISDIR"), "{message}"),
        other => panic!("unexpected error {other:?}"),
    }
    let (_, output, _) = run(
        &desktop,
        "op2",
        request(&desktop, "printf A; printf B >&2", "toolu_bdo_small"),
    )
    .await;
    assert_eq!(output, b"AB".to_vec());
}

/// Node's `sanitizePathSegment`: safe characters pass through, anything else becomes `_`, the
/// result is capped at 120 characters, and an empty result becomes `unknown`.
#[test]
fn path_segments_match_nodes_sanitizer() {
    assert_eq!(path_segment("s1"), "s1");
    assert_eq!(path_segment("a.b-c_d"), "a.b-c_d");
    assert_eq!(path_segment("中文 id:1"), "___id_1");
    assert_eq!(path_segment(&"a".repeat(200)), "a".repeat(120));
    assert_eq!(path_segment(""), "unknown");
    assert_eq!(path_segment("/:*?"), "____");
}

/// 64 KiB，每 20 ms 查一次（同 shell_limit_tests.rs 的 SMALL；生产是 5 GB / 5 s）。
const SMALL: OutputLimit = OutputLimit {
    bytes: 64 * 1024,
    label: "64KB",
    every: Duration::from_millis(20),
};

/// 写正好比上限多 1 字节后停住等被结束：终态的文件大小因此是确定的（LIMIT+1）。
const JUST_PAST: &str = "head -c 65537 /dev/zero | tr '\\0' x; sleep 5";

fn finished_parts(event: CommandEvent) -> (Outcome, Option<String>) {
    let CommandEvent::Finished {
        outcome,
        output_limit,
        ..
    } = event
    else {
        panic!("not finished");
    };
    (outcome, output_limit)
}

/// 前台超限被结束：说明文字带 Node 的写法，输出文件与兼容链接都删掉。
#[tokio::test]
async fn a_desktop_foreground_command_past_the_limit_is_killed_and_cleaned_up() {
    let mut desktop = Desktop::new();
    desktop.shells.set_output_limit(SMALL);
    let (_, _, finished) = run(
        &desktop,
        "op1",
        request(&desktop, JUST_PAST, "toolu_bdo_limit_fg"),
    )
    .await;
    let (outcome, note) = finished_parts(finished);
    assert_eq!(outcome, Outcome::Cancelled);
    assert_eq!(
        note.as_deref(),
        Some("Command killed: output file exceeded 64KB")
    );
    assert!(
        !desktop
            .session_dir()
            .join("toolu_bdo_limit_fg-stdout.log")
            .exists()
    );
    assert!(!desktop.link("toolu_bdo_limit_fg").exists());
}

/// 后台超限被结束：文件按原样保留（正好 LIMIT+1 字节，没有 CLI 布局的 `[killed]` 尾行），通知按
/// killed 交出去。
#[tokio::test]
async fn a_desktop_background_command_past_the_limit_keeps_the_exact_file() {
    let mut desktop = Desktop::new();
    desktop.shells.set_output_limit(SMALL);
    let start = StartCommand {
        kind: CommandKind::Background {
            background: BackgroundCommand {
                description: "Flood".to_owned(),
                tool_use: None,
                kind: Default::default(),
            },
        },
        ..request(&desktop, JUST_PAST, "toolu_bdo_limit_bg")
    };
    let _ = desktop.shells.start(context("op1"), start).await.unwrap();
    let notice = desktop
        .shells
        .notices(&SessionId::new("s1"), 0)
        .next()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (notice.outcome, notice.exit_code),
        (Outcome::Cancelled, Some(137))
    );
    let file = desktop.session_dir().join("toolu_bdo_limit_bg-stdout.log");
    let kept = std::fs::read(&file).unwrap();
    assert_eq!(kept.len(), SMALL.bytes as usize + 1);
    assert!(kept.iter().all(|byte| *byte == b'x'));
    // The compatibility link still resolves the task name for TaskOutput.
    assert_eq!(
        std::fs::read(desktop.link("toolu_bdo_limit_bg")).unwrap(),
        kept
    );
}

/// A foreground command that deletes its own output file before exiting: the settlement read
/// fails, so the terminal event carries the OS code even though nothing was streamed (Node's
/// `<bash output unavailable ...>`).
#[tokio::test]
async fn a_deleted_foreground_output_reports_the_read_failure_code() {
    let desktop = Desktop::new();
    let file = desktop.session_dir().join("del1-stdout.log");
    let command = format!("rm -f '{}'", file.display());
    let (_, output, finished) = run(&desktop, "op-del", request(&desktop, &command, "del1")).await;
    assert!(output.is_empty());
    let CommandEvent::Finished {
        output_unreadable, ..
    } = finished
    else {
        unreachable!()
    };
    assert_eq!(output_unreadable.as_deref(), Some("ENOENT"));
}

/// A normal foreground command reads its file back: no read failure is reported.
#[tokio::test]
async fn a_readable_foreground_output_reports_no_read_failure() {
    let desktop = Desktop::new();
    let (_, _, finished) = run(&desktop, "op-ok", request(&desktop, "echo hi", "ok1")).await;
    let CommandEvent::Finished {
        output_unreadable, ..
    } = finished
    else {
        unreachable!()
    };
    assert_eq!(output_unreadable, None);
}
