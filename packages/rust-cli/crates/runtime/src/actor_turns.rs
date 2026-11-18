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
//! - A cancelled turn ends as an error here (`Stopped`); the workflow loop reads its cancel flag and reports nothing.
//!
//! Deviations, recorded in the spec: the persona prompt and the parent are one value for the whole runner (`ActorRunBase`).
//! The workflow does not pass a persona per turn, so a runner serves one persona. Each actor gets its own child session.
//! The interaction description (the origin of its asks) comes with each turn, as the workflow passes it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_agents::actor_turn::{
    ActorEscalation, ActorPort, ActorQuestion, ActorRun, ActorSubmit, ActorTurnEnd, ActorViolation,
};
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::orchestration::Interactions;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_workflow::actor_mailbox::ActorHandle;
use rust_cli_workflow::actor_turns::TurnRunner;
use rust_cli_workflow::driver_owner::SubmitReply;
use rust_cli_workflow::driver_rules::{actor_permission_policy, parse_subagent_permission_mode};
use rust_cli_workflow::engine::SubmitVerdict;
use rust_cli_workflow::escalation::{EscalateOutcome, EscalationRequest};
use rust_cli_workflow::model::Ref;
use serde_json::Value;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

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
    pub selection: ModelSelection,
    pub mode: PermissionMode,
    pub persona_prompt: String,
    pub interactions: Option<Arc<dyn Interactions>>,
    /// The runtime's clock: an escalation is stamped with the time it was asked.
    pub clock: Arc<dyn Clock>,
}

/// Renders the interactions by presence: the channel is a trait object with no `Debug`.
impl std::fmt::Debug for ActorRunBase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActorRunBase")
            .field("parent", &self.parent)
            .field("workspace", &self.workspace)
            .field("selection", &self.selection)
            .field("mode", &self.mode)
            .field("persona_prompt", &self.persona_prompt)
            .field(
                "interactions",
                &self.interactions.as_ref().map(|_| "present"),
            )
            .finish()
    }
}

/// The workflow's turn runner over the agents crate.
pub struct AgentTurnRunner<A: ActorAgents> {
    agents: Arc<A>,
    handle: Handle,
    base: ActorRunBase,
    mailbox: ActorHandle,
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
        }
    }
}

/// The submit port of one turn over the workflow's mailbox (Node `workflowSubmitPort`). The engine decides the result on
/// the owner's thread, so the call waits on the blocking pool, not on a runtime worker.
struct MailboxPort {
    mailbox: ActorHandle,
    session: String,
    clock: Arc<dyn Clock>,
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
        tokio::task::spawn_blocking(move || {
            match mailbox
                .escalate(&session, request)
                .map_err(|error| error.to_string())?
            {
                EscalateOutcome::Parked { qid } => {
                    let answer = mailbox.parked().wait(&qid)?;
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
        // The epilogue boundary is persisted with the user message in the next PR (spec 9.8f, 2c-3b part 2).
        _epilogue_start: usize,
        prompt: &str,
        cancel: &AtomicBool,
    ) -> Result<String, String> {
        debug_assert!(
            Handle::try_current().is_err(),
            "the ask thread must not be inside a runtime: block_on would panic there"
        );
        let token = CancellationToken::new();
        let run = ActorRun {
            child: SessionId::new(session),
            parent: self.base.parent.clone(),
            interaction_description: interaction.to_owned(),
            interactions: self.base.interactions.clone(),
            persona_prompt: self.base.persona_prompt.clone(),
            workspace: self.base.workspace.clone(),
            selection: self.base.selection.clone(),
            mode: self.base.mode,
            port: Some(Arc::new(MailboxPort {
                mailbox: self.mailbox.clone(),
                session: session.to_owned(),
                clock: self.base.clock.clone(),
            })),
        };
        let end = self.handle.block_on(async {
            let work = self.agents.run_actor_turn(run, prompt, token.clone());
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
            ActorTurnEnd::Failed(error) => Err(error),
            ActorTurnEnd::Stopped => Err("the actor turn was stopped".to_owned()),
        }
    }
}
