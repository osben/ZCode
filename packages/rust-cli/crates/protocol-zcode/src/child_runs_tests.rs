use rust_cli_kernel_api::agents::ChildLive;
use rust_cli_kernel_api::ids::{AgentId, MachineName, MessageId, SessionId};
use rust_cli_kernel_api::message::{AssistantMessage, Message, Usage};
use rust_cli_kernel_api::model::{BlockDelta, ModelSelection};
use rust_cli_kernel_api::orchestration::QueryEvent;
use rust_cli_kernel_api::panels::{SubagentEntry, SubagentStatus};
use rust_cli_kernel_api::session_api::TurnOutcome;
use serde_json::Value;

use super::{ChildRuns, Plan};
use crate::telemetry::tests::assert_schema;
use crate::telemetry::{Observed, Provider};

const CHILD: &str = "sess_subagent_agent_1";

fn selection(model: &str) -> ModelSelection {
    ModelSelection {
        provider: "child-provider".to_owned(),
        model: model.to_owned(),
        reasoning: None,
        connection: None,
    }
}

fn resolve(selection: &ModelSelection) -> Provider {
    Provider {
        provider: selection.provider.clone(),
        model: selection.model.clone(),
        kind: Some("anthropic".to_owned()),
        host: None,
    }
}

fn started(run: u64) -> ChildLive {
    ChildLive::Started {
        run,
        selection: selection("child-model"),
    }
}

fn delta(text: &str) -> ChildLive {
    ChildLive::Event(QueryEvent::Delta {
        message: 0,
        index: 0,
        delta: BlockDelta::Text(text.to_owned()),
    })
}

fn assistant(id: &str) -> ChildLive {
    ChildLive::Committed(Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![],
        model: "child-model".to_owned(),
        stop_reason: None,
        usage: Some(Usage {
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        }),
    }))
}

fn finished() -> ChildLive {
    ChildLive::Finished(TurnOutcome::Success)
}

fn entry(agent: &str, status: SubagentStatus, owner: Option<&str>) -> SubagentEntry {
    SubagentEntry {
        agent: AgentId::new(agent),
        child: SessionId::new(format!("sess_subagent_{agent}")),
        agent_type: "general-purpose".to_owned(),
        description: String::new(),
        status,
        background: true,
        waiting: false,
        elapsed_ms: 0,
        ended_ago_ms: None,
        version: 0,
        owner: owner.map(AgentId::new),
        activity: None,
        parked: false,
        machine: MachineName::primary(),
    }
}

struct Parent {
    runs: ChildRuns,
    now: u64,
    facts: Vec<Value>,
}

impl Parent {
    /// A parent whose first table read (the open) is done.
    fn new() -> Self {
        let mut parent = Self {
            runs: ChildRuns::default(),
            now: 1_000,
            facts: Vec::new(),
        };
        assert_eq!(parent.table(&[]), Plan::default());
        parent
    }

    fn table(&mut self, entries: &[SubagentEntry]) -> Plan {
        self.now += 1;
        let provider = resolve(&selection("parent-model"));
        let mut out = Vec::new();
        let plan = self.runs.table(
            entries,
            &Observed {
                scope: "table-",
                // A nested agent's change moves no row of the parent, so the parent log sequence stays put.
                seq: 7,
                now: self.now,
                provider: &provider,
            },
            &mut out,
        );
        self.facts.extend(out);
        plan
    }

    /// Feeds a watch's replay and live items; returns whether the watch asked to reopen.
    fn feed(
        &mut self,
        child: &str,
        id: u64,
        replay: Vec<ChildLive>,
        live: Vec<Option<ChildLive>>,
    ) -> bool {
        let mut reopen = false;
        let items = replay
            .into_iter()
            .map(|item| (true, Some(item)))
            .chain(live.into_iter().map(|item| (false, item)));
        for (replayed, item) in items {
            self.now += 1;
            let read = self
                .runs
                .item(child, id, replayed, item, self.now, &resolve);
            reopen |= read.reopen;
            self.facts.extend(read.facts);
        }
        reopen
    }

    fn kinds(&self) -> Vec<String> {
        self.facts
            .iter()
            .map(|fact| {
                let kind = fact["kind"].as_str().unwrap_or_default();
                let detail = fact
                    .get("status")
                    .or_else(|| fact.get("phase"))
                    .and_then(Value::as_str);
                detail.map_or_else(|| kind.to_owned(), |detail| format!("{kind}:{detail}"))
            })
            .collect()
    }
}

const RUN: [&str; 5] = [
    "turn.started",
    "model.request.status:model_request_started",
    "model.request.status:model_request_completed",
    "usage.delta",
    "turn.terminal:success",
];

#[test]
fn a_run_that_finished_before_the_watch_is_read_once() {
    let mut parent = Parent::new();
    // The table first shows the child already finished.
    let plan = parent.table(&[entry("agent_1", SubagentStatus::Completed, None)]);
    assert_eq!(plan.open, [(CHILD.to_owned(), false)]);
    let id = parent.runs.open(CHILD).expect("watch");
    parent.feed(
        CHILD,
        id,
        vec![started(5), assistant("m1"), finished()],
        vec![],
    );
    assert!(!parent.runs.watching(CHILD));
    // A later watch that gets the same run again reads nothing.
    let again = parent.runs.open(CHILD).expect("watch");
    parent.feed(
        CHILD,
        again,
        vec![started(5), assistant("m1"), finished()],
        vec![],
    );

    assert_eq!(parent.kinds(), RUN);
    assert_schema(&parent.facts);
    assert!(parent.facts.iter().all(|fact| fact["sessionId"] == CHILD));
}

#[test]
fn a_resumed_run_is_read_as_a_new_turn_with_unique_ids() {
    let mut parent = Parent::new();
    let first = parent.runs.open(CHILD).expect("watch");
    parent.feed(
        CHILD,
        first,
        vec![],
        vec![Some(started(1)), Some(assistant("m1")), Some(finished())],
    );
    // `SendMessage` resumes the settled child; its new run is read on a new watch.
    let second = parent.runs.open(CHILD).expect("watch");
    parent.feed(
        CHILD,
        second,
        vec![],
        vec![Some(started(2)), Some(assistant("m2")), Some(finished())],
    );

    assert_eq!(parent.kinds(), [RUN, RUN].concat());
    assert_schema(&parent.facts);
    assert_ne!(parent.facts[0]["turnId"], parent.facts[5]["turnId"]);
}

#[test]
fn a_child_request_carries_the_child_runs_own_model() {
    let mut parent = Parent::new();
    let id = parent.runs.open(CHILD).expect("watch");
    parent.feed(
        CHILD,
        id,
        vec![],
        vec![
            Some(ChildLive::Started {
                run: 1,
                selection: selection("definition-model"),
            }),
            Some(delta("hi")),
            Some(assistant("m1")),
        ],
    );
    let request = parent
        .facts
        .iter()
        .find(|fact| fact["kind"] == "model.request.status")
        .expect("request");
    assert_eq!(request["modelId"], "definition-model");
    assert_eq!(request["providerId"], "child-provider");
    let usage = parent
        .facts
        .iter()
        .find(|fact| fact["kind"] == "usage.delta")
        .expect("usage");
    assert_eq!(usage["modelId"], "definition-model");
    let started = &parent.facts[0];
    assert_eq!(started["modelName"], "definition-model");
}

#[test]
fn a_nested_agent_is_watched_and_reported_under_its_owner() {
    let mut parent = Parent::new();
    let owner = entry("agent_1", SubagentStatus::Running, None);
    let plan = parent.table(&[
        owner.clone(),
        entry("agent_2", SubagentStatus::Running, Some("agent_1")),
    ]);
    assert_eq!(
        plan.open,
        [
            (CHILD.to_owned(), true),
            ("sess_subagent_agent_2".to_owned(), true)
        ]
    );
    parent.table(&[
        owner,
        entry("agent_2", SubagentStatus::Completed, Some("agent_1")),
    ]);

    assert_eq!(
        parent.kinds(),
        ["subagent.lifecycle:running", "subagent.lifecycle:completed"]
    );
    assert_schema(&parent.facts);
    let spawned = &parent.facts[0];
    assert_eq!(spawned["sessionId"], CHILD);
    assert_eq!(spawned["childSessionId"], "sess_subagent_agent_2");
    assert!(spawned.get("parentToolCallId").is_none());
}

#[test]
fn a_parked_agent_keeps_a_watch_for_its_wake() {
    let mut parent = Parent::new();
    let mut parked = entry("agent_1", SubagentStatus::Completed, None);
    parked.parked = true;
    assert_eq!(parent.table(&[parked]).open, [(CHILD.to_owned(), true)]);
}

#[test]
fn a_watch_that_fell_behind_continues_its_run_without_reading_it_twice() {
    let mut parent = Parent::new();
    let first = parent.runs.open(CHILD).expect("watch");
    let reopen = parent.feed(
        CHILD,
        first,
        vec![],
        vec![Some(started(3)), Some(assistant("m1")), None],
    );
    assert!(reopen);
    let second = parent.runs.open(CHILD).expect("watch");
    parent.feed(
        CHILD,
        second,
        vec![started(3), assistant("m1")],
        vec![Some(finished())],
    );

    assert_eq!(parent.kinds(), RUN);
    assert_schema(&parent.facts);
}

#[test]
fn settled_agents_at_the_open_get_no_watch() {
    let mut parent = Parent {
        runs: ChildRuns::default(),
        now: 0,
        facts: Vec::new(),
    };
    // The first read after the open: an agent that ended before it is only recorded.
    assert_eq!(
        parent.table(&[entry("agent_1", SubagentStatus::Completed, None)]),
        Plan::default()
    );
    assert!(parent.facts.is_empty());
}

#[test]
fn a_watch_whose_agent_settles_before_its_run_is_read_still_reads_the_run() {
    let mut parent = Parent::new();
    let plan = parent.table(&[entry("agent_1", SubagentStatus::Running, None)]);
    assert_eq!(plan.open, [(CHILD.to_owned(), true)]);
    let id = parent.runs.open(CHILD).expect("watch");
    // The child finished right after the watch subscribed: its whole run waits in the feed when the settled table
    // reaches the pump first. The watch stays open.
    assert_eq!(
        parent.table(&[entry("agent_1", SubagentStatus::Completed, None)]),
        Plan::default()
    );
    assert!(parent.runs.watching(CHILD));
    parent.feed(
        CHILD,
        id,
        vec![],
        vec![Some(started(1)), Some(assistant("m1")), Some(finished())],
    );

    assert_eq!(parent.kinds(), RUN);
    assert_schema(&parent.facts);
}

#[test]
fn a_watch_that_fell_behind_reads_the_messages_it_lost_from_the_replay() {
    let mut parent = Parent::new();
    let first = parent.runs.open(CHILD).expect("watch");
    // The watch reads m1, then falls behind: m2 is lost from its stream.
    assert!(parent.feed(
        CHILD,
        first,
        vec![],
        vec![Some(started(3)), Some(assistant("m1")), None],
    ));
    let second = parent.runs.open(CHILD).expect("watch");
    parent.feed(
        CHILD,
        second,
        vec![
            started(3),
            assistant("m1"),
            assistant("m2"),
            delta("partial"),
        ],
        vec![Some(finished())],
    );

    assert_eq!(
        parent.kinds(),
        [
            "turn.started",
            "model.request.status:model_request_started",
            "model.request.status:model_request_completed",
            "usage.delta",
            "model.request.status:model_request_started",
            "model.request.status:model_request_completed",
            "usage.delta",
            "turn.terminal:success",
        ]
    );
    assert_schema(&parent.facts);
    let terminal = parent.facts.last().expect("terminal");
    assert_eq!(terminal["tokenCount"], 24);
}

#[test]
fn a_watch_that_fell_behind_reads_the_end_of_a_run_that_finished_meanwhile() {
    let mut parent = Parent::new();
    let first = parent.runs.open(CHILD).expect("watch");
    assert!(parent.feed(
        CHILD,
        first,
        vec![],
        vec![Some(started(3)), Some(assistant("m1")), None],
    ));
    // The run ended before the new watch subscribed: the feed replays it whole, `Finished` included.
    let second = parent.runs.open(CHILD).expect("watch");
    parent.feed(
        CHILD,
        second,
        vec![started(3), assistant("m1"), assistant("m2"), finished()],
        vec![],
    );

    let kinds = parent.kinds();
    assert_eq!(
        kinds.last().map(String::as_str),
        Some("turn.terminal:success")
    );
    assert_eq!(
        kinds
            .iter()
            .filter(|kind| kind.as_str() == "usage.delta")
            .count(),
        2
    );
    assert!(!parent.runs.watching(CHILD));
    assert_schema(&parent.facts);
}

#[test]
fn nested_lifecycle_facts_of_a_reopened_parent_keep_unique_ids() {
    let read = |now: u64| {
        let mut parent = Parent::new();
        parent.now = now;
        parent.table(&[
            entry("agent_1", SubagentStatus::Running, None),
            entry("agent_2", SubagentStatus::Running, Some("agent_1")),
        ]);
        parent.facts
    };
    let (before, after) = (read(1_000), read(2_000));
    let mut facts = before;
    facts.extend(after);
    assert_eq!(facts.len(), 2);
    assert_ne!(facts[0]["eventId"], facts[1]["eventId"]);
    assert_schema(&facts);
}

#[test]
fn nested_lifecycle_facts_of_two_reads_at_one_parent_sequence_keep_unique_ids() {
    let mut parent = Parent::new();
    let owner = entry("agent_1", SubagentStatus::Running, None);
    parent.table(&[
        owner.clone(),
        entry("agent_2", SubagentStatus::Running, Some("agent_1")),
    ]);
    // The owner child's own run reports facts between the two reads.
    let id = parent.runs.open(CHILD).expect("watch");
    parent.feed(
        CHILD,
        id,
        vec![],
        vec![Some(started(1)), Some(assistant("m1"))],
    );
    parent.table(&[
        owner,
        entry("agent_2", SubagentStatus::Completed, Some("agent_1")),
    ]);

    let lifecycle: Vec<_> = parent
        .facts
        .iter()
        .filter(|fact| fact["kind"] == "subagent.lifecycle")
        .collect();
    assert_eq!(lifecycle.len(), 2);
    assert_ne!(lifecycle[0]["eventId"], lifecycle[1]["eventId"]);
    assert_schema(&parent.facts);
}

#[test]
fn after_the_open_a_settled_first_sight_reads_the_kept_run() {
    let mut runs = ChildRuns::default();
    let mut running = entry("agent_0", SubagentStatus::Running, None);
    running.child = SessionId::new("sess_subagent_agent_0");
    let plan = runs.prime(&[entry("agent_9", SubagentStatus::Completed, None), running]);
    assert_eq!(plan.open, [("sess_subagent_agent_0".to_owned(), true)]);
    // A second prime (a change already read the table) does nothing.
    assert_eq!(runs.prime(&[]), Plan::default());
    let mut parent = Parent {
        runs,
        now: 0,
        facts: Vec::new(),
    };
    // The first change after the open sees a fast child that already finished: its kept run is read.
    let plan = parent.table(&[entry("agent_1", SubagentStatus::Completed, None)]);
    assert_eq!(plan.open, [(CHILD.to_owned(), false)]);
}
