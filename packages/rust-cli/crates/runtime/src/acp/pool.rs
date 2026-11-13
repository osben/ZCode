//! One resident ACP runtime per ZCode session (Node `AcpSessionPool`): reuse while the launch is unchanged,
//! restart a failed runtime, replace it when the launch changed. The binding (ACP session id, cwd, launch key) is
//! written after every acquire so a cold start can load the earlier ACP session.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rust_cli_acp::{
    AcpError, AcpErrorCode, AcpLaunch, AcpRuntime, AcpRuntimeOptions, AcpState, AcpTimeouts,
};
use rust_cli_base::sync::LockUnpoisoned as _;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::{AcpSessionBinding, Store, StoreError};
use rust_cli_proc::ledger::Ledger;

struct Resident {
    runtime: AcpRuntime,
    launch_key: String,
}

/// One session's runtime. Acquires and the release of one session run under its one permit (a semaphore, not a tokio
/// Mutex: the lint policy forbids holding a tokio MutexGuard across an await); `resident` is only touched under it.
struct SlotState {
    gate: tokio::sync::Semaphore,
    resident: Mutex<Option<Resident>>,
}

type Slot = Arc<SlotState>;

/// A slot taken for one acquire before the acquire runs (in its own task): a release that comes first closes the slot,
/// so the acquire starts nothing.
pub(crate) struct Reserved {
    session: SessionId,
    slot: Slot,
}

impl SlotState {
    fn new() -> Self {
        Self {
            gate: tokio::sync::Semaphore::new(1),
            resident: Mutex::new(None),
        }
    }
}

/// App-scoped. A session close releases its runtime; at exit a dropped runtime kills its process group.
pub(crate) struct AcpPool {
    env: Arc<[(String, String)]>,
    ledger: Ledger,
    store: Arc<dyn Store>,
    timeouts: AcpTimeouts,
    slots: Mutex<HashMap<SessionId, Slot>>,
}

impl AcpPool {
    pub(crate) fn new(env: Arc<[(String, String)]>, ledger: Ledger, store: Arc<dyn Store>) -> Self {
        Self {
            env,
            ledger,
            store,
            timeouts: AcpTimeouts::default(),
            slots: Mutex::new(HashMap::new()),
        }
    }

    /// Takes the session's slot now, for an acquire that runs later.
    pub(crate) fn reserve(&self, session: &SessionId) -> Reserved {
        Reserved {
            session: session.clone(),
            slot: self.slot(session),
        }
    }

    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.slots.lock_unpoisoned().is_empty()
    }

    /// Whether an acquire of the session holds its permit right now.
    #[cfg(test)]
    fn is_acquiring(&self, session: &SessionId) -> bool {
        self.slots
            .lock_unpoisoned()
            .get(session)
            .is_some_and(|slot| slot.gate.available_permits() == 0)
    }

    fn slot(&self, session: &SessionId) -> Slot {
        self.slots
            .lock_unpoisoned()
            .entry(session.clone())
            .or_insert_with(|| Arc::new(SlotState::new()))
            .clone()
    }

    /// Node `acquire`, serialized per session.
    pub(crate) async fn acquire(
        &self,
        reserved: Reserved,
        launch: AcpLaunch,
    ) -> Result<AcpRuntime, AcpError> {
        let Reserved { session, slot } = reserved;
        let session = &session;
        let launch_key = rust_cli_acp::launch_key(&launch);
        let _permit =
            slot.gate.acquire().await.map_err(|_| {
                AcpError::new(AcpErrorCode::AgentDied, "the ACP session was released")
            })?;
        let current = slot
            .resident
            .lock_unpoisoned()
            .as_ref()
            .map(|current| (current.runtime.clone(), current.launch_key.clone()));
        if let Some((runtime, key)) = &current
            && *key == launch_key
            && runtime.state() != AcpState::Stopped
        {
            if runtime.state() == AcpState::Failed {
                runtime.restart().await?;
            }
            self.record(session, &launch, &launch_key, runtime).await;
            return Ok(runtime.clone());
        }
        let previous = slot.resident.lock_unpoisoned().take();
        if let Some(previous) = previous {
            previous.runtime.stop().await;
        }
        let resume_session_id = self.resume_target(session, &launch, &launch_key).await;
        let runtime = AcpRuntime::start(AcpRuntimeOptions {
            launch: launch.clone(),
            env_snapshot: self.env.clone(),
            ledger: self.ledger.clone(),
            resume_session_id,
            timeouts: self.timeouts,
        })
        .await?;
        *slot.resident.lock_unpoisoned() = Some(Resident {
            runtime: runtime.clone(),
            launch_key: launch_key.clone(),
        });
        self.record(session, &launch, &launch_key, &runtime).await;
        Ok(runtime)
    }

    /// The ACP session to load: the binding's, when the agent, the cwd and the launch key all match. A binding that
    /// does not match is cleared (Node `acquire`).
    async fn resume_target(
        &self,
        session: &SessionId,
        launch: &AcpLaunch,
        launch_key: &str,
    ) -> Option<String> {
        let binding = match self.store.acp_binding(session).await {
            Ok(binding) => binding?,
            Err(error) => {
                tracing::warn!(event = "acp.binding_read_failed", %error, "ACP session binding could not be read");
                return None;
            }
        };
        if binding.agent_id == launch.agent_id
            && binding.cwd == launch.cwd
            && binding.launch_key == launch_key
        {
            return Some(binding.acp_session_id);
        }
        if let Err(error) = self.store.clear_acp_binding(session).await {
            tracing::warn!(event = "acp.binding_clear_failed", %error, "stale ACP session binding could not be cleared");
        }
        None
    }

    /// Node `recordBinding`: written after every acquire; a failed write clears the binding so a later cold start
    /// does not load a session this one replaced.
    async fn record(
        &self,
        session: &SessionId,
        launch: &AcpLaunch,
        launch_key: &str,
        runtime: &AcpRuntime,
    ) {
        let Some(acp_session_id) = runtime.session_id() else {
            return;
        };
        let binding = AcpSessionBinding {
            agent_id: launch.agent_id.clone(),
            acp_session_id,
            cwd: launch.cwd.clone(),
            launch_key: launch_key.to_owned(),
        };
        match self.store.set_acp_binding(session, &binding).await {
            Ok(()) => {}
            Err(StoreError::Unsupported { .. }) => {
                tracing::debug!(
                    event = "acp.binding_unsupported",
                    "the session database has no ACP binding tables"
                );
            }
            Err(error) => {
                tracing::warn!(event = "acp.binding_write_failed", %error, "ACP session binding could not be written");
                let _ = self.store.clear_acp_binding(session).await;
            }
        }
    }

    /// Releases the session's agent process (Node `stopSession`): the slot leaves the pool at once, so an open of the
    /// same session that follows starts its own runtime; the process stops in the returned future. Safe to call
    /// repeatedly.
    pub(crate) fn release(&self, session: &SessionId) -> impl Future<Output = ()> + Send + 'static {
        let slot = self.slots.lock_unpoisoned().remove(session);
        async move {
            let Some(slot) = slot else {
                return;
            };
            // An acquire still starting finishes first; its runtime is the one stopped here.
            let Ok(_permit) = slot.gate.acquire().await else {
                return;
            };
            // Closed: an acquire that reserved this slot and has not run yet fails instead of starting an agent that
            // nothing would stop.
            slot.gate.close();
            let resident = slot.resident.lock_unpoisoned().take();
            if let Some(resident) = resident {
                resident.runtime.stop().await;
            }
        }
    }
}

#[cfg(test)]
#[path = "pool_tests.rs"]
mod tests;
