//! The runtime bridge for a workflow actor's turn (W6a part 2c-2b-3; spec section 9.8e).
//!
//! `workflow`'s `TurnRunner` is synchronous: each ask runs its turns on its own std thread. `Agents::run_actor_turn` is
//! async. [`AgentTurnRunner`] joins the two: it blocks the ask thread on the runtime's handle while the turn runs, and it
//! carries the ask's cancel flag into the turn's cancellation token.
//!
//! Invariants.
//! - The ask thread is never inside a runtime: the workflow spawns it with `std::thread`, and `block_on` panics inside a
//!   runtime. `run_turn` asserts this in debug builds. A second runner that wants to call the bridge from a runtime task
//!   must move the call to a thread first.
//! - The runtime is the one `new` captured. The handle is taken on the runtime's own thread, when the bridge is built.
//! - The message count is the one the turn captured when it finished. The bridge never reads the store on the ask
//!   thread, so a newer prompt cannot change it and no runtime is blocked to read it.
//! - A cancelled turn ends as an error here (`Stopped`); the workflow loop reads its cancel flag and reports nothing.
//!
//! Deviations, recorded in the spec: the persona prompt and the parent are one value for the whole runner (`ActorRunBase`).
//! The workflow does not pass a persona per turn, so a runner serves one persona. Each actor gets its own child session.
//! The interaction description (the origin of its asks) comes with each turn, as the workflow passes it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_agents::actor_turn::{
    ActorEscalation, ActorPort, ActorQuestion, ActorRun, ActorSubmit, ActorTurnEnd, ActorViolation,
    FirstMutating, MutatingNotify, RequestNotify, SubmitPort,
};
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::orchestration::Interactions;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_workflow::actor_mailbox::ActorHandle;
use rust_cli_workflow::actor_turns::{TurnInput, TurnRunner, TurnStats, TurnUsage};
use rust_cli_workflow::driver_owner::SubmitReply;
use rust_cli_workflow::driver_rules::{actor_permission_policy, parse_subagent_permission_mode};
use rust_cli_workflow::engine::SubmitVerdict;
use rust_cli_workflow::escalation::{EscalateOutcome, EscalationRequest};
use rust_cli_workflow::model::Ref;
use rust_cli_workflow::model_failure::TurnFailure;
use serde_json::Value;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::workflow_assembly::AskObserver;

/// How often the bridge checks the ask's cancel flag while a turn runs. Cancels are human-scale, so 20 ms is
/// imperceptible and keeps the wakeup rate low.
const CANCEL_POLL: Duration = Duration::from_millis(20);

/// The agents boundary the bridge calls. `Agents` implements it; tests script it.
#[async_trait]
pub trait ActorAgents: Send + Sync + 'static {
    async fn run_actor_turn(
        &self,
        run: ActorRun,
        prompt: &str,
        cancel: CancellationToken,
    ) -> ActorTurnEnd;

    /// The message count the child's last turn captured when it finished. Read from the live entry, so it is safe on
    /// the ask thread. None when it is not known.
    fn turn_messages(&self, child: &SessionId) -> Option<u64>;

    /// The counts of the child's last finished turn. None when no turn has finished.
    fn actor_turn_stats(
        &self,
        child: &SessionId,
    ) -> Option<rust_cli_agents::actor_turn::ActorTurnStats>;
}

#[async_trait]
impl ActorAgents for rust_cli_agents::Agents {
    async fn run_actor_turn(
        &self,
        run: ActorRun,
        prompt: &str,
        cancel: CancellationToken,
    ) -> ActorTurnEnd {
        rust_cli_agents::Agents::run_actor_turn(self, run, prompt, cancel).await
    }

    fn turn_messages(&self, child: &SessionId) -> Option<u64> {
        rust_cli_agents::Agents::turn_messages(self, child)
    }

    fn actor_turn_stats(
        &self,
        child: &SessionId,
    ) -> Option<rust_cli_agents::actor_turn::ActorTurnStats> {
        rust_cli_agents::Agents::actor_turn_stats(self, child)
    }
}

/// The permission mode of an actor run, from the mode the workflow run recorded for its subagents.
///
/// Node's rules, in order: only a recordable value survives the read (`parse_subagent_permission_mode`), and an absent
/// value is YOLO (`actor_permission_policy`). The policy's name then goes through the shared collaboration-mode
/// conversion (`PermissionMode::from_node_name`), so there is one table for the names. A name that table does not know
/// fails closed to `Default`, which asks for each permission, never to a mode that skips them.
pub fn actor_permission_mode(recorded: Option<&Value>) -> PermissionMode {
    let policy = actor_permission_policy(parse_subagent_permission_mode(recorded));
    PermissionMode::from_node_name(policy.as_str()).unwrap_or(PermissionMode::Default)
}

/// What every actor run of one runner shares: the parent session, the workspace, the model selection, the permission
/// mode, the persona's system prompt, and the parent's interactions channel (its broker to the user), when it has one.
#[derive(Clone)]
pub struct ActorRunBase {
    pub parent: SessionId,
    pub workspace: WorkspaceRef,
    /// The selection a turn runs on when the runner has no settings map (see `with_settings`). None refuses the turn.
    pub selection: Option<ModelSelection>,
    pub mode: PermissionMode,
    pub persona_prompt: String,
    pub interactions: Option<Arc<dyn Interactions>>,
    /// The runtime's clock: an escalation is stamped with the time it was asked.
    pub clock: Arc<dyn Clock>,
    /// The workflow run these actors belong to: their model requests are admitted under it (W6b part 2b). None when
    /// the runner is not part of a run.
    pub admission_run: Option<rust_cli_kernel_api::ids::WorkflowRunId>,
}

/// Renders the interactions by presence: the channel is a trait object with no `Debug`.
impl std::fmt::Debug for ActorRunBase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActorRunBase")
            .field("parent", &self.parent)
            .field("workspace", &self.workspace)
            .field("selection", &self.selection)
            .field("mode", &self.mode)
            .field("admission_run", &self.admission_run)
            .field("persona_prompt", &self.persona_prompt)
            .field(
                "interactions",
                &self.interactions.as_ref().map(|_| "present"),
            )
            .finish()
    }
}

impl ActorRunBase {
    /// The base of a run's actors: their model requests are admitted under `run`, not the session pool (spec 9.12
    /// item 1). The run service sets it for every run it launches.
    pub fn for_run(mut self, run: &str) -> Self {
        self.admission_run = Some(rust_cli_kernel_api::ids::WorkflowRunId::new(run));
        self
    }
}

/// What one actor's session is bound to, fixed when the session is created (9.33, Node `createActorRuntime`): its persona's
/// system prompt, and the model its turns run on. `selection` None refuses the actor's turns.
#[derive(Debug, Clone, PartialEq)]
pub struct ActorSettings {
    pub persona: String,
    pub selection: Option<ModelSelection>,
}

/// The settings of each child session of a run. The owner's session factory records them when an actor's session is
/// created, and each turn of that session reads them. One map is shared by a run's sessions.
#[derive(Clone, Default)]
pub struct ActorSettingsMap(Arc<Mutex<HashMap<String, ActorSettings>>>);

impl ActorSettingsMap {
    pub fn record(&self, session: &str, settings: ActorSettings) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session.to_owned(), settings);
    }

    pub fn get(&self, session: &str) -> Option<ActorSettings> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session)
            .cloned()
    }
}

/// The text of a turn of an actor whose session was created with no model selection (Node `requireActorModelSelection`).
pub const NO_SELECTION: &str =
    "the actor's session has no model selection: the parent session has none for it to inherit";

/// The text of a turn whose session has no recorded settings (a run that records them never reaches it).
const NO_SETTINGS: &str =
    "the actor's session has no recorded settings: it was not created by its run";

/// The workflow's turn runner over the agents crate.
pub struct AgentTurnRunner<A: ActorAgents> {
    agents: Arc<A>,
    handle: Handle,
    base: ActorRunBase,
    mailbox: ActorHandle,
    /// The per-session settings of a run (9.33). None: every turn takes the base's persona and selection.
    settings: Option<ActorSettingsMap>,
}

impl<A: ActorAgents> AgentTurnRunner<A> {
    /// `handle` must be the handle of the runtime `agents` runs on. `mailbox` is the turn side's handle to the owner:
    /// the submit port of each turn sends its result through it.
    pub fn new(agents: Arc<A>, handle: Handle, base: ActorRunBase, mailbox: ActorHandle) -> Self {
        Self {
            agents,
            handle,
            base,
            mailbox,
            settings: None,
        }
    }

    /// Takes each turn's persona and selection from its session's recorded settings (9.33). A session with no record is
    /// refused, since a run records every session it creates.
    pub fn with_settings(mut self, settings: ActorSettingsMap) -> Self {
        self.settings = Some(settings);
        self
    }
}

/// The owner's `askMutating` over the mailbox. The gate forwards only the first call of its ask.
struct MailboxGate {
    mailbox: ActorHandle,
    session: String,
}

#[async_trait]
impl MutatingNotify for MailboxGate {
    async fn ask_mutating(&self) {
        let mailbox = self.mailbox.clone();
        let session = self.session.clone();
        // The owner answers on its own thread: the call waits on the blocking pool, not on a runtime worker.
        let error = match tokio::task::spawn_blocking(move || mailbox.mutating(&session)).await {
            Ok(Ok(())) => return,
            Ok(Err(error)) => error.to_string(),
            Err(error) => error.to_string(),
        };
        tracing::warn!(session = %self.session, error = %error, "an actor's mutating call could not be reported");
    }
}

/// The turn's model requests over the mailbox (Node `askExecuting`): the observer reports the transition once and posts
/// without waiting, so the request path never blocks on the owner.
struct MailboxRequests(Mutex<AskObserver>);

impl std::fmt::Debug for MailboxRequests {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MailboxRequests")
    }
}

impl RequestNotify for MailboxRequests {
    fn request_started(&self) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .request_started();
    }
}

/// The submit port of one turn over the workflow's mailbox (Node `workflowSubmitPort`). The engine decides the result on
/// the owner's thread, so the call waits on the blocking pool, not on a runtime worker.
struct MailboxPort {
    mailbox: ActorHandle,
    session: String,
    clock: Arc<dyn Clock>,
    /// The turn's cancel token. A blocked escalate checks it as a backstop for a cancel that comes before its wait.
    cancel: CancellationToken,
}

#[async_trait]
impl ActorPort for MailboxPort {
    async fn submit(&self, result: Value) -> Result<ActorSubmit, String> {
        let mailbox = self.mailbox.clone();
        let session = self.session.clone();
        let reply = tokio::task::spawn_blocking(move || mailbox.submit(&session, result))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
        match reply {
            SubmitReply::Verdict(SubmitVerdict::Accept) => Ok(ActorSubmit::Accepted),
            SubmitReply::Verdict(SubmitVerdict::Reject { violations }) => {
                Ok(ActorSubmit::Rejected(
                    violations
                        .into_iter()
                        .map(|violation| ActorViolation {
                            path: violation.path,
                            expected: violation.expected,
                            got: violation.got,
                        })
                        .collect(),
                ))
            }
            // The scheduler answers only Accept or Reject today (`scheduler_submit`), so a nudge cannot reach this port.
            // If the engine ever sends one, the call fails with text the model can act on: the turn goes on, and the
            // model is told to submit again rather than being shown an internal word.
            SubmitReply::Verdict(SubmitVerdict::Nudge) => Err(
                "the result was not accepted yet: call submit_result again with the complete result".to_owned(),
            ),
            SubmitReply::Refused(text) | SubmitReply::Cancelled(text) => Err(text),
        }
    }

    async fn escalate(&self, question: ActorQuestion) -> Result<ActorEscalation, String> {
        let mailbox = self.mailbox.clone();
        let session = self.session.clone();
        // The owner names the question by the session's actor, so the request's actor is a placeholder here.
        let request = EscalationRequest {
            actor: Ref::new("actor", 0),
            actor_name: None,
            question: question.question,
            context: question.context,
            asked_at: self.clock.now_ms(),
        };
        // The blocked call waits for the owner's answer on the blocking pool. The owner answers from the main agent's
        // thread, so the answer may come before this wait starts; the store keeps it.
        let cancel = self.cancel.clone();
        tokio::task::spawn_blocking(move || {
            match mailbox
                .escalate(&session, request)
                .map_err(|error| error.to_string())?
            {
                EscalateOutcome::Parked { qid } => {
                    let answer = mailbox
                        .parked()
                        .wait_until(&session, &qid, &|| cancel.is_cancelled())?;
                    Ok(ActorEscalation::Answered { qid, answer })
                }
                EscalateOutcome::Refused { reason, message } => Ok(ActorEscalation::Refused {
                    reason: reason.as_str().to_owned(),
                    message,
                }),
            }
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

impl<A: ActorAgents> TurnRunner for AgentTurnRunner<A> {
    fn run_turn(
        &self,
        session: &str,
        interaction: &str,
        turn: &TurnInput,
        cancel: &AtomicBool,
    ) -> Result<String, TurnFailure> {
        debug_assert!(
            Handle::try_current().is_err(),
            "the ask thread must not be inside a runtime: block_on would panic there"
        );
        // The session's persona and model, fixed when it was created. Without a settings map the base's are used.
        let (persona_prompt, selection) = match &self.settings {
            None => (
                self.base.persona_prompt.clone(),
                self.base.selection.clone(),
            ),
            Some(settings) => match settings.get(session) {
                Some(settings) => (settings.persona, settings.selection),
                None => return Err(TurnFailure::plain(NO_SETTINGS)),
            },
        };
        let Some(selection) = selection else {
            return Err(TurnFailure::plain(NO_SELECTION));
        };
        let token = CancellationToken::new();
        // One gate per turn, bound to this turn's session: the owner reports a write by session, so a gate kept from
        // an earlier ask would name that ask's session. The owner dedupes the reports of one ask.
        let gate = Arc::new(FirstMutating::new(Arc::new(MailboxGate {
            mailbox: self.mailbox.clone(),
            session: session.to_owned(),
        })));
        // One observer per turn, bound to this turn's session, as the gate is: the owner finds the ask by session.
        let requests = Arc::new(MailboxRequests(Mutex::new(AskObserver::new(
            self.mailbox.clone(),
            session,
        ))));
        let run = ActorRun {
            child: SessionId::new(session),
            parent: self.base.parent.clone(),
            interaction_description: interaction.to_owned(),
            interactions: self.base.interactions.clone(),
            persona_prompt,
            workspace: self.base.workspace.clone(),
            selection,
            mode: self.base.mode,
            port: Some(SubmitPort {
                port: Arc::new(MailboxPort {
                    mailbox: self.mailbox.clone(),
                    session: session.to_owned(),
                    clock: self.base.clock.clone(),
                    cancel: token.clone(),
                }),
                submit_schema: turn.submit_schema.clone(),
            }),
            // Every turn of the bridge has a boundary, so it is stored, a nudged turn's 0 included.
            epilogue_start: Some(turn.epilogue_start),
            on_mutating: Some(gate),
            on_request: Some(requests),
            admission_run: self.base.admission_run.clone(),
        };
        let end = self.handle.block_on(async {
            let work = self.agents.run_actor_turn(run, &turn.text, token.clone());
            tokio::pin!(work);
            loop {
                tokio::select! {
                    end = &mut work => break end,
                    () = tokio::time::sleep(CANCEL_POLL) => {
                        if cancel.load(Ordering::SeqCst) {
                            token.cancel();
                        }
                    }
                }
            }
        });
        match end {
            ActorTurnEnd::Text(text) => Ok(text),
            ActorTurnEnd::Failed(error) => Err(TurnFailure::plain(error)),
            ActorTurnEnd::ModelFailed { message, model } => Err(TurnFailure::model(message, model)),
            ActorTurnEnd::Stopped => Err(TurnFailure::plain("the actor turn was stopped")),
        }
    }

    fn message_boundary(&self, session: &str) -> Option<u64> {
        self.agents.turn_messages(&SessionId::new(session))
    }

    fn turn_stats(&self, session: &str) -> Option<TurnStats> {
        // Node `statsFromTurn`: a failed usage read (no tokens) keeps the counts and takes the usage defaults.
        self.agents
            .actor_turn_stats(&SessionId::new(session))
            .map(|stats| TurnStats {
                tool_calls: stats.tool_calls,
                world_tool_calls: stats.world_tool_calls,
                usage: stats.tokens.map(|tokens| TurnUsage {
                    tokens,
                    requests: stats.requests,
                }),
            })
    }
}
