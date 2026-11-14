use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::Semaphore;

use rust_cli_kernel_api::lsp::{ChangedRange, FileMutation, FileMutationKind, LspPreferences};
use serde_json::{Value, json};

use super::{SessionLsp, Shared};
use crate::lsp::runtime::documents::tests::MemoryDisk;
use crate::lsp::runtime::documents::{Disk, Documents, Snapshot};
use crate::lsp::runtime::pool::tests::{FakeProcess, fake_pool, key};
use crate::lsp::runtime::pool::{Pool, State};
use crate::lsp::runtime::server::Registry;
use crate::lsp::runtime::test_server;

/// A probe that answers installed until told otherwise.
pub(crate) struct Installed(pub(crate) std::sync::atomic::AtomicBool);

impl Default for Installed {
    fn default() -> Self {
        Self(std::sync::atomic::AtomicBool::new(true))
    }
}

#[async_trait]
impl super::InstallProbe for Installed {
    async fn installed(&self, _server: &rust_cli_ext::plugins::lsp::ResolvedLspServer) -> bool {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }
}

struct Harness {
    session: Arc<SessionLsp>,
    pool: Pool,
    preferences: Arc<Mutex<LspPreferences>>,
    launched: tokio::sync::mpsc::UnboundedReceiver<FakeProcess>,
    _launcher: Arc<crate::lsp::runtime::pool::tests::FakeLauncher>,
    probe: Arc<Installed>,
}

fn harness() -> Harness {
    harness_with(Arc::new(MemoryDisk::default()))
}

fn harness_with(disk: Arc<dyn Disk>) -> Harness {
    let (pool, launcher, launched) = fake_pool();
    let preferences = Arc::new(Mutex::new(LspPreferences::default()));
    let probe = Arc::new(Installed::default());
    let shared = Shared {
        pool: pool.clone(),
        documents: Documents::new(false),
        preferences: Arc::clone(&preferences),
        probe: Arc::clone(&probe) as Arc<dyn super::InstallProbe>,
    };
    let session = SessionLsp::new(shared, Registry::new(vec![test_server("ts")]), key(), disk);
    Harness {
        session,
        pool,
        preferences,
        launched,
        _launcher: launcher,
        probe,
    }
}

impl Harness {
    async fn start(&mut self) -> FakeProcess {
        self.start_with(json!({})).await
    }

    async fn start_with(&mut self, capabilities: Value) -> FakeProcess {
        self.session.prewarm("/w/a.ts");
        let mut process = self.launched.recv().await.unwrap();
        process.initialize(capabilities).await;
        self.ready().await;
        process
    }

    async fn ready(&self) {
        for _ in 0..200 {
            if self.pool.status().first().map(|status| status.state) == Some(State::Ready) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("never ready");
    }
}

fn changed(path: &str, content: &str, lines: (u32, u32)) -> FileMutation {
    FileMutation {
        path: path.to_owned(),
        kind: FileMutationKind::Changed,
        content: Some(content.to_owned()),
        changed_range: Some(ChangedRange {
            start_line: lines.0,
            end_line: lines.1,
        }),
    }
}

/// An error at the 0-based `line`.
fn at(line: u32, message: &str) -> Value {
    json!({
        "range": {"start": {"line": line, "character": 0}, "end": {"line": line, "character": 1}},
        "severity": 1,
        "message": message,
    })
}

async fn publish(process: &mut FakeProcess, path: &str, diagnostics: Vec<Value>) {
    process
        .send(
            json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
            "params": {"uri": format!("file://{path}"), "diagnostics": diagnostics}}),
        )
        .await;
}

#[tokio::test(start_paused = true)]
async fn only_new_issues_are_reported_and_a_shifted_one_is_not_new() {
    let mut harness = harness();
    let mut process = harness.start().await;
    assert_eq!(harness.session.edit_diagnostics().await, None);

    // First edit of an unopened file: no baseline, so only the changed lines count.
    harness
        .session
        .file_mutated(changed("/w/a.ts", "a\nb\nc\n", (2, 2)));
    process.expect("textDocument/didOpen").await;
    publish(
        &mut process,
        "/w/a.ts",
        vec![at(0, "outside"), at(1, "old")],
    )
    .await;
    assert_eq!(
        harness.session.edit_diagnostics().await.as_deref(),
        Some("Found 1 new diagnostic issues in 1 files\na.ts:2:1 error old")
    );
    assert!(!harness.session.has_pending());

    // Second edit: the last fresh result is the baseline; "old" moved down a line and is not new.
    harness
        .session
        .file_mutated(changed("/w/a.ts", "a\nx\nb\nc\n", (2, 2)));
    process.expect("textDocument/didChange").await;
    publish(
        &mut process,
        "/w/a.ts",
        vec![at(0, "outside"), at(1, "new"), at(2, "old")],
    )
    .await;
    assert_eq!(
        harness.session.edit_diagnostics().await.as_deref(),
        Some("Found 1 new diagnostic issues in 1 files\na.ts:2:1 error new")
    );
}

#[tokio::test(start_paused = true)]
async fn a_pending_edit_is_reported_then_dropped_after_three_rounds() {
    let mut harness = harness();
    let mut process = harness.start().await;
    harness
        .session
        .file_mutated(changed("/w/a.ts", "a\n", (1, 1)));
    process.expect("textDocument/didOpen").await;
    let started = tokio::time::Instant::now();
    for _ in 0..3 {
        assert_eq!(
            harness.session.edit_diagnostics().await.as_deref(),
            Some("Diagnostics pending for 1 files")
        );
    }
    // The first round waited the 2 s bound from the mutation; later rounds are past it.
    assert!(started.elapsed() >= Duration::from_secs(2));
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(harness.session.edit_diagnostics().await, None);
    assert!(!harness.session.has_pending());
}

#[tokio::test(start_paused = true)]
async fn two_quick_changes_stay_pending_until_a_versioned_result() {
    let mut harness = harness();
    let mut process = harness.start().await;
    harness
        .session
        .file_mutated(changed("/w/a.ts", "a\n", (1, 1)));
    process.expect("textDocument/didOpen").await;
    harness
        .session
        .file_mutated(changed("/w/a.ts", "b\n", (1, 1)));
    process.expect("textDocument/didChange").await;
    // Ambiguous: it may answer either version.
    publish(&mut process, "/w/a.ts", vec![at(0, "which")]).await;
    assert_eq!(
        harness.session.edit_diagnostics().await.as_deref(),
        Some("Diagnostics pending for 1 files")
    );
    process
        .send(
            json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
            "params": {"uri": "file:///w/a.ts", "version": 2, "diagnostics": [at(0, "v2")]}}),
        )
        .await;
    // Past the 2 s bound the request does not wait: let the publish arrive first.
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(
        harness.session.edit_diagnostics().await.as_deref(),
        Some("Found 1 new diagnostic issues in 1 files\na.ts:1:1 error v2")
    );
}

#[tokio::test(start_paused = true)]
async fn an_edit_while_the_server_starts_is_replayed_on_ready() {
    let mut harness = harness();
    harness.session.prewarm("/w/a.ts");
    let mut process = harness.launched.recv().await.unwrap();
    harness
        .session
        .file_mutated(changed("/w/a.ts", "a\n", (1, 1)));
    tokio::time::sleep(Duration::from_millis(5)).await;
    {
        let tracker = harness.session.tracker.lock().unwrap();
        assert!(tracker.entries()[0].needs_sync);
    }
    // The replay reads the file from disk.
    let disk = MemoryDisk::default();
    disk.put("/w/a.ts", "a\n", 1);
    let session = SessionLsp::new(
        harness.session.shared.clone(),
        Registry::new(vec![test_server("ts")]),
        key(),
        Arc::new(disk),
    );
    session.file_mutated(changed("/w/a.ts", "a\n", (1, 1)));
    tokio::time::sleep(Duration::from_millis(5)).await;
    process.initialize(json!({})).await;
    let open = process.expect("textDocument/didOpen").await;
    assert_eq!(open["params"]["textDocument"]["text"], "a\n");
    publish(&mut process, "/w/a.ts", vec![at(0, "boot")]).await;
    assert_eq!(
        session.edit_diagnostics().await.as_deref(),
        Some("Found 1 new diagnostic issues in 1 files\na.ts:1:1 error boot")
    );
    // The first session's file is not on its disk: the replay failed and dropped the edit.
    assert_eq!(harness.session.edit_diagnostics().await, None);
}

#[tokio::test(start_paused = true)]
async fn a_cancelled_request_leaves_the_pending_edits() {
    let mut harness = harness();
    let mut process = harness.start().await;
    harness
        .session
        .file_mutated(changed("/w/a.ts", "a\n", (1, 1)));
    process.expect("textDocument/didOpen").await;
    let cancelled = tokio::time::timeout(
        Duration::from_millis(500),
        harness.session.edit_diagnostics(),
    )
    .await;
    assert!(cancelled.is_err());
    assert!(harness.session.has_pending());
    publish(&mut process, "/w/a.ts", vec![at(0, "late")]).await;
    assert_eq!(
        harness.session.edit_diagnostics().await.as_deref(),
        Some("Found 1 new diagnostic issues in 1 files\na.ts:1:1 error late")
    );
}

#[tokio::test(start_paused = true)]
async fn diagnostics_after_edit_off_tracks_nothing_but_still_syncs() {
    let mut harness = harness();
    let mut process = harness.start().await;
    harness
        .preferences
        .lock()
        .unwrap()
        .diagnostics_after_edit
        .insert("p/ts".to_owned(), json!(false));
    harness
        .session
        .file_mutated(changed("/w/a.ts", "a\n", (1, 1)));
    assert!(!harness.session.has_pending());
    process.expect("textDocument/didOpen").await;
    assert_eq!(harness.session.edit_diagnostics().await, None);
}

#[tokio::test(start_paused = true)]
async fn turning_code_intelligence_off_drops_pending_edits() {
    let mut harness = harness();
    let mut process = harness.start().await;
    harness
        .session
        .file_mutated(changed("/w/a.ts", "a\n", (1, 1)));
    process.expect("textDocument/didOpen").await;
    harness.preferences.lock().unwrap().enabled = false;
    assert_eq!(harness.session.edit_diagnostics().await, None);
    assert!(!harness.session.has_pending());
    harness
        .session
        .file_mutated(changed("/w/a.ts", "b\n", (1, 1)));
    assert!(!harness.session.has_pending());
}

/// Quick edits of one file reach the server in publish order, even on a multi-threaded runtime.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quick_edits_of_one_file_are_synced_in_order() {
    let mut harness = harness();
    let mut process = harness.start().await;
    for index in 0..20 {
        harness
            .session
            .file_mutated(changed("/w/a.ts", &format!("v{index}\n"), (1, 1)));
    }
    let open = process.expect("textDocument/didOpen").await;
    assert_eq!(open["params"]["textDocument"]["text"], "v0\n");
    for index in 1..20 {
        let change = process.expect("textDocument/didChange").await;
        assert_eq!(change["params"]["textDocument"]["version"], index + 1);
        assert_eq!(
            change["params"]["contentChanges"][0]["text"],
            format!("v{index}\n")
        );
    }
}

/// A disk whose reads wait for a permit: it holds the sync queue on one mutation.
struct GatedDisk {
    gate: Semaphore,
    inner: MemoryDisk,
}

#[async_trait]
impl Disk for GatedDisk {
    async fn stat(&self, path: &str) -> Result<Snapshot, String> {
        self.inner.stat(path).await
    }

    async fn read(&self, path: &str) -> Result<String, String> {
        let _permit = self
            .gate
            .acquire()
            .await
            .map_err(|error| error.to_string())?;
        self.inner.read(path).await
    }
}

/// A mutation still queued when code intelligence is turned off starts no server (Node checks and acquires in one
/// synchronous step).
#[tokio::test(start_paused = true)]
async fn a_queued_mutation_starts_nothing_after_code_intelligence_is_off() {
    let disk = Arc::new(GatedDisk {
        gate: Semaphore::new(0),
        inner: MemoryDisk::default(),
    });
    disk.inner.put("/w/a.ts", "a\n", 1);
    let mut harness = harness_with(Arc::clone(&disk) as Arc<dyn Disk>);
    let mut process = harness.start().await;
    // The first mutation reads the disk and waits there; the second queues behind it.
    harness.session.file_mutated(FileMutation {
        path: "/w/a.ts".to_owned(),
        kind: FileMutationKind::Changed,
        content: None,
        changed_range: None,
    });
    harness
        .session
        .file_mutated(changed("/w/b.ts", "b\n", (1, 1)));
    tokio::time::sleep(Duration::from_millis(5)).await;
    harness.preferences.lock().unwrap().enabled = false;
    let stop = harness.pool.stop_all();
    let server = async {
        let shutdown = process.expect("shutdown").await;
        process.reply(&shutdown, Value::Null).await;
        process.expect("exit").await;
        process.exit("exited (code 0, signal none)");
    };
    tokio::join!(stop, server);
    disk.gate.add_permits(10);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        harness.launched.try_recv().is_err(),
        "a server started after code intelligence was turned off"
    );
}

/// An older mutation whose sync fails does not drop the pending edit a newer mutation of the same file recorded.
#[tokio::test(start_paused = true)]
async fn a_failed_older_sync_keeps_the_newer_pending_edit() {
    let mut harness = harness();
    let mut process = harness.start().await;
    // Not on the disk: this sync fails.
    harness.session.file_mutated(FileMutation {
        path: "/w/a.ts".to_owned(),
        kind: FileMutationKind::Changed,
        content: None,
        changed_range: Some(ChangedRange {
            start_line: 1,
            end_line: 1,
        }),
    });
    harness
        .session
        .file_mutated(changed("/w/a.ts", "b\n", (1, 1)));
    let open = process.expect("textDocument/didOpen").await;
    assert_eq!(open["params"]["textDocument"]["text"], "b\n");
    publish(&mut process, "/w/a.ts", vec![at(0, "newer")]).await;
    assert_eq!(
        harness.session.edit_diagnostics().await.as_deref(),
        Some("Found 1 new diagnostic issues in 1 files\na.ts:1:1 error newer")
    );
}

/// Prewarm with code intelligence off starts nothing.
#[tokio::test(start_paused = true)]
async fn prewarm_starts_nothing_when_code_intelligence_is_off() {
    let mut harness = harness();
    harness.preferences.lock().unwrap().enabled = false;
    harness.session.prewarm("/w/a.ts");
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert!(harness.launched.try_recv().is_err());
}

#[path = "query_flow_tests.rs"]
mod query_flow;
