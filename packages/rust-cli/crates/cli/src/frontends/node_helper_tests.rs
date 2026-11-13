use super::*;

fn parsed(raw: &str) -> Command {
    parse(Some(raw)).expect("valid").expect("configured")
}

#[test]
fn unset_or_blank_means_no_helper() {
    assert_eq!(parse(None), Ok(None));
    assert_eq!(parse(Some("")), Ok(None));
    assert_eq!(parse(Some("   ")), Ok(None));
}

#[test]
fn command_args_and_env_are_read() {
    let command = parsed(
        r#"{"command": "/opt/node", "args": ["/bundle.js", "__zcode-rust-helper", "--stdio"],
            "env": {"ELECTRON_RUN_AS_NODE": "1"}}"#,
    );
    assert_eq!(command.program, "/opt/node");
    assert_eq!(
        command.args,
        vec!["/bundle.js", "__zcode-rust-helper", "--stdio"]
    );
    assert_eq!(
        command.env,
        vec![("ELECTRON_RUN_AS_NODE".to_owned(), "1".to_owned())]
    );
}

#[test]
fn the_program_is_trimmed_as_it_is_checked() {
    assert_eq!(parsed(r#"{"command": " node\t"}"#).program, "node");
}

#[test]
fn args_and_env_default_to_empty() {
    let command = parsed(r#"{"command": "node"}"#);
    assert!(command.args.is_empty());
    assert!(command.env.is_empty());
}

#[test]
fn invalid_values_are_refused_without_echoing_them() {
    let secret = "sk-live-do-not-log";
    let cases = [
        format!("{{not json {secret}"),
        format!("[\"{secret}\"]"),
        r#"{"args": []}"#.to_owned(),
        r#"{"command": ""}"#.to_owned(),
        r#"{"command": "   "}"#.to_owned(),
        format!(r#"{{"command": "node", "args": "{secret}"}}"#),
        r#"{"command": "node", "args": [1]}"#.to_owned(),
        format!(r#"{{"command": "node", "env": ["{secret}"]}}"#),
        r#"{"command": "node", "env": {"K": 3}}"#.to_owned(),
    ];
    for raw in cases {
        let reason = parse(Some(&raw)).expect_err("refused");
        assert!(
            !reason.contains(secret),
            "the reason echoes the value: {reason}"
        );
    }
}

#[test]
fn debug_names_env_keys_but_never_their_values() {
    let command = parsed(r#"{"command": "node", "env": {"PROVIDER_TOKEN": "sk-live-do-not-log"}}"#);
    let shown = format!("{command:?}");
    assert!(shown.contains("PROVIDER_TOKEN"), "{shown}");
    assert!(!shown.contains("sk-live-do-not-log"), "{shown}");
}

#[tokio::test]
async fn stderr_lines_survive_bytes_that_are_not_utf8() {
    let input: &[u8] = b"first\n\xff\xfe broken\nlast\n";
    let mut lines = Vec::new();
    read_lines(input, |line| lines.push(line)).await;
    assert_eq!(lines, vec!["first", "\u{FFFD}\u{FFFD} broken", "last"]);
}

#[tokio::test]
async fn a_launch_failure_names_the_program_file() {
    let temp = tempfile::tempdir().expect("temp dir");
    let scope = rust_cli_base::TaskScope::root("node-helper-launch-test", |_| {});
    let launcher = ProcessLauncher {
        command: parsed(r#"{"command": "/no/such/dir/zcode-helper-missing"}"#),
        ledger: Ledger::open(temp.path().join("ledger")),
        spawner: scope.spawner(),
    };
    let Err(error) = launcher.launch().await else {
        panic!("a missing program cannot start");
    };
    let message = error.to_string();
    assert!(message.contains("zcode-helper-missing"), "{message}");
    // Only the file name: a directory can hold the user's name.
    assert!(!message.contains("/no/such/dir"), "{message}");
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_the_launched_process_kills_its_whole_tree() {
    use tokio::io::AsyncBufReadExt;

    let temp = tempfile::tempdir().expect("temp dir");
    let scope = rust_cli_base::TaskScope::root("node-helper-tree-test", |_| {});
    let launcher = ProcessLauncher {
        command: parsed(r#"{"command": "/bin/sh", "args": ["-c", "sleep 30 & echo $!; wait"]}"#),
        ledger: Ledger::open(temp.path().join("ledger")),
        spawner: scope.spawner(),
    };
    let mut process = launcher.launch().await.expect("started");
    let mut line = String::new();
    process.stdout.read_line(&mut line).await.expect("pid line");
    let grandchild: libc::pid_t = line.trim().parse().expect("a pid");
    // Idle reclaim, a timeout and a crash restart only drop the guard: that alone must end the tree.
    drop(process);
    let gone = async {
        while alive(grandchild) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), gone)
        .await
        .expect("the grandchild died with the helper");
    // The stop is confirmed, so its ledger record goes too: a long-lived agent reclaims a helper every idle period,
    // and an unconfirmed drop would leave one record per generation until the next process's sweep.
    let ledger = temp.path().join("ledger");
    let cleared = async {
        while has_entries(&ledger) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), cleared)
        .await
        .expect("the helper's ledger record is removed");
}

#[cfg(unix)]
#[expect(
    clippy::disallowed_methods,
    reason = "the test inspects the ledger directory itself"
)]
fn has_entries(dir: &std::path::Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_some())
}

#[cfg(unix)]
fn alive(pid: libc::pid_t) -> bool {
    // SAFETY: kill with signal 0 delivers nothing; it only checks that the process exists.
    #[expect(unsafe_code, reason = "kill(2) is libc FFI")]
    let found = unsafe { libc::kill(pid, 0) } == 0;
    found
}
