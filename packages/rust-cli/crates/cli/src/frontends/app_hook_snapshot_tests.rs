//! Fork: the App's trust changes rebuild the entry of the workspace they change (specs/fork-rust-agent-parity.md,
//! "Per-workspace hook snapshots and strict project hook discovery"), wherever the process runs.
#![allow(
    clippy::disallowed_methods,
    reason = "the fixture keeps the trust store in a temporary HOME"
)]

use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use rust_cli_hooks::{ProjectEntry, project_key};
use rust_cli_kernel_api::env::{EnvPath, FileContent, WorkspaceRef, WriteFile, WriteReceipt};
use rust_cli_kernel_api::env_files::{
    DirEntry, EnsureDir, FileStat, FileWritten, ListDir, ReadText, StatFile, StatMany, TextRead,
};
use rust_cli_kernel_api::machine::Files;
use serde_json::json;

use super::super::tests::{Fixture, ROOT, fixture_files, fixture_text, target};
use super::tests::{PROJECT, PROJECT_PATH, bundle, ids};
use super::*;

/// The commands of an admitted entry, in order.
fn commands(entry: &ProjectEntry) -> Vec<String> {
    let ProjectEntry::Admitted(sources) = entry else {
        panic!("an admitted entry: {entry:?}");
    };
    sources
        .iter()
        .flat_map(|(_, settings)| &settings.hooks)
        .flat_map(|(_, matchers)| matchers)
        .flat_map(|matcher| &matcher.hooks)
        .map(rust_cli_hooks::config::HookCommand::display)
        .collect()
}

fn last_put(fixture: &Fixture) -> (String, ProjectEntry) {
    fixture
        .hooks
        .lock()
        .unwrap()
        .last()
        .cloned()
        .expect("an entry was put")
}

/// A Desktop agent runs with its cwd in `~/.zcode`, never in the session's workspace.
fn elsewhere(fixture: &mut Fixture) {
    fixture.admin.process.workspace.root = EnvPath::new("/Users/dev/.zcode");
}

#[tokio::test]
async fn trust_changes_rebuild_the_entry_of_a_workspace_outside_the_process_root() {
    let mut fixture = fixture_text(PROJECT, json!({}));
    elsewhere(&mut fixture);
    let review = bundle(&fixture).await;
    fixture
        .admin
        .review_grant(&target(ROOT), &review.bundle_digest, &ids(&review)[..1])
        .await
        .unwrap();
    // The key is the one the engine reads for an event in the session's workspace.
    let (key, entry) = last_put(&fixture);
    assert_eq!(key, project_key(ROOT));
    assert_eq!(commands(&entry), ["echo hi"]);
    let digests: Vec<String> = review
        .items
        .iter()
        .map(|item| item.digest.clone())
        .collect();
    fixture
        .admin
        .review_revoke(&target(ROOT), &digests)
        .await
        .unwrap();
    let (key, entry) = last_put(&fixture);
    assert_eq!(key, project_key(ROOT));
    assert!(commands(&entry).is_empty());
}

#[tokio::test]
async fn a_toggle_rebuilds_the_entry() {
    let mut fixture = fixture_text(PROJECT, json!({}));
    elsewhere(&mut fixture);
    let review = bundle(&fixture).await;
    fixture
        .admin
        .review_grant(&target(ROOT), &review.bundle_digest, &ids(&review))
        .await
        .unwrap();
    assert_eq!(
        commands(&last_put(&fixture).1),
        ["echo hi", "node check.js --fast"]
    );
    fixture
        .admin
        .review_toggle(
            &target(ROOT),
            &review.bundle_digest,
            &ids(&review)[0],
            false,
        )
        .await
        .unwrap();
    let (key, entry) = last_put(&fixture);
    assert_eq!(key, project_key(ROOT));
    assert_eq!(commands(&entry), ["node check.js --fast"]);
}

/// Reads of the project config fail once a write went through: the toggle's rebuild cannot read the file it wrote.
struct FailsAfterWrite {
    inner: Arc<dyn Files>,
    written: AtomicBool,
}

#[async_trait]
impl Files for FailsAfterWrite {
    async fn read_file(
        &self,
        workspace: &WorkspaceRef,
        request: ReadFile,
    ) -> Result<FileContent, EnvError> {
        if self.written.load(Ordering::SeqCst) && request.path.as_str() == PROJECT_PATH {
            return Err(EnvError::Io {
                message: "the config is gone".to_owned(),
            });
        }
        self.inner.read_file(workspace, request).await
    }

    async fn write_file(
        &self,
        workspace: &WorkspaceRef,
        context: OperationContext,
        request: WriteFile,
    ) -> Result<WriteReceipt, EnvError> {
        self.inner.write_file(workspace, context, request).await
    }

    async fn stat(
        &self,
        workspace: &WorkspaceRef,
        request: StatFile,
    ) -> Result<Option<FileStat>, EnvError> {
        self.inner.stat(workspace, request).await
    }

    async fn list_dir(
        &self,
        workspace: &WorkspaceRef,
        request: ListDir,
    ) -> Result<Vec<DirEntry>, EnvError> {
        self.inner.list_dir(workspace, request).await
    }

    async fn read_text(
        &self,
        workspace: &WorkspaceRef,
        request: ReadText,
    ) -> Result<TextRead, EnvError> {
        self.inner.read_text(workspace, request).await
    }

    async fn stat_many(
        &self,
        workspace: &WorkspaceRef,
        request: StatMany,
    ) -> Result<Vec<Result<Option<FileStat>, EnvError>>, EnvError> {
        self.inner.stat_many(workspace, request).await
    }

    async fn put_file(
        &self,
        workspace: &WorkspaceRef,
        context: OperationContext,
        request: PutFile,
    ) -> Result<FileWritten, EnvError> {
        let written = self.inner.put_file(workspace, context, request).await;
        if written.is_ok() {
            self.written.store(true, Ordering::SeqCst);
        }
        written
    }

    async fn ensure_dir(
        &self,
        workspace: &WorkspaceRef,
        request: EnsureDir,
    ) -> Result<(), EnvError> {
        self.inner.ensure_dir(workspace, request).await
    }
}

#[tokio::test]
async fn a_committed_toggle_whose_rebuild_fails_invalidates_the_workspace() {
    // Node `admission.invalidate("workspace_hooks_config_rebuild_failed")`: no project hook runs until the next
    // successful assembly, instead of the hooks the lenient parse would rebuild.
    let mut fixture = fixture_files(PROJECT, json!({}), |inner| {
        Arc::new(FailsAfterWrite {
            inner,
            written: AtomicBool::new(false),
        })
    });
    elsewhere(&mut fixture);
    let review = bundle(&fixture).await;
    fixture
        .admin
        .review_grant(&target(ROOT), &review.bundle_digest, &ids(&review))
        .await
        .unwrap();
    let answer = fixture
        .admin
        .review_toggle(
            &target(ROOT),
            &review.bundle_digest,
            &ids(&review)[0],
            false,
        )
        .await;
    assert_eq!(answer, Err(ToggleError::RebuildFailed));
    assert_eq!(
        last_put(&fixture),
        (project_key(ROOT), ProjectEntry::Invalid)
    );
}
