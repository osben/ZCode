//! The session side of an actor (W6a part 2b; spec section 9.8b).
//!
//! `NodeActorSessions` implements the driver owner's `ActorSessions`. Creating an actor's session writes Node's
//! `workflow_child` row under the run's parent, and the `workflow_actor` task link, through node-store's writers. The
//! session id is `mint_actor_session_id`, the same function the replay envelope uses. Turn calls are delegated to
//! `ActorTurns`, the turn side, which is not part of this module.
use crate::actor_turns::TurnInput;
use crate::driver_owner::{ActorSessionRequest, ActorSessions};
use crate::engine::AskMessage;
use crate::model::Ref;
use anyhow::{Result, bail};
use rust_cli_node_store::dwf::{
    WorkflowActorLink, WorkflowActorSession, create_workflow_actor_session,
    insert_workflow_actor_link,
};
use rust_cli_node_store::mint_actor_session_id;
use std::borrow::Borrow;

/// The turn side of an actor's session: runs the turns of asks, and releases what an ask leaves behind.
pub trait ActorTurns {
    /// Starts one ask's turn on `session`, with the input the owner composed (a `TurnInput`):
    /// - `text`: the turn's prompt, the instructions with their epilogue. The ask's instructions are not read again.
    /// - `epilogue_start`: where that epilogue begins, in UTF-16 code units (Node's `epilogueStart`). It is an offset in
    ///   UTF-16 units, not a byte offset, so it must not be used to slice a Rust string.
    /// - `submit_schema`: the mono session's schema, which the turn's `submit_result` declares. None for a generic
    ///   session, and for an untyped ask on a mono session.
    ///
    /// `interaction` is the description the actor's asks are named by.
    fn start_turn(
        &mut self,
        session: &str,
        instance: &Ref,
        input: &TurnInput,
        interaction: &str,
    ) -> Result<()>;
    fn cancel_turn(&mut self, session: &str, instance: &Ref) -> Result<()>;
    fn reject_parked(&mut self, session: &str, qid: &str) -> Result<()>;
    fn deliver_answer(&mut self, session: &str, qid: &str, answer: &str) -> Result<()>;
    /// The session's close (Node `releaseActorSessions` for one session). Closes now when no turn runs; otherwise when
    /// the running turn lands. Once per session: a second request for the same session is a no-op.
    fn close_session(&mut self, session: &str) -> Result<()>;
    /// Drains the deferred closes that the turn side refused after their turn landed, as (session, message).
    fn take_close_failures(&mut self) -> Vec<(String, String)> {
        Vec::new()
    }
}

/// Session creation on the shared session database, with the turn side injected. `C` is the connection: a borrow of the
/// app's, or an owned one for an owner on its own thread (9.30).
pub struct NodeActorSessions<C: Borrow<rusqlite::Connection>, T: ActorTurns> {
    conn: C,
    directory: String,
    version: String,
    clock: fn() -> i64,
    turns: T,
}

impl<C: Borrow<rusqlite::Connection>, T: ActorTurns> NodeActorSessions<C, T> {
    /// `directory` is the run's workspace directory, `version` the writing build's version (both as Node writes them).
    pub fn new(conn: C, directory: &str, version: &str, clock: fn() -> i64, turns: T) -> Self {
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

impl<C: Borrow<rusqlite::Connection>, T: ActorTurns> ActorSessions for NodeActorSessions<C, T> {
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
            self.conn.borrow(),
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
            self.conn.borrow(),
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
        input: &TurnInput,
        interaction: &str,
    ) -> Result<()> {
        self.turns.start_turn(session, instance, input, interaction)
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

    fn close_session(&mut self, session: &str) -> Result<()> {
        self.turns.close_session(session)
    }

    fn take_close_failures(&mut self) -> Vec<(String, String)> {
        self.turns.take_close_failures()
    }
}
