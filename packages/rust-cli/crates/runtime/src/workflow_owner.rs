//! Fork: the production owner assembly of a workflow run (specs/fork-rust-workflow-engine.md, 9.30, W7-5a-5).
//!
//! An owner lives on its own thread (`workflow_run`), so it cannot borrow the app's session connection. Each owner opens
//! its own connections to the session database: one for the journal, one for the actor sessions. SQLite serialises the
//! writes between them, and the owner writes from one thread only.
//!
//! The turn side and the session release are refused until the run's agent bindings exist (9.30). A run's turns need the
//! parent's model selection, the workspace, the permission mode and the persona, and the launch does not carry them yet.
//! Until then a child's ask fails with a reason, and a close of an actor's session is refused, so nothing waits on a turn
//! that cannot start.
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use anyhow::{Result, anyhow};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_node_store::{MIGRATION_LOCK_WAIT, open_session_database};
use rust_cli_workflow::actor_sessions::NodeActorSessions;
use rust_cli_workflow::actor_turns::{TurnInput, TurnRunner};
use rust_cli_workflow::driver_owner::ActorDriverOwner;
use rust_cli_workflow::engine::EngineConfig;
use rust_cli_workflow::journal_dwf::DwfJournal;
use rust_cli_workflow::model_failure::TurnFailure;

use crate::workflow_assembly::{ActorSessionRelease, actor_turns};
use crate::workflow_run::{Hosted, HostedOwner, OwnerFactory};

/// The text of a refused turn or release. The owner reports it as the ask's failure, so a run says why it stopped.
const NOT_WIRED: &str = "the workflow actor's agent bindings are not wired in this build (specs/fork-rust-workflow-engine.md, 9.30)";

/// Where a production owner keeps its state and what it writes on the rows it creates.
#[derive(Clone)]
pub struct OwnerStores {
    /// The session database the app opened. Each owner opens its own connections to it.
    pub database: PathBuf,
    /// The run's workspace directory, written on each actor session row.
    pub directory: String,
    /// The writing build's version, written on each actor session row.
    pub version: String,
    /// The row timestamp source, in milliseconds.
    pub clock: fn() -> i64,
}

/// The turn side's runner until the agents' bindings are wired: every turn is refused.
pub struct UnwiredTurns;

/// The session release until the agents' bindings are wired: every release is refused.
pub struct UnwiredRelease;

impl TurnRunner for UnwiredTurns {
    fn run_turn(
        &self,
        _session: &str,
        _interaction: &str,
        _turn: &TurnInput,
        _cancel: &AtomicBool,
    ) -> std::result::Result<String, TurnFailure> {
        Err(TurnFailure {
            message: NOT_WIRED.to_owned(),
            model: None,
        })
    }
}

impl ActorSessionRelease for UnwiredRelease {
    fn release_actor_session(&self, child: &SessionId) -> std::result::Result<(), String> {
        Err(format!(
            "the actor's session {child} was not released: {NOT_WIRED}"
        ))
    }
}

/// The owner factory of a production run: each launch opens the owner's own connections, builds the owner over the
/// journal and the actor sessions, and hands it to the run service with its mailbox. A failure to open is the launch's
/// failure, so the child is stopped and nothing is left behind.
pub fn production_owner_factory<R: ActorSessionRelease>(
    stores: OwnerStores,
    runner: Arc<dyn TurnRunner>,
    release: Arc<R>,
) -> OwnerFactory {
    Arc::new(move |config: EngineConfig, mailbox, handle| {
        let journal_conn = open(&stores)?;
        let session_conn = open(&stores)?;
        let turns = actor_turns(runner.clone(), handle, release.clone());
        let sessions = NodeActorSessions::new(
            session_conn,
            &stores.directory,
            &stores.version,
            stores.clock,
            turns,
        );
        let journal = DwfJournal::new(journal_conn, stores.clock);
        let owner = ActorDriverOwner::new(config, journal, sessions)?;
        Ok(Box::new(Hosted::new(owner, mailbox)) as Box<dyn HostedOwner>)
    })
}

/// Opens one connection to the session database. The app opened it first, so the migrations are already applied; the
/// open here checks them again and does not change them.
fn open(stores: &OwnerStores) -> Result<rusqlite::Connection> {
    let now = ledger_ms((stores.clock)());
    let (conn, _) = open_session_database(&stores.database, MIGRATION_LOCK_WAIT, now)
        .map_err(|error| anyhow!("the session database did not open for the run: {error}"))?;
    Ok(conn)
}

/// The ledger's timestamp from a clock reading: a reading before the epoch is read as zero, so the ledger never gets a
/// negative time. The same rule as the app side's `now_ms`, which saturates into the range it can hold.
pub fn ledger_ms(reading: i64) -> u64 {
    u64::try_from(reading.max(0)).unwrap_or(0)
}

#[cfg(test)]
#[path = "workflow_owner_tests.rs"]
mod tests;
