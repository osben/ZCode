//! The session side of an actor (W6a part 2b; spec section 9.8b).
//!
//! `NodeActorSessions` implements the driver owner's `ActorSessions`. Creating an actor's session writes Node's
//! `workflow_child` row under the run's parent, and the `workflow_actor` task link, through node-store's writers. The
//! session id is `mint_actor_session_id`, the same function the replay envelope uses. Turn calls are delegated to
//! `ActorTurns`, the turn side, which is not part of this module.
use crate::driver_owner::{ActorSessionRequest, ActorSessions};
use crate::engine::AskMessage;
use crate::model::Ref;
use anyhow::{Result, bail};
use rust_cli_node_store::dwf::{
    WorkflowActorLink, WorkflowActorSession, create_workflow_actor_session,
    insert_workflow_actor_link,
};
use rust_cli_node_store::mint_actor_session_id;

/// The turn side of an actor's session: runs the turns of asks, and releases what an ask leaves behind.
pub trait ActorTurns {
    /// Starts one ask's turn on `session`. `input` is the turn's text with its epilogue, composed by the owner.
    /// `epilogue_start` is where that epilogue begins, in UTF-16 code units (Node's `epilogueStart`): an offset in
    /// UTF-16 units, not a byte offset, so it must not be used to slice a Rust string. `interaction` is the description
    /// the actor's asks are named by. The prompt is `input`; the ask's instructions are not read again.
    fn start_turn(
        &mut self,
        session: &str,
        instance: &Ref,
        input: &str,
        epilogue_start: usize,
        interaction: &str,
    ) -> Result<()>;
    fn cancel_turn(&mut self, session: &str, instance: &Ref) -> Result<()>;
    fn reject_parked(&mut self, session: &str, qid: &str) -> Result<()>;
    fn deliver_answer(&mut self, session: &str, qid: &str, answer: &str) -> Result<()>;
}

/// Session creation on the shared session database, with the turn side injected.
pub struct NodeActorSessions<'a, T: ActorTurns> {
    conn: &'a rusqlite::Connection,
    directory: String,
    version: String,
    clock: fn() -> i64,
    turns: T,
}

impl<'a, T: ActorTurns> NodeActorSessions<'a, T> {
    /// `directory` is the run's workspace directory, `version` the writing build's version (both as Node writes them).
    pub fn new(
        conn: &'a rusqlite::Connection,
        directory: &str,
        version: &str,
        clock: fn() -> i64,
        turns: T,
    ) -> Self {
        Self {
            conn,
            directory: directory.to_owned(),
            version: version.to_owned(),
            clock,
            turns,
        }
    }

    /// The turn side, back from the adapter (tests read what it recorded).
    pub fn into_turns(self) -> T {
        self.turns
    }
}

impl<T: ActorTurns> ActorSessions for NodeActorSessions<'_, T> {
    /// Node `createActorSession` then `persistActorSession`: the row, then the link. The parent is required, since
    /// the sessions list hides children by `parent_id` and an unparented actor would show up as a root.
    fn create_session(&mut self, request: &ActorSessionRequest) -> Result<String> {
        let Some(parent) = request.parent_session_id.as_deref() else {
            bail!("a workflow actor needs its parent session, and the run has none");
        };
        let id = mint_actor_session_id(
            &request.run_id,
            &request.actor.site_id,
            request.actor.ordinal as f64,
        );
        let now = (self.clock)();
        create_workflow_actor_session(
            self.conn,
            &WorkflowActorSession {
                id: &id,
                parent_session_id: parent,
                directory: &self.directory,
                title: &request.title,
                trace_id: parent,
                version: &self.version,
                created_at: now,
            },
        )?;
        let link_id = format!("tasklink_{id}");
        insert_workflow_actor_link(
            self.conn,
            &WorkflowActorLink {
                id: &link_id,
                child_session_id: &id,
                parent_session_id: Some(parent),
                path: &request.link_path,
                status: "running",
            },
            now,
        )?;
        Ok(id)
    }

    fn start_turn(
        &mut self,
        session: &str,
        instance: &Ref,
        _message: &AskMessage,
        input: &str,
        epilogue_start: usize,
        interaction: &str,
    ) -> Result<()> {
        self.turns
            .start_turn(session, instance, input, epilogue_start, interaction)
    }

    fn cancel_turn(&mut self, session: &str, instance: &Ref) -> Result<()> {
        self.turns.cancel_turn(session, instance)
    }

    fn reject_parked(&mut self, session: &str, qid: &str) -> Result<()> {
        self.turns.reject_parked(session, qid)
    }

    fn deliver_answer(&mut self, session: &str, qid: &str, answer: &str) -> Result<()> {
        self.turns.deliver_answer(session, qid, answer)
    }
}
