//! Fork: the situation snapshot of a run for GetWorkflowRun (9.46). Node's `dynamic-workflow-run-roster.ts` and its three
//! files: `-roster-events.ts` (one scan of the journal's events for every time), `-roster-phases.ts`, `-roster-subagents.ts`,
//! and the health and the log tail of `-introspection.ts` (the last 20 `log` events).
//!
//! A pure function of the journal's events, the non-report node rows, the actor rows and the projected run entry. It reads
//! no clock: Node clamps every event time to the read's `now`, and every age the formatter shows is `now - time` clamped at
//! zero, so the clamp is applied there. Absent facts are omitted, never zero (a missing time is no time).

use std::collections::{HashMap, HashSet};

use rust_cli_node_store::dwf::{ActorRecord, NodeKind, NodeRecord, NodeStatus, StoredEvent};
use serde_json::{Map, Value, json};

/// Node `GET_WORKFLOW_RUN_ROSTER_LIMITS`: the phase rows and the subagent rows the detail carries.
pub const MAX_PHASES: usize = 32;
pub const MAX_SUBAGENTS: usize = 64;
/// Node `DEFAULT_LOG_TAIL_LIMIT`.
const LOG_TAIL_LIMIT: usize = 20;
/// The port's string bound for a log message (`boundDynamicWorkflowRunEventPayload`), in UTF-16 units.
const LOG_MESSAGE_MAX_UNITS: usize = 2_048;

/// Node `PROGRESS_EVENT_TYPES`: the events that show the script or an ask is active.
const PROGRESS_EVENTS: &[&str] = &[
    "node-queued",
    "node-dispatched",
    "node-executing",
    "node-settled",
    "node-progress",
    "phase-entered",
    "log",
    "report",
    "artifact-published",
    "usage-updated",
];

/// Node `NODE_LIFECYCLE_EVENT_TYPES`: the phase transitions of one node (`node-progress` is not one).
const LIFECYCLE_EVENTS: &[&str] = &[
    "node-queued",
    "node-dispatched",
    "node-executing",
    "node-waiting",
    "node-repairing",
    "node-nudged",
    "node-settled",
];

/// What the roster is built from: the projected run entry (`None` when the read has no replay), the events, the non-report
/// node rows and the actor rows, and whether the run is terminal.
pub struct RosterFacts<'a> {
    pub state: Option<&'a Map<String, Value>>,
    pub events: &'a [StoredEvent],
    pub nodes: &'a [NodeRecord],
    pub actors: &'a [ActorRecord],
    pub terminal: bool,
}

/// The roster's keys, as the detail carries them: `phases` (when there is a table), `subagents`, `subagentsTruncated` (when
/// the cap cut rows), `health`, `logTail`, `actors`, and the launch's `modelBindings` and `scriptPath` when the journal has them.
pub fn build_roster(facts: &RosterFacts<'_>) -> Map<String, Value> {
    let index = index_events(facts.events);
    let mut out = Map::new();
    if let Some(mut phases) = phase_views(facts, &index) {
        phases.truncate(MAX_PHASES);
        out.insert("phases".into(), Value::Array(phases));
    }
    let mut subagents = subagent_views(facts, &index);
    let truncated = subagents.len() > MAX_SUBAGENTS;
    subagents.truncate(MAX_SUBAGENTS);
    out.insert("subagents".into(), Value::Array(subagents));
    if truncated {
        out.insert("subagentsTruncated".into(), Value::Bool(true));
    }
    out.insert("health".into(), health(facts, &index));
    out.insert("logTail".into(), Value::Array(log_tail(facts.events)));
    out.insert("actors".into(), Value::Array(actors(facts.actors)));
    let launch = facts
        .events
        .iter()
        .find(|stored| event_type(&stored.event) == Some("run-launched"))
        .map(|stored| &stored.event);
    if let Some(bindings) = launch
        .and_then(|event| event.get("modelBindings"))
        .and_then(Value::as_object)
        .filter(|bindings| !bindings.is_empty())
    {
        out.insert("modelBindings".into(), Value::Object(bindings.clone()));
    }
    // Node readRunScriptPath: the last hole-filled path (a fill can mint one) wins over the run-launched record.
    let minted = facts
        .events
        .iter()
        .filter(|stored| event_type(&stored.event) == Some("hole-filled"))
        .filter_map(|stored| str_of(&stored.event, "scriptPath"))
        .next_back();
    if let Some(path) = minted.or_else(|| launch.and_then(|event| str_of(event, "scriptPath"))) {
        out.insert("scriptPath".into(), Value::String(path.to_owned()));
    }
    out
}

// ————————————————————————————————————————————————
// The event index (Node `indexRosterEvents`)
// ————————————————————————————————————————————————

#[derive(Debug, Clone, Default)]
struct Wait {
    cause: String,
    reason: Option<String>,
    retry_after_ms: Option<i64>,
    since: Option<i64>,
}

#[derive(Debug, Clone, Default)]
struct NodeTrace {
    dispatched_at: Option<i64>,
    last_lifecycle: Option<String>,
    wait: Option<Wait>,
    last_tool_at: Option<i64>,
    last_activity_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default)]
struct PhaseTrace {
    entered_at: Option<i64>,
    exited_at: Option<i64>,
}

struct Settlement {
    key: String,
    outcome: String,
    cached: bool,
}

#[derive(Default)]
struct Index {
    nodes: HashMap<String, NodeTrace>,
    phases: HashMap<String, PhaseTrace>,
    settlements: Vec<Settlement>,
    last_progress_at: Option<i64>,
    stalled_since: Option<i64>,
    concurrency_reason: Option<String>,
    concurrency_since: Option<i64>,
}

fn index_events(events: &[StoredEvent]) -> Index {
    let mut index = Index::default();
    let mut stalled_at: Option<i64> = None;
    let mut stalled_pending = false;
    let mut last_phase: Option<String> = None;
    for stored in events {
        let event = &stored.event;
        let Some(kind) = event_type(event) else {
            continue;
        };
        let at = time_of(stored);
        if PROGRESS_EVENTS.contains(&kind) {
            index.last_progress_at = later(index.last_progress_at, at);
            // Any progress after a stall observation ends the stall, even one without a timestamp.
            stalled_pending = false;
        }
        match kind {
            "run-stalled" => {
                stalled_at = at;
                stalled_pending = true;
                continue;
            }
            "concurrency-changed" => {
                index.concurrency_reason = str_of(event, "reason").map(str::to_owned);
                index.concurrency_since = at;
                continue;
            }
            "phase-entered" => {
                if let Some(name) = str_of(event, "name") {
                    track_phase(&mut index.phases, name, &last_phase, at);
                    last_phase = Some(name.to_owned());
                }
                continue;
            }
            _ => {}
        }
        // Node: only an event with an `instance` names a node.
        let Some(instance) = event.get("instance") else {
            continue;
        };
        let (Some(site), Some(ordinal)) =
            (str_of(instance, "siteId"), int_of(instance.get("ordinal")))
        else {
            continue;
        };
        let key = node_key(site, ordinal);
        let trace = index.nodes.entry(key.clone()).or_default();
        if PROGRESS_EVENTS.contains(&kind) {
            trace.last_activity_at = later(trace.last_activity_at, at);
        }
        if LIFECYCLE_EVENTS.contains(&kind) {
            track_lifecycle(trace, kind, at);
        }
        if kind == "node-waiting" {
            // A backoff ladder emits several waits: the start of the wait is kept, the reason and retry interval are the latest.
            let since = trace.wait.as_ref().and_then(|wait| wait.since).or(at);
            trace.wait = Some(Wait {
                cause: str_of(event, "cause").unwrap_or_default().to_owned(),
                reason: str_of(event, "reason").map(str::to_owned),
                retry_after_ms: int_of(event.get("retryAfterMs")),
                since,
            });
        }
        if kind == "node-progress" && event.get("lastTool").is_some() && at.is_some() {
            trace.last_tool_at = at;
        }
        if kind == "node-settled" {
            index.settlements.push(Settlement {
                key: key.clone(),
                outcome: str_of(event, "outcome").unwrap_or_default().to_owned(),
                cached: event.get("cached") == Some(&Value::Bool(true)),
            });
        }
    }
    index.stalled_since = if stalled_pending { stalled_at } else { None };
    index
}

/// Node `trackPhase`: a phase starts, and the previous different phase ends. A re-entry restarts the entry time.
fn track_phase(
    phases: &mut HashMap<String, PhaseTrace>,
    name: &str,
    last: &Option<String>,
    at: Option<i64>,
) {
    if let (Some(last), Some(at)) = (last, at)
        && last != name
        && let Some(previous) = phases.get_mut(last)
    {
        previous.exited_at = Some(at);
    }
    phases.insert(
        name.to_owned(),
        PhaseTrace {
            entered_at: at,
            exited_at: None,
        },
    );
}

/// Node `trackLifecycle`: any lifecycle event but a wait ends the wait; a requeue clears the dispatch time.
fn track_lifecycle(trace: &mut NodeTrace, kind: &str, at: Option<i64>) {
    trace.last_lifecycle = Some(kind.to_owned());
    if kind != "node-waiting" {
        trace.wait = None;
    }
    if kind == "node-queued" {
        trace.dispatched_at = None;
    }
    if kind == "node-dispatched"
        && let Some(at) = at
    {
        trace.dispatched_at = Some(at);
    }
}

/// Node `timeOf`: a missing or non-positive time is no clock (0 is 1970, never a real time).
fn time_of(stored: &StoredEvent) -> Option<i64> {
    (stored.time_created > 0).then_some(stored.time_created)
}

fn later(left: Option<i64>, right: Option<i64>) -> Option<i64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, None) => left,
        (None, right) => right,
    }
}

// ————————————————————————————————————————————————
// The phase table (Node `buildPhaseViews`)
// ————————————————————————————————————————————————

fn phase_views(facts: &RosterFacts<'_>, index: &Index) -> Option<Vec<Value>> {
    let state = facts.state?;
    let declared: Vec<String> = array_of(state.get("phaseNames"))
        .iter()
        .filter_map(|name| name.as_str().map(str::to_owned))
        .collect();
    let entered = array_of(state.get("phases"));
    if declared.is_empty() && entered.is_empty() {
        return None;
    }
    let mut names = declared;
    for phase in entered {
        if let Some(name) = str_of(phase, "name")
            && !names.iter().any(|known| known == name)
        {
            names.push(name.to_owned());
        }
    }
    let reduced = array_of(state.get("nodes"));
    // A row still marked running on a terminal run is an unsettled node, whatever the reducer says.
    let leftover: HashSet<String> = if facts.terminal {
        facts
            .nodes
            .iter()
            .filter(|row| row.status == NodeStatus::Running)
            .map(|row| node_key(&row.site_id, row.ordinal))
            .collect()
    } else {
        HashSet::new()
    };
    let is_open = |node: &Value| {
        str_of(node, "phase") != Some("settled") || leftover.contains(&reduced_key(node))
    };
    let current = state.get("currentPhase").and_then(Value::as_str);
    let views = names
        .iter()
        .map(|name| {
            let rounds = entered
                .iter()
                .find(|phase| str_of(phase, "name") == Some(name.as_str()))
                .and_then(|phase| int_of(phase.get("rounds")))
                .unwrap_or(0);
            let owned: Vec<&Value> = reduced
                .iter()
                .filter(|node| str_of(node, "phaseName") == Some(name.as_str()))
                .collect();
            let open: Vec<&Value> = owned.iter().copied().filter(|node| is_open(node)).collect();
            let running = open.len();
            let settled = owned.len() - running;
            let state_name = if rounds == 0 {
                "ahead"
            } else if facts.terminal {
                if open
                    .iter()
                    .any(|node| str_of(node, "kind") != Some("world-read"))
                {
                    "unfinished"
                } else {
                    "done"
                }
            } else if current == Some(name.as_str()) {
                "current"
            } else {
                "done"
            };
            let mut view = Map::new();
            view.insert("name".into(), json!(name));
            view.insert("state".into(), json!(state_name));
            view.insert("rounds".into(), json!(rounds));
            view.insert("nodesSettled".into(), json!(settled));
            view.insert("nodesRunning".into(), json!(running));
            if let Some(trace) = index.phases.get(name) {
                if let Some(at) = trace.entered_at {
                    view.insert("enteredAt".into(), json!(at));
                }
                if let Some(at) = trace.exited_at {
                    view.insert("exitedAt".into(), json!(at));
                }
            }
            Value::Object(view)
        })
        .collect();
    Some(views)
}

// ————————————————————————————————————————————————
// The subagent roster (Node `buildSubagentViews`)
// ————————————————————————————————————————————————

fn subagent_views(facts: &RosterFacts<'_>, index: &Index) -> Vec<Value> {
    let state = facts.state;
    let reduced: HashMap<String, &Value> = state
        .map(|state| array_of(state.get("nodes")))
        .unwrap_or_default()
        .iter()
        .map(|node| (reduced_key(node), node))
        .collect();
    // Parked questions and born phases, keyed by the actor; the first entry wins, as a linear search would find it.
    let parked: HashMap<String, String> = state
        .map(|state| {
            first_wins(
                array_of(state.get("pendingQuestions"))
                    .iter()
                    .filter_map(|question| {
                        let actor = node_key(
                            str_of(question, "actorSiteId")?,
                            int_of(question.get("actorOrdinal"))?,
                        );
                        Some((actor, str_of(question, "qid")?.to_owned()))
                    }),
            )
        })
        .unwrap_or_default();
    let born: HashMap<String, Option<String>> = state
        .map(|state| {
            first_wins(array_of(state.get("actors")).iter().filter_map(|actor| {
                Some((
                    node_key(str_of(actor, "siteId")?, int_of(actor.get("ordinal"))?),
                    str_of(actor, "phaseName").map(str::to_owned),
                ))
            }))
        })
        .unwrap_or_default();
    // The asks of each subagent, grouped once and in sequence order (a stable sort keeps the journal order of equal sequences).
    let mut asks_by_actor: HashMap<String, Vec<&NodeRecord>> = HashMap::new();
    for node in facts.nodes {
        if let (Some(site), Some(ordinal)) = (node.actor_site_id.as_deref(), node.actor_ordinal) {
            asks_by_actor
                .entry(node_key(site, ordinal))
                .or_default()
                .push(node);
        }
    }
    for asks in asks_by_actor.values_mut() {
        asks.sort_by_key(|node| node.actor_seq.unwrap_or(0));
    }

    facts
        .actors
        .iter()
        .map(|actor| {
            let key = node_key(&actor.site_id, actor.ordinal);
            let asks: Vec<&NodeRecord> = asks_by_actor.get(&key).cloned().unwrap_or_default();
            let settled: Vec<&NodeRecord> = asks
                .iter()
                .copied()
                .filter(|node| node.status != NodeStatus::Running)
                .collect();
            let running_ask = asks
                .iter()
                .copied()
                .rfind(|node| node.status == NodeStatus::Running);
            let trace =
                running_ask.and_then(|ask| index.nodes.get(&node_key(&ask.site_id, ask.ordinal)));
            let parked_on = parked.get(&key).cloned();
            let last_failed = settled
                .last()
                .is_some_and(|ask| ask.status == NodeStatus::Failed);
            let state_name = subagent_state(
                facts.terminal,
                running_ask.is_some(),
                trace.and_then(|trace| trace.last_lifecycle.as_deref()) == Some("node-waiting"),
                parked_on.is_some(),
                last_failed,
            );

            let mut view = Map::new();
            view.insert("siteId".into(), json!(actor.site_id));
            view.insert("ordinal".into(), json!(actor.ordinal));
            if let Some(name) = &actor.name {
                view.insert("name".into(), json!(name));
            }
            view.insert("state".into(), json!(state_name));
            // The phase where the current (or most recent) ask began; else the actor's own born phase.
            let phase = [running_ask, settled.last().copied()]
                .into_iter()
                .flatten()
                .find_map(|ask| {
                    reduced
                        .get(&node_key(&ask.site_id, ask.ordinal))
                        .and_then(|node| str_of(node, "phaseName"))
                })
                .map(str::to_owned)
                .or_else(|| born.get(&key).cloned().flatten());
            if let Some(phase) = phase {
                view.insert("phaseName".into(), json!(phase));
            }
            if let Some(ask) = running_ask {
                view.insert(
                    "currentAsk".into(),
                    current_ask(
                        ask,
                        reduced.get(&node_key(&ask.site_id, ask.ordinal)).copied(),
                        trace,
                    ),
                );
            }
            if let Some(wait) = trace.and_then(|trace| trace.wait.as_ref()) {
                view.insert("wait".into(), wait_json(wait));
            }
            if let Some(qid) = parked_on {
                view.insert("parkedOn".into(), json!(qid));
            }
            view.insert("stepsSettled".into(), json!(settled.len()));
            view.insert(
                "stepsFailed".into(),
                json!(
                    settled
                        .iter()
                        .filter(|ask| ask.status == NodeStatus::Failed)
                        .count()
                ),
            );
            // Tokens come from settled asks only: the in-flight ask has no stats until it settles.
            let tokens: i64 = settled.iter().map(|ask| stats_tokens(ask)).sum();
            view.insert("tokens".into(), json!(tokens));
            // The latest progress of any ask this subagent owns.
            let last_progress = asks.iter().fold(None, |latest, ask| {
                later(
                    latest,
                    index
                        .nodes
                        .get(&node_key(&ask.site_id, ask.ordinal))
                        .and_then(|trace| trace.last_activity_at),
                )
            });
            if let Some(at) = last_progress {
                view.insert("lastProgressAt".into(), json!(at));
            }
            Value::Object(view)
        })
        .collect()
}

/// Node `subagentStateOf`: the first matching rule decides. A parked subagent is parked even though its ask runs.
fn subagent_state(
    terminal: bool,
    running: bool,
    waiting: bool,
    parked: bool,
    last_failed: bool,
) -> &'static str {
    if terminal {
        // All live states are retired on a terminal run: a running row there means the process died mid-ask.
        return if running {
            "unfinished"
        } else if last_failed {
            "failed"
        } else {
            "done"
        };
    }
    if parked {
        return "parked";
    }
    if running {
        return if waiting { "waiting" } else { "executing" };
    }
    if last_failed { "failed" } else { "idle" }
}

fn current_ask(ask: &NodeRecord, reduced: Option<&Value>, trace: Option<&NodeTrace>) -> Value {
    let mut out = Map::new();
    out.insert("siteId".into(), json!(ask.site_id));
    out.insert("ordinal".into(), json!(ask.ordinal));
    if let Some(seq) = ask.actor_seq {
        out.insert("actorSeq".into(), json!(seq));
    }
    if let Some(head) = reduced.and_then(|node| str_of(node, "instructionsHead")) {
        out.insert("instructionsHead".into(), json!(head));
    }
    if let Some(at) = trace.and_then(|trace| trace.dispatched_at) {
        out.insert("startedAt".into(), json!(at));
    }
    if let Some(turn) = reduced.and_then(|node| int_of(node.get("turn"))) {
        out.insert("turn".into(), json!(turn));
    }
    if let Some(calls) = reduced.and_then(|node| int_of(node.get("toolCalls"))) {
        out.insert("toolCalls".into(), json!(calls));
    }
    if let Some(tool) = reduced
        .and_then(|node| node.get("lastTool"))
        .filter(|tool| tool.is_object())
    {
        let mut last = Map::new();
        last.insert(
            "name".into(),
            json!(str_of(tool, "name").unwrap_or_default()),
        );
        if let Some(target) = str_of(tool, "target") {
            last.insert("target".into(), json!(target));
        }
        if let Some(at) = trace.and_then(|trace| trace.last_tool_at) {
            last.insert("at".into(), json!(at));
        }
        out.insert("lastTool".into(), Value::Object(last));
    }
    Value::Object(out)
}

fn wait_json(wait: &Wait) -> Value {
    let mut out = Map::new();
    out.insert("cause".into(), json!(wait.cause));
    if let Some(reason) = &wait.reason {
        out.insert("reason".into(), json!(reason));
    }
    if let Some(ms) = wait.retry_after_ms {
        out.insert("retryAfterMs".into(), json!(ms));
    }
    if let Some(since) = wait.since {
        out.insert("since".into(), json!(since));
    }
    Value::Object(out)
}

fn stats_tokens(node: &NodeRecord) -> i64 {
    node.stats
        .as_ref()
        .and_then(|stats| int_of(stats.get("tokens")))
        .unwrap_or(0)
}

// ————————————————————————————————————————————————
// Health, the log tail and the actors
// ————————————————————————————————————————————————

/// Node `buildHealth` and `concurrencyField`.
fn health(facts: &RosterFacts<'_>, index: &Index) -> Value {
    let mut out = Map::new();
    if let Some(at) = index.last_progress_at {
        out.insert("lastProgressAt".into(), json!(at));
    }
    if let Some(at) = index.stalled_since {
        out.insert("stalledSince".into(), json!(at));
    }
    if let Some(concurrency) = facts
        .state
        .and_then(|state| state.get("concurrency"))
        .filter(|value| value.is_object())
        && let Some(cap) = num_of(concurrency.get("cap"))
    {
        let limit = num_of(concurrency.get("limit")).or_else(|| num_of(concurrency.get("ceiling")));
        if let Some(limit) = limit {
            let effective = cap.min(limit);
            if effective < limit {
                let mut field = Map::new();
                field.insert("effective".into(), num_json(effective));
                field.insert("cap".into(), num_json(limit));
                if let Some(reason) = &index.concurrency_reason {
                    field.insert("reason".into(), json!(reason));
                }
                if let Some(at) = index.concurrency_since {
                    field.insert("since".into(), json!(at));
                }
                out.insert("concurrency".into(), Value::Object(field));
            }
        }
    }
    let ask_keys: HashSet<String> = facts
        .nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Ask)
        .map(|node| node_key(&node.site_id, node.ordinal))
        .collect();
    // Consecutive trailing failures of asks only: a cancelled or successful settlement breaks the run.
    let failures = index
        .settlements
        .iter()
        .rev()
        .filter(|settlement| ask_keys.contains(&settlement.key))
        .take_while(|settlement| settlement.outcome == "failed")
        .count();
    out.insert("consecutiveFailures".into(), json!(failures));
    out.insert(
        "cachedSteps".into(),
        json!(
            index
                .settlements
                .iter()
                .filter(|settlement| settlement.cached)
                .count()
        ),
    );
    if facts.terminal {
        let leftover = facts
            .nodes
            .iter()
            .filter(|node| node.status == NodeStatus::Running)
            .count();
        if leftover > 0 {
            out.insert("leftoverRunning".into(), json!(leftover));
        }
    }
    out.insert("pendingQuestionsKnown".into(), json!(facts.state.is_some()));
    Value::Object(out)
}

/// Node `listRecentLogEvents(runId, 20)` mapped by `toLogTailEntry`: the last twenty `log` events, oldest first.
fn log_tail(events: &[StoredEvent]) -> Vec<Value> {
    let logs: Vec<&StoredEvent> = events
        .iter()
        .filter(|stored| event_type(&stored.event) == Some("log"))
        .collect();
    let start = logs.len().saturating_sub(LOG_TAIL_LIMIT);
    logs[start..]
        .iter()
        .map(|stored| {
            let mut entry = Map::new();
            entry.insert("sequence".into(), json!(stored.sequence));
            let message = str_of(&stored.event, "message").unwrap_or_default();
            entry.insert(
                "message".into(),
                json!(bounded_units(message, LOG_MESSAGE_MAX_UNITS)),
            );
            if let Some(at) = time_of(stored) {
                entry.insert("at".into(), json!(at));
            }
            Value::Object(entry)
        })
        .collect()
}

fn actors(rows: &[ActorRecord]) -> Vec<Value> {
    rows.iter()
        .map(|actor| {
            let mut out = Map::new();
            out.insert("siteId".into(), json!(actor.site_id));
            out.insert("ordinal".into(), json!(actor.ordinal));
            if let Some(name) = &actor.name {
                out.insert("name".into(), json!(name));
            }
            Value::Object(out)
        })
        .collect()
}

// ————————————————————————————————————————————————
// Helpers
// ————————————————————————————————————————————————

fn node_key(site: &str, ordinal: i64) -> String {
    format!("{site}@{ordinal}")
}

/// The map of the first value for each key: a linear search over the pairs would have found that one.
fn first_wins<V>(pairs: impl Iterator<Item = (String, V)>) -> HashMap<String, V> {
    let mut map = HashMap::new();
    for (key, value) in pairs {
        map.entry(key).or_insert(value);
    }
    map
}

/// The key of a reduced node entry (its `siteId` and `ordinal`).
fn reduced_key(node: &Value) -> String {
    node_key(
        str_of(node, "siteId").unwrap_or_default(),
        int_of(node.get("ordinal")).unwrap_or(-1),
    )
}

fn array_of(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn event_type(event: &Value) -> Option<&str> {
    str_of(event, "type")
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// An integer field. A number with no fraction is an integer; anything else is no integer.
fn int_of(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|n| n.fract() == 0.0)
            .map(|n| n as i64)
    })
}

fn num_of(value: Option<&Value>) -> Option<f64> {
    value?.as_f64()
}

/// A number as JSON: an integer when it is whole, so the formatter prints `2/4`, not `2.0/4.0`.
fn num_json(value: f64) -> Value {
    if value.fract() == 0.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// The longest prefix of `text` that fits `limit` UTF-16 units, never splitting a character.
fn bounded_units(text: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for ch in text.chars() {
        let width = ch.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

#[cfg(test)]
#[path = "run_roster_tests.rs"]
mod tests;
