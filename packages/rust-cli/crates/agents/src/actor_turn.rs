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

use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::env_shell::BackgroundStatus;
use rust_cli_kernel_api::ids::{AgentId, MachineName, SessionId};
use rust_cli_kernel_api::message::UserOrigin;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use tokio_util::sync::CancellationToken;

use crate::definitions::{AgentDefinition, AgentSource};
use crate::live::{AgentState, LiveAgent, Shown};
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

/// The parts of an actor's run the workflow supplies: its child session (created by the workflow), the parent
/// session of the run, the persona's system prompt, and the run's workspace, model and permission mode.
#[derive(Debug, Clone, PartialEq)]
pub struct ActorRun {
    pub child: SessionId,
    pub parent: SessionId,
    pub description: String,
    /// The persona's system prompt, the first part of the child's system prompt.
    pub persona_prompt: String,
    pub workspace: WorkspaceRef,
    pub selection: ModelSelection,
    pub mode: PermissionMode,
}

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
            description: run.description,
            definition: Arc::new(AgentDefinition {
                agent_type: "workflow_actor".to_owned(),
                when_to_use: String::new(),
                tools: None,
                disallowed_tools: Vec::new(),
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
        // The first-use check, the insert and the run start share one lock section (`Live::begin_actor_run`).
        let started = core.live.begin_actor_run(
            &agent_id,
            || LiveAgent::for_actor(run, agent_id.clone(), root),
            execution_id,
        );
        if let Err(message) = started {
            return ActorTurnEnd::Failed(message);
        }
        let Some(entry) = core.live.get(&agent_id) else {
            return ActorTurnEnd::Failed("the actor's session is not live".to_owned());
        };
        let opening = match spawn::resume(core, &entry, prompt, UserOrigin::Human).await {
            Ok(opening) => opening,
            Err(error) => {
                core.live.finish(&agent_id, Ending::Failed);
                return ActorTurnEnd::Failed(error.to_string());
            }
        };
        let finished = spawn::drive(core, &entry, opening, None, Some(cancel)).await;
        core.live.finish(&agent_id, finished.ending);
        actor_turn_end(
            finished.ending.status() == BackgroundStatus::Killed,
            finished.failure(core.node_desktop).as_deref(),
            &finished.report.text,
        )
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
