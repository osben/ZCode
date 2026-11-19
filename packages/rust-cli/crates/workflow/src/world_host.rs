//! The worker side of world reads and artifact publishes (W6b part 4; Node's `.then` on `executeWorldRead` and
//! `executeArtifactPublish`).
//!
//! The owner never does I/O. [`crate::driver_owner::ActorPort`] queues a [`WorldJob`]; the owner's pump hands it to
//! [`spawn_world_job`], which runs the blocking read on its own thread and posts the outcome back to the owner's
//! mailbox as an `ActorRequest::WorldSettled` or `ActorRequest::ArtifactSettled`. The owner then settles the engine.

// WorkflowError is the engine's error type (see world_read.rs): the closures' Err path is cold.
#![allow(clippy::result_large_err)]

use crate::actor_mailbox::{ActorHandle, ActorRequest};
use crate::artifact_publish::{
    ArtifactFsPort, ArtifactStorePort, PublishDeps, execute_artifact_publish,
};
use crate::engine_artifacts::ArtifactPublishRequest;
use crate::error::{ErrorCode, WorkflowError};
use crate::model::Ref;
use crate::world_read::{WorldReadPorts, execute_world_read};
use serde_json::Value;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Arc;

/// The artifact half of the wiring: the bytes port, the store (optional, as in Node), the parent session the store
/// writes under, and the publication clock.
#[derive(Clone)]
pub struct ArtifactWiring {
    pub fs: Arc<dyn ArtifactFsPort>,
    pub store: Option<Arc<dyn ArtifactStorePort>>,
    pub parent_session_id: Option<String>,
    pub now_ms: fn() -> u64,
}

/// Everything the owner needs to run world jobs: the read port, the workspace root, the optional artifact half, and
/// the owner's mailbox handle that the outcomes are posted to.
#[derive(Clone)]
pub struct WorldWiring {
    pub reads: Arc<dyn WorldReadPorts>,
    pub cwd: PathBuf,
    pub artifacts: Option<ArtifactWiring>,
    pub done: ActorHandle,
}

/// One queued job from the engine's driver port.
#[derive(Debug)]
pub(crate) enum WorldJob {
    Read {
        instance: Ref,
        op: String,
        args: Vec<Value>,
    },
    Publish {
        instance: Ref,
        request: ArtifactPublishRequest,
    },
}

/// Run one job on a worker thread and post its outcome to the owner. A panic in a port becomes a `DriverError` for
/// that node instead of a node that stays running forever.
pub(crate) fn spawn_world_job(wiring: &WorldWiring, job: WorldJob) {
    let done = wiring.done.clone();
    match job {
        WorldJob::Read { instance, op, args } => {
            let reads = Arc::clone(&wiring.reads);
            let cwd = wiring.cwd.clone();
            std::thread::spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    execute_world_read(&cwd, reads.as_ref(), &op, &args)
                }))
                .unwrap_or_else(|_| Err(panicked("the world read")));
                let _ = done.post(ActorRequest::WorldSettled { instance, result });
            });
        }
        WorldJob::Publish { instance, request } => {
            let Some(artifacts) = wiring.artifacts.clone() else {
                // The engine checks `has_artifact_store` first, so this is a wiring error. Fail the publish loudly.
                let result = Err(WorkflowError::new(
                    ErrorCode::ArtifactStoreUnavailable,
                    format!(
                        "artifact.{}: this assembly has no artifact store.",
                        request.op
                    ),
                ));
                let _ = done.post(ActorRequest::ArtifactSettled { instance, result });
                return;
            };
            let cwd = wiring.cwd.clone();
            std::thread::spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    let deps = PublishDeps {
                        fs: artifacts.fs.as_ref(),
                        store: artifacts.store.as_deref(),
                        parent_session_id: artifacts.parent_session_id.as_deref(),
                        cwd: &cwd,
                        now_ms: (artifacts.now_ms)(),
                    };
                    execute_artifact_publish(&deps, &request)
                }))
                .unwrap_or_else(|_| Err(panicked("the artifact publish")));
                let _ = done.post(ActorRequest::ArtifactSettled { instance, result });
            });
        }
    }
}

fn panicked(what: &str) -> WorkflowError {
    WorkflowError::new(
        ErrorCode::DriverError,
        format!("{what} panicked; the node fails and the run continues."),
    )
}
