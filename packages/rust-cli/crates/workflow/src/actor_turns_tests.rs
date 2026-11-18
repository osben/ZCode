//! The turn loop over an injected `TurnRunner` (W6a part 2c-2a). Each ask runs on its own thread; the owner is served
//! here, on the test thread, through the mailbox.
use crate::actor_mailbox::ActorMailbox;
use crate::actor_sessions::ActorTurns;
use crate::actor_turns::{MailboxTurns, TurnInput, TurnRunner, TurnStats, TurnUsage};
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

/// Replies in order; records every prompt, interaction description, epilogue boundary and submit schema it was given.
struct ScriptedRunner {
    prompts: Mutex<Vec<String>>,
    interactions: Mutex<Vec<String>>,
    epilogue_starts: Mutex<Vec<usize>>,
    submit_schemas: Mutex<Vec<Option<serde_json::Value>>>,
    replies: Mutex<VecDeque<std::result::Result<String, String>>>,
}

impl ScriptedRunner {
    fn new(replies: Vec<std::result::Result<String, String>>) -> Arc<Self> {
        Arc::new(Self {
            prompts: Mutex::new(Vec::new()),
            interactions: Mutex::new(Vec::new()),
            epilogue_starts: Mutex::new(Vec::new()),
            submit_schemas: Mutex::new(Vec::new()),
            replies: Mutex::new(replies.into()),
        })
    }
}

impl TurnRunner for ScriptedRunner {
    fn run_turn(
        &self,
        _session: &str,
        interaction: &str,
        turn: &TurnInput,
        _cancel: &AtomicBool,
    ) -> std::result::Result<String, String> {
        self.interactions
            .lock()
            .expect("interactions")
            .push(interaction.to_owned());
        self.epilogue_starts
            .lock()
            .expect("epilogue starts")
            .push(turn.epilogue_start);
        self.submit_schemas
            .lock()
            .expect("submit schemas")
            .push(turn.submit_schema.clone());
        self.prompts
            .lock()
            .expect("prompts")
            .push(turn.text.clone());
        self.replies
            .lock()
            .expect("replies")
            .pop_front()
            .unwrap_or_else(|| Ok("done".into()))
    }
}

/// A scripted runner that also reports a message count, as the runtime's bridge does after a turn.
struct CountingRunner {
    inner: Arc<ScriptedRunner>,
    count: u64,
}

impl TurnRunner for CountingRunner {
    fn run_turn(
        &self,
        session: &str,
        interaction: &str,
        turn: &TurnInput,
        cancel: &AtomicBool,
    ) -> std::result::Result<String, String> {
        self.inner.run_turn(session, interaction, turn, cancel)
    }

    fn message_boundary(&self, _session: &str) -> Option<u64> {
        Some(self.count)
    }
}

#[test]
fn a_settled_ask_gets_its_message_boundary_on_its_node_after_settlement() {
    use crate::journal::JournalPort;
    let runner: Arc<dyn TurnRunner> = Arc::new(CountingRunner {
        inner: ScriptedRunner::new(vec![Ok("first".into()), Ok("second".into())]),
        count: 4,
    });
    let (mut owner, mailbox, actor) = owner_over(runner);
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    // The first turn is nudged, the nudged turn ends the ask, and the boundary follows the settlement.
    mailbox.serve_next(&mut owner).expect("the first turn end");
    mailbox.serve_next(&mut owner).expect("the nudged turn end");
    mailbox
        .serve_next(&mut owner)
        .expect("the message boundary");
    let nodes = owner.journal().list_nodes("run_1").expect("nodes");
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].message_boundary, Some(4));
}

/// A scripted runner that also reports each turn's stats, in order (None: no stats for that turn).
struct StatsRunner {
    inner: Arc<ScriptedRunner>,
    stats: Mutex<VecDeque<Option<TurnStats>>>,
}

impl TurnRunner for StatsRunner {
    fn run_turn(
        &self,
        session: &str,
        interaction: &str,
        turn: &TurnInput,
        cancel: &AtomicBool,
    ) -> std::result::Result<String, String> {
        self.inner.run_turn(session, interaction, turn, cancel)
    }

    fn turn_stats(&self, _session: &str) -> Option<TurnStats> {
        self.stats.lock().expect("stats").pop_front().flatten()
    }
}

#[test]
fn a_turns_stats_reach_the_settled_ask_with_cumulative_counts_and_node_defaults_for_a_failed_usage_read()
 {
    // Node `statsFromTurn`: the counts accumulate over the ask's turns; tokens and turns come from the turn, and a failed
    // usage read takes Node's defaults (0 tokens, 1 turn). Each turn reports its stats before its end.
    use crate::journal::JournalPort;
    let runner: Arc<dyn TurnRunner> = Arc::new(StatsRunner {
        inner: ScriptedRunner::new(vec![Ok("first".into()), Ok("second".into())]),
        stats: Mutex::new(VecDeque::from(vec![
            Some(TurnStats {
                tool_calls: 2,
                world_tool_calls: 1,
                usage: Some(TurnUsage {
                    tokens: 40,
                    requests: 3,
                }),
            }),
            Some(TurnStats {
                tool_calls: 1,
                world_tool_calls: 0,
                usage: None,
            }),
        ])),
    });
    let (mut owner, mailbox, actor) = owner_over(runner);
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    // Stats, end, stats, end: the nudge runs in between, and the ask settles on the second end.
    for _ in 0..4 {
        mailbox.serve_next(&mut owner).expect("the next request");
    }
    let nodes = owner.journal().list_nodes("run_1").expect("nodes");
    let stats = nodes[0]
        .stats
        .clone()
        .expect("the settled ask carries its stats");
    assert_eq!(
        stats["toolCalls"].as_f64(),
        Some(3.0),
        "2 + 1 across the turns"
    );
    assert_eq!(
        stats["worldToolCalls"].as_f64(),
        Some(1.0),
        "1 + 0 across the turns"
    );
    assert_eq!(
        stats["tokens"].as_f64(),
        Some(0.0),
        "the failed usage read of the last turn takes Node's 0 tokens"
    );
    assert_eq!(stats["turns"].as_f64(), Some(1.0), "and Node's 1 turn");
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
        _turn: &TurnInput,
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
        std::thread::spawn(move || parked.wait("sess", "q1"))
    };
    turns.deliver_answer("sess", "q1", "yes").expect("deliver");
    assert_eq!(answered.join().expect("join"), Ok("yes".to_owned()));
    // A withdrawn question wakes its waiter with an error, so the tool fails instead of hanging.
    let withdrawn = std::thread::spawn(move || parked.wait("sess", "q2"));
    turns.reject_parked("sess", "q2").expect("reject");
    assert!(withdrawn.join().expect("join").is_err());
}

#[test]
fn cancelling_a_turn_drops_the_answers_nobody_waited_for() {
    use crate::actor_sessions::ActorTurns;
    let (_mailbox, handle) = crate::actor_mailbox::ActorMailbox::new();
    let mut turns = MailboxTurns::new(ScriptedRunner::new(Vec::new()), handle.clone());
    // An answer whose waiter never started, because its turn was cancelled before it waited.
    turns.deliver_answer("sess", "q9", "late").expect("deliver");
    turns
        .deliver_answer("other", "q8", "kept")
        .expect("deliver");
    assert_eq!(handle.parked().len(), 2);
    turns
        .cancel_turn("sess", &Ref::new("ask", 1))
        .expect("cancel");
    assert_eq!(
        handle.parked().len(),
        1,
        "only the cancelled session's answer is dropped"
    );
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
    // A generic session declares no schema, on the first turn and on the nudge.
    assert_eq!(
        *runner.submit_schemas.lock().expect("submit schemas"),
        vec![None, None]
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
fn a_nudge_keeps_the_mono_submit_schema() {
    // The actor's session is mono with the ask's schema, so both turns, the nudged one included, declare that schema.
    let runner = ScriptedRunner::new(vec![Ok("first".into()), Ok("second".into())]);
    let (mut owner, mailbox, actor) = owner_over(runner.clone());
    let schema = json!({"type": "object"});
    owner.set_actor_profile(
        &actor,
        crate::driver_rules::SubmitProfile::Mono {
            schema: schema.clone(),
        },
    );
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    mailbox.serve_next(&mut owner).expect("the first turn end");
    mailbox.serve_next(&mut owner).expect("the second turn end");
    assert_eq!(
        *runner
            .prompts
            .lock()
            .expect("prompts")
            .last()
            .expect("a turn"),
        NUDGE_PROMPT.to_owned(),
        "the second turn is the nudge"
    );
    assert_eq!(
        *runner.submit_schemas.lock().expect("submit schemas"),
        vec![Some(schema.clone()), Some(schema)],
        "the nudge keeps the mono schema"
    );
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
        _turn: &TurnInput,
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

/// A runner whose count read panics, as `block_on` does during a runtime shutdown. The count is unknown; the turn's end
/// is still reported, so the ask settles.
struct PanickingCount;

impl TurnRunner for PanickingCount {
    fn run_turn(
        &self,
        _session: &str,
        _interaction: &str,
        _turn: &TurnInput,
        _cancel: &AtomicBool,
    ) -> std::result::Result<String, String> {
        Ok("done".to_owned())
    }

    fn message_boundary(&self, _session: &str) -> Option<u64> {
        panic!("the count read exploded");
    }
}

#[test]
fn a_panicking_count_read_still_reports_the_turn_end() {
    let (mut owner, mailbox, actor) = owner_over(Arc::new(PanickingCount));
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    // Poll instead of blocking on the mailbox: a run where the turn's end never arrives must fail, not hang.
    let mut request = None;
    for _ in 0..500 {
        if let Some(found) = mailbox.try_take() {
            request = Some(found);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    match request {
        Some(crate::actor_mailbox::ActorRequest::TurnEnded {
            session,
            text,
            reply,
        }) => {
            let verdict = owner.turn_ended(&session, &text);
            assert!(verdict.is_ok(), "the turn's end is answered: {verdict:?}");
            let _ = reply.send(verdict);
        }
        _ => panic!("the turn's end was never reported after the count read panicked"),
    }
}
