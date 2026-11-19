//! The worker side of world reads and artifact publishes (W6b part 4; Node's `.then` on `executeWorldRead` and
//! `executeArtifactPublish`).
//!
//! The owner never does I/O. [`crate::driver_owner::ActorPort`] queues a [`WorldJob`]; the owner starts at most
//! [`WORLD_JOB_LIMIT`] of them at a time, each on its own thread through [`spawn_world_job`]. A job posts its outcome
//! back to the owner's mailbox as an `ActorRequest::WorldSettled` or `ActorRequest::ArtifactSettled`, and the owner
//! settles the engine.

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
use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Arc;

/// The most world jobs (world reads and artifact publishes) running at once. Node does not bound them: they sit outside
/// the actor cap (spec section 9.5). Rust bounds them because each running job holds an OS thread. Queued jobs wait in
/// the owner, and a settled job starts the next one.
pub const WORLD_JOB_LIMIT: usize = 8;

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
/// the owner's mailbox handle that the outcomes are posted to. The owner drops its copy of the handle once the run has
/// settled and no job is left, so the mailbox can close.
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

/// Run one job on its own thread and post its outcome to the owner. A panic in a port becomes a `DriverError` for that
/// node, with the panic message. A thread that cannot be created also fails only that node.
pub(crate) fn spawn_world_job(wiring: &WorldWiring, job: WorldJob) {
    let done = wiring.done.clone();
    match job {
        WorldJob::Read { instance, op, args } => {
            let reads = Arc::clone(&wiring.reads);
            let cwd = wiring.cwd.clone();
            let fallback = done.clone();
            let failed_instance = instance.clone();
            let spawned = std::thread::Builder::new()
                .name("workflow-world-read".to_owned())
                .spawn(move || {
                    let result = catch_unwind(AssertUnwindSafe(|| {
                        execute_world_read(&cwd, reads.as_ref(), &op, &args)
                    }))
                    .unwrap_or_else(|payload| Err(panicked("the world read", payload.as_ref())));
                    let _ = done.post(ActorRequest::WorldSettled { instance, result });
                });
            if spawned.is_err() {
                // The closure was dropped with the failed spawn; the instance was cloned before the spawn.
                let _ = fallback.post(ActorRequest::WorldSettled {
                    instance: failed_instance,
                    result: Err(thread_failed("the world read")),
                });
            }
        }
        WorldJob::Publish { instance, request } => {
            let Some(artifacts) = wiring.artifacts.clone() else {
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
            let fallback = done.clone();
            let failed_instance = instance.clone();
            let spawned = std::thread::Builder::new()
                .name("workflow-artifact-publish".to_owned())
                .spawn(move || {
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
                    .unwrap_or_else(|payload| {
                        Err(panicked("the artifact publish", payload.as_ref()))
                    });
                    let _ = done.post(ActorRequest::ArtifactSettled { instance, result });
                });
            if spawned.is_err() {
                let _ = fallback.post(ActorRequest::ArtifactSettled {
                    instance: failed_instance,
                    result: Err(thread_failed("the artifact publish")),
                });
            }
        }
    }
}

/// The message of a panic payload, as `actor_turns` reads it.
fn panic_message(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a non-text panic".to_owned())
}

fn panicked(what: &str, payload: &(dyn Any + Send)) -> WorkflowError {
    WorkflowError::new(
        ErrorCode::DriverError,
        format!(
            "{what} panicked: {}; the node fails and the run continues.",
            panic_message(payload)
        ),
    )
}

fn thread_failed(what: &str) -> WorkflowError {
    WorkflowError::new(
        ErrorCode::DriverError,
        format!("{what} could not start a worker thread; the node fails and the run continues."),
    )
}
