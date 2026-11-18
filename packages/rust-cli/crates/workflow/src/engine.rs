//! The workflow engine (Node `engine/engine.ts` with `engine-settlement.ts`, `engine-resume.ts`,
//! `identity` and the scheduler): run creation or resume, the ask lifecycle, settlement and usage.
//!
//! The engine reads no clock and draws no random numbers. Its only I/O is the journal port and the
//! driver port. Node's promises are modelled explicitly:
//! - an ask returns a ticket, and its settlement is pushed to an outcome queue (`take_outcomes`), in
//!   the order Node's promise reactions would run;
//! - work Node does after an `await` or `queueMicrotask` is a `Job` in a FIFO queue. The host calls
//!   `drain` after each synchronous slice of script calls, as the JavaScript event loop does between
//!   turns. A first dispatch of an actor takes two jobs (session ready, then dispatch), a later one one
//!   job, matching the promise hops of `ensureSession`.
//!
//! Holes, artifacts, reports and the process-level governor are not here yet (spec 9.3 and 9.5). The import
//! cache and world reads are (W5b, spec 9.5).
use crate::engine_world::WorldLive;
use crate::error::{ErrorCode, WorkflowError};
use crate::event::{LaunchFields, RunEvent};
use crate::identity::Identity;
use crate::imported_cache::{
    ActorSessionSeed, ImportedRunCache, ImportedWorldQueue, match_imported_actor,
};
use crate::journal::JournalPort;
use crate::model::{
    ActorRow, Caps, Ref, RunRow, RunStatus, Settlement, StopReason, StoredEvent, Violation,
};
use crate::persona::normalize_persona;
use crate::replay::{Job, Release, ReplayGate};
use crate::scheduler::{Actor, AskNode};
use anyhow::Result;
use rust_cli_base::js::string::{trim as js_trim, utf16_len, utf16_prefix};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

/// Injected validator (Node `ValidateFn`): an empty list means the value is valid.
pub type ValidateFn = fn(&Value, &Value) -> Vec<Violation>;

/// Node `AskSpec`: whether the site is typed, and its schema when it is.
#[derive(Debug, Clone, PartialEq)]
pub struct AskSpec {
    pub typed: bool,
    pub schema: Option<Value>,
}

/// Node `AskStats`: usage the driver reports for one ask. `world_tool_calls` is absent for old rows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AskStats {
    pub tokens: f64,
    pub tool_calls: f64,
    pub turns: f64,
    pub world_tool_calls: Option<f64>,
}

impl AskStats {
    /// The stats object in Node's key order.
    pub fn to_json(self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("tokens".into(), crate::model::js_number(self.tokens));
        map.insert("toolCalls".into(), crate::model::js_number(self.tool_calls));
        map.insert("turns".into(), crate::model::js_number(self.turns));
        if let Some(world) = self.world_tool_calls {
            map.insert("worldToolCalls".into(), crate::model::js_number(world));
        }
        Value::Object(map)
    }
}

/// Node `SubmitVerdict`, the answer the driver gives a submit or a turn end.
#[derive(Debug, Clone, PartialEq)]
pub enum SubmitVerdict {
    Accept,
    Reject { violations: Vec<Violation> },
    Nudge,
}

/// Node `AskMessage`: what the driver is told to run.
#[derive(Debug, Clone, PartialEq)]
pub struct AskMessage {
    pub instructions: String,
    pub typed: bool,
    pub schema: Option<Value>,
}

/// Node `EngineConfig`, for the fields the scheduler and the lifecycle use. `Default` is manual because
/// `validate` is a function pointer, which has no default.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub run_id: String,
    pub caps: Caps,
    pub ask_specs: HashMap<String, AskSpec>,
    pub validate: ValidateFn,
    pub site_phases: HashMap<String, String>,
    pub script_text: Option<String>,
    pub script_hash: Option<String>,
    pub name: Option<String>,
    pub args: Option<Value>,
    pub parent_session_id: Option<String>,
    pub cwd: Option<String>,
    pub tool_call_id: Option<String>,
    pub resumed_from: Option<String>,
    /// Host metadata for `run-launched`; the origin fields come from this config (as in Node).
    pub launch: Option<LaunchFields>,
    pub inherited_tokens: Option<f64>,
    /// The amend-resume import cache (Node `importedCache`), built by `import_build`. Absent for a run that
    /// is not amended.
    pub imported_cache: Option<ImportedRunCache>,
}

fn no_validation(_schema: &Value, _value: &Value) -> Vec<Violation> {
    Vec::new()
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            run_id: String::new(),
            caps: Caps::default(),
            ask_specs: HashMap::new(),
            validate: no_validation,
            site_phases: HashMap::new(),
            script_text: None,
            script_hash: None,
            name: None,
            args: None,
            parent_session_id: None,
            cwd: None,
            tool_call_id: None,
            resumed_from: None,
            launch: None,
            inherited_tokens: None,
            imported_cache: None,
        }
    }
}

/// The driver side of the port: session creation, asks, submit verdicts, cancellation and event fan-out
/// (Node `WorkflowDriver`, without the journal, which the engine owns).
pub trait WorkflowDriver {
    /// Create (or reattach) the session of an actor and return its id. `seed` is the transcript a diverged
    /// actor continues from (Node `ActorSessionSeed`), when there is one.
    fn create_actor_session(
        &mut self,
        actor: &Ref,
        persona: &Value,
        seed: Option<&ActorSessionSeed>,
    ) -> anyhow::Result<String>;
    fn start_ask(&mut self, session: &str, instance: &Ref, message: &AskMessage);
    fn respond_to_submit(&mut self, instance: &Ref, verdict: &SubmitVerdict);
    fn cancel_ask(&mut self, instance: &Ref);
    /// Execute a live world read or run (Node `executeWorldRead`). The result comes back through
    /// `WorkflowEngine::world_read_settled` with the same instance.
    fn start_world_read(&mut self, instance: &Ref, op: &str, args: &Value);
    fn emit(&mut self, event: &RunEvent);
    fn dispose(&mut self) {}
}

impl<T: WorkflowDriver + ?Sized> WorkflowDriver for &mut T {
    fn create_actor_session(
        &mut self,
        actor: &Ref,
        persona: &Value,
        seed: Option<&ActorSessionSeed>,
    ) -> anyhow::Result<String> {
        (**self).create_actor_session(actor, persona, seed)
    }

    fn start_world_read(&mut self, instance: &Ref, op: &str, args: &Value) {
        (**self).start_world_read(instance, op, args);
    }

    fn start_ask(&mut self, session: &str, instance: &Ref, message: &AskMessage) {
        (**self).start_ask(session, instance, message);
    }

    fn respond_to_submit(&mut self, instance: &Ref, verdict: &SubmitVerdict) {
        (**self).respond_to_submit(instance, verdict);
    }

    fn cancel_ask(&mut self, instance: &Ref) {
        (**self).cancel_ask(instance);
    }

    fn emit(&mut self, event: &RunEvent) {
        (**self).emit(event);
    }

    fn dispose(&mut self) {
        (**self).dispose();
    }
}

/// Final run settlement (Node `RunSettlement`). `error` is the journal shape of the run error.
#[derive(Debug, Clone, PartialEq)]
pub enum RunSettlement {
    Completed {
        artifact: Value,
    },
    Errored {
        error: Value,
    },
    Stopped {
        reason: StopReason,
        superseded_by: Option<String>,
        error: Option<Value>,
    },
}

/// The settlement of one ask ticket, in the order the promise would have settled (Node `deferred`).
#[derive(Debug, Clone, PartialEq)]
pub struct AskOutcome {
    pub ticket: u64,
    pub result: Result<Value, WorkflowError>,
}

/// Node `DriverError` text for a failed session: the cause, trimmed and bounded (`describeCause`).
/// The bound counts UTF-16 units, as `String.prototype.slice` does. A surrogate pair straddling unit 300
/// is dropped whole; see `scheduler::instructions_head` for the same deviation.
pub fn describe_cause(text: &str) -> String {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return "unknown error".to_owned();
    }
    if utf16_len(trimmed) > 300 {
        return format!("{}…", utf16_prefix(trimmed, 300));
    }
    trimmed.to_owned()
}

pub struct WorkflowEngine<J: JournalPort, D: WorkflowDriver> {
    pub(crate) run_id: String,
    pub(crate) journal: J,
    pub(crate) driver: D,
    pub(crate) caps: Caps,
    pub(crate) spent_tokens: f64,
    pub(crate) settled: bool,
    pub(crate) settlement: Option<RunSettlement>,
    pub(crate) run_failure: Option<WorkflowError>,
    pub(crate) ask_specs: HashMap<String, AskSpec>,
    pub(crate) validate: ValidateFn,
    pub(crate) identity: Identity,
    pub(crate) actors: HashMap<String, Actor>,
    pub(crate) actor_order: Vec<String>,
    pub(crate) actor_names: HashMap<String, String>,
    /// Live asks in admission order (Node `liveNodes` insertion order), keyed by node id.
    pub(crate) live: BTreeMap<u64, AskNode>,
    pub(crate) live_index: HashMap<String, u64>,
    pub(crate) next_node_id: u64,
    /// Instances whose transcript predates this dispatch (Node `priorTranscriptAsks`).
    pub(crate) prior_transcript: HashSet<String>,
    /// Ask rows already recorded per actor (Node `recordedAsks`), read once at resume.
    pub(crate) recorded_asks: HashMap<String, u64>,
    pub(crate) active_asks: f64,
    pub(crate) gate: ReplayGate,
    pub(crate) jobs: VecDeque<Job>,
    pub(crate) outcomes: Vec<AskOutcome>,
    next_ticket: u64,
    /// The amend-resume import cache (Node `importedCache`); absent for a run that is not amended.
    pub(crate) imported_cache: Option<ImportedRunCache>,
    /// Consumption cursors of the world import queue (Node `importedWorld`).
    pub(crate) imported_world: ImportedWorldQueue,
    /// Whether the import cache is closed. It never reopens. Resume restores it from the closure event.
    pub(crate) import_closed: bool,
    /// Asks admitted while the cache was still open (Node `queuedBeforeImportClose`, resume only).
    pub(crate) queued_before_close: HashSet<String>,
    /// Asks that ran live in an earlier lifetime (Node `liveAskInstances`, resume only).
    pub(crate) live_before_resume: HashSet<String>,
    /// World nodes the driver is executing, by instance key.
    pub(crate) world_live: HashMap<String, WorldLive>,
}

impl<J: JournalPort, D: WorkflowDriver> WorkflowEngine<J, D> {
    /// Create the run, or resume it when the journal already has a row for `run_id` (Node constructor).
    ///
    /// Fails with `ScriptHashMismatch` before any write when a resumed script differs from the recorded
    /// one. The check runs only when both hashes are present.
    pub fn new(config: EngineConfig, mut journal: J, driver: D) -> Result<Self> {
        let existing = journal.get_run(&config.run_id)?;
        let spent_tokens = match &existing {
            None => {
                let spent_tokens = normalize_inherited(config.inherited_tokens);
                journal.create_run(RunRow {
                    run_id: config.run_id.clone(),
                    parent_session_id: config.parent_session_id.clone(),
                    cwd: config.cwd.clone(),
                    name: config.name.clone(),
                    tool_call_id: config.tool_call_id.clone(),
                    script_text: config.script_text.clone(),
                    script_hash: config.script_hash.clone(),
                    args: config.args.clone(),
                    resumed_from: config.resumed_from.clone(),
                    caps: config.caps,
                    spent_tokens,
                    status: RunStatus::Running,
                    stop_reason: None,
                    superseded_by: None,
                    failure: None,
                    result: None,
                })?;
                spent_tokens
            }
            Some(row) => {
                if let (Some(recorded), Some(got)) = (&row.script_hash, &config.script_hash)
                    && recorded != got
                {
                    let error = WorkflowError::new(
                        ErrorCode::ScriptHashMismatch,
                        format!(
                            "Cannot resume run {}: its script changed (recorded hash {recorded}, got {got}). Resume needs the byte-identical script; to run a revised script, start a new run with resume_from instead.",
                            config.run_id
                        ),
                    )
                    .with_mismatch(recorded.clone(), got.clone());
                    return Err(error.into());
                }
                journal.update_run_status(
                    &config.run_id,
                    RunStatus::Running,
                    &Settlement::default(),
                )?;
                row.spent_tokens
            }
        };
        let mut engine = Self {
            run_id: config.run_id.clone(),
            journal,
            driver,
            caps: config.caps,
            spent_tokens,
            settled: false,
            settlement: None,
            run_failure: None,
            ask_specs: config.ask_specs,
            validate: config.validate,
            identity: Identity::new(config.site_phases),
            actors: HashMap::new(),
            actor_order: Vec::new(),
            actor_names: HashMap::new(),
            live: BTreeMap::new(),
            live_index: HashMap::new(),
            next_node_id: 0,
            prior_transcript: HashSet::new(),
            recorded_asks: HashMap::new(),
            active_asks: 0.0,
            gate: ReplayGate::empty(),
            jobs: VecDeque::new(),
            outcomes: Vec::new(),
            next_ticket: 0,
            imported_world: ImportedWorldQueue::new(
                config
                    .imported_cache
                    .as_ref()
                    .map(|cache| cache.world.clone())
                    .unwrap_or_default(),
            ),
            imported_cache: config.imported_cache,
            import_closed: false,
            queued_before_close: HashSet::new(),
            live_before_resume: HashSet::new(),
            world_live: HashMap::new(),
        };
        if existing.is_some() {
            engine.restore_from_journal()?;
        }
        engine.record(RunEvent::RunStarted {
            run_id: config.run_id.clone(),
            caps: config.caps,
        })?;
        if existing.is_none()
            && let Some(mut launch) = config.launch
        {
            launch.tool_call_id = config.tool_call_id.clone();
            launch.parent_session_id = config.parent_session_id.clone();
            engine.record(RunEvent::RunLaunched(Box::new(launch)))?;
        }
        if spent_tokens > 0.0 {
            engine.record(RunEvent::UsageUpdated { spent_tokens })?;
        }
        Ok(engine)
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn caps(&self) -> Caps {
        self.caps
    }

    pub fn spent_tokens(&self) -> f64 {
        self.spent_tokens
    }

    pub fn settlement(&self) -> Option<&RunSettlement> {
        self.settlement.as_ref()
    }

    /// Ask settlements since the last call, in settlement order.
    pub fn take_outcomes(&mut self) -> Vec<AskOutcome> {
        std::mem::take(&mut self.outcomes)
    }

    /// Run the queued continuations (session creation, dispatch, replay releases) until none is left.
    /// Hosts call this after each synchronous slice of script calls.
    pub fn drain(&mut self) -> Result<()> {
        while let Some(job) = self.jobs.pop_front() {
            match job {
                Job::SessionReady { actor_id, node_id } => {
                    self.session_ready(&actor_id, node_id)?
                }
                Job::Dispatch { node_id } => self.dispatch_continue(node_id)?,
                Job::GateFlush => self.gate_flush()?,
            }
        }
        Ok(())
    }

    /// Node `createActor`: register an actor under a fresh ordinal of `site_id`. A nonempty name must be
    /// unique in the run; a duplicate fails the run and returns the `DuplicateActorName` error.
    pub fn create_actor(
        &mut self,
        site_id: &str,
        name: Option<&str>,
        persona: Option<&Value>,
    ) -> Result<String> {
        self.assert_running("createActor")?;
        let ordinal = self.identity.next_ordinal(site_id);
        let actor_ref = Ref::new(site_id, ordinal);
        let id = actor_ref.key();
        let spec = normalize_persona(name, persona);
        let effective = crate::persona::persona_name(&spec).map(str::to_owned);
        if let Some(effective) = effective.filter(|text| !text.is_empty()) {
            if let Some(claimed) = self.actor_names.get(&effective).cloned() {
                let error = WorkflowError::new(
                    ErrorCode::DuplicateActorName,
                    format!(
                        "Subagent name \"{effective}\" is used twice in this run ({claimed} and {id}). A named subagent is the identity an amended re-run matches its cache by, so names must be unique; give this one its own name or drop the name to make it anonymous."
                    ),
                );
                self.fail_run(error.clone())?;
                return Err(error.into());
            }
            self.actor_names.insert(effective, id.clone());
        }
        let recorded = self.recorded_asks.get(&id).copied().unwrap_or(0);
        let mut actor = Actor::new(
            actor_ref.clone(),
            name.map(str::to_owned),
            spec.clone(),
            recorded,
        );
        // Node `createActor`: the import candidate is matched by effective name and normalized persona.
        actor.imported = match_imported_actor(self.imported_cache.as_ref(), &spec);
        self.actors.insert(id.clone(), actor);
        self.actor_order.push(id.clone());
        // putActor replaces the row, but sessionId and resolvedModel belong to the driver side; carry
        // them through so that replaying the same creation does not erase them.
        let existing = self.journal.get_actor(&self.run_id, &actor_ref)?;
        self.journal.put_actor(ActorRow {
            run_id: self.run_id.clone(),
            site_id: site_id.to_owned(),
            ordinal,
            name: name.map(str::to_owned),
            persona: Some(spec.clone()),
            session_id: existing.as_ref().and_then(|row| row.session_id.clone()),
            resolved_model: existing.and_then(|row| row.resolved_model),
        })?;
        self.record(RunEvent::ActorCreated {
            actor: actor_ref,
            name: name.map(str::to_owned),
            persona: spec,
            phase: None,
        })?;
        Ok(id)
    }

    /// Node `ask`: admit one ask to `actor_id`. Returns the ticket; the settlement arrives as an
    /// `AskOutcome` with the same ticket. Refusals are settlements too (as rejected promises are).
    pub fn ask(&mut self, site_id: &str, actor_id: &str, instructions: &str) -> Result<u64> {
        let ticket = self.next_ticket;
        self.next_ticket += 1;
        if self.settled {
            let error = self.run_error();
            self.outcomes.push(AskOutcome {
                ticket,
                result: Err(error),
            });
            return Ok(ticket);
        }
        if !self.actors.contains_key(actor_id) {
            let error = WorkflowError::new(
                ErrorCode::UnknownActor,
                format!("Unknown subagent handle: {actor_id}."),
            );
            self.fail_run(error.clone())?;
            self.outcomes.push(AskOutcome {
                ticket,
                result: Err(error),
            });
            return Ok(ticket);
        }
        let Some(spec) = self.ask_specs.get(site_id).cloned() else {
            let error = WorkflowError::new(
                ErrorCode::MissingAskSpec,
                format!(
                    "Ask site {site_id} has no spec: askSpecs is incomplete (compile output mismatch)."
                ),
            );
            self.fail_run(error.clone())?;
            self.outcomes.push(AskOutcome {
                ticket,
                result: Err(error),
            });
            return Ok(ticket);
        };
        self.admit_ask(ticket, site_id, actor_id, instructions, spec)?;
        Ok(ticket)
    }

    /// Node `log`: a no-op after settlement.
    pub fn log(&mut self, message: &str) -> Result<()> {
        if self.settled {
            return Ok(());
        }
        self.record(RunEvent::Log {
            message: message.to_owned(),
        })
    }

    /// Node `enterPhase`: a marker is not a site, so it writes no row. Every entry is recorded.
    pub fn enter_phase(&mut self, name: &str) -> Result<()> {
        if self.settled {
            return Ok(());
        }
        let trimmed = js_trim(name);
        if trimmed.is_empty() {
            return Ok(());
        }
        let ordinal = self.identity.enter_phase(trimmed);
        self.record(RunEvent::PhaseEntered {
            name: trimmed.to_owned(),
            ordinal,
        })
    }

    /// Node `askStats`: usage of one ask. The live node keeps the stats for its settlement; a settled
    /// row is backfilled. Tokens always count; the event is emitted only while the run is live.
    pub fn ask_stats(&mut self, instance: &Ref, stats: AskStats) -> Result<()> {
        self.note_stats(instance, stats)?;
        self.record_usage(stats.tokens)
    }

    /// The run-level usage part of `askStats`: the total is persisted at once; the event is emitted only
    /// while the run is live. The total is added before the journal write, as Node does (`spentTokens +=
    /// tokens`, then `updateRunUsage`). When the write fails, the in-memory total stays ahead of the row
    /// until the next successful usage write, which writes the full total. Do not move the add after the
    /// write: that changes which total a retry persists.
    pub fn record_usage(&mut self, tokens: f64) -> Result<()> {
        self.spent_tokens += tokens;
        self.journal
            .update_run_usage(&self.run_id, self.spent_tokens)?;
        if self.settled {
            return Ok(());
        }
        self.record(RunEvent::UsageUpdated {
            spent_tokens: self.spent_tokens,
        })
    }

    /// Node `setMaxConcurrency`: returns whether anything changed. A non-finite value, a settled run and
    /// an unchanged value are no-ops; the value is floored and raised to at least 1. Raising the limit
    /// starts queued asks at once. The caps are replaced before the journal write, as Node does (`this.caps
    /// = caps`, then `updateRunCaps`): when the write fails, the engine keeps the new value, the row keeps
    /// the old one, and a retry with the same value returns `Ok(false)`. Pinned by `engine_tests`.
    pub fn set_max_concurrency(&mut self, max_concurrency: f64) -> Result<bool> {
        if self.settled || !max_concurrency.is_finite() {
            return Ok(false);
        }
        let previous = self.caps;
        let next = Caps {
            max_concurrency: max_concurrency.floor().max(1.0),
        };
        if next.max_concurrency == previous.max_concurrency {
            return Ok(false);
        }
        self.caps = next;
        self.journal.update_run_caps(&self.run_id, next)?;
        self.record(RunEvent::RunCapsChanged {
            run_id: self.run_id.clone(),
            caps: next,
            previous,
        })?;
        if next.max_concurrency > previous.max_concurrency {
            self.pump_all()?;
        }
        Ok(true)
    }

    /// Node `submitAttempted`, `turnEnded`: the driver's reports on a live ask.
    pub fn submit_attempted(&mut self, instance: &Ref, payload: Value) -> Result<()> {
        self.handle_submit_attempted(instance, payload)
    }

    pub fn turn_ended(&mut self, instance: &Ref, final_text: &str) -> Result<()> {
        self.handle_turn_ended(instance, final_text)
    }

    /// Node `askFailed`: the driver failed one live ask.
    pub fn ask_failed(&mut self, instance: &Ref, error: WorkflowError) -> Result<()> {
        if let Some(node_id) = self.live_node_id(instance) {
            self.settle_failed(node_id, error)?;
        }
        Ok(())
    }

    /// Node `complete`: the script returned. Asks still in flight are abandoned. First settlement wins.
    pub fn complete(&mut self, artifact: Value) -> Result<()> {
        if self.settled {
            return Ok(());
        }
        let opened = self.begin_settlement(
            RunSettlement::Completed {
                artifact: artifact.clone(),
            },
            None,
        );
        let aborted = self.abort_in_flight(
            &WorkflowError::new(
                ErrorCode::Cancelled,
                "Run completed; in-flight subagent tasks were abandoned.",
            ),
            true,
        );
        let finished = self.finish_run(
            RunStatus::Completed,
            None,
            None,
            None,
            Settlement {
                result: Some(artifact),
                ..Settlement::default()
            },
        );
        opened.and(aborted).and(finished)
    }

    /// Node `stop`: settle as `stopped(reason)`. Completed work stays resumable. First settlement wins.
    pub fn stop(
        &mut self,
        reason: StopReason,
        error: Option<WorkflowError>,
        superseded_by: Option<String>,
    ) -> Result<()> {
        if self.settled {
            return Ok(());
        }
        let failure = error.as_ref().map(WorkflowError::to_json);
        let opened = self.begin_settlement(
            RunSettlement::Stopped {
                reason,
                superseded_by: superseded_by.clone(),
                error: failure.clone(),
            },
            None,
        );
        let aborted = self.abort_in_flight(
            &WorkflowError::new(ErrorCode::Cancelled, "Run stopped."),
            true,
        );
        let finished = self.finish_run(
            RunStatus::Stopped,
            Some(reason),
            superseded_by.clone(),
            failure.clone(),
            Settlement {
                stop_reason: Some(reason),
                superseded_by,
                failure,
                result: None,
            },
        );
        opened.and(aborted).and(finished)
    }

    /// Node `fail`: the run failed (script error or host failure). First settlement wins.
    pub fn fail(&mut self, error: WorkflowError) -> Result<()> {
        self.fail_run(error)
    }

    /// Node `failRun` (`settleFailed`): the run errors; in-flight asks reject with the same error.
    pub(crate) fn fail_run(&mut self, error: WorkflowError) -> Result<()> {
        if self.settled {
            return Ok(());
        }
        let failure = error.to_json();
        let opened = self.begin_settlement(
            RunSettlement::Errored {
                error: failure.clone(),
            },
            Some(error.clone()),
        );
        let aborted = self.abort_in_flight(&error, false);
        let finished = self.finish_run(
            RunStatus::Errored,
            None,
            None,
            Some(failure.clone()),
            Settlement {
                failure: Some(failure),
                ..Settlement::default()
            },
        );
        opened.and(aborted).and(finished)
    }

    /// Node `markSettled`: the first settlement step. The settlement value and the latch are set together,
    /// so `settled` and `settlement` agree whatever the later writes do. The replay gate opens here, so
    /// parked cached settlements are released before the run's own abort and terminal event.
    fn begin_settlement(
        &mut self,
        settlement: RunSettlement,
        failure: Option<WorkflowError>,
    ) -> Result<()> {
        self.settled = true;
        self.settlement = Some(settlement);
        if failure.is_some() {
            self.run_failure = failure;
        }
        self.gate_open()
    }

    /// Node `finishRun`: the journal status first, then `run-settled`, then dispose. The latch is set by
    /// `begin_settlement` before this runs, as Node's `markSettled()` precedes `finishRun`. So when the
    /// status write fails, the engine stays settled: `run-settled` is not appended, dispose is not called,
    /// and a retry is a no-op. The row keeps its previous status. Do not move the latch after the write:
    /// a retry would then settle twice. Pinned by `engine_tests::failed_status_write_latches_the_settlement`.
    fn finish_run(
        &mut self,
        status: RunStatus,
        stop_reason: Option<StopReason>,
        superseded_by: Option<String>,
        error: Option<Value>,
        settlement: Settlement,
    ) -> Result<()> {
        self.journal
            .update_run_status(&self.run_id, status, &settlement)?;
        self.record(RunEvent::RunSettled {
            status,
            stop_reason,
            superseded_by,
            error,
        })?;
        self.driver.dispose();
        Ok(())
    }

    fn assert_running(&self, op: &str) -> Result<()> {
        if self.settled {
            return Err(self
                .run_failure
                .clone()
                .unwrap_or_else(|| {
                    WorkflowError::new(
                        ErrorCode::Cancelled,
                        format!("Run already settled; {op} is no longer accepted."),
                    )
                })
                .into());
        }
        Ok(())
    }

    pub(crate) fn run_error(&self) -> WorkflowError {
        self.run_failure
            .clone()
            .unwrap_or_else(|| WorkflowError::new(ErrorCode::Cancelled, "Run already settled."))
    }

    /// Node `record`: stamp the birth phase, persist, then fan out. Both routes get the same event.
    pub(crate) fn record(&mut self, mut event: RunEvent) -> Result<()> {
        self.identity.stamp(&mut event);
        self.journal.append_event(&self.run_id, &event)?;
        self.driver.emit(&event);
        Ok(())
    }

    /// The journal's events, in sequence order (used by resume and by the golden tests).
    pub fn events(&self) -> Result<Vec<StoredEvent>> {
        self.journal.list_events(&self.run_id)
    }

    /// Node `pumpAll`: start every actor's next queued ask as far as the cap allows.
    pub(crate) fn pump_all(&mut self) -> Result<()> {
        for actor_id in self.actor_order.clone() {
            self.pump_actor(&actor_id)?;
        }
        Ok(())
    }

    pub(crate) fn live_node_id(&self, instance: &Ref) -> Option<u64> {
        self.live_index.get(&instance.key()).copied()
    }

    /// Node `abortInFlight`: every live ask settles as cancelled (with an event when asked), dispatched
    /// ones are cancelled on the driver, and each caller's settlement rejects with `error`.
    pub(crate) fn abort_in_flight(
        &mut self,
        error: &WorkflowError,
        emit_cancelled: bool,
    ) -> Result<()> {
        let ids: Vec<u64> = self.live.keys().copied().collect();
        let mut first_error = None;
        for id in ids {
            let Some(node) = self.live.remove(&id) else {
                continue;
            };
            self.live_index.remove(&node.instance.key());
            if node.dispatched {
                self.driver.cancel_ask(&node.instance);
            }
            // Node records the cancellation, then rejects. A failed write does not stop the loop: every
            // in-flight ticket still gets its outcome and the live set is empty, so no ask is left
            // waiting. The first write error is returned after the loop.
            let written = if emit_cancelled {
                self.record(RunEvent::NodeSettled {
                    instance: node.instance.clone(),
                    outcome: crate::event::NodeOutcome::Cancelled,
                    cached: false,
                    error: None,
                    facts: None,
                    phase: None,
                })
            } else {
                Ok(())
            };
            self.outcomes.push(AskOutcome {
                ticket: node.ticket,
                result: Err(error.clone()),
            });
            if let Err(write) = written {
                first_error.get_or_insert(write);
            }
        }
        self.active_asks = 0.0;
        first_error.map_or(Ok(()), Err)
    }

    pub(crate) fn push_outcome(&mut self, ticket: u64, result: Result<Value, WorkflowError>) {
        self.outcomes.push(AskOutcome { ticket, result });
    }

    /// The next ticket for an ask or a world node. Tickets are unique per engine.
    pub(crate) fn allocate_ticket(&mut self) -> u64 {
        let ticket = self.next_ticket;
        self.next_ticket += 1;
        ticket
    }

    /// Node `liveNodes` membership: the ask is admitted and not yet settled.
    pub(crate) fn is_live_ask(&self, instance: &Ref) -> bool {
        self.live_index.contains_key(&instance.key())
    }

    /// Node `liveActorName`: the effective name of the actor owning a live ask (`None` when anonymous or
    /// not live).
    pub(crate) fn live_actor_name(&self, instance: &Ref) -> Option<String> {
        let node_id = self.live_index.get(&instance.key())?;
        let node = self.live.get(node_id)?;
        let actor = self.actors.get(&node.actor_id)?;
        crate::persona::persona_name(&actor.persona).map(str::to_owned)
    }

    pub(crate) fn is_settled(&self) -> bool {
        self.settled
    }

    pub(crate) fn validate_value(&self, schema: &Value, value: &Value) -> Vec<Violation> {
        (self.validate)(schema, value)
    }

    /// Run one queued release (a cached settlement) now.
    pub(crate) fn execute_release(&mut self, release: Release) -> Result<()> {
        match release {
            Release::Cached(cached) => self.settle_cached(cached),
        }
    }
}

/// Node: `Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0`.
fn normalize_inherited(value: Option<f64>) -> f64 {
    match value {
        Some(tokens) if tokens.is_finite() => tokens.floor().max(0.0),
        _ => 0.0,
    }
}
