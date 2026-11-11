//! Fork: a new task's prewarm stays a draft until its first real write (specs/fork-agent-runtime-selection.md
//! "Draft prewarm in Rust mode"). The kernel is assembled the way the entry point does, over a real NodeStore, and the
//! shared `db.sqlite` is read directly: an abandoned draft must leave no `session` row that the Node agent would list.
#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "integration test: temporary directories and direct database reads"
)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::clock::SystemClock;
use rust_cli_env_local::LocalEnvironment;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{CommandId, EnvironmentId, SessionId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack, Command, CommandEnvelope, CreateSession, Delivery, EndReason, Kernel,
};
use rust_cli_kernel_api::store::{FrontendRecord, LoadedSession, SessionStore, StoreQueries};
use rust_cli_kernel_api::testing::{ScriptedModel, environments, selection, text_response};
use rust_cli_node_store::{NodeIds, NodeStore};
use rust_cli_paths::{StoragePaths, StorageSettings};
use rust_cli_runtime::{Defaults, LocalKernel, Ports};

struct Sandbox {
    _dir: tempfile::TempDir,
    home: PathBuf,
    work: PathBuf,
}

impl Sandbox {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let (home, work) = (base.join("home"), base.join("work"));
        std::fs::create_dir_all(work.join(".git")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        Self {
            _dir: dir,
            home,
            work,
        }
    }

    fn paths(&self) -> StoragePaths {
        StoragePaths::resolve(&StorageSettings::default(), &self.home, &self.work)
    }

    fn kernel(&self) -> (LocalKernel, Arc<NodeStore>) {
        let clock = Arc::new(SystemClock::utc());
        let ids = Arc::new(NodeIds::new(clock.clone()));
        let store = Arc::new(NodeStore::new(self.paths(), ids.clone()).with_deferred_drafts());
        let ports = Ports {
            model: Arc::new(ScriptedModel::new(vec![text_response(&["hello"])])),
            environments: environments(Arc::new(LocalEnvironment::new(Some(self.home.clone())))),
            store: store.clone(),
            artifacts: store.clone(),
            clock,
            ids,
        };
        let defaults = Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        };
        (LocalKernel::new(ports, defaults), store)
    }

    async fn create(&self, kernel: &LocalKernel) -> SessionId {
        kernel
            .create_session(CreateSession {
                id: None,
                workspace: WorkspaceRef {
                    environment: EnvironmentId::new("local"),
                    root: EnvPath::new(self.work.to_string_lossy()),
                },
                selection: selection(),
                mode: PermissionMode::Default,
                plan: false,
            })
            .await
            .unwrap()
    }

    /// Every `session` row for `id`, soft-deleted ones included: its `time_deleted`.
    fn rows(&self, id: &SessionId) -> Vec<Option<i64>> {
        let conn = rusqlite::Connection::open(self.paths().database().as_path()).unwrap();
        let mut statement = conn
            .prepare("select time_deleted from session where id = ?")
            .unwrap();
        statement
            .query_map([id.as_str()], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }
}

async fn send(kernel: &LocalKernel, id: &SessionId, command_id: &str, command: Command) {
    let handle = kernel.open_session(id).await.unwrap();
    let ack = handle
        .send(CommandEnvelope {
            id: CommandId::new(command_id),
            command,
        })
        .await;
    assert!(!matches!(ack, Ack::Rejected { .. }), "{ack:?}");
}

fn other_model() -> rust_cli_kernel_api::model::ModelSelection {
    rust_cli_kernel_api::model::ModelSelection::new("anthropic", "draft-model")
}

/// A prewarm and its configuration changes leave no row; the actor's own startup writes stay in the draft.
#[tokio::test]
async fn an_untouched_prewarm_writes_no_session_row() {
    let sandbox = Sandbox::new();
    let (kernel, _store) = sandbox.kernel();
    let id = sandbox.create(&kernel).await;
    send(
        &kernel,
        &id,
        "cmd_model",
        Command::SetModel {
            selection: other_model(),
        },
    )
    .await;
    send(
        &kernel,
        &id,
        "cmd_mode",
        Command::SetMode {
            mode: PermissionMode::AcceptEdits,
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(sandbox.rows(&id), Vec::new());
    // A restarted agent has nothing to list or reopen.
    let (fresh, _) = sandbox.kernel();
    assert!(fresh.session_snapshot(&id).await.is_err());
}

/// Waits until a fresh store (a restarted agent) loads `count` messages for the session.
async fn stored_messages(sandbox: &Sandbox, id: &SessionId, count: usize) -> LoadedSession {
    for _ in 0..100 {
        let (_, fresh) = sandbox.kernel();
        if let Ok(loaded) = fresh.load(id).await
            && loaded.messages.len() >= count
        {
            return loaded;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the session never stored {count} messages");
}

/// The first send materializes the draft with the model and mode chosen on it.
#[tokio::test]
async fn the_first_send_persists_the_draft_with_its_config() {
    let sandbox = Sandbox::new();
    let (kernel, store) = sandbox.kernel();
    let id = sandbox.create(&kernel).await;
    send(
        &kernel,
        &id,
        "cmd_model",
        Command::SetModel {
            selection: other_model(),
        },
    )
    .await;
    send(
        &kernel,
        &id,
        "cmd_mode",
        Command::SetMode {
            mode: PermissionMode::AcceptEdits,
        },
    )
    .await;
    assert!(store.is_draft(&id).await.unwrap());
    let submit = Command::Submit {
        text: "hi".into(),
        attachments: Vec::new(),
        delivery: Delivery::Queue,
    };
    send(&kernel, &id, "cmd_send", submit).await;
    let loaded = stored_messages(&sandbox, &id, 2).await;
    assert!(!store.is_draft(&id).await.unwrap());
    assert_eq!(sandbox.rows(&id), vec![None]);
    assert_eq!(loaded.model, Some(other_model()));
    assert_eq!(loaded.mode, Some(PermissionMode::AcceptEdits));
}

/// Disposal (`deleteSession`: close the actor, then delete) leaves nothing behind.
#[tokio::test]
async fn a_disposed_prewarm_leaves_no_row() {
    let sandbox = Sandbox::new();
    let (kernel, store) = sandbox.kernel();
    let id = sandbox.create(&kernel).await;
    send(
        &kernel,
        &id,
        "cmd_model",
        Command::SetModel {
            selection: other_model(),
        },
    )
    .await;
    let handle = kernel.open_session(&id).await.unwrap();
    handle.close(EndReason::Other).await;
    kernel.delete_session(&id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!store.is_draft(&id).await.unwrap());
    assert_eq!(sandbox.rows(&id), Vec::new());
}

/// `session/close` with `expectedPersistence: "deferred"`: drop the draft first, then close the actor.
#[tokio::test]
async fn a_discarded_draft_stays_out_after_its_actor_closes() {
    let sandbox = Sandbox::new();
    let (kernel, store) = sandbox.kernel();
    let id = sandbox.create(&kernel).await;
    send(
        &kernel,
        &id,
        "cmd_mode",
        Command::SetMode {
            mode: PermissionMode::AcceptEdits,
        },
    )
    .await;
    assert!(store.discard_draft(&id).await.unwrap());
    let handle = kernel.open_session(&id).await.unwrap();
    handle.close(EndReason::Other).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(sandbox.rows(&id), Vec::new());
}

/// Rule 5: the reservation marker is the draft's first real write, so it persists the prewarm.
#[tokio::test]
async fn the_reservation_marker_persists_the_prewarm() {
    let sandbox = Sandbox::new();
    let (kernel, _store) = sandbox.kernel();
    let id = sandbox.create(&kernel).await;
    send(
        &kernel,
        &id,
        "cmd_model",
        Command::SetModel {
            selection: other_model(),
        },
    )
    .await;
    let marker = FrontendRecord {
        kind: "v4/fork_submission_preparation".into(),
        key: format!("v4/fork_submission_preparation:{}", id.as_str()),
        data: serde_json::json!({"submissionId": "sub_1", "status": "preparing"}),
    };
    kernel.queries().put_record(&id, &marker).await.unwrap();
    assert_eq!(sandbox.rows(&id), vec![None]);
    let (_, fresh) = sandbox.kernel();
    assert_eq!(fresh.load(&id).await.unwrap().model, Some(other_model()));
    assert_eq!(
        fresh
            .records(&id, "v4/fork_submission_preparation")
            .await
            .unwrap(),
        vec![marker]
    );
}

/// A worktree session created directly (`createSession` with `executionWorktree`) is a draft too. The protocol opens
/// its projection right after the create, before the first input persists it, and reads where the session is listed
/// and where it runs from the store: the draft must answer the parent workspace and the worktree like the row will,
/// or the projection would list the session under the worktree for good (Node lists it under the parent).
#[tokio::test]
async fn a_worktree_draft_answers_its_parent_and_worktree_before_its_row() {
    let sandbox = Sandbox::new();
    let (kernel, store) = sandbox.kernel();
    // Opens and migrates the database, then adds Node's fork migration 9002 columns (zcode-rs adds no migration).
    sandbox.create(&kernel).await;
    rusqlite::Connection::open(sandbox.paths().database().as_path())
        .unwrap()
        .execute_batch(
            "alter table session add column execution_directory text;
             alter table session add column execution_branch text;",
        )
        .unwrap();
    let worktree = sandbox.work.with_file_name("work-worktrees").join("a");
    std::fs::create_dir_all(&worktree).unwrap();
    let work = sandbox.work.to_string_lossy().into_owned();
    let id = kernel
        .create_session_in_worktree(
            CreateSession {
                id: None,
                workspace: WorkspaceRef {
                    environment: EnvironmentId::new("local"),
                    root: EnvPath::new(&work),
                },
                selection: selection(),
                mode: PermissionMode::Default,
                plan: false,
            },
            EnvPath::new(worktree.to_string_lossy()),
            Some("feat/a".to_owned()),
        )
        .await
        .unwrap();
    assert_eq!(sandbox.rows(&id), Vec::new());
    let check = async || {
        let execution = store.execution_worktree(&id).await.unwrap().unwrap();
        assert_eq!(execution.directory.as_str(), work);
        assert_eq!(execution.path.as_str(), worktree.to_string_lossy());
        assert_eq!(execution.branch.as_deref(), Some("feat/a"));
        assert_eq!(
            store.session_workspace_key(&id).await.unwrap().as_deref(),
            Some(work.as_str())
        );
    };
    check().await;
    assert!(store.persist_draft(&id).await.unwrap());
    assert_eq!(sandbox.rows(&id), vec![None]);
    check().await;
}
