//! Fork: the process hook snapshot has one owner (specs/fork-rust-agent-parity.md, "Workspace hook review flow"):
//! two trust mutations that rebuild at once install the snapshot of the later read last.
#![allow(
    clippy::disallowed_methods,
    reason = "the fixture keeps the trust store in a temporary HOME"
)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_hooks::HookSource;
use rust_cli_kernel_api::env::{FileContent, WorkspaceRef, WriteFile, WriteReceipt};
use rust_cli_kernel_api::env_files::{
    DirEntry, EnsureDir, FileStat, FileWritten, ListDir, ReadText, StatFile, StatMany, TextRead,
};
use rust_cli_kernel_api::machine::Files;
use serde_json::json;
use tokio::sync::Notify;

use super::super::tests::{Fixture, ROOT, fixture_files, target};
use super::tests::{PROJECT, PROJECT_PATH, bundle, ids};
use super::*;

/// Holds the first project config read after `armed`: the content is read, then returned only on `release`.
#[derive(Default)]
struct Gate {
    armed: AtomicBool,
    held: Notify,
    release: Notify,
}

struct HoldsRead {
    inner: Arc<dyn Files>,
    gate: Arc<Gate>,
}

#[async_trait]
impl Files for HoldsRead {
    async fn read_file(
        &self,
        workspace: &WorkspaceRef,
        request: ReadFile,
    ) -> Result<FileContent, EnvError> {
        let hold =
            request.path.as_str() == PROJECT_PATH && self.gate.armed.swap(false, Ordering::SeqCst);
        let content = self.inner.read_file(workspace, request).await;
        if hold {
            self.gate.held.notify_one();
            self.gate.release.notified().await;
        }
        content
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
        self.inner.put_file(workspace, context, request).await
    }

    async fn ensure_dir(
        &self,
        workspace: &WorkspaceRef,
        request: EnsureDir,
    ) -> Result<(), EnvError> {
        self.inner.ensure_dir(workspace, request).await
    }
}

/// The project hook commands of the last installed snapshot, in order.
fn installed(fixture: &Fixture) -> Vec<String> {
    let hooks = fixture.hooks.lock().unwrap();
    let last = hooks.last().expect("a snapshot was installed");
    last.sources
        .iter()
        .filter(|(source, _)| *source == HookSource::Project)
        .flat_map(|(_, settings)| &settings.hooks)
        .flat_map(|(_, matchers)| matchers)
        .flat_map(|matcher| &matcher.hooks)
        .map(rust_cli_hooks::config::HookCommand::display)
        .collect()
}

#[tokio::test]
async fn an_earlier_rebuild_never_installs_over_a_later_mutation() {
    let gate = Arc::new(Gate::default());
    let fixture = fixture_files(PROJECT, json!({}), |inner| {
        Arc::new(HoldsRead {
            inner,
            gate: gate.clone(),
        })
    });
    let review = bundle(&fixture).await;
    fixture
        .admin
        .review_grant(&target(ROOT), &review.bundle_digest, &ids(&review))
        .await
        .unwrap();
    assert_eq!(installed(&fixture), ["echo hi", "node check.js --fast"]);

    // The earlier rebuild reads the config with both declarations enabled, then stalls before it installs.
    gate.armed.store(true, Ordering::SeqCst);
    let (own, at, ids) = (Target::new(ROOT, None), target(ROOT), ids(&review));
    let earlier = fixture.admin.rebuild_own_hooks(&own);
    let later = async {
        gate.held.notified().await;
        let before = fixture.hooks.lock().unwrap().len();
        // A later mutation disables the first declaration and rebuilds.
        let toggle = fixture
            .admin
            .review_toggle(&at, &review.bundle_digest, &ids[0], false);
        let release = async {
            // Give the later rebuild the chance to install while the earlier one is held; with one owner it waits.
            let installed_meanwhile = async {
                while fixture.hooks.lock().unwrap().len() == before {
                    tokio::task::yield_now().await;
                }
            };
            let _ = tokio::time::timeout(Duration::from_millis(500), installed_meanwhile).await;
            gate.release.notify_one();
        };
        tokio::join!(toggle, release).0
    };
    let ((), toggled) = tokio::join!(earlier, later);
    toggled.unwrap();
    assert_eq!(installed(&fixture), ["node check.js --fast"]);
}
