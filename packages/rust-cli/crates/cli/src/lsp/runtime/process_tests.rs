//! Acceptance 7: a real child process speaking LSP over stdio (a `/bin/sh` script) through start, an edit, its
//! diagnostics and a graceful stop.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rust_cli_kernel_api::lsp::{ChangedRange, FileMutation, FileMutationKind, LspPreferences};
use rust_cli_proc::ledger::Ledger;

use super::{Launcher, LedgerLauncher};
use crate::lsp::runtime::documents::Documents;
use crate::lsp::runtime::documents::tests::MemoryDisk;
use crate::lsp::runtime::pool::{Limits, Pool, ServerKey, State};
use crate::lsp::runtime::server::Registry;
use crate::lsp::runtime::session::{SessionLsp, Shared};
use crate::lsp::runtime::test_server;

/// Answers `initialize` and `shutdown`, publishes one error for every opened document, exits on `exit`.
const SERVER: &str = r#"
reply() { printf 'Content-Length: %d\r\n\r\n%s' "${#1}" "$1"; }
while :; do
  len=0
  while IFS= read -r line; do
    line=$(printf '%s' "$line" | tr -d '\r')
    [ -z "$line" ] && break
    case $line in Content-Length:*) len=$(printf '%s' "${line#Content-Length:}" | tr -dc '0-9');; esac
  done
  [ "$len" -gt 0 ] || exit 0
  body=$(dd bs=1 count="$len" 2>/dev/null)
  id=$(printf '%s' "$body" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case $body in
    *'"method":"initialize"'*) reply "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"capabilities\":{}}}" ;;
    *'"method":"shutdown"'*) reply "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":null}" ;;
    *'"method":"exit"'*) exit 0 ;;
    *'"method":"textDocument/didOpen"'*)
      uri=$(printf '%s' "$body" | sed -n 's/.*"uri":"\([^"]*\)".*/\1/p')
      reply "{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/publishDiagnostics\",\"params\":{\"uri\":\"$uri\",\"version\":1,\"diagnostics\":[{\"range\":{\"start\":{\"line\":0,\"character\":0},\"end\":{\"line\":0,\"character\":1}},\"severity\":1,\"message\":\"fake error\",\"source\":\"sh\"}]}}" ;;
  esac
done
"#;

#[tokio::test]
async fn a_real_server_reports_diagnostics_after_an_edit() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().to_string_lossy().into_owned();
    let launcher: Arc<dyn Launcher> =
        Arc::new(LedgerLauncher::new(Ledger::open(dir.path().join("ledger"))));
    let pool = Pool::new(
        launcher,
        vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())],
        false,
        Limits::default(),
    );
    let mut server = test_server("sh");
    server.command = "/bin/sh".to_owned();
    server.args = vec!["-c".to_owned(), SERVER.to_owned()];
    let session = SessionLsp::new(
        Shared {
            pool: pool.clone(),
            documents: Documents::new(false),
            preferences: Arc::new(Mutex::new(LspPreferences::default())),
        },
        Registry::new(vec![server]),
        ServerKey {
            identity: workspace.clone(),
            workspace: workspace.clone(),
        },
        Arc::new(MemoryDisk::default()),
    );
    let path = format!("{workspace}/a.ts");
    session.prewarm(&path);
    let ready = async {
        while pool.status().first().map(|status| status.state) != Some(State::Ready) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), ready)
        .await
        .expect("the server never became ready");
    session.file_mutated(FileMutation {
        path,
        kind: FileMutationKind::Created,
        content: Some("x\n".to_owned()),
        changed_range: Some(ChangedRange {
            start_line: 1,
            end_line: 1,
        }),
    });
    assert_eq!(
        session.edit_diagnostics().await.as_deref(),
        Some("Found 1 new diagnostic issues in 1 files\na.ts:1:1 error fake error [sh]")
    );
    tokio::time::timeout(Duration::from_secs(10), pool.stop_all())
        .await
        .expect("the server did not stop");
    assert_eq!(pool.status()[0].state, State::Stopped);
}
