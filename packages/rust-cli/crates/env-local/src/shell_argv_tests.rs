//! argv mode (W7-4; Node `executionPort.run` with `command.mode: "argv"`): the program runs without a shell, its
//! arguments arrive unexpanded, and stderr is its own stream. Needs `/bin/sh` and `/bin/echo`; Unix only.
#![cfg(unix)]

use futures_util::StreamExt;
use rust_cli_kernel_api::env::{CommandEvent, CommandKind, EnvError, EnvPath, OutputStream};
use rust_cli_kernel_api::env_shell::CwdScope;
use rust_cli_kernel_api::ids::ShellTaskId;
use std::sync::atomic::{AtomicU64, Ordering};

use super::tests::{context, fixture};
use super::*;

static NEXT_ARGV_TASK: AtomicU64 = AtomicU64::new(1);
type CommandEvents = futures_util::stream::BoxStream<'static, Result<CommandEvent, EnvError>>;

fn argv_request(file: &str, args: &[&str], root: &std::path::Path) -> StartCommand {
    let task = ShellTaskId::new(format!(
        "a{}",
        NEXT_ARGV_TASK.fetch_add(1, Ordering::Relaxed)
    ));
    StartCommand::argv(
        file,
        args.iter().map(|arg| (*arg).to_owned()).collect(),
        EnvPath::new(root.to_string_lossy()),
        task,
    )
}

/// Reads the whole stream, keeping each stream's bytes apart, and returns the terminal event.
async fn collect_streams(mut events: CommandEvents) -> (Vec<u8>, Vec<u8>, CommandEvent) {
    assert!(matches!(
        events.next().await,
        Some(Ok(CommandEvent::Started { .. }))
    ));
    let (mut out, mut err) = (Vec::new(), Vec::new());
    while let Some(event) = events.next().await {
        match event.unwrap() {
            CommandEvent::Output { stream, data, .. } => match stream {
                OutputStream::Stdout => out.extend(data),
                OutputStream::Stderr => err.extend(data),
            },
            finished @ CommandEvent::Finished { .. } => return (out, err, finished),
            other => panic!("unexpected event {other:?}"),
        }
    }
    panic!("no terminal event");
}

#[tokio::test]
async fn arguments_are_passed_through_without_a_shell() {
    let fixture = fixture(Vec::new());
    let request = argv_request(
        "/bin/echo",
        &["a b", "$HOME", ";echo x", "*", "`id`"],
        &fixture.root,
    );
    let events = fixture
        .shells
        .start(context("argv-literal"), request)
        .await
        .unwrap();
    let (out, err, finished) = collect_streams(events).await;
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "a b $HOME ;echo x * `id`\n"
    );
    assert!(err.is_empty());
    assert!(matches!(
        finished,
        CommandEvent::Finished {
            exit_code: Some(0),
            ..
        }
    ));
}

#[tokio::test]
async fn stderr_is_a_separate_stream() {
    let fixture = fixture(Vec::new());
    let request = argv_request("/bin/sh", &["-c", "echo out; echo err >&2"], &fixture.root);
    let events = fixture
        .shells
        .start(context("argv-streams"), request)
        .await
        .unwrap();
    let (out, err, _) = collect_streams(events).await;
    assert_eq!(String::from_utf8(out).unwrap(), "out\n");
    assert_eq!(String::from_utf8(err).unwrap(), "err\n");
}

#[tokio::test]
async fn a_nonzero_exit_is_a_finished_event_with_its_code() {
    let fixture = fixture(Vec::new());
    let request = argv_request("/bin/sh", &["-c", "exit 3"], &fixture.root);
    let events = fixture
        .shells
        .start(context("argv-exit"), request)
        .await
        .unwrap();
    let (_, _, finished) = collect_streams(events).await;
    assert!(matches!(
        finished,
        CommandEvent::Finished {
            exit_code: Some(3),
            ..
        }
    ));
}

#[tokio::test]
async fn a_program_that_is_not_on_path_does_not_start() {
    let fixture = fixture(Vec::new());
    let request = argv_request("no-such-program-w7-4", &[], &fixture.root);
    let started = fixture.shells.start(context("argv-missing"), request).await;
    assert!(
        matches!(started, Err(EnvError::Io { .. })),
        "a missing program is a spawn failure, not a finished command"
    );
}

#[tokio::test]
async fn argv_outside_a_pinned_unsandboxed_foreground_command_is_refused() {
    let fixture = fixture(Vec::new());
    let mut request = argv_request("/bin/echo", &["x"], &fixture.root);
    request.cwd_scope = CwdScope::Session {
        roots: vec![EnvPath::new(fixture.root.to_string_lossy())],
    };
    let refused = fixture.shells.start(context("argv-scope"), request).await;
    assert!(matches!(refused, Err(EnvError::Unsupported { .. })));
}

#[test]
fn a_shell_request_serializes_without_an_argv_key() {
    let task = ShellTaskId::new("s1");
    let shell = StartCommand::new("echo hi", EnvPath::new("/w"), task.clone());
    let json = serde_json::to_value(&shell).unwrap();
    assert!(json.get("argv").is_none());
    let argv = StartCommand::argv("git", vec!["status".to_owned()], EnvPath::new("/w"), task);
    assert!(matches!(
        argv.kind,
        CommandKind::Foreground { on_timeout: None }
    ));
    let json = serde_json::to_value(&argv).unwrap();
    assert_eq!(json["argv"]["file"], "git");
    assert_eq!(json["argv"]["args"][0], "status");
}

#[tokio::test]
async fn argv_refuses_a_sandbox_and_every_kind_but_a_plain_foreground_command() {
    use rust_cli_kernel_api::env::CommandKind;
    use rust_cli_kernel_api::env_shell::{FilesystemPolicy, HookIo, NetworkPolicy, SandboxPolicy};
    let fixture = fixture(Vec::new());
    let mut sandboxed = argv_request("/bin/echo", &["x"], &fixture.root);
    sandboxed.sandbox = Some(SandboxPolicy {
        filesystem: FilesystemPolicy::default(),
        network: NetworkPolicy::default(),
        required: false,
    });
    let refused = fixture
        .shells
        .start(context("argv-sandbox"), sandboxed)
        .await;
    assert!(matches!(refused, Err(EnvError::Unsupported { .. })));

    let mut hook = argv_request("/bin/echo", &["x"], &fixture.root);
    hook.kind = CommandKind::Hook {
        hook: HookIo {
            stdin: String::new(),
            env: Default::default(),
        },
    };
    let refused = fixture.shells.start(context("argv-hook"), hook).await;
    assert!(matches!(refused, Err(EnvError::Unsupported { .. })));
}

#[tokio::test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test prepares a scratch and workspace directory"
)]
async fn argv_without_a_configured_shell_inherits_the_snapshot_shell() {
    // With no bash configured, argv must not write an empty SHELL: the child keeps the snapshot's value (F58).
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().to_path_buf();
    let root = base.join("work");
    std::fs::create_dir_all(&root).unwrap();
    let path = std::env::var("PATH").unwrap_or_default();
    let shells = Shells::new(ShellConfig {
        scratch: base.join("scratch"),
        ledger: base.join("ledger"),
        bash: None,
        bwrap: None,
        embedded: None,
        env: vec![
            ("PATH".to_owned(), path),
            ("SHELL".to_owned(), "/bin/zsh".to_owned()),
        ]
        .into(),
    });
    let request = argv_request("/bin/sh", &["-c", "printf %s \"$SHELL\""], &root);
    let events = shells.start(context("argv-shell"), request).await.unwrap();
    let (out, _, _) = collect_streams(events).await;
    assert_eq!(String::from_utf8(out).unwrap(), "/bin/zsh");
}
