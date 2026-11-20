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
use rust_cli_workflow::driver_owner::{ActorDriverOwner, ActorSessionRequest, ActorSessions};
use rust_cli_workflow::engine::{AskMessage, EngineConfig};
use rust_cli_workflow::journal_dwf::DwfJournal;
use rust_cli_workflow::model::Ref;
use rust_cli_workflow::model_failure::TurnFailure;
use serde_json::Value;

use crate::actor_turns::{
    ActorAgents, ActorRunBase, AgentTurnRunner, PersonaPrompts, actor_permission_mode,
};
use crate::workflow_assembly::{ActorSessionRelease, actor_turns};
use crate::workflow_run::{Hosted, HostedOwner, OwnerFactory};
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::orchestration::Interactions;
use rust_cli_kernel_api::permission::PermissionMode;

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

/// What a parent session gives the turns of the runs it launches (9.33, Node `createActorRuntime`'s bindings): the
/// model selection the child inherits, the workspace, and the parent's interactions channel.
pub struct ParentBindings {
    /// The parent's current model selection. None when the parent has none: a child's turn is refused then (Node
    /// `requireActorModelSelection`).
    pub selection: Option<ModelSelection>,
    pub workspace: WorkspaceRef,
    pub interactions: Option<Arc<dyn Interactions>>,
}

/// Reads a parent session's bindings at launch. The composition implements it over the session store.
pub trait ActorBindingsPort: Send + Sync + 'static {
    /// The bindings of `parent`, or None when the session is not known (the launch is then refused).
    fn parent_bindings(&self, parent: &str) -> Option<ParentBindings>;
}

/// The text of a turn refused because the parent has no model selection to inherit (Node `requireActorModelSelection`).
const NO_SELECTION: &str =
    "the actor's session has no model selection: the parent session has none for it to inherit";

/// The turn side of a child whose parent has no model selection: every turn is refused, as Node's runtime factory
/// refuses to build the actor's runtime. The run itself goes on.
pub struct NoSelectionTurns;

impl TurnRunner for NoSelectionTurns {
    fn run_turn(
        &self,
        _session: &str,
        _interaction: &str,
        _turn: &TurnInput,
        _cancel: &AtomicBool,
    ) -> std::result::Result<String, TurnFailure> {
        Err(TurnFailure::plain(NO_SELECTION))
    }
}

/// Records each created session's persona system prompt, then forwards every call. The turn side reads the prompt
/// per session, so a run with several personas gives each actor its own (9.33).
struct PersonaRecording<S> {
    inner: S,
    personas: PersonaPrompts,
}

impl<S: ActorSessions> ActorSessions for PersonaRecording<S> {
    fn create_session(&mut self, request: &ActorSessionRequest) -> Result<String> {
        let session = self.inner.create_session(request)?;
        let prompt = request
            .persona
            .get("system")
            .and_then(Value::as_str)
            .unwrap_or_default();
        self.personas.record(&session, prompt.to_owned());
        Ok(session)
    }

    fn start_turn(
        &mut self,
        session: &str,
        instance: &Ref,
        message: &AskMessage,
        input: &TurnInput,
        interaction: &str,
    ) -> Result<()> {
        self.inner
            .start_turn(session, instance, message, input, interaction)
    }

    fn cancel_turn(&mut self, session: &str, instance: &Ref) -> Result<()> {
        self.inner.cancel_turn(session, instance)
    }

    fn reject_parked(&mut self, session: &str, qid: &str) -> Result<()> {
        self.inner.reject_parked(session, qid)
    }

    fn deliver_answer(&mut self, session: &str, qid: &str, answer: &str) -> Result<()> {
        self.inner.deliver_answer(session, qid, answer)
    }

    fn close_session(&mut self, session: &str) -> Result<()> {
        self.inner.close_session(session)
    }

    fn take_close_failures(&mut self) -> Vec<(String, String)> {
        self.inner.take_close_failures()
    }
}

/// The permission mode a run's actors use: the mode the launch recorded (Node `subagentPermissionMode`), never the
/// parent's current mode. A launch that recorded none is YOLO, as Node reads an absent value (`actor_permission_mode`).
fn recorded_mode(config: &EngineConfig) -> PermissionMode {
    let recorded = config
        .launch
        .as_ref()
        .and_then(|launch| launch.subagent_permission_mode.clone())
        .map(Value::String);
    actor_permission_mode(recorded.as_ref())
}

/// The owner factory of a run whose actor turns run on the agents (9.33). Each launch reads its parent's bindings, then
/// builds the turn side over them: the parent's model selection, workspace and interactions, the run's recorded
/// permission mode, and the persona of each actor. The session release is the agents'.
///
/// A parent the bindings port does not know refuses the launch (its owner is not built). A parent with no model
/// selection starts the run, and its actors' turns are refused at their asks (`NoSelectionTurns`).
pub fn bound_owner_factory<A: ActorAgents + ActorSessionRelease>(
    stores: OwnerStores,
    agents: Arc<A>,
    handle: tokio::runtime::Handle,
    bindings: Arc<dyn ActorBindingsPort>,
    clock: Arc<dyn Clock>,
) -> OwnerFactory {
    Arc::new(move |config: EngineConfig, mailbox, actor_handle| {
        let parent = config
            .parent_session_id
            .clone()
            .ok_or_else(|| anyhow!("a run without a parent session has no bindings"))?;
        let found = bindings.parent_bindings(&parent).ok_or_else(|| {
            anyhow!("the parent session {parent} is not known: its bindings are not read")
        })?;
        let personas = PersonaPrompts::default();
        let turns: Arc<dyn TurnRunner> = match found.selection {
            Some(selection) => {
                let base = ActorRunBase {
                    parent: SessionId::new(&parent),
                    workspace: found.workspace,
                    selection,
                    mode: recorded_mode(&config),
                    persona_prompt: String::new(),
                    interactions: found.interactions,
                    clock: clock.clone(),
                    admission_run: None,
                }
                .for_run(&config.run_id);
                Arc::new(
                    AgentTurnRunner::new(
                        agents.clone(),
                        handle.clone(),
                        base,
                        actor_handle.clone(),
                    )
                    .with_personas(personas.clone()),
                )
            }
            None => Arc::new(NoSelectionTurns),
        };
        let journal_conn = open(&stores)?;
        let session_conn = open(&stores)?;
        let sessions = PersonaRecording {
            inner: NodeActorSessions::new(
                session_conn,
                &stores.directory,
                &stores.version,
                stores.clock,
                actor_turns(turns, actor_handle, agents.clone()),
            ),
            personas,
        };
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
