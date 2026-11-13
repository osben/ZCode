use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::lsp::{FileMutation, FileMutationKind};
use serde_json::{Value, json};

use super::{Disk, Documents, Freshness, Outcome, Snapshot, SyncContext};
use crate::lsp::runtime::MAX_OPEN_DOCUMENTS;
use crate::lsp::runtime::edits::Diagnostic;
use crate::lsp::runtime::pool::tests::{FakeProcess, fake_pool, key};
use crate::lsp::runtime::pool::{Acquired, Pool, ServerConnection};
use crate::lsp::runtime::test_server;

#[derive(Default)]
pub(crate) struct MemoryDisk(Mutex<HashMap<String, (String, Snapshot)>>);

impl MemoryDisk {
    pub(crate) fn put(&self, path: &str, text: &str, mtime_ms: u64) {
        self.0.lock_unpoisoned().insert(
            path.to_owned(),
            (
                text.to_owned(),
                Snapshot {
                    size: text.len() as u64,
                    mtime_ms: Some(mtime_ms),
                },
            ),
        );
    }
}

#[async_trait]
impl Disk for MemoryDisk {
    async fn stat(&self, path: &str) -> Result<Snapshot, String> {
        self.0
            .lock_unpoisoned()
            .get(path)
            .map(|(_, snapshot)| *snapshot)
            .ok_or_else(|| format!("ENOENT: {path}"))
    }

    async fn read(&self, path: &str) -> Result<String, String> {
        self.0
            .lock_unpoisoned()
            .get(path)
            .map(|(text, _)| text.clone())
            .ok_or_else(|| format!("ENOENT: {path}"))
    }
}

fn item(message: &str) -> Diagnostic {
    Diagnostic {
        line: 0,
        character: 0,
        end_line: 0,
        end_character: 1,
        severity: crate::lsp::runtime::edits::Severity::Error,
        message: message.to_owned(),
        code: None,
        source: None,
    }
}

fn raw(message: &str) -> Value {
    json!({
        "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}},
        "severity": 1,
        "message": message,
    })
}

#[test]
fn a_versionless_publish_counts_only_with_one_change_in_flight() {
    let mut freshness = Freshness::default();
    freshness.record_change(1);
    assert_eq!(freshness.record_publish(None, vec![item("a")]), Outcome::Fresh);
    assert_eq!(freshness.current_fresh(), Some(&vec![item("a")]));
    // Two quick changes, one versionless publish: it may answer either.
    freshness.record_change(2);
    freshness.record_change(3);
    assert_eq!(freshness.record_publish(None, vec![item("b")]), Outcome::Ambiguous);
    assert_eq!(freshness.current_fresh(), None);
    assert_eq!(freshness.last_fresh(), Some(&vec![item("a")]));
    // Nothing in flight any more: a further publish is unattributed.
    assert_eq!(freshness.record_publish(None, vec![item("c")]), Outcome::Unattributed);
}

#[test]
fn versioned_publishes_and_pulls_count_only_for_the_current_version() {
    let mut freshness = Freshness::default();
    freshness.record_change(1);
    freshness.record_change(2);
    assert_eq!(freshness.record_publish(Some(1.0), vec![item("old")]), Outcome::Stale);
    assert_eq!(freshness.current_fresh(), None);
    assert_eq!(freshness.record_pull(1, vec![item("old")]), Outcome::Stale);
    assert_eq!(freshness.record_pull(2, vec![item("pulled")]), Outcome::Fresh);
    assert_eq!(freshness.current_fresh(), Some(&vec![item("pulled")]));
    freshness.record_change(3);
    assert_eq!(freshness.current_fresh(), None);
    assert_eq!(freshness.record_publish(Some(3.0), vec![]), Outcome::Fresh);
    assert_eq!(freshness.current_fresh(), Some(&vec![]));
}

async fn ready(pool: &Pool, process: &mut FakeProcess, capabilities: Value) -> Arc<ServerConnection> {
    let ts = Arc::new(test_server("ts"));
    process.initialize(capabilities).await;
    for _ in 0..200 {
        if let Acquired::Ready(connection) = pool.acquire(&ts, &key()) {
            return connection;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("never ready");
}

async fn started(capabilities: Value) -> (Pool, FakeProcess, Arc<ServerConnection>) {
    let (pool, _launcher, mut launched) = fake_pool();
    let _ = pool.acquire(&Arc::new(test_server("ts")), &key());
    let mut process = launched.recv().await.unwrap();
    let connection = ready(&pool, &mut process, capabilities).await;
    (pool, process, connection)
}

fn mutation(path: &str, kind: FileMutationKind, content: Option<&str>) -> FileMutation {
    FileMutation {
        path: path.to_owned(),
        kind,
        content: content.map(str::to_owned),
        changed_range: None,
    }
}

#[tokio::test(start_paused = true)]
async fn open_change_close_and_publish_freshness() {
    let (_pool, mut process, connection) = started(json!({})).await;
    let disk = MemoryDisk::default();
    disk.put("/w/a.ts", "let a = 1\n", 1);
    let documents = Documents::new(false);
    let key = key();
    let context = SyncContext {
        key: &key,
        connection: &connection,
        language_id: "typescript",
        disk: &disk,
    };
    documents.ensure_open(&context, "/w/a.ts").await.unwrap();
    let open = process.expect("textDocument/didOpen").await;
    assert_eq!(
        open["params"],
        json!({"textDocument": {"uri": "file:///w/a.ts", "languageId": "typescript", "version": 1, "text": "let a = 1\n"}})
    );
    // Opening again with the same stat sends nothing; the first publish after one change is fresh.
    documents.ensure_open(&context, "/w/a.ts").await.unwrap();
    let mut wakeups = documents.wakeups();
    process
        .send(json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
            "params": {"uri": "file:///w/a.ts", "diagnostics": [raw("first")]}}))
        .await;
    wakeups.changed().await.unwrap();
    let fresh = documents.fresh("p/ts", &key, "file:///w/a.ts").unwrap();
    assert_eq!(fresh[0].message, "first");

    // A change keeps the last fresh result as the baseline and bumps the version.
    let outcome = documents
        .apply_mutation(&context, &mutation("/w/a.ts", FileMutationKind::Changed, Some("let a = 2\n")))
        .await
        .unwrap();
    assert!(outcome.synced);
    assert_eq!(outcome.baseline.unwrap()[0].message, "first");
    let change = process.expect("textDocument/didChange").await;
    assert_eq!(
        change["params"],
        json!({"textDocument": {"uri": "file:///w/a.ts", "version": 2}, "contentChanges": [{"text": "let a = 2\n"}]})
    );
    assert_eq!(documents.fresh("p/ts", &key, "file:///w/a.ts"), None);
    // The same text again: nothing to send.
    let same = documents
        .apply_mutation(&context, &mutation("/w/a.ts", FileMutationKind::Changed, Some("let a = 2\n")))
        .await
        .unwrap();
    assert!(!same.synced);
    // A stale versioned publish is ignored; the current version's is fresh.
    process
        .send(json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
            "params": {"uri": "file:///w/a.ts", "version": 1, "diagnostics": [raw("stale")]}}))
        .await;
    process
        .send(json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
            "params": {"uri": "file:///w/a.ts", "version": 2, "diagnostics": []}}))
        .await;
    wakeups.changed().await.unwrap();
    assert_eq!(documents.fresh("p/ts", &key, "file:///w/a.ts"), Some(vec![]));

    let deleted = documents
        .apply_mutation(&context, &mutation("/w/a.ts", FileMutationKind::Deleted, None))
        .await
        .unwrap();
    assert!(deleted.synced);
    let close = process.expect("textDocument/didClose").await;
    assert_eq!(close["params"], json!({"textDocument": {"uri": "file:///w/a.ts"}}));
    assert_eq!(documents.fresh("p/ts", &key, "file:///w/a.ts"), None);
}

#[tokio::test(start_paused = true)]
async fn a_drifted_file_is_re_read_on_ensure_open() {
    let (_pool, mut process, connection) = started(json!({})).await;
    let disk = MemoryDisk::default();
    disk.put("/w/a.ts", "one\n", 1);
    let documents = Documents::new(false);
    let key = key();
    let context = SyncContext {
        key: &key,
        connection: &connection,
        language_id: "typescript",
        disk: &disk,
    };
    documents.ensure_open(&context, "/w/a.ts").await.unwrap();
    process.expect("textDocument/didOpen").await;
    disk.put("/w/a.ts", "two\n", 2);
    documents.ensure_open(&context, "/w/a.ts").await.unwrap();
    let change = process.expect("textDocument/didChange").await;
    assert_eq!(change["params"]["textDocument"]["version"], 2);
    assert_eq!(change["params"]["contentChanges"][0]["text"], "two\n");
}

#[tokio::test(start_paused = true)]
async fn a_pull_server_is_asked_after_each_sync_and_unchanged_is_ignored() {
    let (_pool, mut process, connection) = started(json!({"diagnosticProvider": {}})).await;
    let disk = MemoryDisk::default();
    let documents = Documents::new(false);
    let key = key();
    let context = SyncContext {
        key: &key,
        connection: &connection,
        language_id: "typescript",
        disk: &disk,
    };
    let mut wakeups = documents.wakeups();
    let created = documents
        .apply_mutation(&context, &mutation("/w/b.ts", FileMutationKind::Created, Some("x\n")))
        .await
        .unwrap();
    assert!(created.synced && created.baseline.is_none());
    let pull = process.expect("textDocument/diagnostic").await;
    assert_eq!(pull["params"], json!({"textDocument": {"uri": "file:///w/b.ts"}}));
    process
        .reply(&pull, json!({"kind": "full", "items": [raw("pulled")]}))
        .await;
    wakeups.changed().await.unwrap();
    assert_eq!(documents.fresh("p/ts", &key, "file:///w/b.ts").unwrap()[0].message, "pulled");

    documents
        .apply_mutation(&context, &mutation("/w/b.ts", FileMutationKind::Changed, Some("y\n")))
        .await
        .unwrap();
    let pull = process.expect("textDocument/diagnostic").await;
    process.reply(&pull, json!({"kind": "unchanged", "resultId": "1"})).await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(documents.fresh("p/ts", &key, "file:///w/b.ts"), None);
}

#[tokio::test(start_paused = true)]
async fn watched_files_and_the_open_document_limit() {
    let (_pool, mut process, connection) = started(json!({})).await;
    let disk = MemoryDisk::default();
    let documents = Documents::new(false);
    let key = key();
    let context = SyncContext {
        key: &key,
        connection: &connection,
        language_id: "typescript",
        disk: &disk,
    };
    documents.notify_watched_file(&connection, &mutation("/w/c.ts", FileMutationKind::Deleted, None));
    let watched = process.expect("workspace/didChangeWatchedFiles").await;
    assert_eq!(watched["params"], json!({"changes": [{"uri": "file:///w/c.ts", "type": 3}]}));
    for index in 0..=MAX_OPEN_DOCUMENTS {
        let path = format!("/w/f{index}.ts");
        documents
            .apply_mutation(&context, &mutation(&path, FileMutationKind::Created, Some("x")))
            .await
            .unwrap();
    }
    // The least recently used, the first, is closed.
    let close = process.expect("textDocument/didClose").await;
    assert_eq!(close["params"]["textDocument"]["uri"], "file:///w/f0.ts");
}
