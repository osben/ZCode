//! Fork: the runtime workflow run service (specs/fork-rust-workflow-engine.md, 9.25, W7-5a-3).
//!
//! The service starts a run's child through the kernel-api port, hosts the run's owner on its own thread, bridges the
//! child's messages to the owner's mailbox, and closes its live runs. Admission, orphan reconciliation and the production
//! owner assembly are not here (see 9.25 for what is deferred).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::thread::JoinHandle;

use anyhow::Result;
use futures_util::future::BoxFuture;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::agents::AgentSignals;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::workflow_child::{
    ChildEvent, ChildHandler, ChildRequest, ChildStop, Completion, CreateActor, LaunchError,
    LaunchInput, Outcome, RequestType, RunningChild, WireError, WorkflowChildRunner,
};
use rust_cli_kernel_api::workflow_run::WorkflowRunHost;
use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use rust_cli_workflow::actor_mailbox::{ActorHandle, ActorMailbox, MailboxError, TicketedCall};
use rust_cli_workflow::driver_owner::{ActorDriverOwner, ActorSessions, TicketSettlement};
use rust_cli_workflow::engine::EngineConfig;
use rust_cli_workflow::error::{ErrorCode, WorkflowError};
use rust_cli_workflow::journal::JournalPort;
use rust_cli_workflow::model_failure::RedriveClock;
use rust_cli_workflow::quota_resume::{InUse, QuotaAutoResume};
use rust_cli_workflow::residency::SessionResidency;
use rust_cli_workflow::run_concurrency::RunConcurrency;
use rust_cli_workflow::run_progress::{
    LaunchProgress, RunProgress, SharedProjection, shared_projection,
};
use rust_cli_workflow::run_store::RunStore;
use serde_json::{Map, Value};

use crate::workflow_assembly::{RunRegistrations, attach_run};
use crate::workflow_owner::ActorBindingsPort;
use crate::workflow_quota::{QuotaRunReads, QuotaRunResumer, SessionQuotaPort};

#[path = "workflow_run_amend.rs"]
mod amend;
#[path = "workflow_run_cancel.rs"]
mod cancel;
#[path = "workflow_run_fill.rs"]
mod fill;
#[path = "workflow_run_list.rs"]
mod list;
#[path = "workflow_run_orphans.rs"]
mod orphans;
#[path = "workflow_run_resume.rs"]
mod resume;
#[path = "workflow_run_retune.rs"]
mod retune;
#[path = "workflow_run_settings.rs"]
mod settings;
#[path = "workflow_run_start.rs"]
mod start;
#[path = "workflow_run_submit.rs"]
mod submit;

pub use orphans::ReconcileReport;

/// One run's owner as the service holds it: attached at launch, then served on its own thread until it settles.
pub trait HostedOwner: Send {
    /// The launch's registrations (9.15 item 2, 9.12 item 3). Runs in the launch's synchronous step.
    fn attach(&mut self, registrations: RunRegistrations<'_>) -> Result<()>;

    /// The run's progress sink (9.31). The service calls it on the owner's thread, after attach and before the first
    /// `serve`: the rows already journaled (the backlog) are delivered first, so no row is missed. Default: none.
    fn set_progress(&mut self, progress: Box<dyn RunProgress>) {
        let _ = progress;
    }

    /// Serves the mailbox until the run settles or every handle is dropped. Returns the close failures the owner
    /// recorded, which the service reads at close.
    fn serve(self: Box<Self>) -> Vec<(String, String)>;
}

/// An owner with its mailbox, the production shape of `HostedOwner`.
pub struct Hosted<J: JournalPort + Send + 'static, S: ActorSessions + Send + 'static> {
    owner: ActorDriverOwner<J, S>,
    mailbox: ActorMailbox,
}

impl<J: JournalPort + Send + 'static, S: ActorSessions + Send + 'static> Hosted<J, S> {
    pub fn new(owner: ActorDriverOwner<J, S>, mailbox: ActorMailbox) -> Self {
        Self { owner, mailbox }
    }
}

impl<J: JournalPort + Send + 'static, S: ActorSessions + Send + 'static> HostedOwner
    for Hosted<J, S>
{
    fn attach(&mut self, registrations: RunRegistrations<'_>) -> Result<()> {
        attach_run(&mut self.owner, registrations)
    }

    fn set_progress(&mut self, progress: Box<dyn RunProgress>) {
        self.owner.set_progress(progress);
    }

    fn serve(self: Box<Self>) -> Vec<(String, String)> {
        let mut hosted = *self;
        // The loop ends when the run settles (its guard and bound are then released, and a later request could not be
        // answered anyway) or when every handle is dropped. Requests after the settlement are refused by the dropped
        // receiver, as a settled run refuses them.
        while hosted.owner.settlement().is_none() {
            if hosted.mailbox.serve_next(&mut hosted.owner).is_err() {
                break;
            }
        }
        hosted.owner.take_close_failures()
    }
}

/// Builds a run's owner over its mailbox. Called once per launch, outside the service's lock. The handle is the mailbox's
/// own sender: the turn side posts its results through it (9.30).
pub type OwnerFactory = Arc<
    dyn Fn(EngineConfig, ActorMailbox, ActorHandle) -> Result<Box<dyn HostedOwner>> + Send + Sync,
>;

/// The most close failures the service keeps for the next close (L2). Later ones are logged and dropped.
pub const FAILURE_BUFFER_LIMIT: usize = 64;

/// Keeps the first failures up to [`FAILURE_BUFFER_LIMIT`]. The caller logs each one.
fn buffer_failures(buffer: &mut Vec<(String, String)>, failures: Vec<(String, String)>) {
    for failure in failures {
        if buffer.len() >= FAILURE_BUFFER_LIMIT {
            break;
        }
        buffer.push(failure);
    }
}

/// Why a launch did not start a run. Nothing is left behind in any case.
#[derive(Debug)]
pub enum LaunchFailure {
    /// The service is closed: a launch after close is a wiring fault (Node `assertOpen`).
    Closed,
    /// The run has no parent session to keep it resident, so it is refused before anything starts.
    NoParentSession,
    /// A live run, or a launch in progress, already has this id.
    Duplicate(String),
    /// The owner or its residency registration failed; the child was not kept.
    Attach(String),
    /// The child did not start (a rejected script, or a failed compile or entry write).
    Child(Box<LaunchError>),
    /// The check after the child's compile refused the launch (9.37: a resume's `compile_failed` or `script_mismatch`).
    /// The child is stopped and nothing is kept.
    Refused {
        reason: &'static str,
        message: Option<String>,
    },
}

/// What a launch checks on the child's compile, after the child started and before its owner is built. Only a resume
/// passes one (9.37). It may fill the engine config from the compile and refuse the launch.
pub(crate) type CompileCheck =
    Box<dyn FnOnce(&RunningChild, &mut EngineConfig) -> Result<(), LaunchFailure> + Send>;

impl fmt::Display for LaunchFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused { reason, message } => match message {
                Some(message) => f.write_str(message),
                None => f.write_str(reason),
            },
            Self::Closed => f.write_str(
                "dynamic workflow run service is closed; a launch after close is a wiring fault",
            ),
            Self::NoParentSession => {
                f.write_str("a workflow run needs its parent session, which keeps it resident")
            }
            Self::Duplicate(run) => write!(
                f,
                "a live workflow run, or a launch still starting, already has the id {run}"
            ),
            Self::Attach(text) => write!(f, "the workflow run could not be registered: {text}"),
            Self::Child(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for LaunchFailure {}

/// What close did: the runs it stopped, the runs whose residency did not close in time, and the close failures.
#[derive(Debug, Default, PartialEq)]
pub struct CloseReport {
    pub stopped: usize,
    pub stuck: Vec<String>,
    pub close_failures: Vec<(String, String)>,
}

/// The run service. Cheap to clone; every clone shares one run map.
#[derive(Clone)]
pub struct WorkflowRunService {
    inner: Arc<Inner>,
}

/// Fork (W9a, 9.53): the ports of a hub start (`configure_saved_start`).
pub(crate) struct SavedStartPorts {
    pub(crate) home: std::path::PathBuf,
    pub(crate) analyzer: Arc<dyn rust_cli_kernel_api::workflow_analysis::WorkflowAnalyzer>,
}

impl Inner {
    /// Fork (9.52): the live run set changed; the watchers re-read their sessions' background works.
    fn runs_changed(&self) {
        self.changes
            .send_modify(|count| *count = count.wrapping_add(1));
    }
}

struct Inner {
    /// The service's own weak handle, for the idle callbacks of the quota modules.
    me: Weak<Inner>,
    residency: Arc<SessionResidency>,
    concurrency: Arc<dyn RunConcurrency>,
    runner: Arc<dyn WorkflowChildRunner>,
    owners: OwnerFactory,
    state: Mutex<State>,
    /// The journal's host reads and orphan write (W7-5a-4). Set once by the composition; without it the reads are
    /// unsupported or empty, as Node's are without an enumeration query, and the orphan sweep is skipped.
    store: OnceLock<Arc<dyn RunStore>>,
    /// The production clock, for a launch's start time (W7-5a-4). Set once by the composition.
    clock: OnceLock<Arc<dyn rust_cli_kernel_api::clock::Clock>>,
    /// The optional hooks the composition sets (9.31). Read once per launch, never held across a call.
    setup: Mutex<Setup>,
    /// Per parent session: its progress projection and its quota module (9.31). Written only under `state`, after the
    /// launch's last failure point, and dropped when the session is idle (see `evict_if_idle`).
    sessions: Mutex<HashMap<String, SessionHooks>>,
    /// Test seam (finding 1): runs before the quota module is looked up, so a test can close the service between the
    /// caller's check and the module's creation.
    #[cfg(test)]
    before_quota_module: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// The parent's permission mode port a submit reads before its launch (9.39). Set once by the composition; without it a
    /// submit is refused (fail closed).
    bindings: OnceLock<Arc<dyn ActorBindingsPort>>,
    /// Node `defaultConcurrency()` (9.39): the caps default of a submit. Set once by the composition.
    default_concurrency: OnceLock<f64>,
    /// Fork (W9a, 9.53): the saved-workflow store's home and the compile checker of a hub start. Set once by the
    /// composition; without it a hub start is unsupported.
    saved_start: OnceLock<SavedStartPorts>,
    /// Fork (9.63): the model catalog a GUI settings change resolves a model against (Node `modelCatalogPort`). Set once
    /// by the composition; without it a model change is refused as `model_unavailable`.
    models: OnceLock<Arc<rust_cli_kernel_api::provider::LateModelDirectory>>,
    /// Serializes FillWorkflowHole calls (9.45): a fill reads the run's script, and the next fill must read the one the
    /// previous fill wrote. One permit, held across the helper's call and the owner's apply (a semaphore, since a tokio guard
    /// may not be held across an await).
    fills: Arc<tokio::sync::Semaphore>,
    /// Counts every change of the live run set (a run started or settled, or the host closed). The sessions' background
    /// watchers wait on it, so a run that ends on its own leaves the background list without a kernel event (9.52).
    changes: tokio::sync::watch::Sender<u64>,
    /// Serializes a question's answer with its retirement (W8a, 9.48): a resolve delivers and retires under this lock, so a
    /// concurrent resolve of the same question reads the retired table after the delivery, not before it.
    resolves: Mutex<()>,
}

/// What the composition configures. Each hook is off until its setter runs, so a service without them behaves as 9.25.
#[derive(Default)]
struct Setup {
    progress: Option<ProgressSetup>,
    quota: Option<QuotaSetup>,
    /// Where a run's terminal notice goes, to its parent session's model (9.51, W8d). Without it no notice is posted.
    terminal: Option<Arc<dyn AgentSignals>>,
}

struct ProgressSetup {
    port: Arc<dyn WorkflowRunProgressPort>,
    default_concurrency: f64,
}

struct QuotaSetup {
    reads: Arc<dyn QuotaRunReads>,
    resumer: Arc<dyn QuotaRunResumer>,
    clock: Arc<dyn RedriveClock>,
}

#[derive(Default)]
struct SessionHooks {
    projection: Option<SharedProjection>,
    quota: Option<Arc<QuotaAutoResume>>,
}

#[derive(Default)]
struct State {
    closed: bool,
    /// Run ids whose launch is past the duplicate check and has not finished (L3).
    starting: HashSet<String>,
    runs: HashMap<String, RunEntry>,
    /// Close failures of runs that settled on their own, for the next close (bounded, L2).
    failures: Vec<(String, String)>,
    /// Questions that were answered or withdrawn, for a later resolve's refusal (W8a, 9.48; Node's retired table).
    retired: cancel::RetiredQuestions,
    /// Gives each launch a token, so a settled run removes only its own entry (a run id may be launched again).
    next_token: u64,
}

struct RunEntry {
    token: u64,
    parent: String,
    handle: ActorHandle,
    stop: ChildStop,
    serve: Option<JoinHandle<Vec<(String, String)>>>,
    /// What the run's reads need before its row exists (W7-5a-4).
    meta: Arc<list::RunMeta>,
    /// Fork (9.62 review): the run's script file (Node's snapshot `scriptPath`), kept here so the hole notice and the
    /// blocked reminder read it from memory. Set at launch; a Rust fill journals no file, so it does not change.
    script_path: Option<String>,
}

/// Frees a run id's reservation when its launch ends, however it ends.
struct Reservation {
    inner: Arc<Inner>,
    run_id: String,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.inner
            .state
            .lock_unpoisoned()
            .starting
            .remove(&self.run_id);
    }
}

/// The launch facts the progress sink reads, taken from the config before the config moves into the owner factory.
struct LaunchFacts {
    /// Fork (9.61): the run's user-given name, for the progress notices.
    run_name: Option<String>,
    parent_session_id: Option<String>,
    run_id: String,
    tool_call_id: Option<String>,
    resumed_from: Option<String>,
    subagent_model: Option<String>,
    model_bindings: Option<Map<String, Value>>,
}

impl LaunchFacts {
    fn of(config: &EngineConfig) -> Self {
        let (subagent_model, model_bindings) = match &config.launch {
            Some(launch) => (
                launch.subagent_model.clone(),
                launch
                    .model_bindings
                    .as_ref()
                    .and_then(Value::as_object)
                    .cloned(),
            ),
            None => (None, None),
        };
        Self {
            run_name: config.name.clone(),
            parent_session_id: config.parent_session_id.clone(),
            run_id: config.run_id.clone(),
            tool_call_id: config.tool_call_id.clone(),
            resumed_from: config.resumed_from.clone(),
            subagent_model,
            model_bindings,
        }
    }
}

/// The hooks of one launch, built under `state` (see [`session_hooks`]).
type LaunchHooks = (Option<Box<dyn RunProgress>>, Option<Arc<QuotaAutoResume>>);

/// The parent's hooks, created if absent: the caller holds `state` and the `sessions` lock.
///
/// Lock order everywhere: `state`, then `setup`, then `sessions`. The sink's projection is the parent's, and the quota
/// module is the parent's, so every run of one session shares both.
fn session_hooks(
    me: &Weak<Inner>,
    sessions: &mut HashMap<String, SessionHooks>,
    parent: &str,
    progress: Option<(Arc<dyn WorkflowRunProgressPort>, f64)>,
    facts: LaunchFacts,
    quota: Option<QuotaSetup>,
) -> LaunchHooks {
    // Nothing to install, so no entry (re-review 3).
    if progress.is_none() && quota.is_none() {
        return (None, None);
    }
    let hooks = sessions.entry(parent.to_owned()).or_default();
    let sink = progress.map(|(port, default_concurrency)| {
        LaunchProgress {
            owned_session: parent.to_owned(),
            parent_session_id: facts.parent_session_id,
            run_id: facts.run_id,
            tool_call_id: facts.tool_call_id,
            resumed_from: facts.resumed_from,
            subagent_model: facts.subagent_model,
            model_bindings: facts.model_bindings,
            default_concurrency,
            run_name: facts.run_name,
            projection: hooks
                .projection
                .get_or_insert_with(shared_projection)
                .clone(),
            port,
        }
        .into_sink()
    });
    let module = quota.map(|quota| {
        hooks
            .quota
            .get_or_insert_with(|| {
                let port = SessionQuotaPort::new(parent.to_owned(), quota.reads, quota.resumer);
                // When the module goes idle the parent is re-checked for eviction (re-review 2). A weak handle: the
                // module lives inside the service, so a strong one would be a cycle.
                let me = me.clone();
                let owned = parent.to_owned();
                let on_idle = Box::new(move || {
                    if let Some(inner) = me.upgrade() {
                        inner.evict_if_idle(&owned);
                    }
                });
                Arc::new(QuotaAutoResume::with_idle_callback(
                    Arc::new(port),
                    quota.clock,
                    on_idle,
                ))
            })
            .clone()
    });
    (sink, module)
}

impl Inner {
    /// The parent's quota module, created on first use when quota is configured. Refused after close (finding 1): the
    /// closed check and the insert share one critical section, so close either sees the module and disposes it, or the
    /// module is never created.
    fn quota_module(&self, parent: &str) -> Option<(Arc<QuotaAutoResume>, InUse)> {
        #[cfg(test)]
        {
            let hook = self.before_quota_module.lock_unpoisoned().take();
            if let Some(hook) = hook {
                hook();
            }
        }
        let state = self.state.lock_unpoisoned();
        if state.closed {
            return None;
        }
        let quota = self.quota_clones()?;
        let mut sessions = self.sessions.lock_unpoisoned();
        let (_, module) = session_hooks(
            &self.me,
            &mut sessions,
            parent,
            None,
            LaunchFacts::none(),
            Some(quota),
        );
        // The guard is taken under the same locks that hand the module out: an eviction that runs next sees the call.
        let module = module?;
        let in_use = module.in_use();
        Some((module, in_use))
    }

    /// Posts the terminal notice of a settled run to its parent session (9.51, W8d). Runs on the owner's thread after the
    /// settlement, with no lock held. A row that cannot be read posts nothing; the read failure is logged.
    fn post_terminal_notice(&self, run_id: &str, started_at_ms: i64) {
        // No sink is the gate-off default: nothing is posted and nothing is logged.
        let (signals, quota_on) = {
            let setup = self.setup.lock_unpoisoned();
            (setup.terminal.clone(), setup.quota.is_some())
        };
        let Some(signals) = signals else {
            return;
        };
        // Fork (9.62, DWP-03): a run the closing service stopped posts nothing, as Node drops a background notification
        // while its runtime shuts down. The row stays `stopped`, so a restarted app draws the run with no notification.
        if self.state.lock_unpoisoned().closed {
            tracing::info!(
                event = "workflow.run.terminal_notice.shutdown_dropped",
                run = %run_id,
                "a workflow run settled while the service closed; its terminal notice is dropped"
            );
            return;
        }
        let Some(store) = self.store.get().cloned() else {
            tracing::warn!(
                event = "workflow.run.terminal_notice_skipped",
                run = %run_id,
                "a settled workflow run's terminal notice was not posted: a sink is set but no run store is"
            );
            return;
        };
        let row = match store.get_run(run_id) {
            Ok(Some(row)) => row,
            Ok(None) => {
                // A run that just settled has a row. Its absence is a persistence fault, not a silent case.
                tracing::warn!(
                    event = "workflow.run.terminal_notice_skipped",
                    run = %run_id,
                    "a settled workflow run has no journal row, so its terminal notice was not posted"
                );
                return;
            }
            Err(error) => {
                tracing::warn!(
                    event = "workflow.run.terminal_notice_skipped",
                    run = %run_id,
                    error = %error,
                    "a workflow run's terminal notice was skipped: its row could not be read"
                );
                return;
            }
        };
        if !crate::workflow_run_terminal::is_terminal(row.status) {
            // The owner ended with no terminal status in the row: a settlement whose status write did not land, or an
            // owner that stopped serving without settling (a caught panic). The model is not told the run ended.
            tracing::warn!(
                event = "workflow.run.terminal_notice_skipped",
                run = %run_id,
                status = row.status.as_str(),
                "a workflow run's row is not terminal when its owner ends, so its terminal notice was not posted"
            );
            return;
        }
        // The resume guidance is true only where the quota module arms the resume: the same predicate, with quota wired.
        let auto_resumes =
            quota_on && rust_cli_workflow::quota_resume::quota_resume_at(&row).is_some();
        // Fork (9.61, 9.62): one detail read gives the chips (the journal's published records) and the script file the
        // guidance names (the roster's `scriptPath`). A read fault posts the notice without either.
        let detail = match store.run_detail(run_id, None) {
            Ok(detail) => detail,
            Err(error) => {
                tracing::warn!(
                    event = "workflow.run.terminal_artifacts_unread",
                    run = %run_id,
                    error = %error,
                    "a settled workflow run's detail could not be read, so its terminal notice carries no chips and no script path"
                );
                None
            }
        };
        let script_path = detail.as_ref().and_then(roster_script_path);
        if let Some(notice) =
            crate::workflow_run_terminal::terminal_notice(&row, auto_resumes, script_path)
        {
            // Fork (9.61): the card's time cell, this incarnation's life on the injected clock.
            let settled_at_ms = self.clock.get().map(|clock| clock.now_ms());
            let notice = crate::workflow_run_terminal::with_duration(
                notice,
                crate::workflow_run_terminal::run_duration_ms(started_at_ms, settled_at_ms),
            );
            let published = detail.map(|detail| Value::Array(detail.published_artifacts));
            let notice = crate::workflow_run_terminal::with_artifacts(notice, published.as_ref());
            signals.workflow_notice(
                &SessionId::new(notice.parent_session_id),
                notice.text,
                Some(notice.workflow),
            );
        }
    }

    /// The quota setup, cloned so no lock is held across the module's creation.
    fn quota_clones(&self) -> Option<QuotaSetup> {
        let setup = self.setup.lock_unpoisoned();
        let quota = setup.quota.as_ref()?;
        Some(QuotaSetup {
            reads: quota.reads.clone(),
            resumer: quota.resumer.clone(),
            clock: quota.clock.clone(),
        })
    }

    /// The progress setup (port and default concurrency), when configured.
    fn progress_clones(&self) -> Option<(Arc<dyn WorkflowRunProgressPort>, f64)> {
        let setup = self.setup.lock_unpoisoned();
        setup
            .progress
            .as_ref()
            .map(|progress| (progress.port.clone(), progress.default_concurrency))
    }

    /// Drops a parent's hooks once it has no live run and no armed quota timer (finding 2). The module is disposed with
    /// them, so a stale timer cannot fire later. A later launch rebuilds the hooks. Called after a settlement and when a
    /// launch fails after its hooks were built.
    fn evict_if_idle(&self, parent: &str) {
        let state = self.state.lock_unpoisoned();
        if state.runs.values().any(|entry| entry.parent == parent) {
            return;
        }
        let mut sessions = self.sessions.lock_unpoisoned();
        let idle = sessions
            .get(parent)
            .and_then(|hooks| hooks.quota.as_ref())
            .is_none_or(|module| module.is_idle());
        if !idle {
            return;
        }
        if let Some(hooks) = sessions.remove(parent)
            && let Some(module) = hooks.quota
        {
            module.dispose();
        }
    }
}

impl LaunchFacts {
    /// Facts for a hook that carries no run (the quota module alone).
    fn none() -> Self {
        Self {
            run_name: None,
            parent_session_id: None,
            run_id: String::new(),
            tool_call_id: None,
            resumed_from: None,
            subagent_model: None,
            model_bindings: None,
        }
    }
}

impl WorkflowRunService {
    pub fn new(
        residency: Arc<SessionResidency>,
        concurrency: Arc<dyn RunConcurrency>,
        runner: Arc<dyn WorkflowChildRunner>,
        owners: OwnerFactory,
    ) -> Self {
        Self {
            inner: Arc::new_cyclic(|me| Inner {
                me: me.clone(),
                residency,
                concurrency,
                runner,
                owners,
                state: Mutex::new(State::default()),
                store: OnceLock::new(),
                clock: OnceLock::new(),
                setup: Mutex::new(Setup::default()),
                sessions: Mutex::new(HashMap::new()),
                #[cfg(test)]
                before_quota_module: Mutex::new(None),
                bindings: OnceLock::new(),
                default_concurrency: OnceLock::new(),
                saved_start: OnceLock::new(),
                models: OnceLock::new(),
                fills: Arc::new(tokio::sync::Semaphore::new(1)),
                changes: tokio::sync::watch::channel(0).0,
                resolves: Mutex::new(()),
            }),
        }
    }

    /// Fork (9.63): the model catalog of the GUI settings (the slot the workflow tools read too). Returns `false` when
    /// one is already set (the first one stays).
    pub fn configure_models(
        &self,
        models: Arc<rust_cli_kernel_api::provider::LateModelDirectory>,
    ) -> bool {
        self.inner.models.set(models).is_ok()
    }

    /// The catalog's entries now, or `None` without one. Fork (9.65, closes 919): `parent`'s current model is marked
    /// current (Node's `currentSelection()` in `createModelCatalogPort`), so a bare name prefers the session's
    /// provider. A parent whose bindings cannot be read marks none (logged): a qualified id still resolves.
    pub(crate) async fn model_entries(
        &self,
        parent: &str,
    ) -> Option<Vec<rust_cli_tools::model_reference::CatalogEntry>> {
        let directory = self.inner.models.get()?.get()?;
        let selection = match self.inner.bindings.get().cloned() {
            Some(bindings) => {
                let parent = parent.to_owned();
                let read =
                    list::on_blocking_pool(move || Ok(bindings.parent_bindings(&parent))).await;
                match read {
                    Ok(Ok(found)) => found.and_then(|bindings| bindings.selection),
                    Ok(Err(error))
                    | Err(rust_cli_kernel_api::workflow_run::DynamicWorkflowRunError {
                        message: error,
                    }) => {
                        tracing::warn!(
                            event = "workflow.run.settings.parent_selection_unread",
                            %error,
                            "the parent's model could not be read; no catalog entry is current"
                        );
                        None
                    }
                }
            }
            None => None,
        };
        rust_cli_tools::model_reference::read_entries(Some(directory.as_ref()), selection.as_ref())
            .await
    }

    /// Fork (W9a, 9.53): sets the hub start's ports, the user's home (where saved workflows live) and the compile checker
    /// (the same analyzer CreateWorkflow uses). Set once: a second call is a wiring fault, logged, and keeps the first.
    pub fn configure_saved_start(
        &self,
        home: std::path::PathBuf,
        analyzer: Arc<dyn rust_cli_kernel_api::workflow_analysis::WorkflowAnalyzer>,
    ) -> bool {
        let first = self
            .inner
            .saved_start
            .set(SavedStartPorts { home, analyzer })
            .is_ok();
        if !first {
            tracing::warn!(
                event = "workflow.run.saved_start_set_twice",
                "the saved-start ports were set twice; the first ones stay"
            );
        }
        first
    }

    /// Fork (9.52): a receiver that ticks on every change of the live run set, for a session's background watcher.
    pub(crate) fn run_changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.inner.changes.subscribe()
    }

    /// Node `defaultConcurrency()` (9.39): the caps default of a submit, and the port's `default_concurrency`. Set once by
    /// the composition root (the governor's formula over the process's cores). Returns `false` when the value is not
    /// finite or below one (refused, nothing kept), or when a value is already set (the first one stays, logged).
    pub fn configure_concurrency(&self, default_concurrency: f64) -> bool {
        if !default_concurrency.is_finite() || default_concurrency < 1.0 {
            tracing::warn!(
                event = "workflow.run.default_concurrency_invalid",
                value = default_concurrency,
                "the default concurrency must be a finite number of at least one; it is not set"
            );
            return false;
        }
        let first = self
            .inner
            .default_concurrency
            .set(default_concurrency)
            .is_ok();
        if !first {
            tracing::warn!(
                event = "workflow.run.default_concurrency_set_twice",
                "the default concurrency was set twice; the first one stays"
            );
        }
        first
    }

    /// The parent's permission mode port a submit reads before its launch (9.39). Set once by the composition root; a
    /// submit without it is refused, so no run starts with its mode unrecorded. Returns `false` (logged) on a second set.
    pub fn configure_bindings(&self, bindings: Arc<dyn ActorBindingsPort>) -> bool {
        let first = self.inner.bindings.set(bindings).is_ok();
        if !first {
            tracing::warn!(
                event = "workflow.run.bindings_set_twice",
                "the actor bindings were set twice; the first one stays"
            );
        }
        first
    }

    /// Sets the journal's run store (set once, by the composition root that owns the session database).
    /// Returns `false` (and keeps the first store) when one is already set: a second composition is a wiring fault,
    /// logged here rather than swallowed.
    pub fn set_store(&self, store: Arc<dyn RunStore>) -> bool {
        let first = self.inner.store.set(store).is_ok();
        if !first {
            tracing::warn!(
                event = "workflow.run.store_already_set",
                "the run store was set twice; the first one stays"
            );
        }
        first
    }

    /// Sets the clock a launch reads its start time from (set once, by the composition root).
    /// Returns `false` (and keeps the first clock) when one is already set, logged as `set_store` is.
    pub fn set_clock(&self, clock: Arc<dyn rust_cli_kernel_api::clock::Clock>) -> bool {
        let first = self.inner.clock.set(clock).is_ok();
        if !first {
            tracing::warn!(
                event = "workflow.run.clock_already_set",
                "the run clock was set twice; the first one stays"
            );
        }
        first
    }

    /// Test seam: the next quota-module lookup runs `hook` first (see `Inner::quota_module`).
    #[cfg(test)]
    pub(crate) fn set_hook_before_quota_module(&self, hook: Box<dyn FnOnce() + Send>) {
        *self.inner.before_quota_module.lock_unpoisoned() = Some(hook);
    }

    /// Test seam: how many sessions hold hooks.
    #[cfg(test)]
    pub(crate) fn session_entries(&self) -> usize {
        self.inner.sessions.lock_unpoisoned().len()
    }

    /// Turns on the progress fan-out (9.31): each run's journal events reach `port` for its parent session. Set before
    /// the first launch; a run launched earlier has no sink.
    pub fn configure_progress(
        &self,
        port: Arc<dyn WorkflowRunProgressPort>,
        default_concurrency: f64,
    ) {
        self.inner.setup.lock_unpoisoned().progress = Some(ProgressSetup {
            port,
            default_concurrency,
        });
    }

    /// Turns on the terminal notices (9.51, W8d): each run posts one notice to its parent session when it settles, through
    /// `signals`. Set before the first settlement; a run settled earlier posts nothing.
    pub fn configure_terminal_notices(&self, signals: Arc<dyn AgentSignals>) {
        self.inner.setup.lock_unpoisoned().terminal = Some(signals);
    }

    /// Turns on quota auto-resume (9.31, spec 9.14): a settled quota stop is armed, and `open_session` scans a session.
    /// `reads` answers the run rows, `resumer` the resume, and `clock` the timers (production: `ThreadClock`).
    pub fn configure_quota(
        &self,
        reads: Arc<dyn QuotaRunReads>,
        resumer: Arc<dyn QuotaRunResumer>,
        clock: Arc<dyn RedriveClock>,
    ) {
        self.inner.setup.lock_unpoisoned().quota = Some(QuotaSetup {
            reads,
            resumer,
            clock,
        });
    }

    /// The session-open hook (9.31): builds the parent's quota module and scans its recent runs, so a run stopped by a
    /// quota whose reset has passed resumes now and the others are armed. Reads the journal, so call it off the
    /// runtime's workers. A no-op without `configure_quota`, and after close.
    pub fn open_session(&self, parent_session_id: &str) {
        if let Some((module, in_use)) = self.inner.quota_module(parent_session_id) {
            module.scan();
            // Dropping the guard re-checks the parent: a scan that armed nothing leaves no hooks behind (re-review 2).
            drop(in_use);
        }
    }

    /// Starts a run: the child, then the owner, then the registrations, in one step after the compile (Node invariant 6).
    pub async fn launch(
        &self,
        input: LaunchInput,
        config: EngineConfig,
    ) -> Result<(), LaunchFailure> {
        self.start(input, config, None).await
    }

    /// The launch behind `launch` and the resume (9.37). `check` runs once the child has compiled and before the owner is
    /// built; a refusal stops the child and keeps nothing.
    pub(crate) async fn start(
        &self,
        input: LaunchInput,
        mut config: EngineConfig,
        check: Option<CompileCheck>,
    ) -> Result<(), LaunchFailure> {
        let inner = self.inner.clone();
        let Some(parent) = config.parent_session_id.clone() else {
            return Err(LaunchFailure::NoParentSession);
        };
        if input.run_id != config.run_id {
            return Err(LaunchFailure::Attach(format!(
                "the launch names run {} but its config names {}",
                input.run_id, config.run_id
            )));
        }
        let run_id = input.run_id.clone();
        // The id is reserved before the compile's await, so a second launch of it is refused before its child starts.
        {
            let mut state = inner.state.lock_unpoisoned();
            if state.closed {
                return Err(LaunchFailure::Closed);
            }
            if state.runs.contains_key(&run_id) || !state.starting.insert(run_id.clone()) {
                return Err(LaunchFailure::Duplicate(run_id));
            }
        }
        let _reservation = Reservation {
            inner: inner.clone(),
            run_id: run_id.clone(),
        };
        // The start time is the injected clock's (Node's `startedAt`). Without a clock it is 0, which only the
        // synthesized gap rows of a list would show.
        let started_at_ms = inner
            .clock
            .get()
            .map_or(0, |clock| i64::try_from(clock.now_ms()).unwrap_or(i64::MAX));
        let meta = Arc::new(list::RunMeta::at_launch(&input, &config, started_at_ms));

        // The compile and the child's start come first, as Node's launch does: a rejected script creates no engine and
        // no run row. The mailbox is held here, so the child's early requests wait in it until the owner serves.
        let (mailbox, handle) = ActorMailbox::new();
        let bridge = Arc::new(WireBridge::new(handle.clone()));
        let running = inner
            .runner
            .start(input, bridge)
            .await
            .map_err(|error| LaunchFailure::Child(Box::new(error)))?;
        if let Some(check) = check
            && let Err(error) = check(&running, &mut config)
        {
            running.stop.stop();
            return Err(error);
        }
        let RunningChild { stop, outcome, .. } = running;

        // The run's progress and quota setup, and the facts the sink reads, taken before the config moves (9.31).
        let progress_setup = inner.progress_clones();
        let quota_setup = inner.quota_clones();
        let facts = LaunchFacts::of(&config);
        // The owner is built outside the lock, since the factory may read the service (M1). It runs on the blocking pool:
        // a factory may block on the database (a migration check waiting on a busy writer), and that must not hold the
        // executor (9.30 review). The id stays reserved until this launch returns, so a failure releases it.
        let owners = inner.owners.clone();
        let factory_handle = handle.clone();
        let launched_path = config
            .launch
            .as_ref()
            .and_then(|launch| launch.script_path.clone())
            .filter(|path| !path.is_empty());
        let journal = launched_path
            .is_none()
            .then(|| inner.store.get().cloned())
            .flatten();
        let path_run = run_id.clone();
        let built = tokio::task::spawn_blocking(move || {
            let script_path = launched_path.or_else(|| {
                journal.and_then(|store| journaled_script_path(store.as_ref(), &path_run))
            });
            ((owners)(config, mailbox, factory_handle), script_path)
        })
        .await;
        let (built, script_path) = match built {
            Ok((built, script_path)) => (Ok(built), script_path),
            Err(join) => (Err(join), None),
        };
        let mut hosted = match built {
            Ok(Ok(hosted)) => hosted,
            Ok(Err(error)) => {
                stop.stop();
                return Err(LaunchFailure::Attach(format!("{error:#}")));
            }
            Err(join) => {
                stop.stop();
                return Err(LaunchFailure::Attach(format!(
                    "the owner factory did not finish: {join}"
                )));
            }
        };
        // The critical section: the closed re-check, the registrations, the hooks, the thread and the entry, with no await.
        // The hooks are built here, after the last check that can refuse the launch, so a refused launch creates none
        // (finding 2). The progress sink is installed on the owner's thread, not here (finding 8).
        let mut state = inner.state.lock_unpoisoned();
        if state.closed {
            drop(state);
            stop.stop();
            return Err(LaunchFailure::Closed);
        }
        let registrations = RunRegistrations {
            residency: &inner.residency,
            concurrency: inner.concurrency.clone(),
            mailbox: handle.clone(),
        };
        if let Err(error) = hosted.attach(registrations) {
            drop(state);
            stop.stop();
            return Err(LaunchFailure::Attach(format!("{error:#}")));
        }
        let (progress, quota) = {
            let mut sessions = inner.sessions.lock_unpoisoned();
            session_hooks(
                &inner.me,
                &mut sessions,
                &parent,
                progress_setup,
                facts,
                quota_setup,
            )
        };
        let token = state.next_token;
        state.next_token += 1;
        let settle_inner = inner.clone();
        let settle_run_id = run_id.clone();
        let settle_stop = stop.clone();
        let settle_parent = parent.clone();
        let serve = match std::thread::Builder::new()
            .name(format!("workflow-owner-{run_id}"))
            .spawn(move || {
                // A panic in serve still settles the run (finding 1): the panic is a failure, and settle_run runs. The
                // progress backlog is delivered here, before the first request is served, on the owner's own thread.
                let failures = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if let Some(progress) = progress {
                        hosted.set_progress(progress);
                    }
                    hosted.serve()
                })) {
                    Ok(failures) => failures,
                    Err(payload) => vec![(
                        "owner".to_owned(),
                        format!("the owner panicked: {}", panic_text(payload.as_ref())),
                    )],
                };
                // The module is in use from before the run leaves the run map until its row is read (re-review 1): an
                // eviction by another run of the parent cannot dispose it in between.
                let in_use = quota.as_ref().map(|quota| quota.in_use());
                let failures =
                    settle_run(&settle_inner, &settle_run_id, token, &settle_stop, failures);
                // After the settlement, with no lock held: the quota module reads the run's row (9.31, spec 9.14).
                if let Some(quota) = &quota {
                    quota.on_run_settled(&settle_run_id);
                }
                drop(in_use);
                // The run's terminal notice (9.51): the row is settled, and it is posted once, on this settlement.
                settle_inner.post_terminal_notice(&settle_run_id, started_at_ms);
                settle_inner.evict_if_idle(&settle_parent);
                failures
            }) {
            Ok(serve) => serve,
            Err(error) => {
                drop(state);
                stop.stop();
                inner.evict_if_idle(&parent);
                return Err(LaunchFailure::Attach(format!(
                    "the owner thread did not start: {error}"
                )));
            }
        };
        state.runs.insert(
            run_id.clone(),
            RunEntry {
                token,
                parent,
                handle: handle.clone(),
                stop: stop.clone(),
                serve: Some(serve),
                meta,
                script_path,
            },
        );
        drop(state);
        inner.runs_changed();
        tokio::spawn(drive_outcome(run_id, handle, outcome, stop));
        Ok(())
    }

    /// Stops every live run and waits for each run's residency to close. A run whose residency does not close in time
    /// is reported as stuck: its owner did not settle, so its thread is left to end on its own.
    pub async fn close(&self) -> CloseReport {
        let inner = self.inner.clone();
        let (runs, modules) = {
            let mut state = inner.state.lock_unpoisoned();
            state.closed = true;
            let runs = std::mem::take(&mut state.runs);
            inner.runs_changed();
            let modules: Vec<Arc<QuotaAutoResume>> = inner
                .sessions
                .lock_unpoisoned()
                .drain()
                .filter_map(|(_, hooks)| hooks.quota)
                .collect();
            (runs, modules)
        };
        // The quota modules stop first, so no timer resumes a run while the service closes (9.31). They are taken in the
        // same critical section as the closed flag (finding 1), so no module can be created after this.
        for module in modules {
            module.dispose();
        }
        let stopped = runs.len();
        for entry in runs.values() {
            entry.stop.stop();
            let _ = entry.handle.stop_interrupted();
        }

        let parents: BTreeSet<String> = runs.values().map(|entry| entry.parent.clone()).collect();
        let mut stuck: Vec<String> = Vec::new();
        for parent in parents {
            let residency = inner.residency.clone();
            let session = parent.clone();
            let closed = tokio::task::spawn_blocking(move || residency.close(&session)).await;
            if !matches!(closed, Ok(Ok(()))) {
                stuck.extend(
                    runs.iter()
                        .filter(|(_, entry)| entry.parent == parent)
                        .map(|(run_id, _)| run_id.clone()),
                );
            }
        }
        stuck.sort();

        let mut close_failures = Vec::new();
        for (run_id, entry) in runs {
            if stuck.contains(&run_id) {
                continue;
            }
            if let Some(serve) = entry.serve {
                close_failures.extend(join_owner(serve).await);
            }
        }
        close_failures.extend(std::mem::take(&mut inner.state.lock_unpoisoned().failures));
        CloseReport {
            stopped,
            stuck,
            close_failures,
        }
    }

    /// The number of runs the service holds (live, or settled but not yet collected).
    pub fn run_count(&self) -> usize {
        self.inner.state.lock_unpoisoned().runs.len()
    }

    /// Fork (9.62, DWH-02): a live run's script file (Node's snapshot `scriptPath`, read by the hole notice and the
    /// blocked reminder), from the service's memory: these readers run on the async runtime, so no store is read here. A
    /// run the service does not hold, or one with no file, has none; the notice then falls back to GetWorkflowRun.
    pub fn run_script_path_of(&self, run_id: &str) -> Option<String> {
        let state = self.inner.state.lock_unpoisoned();
        state.runs.get(run_id)?.script_path.clone()
    }

    /// Fork (W7-11, 9.44): the ids of one parent session's live runs, the runs the service holds (a settled run is removed).
    /// Sorted, so the reminder's order does not depend on the map.
    pub fn live_run_ids_of(&self, parent_session_id: &str) -> Vec<String> {
        let state = self.inner.state.lock_unpoisoned();
        let mut ids: Vec<String> = state
            .runs
            .iter()
            .filter(|(_, entry)| entry.parent == parent_session_id)
            .map(|(run_id, _)| run_id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// Fork (W7-11, 9.44): one run's snapshot from its parent's projection (the reducer's run object, with
    /// `pendingQuestions` and the holes), read from memory. `None` when the session has no projection or no such run.
    pub fn run_snapshot_of(&self, parent_session_id: &str, run_id: &str) -> Option<Value> {
        let projection = {
            let sessions = self.inner.sessions.lock_unpoisoned();
            sessions.get(parent_session_id)?.projection.clone()?
        };
        // Only the one run is cloned, under the projection's lock (the progress fan-out takes the same lock).
        let state = projection.lock_unpoisoned();
        let found = state
            .state()
            .runs
            .iter()
            .find(|run| run.get("runId").and_then(Value::as_str) == Some(run_id))
            .map(|run| Value::Object(run.clone()));
        drop(state);
        found
    }
}

impl WorkflowRunHost for WorkflowRunService {
    fn held_runs(&self) -> usize {
        self.run_count()
    }

    fn close(&self) -> BoxFuture<'static, Vec<String>> {
        let service = self.clone();
        Box::pin(async move {
            let report = WorkflowRunService::close(&service).await;
            let mut lines: Vec<String> = report
                .stuck
                .iter()
                .map(|run| format!("run {run}: its session did not close in time"))
                .collect();
            lines.extend(
                report
                    .close_failures
                    .iter()
                    .map(|(session, message)| format!("{session}: {message}")),
            );
            lines
        })
    }

    /// The sweep first (its own blocking work), then the quota scan: the scan reads the rows the sweep just settled.
    /// Both read the journal, so the scan runs on the blocking pool; a failed join is logged, never raised.
    fn session_opened(&self, parent_session_id: &str) -> BoxFuture<'static, ()> {
        let service = self.clone();
        let parent = parent_session_id.to_owned();
        Box::pin(async move {
            service.reconcile_session_off_thread(&parent).await;
            let scan = service.clone();
            let opened = tokio::task::spawn_blocking(move || scan.open_session(&parent)).await;
            if let Err(error) = opened {
                tracing::error!(
                    event = "workflow.run.session_open_failed",
                    error = %error,
                    "the quota scan of an opened session did not finish"
                );
            }
        })
    }
}

/// Runs on the owner's thread once the owner has stopped serving: the run settled, or every handle was dropped. The
/// child is stopped here, so its host ends with the run whatever settled it (H1). The run's entry is removed unless close
/// took it; a taken entry's failures go back to close through the thread's return value, which close joins.
fn settle_run(
    inner: &Inner,
    run_id: &str,
    token: u64,
    stop: &ChildStop,
    failures: Vec<(String, String)>,
) -> Vec<(String, String)> {
    stop.stop();
    log_failures(run_id, &failures);
    let mut state = inner.state.lock_unpoisoned();
    let owned = state
        .runs
        .get(run_id)
        .is_some_and(|entry| entry.token == token);
    if owned {
        state.runs.remove(run_id);
        inner.runs_changed();
        buffer_failures(&mut state.failures, failures);
        return Vec::new();
    }
    failures
}

/// The run's script file in its journal roster (Node `workflowSnapshotScriptPath`: the last fill's file, else the
/// launch's). An empty path is none. The one rule for the terminal notice and the resume's journal read.
fn roster_script_path(detail: &rust_cli_workflow::run_store::RunDetail) -> Option<&str> {
    detail
        .roster
        .get("scriptPath")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
}

/// The script file a run's journal records, for a launch that carries none (a resume). Blocking: called on the blocking
/// pool. A read fault is logged and reads as none.
pub(crate) fn journaled_script_path(store: &dyn RunStore, run_id: &str) -> Option<String> {
    match store.run_detail(run_id, None) {
        Ok(detail) => detail
            .as_ref()
            .and_then(roster_script_path)
            .map(str::to_owned),
        Err(error) => {
            tracing::warn!(
                event = "workflow.run.script_path_unread",
                run = %run_id,
                error = %error,
                "a workflow run's script path could not be read from its journal, so its notices name no file"
            );
            None
        }
    }
}

/// The text of a panic payload, for the close failure that reports it.
fn panic_text(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("a panic without a message")
}

/// Logs each close failure at the point it is collected, so a failure that is not returned to a caller is still recorded.
fn log_failures(run_id: &str, failures: &[(String, String)]) {
    for (session, message) in failures {
        tracing::warn!(
            event = "workflow.run.close_failed",
            run = %run_id,
            session = %session,
            error = %message,
            "a workflow run's session did not close"
        );
    }
}

/// The engine side of the child's messages for one run (9.25 item 1). Calls that wait for the owner run on the blocking
/// pool, so an ask in flight never holds the child's host.
pub struct WireBridge {
    handle: ActorHandle,
}

impl WireBridge {
    pub fn new(handle: ActorHandle) -> Self {
        Self { handle }
    }
}

impl ChildHandler for WireBridge {
    fn create_actor(&self, actor: &CreateActor) -> BoxFuture<'static, Result<String, String>> {
        let handle = self.handle.clone();
        let site_id = actor.site_id.clone();
        let name = actor.name.clone();
        let persona = actor.persona.clone();
        Box::pin(async move {
            match tokio::task::spawn_blocking(move || {
                handle.create_actor(&site_id, name.as_deref(), persona.as_ref())
            })
            .await
            {
                Ok(Ok(id)) => Ok(id),
                Ok(Err(error)) => Err(error.to_string()),
                Err(join) => Err(format!("the owner call did not finish: {join}")),
            }
        })
    }

    fn request(
        &self,
        request: ChildRequest,
        actor_id: Option<String>,
    ) -> BoxFuture<'static, Result<Value, WireError>> {
        let handle = self.handle.clone();
        Box::pin(async move {
            let call = ticketed_call(request, actor_id).map_err(|error| *error)?;
            // The owner's calls block, so they run on the blocking pool: the child's host keeps reading meanwhile.
            match tokio::task::spawn_blocking(move || ticketed(&handle, call)).await {
                Ok(Ok(Ok(value))) => Ok(value),
                Ok(Ok(Err(error))) => Err(workflow_wire(&error)),
                Ok(Err(error)) => Err(wire("DriverError", error.to_string())),
                Err(join) => Err(wire(
                    "DriverError",
                    format!("the owner call did not finish: {join}"),
                )),
            }
        })
    }

    fn event(&self, event: ChildEvent) {
        match event {
            ChildEvent::Log { message } => {
                let _ = self.handle.log(&message);
            }
            ChildEvent::Report {
                site_id,
                item,
                artifact_id,
            } => {
                let _ = self.handle.report(&site_id, item, artifact_id.as_deref());
            }
            ChildEvent::PhaseEntered { name } => {
                let _ = self.handle.enter_phase(&name);
            }
            // Posted inline, as a report is: the reports that fill the declared artifact queue after it.
            ChildEvent::DeclareArtifact { site_id, op, args } => {
                let _ = self.handle.declare_artifact(&site_id, &op, args);
            }
        }
    }
}

/// The owner call for one ticketed child request. The call is sent, then the owner is drained, which starts the turns
/// the call queued (the engine queues starts until a drain), and then the call waits for its settlement.
fn ticketed(handle: &ActorHandle, call: TicketedCall) -> Result<TicketSettlement, MailboxError> {
    let answer = handle.send_ticketed(call)?;
    // A drain refused by a run that settled on this very call still leaves the call's settlement in its reply, so the
    // drain's error is not the answer. It is logged, not returned (L5).
    if let Err(error) = handle.drain() {
        tracing::warn!(%error, "the owner refused a drain after a child call; the call's settlement is still awaited");
    }
    ActorHandle::await_ticketed(answer)
}

/// Maps one child request to its owner call. A hole parks its branch until the run service fills it (9.45).
fn ticketed_call(
    request: ChildRequest,
    actor_id: Option<String>,
) -> Result<TicketedCall, Box<WireError>> {
    let site_id = request.site_id;
    match request.request_type {
        RequestType::Ask => {
            let Some(actor) = actor_id else {
                return Err(Box::new(wire("DriverError", "the ask names no actor")));
            };
            Ok(TicketedCall::Ask {
                site_id,
                actor,
                instructions: request.instructions.unwrap_or_default(),
            })
        }
        RequestType::WorldRead => Ok(TicketedCall::WorldRead {
            site_id,
            op: request.op.unwrap_or_default(),
            args: request.args.unwrap_or_default(),
        }),
        RequestType::PublishArtifact => Ok(TicketedCall::PublishArtifact {
            site_id,
            op: request.artifact_op.unwrap_or_default(),
            args: request.args.unwrap_or_default(),
        }),
        RequestType::Hole => Ok(TicketedCall::Hole {
            site_id,
            name: request.name.unwrap_or_default(),
            prompt: request.prompt,
        }),
    }
}

/// A workflow error as the child sees it: the code is its name, and the ask refusal keeps its violations and final text.
fn workflow_wire(error: &WorkflowError) -> WireError {
    WireError {
        name: error.code.as_str().to_owned(),
        message: error.message.clone(),
        code: Some(error.code.as_str().to_owned()),
        violations: error.violations.as_ref().and_then(Value::as_array).cloned(),
        final_text: error.final_text.clone(),
        stack: None,
    }
}

fn wire(name: &str, message: impl Into<String>) -> WireError {
    WireError {
        name: name.to_owned(),
        message: message.into(),
        code: Some(name.to_owned()),
        violations: None,
        final_text: None,
        stack: None,
    }
}

/// The child's outcome settles the run. A stream that stops before `complete` settles the run as interrupted, and its
/// reason and cause are logged, since the stop carries no error text (L6).
async fn drive_outcome(
    run_id: String,
    handle: ActorHandle,
    outcome: BoxFuture<'static, Outcome>,
    stop: ChildStop,
) {
    let outcome = outcome.await;
    // Read after the outcome: a stop the service requested is visible here, since the request came before the outcome.
    let requested = stop.is_stopped();
    let _ = tokio::task::spawn_blocking(move || match outcome {
        Outcome::Completed(Completion {
            ok: true, value, ..
        }) => {
            let _ = handle.complete(value.unwrap_or(Value::Null));
        }
        Outcome::Completed(Completion {
            ok: false, error, ..
        }) => {
            let message = error
                .map(|error| error.message)
                .unwrap_or_else(|| "The workflow script threw an error".to_owned());
            let _ = handle.fail(WorkflowError::new(ErrorCode::DriverError, message));
        }
        Outcome::Stopped { reason, cause } => {
            // A stop the service asked for (close, or the run settling) is expected; only a child that stopped by itself
            // is logged as a warning (finding 4).
            if requested {
                tracing::debug!(run = %run_id, reason = ?reason, "the service stopped the child");
            } else {
                tracing::warn!(
                    event = "workflow.run.host_stopped",
                    run = %run_id,
                    reason = ?reason,
                    cause = %cause,
                    "the child's stream ended before it completed; the run is stopped as interrupted"
                );
            }
            let _ = handle.stop_interrupted();
        }
    })
    .await;
}

/// Joins an owner thread on the blocking pool, and returns the close failures it recorded. A thread that panicked is
/// reported as one failure.
async fn join_owner(serve: JoinHandle<Vec<(String, String)>>) -> Vec<(String, String)> {
    tokio::task::spawn_blocking(move || serve.join())
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_else(|| {
            vec![(
                "owner".to_owned(),
                "the owner thread ended by a panic".to_owned(),
            )]
        })
}

#[cfg(test)]
#[path = "workflow_run_list_tests.rs"]
mod list_tests;

#[cfg(test)]
#[path = "workflow_run_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "workflow_run_store_tests.rs"]
mod store_tests;

#[cfg(test)]
#[path = "workflow_run_resume_tests.rs"]
mod resume_tests;

#[cfg(test)]
#[path = "workflow_run_submit_tests.rs"]
mod submit_tests;

#[cfg(test)]
#[path = "workflow_run_amend_tests.rs"]
mod amend_tests;
#[cfg(test)]
#[path = "workflow_run_start_tests.rs"]
mod start_tests;
