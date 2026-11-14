//! 无进展提醒的测试（specs/fork-rust-agent-parity.md「Background subagent stall reminder」）：正文与 Node 逐字节一致，
//! 时钟的规则（首次、加倍、上限、进展清零、权限等待、离开运行），以及 env 之外的配置缺省。时刻都由测试给，没有真的等待。

use rust_cli_kernel_api::ids::{AgentId, SessionId};
use serde_json::Value;

use super::*;

const MIN: u64 = 60_000;

fn reminder(
    description: &str,
    running_for_ms: u64,
    no_progress_for_ms: u64,
    last_progress_ms: u64,
    tools: Vec<ReminderTool>,
    next_report_in_ms: u64,
) -> Reminder {
    Reminder {
        execution_id: String::new(),
        agent: AgentId::new("agent_abc"),
        root: SessionId::new("sess_root"),
        description: description.to_owned(),
        execution: 0,
        running_for_ms,
        no_progress_for_ms,
        last_progress_ms,
        running_tools: tools,
        next_report_in_ms,
    }
}

fn tool(name: &str, summary: Option<&str>, running_for_ms: u64) -> ReminderTool {
    ReminderTool {
        name: name.to_owned(),
        summary: summary.map(str::to_owned),
        running_for_ms,
    }
}

/// The golden texts (`stall_golden.json`) come from Node's `formatBackgroundSubagentStallNotification`, run on the
/// same inputs as the `reminder` values below (one per key, same names).
fn golden() -> Value {
    serde_json::from_str(include_str!("stall_golden.json")).expect("golden fixture is JSON")
}

#[test]
fn text_matches_node_byte_for_byte() {
    let golden = golden();
    let text = |name: &str| golden[name].as_str().expect("fixture").to_owned();
    let cases = [
        (
            "basic",
            reminder(
                "Run the test suite",
                20 * MIN,
                15 * MIN,
                1_731_000_000_000,
                vec![tool("Bash", Some("pnpm test"), 10 * MIN)],
                30 * MIN,
            ),
        ),
        (
            "escaping",
            reminder(
                "Fix <b> & \"quotes\" 'x'",
                3 * MIN,
                2 * MIN,
                1_731_000_100_000,
                vec![
                    tool("Ba\"sh", Some("echo <a> & 'b'"), 5 * MIN),
                    tool("Read", None, MIN),
                ],
                30 * MIN,
            ),
        ),
        (
            "manyTools",
            reminder(
                "Long crawl",
                130 * MIN,
                20 * MIN,
                1_731_000_200_000,
                (1..=7)
                    .map(|index: u64| {
                        tool(
                            &format!("Tool{index}"),
                            index
                                .is_multiple_of(2)
                                .then(|| format!("item {index}"))
                                .as_deref(),
                            (index % 3) * MIN + 30_000,
                        )
                    })
                    .collect(),
                240 * MIN,
            ),
        ),
        (
            "longDescription",
            reminder(
                &format!("{}😀b", "a".repeat(199)),
                16 * MIN,
                15 * MIN,
                1_731_000_300_000,
                Vec::new(),
                30 * MIN,
            ),
        ),
        (
            "minuteRounding",
            reminder(
                "  multi\n\tline   description  ",
                30_000,
                MIN,
                1_731_000_400_000,
                vec![tool("Agent", Some("  spaced\n  summary  "), 30_000)],
                120 * MIN,
            ),
        ),
        (
            "hours",
            reminder(
                "Hours",
                150 * MIN,
                120 * MIN,
                1_731_000_500_000,
                Vec::new(),
                480 * MIN,
            ),
        ),
        (
            "sortedTies",
            reminder(
                "Ties",
                20 * MIN,
                16 * MIN,
                1_731_000_600_000,
                vec![
                    tool("First", Some("x"), 3 * MIN),
                    tool("Second", Some("y"), 3 * MIN),
                    tool("Third", Some("z"), 9 * MIN),
                ],
                30 * MIN,
            ),
        ),
    ];
    for (name, reminder) in cases {
        assert_eq!(format(&reminder), text(name), "fixture {name}");
    }
}

#[test]
fn the_text_starts_with_the_banner_and_is_not_wrapped() {
    let text = format(&reminder("x", MIN, MIN, 0, Vec::new(), 15 * MIN));
    assert!(text.starts_with("[SYSTEM NOTIFICATION - NOT USER INPUT]\n"));
    assert!(!text.contains("<system-reminder>"));
    assert!(!text.contains("<task-notification>"));
}

#[test]
fn minutes_round_half_up_and_switch_to_hours_at_two() {
    assert_eq!(minutes(0), "1 minute");
    assert_eq!(minutes(29_999), "1 minute");
    assert_eq!(minutes(30_000), "1 minute", "half a minute rounds up");
    assert_eq!(minutes(90_000), "2 minutes");
    assert_eq!(minutes(59 * MIN), "59 minutes");
    assert_eq!(minutes(119 * MIN + 29_999), "119 minutes");
    assert_eq!(minutes(120 * MIN), "2 hours");
    assert_eq!(minutes(150 * MIN), "2.5 hours");
    assert_eq!(minutes(8 * 60 * MIN), "8 hours");
}

#[test]
fn description_line_is_single_line_and_bounded() {
    assert_eq!(description_line(" a \n\t b "), "a b");
    assert_eq!(description_line(" \n "), "Subagent");
    assert_eq!(description_line(&"a".repeat(200)), "a".repeat(200));
    assert_eq!(
        description_line(&format!("{}😀b", "a".repeat(199))),
        format!("{}…", "a".repeat(199)),
        "a 202-unit description is cut to 199 units and an ellipsis"
    );
}

#[test]
fn input_summary_takes_the_first_non_empty_text_field() {
    let summary = |input: Value| input_summary(&input);
    assert_eq!(
        summary(serde_json::json!({"description": "d", "command": "ls"})),
        Some("ls".to_owned()),
        "command comes before description"
    );
    assert_eq!(
        summary(serde_json::json!({"command": "   ", "path": "src/a.rs"})),
        Some("src/a.rs".to_owned())
    );
    assert_eq!(summary(serde_json::json!({"other": "x"})), None);
    assert_eq!(summary(serde_json::json!("not an object")), None);
    assert_eq!(
        summary(serde_json::json!({"prompt": "a\n\nb"})),
        Some("a b".to_owned()),
        "a summary is one line"
    );
}

#[test]
fn the_config_defaults_and_keeps_the_cap_above_the_first_interval() {
    assert_eq!(
        StallConfig::default(),
        StallConfig {
            first_ms: 15 * MIN,
            max_interval_ms: 4 * 60 * MIN,
        }
    );
    assert_eq!(
        StallConfig::new(Some(0), Some(0)),
        StallConfig::default(),
        "non-positive values fall back to the defaults"
    );
    assert_eq!(
        StallConfig::new(Some(30 * MIN), Some(10 * MIN)).max_interval_ms,
        30 * MIN,
        "the cap is never below the first interval"
    );
}

/// A candidate that started at `started` and has seen no progress since.
fn candidate(agent: &str, started: u64) -> Candidate {
    Candidate {
        execution_id: String::new(),
        agent: AgentId::new(agent),
        root: SessionId::new("sess_root"),
        description: "task".to_owned(),
        started_ms: started,
        execution: 0,
        activity: Activity::default(),
        waiting: false,
    }
}

fn clock() -> StallClock {
    StallClock::new(StallConfig::new(Some(15 * MIN), None))
}

#[test]
fn the_first_reminder_comes_after_the_first_interval_without_progress() {
    let mut clock = clock();
    let candidates = [candidate("a", 0)];
    assert!(clock.tick(15 * MIN - 1, &candidates).is_empty());
    let due = clock.tick(15 * MIN, &candidates);
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].no_progress_for_ms, 15 * MIN);
    assert_eq!(due[0].next_report_in_ms, 30 * MIN, "the next one doubles");
    assert_eq!(clock.next_due(&candidates), Some(45 * MIN));
}

#[test]
fn each_reminder_doubles_the_wait_up_to_the_cap() {
    let mut clock = StallClock::new(StallConfig::new(Some(15 * MIN), Some(40 * MIN)));
    let candidates = [candidate("a", 0)];
    // The driver always reconciles (tick) before it asks for the next due time.
    assert!(clock.tick(0, &candidates).is_empty());
    let mut at = 0;
    let mut waits = Vec::new();
    for _ in 0..4 {
        let due = clock.next_due(&candidates).expect("a reminder is due");
        waits.push(due - at);
        at = due;
        assert_eq!(clock.tick(at, &candidates).len(), 1);
    }
    assert_eq!(waits, [15 * MIN, 30 * MIN, 40 * MIN, 40 * MIN]);
}

#[test]
fn progress_restarts_the_count_from_that_moment() {
    let mut clock = clock();
    let mut candidates = [candidate("a", 0)];
    assert_eq!(clock.tick(15 * MIN, &candidates).len(), 1);
    // A tool call finished at 20 minutes: the clock now counts from 20 minutes, with no reminders sent.
    candidates[0].activity.progress(20 * MIN);
    assert!(
        clock.tick(30 * MIN, &candidates).is_empty(),
        "35 minutes is due, not 30"
    );
    let due = clock.tick(35 * MIN, &candidates);
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].last_progress_ms, 20 * MIN);
    assert_eq!(
        due[0].next_report_in_ms,
        30 * MIN,
        "the count was reset, so this is the first"
    );
}

#[test]
fn a_permission_wait_pauses_the_clock_and_the_answer_restarts_it() {
    let mut clock = clock();
    let mut candidates = [candidate("a", 0)];
    candidates[0].waiting = true;
    assert!(
        clock.tick(60 * MIN, &candidates).is_empty(),
        "no reminder while waiting for a person"
    );
    assert_eq!(clock.next_due(&candidates), None, "no timer while waiting");
    // The answer at 60 minutes is progress; the next reminder is due 15 minutes after it.
    candidates[0].waiting = false;
    candidates[0].activity.progress(60 * MIN);
    assert!(clock.tick(74 * MIN, &candidates).is_empty());
    assert_eq!(clock.tick(75 * MIN, &candidates).len(), 1);
}

#[test]
fn an_agent_that_is_no_longer_a_candidate_gets_no_reminder_and_its_count_is_forgotten() {
    let mut clock = clock();
    let candidates = [candidate("a", 0)];
    assert_eq!(clock.tick(15 * MIN, &candidates).len(), 1);
    // Parked, finished, or erased: not a candidate. Nothing is sent, and the record goes.
    assert!(clock.tick(60 * MIN, &[]).is_empty());
    assert_eq!(clock.next_due(&[]), None);
    // Running again later counts from its own start, not from the old record.
    let restarted = [candidate("a", 100 * MIN)];
    assert!(clock.tick(110 * MIN, &restarted).is_empty());
    assert_eq!(
        clock.tick(115 * MIN, &restarted)[0].no_progress_for_ms,
        15 * MIN
    );
}

#[test]
fn reminders_list_the_running_tools_by_how_long_they_have_run() {
    let mut clock = clock();
    let mut agent = candidate("a", 0);
    agent.activity.tool_started("t1", "Read", None, MIN);
    agent
        .activity
        .tool_started("t2", "Bash", Some("pnpm test".to_owned()), 5 * MIN);
    // The last tool started at 5 minutes, which is progress: the first reminder is due at 20 minutes.
    let due = clock.tick(20 * MIN, &[agent]);
    assert_eq!(
        due[0].running_tools[0].name, "Read",
        "in the order they started"
    );
    let text = format(&due[0]);
    assert!(
        text.contains("  <running-tool name=\"Read\" running-for-ms=\"1140000\""),
        "the listed tools carry their own running time: {text}"
    );
}

#[test]
fn a_finished_tool_is_no_longer_listed_and_counts_as_progress() {
    let mut activity = Activity::default();
    activity.tool_started("t1", "Bash", None, MIN);
    activity.tool_finished("t1", 9 * MIN);
    assert!(activity.tools.is_empty());
    assert_eq!(activity.progress_ms, Some(9 * MIN));
}

#[test]
fn the_notice_is_addressed_to_the_root_session() {
    let mut clock = clock();
    let due = clock.tick(15 * MIN, &[candidate("a", 0)]);
    let stall = notice(&due[0]);
    assert_eq!(stall.agent, AgentId::new("a"));
    assert!(
        stall
            .text
            .starts_with("[SYSTEM NOTIFICATION - NOT USER INPUT]")
    );
    assert_eq!(due[0].root, SessionId::new("sess_root"));
}

#[test]
fn truncation_keeps_the_first_units_and_marks_the_cut() {
    let long = "x".repeat(NOTIFICATION_MAX_UNITS + 5);
    assert_eq!(
        truncate_notification(&long),
        format!("{}\n[truncated]", "x".repeat(NOTIFICATION_MAX_UNITS))
    );
    assert_eq!(truncate_notification("short"), "short");
}

/// A clock that moves with tokio's time, so a paused runtime advances the agents' start times and the reminder's
/// timer together.
struct TokioClock {
    base_ms: u64,
    start: tokio::time::Instant,
}

impl rust_cli_kernel_api::clock::Clock for TokioClock {
    fn now_ms(&self) -> u64 {
        self.base_ms + u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn time_zone(&self) -> String {
        "UTC".to_owned()
    }
}

/// End to end: a background agent that makes no progress is reported to its parent once the first interval has
/// passed. The reminder is a lane notice (not acknowledged, not pending), and the completion notice follows it.
#[tokio::test(start_paused = true)]
async fn a_silent_background_agent_is_reported_to_its_parent_after_the_first_interval() {
    use futures_util::StreamExt;
    use rust_cli_kernel_api::agents::AgentSignal;
    let gate = std::sync::Arc::new(tokio::sync::Notify::new());
    let clock = std::sync::Arc::new(TokioClock {
        base_ms: 1_700_000_000_000,
        start: tokio::time::Instant::now(),
    });
    let harness = crate::test_support::desktop_harness_clocked(gate.clone(), clock);
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    harness
        .call(
            "sess_parent",
            "Agent",
            serde_json::json!({"description": "Silent job", "prompt": "Wait.", "run_in_background": true}),
        )
        .await;
    harness.started(1).await;
    let launched = tokio::time::Instant::now();
    let Some(AgentSignal::Stall(stall)) = stream.next().await else {
        panic!("expected the stall reminder first");
    };
    assert_eq!(launched.elapsed(), std::time::Duration::from_secs(15 * 60));
    assert!(
        stall
            .text
            .starts_with("[SYSTEM NOTIFICATION - NOT USER INPUT]\n"),
        "{}",
        stall.text
    );
    assert!(
        stall.text.contains("<description>Silent job</description>"),
        "{}",
        stall.text
    );
    assert!(
        stall.text.contains("has made no progress for 15 minutes"),
        "{}",
        stall.text
    );
    assert_eq!(stall.agent, AgentId::new("agent_1"));
    // The reminder is never acknowledged; the completion notice is the only ack-able one.
    // Still the same run and no progress: a queued copy of the reminder would drain.
    assert!(signals.stall_current(&parent, &stall).await);
    gate.notify_one();
    let Some(AgentSignal::Notice(notice)) = stream.next().await else {
        panic!("expected the completion notice after the reminder");
    };
    // Once the run has finished, the reminder is stale and is dropped instead of drained.
    assert!(!signals.stall_current(&parent, &stall).await);
    assert_eq!(notice.agent, AgentId::new("agent_1"));
}

/// Node `ToolCallScheduled`: a call queued behind a running one is listed too, from when it was scheduled. Queueing is
/// not progress, so the first call's start is still the last progress.
#[test]
fn a_queued_call_is_listed_from_when_it_was_scheduled() {
    let mut clock = clock();
    let mut agent = candidate("a", 0);
    agent
        .activity
        .tool_scheduled("t1", "Bash", Some("sleep 3600".to_owned()), 0);
    agent
        .activity
        .tool_started("t1", "Bash", Some("sleep 3600".to_owned()), 0);
    agent
        .activity
        .tool_scheduled("t2", "Write", Some("out.txt".to_owned()), MIN);
    assert_eq!(
        agent.activity.progress_ms,
        Some(0),
        "queueing does not count as progress"
    );
    let due = clock.tick(15 * MIN, &[agent]);
    assert_eq!(due.len(), 1);
    let names: Vec<&str> = due[0]
        .running_tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect();
    assert_eq!(names, ["Bash", "Write"]);
    assert!(format(&due[0]).contains("<running-tool name=\"Write\""));
}

#[test]
fn a_repeated_scheduled_event_keeps_the_start_time_and_the_summary() {
    let mut activity = Activity::default();
    activity.tool_scheduled("t1", "Bash", Some("sleep 3600".to_owned()), MIN);
    activity.tool_scheduled("t1", "Bash", None, 9 * MIN);
    assert_eq!(activity.tools.len(), 1);
    assert_eq!(activity.tools[0].started_ms, MIN);
    assert_eq!(activity.tools[0].summary.as_deref(), Some("sleep 3600"));
}

#[test]
fn a_started_call_keeps_the_summary_from_scheduling() {
    let mut activity = Activity::default();
    activity.tool_scheduled("t1", "Bash", Some("sleep 3600".to_owned()), MIN);
    activity.tool_started("t1", "Bash", None, 2 * MIN);
    assert_eq!(activity.tools[0].started_ms, 2 * MIN);
    assert_eq!(activity.tools[0].summary.as_deref(), Some("sleep 3600"));
}

#[test]
fn a_queued_call_that_starts_restarts_its_clock_and_is_progress() {
    let mut activity = Activity::default();
    activity.tool_scheduled("t2", "Write", None, MIN);
    activity.tool_started("t2", "Write", None, 20 * MIN);
    assert_eq!(activity.tools[0].started_ms, 20 * MIN);
    assert_eq!(activity.progress_ms, Some(20 * MIN));
}

/// Node `isBackgroundSubagentStallReminderCurrent` checks `executionId`: a reminder built for run N is not delivered
/// once the agent has restarted into run N+1 (SendMessage resumes it as a new run).
#[tokio::test(start_paused = true)]
async fn a_reminder_from_an_earlier_run_is_not_delivered_after_a_restart() {
    use futures_util::StreamExt;
    use rust_cli_kernel_api::agents::AgentSignal;
    let gate = std::sync::Arc::new(tokio::sync::Notify::new());
    let clock = std::sync::Arc::new(TokioClock {
        base_ms: 1_700_000_000_000,
        start: tokio::time::Instant::now(),
    });
    let harness = crate::test_support::desktop_harness_clocked(gate.clone(), clock);
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    harness
        .call(
            "sess_parent",
            "Agent",
            serde_json::json!({"description": "Silent job", "prompt": "Wait.", "run_in_background": true}),
        )
        .await;
    harness.started(1).await;
    let Some(AgentSignal::Stall(stall)) = stream.next().await else {
        panic!("expected the stall reminder of run 1");
    };
    assert!(
        signals.stall_current(&parent, &stall).await,
        "run 1 is still running"
    );
    harness
        .call(
            "sess_parent",
            "TaskStop",
            serde_json::json!({"task_id": "agent_1"}),
        )
        .await;
    let Some(AgentSignal::Notice(_)) = stream.next().await else {
        panic!("expected the TaskStop notice");
    };
    harness
        .call_as(
            "sess_parent",
            "SendMessage",
            serde_json::json!({"to": "agent_1", "message": "Go on."}),
            Some("toolu_send"),
        )
        .await;
    harness.started(2).await;
    assert!(
        !signals.stall_current(&parent, &stall).await,
        "the reminder of run 1 is stale in run 2"
    );
}

/// A retry request that starts at 10 minutes is progress (Node sets `lastProgressAt` on `ModelRequest`): the reminder is
/// due 15 minutes after it, at 25 minutes, not at 15.
#[test]
fn a_retry_request_starting_late_moves_the_reminder_after_it() {
    let mut clock = clock();
    let mut agent = candidate("a", 0);
    agent.activity.progress(10 * MIN);
    assert!(clock.tick(15 * MIN, &[agent.clone()]).is_empty());
    let due = clock.tick(25 * MIN, &[agent]);
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].last_progress_ms, 10 * MIN);
}
