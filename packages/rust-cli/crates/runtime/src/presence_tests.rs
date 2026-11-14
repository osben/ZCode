//! Fork: the session table owns each open session's runtime presence (specs/fork-rust-agent-parity.md "Session
//! runtime presence on the shared database"): registered before the cold load or the create, held through
//! Closing, released when the slot leaves the table.
use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::session_api::{CreateSession, EndReason, KernelError, StartSource};
use rust_cli_kernel_api::store::{StoreError, StoreQueries};
use rust_cli_kernel_api::testing::{
    ClosingEnvironment, FixedClock, MemoryStore, ScriptedModel, SequentialIds, StoreCall,
    StoreHooks, StoreProxy, environments, selection,
};

use super::*;

const WAIT: Duration = Duration::from_secs(5);

fn kernel(
    env: Arc<ClosingEnvironment>,
    store: Arc<dyn rust_cli_kernel_api::store::Store>,
) -> LocalKernel {
    LocalKernel::new(
        Ports {
            model: Arc::new(ScriptedModel::new(Vec::new())),
            environments: environments(env),
            store,
            artifacts: Arc::new(MemoryStore::default()),
            clock: Arc::new(FixedClock(1_000)),
            ids: Arc::new(SequentialIds::default()),
        },
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            max_turns: None,
            search_tools: false,
            task_tools: None,
            limits: Default::default(),
        },
    )
}

fn request(id: Option<&str>) -> CreateSession {
    CreateSession {
        id: id.map(SessionId::new),
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/work"),
        },
        selection: selection(),
        mode: PermissionMode::Default,
        plan: false,
        incognito: None,
    }
}

/// Records whether the session had its presence when the store saw a load or a create.
struct Witness(Arc<MemoryStore>, std::sync::Mutex<Vec<(String, usize)>>);

#[async_trait::async_trait]
impl StoreHooks for Witness {
    async fn before(&self, call: StoreCall<'_>) -> Result<(), StoreError> {
        let seen = match call {
            StoreCall::Load(id) => Some(("load", id.clone())),
            StoreCall::Create(meta) => Some(("create", meta.id.clone())),
            _ => None,
        };
        if let Some((call, id)) = seen {
            self.1
                .lock()
                .unwrap()
                .push((call.to_owned(), self.0.presence(&id)));
        }
        Ok(())
    }
}

#[tokio::test]
async fn presence_is_registered_before_the_create_and_the_load_and_held_through_closing() {
    let memory = Arc::new(MemoryStore::default());
    let witness = Arc::new(Witness(memory.clone(), Default::default()));
    let env = Arc::new(ClosingEnvironment::held());
    let kernel = kernel(
        env.clone(),
        Arc::new(StoreProxy::new(memory.clone(), witness.clone())),
    );
    let id = kernel.create_session(request(None)).await.unwrap();
    assert_eq!(memory.presence(&id), 1);
    let first = kernel.open_session(&id).await.unwrap();

    // Closing holds the presence until the slot leaves the table.
    let close = first.close(EndReason::Clear);
    let observe = async {
        env.closing(1).await;
        assert_eq!(
            memory.presence(&id),
            1,
            "a closing session keeps its presence"
        );
        env.release();
    };
    tokio::time::timeout(WAIT, async { tokio::join!(close, observe) })
        .await
        .expect("the close must finish");
    assert_eq!(memory.presence(&id), 0, "the close released the presence");

    let reopened = kernel
        .open_session_as(&id, StartSource::Resume)
        .await
        .unwrap();
    assert_eq!(memory.presence(&id), 1);
    assert_eq!(
        *witness.1.lock().unwrap(),
        [("create".to_owned(), 1), ("load".to_owned(), 1)],
        "the presence exists before the store creates or loads the session"
    );
    drop(reopened);
}

#[tokio::test]
async fn a_purge_started_elsewhere_refuses_the_open_before_the_load() {
    let memory = Arc::new(MemoryStore::default());
    let witness = Arc::new(Witness(memory.clone(), Default::default()));
    let env = Arc::new(ClosingEnvironment::held());
    let kernel = kernel(
        env.clone(),
        Arc::new(StoreProxy::new(memory.clone(), witness.clone())),
    );
    let id = kernel.create_session(request(None)).await.unwrap();
    let open = kernel.open_session(&id).await.unwrap();
    let close = open.close(EndReason::Other);
    let release = async {
        env.closing(1).await;
        env.release();
    };
    tokio::time::timeout(WAIT, async { tokio::join!(close, release) })
        .await
        .expect("the close must finish");

    memory.start_purge(&id);
    let refused = match kernel.open_session_as(&id, StartSource::Resume).await {
        Err(error) => error,
        Ok(_) => panic!("the open of a purged session must fail"),
    };
    assert_eq!(
        refused,
        KernelError::Failed {
            message: "session-data.deleting".to_owned()
        }
    );
    assert_eq!(memory.presence(&id), 0);
    assert_eq!(
        *witness.1.lock().unwrap(),
        [("create".to_owned(), 1)],
        "the refused open never loads"
    );
    assert!(
        kernel.sessions().get(&id).is_none(),
        "no Loading slot is left"
    );
    assert_eq!(
        memory.assert_not_deleting(&[id]).await,
        Err(StoreError::Deleting)
    );
}

#[tokio::test]
async fn a_create_of_a_purged_id_writes_nothing() {
    let memory = Arc::new(MemoryStore::default());
    let kernel = kernel(Arc::new(ClosingEnvironment::held()), memory.clone());
    let id = SessionId::new("sess_purged");
    memory.start_purge(&id);
    let refused = kernel
        .create_session(request(Some("sess_purged")))
        .await
        .unwrap_err();
    assert_eq!(
        refused,
        KernelError::Failed {
            message: "session-data.deleting".to_owned()
        }
    );
    assert!(memory.meta(&id).is_none(), "no session row");
    assert_eq!(memory.presence(&id), 0);
}

/// A failed cold load drops the presence it registered.
#[tokio::test]
async fn a_failed_open_releases_its_presence() {
    let memory = Arc::new(MemoryStore::default());
    let kernel = kernel(Arc::new(ClosingEnvironment::held()), memory.clone());
    let missing = SessionId::new("sess_missing");
    let mut open = pin!(kernel.open_session_as(&missing, StartSource::Resume));
    assert!(open.as_mut().await.is_err());
    assert_eq!(memory.presence(&missing), 0);
}
