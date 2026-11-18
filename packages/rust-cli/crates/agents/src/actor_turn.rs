//! One turn of a workflow actor, as the workflow's turn loop reads its end (W6a part 2c-2b; spec section 9.8e).
//!
//! Node's `executeTurn` resolves with the turn's `response` (its final text), and a turn that rejects is either cancelled
//! (silent) or a failure (`askFailed`). `spawn::drive` produces the same three cases as `Finished`: a completed run, a
//! failed run, and a killed run. [`actor_turn_end`] maps those parts to the three cases the workflow reads.
//!
//! [`Agents::run_actor_turn`] is the turn-by-turn entry. The child session is created by the workflow (its row is
//! Node's `workflow_child`), and the first call makes the actor's live entry. Each call runs one turn with
//! `spawn::resume` (the prompt is appended to the child's transcript) and `spawn::drive`. The session persists
//! between calls, so the next turn continues it.
//!
//! Deviations, recorded in the spec: the actor's definition is built here with `AgentSource::BuiltIn` (the source only
//! affects catalog listing, and an actor is not a catalog entry). Its run is never a notification run, so it does not
//! claim routes (`Live::restart` does, and is not used here). Its `background` flag is set, so a foreground-only path
//! never treats it as one.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::env_shell::BackgroundStatus;
use rust_cli_kernel_api::ids::{AgentId, MachineName, SessionId};
use rust_cli_kernel_api::message::UserOrigin;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::orchestration::Interactions;
use rust_cli_kernel_api::permission::PermissionMode;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::child::Asks;
use crate::definitions::{AgentDefinition, AgentSource};
use crate::live::{AgentState, BeginActorRun, LiveAgent, Shown};
use crate::report::Ending;
use crate::spawn;

/// How an actor's turn ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActorTurnEnd {
    /// The turn completed; the text is its final text (Node's `result.response`).
    Text(String),
    /// The turn failed; the text is the failure (Node's `askFailed(toWorkflowError(error))`).
    Failed(String),
    /// The turn was stopped (cancelled or killed). Node reports nothing for a cancelled turn.
    Stopped,
}

/// Map a finished run's parts to the turn's end. A killed run is `Stopped` whatever else it carries. A failure takes
/// precedence over the text: a failed turn's text is not its result.
pub fn actor_turn_end(killed: bool, failure: Option<&str>, text: &str) -> ActorTurnEnd {
    if killed {
        return ActorTurnEnd::Stopped;
    }
    match failure {
        Some(error) => ActorTurnEnd::Failed(error.to_owned()),
        None => ActorTurnEnd::Text(text.to_owned()),
    }
}

/// One violation of a submitted result (Node `SubmitViolation`): where the result differs from the schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActorViolation {
    pub path: String,
    pub expected: String,
    pub got: String,
}

/// The engine's answer to a submitted result (Node `SubmitVerdict`). A refusal of the port is an `Err`, not a verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActorSubmit {
    Accepted,
    Rejected(Vec<ActorViolation>),
}

/// A question an actor escalates to the main agent (Node `escalate`'s input).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActorQuestion {
    pub question: String,
    /// What the actor already tried and where it is stuck (Node's `context`).
    pub context: Option<String>,
}

/// The main agent's answer to an escalated question, or the refusal that parked nothing (Node `escalate` outcome).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActorEscalation {
    /// The question was parked under `qid` and the main agent answered it.
    Answered { qid: String, answer: String },
    /// Nothing was parked: `reason` is the refusal's name and `message` is the text the model reads.
    Refused { reason: String, message: String },
}

/// The submit port of one actor turn (Node `workflowSubmitPort`): the `submit_result` tool hands the result here and
/// waits for the engine's verdict, and the `escalate` tool asks the main agent through the same port. The port is bound to
/// the actor's session, so the model cannot pick another one.
#[async_trait]
pub trait ActorPort: Send + Sync + 'static {
    async fn submit(&self, result: Value) -> Result<ActorSubmit, String>;

    /// Escalate a question and wait for the main agent's answer (Node `workflowEscalatePort.escalate`).
    async fn escalate(&self, question: ActorQuestion) -> Result<ActorEscalation, String>;
}

/// A turn's submit port as the live entry holds it: the port, and the mono session's submit schema (None for a generic
/// session), which the submit tool declares. Its `Debug` says only that there is one, as `child::Asks` does.
#[derive(Clone)]
pub(crate) struct SubmitPort {
    pub(crate) port: Arc<dyn ActorPort>,
    pub(crate) submit_schema: Option<Value>,
}

impl std::fmt::Debug for SubmitPort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SubmitPort")
    }
}

/// The parts of an actor's run the workflow supplies: its child session (created by the workflow), the parent
/// session of the run, the persona's system prompt, the run's workspace, model and permission mode, and the submit port.
#[derive(Clone)]
pub struct ActorRun {
    pub child: SessionId,
    pub parent: SessionId,
    /// `<persona name ?? "subagent"> (<site>@<ordinal>)`: the origin of the actor's permission and interaction asks.
    pub interaction_description: String,
    /// The parent session's interactions (its broker to the user), when the runtime has them. The gate that decides
    /// whether an actor may ask is `actor_asks`, as it is for the Agent tool.
    pub interactions: Option<Arc<dyn Interactions>>,
    /// The persona's system prompt, the first part of the child's system prompt.
    pub persona_prompt: String,
    pub workspace: WorkspaceRef,
    pub selection: ModelSelection,
    pub mode: PermissionMode,
    /// The submit port of this turn. None means the child has no `submit_result` tool.
    pub port: Option<Arc<dyn ActorPort>>,
    /// The mono session's submit schema, which the turn's `submit_result` declares. None for a generic session.
    pub submit_schema: Option<Value>,
}

/// Renders the interactions by presence, as `child::Asks` does: the channel is a trait object with no `Debug`.
impl std::fmt::Debug for ActorRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActorRun")
            .field("child", &self.child)
            .field("parent", &self.parent)
            .field("interaction_description", &self.interaction_description)
            .field(
                "interactions",
                &self.interactions.as_ref().map(|_| "present"),
            )
            .field("persona_prompt", &self.persona_prompt)
            .field("workspace", &self.workspace)
            .field("selection", &self.selection)
            .field("mode", &self.mode)
            .field("port", &self.port.as_ref().map(|_| "present"))
            .finish()
    }
}

/// The asks channel of an actor. It exists only when the parent offers background prompts and its interactions have a
/// lasting channel, as the Agent tool's entry does (`core.background_prompts.then(|| context.interactions.lasting())`).
/// The channel is taken from `lasting()` here, so a caller passes the parent's interactions, not a lasting one.
pub(crate) fn actor_asks(
    background_prompts: bool,
    interactions: Option<Arc<dyn Interactions>>,
) -> Option<Asks> {
    if !background_prompts {
        return None;
    }
    interactions.and_then(|parent| parent.lasting()).map(Asks)
}

/// The tools an actor is denied: Node `workflowActorToolPolicy` (`ACTOR_DISALLOWED_TOOLS`). The plan pair has nobody to
/// approve it in a headless child. The questions to the user go through `escalate`, so only the main session answers
/// them. The meta tools would let an actor submit or amend another workflow, and the topic resource belongs to the
/// main session's inbound input. The deny list is enforced by the child's toolset (`toolset.rs`).
pub(crate) const WORKFLOW_ACTOR_DISALLOWED_TOOLS: [&str; 7] = [
    rust_cli_kernel_api::tool_names::ASK_USER_QUESTION,
    rust_cli_kernel_api::tool_names::ENTER_PLAN_MODE,
    rust_cli_kernel_api::tool_names::EXIT_PLAN_MODE,
    rust_cli_kernel_api::tool_names::CREATE_WORKFLOW,
    rust_cli_kernel_api::tool_names::AMEND_WORKFLOW,
    rust_cli_kernel_api::tool_names::READ_TOPIC_RESOURCE,
    rust_cli_kernel_api::tool_names::RESOLVE_WORKFLOW_QUESTION,
];

/// The live-map key of an actor: one per child session.
fn actor_agent_id(child: &SessionId) -> AgentId {
    AgentId::new(format!("actor-{}", child.as_str()))
}

impl LiveAgent {
    /// The live entry of an actor, as the Agent tool builds one before `spawn::create`, with the actor's values: no
    /// owner, depth 1, no tool use, no interaction channel, and no fork prefix. It starts finished; each turn begins a
    /// run on it. The run's fields are moved in, not cloned.
    pub(crate) fn for_actor(run: ActorRun, agent: AgentId, root: SessionId) -> Self {
        Self {
            off_peak_execution: None,
            agent,
            child: run.child,
            parent: run.parent,
            root,
            owner: None,
            depth: 1,
            tool_use: None,
            stopped_by_user: false,
            erased: false,
            late_messages: Vec::new(),
            description: run.interaction_description,
            definition: Arc::new(AgentDefinition {
                agent_type: "workflow_actor".to_owned(),
                when_to_use: String::new(),
                tools: None,
                disallowed_tools: WORKFLOW_ACTOR_DISALLOWED_TOOLS
                    .iter()
                    .map(|tool| (*tool).to_owned())
                    .collect(),
                prompt: run.persona_prompt,
                source: AgentSource::BuiltIn,
                model: None,
                effort: None,
                max_turns: None,
                permission_mode: None,
                background: true,
                selection: None,
                inject_agents_md: false,
                mcp_servers: None,
                skills: None,
                memory: None,
            }),
            workspace: run.workspace,
            execution_worktree: false,
            machine: MachineName::primary(),
            selection: run.selection,
            mode: run.mode,
            background: true,
            asks: None,
            actor_port: run.port.map(|port| SubmitPort {
                port,
                submit_schema: run.submit_schema,
            }),
            state: AgentState::Finished(Ending::Completed),
            result: None,
            shown: Shown::default(),
            delivered: Vec::new(),
            fork_prefix: None,
        }
    }
}

impl crate::Agents {
    /// Run one turn of an actor's ask on its child session and return how it ended.
    ///
    /// The first call for a child makes its live entry. Each call starts a run on that entry, appends `prompt` to the
    /// child's transcript (`spawn::resume`), and drives the model loop until it stops (`spawn::drive`). `cancel` stops
    /// the loop; the turn then ends as `Stopped`. A call on an actor whose turn is still running is refused as
    /// `Failed`, and it does not touch the running turn; the workflow's per-actor FIFO keeps this from happening.
    pub async fn run_actor_turn(
        &self,
        run: ActorRun,
        prompt: &str,
        cancel: CancellationToken,
    ) -> ActorTurnEnd {
        let core = &self.core;
        let agent_id = actor_agent_id(&run.child);
        let root = core.live.root_of(&run.parent);
        let execution_id = core.ports.ids.execution();
        let asks = actor_asks(core.background_prompts, run.interactions.clone());
        let description = run.interaction_description.clone();
        let fresh_asks = asks.clone();
        let submit = run.port.clone().map(|port| SubmitPort {
            port,
            submit_schema: run.submit_schema.clone(),
        });
        // The first-use check, the insert, the refresh and the run start share one lock section (`Live::begin_actor_run`).
        let started = core.live.begin_actor_run(
            &agent_id,
            || {
                let mut entry = LiveAgent::for_actor(run, agent_id.clone(), root);
                entry.asks = fresh_asks;
                entry
            },
            |entry| {
                entry.description = description;
                entry.asks = asks;
                entry.actor_port = submit;
            },
            execution_id,
        );
        if started == BeginActorRun::AlreadyRunning {
            return ActorTurnEnd::Failed("the actor already has a turn running".to_owned());
        }
        let Some(entry) = core.live.get(&agent_id) else {
            return ActorTurnEnd::Failed("the actor's session is not live".to_owned());
        };
        let opening = match spawn::resume(core, &entry, prompt, UserOrigin::Human).await {
            Ok(opening) => opening,
            Err(error) => {
                core.live.finish_actor_turn(&agent_id, Ending::Failed);
                return ActorTurnEnd::Failed(error.to_string());
            }
        };
        let finished = spawn::drive(core, &entry, opening, None, Some(cancel)).await;
        core.live.finish_actor_turn(&agent_id, finished.ending);
        actor_turn_end(
            finished.ending.status() == BackgroundStatus::Killed,
            finished.failure(core.node_desktop).as_deref(),
            &finished.report.text,
        )
    }
}

#[cfg(test)]
mod asks_tests {
    use super::actor_asks;
    use rust_cli_kernel_api::orchestration::Interactions;
    use rust_cli_kernel_api::testing::{AskOverride, NoOneToAsk, ScriptedInteractions};
    use std::sync::Arc;

    /// A parent whose interactions have a lasting channel (the session's own), as the real turn channel does.
    struct WithLasting;

    impl AskOverride for WithLasting {
        fn lasting(&self) -> Option<Arc<dyn Interactions>> {
            Some(Arc::new(NoOneToAsk))
        }
    }

    #[test]
    fn an_actor_has_an_asks_channel_only_when_the_parent_offers_background_prompts() {
        let parent = || Some(Arc::new(WithLasting) as Arc<dyn Interactions>);
        assert!(actor_asks(true, parent()).is_some());
        assert!(
            actor_asks(false, parent()).is_none(),
            "the gate applies as it does for the Agent tool"
        );
    }

    #[test]
    fn an_actor_has_no_asks_channel_without_a_parent_or_a_lasting_channel() {
        assert!(actor_asks(true, None).is_none(), "no channel means no asks");
        let no_lasting = Some(Arc::new(ScriptedInteractions::default()) as Arc<dyn Interactions>);
        assert!(
            actor_asks(true, no_lasting).is_none(),
            "a parent without a lasting channel gives the actor none"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{ActorTurnEnd, actor_turn_end};

    #[test]
    fn a_completed_turn_is_its_final_text() {
        assert_eq!(
            actor_turn_end(false, None, "the answer"),
            ActorTurnEnd::Text("the answer".to_owned())
        );
    }

    #[test]
    fn an_empty_completed_turn_is_an_empty_text_not_a_failure() {
        assert_eq!(
            actor_turn_end(false, None, ""),
            ActorTurnEnd::Text(String::new())
        );
    }

    #[test]
    fn a_failed_turn_is_the_failure_and_its_text_is_not_the_result() {
        assert_eq!(
            actor_turn_end(false, Some("model refused"), "partial"),
            ActorTurnEnd::Failed("model refused".to_owned())
        );
    }

    #[test]
    fn a_killed_turn_is_stopped_whatever_else_it_carries() {
        assert_eq!(
            actor_turn_end(true, Some("late error"), "partial"),
            ActorTurnEnd::Stopped
        );
        assert_eq!(actor_turn_end(true, None, "partial"), ActorTurnEnd::Stopped);
    }
}
