//! The turn loop of an actor's ask (W6a part 2c-2a; spec section 9.8d).
//!
//! `MailboxTurns` implements the turn side's `ActorTurns`. Starting an ask spawns a thread that runs the ask's turns
//! through a `TurnRunner` (one model turn on the child session) and reports each turn's end to the owner through the
//! mailbox. A `Nudge` verdict starts a fresh turn with `NUDGE_PROMPT`. A settled ask, or an owner that is gone, ends the
//! thread. A turn that fails is reported as `turn_failed`, which fails the ask (Node `askFailed`). A cancelled ask
//! reports nothing (Node `onTurnRejected` returns early on `state.cancelled`).
//!
//! The runner is the only part that runs a model. The agents side provides it in part 2c-2b; until then the loop is
//! tested with scripted runners.
use crate::actor_mailbox::ActorHandle;
use crate::actor_sessions::ActorTurns;
use crate::driver_owner::TurnEndReply;
use crate::driver_rules::NUDGE_PROMPT;
use crate::engine::SubmitVerdict;
use crate::model::Ref;
use anyhow::{Result, anyhow};
use std::any::Any;
use std::collections::HashMap;
use std::panic::{self, AssertUnwindSafe};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

/// One model turn on a child session. `cancel` is set when the owner cancels the ask; a runner should stop early when
/// it is set. The returned text is the turn's final text.
///
/// `interaction` is the actor's interaction description (`<persona name ?? "subagent"> (<site>@<ordinal>)`), the origin
/// its permission and interaction asks are named by. It is the same for every turn of the actor, nudged turns included.
pub trait TurnRunner: Send + Sync + 'static {
    fn run_turn(
        &self,
        session: &str,
        interaction: &str,
        turn: &TurnInput,
        cancel: &AtomicBool,
    ) -> std::result::Result<String, String>;

    /// The session's message count, read after its ask settles (Node `journalAskMessageBoundary`'s count). None means
    /// the count is not known, and no boundary is written.
    fn message_boundary(&self, _session: &str) -> Option<u64> {
        None
    }
}

/// One turn's input: the text the model reads, the boundary in UTF-16 units where its epilogue begins (Node `runTurn`'s
/// `epilogueStart`: the instructions' length for the first turn of an ask, 0 for a nudge), and the submit schema the
/// turn's `submit_result` declares. The schema is None in two cases: a generic session, and an untyped ask on a mono
/// session (the owner sends no schema for an ask that has none). A nudge keeps the schema of the turn it follows.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnInput {
    pub text: String,
    pub epilogue_start: usize,
    pub submit_schema: Option<serde_json::Value>,
}

/// The turn side of an actor: one thread per ask, reporting through the mailbox.
pub struct MailboxTurns {
    runner: Arc<dyn TurnRunner>,
    handle: ActorHandle,
    /// Cancel flag per ask, keyed by instance. An entry is removed when its ask is cancelled; an ask that settles
    /// normally keeps its entry (a flag nobody sets), so the map grows by one per ask in the run.
    cancels: HashMap<String, Arc<AtomicBool>>,
}

impl MailboxTurns {
    pub fn new(runner: Arc<dyn TurnRunner>, handle: ActorHandle) -> Self {
        Self {
            runner,
            handle,
            cancels: HashMap::new(),
        }
    }
}

impl ActorTurns for MailboxTurns {
    fn start_turn(
        &mut self,
        session: &str,
        instance: &Ref,
        input: &TurnInput,
        interaction: &str,
    ) -> Result<()> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels.insert(instance.key(), cancel.clone());
        let runner = self.runner.clone();
        let handle = self.handle.clone();
        let session = session.to_owned();
        let first = input.clone();
        let interaction = interaction.to_owned();
        let turn_instance = instance.clone();
        thread::Builder::new()
            .name(format!("actor-turn-{}", instance.key()))
            .spawn(move || {
                run_ask(
                    runner.as_ref(),
                    &handle,
                    &session,
                    &turn_instance,
                    &interaction,
                    first,
                    &cancel,
                )
            })
            .map_err(|error| anyhow!("the actor's turn thread could not start: {error}"))?;
        Ok(())
    }

    /// A cancelled ask's turn is gone, so the answers its session was never waited for are dropped. The owner runs on one
    /// thread, so this is ordered before any later start on the same session.
    fn cancel_turn(&mut self, session: &str, instance: &Ref) -> Result<()> {
        if let Some(flag) = self.cancels.remove(&instance.key()) {
            flag.store(true, Ordering::SeqCst);
        }
        self.handle.parked().discard_session(session);
        Ok(())
    }

    /// The owner withdrew a parked question: its blocked escalate fails with the reason, and nothing waits on it.
    fn reject_parked(&mut self, session: &str, qid: &str) -> Result<()> {
        self.handle.parked().reject(
            session,
            qid,
            "the question was withdrawn before it was answered",
        );
        Ok(())
    }

    /// The owner accepted an answer: the blocked escalate of the question returns it.
    fn deliver_answer(&mut self, session: &str, qid: &str, answer: &str) -> Result<()> {
        self.handle.parked().deliver(session, qid, answer);
        Ok(())
    }
}

/// The loop of one ask: a turn, its end reported, then a nudged turn for as long as the owner asks for one.
fn run_ask(
    runner: &dyn TurnRunner,
    handle: &ActorHandle,
    session: &str,
    instance: &Ref,
    interaction: &str,
    first: TurnInput,
    cancel: &AtomicBool,
) {
    let mut turn = first;
    loop {
        // Node catches every throw from a turn and reports it as the ask's failure. A panic is the Rust equivalent,
        // and it must not leave the ask waiting on a thread that is gone.
        let outcome = panic::catch_unwind(AssertUnwindSafe(|| {
            runner.run_turn(session, interaction, &turn, cancel)
        }))
        .unwrap_or_else(|payload| Err(panic_text(payload.as_ref())));
        let text = match outcome {
            Ok(text) => text,
            Err(error) => {
                if !cancel.load(Ordering::SeqCst)
                    && let Err(report) = handle.turn_failed(session, &error)
                {
                    tracing::warn!(%session, error = %report, "an actor's failed turn could not be reported");
                }
                return;
            }
        };
        // A turn that ends after its ask was cancelled reports nothing: the owner has already settled the ask.
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        // Counted while the ask is still active: a newer ask cannot start before this one settles, so this is the count
        // at settlement (Node reads it there) and no race with a later prompt can change it.
        let boundary = runner.message_boundary(session);
        match handle.turn_ended(session, &text) {
            Ok(TurnEndReply::Verdict(SubmitVerdict::Nudge)) => {
                // Node `runTurn(NUDGE_PROMPT, 0)`: the nudge has no instructions, so its epilogue starts at 0. It is the
                // same session, so it keeps the submit schema: only the text and the boundary change.
                turn.text = NUDGE_PROMPT.to_owned();
                turn.epilogue_start = 0;
            }
            Ok(_) => {
                // The ask settled. Its message boundary goes on its node row, named by the instance this turn ran for.
                if let Some(boundary) = boundary
                    && let Err(report) = handle.message_boundary(instance, boundary)
                {
                    tracing::warn!(%session, error = %report, "an actor's message boundary could not be reported");
                }
                return;
            }
            Err(report) => {
                tracing::warn!(%session, error = %report, "an actor's turn end could not be reported");
                return;
            }
        }
    }
}

/// The text of a panic payload: `panic!` with a literal gives `&str`, with a format gives `String`.
fn panic_text(payload: &(dyn Any + Send)) -> String {
    let message = payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a non-text panic".to_owned());
    format!("the actor turn panicked: {message}")
}
