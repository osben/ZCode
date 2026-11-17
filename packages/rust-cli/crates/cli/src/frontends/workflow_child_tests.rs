//! The sandbox child's process: a launch failure names the entry file, and dropping the launched child ends its tree
//! and clears its ledger record (specs/fork-rust-workflow-engine.md, 4.1). Mirrors `node_helper_tests.rs`.

use std::path::Path;

use rust_cli_protocol_zcode::ChildLauncher;

use super::*;

#[tokio::test]
async fn a_launch_failure_names_the_entry_file_and_not_its_directory() {
    let temp = tempfile::tempdir().expect("temp dir");
    let scope = rust_cli_base::TaskScope::root("workflow-child-launch-test", |_| {});
    let launcher = ProcessChildLauncher::new(
        ChildCommand {
            program: "/no/such/dir/zcode-helper-missing".to_owned(),
            env: Vec::new(),
        },
        Ledger::open(temp.path().join("ledger")),
        scope.spawner(),
    );
    let Err(error) = launcher
        .launch(Path::new("/work/.zcode/workflow-runs/run-9.mjs"))
        .await
    else {
        panic!("a missing program cannot start");
    };
    let message = error.to_string();
    assert!(message.contains("run-9.mjs"), "{message}");
    // Only the file name: a directory can hold the user's name.
    assert!(!message.contains("/work/.zcode"), "{message}");
}

#[cfg(unix)]
#[expect(
    clippy::disallowed_methods,
    reason = "the test inspects the ledger directory itself"
)]
fn has_entries(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_some())
}

/// Whether `pid` is a live process. `kill(pid, 0)` also succeeds for a zombie (exited, not yet reaped), so a zombie
/// counts as dead: the grandchild is reparented, and its exit is only reaped by whoever inherits it.
#[cfg(unix)]
fn alive(pid: libc::pid_t) -> bool {
    // SAFETY: kill with signal 0 delivers nothing; it only checks that the process exists.
    #[expect(unsafe_code, reason = "kill(2) is libc FFI")]
    let found = unsafe { libc::kill(pid, 0) } == 0;
    found && !zombie(pid)
}

#[cfg(unix)]
fn zombie(pid: libc::pid_t) -> bool {
    rust_cli_proc::std_command("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .output()
        .is_ok_and(|output| {
            String::from_utf8_lossy(&output.stdout)
                .trim_start()
                .starts_with('Z')
        })
}

/// A stand-in child: it ignores its arguments, starts a grandchild, prints its pid and waits.
#[cfg(unix)]
async fn stand_in_child(dir: &Path) -> std::path::PathBuf {
    let path = dir.join("stand-in-child.sh");
    rust_cli_fs::atomic_write(
        &path,
        b"#!/bin/sh\nsleep 30 & echo $!\nwait\n",
        rust_cli_fs::WriteOptions {
            mode: rust_cli_fs::FileMode::Executable,
            temp_name: rust_cli_fs::TempName::Visible,
            parent: rust_cli_fs::ParentDir::Create,
            rename_retry: &[],
        },
    )
    .await
    .expect("the stand-in child is written");
    path
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_the_launched_child_kills_its_whole_tree_and_clears_its_record() {
    use tokio::io::AsyncBufReadExt;

    let temp = tempfile::tempdir().expect("temp dir");
    let scope = rust_cli_base::TaskScope::root("workflow-child-tree-test", |_| {});
    let program = stand_in_child(temp.path()).await;
    let ledger = temp.path().join("ledger");
    let launcher = ProcessChildLauncher::new(
        ChildCommand {
            program: program.to_string_lossy().into_owned(),
            env: Vec::new(),
        },
        Ledger::open(ledger.clone()),
        scope.spawner(),
    );
    let mut launched = launcher
        .launch(Path::new("/tmp/run-tree.mjs"))
        .await
        .expect("started");
    let mut line = String::new();
    launched
        .streams
        .stdout
        .read_line(&mut line)
        .await
        .expect("pid line");
    let grandchild: libc::pid_t = line.trim().parse().expect("a pid");
    assert!(has_entries(&ledger), "the launch wrote a ledger record");
    // A run that ends, an abort and a settlement only drop the guard: that alone must end the tree.
    drop(launched);
    let gone = async {
        while alive(grandchild) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), gone)
        .await
        .expect("the grandchild died with the sandbox child");
    let cleared = async {
        while has_entries(&ledger) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), cleared)
        .await
        .expect("the sandbox child's ledger record is removed");
}
