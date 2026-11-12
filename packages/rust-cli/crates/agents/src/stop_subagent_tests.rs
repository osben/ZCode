//! Fork: the desktop's guarded subagent stop (`stopSubagent`, specs/fork-rust-agent-parity.md B2).

use std::sync::Arc;

use futures_util::StreamExt;
use rust_cli_kernel_api::agents::{AgentSignal, SubagentStopRefusal};
use rust_cli_kernel_api::env::OperationContext;
use rust_cli_kernel_api::env_shell::BackgroundStatus;
use rust_cli_kernel_api::ids::{AgentId, OperationId, SessionId};
use rust_cli_kernel_api::panels::SubagentStatus;
use serde_json::json;
use tokio::sync::Notify;

use crate::test_support::{desktop_harness, harness, text};

fn operation(session: &SessionId) -> OperationContext {
    OperationContext::new(
        rust_cli_kernel_api::ids::EnvironmentId::new("local"),
        rust_cli_kernel_api::ids::Generation::new("g1"),
        OperationId::new("op_user"),
        rust_cli_kernel_api::env::Origin::User {
            session: Some(session.clone()),
        },
    )
}

/// The first run is execution 0; a stop that names it ends the agent as the user's, and a second stop of the
/// ended agent is `not_running`.
#[tokio::test]
async fn a_stop_naming_the_current_run_ends_it() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Long job", "prompt": "Work."}),
        )
        .await;
    harness.started(1).await;
    let entries = signals.subagents(&parent).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].execution, 0);
    let agent = AgentId::new("agent_1");
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "0", operation(&parent))
            .await,
        Ok(())
    );
    let Some(AgentSignal::Notice(notice)) = stream.next().await else {
        panic!("expected a notice");
    };
    assert_eq!(notice.status, BackgroundStatus::Killed);
    assert_eq!(
        signals.subagents(&parent).await[0].status,
        SubagentStatus::Killed
    );
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "0", operation(&parent))
            .await,
        Err(SubagentStopRefusal::NotRunning)
    );
}

/// A stop that names another run is refused and leaves the agent running.
#[tokio::test]
async fn a_stop_naming_another_run_is_refused() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Long job", "prompt": "Work."}),
        )
        .await;
    harness.started(1).await;
    let agent = AgentId::new("agent_1");
    for stale in ["1", "x"] {
        assert_eq!(
            signals
                .stop_subagent(&parent, &agent, stale, operation(&parent))
                .await,
            Err(SubagentStopRefusal::NotRunning)
        );
    }
    assert_eq!(
        signals.subagents(&parent).await[0].status,
        SubagentStatus::Running
    );
}

/// Only the session that spawned the agent may stop it; an unknown agent is `not_found`.
#[tokio::test]
async fn another_session_or_an_unknown_agent_is_not_found() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let other = SessionId::new("sess_other");
    let signals = harness.agents.signals();
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Long job", "prompt": "Work."}),
        )
        .await;
    harness.started(1).await;
    assert_eq!(
        signals
            .stop_subagent(&other, &AgentId::new("agent_1"), "0", operation(&other))
            .await,
        Err(SubagentStopRefusal::NotFound)
    );
    assert_eq!(
        signals
            .stop_subagent(&parent, &AgentId::new("agent_9"), "0", operation(&parent))
            .await,
        Err(SubagentStopRefusal::NotFound)
    );
    assert_eq!(
        signals.subagents(&parent).await[0].status,
        SubagentStatus::Running
    );
}

/// A SendMessage resume is a new run: its execution is 1, and a late stop of run 0 cannot end it.
#[tokio::test]
async fn a_resume_is_a_new_run() {
    let gate = Arc::new(Notify::new());
    let harness = harness(Some(gate.clone()));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Long job", "prompt": "Work."}),
        )
        .await;
    harness.started(1).await;
    let agent = AgentId::new("agent_1");
    signals
        .stop_subagent(&parent, &agent, "0", operation(&parent))
        .await
        .unwrap();
    let Some(AgentSignal::Notice(_)) = stream.next().await else {
        panic!("expected a notice");
    };
    let resumed = text(
        &harness
            .call(
                "sess_parent",
                "SendMessage",
                json!({"to": "agent_1", "message": "Go on."}),
            )
            .await,
    );
    assert!(resumed.contains("resumed"), "{resumed}");
    harness.started(2).await;
    let entries = signals.subagents(&parent).await;
    assert_eq!(entries[0].status, SubagentStatus::Running);
    assert_eq!(entries[0].execution, 1);
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "0", operation(&parent))
            .await,
        Err(SubagentStopRefusal::NotRunning)
    );
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "1", operation(&parent))
            .await,
        Ok(())
    );
}

/// A background agent of `sess_parent` that no query drives: the tests settle and park it by hand, so the transitions
/// they check are not raced by a real run.
fn undriven(harness: &crate::test_support::Harness, agent: &str) -> AgentId {
    use rust_cli_kernel_api::abort::Abort;
    let entry = crate::live::LiveAgent {
        machine: Default::default(),
        agent: AgentId::new(agent),
        child: SessionId::new(format!("sess_subagent_{agent}")),
        parent: SessionId::new("sess_parent"),
        root: SessionId::new("sess_parent"),
        owner: None,
        depth: 1,
        tool_use: None,
        description: "Undriven".to_owned(),
        definition: Arc::new(
            crate::definitions::builtins()
                .into_iter()
                .find(|definition| definition.agent_type == "Explore")
                .unwrap(),
        ),
        workspace: crate::test_support::workspace(),
        execution_worktree: false,
        selection: rust_cli_kernel_api::testing::selection(),
        mode: rust_cli_kernel_api::permission::PermissionMode::Default,
        background: true,
        asks: None,
        state: crate::live::AgentState::Running {
            abort: Abort::new(),
            mailbox: Vec::new(),
        },
        shown: crate::live::Shown::default(),
        delivered: Vec::new(),
        fork_prefix: None,
        stopped_by_user: false,
        erased: false,
        late_messages: Vec::new(),
    };
    harness.agents.core.live.insert(entry);
    AgentId::new(agent)
}

fn completed() -> crate::spawn::Finished {
    crate::spawn::Finished {
        ending: crate::report::Ending::Completed,
        report: crate::report::Report::default(),
        error: None,
    }
}

fn execution(harness: &crate::test_support::Harness, agent: &AgentId) -> u64 {
    harness.agents.core.live.get(agent).unwrap().shown.execution
}

/// Codex review of #418 (1): a run that ends with a stranded SendMessage message is replaced by a new run in the same
/// lock section. That new run gets a new execution, so a late stop of the ended run cannot end it.
#[tokio::test]
async fn a_run_replaced_in_the_settling_section_is_a_new_execution() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let agent = undriven(&harness, "agent_u");
    assert_eq!(
        harness
            .agents
            .core
            .live
            .enqueue(&agent, "Go on.".to_owned()),
        crate::live::Enqueued::Steered
    );
    let settled = crate::routing::settle(&harness.agents.core, &agent, &completed()).await;
    assert!(!settled.parked);
    assert_eq!(settled.ending, crate::report::Ending::Completed);
    assert!(matches!(
        harness.agents.core.live.get(&agent).unwrap().state,
        crate::live::AgentState::Running { .. }
    ));
    assert_eq!(execution(&harness, &agent), 1);
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "0", operation(&parent))
            .await,
        Err(SubagentStopRefusal::NotRunning)
    );
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "1", operation(&parent))
            .await,
        Ok(())
    );
}

/// Codex review of #418 (2): a stop accepted after the query returned `Completed`, before the run settled, claims the
/// ending: the run ends as killed and its notice is a stop, never `finished`.
#[tokio::test]
async fn an_accepted_stop_claims_the_ending_of_a_completed_query() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    let agent = undriven(&harness, "agent_u");
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "0", operation(&parent))
            .await,
        Ok(())
    );
    // The query already returned its report (#418 review @9fef2a4d3): the stopped run still reports nothing.
    let mut finished = completed();
    finished.report = crate::report::Report {
        text: "Report of the stopped run.".to_owned(),
        tokens: 42,
        tool_uses: 3,
        duration_ms: 1_000,
    };
    let settled = crate::routing::settle(&harness.agents.core, &agent, &finished).await;
    assert_eq!(settled.ending, crate::report::Ending::Killed);
    assert!(matches!(
        harness.agents.core.live.get(&agent).unwrap().state,
        crate::live::AgentState::Finished(crate::report::Ending::Killed)
    ));
    let Some(AgentSignal::Notice(notice)) = stream.next().await else {
        panic!("expected a notice");
    };
    assert_eq!(notice.status, BackgroundStatus::Killed);
    assert!(
        notice.text.contains("was stopped by user"),
        "{}",
        notice.text
    );
    assert!(!notice.text.contains("finished"), "{}", notice.text);
    assert!(
        !notice.text.contains("Report of the stopped run."),
        "{}",
        notice.text
    );
    assert!(!notice.text.contains("<result>"), "{}", notice.text);
    assert!(!notice.text.contains("<usage>"), "{}", notice.text);
}

/// Codex review of #418 (3): a parked agent's stop names the execution it checked. When another notice woke the agent
/// and it parked again in a later execution, the stale stop leaves it parked.
#[tokio::test]
async fn a_stale_stop_leaves_an_agent_parked_again_in_a_later_execution() {
    use crate::live::AgentState;
    use rust_cli_kernel_api::abort::Abort;
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let agent = undriven(&harness, "agent_u");
    let live = &harness.agents.core.live;
    let park = || {
        live.with(|agents| {
            agents.get_mut(&agent).unwrap().state = AgentState::Parked {
                report: crate::report::Report::default(),
                notified: true,
            };
        });
    };
    park();
    let checked = match live.stop_execution(&parent, &agent, "0") {
        crate::live::GuardedStop::Parked(execution) => execution,
        other => panic!("expected parked, got {other:?}"),
    };
    assert_eq!(checked, 0);
    // Between the check and the transition a notice wakes it (execution 1) and it parks again.
    live.with(|agents| {
        agents
            .get_mut(&agent)
            .unwrap()
            .begin_run(Abort::new(), Vec::new());
    });
    park();
    assert_eq!(execution(&harness, &agent), 1);
    assert!(
        crate::routing::stop_parked(
            &harness.agents.core,
            &agent,
            checked,
            crate::report::Ending::KilledParked
        )
        .is_none()
    );
    assert!(matches!(
        live.get(&agent).unwrap().state,
        AgentState::Parked { .. }
    ));
    assert!(
        crate::routing::stop_parked(
            &harness.agents.core,
            &agent,
            1,
            crate::report::Ending::KilledParked
        )
        .is_some()
    );
    assert!(matches!(
        live.get(&agent).unwrap().state,
        AgentState::Finished(crate::report::Ending::KilledParked)
    ));
}

/// A shell that records, at each read of the child's background commands, whether the agent was still parked.
struct ReadWatcher {
    live: Arc<crate::live::Live>,
    agent: AgentId,
    parked_at_read: std::sync::Mutex<Vec<bool>>,
    stopped: std::sync::Mutex<Vec<String>>,
    /// The read is where a notice wakes the parked agent into a new run (between the read and the transition).
    wake_on_read: bool,
}

#[async_trait::async_trait]
impl rust_cli_kernel_api::machine::Shell for ReadWatcher {
    async fn shell_state(
        &self,
        workspace: &rust_cli_kernel_api::env::WorkspaceRef,
        _session: &SessionId,
    ) -> Result<rust_cli_kernel_api::env_shell::ShellState, rust_cli_kernel_api::env::EnvError>
    {
        let parked = self
            .live
            .get(&self.agent)
            .is_some_and(|entry| matches!(entry.state, crate::live::AgentState::Parked { .. }));
        self.parked_at_read.lock().unwrap().push(parked);
        if self.wake_on_read {
            self.live.with(|agents| {
                agents
                    .get_mut(&self.agent)
                    .unwrap()
                    .begin_run(rust_cli_kernel_api::abort::Abort::new(), Vec::new());
            });
        }
        Ok(rust_cli_kernel_api::env_shell::ShellState {
            cwd: workspace.root.clone(),
            outputs: None,
            background: vec![rust_cli_kernel_api::ids::ShellTaskId::new("b_old")],
        })
    }
}

#[async_trait::async_trait]
impl rust_cli_kernel_api::machine::Background for ReadWatcher {
    async fn background_command(
        &self,
        _request: rust_cli_kernel_api::env_shell::BackgroundTask,
    ) -> Result<
        Option<rust_cli_kernel_api::env_shell::BackgroundInfo>,
        rust_cli_kernel_api::env::EnvError,
    > {
        Ok(None)
    }

    async fn stop_background_command(
        &self,
        _context: OperationContext,
        request: rust_cli_kernel_api::env_shell::BackgroundTask,
    ) -> Result<rust_cli_kernel_api::env_shell::BackgroundStop, rust_cli_kernel_api::env::EnvError>
    {
        self.stopped.lock().unwrap().push(request.task.to_string());
        Ok(rust_cli_kernel_api::env_shell::BackgroundStop::NotFound)
    }
}

/// Codex review of #418 @390c2bc4e (2): the cleanup targets of a parked stop are read while the agent is still parked
/// in the stopped execution, before the transition that lets a SendMessage restart it in the same child session; a read
/// after it could list the new run's commands.
#[tokio::test]
async fn a_parked_stop_reads_its_cleanup_targets_before_the_agent_can_restart() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let agent = undriven(&harness, "agent_u");
    let live = harness.agents.core.live.clone();
    live.with(|agents| {
        agents.get_mut(&agent).unwrap().state = crate::live::AgentState::Parked {
            report: crate::report::Report::default(),
            notified: true,
        };
    });
    let watcher = Arc::new(ReadWatcher {
        live: live.clone(),
        agent: agent.clone(),
        parked_at_read: std::sync::Mutex::default(),
        stopped: std::sync::Mutex::default(),
        wake_on_read: false,
    });
    let machine = rust_cli_kernel_api::testing::unsupported_machine()
        .with_shell(watcher.clone())
        .with_background(watcher.clone());
    let tool = crate::task_stop::TaskStopTool {
        core: harness.agents.core.clone(),
    };
    let operation = operation(&parent);
    let caller = crate::task_stop::Caller {
        session: &parent,
        agent: None,
        machine: &machine,
        operation: &operation,
        by_user: true,
    };
    // A stale execution reads nothing and ends nothing.
    assert!(!tool.stop_parked(&agent, 1, &caller).await);
    assert!(watcher.parked_at_read.lock().unwrap().is_empty());
    assert!(tool.stop_parked(&agent, 0, &caller).await);
    assert_eq!(*watcher.parked_at_read.lock().unwrap(), vec![true]);
    assert_eq!(*watcher.stopped.lock().unwrap(), vec!["b_old".to_owned()]);
    assert!(matches!(
        live.get(&agent).unwrap().state,
        crate::live::AgentState::Finished(crate::report::Ending::KilledParked)
    ));
}

/// Codex review of #418 @390c2bc4e (1): a foreground child stopped on its own ends only its Agent call, as cancelled
/// (Node `ToolCancelled`), and the result keeps `display.agent`, the child link that cold subagent queries read.
#[tokio::test]
async fn a_stopped_foreground_child_is_a_cancelled_call_that_keeps_its_link() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let call = harness.call(
        "sess_parent",
        "Agent",
        json!({"description": "Long job", "prompt": "Work.", "run_in_background": false}),
    );
    let stop = async {
        harness.started(1).await;
        signals
            .stop_subagent(&parent, &AgentId::new("agent_1"), "0", operation(&parent))
            .await
    };
    let (output, stopped) = tokio::join!(call, stop);
    assert_eq!(stopped, Ok(()));
    assert!(output.is_error);
    assert_eq!(
        text(&output),
        rust_cli_kernel_api::tool::SUBAGENT_STOPPED_BY_USER
    );
    let agent = &output.display["agent"];
    assert_eq!(agent["agentId"], "agent_1");
    assert_eq!(agent["childSessionId"], "sess_subagent_agent_1");
    assert_eq!(agent["status"], "killed");
}

/// Codex review of #418 @dc4b08512 (2): a TaskStop that ends nothing (the parked agent woke into a new run while its
/// cleanup targets were read) is refused with Node's `not running` error, never reported as stopped.
#[tokio::test]
async fn a_task_stop_that_ends_nothing_is_refused() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let agent = undriven(&harness, "agent_u");
    let live = harness.agents.core.live.clone();
    live.with(|agents| {
        agents.get_mut(&agent).unwrap().state = crate::live::AgentState::Parked {
            report: crate::report::Report::default(),
            notified: true,
        };
    });
    let watcher = Arc::new(ReadWatcher {
        live: live.clone(),
        agent: agent.clone(),
        parked_at_read: std::sync::Mutex::default(),
        stopped: std::sync::Mutex::default(),
        wake_on_read: true,
    });
    let machine = rust_cli_kernel_api::testing::unsupported_machine()
        .with_shell(watcher.clone())
        .with_background(watcher.clone());
    let tool = crate::task_stop::TaskStopTool {
        core: harness.agents.core.clone(),
    };
    let operation = operation(&parent);
    let caller = crate::task_stop::Caller {
        session: &parent,
        agent: None,
        machine: &machine,
        operation: &operation,
        by_user: false,
    };
    let Err(refused) = tool.stop("agent_u", &caller).await else {
        panic!("a stop that ended nothing reported success");
    };
    assert_eq!(
        refused.to_string(),
        "Task agent_u is not running (status: running)"
    );
    assert!(matches!(
        live.get(&agent).unwrap().state,
        crate::live::AgentState::Running { .. }
    ));
    assert!(watcher.stopped.lock().unwrap().is_empty());
}

/// #418 reviews: on the desktop a stop of a parked agent is Node's killed notification. The model's TaskStop reads
/// `was stopped by ZCode` and the user's `was stopped by user` (`completion-notification.ts`), and neither carries the
/// parked report (`<result>`, runner.ts) or `<usage>` (excluded for killed). The TUI keeps upstream's `KilledParked`.
#[tokio::test]
async fn a_desktop_stop_of_a_parked_agent_is_a_killed_notice_without_report() {
    for (by_user, ending, stopper) in [
        (false, crate::report::Ending::Killed, "ZCode"),
        (true, crate::report::Ending::KilledByUser, "user"),
    ] {
        let harness = desktop_harness();
        let parent = SessionId::new("sess_parent");
        let mut stream = harness.agents.signals().signals(&parent);
        let agent = undriven(&harness, "agent_u");
        let live = harness.agents.core.live.clone();
        live.with(|agents| {
            agents.get_mut(&agent).unwrap().state = crate::live::AgentState::Parked {
                report: crate::report::Report {
                    text: "Parked report.".to_owned(),
                    tokens: 42,
                    tool_uses: 3,
                    duration_ms: 1_000,
                },
                notified: true,
            };
        });
        let machine = rust_cli_kernel_api::testing::unsupported_machine();
        let tool = crate::task_stop::TaskStopTool {
            core: harness.agents.core.clone(),
        };
        let operation = operation(&parent);
        let caller = crate::task_stop::Caller {
            session: &parent,
            agent: None,
            machine: &machine,
            operation: &operation,
            by_user,
        };
        assert!(tool.stop_parked(&agent, 0, &caller).await);
        assert!(matches!(
            live.get(&agent).unwrap().state,
            crate::live::AgentState::Finished(found) if found == ending
        ));
        let Some(AgentSignal::Notice(notice)) = stream.next().await else {
            panic!("expected the stop notice");
        };
        assert!(
            notice.text.contains(&format!(
                "<summary>Agent \"Undriven\" was stopped by {stopper}</summary>"
            )),
            "{}",
            notice.text
        );
        assert!(!notice.text.contains("Parked report."), "{}", notice.text);
        assert!(!notice.text.contains("<result>"), "{}", notice.text);
        assert!(!notice.text.contains("<usage>"), "{}", notice.text);
    }
}

/// #418 review @f9521dce9 (1): the first stop claims the ending at once. A second stop of the same run that arrives
/// before the run settles (another command id) is refused `not_running`, as Node claims `killed` synchronously.
#[tokio::test]
async fn a_second_stop_before_the_run_settles_is_not_running() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let agent = undriven(&harness, "agent_u");
    let live = harness.agents.core.live.clone();
    assert_eq!(
        live.stop_execution(&parent, &agent, "0"),
        crate::live::GuardedStop::Aborted
    );
    assert!(matches!(
        live.get(&agent).unwrap().state,
        crate::live::AgentState::Running { .. }
    ));
    assert_eq!(
        live.stop_execution(&parent, &agent, "0"),
        crate::live::GuardedStop::NotRunning
    );
}

/// #418 final review (P1): a SendMessage that reaches a run after a stop claimed it is not lost. Node takes `killed`
/// at once and a message to a killed agent resumes it (core `runner.ts`): it is answered as a resume, the stopped run
/// still settles as stopped (killed notice), and then a new run (next execution) takes the message. A message queued
/// before the stop is dropped with it, as upstream does.
#[tokio::test]
async fn a_message_after_a_claimed_stop_resumes_the_agent_after_it_settles() {
    use crate::live::{AgentState, Enqueued};
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let mut stream = harness.agents.signals().signals(&parent);
    let agent = undriven(&harness, "agent_u");
    let live = harness.agents.core.live.clone();
    assert_eq!(
        live.enqueue(&agent, "Before.".to_owned()),
        Enqueued::Steered
    );
    assert_eq!(
        live.stop_execution(&parent, &agent, "0"),
        crate::live::GuardedStop::Aborted
    );
    assert_eq!(
        live.enqueue(&agent, "After.".to_owned()),
        Enqueued::AfterStop
    );
    let settled = crate::routing::settle(&harness.agents.core, &agent, &completed()).await;
    assert_eq!(settled.ending, crate::report::Ending::Killed);
    // One resume, with the late message; the message queued before the stop is not resumed.
    assert_eq!(settled.wakes.len(), 1);
    let entry = live.get(&agent).unwrap();
    assert!(matches!(&entry.state, AgentState::Running { mailbox, .. } if mailbox.is_empty()));
    assert!(!entry.stop_claimed());
    assert!(!entry.stopped_by_user);
    assert!(entry.late_messages.is_empty());
    assert_eq!(execution(&harness, &agent), 1);
    let Some(AgentSignal::Notice(notice)) = stream.next().await else {
        panic!("expected the stop notice");
    };
    assert!(
        notice.text.contains("was stopped by user"),
        "{}",
        notice.text
    );
}

/// #418 final review (P1): the claim takes the run off the running list at once (the change notice fires and the table
/// reports it killed), so the desktop drops its Stop before the run settles.
#[tokio::test]
async fn a_claimed_stop_leaves_the_running_list_at_once() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let agent = undriven(&harness, "agent_u");
    let live = harness.agents.core.live.clone();
    let mut changes = live.subscribe();
    changes.mark_unchanged();
    assert_eq!(
        live.stop_execution(&parent, &agent, "0"),
        crate::live::GuardedStop::Aborted
    );
    assert!(changes.has_changed().unwrap());
    let entries = harness.agents.signals().subagents(&parent).await;
    assert_eq!(entries[0].status, SubagentStatus::Killed);
    assert_eq!(live.get(&agent).unwrap().status(), BackgroundStatus::Killed);
}

/// #418 final review (P2): after the user's stop claimed the run, a model TaskStop before it settles is refused as not
/// running and keeps the user's attribution (Node `task-stop.ts`, `completion-notification.ts`).
#[tokio::test]
async fn a_task_stop_after_a_claimed_user_stop_is_refused_and_keeps_the_user() {
    let harness = desktop_harness();
    let parent = SessionId::new("sess_parent");
    let mut stream = harness.agents.signals().signals(&parent);
    let agent = undriven(&harness, "agent_u");
    let live = harness.agents.core.live.clone();
    assert_eq!(
        live.stop_execution(&parent, &agent, "0"),
        crate::live::GuardedStop::Aborted
    );
    let machine = rust_cli_kernel_api::testing::unsupported_machine();
    let tool = crate::task_stop::TaskStopTool {
        core: harness.agents.core.clone(),
    };
    let operation = operation(&parent);
    let caller = crate::task_stop::Caller {
        session: &parent,
        agent: None,
        machine: &machine,
        operation: &operation,
        by_user: false,
    };
    let Err(refused) = tool.stop("agent_u", &caller).await else {
        panic!("a second stop was accepted");
    };
    assert_eq!(
        refused.to_string(),
        "Task agent_u is not running (status: killed)"
    );
    assert!(live.get(&agent).unwrap().stopped_by_user);
    crate::routing::settle(&harness.agents.core, &agent, &completed()).await;
    let Some(AgentSignal::Notice(notice)) = stream.next().await else {
        panic!("expected the stop notice");
    };
    assert!(
        notice.text.contains("was stopped by user"),
        "{}",
        notice.text
    );
}
