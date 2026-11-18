//! The bridge from a workflow actor's turn to `Agents::run_actor_turn` (W6a part 2c-2b-3), end to end: the real workflow
//! owner, mailbox and turn loop, with a scripted `ActorAgents` standing for the agents crate. The real entry is covered by
//! the agents crate's own tests (`actor_turn_entry_tests`).
use crate::actor_turns::{ActorAgents, ActorRunBase, AgentTurnRunner};
use async_trait::async_trait;
use rust_cli_agents::actor_turn::{
    ActorEscalation, ActorQuestion, ActorRun, ActorSubmit, ActorTurnEnd, ActorViolation,
};
use rust_cli_base::models::GLM_5_3_ACCOUNT;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::orchestration::Interactions;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_workflow::actor_mailbox::ActorMailbox;
use rust_cli_workflow::actor_sessions::ActorTurns;
use rust_cli_workflow::actor_turns::{MailboxTurns, TurnInput};
use rust_cli_workflow::driver_owner::{ActorDriverOwner, ActorSessionRequest, ActorSessions};
use rust_cli_workflow::driver_rules::NUDGE_PROMPT;
use rust_cli_workflow::engine::{AskMessage, AskSpec, EngineConfig};
use rust_cli_workflow::error::ErrorCode;
use rust_cli_workflow::journal::MemoryJournal;
use rust_cli_workflow::model::{Ref, Violation};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const PERSONA: &str = "You are a workflow actor.";

/// The agents boundary, scripted: it records every run it is asked for and answers from a script. With `block`, a turn
/// waits until its token is cancelled and then ends as stopped, as the real entry does when its drive is cancelled.
struct ScriptedAgents {
    runs: Mutex<Vec<ActorRun>>,
    prompts: Mutex<Vec<String>>,
    replies: Mutex<VecDeque<ActorTurnEnd>>,
    block: bool,
    /// A result the turn submits through its port before it ends, and the port's answer to it.
    submit: Option<Value>,
    submitted: Mutex<Vec<Result<ActorSubmit, String>>>,
    /// A question the first turn escalates through its port (once), and the port's answer to it.
    escalate: Mutex<Option<String>>,
    escalated: Mutex<Vec<Result<ActorEscalation, String>>>,
}

impl ScriptedAgents {
    fn new(replies: Vec<ActorTurnEnd>, block: bool) -> Arc<Self> {
        Arc::new(Self {
            runs: Mutex::new(Vec::new()),
            prompts: Mutex::new(Vec::new()),
            replies: Mutex::new(replies.into()),
            block,
            submit: None,
            submitted: Mutex::new(Vec::new()),
            escalate: Mutex::new(None),
            escalated: Mutex::new(Vec::new()),
        })
    }

    /// A first turn that escalates `question` through its port, then ends with the default text.
    fn escalating(question: &str) -> Arc<Self> {
        Arc::new(Self {
            runs: Mutex::new(Vec::new()),
            prompts: Mutex::new(Vec::new()),
            replies: Mutex::new(VecDeque::new()),
            block: false,
            submit: None,
            submitted: Mutex::new(Vec::new()),
            escalate: Mutex::new(Some(question.to_owned())),
            escalated: Mutex::new(Vec::new()),
        })
    }

    /// A turn that submits `result` through its port, then ends with the default text.
    fn submitting(result: Value) -> Arc<Self> {
        Arc::new(Self {
            runs: Mutex::new(Vec::new()),
            prompts: Mutex::new(Vec::new()),
            replies: Mutex::new(VecDeque::new()),
            block: false,
            submit: Some(result),
            submitted: Mutex::new(Vec::new()),
            escalate: Mutex::new(None),
            escalated: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait]
impl ActorAgents for ScriptedAgents {
    async fn run_actor_turn(
        &self,
        run: ActorRun,
        prompt: &str,
        cancel: CancellationToken,
    ) -> ActorTurnEnd {
        let port = run.port.clone();
        self.runs.lock().expect("runs").push(run);
        if let Some(port) = port.as_ref().map(|port| &port.port) {
            if let Some(result) = self.submit.clone() {
                let answer = port.submit(result).await;
                self.submitted.lock().expect("submitted").push(answer);
            }
            // The question is taken, so only the first turn escalates; a nudged turn does not.
            let question = self.escalate.lock().expect("escalate").take();
            if let Some(question) = question {
                let answer = port
                    .escalate(ActorQuestion {
                        question,
                        context: None,
                    })
                    .await;
                self.escalated.lock().expect("escalated").push(answer);
            }
        }
        self.prompts
            .lock()
            .expect("prompts")
            .push(prompt.to_owned());
        if self.block {
            while !cancel.is_cancelled() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            return ActorTurnEnd::Stopped;
        }
        self.replies
            .lock()
            .expect("replies")
            .pop_front()
            .unwrap_or_else(|| ActorTurnEnd::Text("done".to_owned()))
    }

    async fn message_count(&self, _child: &SessionId) -> Option<u64> {
        Some(MESSAGE_COUNT)
    }
}

/// The message count the scripted child reports when its ask settles.
const MESSAGE_COUNT: u64 = 4;

/// The turn side the owner sees: the child is named from the actor, and the turns are the bridge over the mailbox.
struct Sessions {
    turns: MailboxTurns,
}

impl ActorSessions for Sessions {
    fn create_session(&mut self, request: &ActorSessionRequest) -> anyhow::Result<String> {
        Ok(format!("sess_{}", request.actor.site_id))
    }

    fn start_turn(
        &mut self,
        session: &str,
        instance: &Ref,
        _message: &AskMessage,
        input: &TurnInput,
        interaction: &str,
    ) -> anyhow::Result<()> {
        self.turns.start_turn(session, instance, input, interaction)
    }

    fn cancel_turn(&mut self, session: &str, instance: &Ref) -> anyhow::Result<()> {
        self.turns.cancel_turn(session, instance)
    }

    fn reject_parked(&mut self, session: &str, qid: &str) -> anyhow::Result<()> {
        self.turns.reject_parked(session, qid)
    }

    fn deliver_answer(&mut self, session: &str, qid: &str, answer: &str) -> anyhow::Result<()> {
        self.turns.deliver_answer(session, qid, answer)
    }
}

fn needs_ok(_schema: &Value, value: &Value) -> Vec<Violation> {
    if value.get("ok").is_some() {
        Vec::new()
    } else {
        vec![Violation {
            path: "$.ok".into(),
            expected: "ok".into(),
            got: "missing".into(),
        }]
    }
}

fn config() -> EngineConfig {
    let mut config = EngineConfig {
        run_id: "run_1".into(),
        parent_session_id: Some("ses_parent".into()),
        validate: needs_ok,
        ..Default::default()
    };
    config.caps.max_concurrency = 4.0;
    config.ask_specs.insert(
        "site".into(),
        AskSpec {
            typed: true,
            schema: Some(json!({"type": "object"})),
        },
    );
    config
}

fn base() -> ActorRunBase {
    ActorRunBase {
        parent: SessionId::new("ses_parent"),
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/work"),
        },
        selection: ModelSelection::new("account:bigmodel-team-coding-plan", GLM_5_3_ACCOUNT),
        mode: PermissionMode::Default,
        persona_prompt: PERSONA.to_owned(),
        interactions: None,
        clock: Arc::new(rust_cli_kernel_api::testing::FixedClock(1_700_000_000_000)),
    }
}

/// An owner whose turns run through the bridge over `agents`, on the runtime this test runs in.
fn owner_over(
    agents: Arc<ScriptedAgents>,
) -> (ActorDriverOwner<MemoryJournal, Sessions>, ActorMailbox) {
    owner_over_with(agents, None)
}

/// The first input of the scripted actor: "do it" with the quality and schema epilogues.
fn composed_do_it() -> String {
    use rust_cli_workflow::driver_rules as rules;
    let schema = json!({"type": "object"});
    format!(
        "do it{}{}",
        rules::quality_epilogue(Some(&schema)),
        rules::schema_epilogue(Some(&schema))
    )
}

/// The same owner, with the parent's interactions channel (or none) in the runner's base.
fn owner_over_with(
    agents: Arc<ScriptedAgents>,
    interactions: Option<Arc<dyn Interactions>>,
) -> (ActorDriverOwner<MemoryJournal, Sessions>, ActorMailbox) {
    let (mailbox, handle) = ActorMailbox::new();
    let runner = Arc::new(AgentTurnRunner::new(
        agents,
        tokio::runtime::Handle::current(),
        ActorRunBase {
            interactions,
            ..base()
        },
        handle.clone(),
    ));
    let sessions = Sessions {
        turns: MailboxTurns::new(runner, handle),
    };
    let owner = ActorDriverOwner::new(config(), MemoryJournal::new(), sessions).expect("owner");
    (owner, mailbox)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_scripted_actor_turn_runs_through_the_workflow_and_settles_after_the_nudge() {
    let agents = ScriptedAgents::new(
        vec![
            ActorTurnEnd::Text("first".into()),
            ActorTurnEnd::Text("second".into()),
        ],
        false,
    );
    let (mut owner, mailbox) = owner_over(agents.clone());
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    // The first turn ends and is nudged; the nudged turn ends and the ask settles as ResultNotSubmitted.
    mailbox.serve_next(&mut owner).expect("the first turn end");
    mailbox.serve_next(&mut owner).expect("the second turn end");
    assert_eq!(
        *agents.prompts.lock().expect("prompts"),
        vec![composed_do_it(), NUDGE_PROMPT.to_owned()]
    );
    let runs = agents.runs.lock().expect("runs");
    assert_eq!(runs[0].parent, SessionId::new("ses_parent"));
    assert_eq!(runs[0].persona_prompt, PERSONA);
    assert_eq!(runs[0].mode, PermissionMode::Default);
    // The typed turn's boundary is the instructions' UTF-16 length ("do it" is 5 units); the nudged turn's is Some(0).
    assert_eq!(
        runs.iter()
            .map(|run| run.epilogue_start)
            .collect::<Vec<_>>(),
        vec![Some(5), Some(0)],
        "the turn reaches the bridge with its epilogue boundary, the nudge with 0"
    );
    // A generic session: every recorded turn carries its submit port with no schema, the nudged one included.
    assert!(
        runs.iter().all(|run| run
            .port
            .as_ref()
            .is_some_and(|port| port.submit_schema.is_none())),
        "a generic session's turns carry no submit schema"
    );
    drop(runs);
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(
        outcomes[0].result.as_ref().expect_err("the ask fails").code,
        ErrorCode::ResultNotSubmitted
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_agents_turn_fails_the_ask_with_its_text() {
    let agents = ScriptedAgents::new(vec![ActorTurnEnd::Failed("model refused".into())], false);
    let (mut owner, mailbox) = owner_over(agents);
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    mailbox.serve_next(&mut owner).expect("the turn failure");
    let outcomes = owner.take_outcomes();
    let error = outcomes[0].result.as_ref().expect_err("the ask fails");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert!(error.message.contains("model refused"), "{}", error.message);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_turn_is_stopped_through_the_bridge_and_reports_nothing() {
    let agents = ScriptedAgents::new(Vec::new(), true);
    let (mut owner, _mailbox) = owner_over(agents.clone());
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    // Wait until the agents side has the turn, so the cancel is the one that stops it.
    tokio::time::timeout(Duration::from_secs(10), async {
        while agents.prompts.lock().expect("prompts").is_empty() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the turn reached the agents side");
    owner.complete(json!("done")).expect("complete");
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(
        outcomes[0].result.as_ref().expect_err("cancelled").code,
        ErrorCode::Cancelled
    );
}

// The invariant is a debug_assert, so the test exists only where debug assertions are compiled in.
#[cfg(debug_assertions)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[should_panic(expected = "the ask thread must not be inside a runtime")]
async fn the_bridge_refuses_to_block_from_inside_a_runtime() {
    let runner = AgentTurnRunner::new(
        ScriptedAgents::new(Vec::new(), false),
        tokio::runtime::Handle::current(),
        base(),
        ActorMailbox::new().1,
    );
    // Called from a task of the runtime itself, the bridge's block_on would panic; the debug assertion says why first.
    let cancel = AtomicBool::new(false);
    use rust_cli_workflow::actor_turns::TurnRunner;
    let _ = runner.run_turn(
        "sess_site",
        "Ada (site@1)",
        &TurnInput {
            text: "do it".into(),
            epilogue_start: 5,
            submit_schema: None,
        },
        &cancel,
    );
}

#[test]
fn the_permission_mode_of_an_actor_is_the_recorded_mode_through_the_shared_conversion() {
    use crate::actor_turns::actor_permission_mode;
    // Node's rules: a recordable mode maps through the one collaboration-mode table; anything else is absent, and absent
    // is YOLO (the run before the mode was recorded).
    let mode = |raw: Value| actor_permission_mode(Some(&raw));
    assert_eq!(
        actor_permission_mode(None),
        PermissionMode::BypassPermissions
    );
    assert_eq!(mode(json!("build")), PermissionMode::Default);
    assert_eq!(mode(json!("edit")), PermissionMode::AcceptEdits);
    assert_eq!(mode(json!("yolo")), PermissionMode::BypassPermissions);
    assert_eq!(mode(json!("guarded")), PermissionMode::Guarded);
    assert_eq!(mode(json!("auto")), PermissionMode::Auto);
    // `plan` is not a recordable subagent mode, so it reads as absent.
    assert_eq!(mode(json!("plan")), PermissionMode::BypassPermissions);
    assert_eq!(mode(json!("bogus")), PermissionMode::BypassPermissions);
    assert_eq!(mode(json!(7)), PermissionMode::BypassPermissions);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_actor_run_is_named_by_its_interaction_description_and_carries_the_parents_interactions()
 {
    use rust_cli_kernel_api::testing::ScriptedInteractions;

    let agents = ScriptedAgents::new(
        vec![
            ActorTurnEnd::Text("first".into()),
            ActorTurnEnd::Text("second".into()),
        ],
        false,
    );
    let (mut owner, mailbox) = owner_over_with(
        agents.clone(),
        Some(Arc::new(ScriptedInteractions::default()) as Arc<dyn Interactions>),
    );
    let persona = json!({"name": "Ada"});
    let actor = owner
        .create_actor("site", Some("Ada"), Some(&persona))
        .expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    mailbox.serve_next(&mut owner).expect("the first turn end");
    mailbox.serve_next(&mut owner).expect("the second turn end");
    let runs = agents.runs.lock().expect("runs");
    // The asks are named by the interaction description, not by the session title.
    assert_eq!(runs[0].interaction_description, "Ada (site@1)");
    assert!(
        runs[0].interactions.is_some(),
        "the parent's interactions reach the actor run"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_submitted_result_is_accepted_through_the_mailbox_and_settles_the_ask() {
    let agents = ScriptedAgents::submitting(json!({"ok": true}));
    let (mut owner, mailbox) = owner_over(agents.clone());
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    // The submit, then the turn's end. The engine accepts the result, so the ask settles with it.
    mailbox.serve_next(&mut owner).expect("the submit");
    mailbox.serve_next(&mut owner).expect("the turn end");
    assert_eq!(
        *agents.submitted.lock().expect("submitted"),
        vec![Ok(ActorSubmit::Accepted)]
    );
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(
        outcomes[0]
            .result
            .as_ref()
            .expect("the ask settles with the result"),
        &json!({"ok": true})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_submit_keeps_the_ask_live_and_names_each_violation() {
    let agents = ScriptedAgents::submitting(json!({}));
    let (mut owner, mailbox) = owner_over(agents.clone());
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    // The first submit is rejected; the turn ends and is nudged; the nudged turn submits again and ends.
    for _ in 0..4 {
        mailbox.serve_next(&mut owner).expect("the next request");
    }
    let rejected = Ok(ActorSubmit::Rejected(vec![ActorViolation {
        path: "$.ok".to_owned(),
        expected: "ok".to_owned(),
        got: "missing".to_owned(),
    }]));
    assert_eq!(
        *agents.submitted.lock().expect("submitted"),
        vec![rejected.clone(), rejected]
    );
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(
        outcomes[0]
            .result
            .as_ref()
            .expect_err("no result was accepted")
            .code,
        ErrorCode::ResultNotSubmitted
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blocked_escalation_is_answered_through_the_mailbox_and_returns_the_answer() {
    let agents = ScriptedAgents::escalating("which gate?");
    let (mut owner, mailbox) = owner_over(agents.clone());
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    // The escalation parks its question; the turn waits on it until the owner answers.
    mailbox.serve_next(&mut owner).expect("the escalation");
    let session = owner.session_of(&actor).expect("session");
    let qids = owner.parked_questions(&session);
    assert_eq!(qids.len(), 1, "the question is parked on the session");
    owner.answer(&qids[0], "the second one").expect("answer");
    // The turn ends (and is nudged), and the nudged turn ends.
    mailbox.serve_next(&mut owner).expect("the turn end");
    mailbox.serve_next(&mut owner).expect("the nudged turn end");
    assert_eq!(
        *agents.escalated.lock().expect("escalated"),
        vec![Ok(ActorEscalation::Answered {
            qid: qids[0].clone(),
            answer: "the second one".to_owned(),
        })]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mono_session_hands_its_submit_schema_to_every_turn_of_its_ask() {
    let agents = ScriptedAgents::new(Vec::new(), false);
    let (mut owner, mailbox) = owner_over(agents.clone());
    let actor = owner.create_actor("site", None, None).expect("actor");
    // The schema matches the site's ask, so the session stays mono and its turns declare the schema.
    let schema = json!({"type": "object"});
    owner.set_actor_profile(
        &actor,
        rust_cli_workflow::driver_rules::SubmitProfile::Mono {
            schema: schema.clone(),
        },
    );
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    // The turn ends and is nudged; the nudged turn ends too.
    mailbox.serve_next(&mut owner).expect("the turn end");
    mailbox.serve_next(&mut owner).expect("the nudged turn end");
    let runs = agents.runs.lock().expect("runs");
    assert_eq!(runs.len(), 2);
    assert!(runs.iter().all(|run| {
        run.port
            .as_ref()
            .and_then(|port| port.submit_schema.as_ref())
            == Some(&schema)
    }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mono_session_that_misses_its_ask_falls_back_to_the_generic_declaration_on_every_turn() {
    // Node `ensureSubmitProfileFits`: the session's schema differs from the typed ask, so the session falls back to the
    // generic submit_result. Its turns, the nudged one included, declare no schema, and the ask is composed for generic.
    let agents = ScriptedAgents::new(Vec::new(), false);
    let (mut owner, mailbox) = owner_over(agents.clone());
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.set_actor_profile(
        &actor,
        rust_cli_workflow::driver_rules::SubmitProfile::Mono {
            schema: json!({"type": "string"}),
        },
    );
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    mailbox.serve_next(&mut owner).expect("the turn end");
    mailbox.serve_next(&mut owner).expect("the nudged turn end");
    assert_eq!(
        *agents.prompts.lock().expect("prompts"),
        vec![composed_do_it(), NUDGE_PROMPT.to_owned()],
        "the fallen-back ask is composed for the generic declaration"
    );
    let runs = agents.runs.lock().expect("runs");
    assert_eq!(runs.len(), 2);
    assert!(
        runs.iter().all(|run| run
            .port
            .as_ref()
            .is_some_and(|port| port.submit_schema.is_none())),
        "no turn declares the missed schema"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_settled_ask_writes_the_child_message_count_as_its_boundary() {
    // Node `journalAskMessageBoundary`: the count is written on the settled ask's node, after its settlement.
    use rust_cli_workflow::journal::JournalPort;
    let agents = ScriptedAgents::new(
        vec![
            ActorTurnEnd::Text("first".into()),
            ActorTurnEnd::Text("second".into()),
        ],
        false,
    );
    let (mut owner, mailbox) = owner_over(agents);
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    mailbox.serve_next(&mut owner).expect("the first turn end");
    mailbox.serve_next(&mut owner).expect("the nudged turn end");
    mailbox
        .serve_next(&mut owner)
        .expect("the message boundary");
    let nodes = owner.journal().list_nodes("run_1").expect("nodes");
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].message_boundary, Some(MESSAGE_COUNT));
}

#[test]
fn every_recordable_mode_names_a_permission_mode_through_the_shared_table() {
    use rust_cli_workflow::driver_rules::SubagentPermissionMode;
    // `ALL` is generated with the enum, so no recordable mode can be left out of this loop.
    for &mode in SubagentPermissionMode::ALL {
        assert!(
            PermissionMode::from_node_name(mode.as_str()).is_some(),
            "the recordable mode {} must name a permission mode",
            mode.as_str()
        );
    }
}
