//! 登记只放还在跑的命令（工作线 F119，docs/specs/rust-cli/shell-permissions.md §2.1）：结束的命令不留登记，已经拿到流的
//! 一方照常读完。以前每条命令（Bash、hook、Monitor）按 operationId 一直留着，远端跑了 23 小时的 TUI 留着约 2 万条。
//! 需要 `/bin/bash`，Windows 上跳过。
#![cfg(unix)]

use futures_util::StreamExt;
use rust_cli_kernel_api::env::CommandKind;
use rust_cli_kernel_api::env_shell::{
    BackgroundCommand, BackgroundInfo, BackgroundStatus, BackgroundStop, BackgroundTask, CwdScope,
};
use rust_cli_kernel_api::ids::{OperationId, SessionId};

use super::tests::{collect, context, fixture, request};

#[tokio::test]
async fn finished_commands_leave_no_registration() {
    let fixture = fixture(Vec::new());
    for n in 0..20 {
        let operation = format!("op_registry_{n}");
        let events = fixture
            .shells
            .start(
                context(&operation),
                request("true", &fixture.root, CwdScope::Pinned),
            )
            .await
            .unwrap();
        collect(events).await;
    }
    assert_eq!(fixture.shells.shared.state().commands.len(), 0);
    // 结束的命令不能再按 ID 接回。
    assert!(
        fixture
            .shells
            .watch(&OperationId::new("op_registry_0"), 0)
            .is_none()
    );
}

/// 结束、通知还没 ack 的后台命令：登记已删，TaskStop 仍查得到命令原文与终态（原文跟通知一起记着）；ack 之后查不到。
#[tokio::test]
async fn a_finished_background_command_is_found_until_its_notice_is_acked() {
    let fixture = fixture(Vec::new());
    let mut start = request("echo done", &fixture.root, CwdScope::Pinned);
    start.kind = CommandKind::Background {
        background: BackgroundCommand {
            description: "Done".to_owned(),
            tool_use: None,
            kind: Default::default(),
        },
    };
    let key = BackgroundTask {
        session: SessionId::new("s1"),
        task: start.task.clone(),
        notify_stop: false,
    };
    let events = fixture.shells.start(context("op_bg"), start).await.unwrap();
    collect(events).await;
    let notice = fixture
        .shells
        .notices(&SessionId::new("s1"), 0)
        .next()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fixture.shells.shared.state().commands.len(), 0);
    let found = fixture.shells.background_command(&key);
    assert!(
        matches!(
            &found,
            Some(BackgroundInfo { command, status: BackgroundStatus::Completed, .. }) if command == "echo done"
        ),
        "{found:?}"
    );
    // Fork: the ended command still names the file it wrote.
    assert_eq!(
        found.and_then(|info| info.output),
        Some(notice.output.clone())
    );
    assert!(matches!(
        fixture.shells.stop(&key),
        BackgroundStop::NotRunning {
            status: BackgroundStatus::Completed
        }
    ));
    fixture.shells.ack(&SessionId::new("s1"), notice.seq);
    assert!(fixture.shells.background_command(&key).is_none());
    assert!(matches!(
        fixture.shells.stop(&key),
        BackgroundStop::NotFound
    ));
}

/// Fork (node_desktop): a stop with `notify_stop` still records the command's notice, which reads killed, so the
/// parent wakes like Node's `<status>killed</status>` task notification.
#[tokio::test]
async fn a_stop_that_notifies_records_a_killed_notice() {
    let fixture = fixture(Vec::new());
    let mut start = request("sleep 30", &fixture.root, CwdScope::Pinned);
    start.kind = CommandKind::Background {
        background: BackgroundCommand {
            description: "Sleep".to_owned(),
            tool_use: None,
            kind: Default::default(),
        },
    };
    let key = BackgroundTask {
        session: SessionId::new("s1"),
        task: start.task.clone(),
        notify_stop: true,
    };
    let events = fixture
        .shells
        .start(context("op_bg_stop"), start)
        .await
        .unwrap();
    assert!(matches!(
        fixture.shells.stop(&key),
        BackgroundStop::Stopped { .. }
    ));
    collect(events).await;
    let notice = fixture
        .shells
        .notices(&SessionId::new("s1"), 0)
        .next()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(notice.task, key.task);
    assert_eq!(
        BackgroundStatus::ended(&notice.outcome, notice.exit_code),
        BackgroundStatus::Killed
    );
}

/// Fork (node_desktop): between TaskStop and the process exit the command has left `background` and recorded no notice
/// yet; the ledger reads it `killed` meanwhile (Node's `killTask` marks it killed at once), not unknown. The detail pane
/// polls this and otherwise stops on "not found" with the status stuck on running. After the exit it is gone (the stop
/// did not ask for a notice). The output path is the file the command writes, like Node's.
#[tokio::test]
async fn a_stopped_command_reads_killed_until_it_exits() {
    let fixture = fixture(Vec::new());
    let mut start = request("sleep 30", &fixture.root, CwdScope::Pinned);
    start.kind = CommandKind::Background {
        background: BackgroundCommand {
            description: "Sleep".to_owned(),
            tool_use: None,
            kind: Default::default(),
        },
    };
    let key = BackgroundTask {
        session: SessionId::new("s1"),
        task: start.task.clone(),
        notify_stop: false,
    };
    let events = fixture
        .shells
        .start(context("op_bg_stopping"), start)
        .await
        .unwrap();
    let running = fixture.shells.background_command(&key).unwrap();
    assert_eq!(running.status, BackgroundStatus::Running);
    let output = running
        .output
        .clone()
        .expect("a local command reports its output file");
    let written = fixture
        .shells
        .shared
        .state()
        .commands
        .values()
        .map(|running| running.output.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(written, [output.as_str()]);
    assert!(matches!(
        fixture.shells.stop(&key),
        BackgroundStop::Stopped { .. }
    ));
    // The current-thread runtime cannot run the exit supervision between these calls.
    let stopping = fixture.shells.background_command(&key).unwrap();
    assert_eq!(stopping.status, BackgroundStatus::Killed);
    assert_eq!(stopping.output, Some(output));
    assert!(matches!(
        fixture.shells.stop(&key),
        BackgroundStop::NotRunning {
            status: BackgroundStatus::Killed
        }
    ));
    collect(events).await;
    assert!(fixture.shells.background_command(&key).is_none());
    assert!(
        fixture.shells.shared.state().sessions[&key.session]
            .stopping
            .is_empty()
    );
}

/// Fork: a finished command's terminal record outlives its notice's ack (`ended_background_command`), so the desktop
/// detail pane reads its status whichever subscriber acknowledged the notice. `background_command`, `stop` and
/// `shell_state.background` still forget it at the ack: their callers read a record as "the notice is pending".
#[tokio::test]
async fn an_acked_command_keeps_its_terminal_record() {
    let fixture = fixture(Vec::new());
    let mut start = request("echo done", &fixture.root, CwdScope::Pinned);
    start.kind = CommandKind::Background {
        background: BackgroundCommand {
            description: "Done".to_owned(),
            tool_use: None,
            kind: Default::default(),
        },
    };
    let session = SessionId::new("s1");
    let key = BackgroundTask {
        session: session.clone(),
        task: start.task.clone(),
        notify_stop: false,
    };
    let events = fixture
        .shells
        .start(context("op_bg_ended"), start)
        .await
        .unwrap();
    collect(events).await;
    let notice = fixture
        .shells
        .notices(&session, 0)
        .next()
        .await
        .unwrap()
        .unwrap();
    fixture.shells.ack(&session, notice.seq);

    let ended = fixture
        .shells
        .ended_command(&key)
        .expect("kept after the ack");
    assert_eq!(ended.status, BackgroundStatus::Completed);
    assert_eq!(ended.command, "echo done");
    assert_eq!(ended.description, "Done");
    assert_eq!(ended.output, Some(notice.output));
    assert!(fixture.shells.background_command(&key).is_none());
    assert!(matches!(
        fixture.shells.stop(&key),
        BackgroundStop::NotFound
    ));
    let workspace = rust_cli_kernel_api::env::WorkspaceRef {
        environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
        root: rust_cli_kernel_api::env::EnvPath::new(fixture.root.to_string_lossy()),
    };
    assert!(
        fixture
            .shells
            .shell_state(&workspace, &session)
            .background
            .is_empty()
    );
    // Another session never reads it.
    let other = BackgroundTask {
        session: SessionId::new("s2"),
        ..key
    };
    assert!(fixture.shells.ended_command(&other).is_none());
}

/// Fork: a TaskStop that asks for no notice records none, but the command's terminal record still reads `killed`
/// after the exit (before, the detail pane read it unknown once the process exited).
#[tokio::test]
async fn a_silently_stopped_command_keeps_a_killed_record() {
    let fixture = fixture(Vec::new());
    let mut start = request("sleep 30", &fixture.root, CwdScope::Pinned);
    start.kind = CommandKind::Background {
        background: BackgroundCommand {
            description: "Sleep".to_owned(),
            tool_use: None,
            kind: Default::default(),
        },
    };
    let key = BackgroundTask {
        session: SessionId::new("s1"),
        task: start.task.clone(),
        notify_stop: false,
    };
    let events = fixture
        .shells
        .start(context("op_bg_silent_stop"), start)
        .await
        .unwrap();
    assert!(matches!(
        fixture.shells.stop(&key),
        BackgroundStop::Stopped { .. }
    ));
    collect(events).await;
    assert!(fixture.shells.background_command(&key).is_none());
    let ended = fixture
        .shells
        .ended_command(&key)
        .expect("kept after the exit");
    assert_eq!(ended.status, BackgroundStatus::Killed);
}

/// Fork: a session keeps the records of its newest `ENDED_KEPT` ended commands; a task recorded again moves to the end.
#[test]
fn ended_records_are_bounded_per_session() {
    use rust_cli_kernel_api::env::EnvPath;
    use rust_cli_kernel_api::ids::ShellTaskId;

    use crate::shell::{ENDED_KEPT, SessionShell};

    let background = BackgroundCommand {
        description: String::new(),
        tool_use: None,
        kind: Default::default(),
    };
    let mut shell = SessionShell::default();
    for n in 0..=ENDED_KEPT {
        shell.record_ended(
            &ShellTaskId::new(format!("t{n}")),
            "true",
            &background,
            EnvPath::new(format!("/out/t{n}")),
            BackgroundStatus::Completed,
        );
    }
    assert_eq!(shell.ended.len(), ENDED_KEPT);
    assert_eq!(shell.ended.front().unwrap().0, ShellTaskId::new("t1"));
    shell.record_ended(
        &ShellTaskId::new("t1"),
        "false",
        &background,
        EnvPath::new("/out/t1"),
        BackgroundStatus::Failed,
    );
    assert_eq!(shell.ended.len(), ENDED_KEPT);
    let (task, info) = shell.ended.back().unwrap();
    assert_eq!(task, &ShellTaskId::new("t1"));
    assert_eq!(info.status, BackgroundStatus::Failed);
}

/// Fork: a TaskStop accepted after the supervisor saw the process exit with code 0, but before it finalized the exit,
/// wins (Node's `killTask` marks the task killed at once and for good). The ledger reported `killed` from the stop on;
/// the finalized outcome must not turn the terminal record, the notice or the receipt back into `completed`. The
/// interleaving is decided under the ledger lock, so it is reproduced here on the session's ledger directly.
#[test]
fn a_stop_accepted_before_the_exit_is_finalized_wins() {
    use rust_cli_kernel_api::env::Outcome;
    use rust_cli_kernel_api::ids::ShellTaskId;

    use crate::shell::{Finish, SessionShell};

    let exited = || Finish {
        outcome: Outcome::Completed,
        exit_code: Some(0),
        timed_out: false,
        cwd_reset: None,
        output_bytes: 3,
        output_limit: None,
        output_unreadable: None,
        discard: Vec::new(),
    };
    let task = ShellTaskId::new("b1");
    let killed_exit = Some(137);

    // No stop: the process's own outcome stands.
    let shell = SessionShell::default();
    let mut finish = exited();
    shell.settle_stop(&task, &mut finish, killed_exit);
    assert_eq!(finish, exited());
    assert_eq!(
        BackgroundStatus::ended(&finish.outcome, finish.exit_code),
        BackgroundStatus::Completed
    );

    // A stop that notifies: `stop` moved the task from `background` to `stopping` after the exit was seen.
    let mut shell = SessionShell::default();
    shell
        .stopping
        .insert(task.clone(), OperationId::new("op_b1"));
    let mut finish = exited();
    shell.settle_stop(&task, &mut finish, killed_exit);
    assert_eq!(finish.outcome, Outcome::Cancelled);
    assert_eq!(finish.exit_code, killed_exit);
    assert_eq!(finish.output_bytes, 3);
    assert_eq!(
        BackgroundStatus::ended(&finish.outcome, finish.exit_code),
        BackgroundStatus::Killed
    );

    // A silent stop (`stopped` as well): killed too; its notice is suppressed by the caller.
    shell.stopped.insert(task.clone());
    let mut finish = exited();
    shell.settle_stop(&task, &mut finish, None);
    assert_eq!(
        (finish.outcome, finish.exit_code),
        (Outcome::Cancelled, None)
    );

    // Another task of the session is not affected.
    let mut finish = exited();
    shell.settle_stop(&ShellTaskId::new("b2"), &mut finish, killed_exit);
    assert_eq!(finish, exited());
}
