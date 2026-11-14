//! Fork: the live stdio server processes behind `process/childProcesses` (specs/fork-rust-agent-parity.md
//! "`process/childProcesses`").

use std::time::Duration;

use futures_util::StreamExt;
use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::ids::EnvironmentId;
use serde_json::json;

use super::*;

fn workspace(root: &str) -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(root),
    }
}

fn transport() -> (LocalMcpTransport, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let env = vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())];
    (
        LocalMcpTransport::new(dir.path().join("ledger"), env.into(), None),
        dir,
    )
}

fn stdio(server: &str, command: &str, args: &[&str]) -> McpConnect {
    McpConnect {
        server: server.to_owned(),
        transport: McpTransportConfig::Stdio {
            command: command.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            env: std::collections::BTreeMap::new(),
            cwd: None,
        },
    }
}

/// The process is alive (signal 0 reaches it).
#[cfg(unix)]
fn alive(pid: u32) -> bool {
    rust_cli_proc::std_command("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(unix)]
#[tokio::test]
async fn started_servers_are_listed_in_start_order_until_closed() {
    let (transport, dir) = transport();
    let root = workspace(dir.path().to_str().unwrap());
    let first = transport
        .connect(&root, stdio("plugin:browser:node", "cat", &[]))
        .await
        .unwrap();
    let second = transport
        .connect(&root, stdio("docs", "cat", &[]))
        .await
        .unwrap();
    let listed = transport.processes();
    assert_eq!(
        listed
            .iter()
            .map(|row| row.server.as_str())
            .collect::<Vec<_>>(),
        vec!["plugin:browser:node", "docs"]
    );
    for row in &listed {
        assert!(row.pid > 0 && row.pid != std::process::id());
        assert!(alive(row.pid), "{row:?}");
    }
    transport.close(&first).await.unwrap();
    assert_eq!(
        transport
            .processes()
            .into_iter()
            .map(|row| row.server)
            .collect::<Vec<_>>(),
        vec!["docs"]
    );
    assert!(!alive(listed[0].pid));
    transport.close(&second).await.unwrap();
    assert!(transport.processes().is_empty());
}

/// A server that exits by itself leaves the list before its `Closed` event arrives.
#[cfg(unix)]
#[tokio::test]
async fn a_server_that_exits_leaves_the_list() {
    let (transport, dir) = transport();
    let id = transport
        .connect(
            &workspace(dir.path().to_str().unwrap()),
            stdio("s", "/bin/sh", &["-c", "read line; exit 0"]),
        )
        .await
        .unwrap();
    let mut events = transport.events(&id);
    assert_eq!(transport.processes().len(), 1);
    transport
        .send(&id, json!({"jsonrpc": "2.0", "method": "bye"}))
        .await
        .unwrap();
    let event = tokio::time::timeout(Duration::from_secs(10), events.next())
        .await
        .expect("an event in time")
        .expect("the stream is open");
    assert!(
        matches!(event, McpTransportEvent::Closed { .. }),
        "{event:?}"
    );
    assert!(transport.processes().is_empty());
}

/// Dropping the transport aborts the connection tasks; their rows go with them.
#[cfg(unix)]
#[tokio::test]
async fn a_dropped_connection_task_leaves_the_list() {
    let (transport, dir) = transport();
    transport
        .connect(
            &workspace(dir.path().to_str().unwrap()),
            stdio("s", "cat", &[]),
        )
        .await
        .unwrap();
    let table = transport.processes.clone();
    assert_eq!(table.processes().len(), 1);
    drop(transport);
    // The abort drops the task's future when the runtime next runs it.
    tokio::time::timeout(Duration::from_secs(10), async {
        while !table.processes().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the row is removed with the aborted task");
}

#[tokio::test]
async fn a_server_that_fails_to_start_is_not_listed() {
    let (transport, dir) = transport();
    let error = transport
        .connect(
            &workspace(dir.path().to_str().unwrap()),
            stdio("s", "/nonexistent/zcode-mcp-server", &[]),
        )
        .await;
    assert!(error.is_err());
    assert!(transport.processes().is_empty());
}
