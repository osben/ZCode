//! Fork: the production owner assembly of a workflow run (specs/fork-rust-workflow-engine.md, 9.30, W7-5a-5; the actor
//! bindings of 9.33).
//!
//! An owner lives on its own thread (`workflow_run`), so it cannot borrow the app's session connection. Each owner opens
//! its own connections to the session database: one for the journal, one for the actor sessions, one for the actor
//! settings. SQLite serialises the writes between them, and the owner writes from one thread only.
//!
//! The unwired factory refuses every turn and every release (`production_owner_factory`, 9.30). The bound factory
//! (`bound_owner_factory`, 9.33) runs the turns on the agents: each actor's model is resolved when its session is created,
//! in Node's order (persona model, run model, journaled pin, parent's selection), and written to its journal row.
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use anyhow::{Result, anyhow};
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::orchestration::Interactions;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_node_store::{MIGRATION_LOCK_WAIT, open_session_database};
use rust_cli_workflow::actor_sessions::NodeActorSessions;
use rust_cli_workflow::actor_turns::{TurnInput, TurnRunner};
use rust_cli_workflow::driver_owner::{ActorDriverOwner, ActorSessionRequest, ActorSessions};
use rust_cli_workflow::driver_rules::subagent_permission_mode_of;
use rust_cli_workflow::engine::{AskMessage, EngineConfig};
use rust_cli_workflow::event::LaunchFields;
use rust_cli_workflow::journal::JournalPort;
use rust_cli_workflow::journal_dwf::DwfJournal;
use rust_cli_workflow::model::{Ref, StoredEvent};
use rust_cli_workflow::model_failure::TurnFailure;
use serde_json::{Map, Value};

use crate::actor_turns::{
    ActorAgents, ActorRunBase, ActorSettings, ActorSettingsMap, AgentTurnRunner,
    actor_permission_mode,
};
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

/// What a parent session gives the turns of the runs it launches (9.33): the model selection its children inherit, the
/// workspace, and the parent's interactions channel.
pub struct ParentBindings {
    /// The parent's current model selection. None when the parent has none: an actor with no override then has no
    /// selection and its turns are refused (Node `requireActorModelSelection`).
    pub selection: Option<ModelSelection>,
    pub workspace: WorkspaceRef,
    pub interactions: Option<Arc<dyn Interactions>>,
}

/// Reads a parent session's bindings. The composition implements it over the session store. It is read at the launch
/// (the workspace and the interactions) and again when each actor's session is created (the selection).
pub trait ActorBindingsPort: Send + Sync + 'static {
    /// The bindings of `parent`: Ok(None) when the session is not known, Err when the read failed.
    fn parent_bindings(&self, parent: &str) -> std::result::Result<Option<ParentBindings>, String>;

    /// The parent's permission mode now, read once when a run is launched from it (9.35, Node `permissionMode()` at
    /// submit). Ok(None) when the port has no mode to read (a port with no store): the launch then records no mode.
    /// Err when the read failed or the session is not known: the launch is refused, never recorded as absent.
    fn parent_permission_mode(
        &self,
        parent: &str,
    ) -> std::result::Result<Option<PermissionMode>, String> {
        let _ = parent;
        Ok(None)
    }
}

/// Fork (9.35, divergence 273): records the parent's permission mode on a launch, as Node's submit records the session's
/// mode at the moment the run is created (`workflowSubagentPermissionModeField`). Resume never calls this. Every session
/// mode has a recordable name (plan reads as build).
///
/// Fail closed: a port that cannot read the parent's mode returns Err, and this returns it, so the launch is refused and
/// nothing is recorded. Only a port with no mode to read (Ok(None)) records nothing, and then the actors read YOLO.
///
/// The port blocks on the store (`Handle::block_on`), so the caller must be off the async workers: call this from a
/// blocking thread (the launch path does its reads on the blocking pool), never from an async task.
pub fn record_parent_mode(
    config: &mut EngineConfig,
    bindings: &dyn ActorBindingsPort,
) -> std::result::Result<(), String> {
    let Some(parent) = config.parent_session_id.as_deref() else {
        return Ok(());
    };
    // Fail closed: a read error refuses the launch (Err), and nothing is recorded, so no actor reads YOLO by default.
    let Some(mode) = bindings.parent_permission_mode(parent)? else {
        return Ok(());
    };
    let recorded =
        subagent_permission_mode_of(Some(mode.node_name())).map(|mode| mode.as_str().to_owned());
    config
        .launch
        .get_or_insert_with(LaunchFields::default)
        .subagent_permission_mode = recorded;
    Ok(())
}

/// Node `parseModelPickerValue`: `provider/model`, with an optional `$reasoning` after the model.
fn parse_picker(value: &str) -> std::result::Result<ModelSelection, String> {
    let normalized = value.trim();
    let slash = match normalized.find('/') {
        Some(index) if index > 0 => index,
        _ => return Err(format!("the model selection has no provider: {normalized}")),
    };
    let provider = &normalized[..slash];
    let rest = &normalized[slash + 1..];
    if rest.is_empty() {
        return Err(format!("the model selection has no model: {normalized}"));
    }
    Ok(match rest.find('$') {
        Some(dollar) if dollar > 0 && dollar + 1 < rest.len() => {
            let mut selection = ModelSelection::new(provider, &rest[..dollar]);
            selection.reasoning = Some(rest[dollar + 1..].to_owned());
            selection
        }
        _ => ModelSelection::new(provider, rest),
    })
}

/// The journal's `resolvedModel` text, `providerId/modelId` (Node `formatActorResolvedModel`).
fn format_resolved(selection: &ModelSelection) -> String {
    format!("{}/{}", selection.provider, selection.model)
}

/// Two selections name the same model (Node `sameModelIdentity`): provider and model, not the reasoning.
fn same_model(a: &ModelSelection, b: &ModelSelection) -> bool {
    a.provider == b.provider && a.model == b.model
}

/// The launch facts a run's actors read (Node `subagentModel`, `modelBindings`, `subagentPermissionMode`). A launch
/// that carries its fields uses them. A resume (no launch) reads the run's journaled `run-launched` event, as Node does,
/// so a resumed run keeps the mode and models it was launched with.
#[derive(Default)]
struct LaunchFacts {
    subagent_model: Option<ModelSelection>,
    subagent_permission_mode: Option<String>,
    model_bindings: Option<Map<String, Value>>,
}

fn launch_facts(config: &EngineConfig, journaled: &[StoredEvent]) -> Result<LaunchFacts> {
    let event = journaled
        .iter()
        .filter_map(|stored| serde_json::from_str::<Value>(&stored.payload_json).ok())
        .find(|event| event.get("type").and_then(Value::as_str) == Some("run-launched"));
    let journaled_text = |key: &str| {
        event
            .as_ref()
            .and_then(|event| event.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let journaled_bindings = event
        .as_ref()
        .and_then(|event| event.get("modelBindings"))
        .and_then(Value::as_object)
        .cloned();
    // Node: the mode is the launch's when there is one, and the journal's otherwise. The models fall back per field.
    let (subagent_model, subagent_permission_mode, model_bindings) = match &config.launch {
        Some(launch) => (
            launch
                .subagent_model
                .clone()
                .or_else(|| journaled_text("subagentModel")),
            launch.subagent_permission_mode.clone(),
            launch
                .model_bindings
                .as_ref()
                .and_then(Value::as_object)
                .cloned()
                .or(journaled_bindings),
        ),
        None => (
            journaled_text("subagentModel"),
            journaled_text("subagentPermissionMode"),
            journaled_bindings,
        ),
    };
    let subagent_model = match subagent_model {
        Some(text) => Some(parse_picker(&text).map_err(|error| anyhow!(error))?),
        None => None,
    };
    Ok(LaunchFacts {
        subagent_model,
        subagent_permission_mode,
        model_bindings,
    })
}

/// Records each actor's settings when its session is created, then forwards every call. The settings are the actor's
/// persona prompt and its model (Node `runtimeFactory`'s model surface, `workflow-actor-model.ts`): the persona's model
/// first, then the run's model, then the model the actor was journaled with (resume), then the parent's selection read
/// now. The model is journaled on the actor's row, as Node's `journalActorResolvedModel` does (9.33).
struct SettingsRecording<S> {
    inner: S,
    settings: ActorSettingsMap,
    bindings: Arc<dyn ActorBindingsPort>,
    parent: String,
    run_id: String,
    facts: LaunchFacts,
    journal: DwfJournal<rusqlite::Connection>,
}

impl<S: ActorSessions> SettingsRecording<S> {
    /// The model an actor's session runs on. Refusals leave no session behind: nothing is created before this returns.
    fn resolve_model(&mut self, request: &ActorSessionRequest) -> Result<Option<ModelSelection>> {
        let persona_model = match request.persona.get("model").and_then(Value::as_str) {
            None => None,
            Some(name) => {
                let canonical = self
                    .facts
                    .model_bindings
                    .as_ref()
                    .and_then(|table| table.get(name))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        anyhow!(
                            "this subagent's persona names the model \"{name}\", which the run did not resolve at launch"
                        )
                    })?;
                Some(parse_picker(canonical).map_err(|error| anyhow!(error))?)
            }
        };
        if persona_model.is_some() {
            return Ok(persona_model);
        }
        if self.facts.subagent_model.is_some() {
            return Ok(self.facts.subagent_model.clone());
        }
        let current = self
            .bindings
            .parent_bindings(&self.parent)
            .map_err(|error| anyhow!(error))?
            .ok_or_else(|| {
                anyhow!(
                    "the parent session {} is not known: its bindings are not read",
                    self.parent
                )
            })?
            .selection;
        // Node `currentRunPin ?? seed?.resolvedModel`: the run's own pin (a resume), else the predecessor's pin the
        // actor was seeded with (an amend-resume's first live dispatch).
        let own = match self.journal.get_actor(&self.run_id, &request.actor)? {
            Some(row) => row.resolved_model,
            None => None,
        };
        let pin_text = own.or_else(|| {
            request
                .seed
                .as_ref()
                .and_then(|seed| seed.resolved_model.clone())
        });
        let pin = match pin_text {
            Some(text) => Some(parse_picker(&text).map_err(|error| anyhow!(error))?),
            None => None,
        };
        Ok(match (pin, current) {
            // The pin is the parent's model already: inherit the parent's selection, reasoning included.
            (Some(pin), Some(current)) if same_model(&pin, &current) => Some(current),
            (Some(pin), _) => Some(pin),
            (None, current) => current,
        })
    }

    /// Journals the resolved model on the actor's row, when the row exists. The engine carries the field forward.
    fn journal_model(&mut self, actor: &Ref, selection: &ModelSelection) -> Result<()> {
        if let Some(mut row) = self.journal.get_actor(&self.run_id, actor)? {
            row.resolved_model = Some(format_resolved(selection));
            self.journal.put_actor(row)?;
        }
        Ok(())
    }
}

impl<S: ActorSessions> ActorSessions for SettingsRecording<S> {
    fn create_session(&mut self, request: &ActorSessionRequest) -> Result<String> {
        let selection = self.resolve_model(request)?;
        let session = self.inner.create_session(request)?;
        if let Some(selection) = &selection {
            self.journal_model(&request.actor, selection)?;
        }
        let persona = request
            .persona
            .get("system")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        self.settings
            .record(&session, ActorSettings { persona, selection });
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

/// The owner factory of a run whose actor turns run on the agents (9.33). Each launch reads its parent's bindings, the
/// launch facts (its own, or the journal's on a resume), and builds the turn side: the workspace and interactions as read
/// at launch, the run's recorded permission mode, and each actor's persona and model as resolved when its session is
/// created. The session release is the agents'.
///
/// A parent the bindings port does not know refuses the launch (its owner is not built). An actor whose resolved model is
/// none is refused at each of its asks; the run goes on, and an actor created later can still run.
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
        let found = bindings
            .parent_bindings(&parent)
            .map_err(|error| anyhow!(error))?
            .ok_or_else(|| {
                anyhow!("the parent session {parent} is not known: its bindings are not read")
            })?;
        let run_id = config.run_id.clone();
        let journal = DwfJournal::new(open(&stores)?, stores.clock);
        let journaled = journal.list_events(&run_id)?;
        let facts = launch_facts(&config, &journaled)?;
        let mode = actor_permission_mode(
            facts
                .subagent_permission_mode
                .clone()
                .map(Value::String)
                .as_ref(),
        );
        // The base's selection is the fallback for a runner with no settings; every actor of this run has settings, so
        // each turn takes its own actor's selection.
        let base = ActorRunBase {
            parent: SessionId::new(&parent),
            workspace: found.workspace,
            selection: None,
            mode,
            persona_prompt: String::new(),
            interactions: found.interactions,
            clock: clock.clone(),
            admission_run: None,
        }
        .for_run(&run_id);
        let settings = ActorSettingsMap::default();
        let runner =
            AgentTurnRunner::new(agents.clone(), handle.clone(), base, actor_handle.clone())
                .with_settings(settings.clone());
        let session_conn = open(&stores)?;
        let settings_journal = DwfJournal::new(open(&stores)?, stores.clock);
        let sessions = SettingsRecording {
            inner: NodeActorSessions::new(
                session_conn,
                &stores.directory,
                &stores.version,
                stores.clock,
                actor_turns(Arc::new(runner), actor_handle, agents.clone()),
            ),
            settings,
            bindings: bindings.clone(),
            parent,
            run_id,
            facts,
            journal: settings_journal,
        };
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
