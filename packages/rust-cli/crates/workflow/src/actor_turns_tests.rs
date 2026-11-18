//! The turn loop over an injected `TurnRunner` (W6a part 2c-2a). Each ask runs on its own thread; the owner is served
//! here, on the test thread, through the mailbox.
use crate::actor_mailbox::ActorMailbox;
use crate::actor_sessions::ActorTurns;
use crate::actor_turns::{MailboxTurns, TurnRunner};
use crate::driver_owner::{ActorDriverOwner, ActorSessionRequest, ActorSessions};
use crate::driver_owner_tests::config;
use crate::driver_rules::NUDGE_PROMPT;
use crate::engine::AskMessage;
use crate::error::ErrorCode;
use crate::journal::MemoryJournal;
use crate::model::Ref;
use anyhow::Result;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// The first input of the scripted actor: "do it" with the quality and schema epilogues (schema `{"type": "object"}`).
fn composed_do_it() -> String {
    use crate::driver_rules as rules;
    let schema = json!({"type": "object"});
    format!(
        "do it{}{}",
        rules::quality_epilogue(Some(&schema)),
        rules::schema_epilogue(Some(&schema))
    )
}

/// Replies in order; records every prompt and every interaction description it was given.
struct ScriptedRunner {
    prompts: Mutex<Vec<String>>,
    interactions: Mutex<Vec<String>>,
    epilogue_starts: Mutex<Vec<usize>>,
    replies: Mutex<VecDeque<std::result::Result<String, String>>>,
}

impl ScriptedRunner {
    fn new(replies: Vec<std::result::Result<String, String>>) -> Arc<Self> {
        Arc::new(Self {
            prompts: Mutex::new(Vec::new()),
            interactions: Mutex::new(Vec::new()),
            epilogue_starts: Mutex::new(Vec::new()),
            replies: Mutex::new(replies.into()),
        })
    }
}

impl TurnRunner for ScriptedRunner {
    fn run_turn(
        &self,
        _session: &str,
        interaction: &str,
        epilogue_start: usize,
        prompt: &str,
        _cancel: &AtomicBool,
    ) -> std::result::Result<String, String> {
        self.interactions
            .lock()
            .expect("interactions")
            .push(interaction.to_owned());
        self.epilogue_starts
            .lock()
            .expect("epilogue starts")
            .push(epilogue_start);
        self.prompts
            .lock()
            .expect("prompts")
            .push(prompt.to_owned());
        self.replies
            .lock()
            .expect("replies")
            .pop_front()
            .unwrap_or_else(|| Ok("done".into()))
    }
}

/// Reports that it started, then runs until the owner cancels its ask, then returns. It never submits.
struct UntilCancelled {
    started: Sender<()>,
    finished: Sender<()>,
}

impl TurnRunner for UntilCancelled {
    fn run_turn(
        &self,
        _session: &str,
        _interaction: &str,
        _epilogue_start: usize,
        _prompt: &str,
        cancel: &AtomicBool,
    ) -> std::result::Result<String, String> {
        let _ = self.started.send(());
        while !cancel.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(1));
        }
        let _ = self.finished.send(());
        Ok("late".into())
    }
}

/// The turn side the owner sees: sessions are fixed names, and turns are the loop under test.
struct TestSessions {
    turns: MailboxTurns,
}

impl ActorSessions for TestSessions {
    fn create_session(&mut self, request: &ActorSessionRequest) -> Result<String> {
        Ok(format!("sess_{}", request.actor.key()))
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

fn owner_over(
    runner: Arc<dyn TurnRunner>,
) -> (
    ActorDriverOwner<MemoryJournal, TestSessions>,
    ActorMailbox,
    String,
) {
    let (mailbox, handle) = ActorMailbox::new();
    let sessions = TestSessions {
        turns: MailboxTurns::new(runner, handle),
    };
    let mut owner = ActorDriverOwner::new(config(), MemoryJournal::new(), sessions).expect("owner");
    let actor = owner.create_actor("site", None, None).expect("actor");
    (owner, mailbox, actor)
}

#[test]
fn a_parked_question_is_answered_or_withdrawn_through_the_turn_side() {
    use crate::actor_sessions::ActorTurns;
    let (_mailbox, handle) = crate::actor_mailbox::ActorMailbox::new();
    let mut turns = MailboxTurns::new(ScriptedRunner::new(Vec::new()), handle.clone());
    let parked = handle.parked();
    // A blocked escalate waits on its question; the owner's answer wakes it with the text.
    let answered = {
        let parked = parked.clone();
        std::thread::spawn(move || parked.wait("q1"))
    };
    turns.deliver_answer("sess", "q1", "yes").expect("deliver");
    assert_eq!(answered.join().expect("join"), Ok("yes".to_owned()));
    // A withdrawn question wakes its waiter with an error, so the tool fails instead of hanging.
    let withdrawn = std::thread::spawn(move || parked.wait("q2"));
    turns.reject_parked("sess", "q2").expect("reject");
    assert!(withdrawn.join().expect("join").is_err());
}

#[test]
fn a_turn_without_a_submit_is_nudged_and_the_nudged_turn_runs_with_the_nudge_prompt() {
    let runner = ScriptedRunner::new(vec![Ok("first".into()), Ok("second".into())]);
    let (mut owner, mailbox, actor) = owner_over(runner.clone());
    owner.ask("site", &actor, "do it").expect("ask");
    // The engine dispatches the ask during its drain; the turn starts there.
    owner.drain().expect("drain");
    // The first turn ends and is nudged; the nudged turn ends and the ask settles as ResultNotSubmitted.
    mailbox.serve_next(&mut owner).expect("the first turn end");
    mailbox.serve_next(&mut owner).expect("the second turn end");
    assert_eq!(
        *runner.prompts.lock().expect("prompts"),
        vec![composed_do_it(), NUDGE_PROMPT.to_owned()]
    );
    // The first turn starts at the instructions' end, and the nudged turn starts at 0 (Node `runTurn(NUDGE_PROMPT, 0)`).
    assert_eq!(
        *runner.epilogue_starts.lock().expect("epilogue starts"),
        vec![5, 0]
    );
    // The nudged turn is the same actor, so it is named by the same interaction description.
    assert_eq!(
        *runner.interactions.lock().expect("interactions"),
        vec![
            "subagent (site@1)".to_owned(),
            "subagent (site@1)".to_owned()
        ]
    );
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    let error = outcomes[0].result.as_ref().expect_err("the ask fails");
    assert_eq!(error.code, ErrorCode::ResultNotSubmitted);
}

#[test]
fn a_refused_turn_fails_the_ask_with_the_runners_text() {
    let runner = ScriptedRunner::new(vec![Err("model refused the request".into())]);
    let (mut owner, mailbox, actor) = owner_over(runner);
    owner.ask("site", &actor, "do it").expect("ask");
    // The engine dispatches the ask during its drain; the turn starts there.
    owner.drain().expect("drain");
    mailbox.serve_next(&mut owner).expect("the turn failure");
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    let error = outcomes[0].result.as_ref().expect_err("the ask fails");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert!(
        error.message.contains("model refused the request"),
        "{}",
        error.message
    );
}

#[test]
fn a_cancelled_turn_sends_no_turn_end_and_the_ask_is_cancelled() {
    let (started_tx, started) = channel();
    let (finished_tx, finished) = channel();
    let runner: Arc<dyn TurnRunner> = Arc::new(UntilCancelled {
        started: started_tx,
        finished: finished_tx,
    });
    let (mut owner, mailbox, actor) = owner_over(runner);
    owner.ask("site", &actor, "do it").expect("ask");
    // The engine dispatches the ask during its drain; the turn starts there.
    owner.drain().expect("drain");
    started.recv().expect("the turn is running");
    owner.complete(json!("done")).expect("complete");
    finished
        .recv()
        .expect("the runner observed the cancel and returned");
    // A turn end sent after the cancel would wait for a reply nobody serves; nothing must have been queued.
    thread::sleep(Duration::from_millis(100));
    assert!(
        mailbox.try_take().is_none(),
        "a cancelled turn must not report its end"
    );
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    let error = outcomes[0].result.as_ref().expect_err("cancelled");
    assert_eq!(error.code, ErrorCode::Cancelled);
}

/// Panics on every turn, as a runner whose model client throws would.
struct PanickingRunner;

impl TurnRunner for PanickingRunner {
    fn run_turn(
        &self,
        _session: &str,
        _interaction: &str,
        _epilogue_start: usize,
        _prompt: &str,
        _cancel: &AtomicBool,
    ) -> std::result::Result<String, String> {
        panic!("runner exploded mid-turn");
    }
}

#[test]
fn a_panicking_turn_fails_the_ask_with_the_panic_text_and_nothing_hangs() {
    let (mut owner, mailbox, actor) = owner_over(Arc::new(PanickingRunner));
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    // Without the panic report, nothing is ever queued and this serve blocks forever.
    mailbox
        .serve_next(&mut owner)
        .expect("the panic is reported as the turn's failure");
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    let error = outcomes[0].result.as_ref().expect_err("the ask fails");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert!(
        error.message.contains("runner exploded mid-turn"),
        "{}",
        error.message
    );
}
