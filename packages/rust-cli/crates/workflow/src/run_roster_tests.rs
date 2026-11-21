//! 9.46: the situation snapshot of a run (phases, subagents, health, log tail, actors), from the journal's events, its node and
//! actor rows and the projected state. The rules are Node's `dynamic-workflow-run-roster*.ts`; each test names the rule it pins.

use rust_cli_node_store::dwf::{ActorRecord, NodeKind, NodeRecord, NodeStatus, StoredEvent};
use serde_json::{Map, Value, json};

use crate::run_roster::{RosterFacts, build_roster};

fn stored(sequence: i64, time: i64, event: Value) -> StoredEvent {
    StoredEvent {
        sequence,
        event,
        time_created: time,
    }
}

fn state(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("a state object")
}

fn actor(site: &str, ordinal: i64, name: Option<&str>) -> ActorRecord {
    ActorRecord {
        run_id: "wf_1".into(),
        site_id: site.into(),
        ordinal,
        name: name.map(str::to_owned),
        ..Default::default()
    }
}

fn ask(site: &str, ordinal: i64, actor: (&str, i64), seq: i64, status: NodeStatus) -> NodeRecord {
    NodeRecord {
        run_id: "wf_1".into(),
        site_id: site.into(),
        ordinal,
        kind: NodeKind::Ask,
        actor_site_id: Some(actor.0.into()),
        actor_ordinal: Some(actor.1),
        actor_seq: Some(seq),
        status,
        ..Default::default()
    }
}

fn facts<'a>(
    state: Option<&'a Map<String, Value>>,
    events: &'a [StoredEvent],
    nodes: &'a [NodeRecord],
    actors: &'a [ActorRecord],
    terminal: bool,
) -> RosterFacts<'a> {
    RosterFacts {
        state,
        events,
        nodes,
        actors,
        terminal,
        questions_known: true,
    }
}

fn roster(facts: &RosterFacts<'_>) -> Map<String, Value> {
    build_roster(facts)
}

#[test]
fn phases_are_declared_order_with_entry_and_exit_times_from_the_events() {
    // Node: declared phases in order; the previous different phase exits when the next one is entered; a phase with no rounds is `ahead`.
    let s = state(json!({
        "phaseNames": ["plan", "build", "ship"],
        "phases": [
            { "name": "plan", "rounds": 1 },
            { "name": "build", "rounds": 2 }
        ],
        "currentPhase": "build",
        "nodes": [
            { "siteId": "a", "ordinal": 1, "phaseName": "build", "phase": "executing", "kind": "ask" }
        ]
    }));
    let events = [
        stored(1, 1_000, json!({ "type": "phase-entered", "name": "plan" })),
        stored(
            2,
            2_000,
            json!({ "type": "phase-entered", "name": "build" }),
        ),
    ];
    let out = roster(&facts(Some(&s), &events, &[], &[], false));
    let phases = out["phases"].as_array().expect("phases");
    assert_eq!(phases.len(), 3);
    assert_eq!(
        phases[0],
        json!({ "name": "plan", "state": "done", "rounds": 1, "nodesSettled": 0, "nodesRunning": 0, "enteredAt": 1_000, "exitedAt": 2_000 })
    );
    assert_eq!(
        phases[1],
        json!({ "name": "build", "state": "current", "rounds": 2, "nodesSettled": 0, "nodesRunning": 1, "enteredAt": 2_000 })
    );
    assert_eq!(
        phases[2],
        json!({ "name": "ship", "state": "ahead", "rounds": 0, "nodesSettled": 0, "nodesRunning": 0 })
    );
}

#[test]
fn a_run_with_no_declared_or_entered_phase_has_no_phase_table() {
    // Node: undefined, not an empty table, when the script declared no phase and none was visited.
    let s = state(json!({ "phaseNames": [], "phases": [] }));
    let out = roster(&facts(Some(&s), &[], &[], &[], false));
    assert!(!out.contains_key("phases"), "{out:?}");
}

#[test]
fn an_open_node_in_a_finished_phase_makes_it_unfinished_only_on_a_terminal_run() {
    // Node: `unfinished` applies to terminal runs only; a non-world-read open node makes the phase unfinished, a world read does not.
    let s = state(json!({
        "phaseNames": ["only"],
        "phases": [{ "name": "only", "rounds": 1 }],
        "currentPhase": "only",
        "nodes": [{ "siteId": "a", "ordinal": 1, "phaseName": "only", "phase": "executing", "kind": "ask" }]
    }));
    let rows = [ask("a", 1, ("agent", 1), 0, NodeStatus::Running)];
    let live = roster(&facts(Some(&s), &[], &rows, &[], false));
    assert_eq!(live["phases"][0]["state"], "current");
    let done = roster(&facts(Some(&s), &[], &rows, &[], true));
    assert_eq!(done["phases"][0]["state"], "unfinished");
    assert_eq!(done["phases"][0]["nodesRunning"], 1);
}

#[test]
fn subagent_states_follow_node_rule_order_and_parked_wins_over_executing() {
    // Node `subagentStateOf`: parked is checked before running; a waiting ask is `waiting`; a settled last failure is `failed`;
    // a subagent with no running ask and no failure is `idle`.
    let s = state(json!({
        "phaseNames": [], "phases": [],
        "pendingQuestions": [{ "qid": "q-1", "actorSiteId": "agent", "actorOrdinal": 1, "askedAt": 900, "question": "which?" }],
        "nodes": [
            { "siteId": "w", "ordinal": 1, "actorSiteId": "agent", "actorOrdinal": 1, "instructionsHead": "fetch the feed", "turn": 2, "toolCalls": 3,
              "lastTool": { "name": "Read", "target": "a.txt" }, "phase": "executing", "phaseName": "fetch" },
            { "siteId": "x", "ordinal": 2, "actorSiteId": "beta", "actorOrdinal": 2, "phase": "waiting", "phaseName": "fetch" },
            { "siteId": "y", "ordinal": 3, "actorSiteId": "gamma", "actorOrdinal": 3, "phase": "executing", "phaseName": "fetch" }
        ]
    }));
    let actors = [
        actor("agent", 1, Some("poet")),
        actor("beta", 2, None),
        actor("gamma", 3, None),
        actor("delta", 4, None),
        actor("eps", 5, None),
    ];
    let rows = [
        ask("w", 1, ("agent", 1), 0, NodeStatus::Running),
        ask("x", 2, ("beta", 2), 0, NodeStatus::Running),
        ask("y", 3, ("gamma", 3), 0, NodeStatus::Running),
        ask("z", 4, ("delta", 4), 0, NodeStatus::Failed),
    ];
    let events = [
        stored(
            1,
            1_000,
            json!({ "type": "node-dispatched", "instance": { "siteId": "w", "ordinal": 1 } }),
        ),
        stored(
            2,
            1_100,
            json!({ "type": "node-progress", "instance": { "siteId": "w", "ordinal": 1 }, "lastTool": { "name": "Read", "target": "a.txt" } }),
        ),
        stored(
            3,
            1_200,
            json!({ "type": "node-waiting", "instance": { "siteId": "x", "ordinal": 2 }, "cause": "backoff", "reason": "rate limited", "retryAfterMs": 4_000 }),
        ),
        stored(
            4,
            1_300,
            json!({ "type": "node-dispatched", "instance": { "siteId": "y", "ordinal": 3 } }),
        ),
    ];
    let out = roster(&facts(Some(&s), &events, &rows, &actors, false));
    let subs = out["subagents"].as_array().expect("subagents");
    assert_eq!(subs.len(), 5);
    assert_eq!(subs[0]["name"], "poet");
    assert_eq!(subs[0]["state"], "parked");
    assert_eq!(subs[0]["parkedOn"], "q-1");
    assert_eq!(subs[0]["phaseName"], "fetch");
    assert_eq!(subs[0]["currentAsk"]["instructionsHead"], "fetch the feed");
    assert_eq!(subs[0]["currentAsk"]["turn"], 2);
    assert_eq!(subs[0]["currentAsk"]["toolCalls"], 3);
    assert_eq!(subs[0]["currentAsk"]["startedAt"], 1_000);
    assert_eq!(
        subs[0]["currentAsk"]["lastTool"],
        json!({ "name": "Read", "target": "a.txt", "at": 1_100 })
    );
    assert_eq!(subs[0]["lastProgressAt"], 1_100);
    assert_eq!(subs[1]["state"], "waiting");
    assert_eq!(
        subs[1]["wait"],
        json!({ "cause": "backoff", "reason": "rate limited", "retryAfterMs": 4_000, "since": 1_200 })
    );
    assert_eq!(subs[2]["state"], "executing");
    assert_eq!(subs[3]["state"], "failed");
    assert_eq!(subs[3]["stepsFailed"], 1);
    assert_eq!(subs[4]["state"], "idle");
    assert_eq!(subs[4]["stepsSettled"], 0);
    assert!(!subs[4].as_object().unwrap().contains_key("currentAsk"));
}

#[test]
fn a_terminal_run_retires_live_states_and_counts_tokens_of_settled_asks_only() {
    // Node: on a terminal run a running ask is `unfinished`; tokens come from settled asks only.
    let s = state(json!({ "phaseNames": [], "phases": [], "nodes": [] }));
    let mut settled = ask("a", 1, ("agent", 1), 0, NodeStatus::Completed);
    settled.stats = Some(json!({ "tokens": 120 }));
    let mut running = ask("b", 2, ("agent", 1), 1, NodeStatus::Running);
    running.stats = Some(json!({ "tokens": 999 }));
    let actors = [actor("agent", 1, None)];
    let rows = [settled, running];
    let out = roster(&facts(Some(&s), &[], &rows, &actors, true));
    let sub = &out["subagents"][0];
    assert_eq!(sub["state"], "unfinished");
    assert_eq!(sub["stepsSettled"], 1);
    assert_eq!(sub["tokens"], 120);
    assert_eq!(out["health"]["leftoverRunning"], 1);
}

#[test]
fn health_reports_progress_a_stall_trailing_failures_and_cached_steps() {
    // Node `indexRosterEvents` and `buildHealth`: a progress event after a stall ends it; `run-stalled` without later progress
    // is the stall; trailing failed asks count from the end; cached settlements count.
    let s = state(json!({ "phaseNames": [], "phases": [] }));
    let rows = [
        ask("a", 1, ("agent", 1), 0, NodeStatus::Completed),
        ask("b", 2, ("agent", 1), 1, NodeStatus::Failed),
        ask("c", 3, ("agent", 1), 2, NodeStatus::Failed),
    ];
    let events = [
        stored(
            1,
            100,
            json!({ "type": "node-settled", "instance": { "siteId": "a", "ordinal": 1 }, "outcome": "ok", "cached": true }),
        ),
        stored(2, 400, json!({ "type": "log", "message": "hello" })),
        stored(3, 500, json!({ "type": "run-stalled" })),
        stored(
            4,
            600,
            json!({ "type": "node-settled", "instance": { "siteId": "b", "ordinal": 2 }, "outcome": "failed" }),
        ),
        stored(
            5,
            700,
            json!({ "type": "node-settled", "instance": { "siteId": "c", "ordinal": 3 }, "outcome": "failed" }),
        ),
        stored(6, 800, json!({ "type": "run-stalled" })),
    ];
    let out = roster(&facts(Some(&s), &events, &rows, &[], false));
    let health = &out["health"];
    assert_eq!(health["lastProgressAt"], 700);
    assert_eq!(health["stalledSince"], 800);
    assert_eq!(health["consecutiveFailures"], 2);
    assert_eq!(health["cachedSteps"], 1);
    assert_eq!(health["pendingQuestionsKnown"], true);
    assert!(!health.as_object().unwrap().contains_key("leftoverRunning"));
}

#[test]
fn a_stall_ends_when_progress_follows_it() {
    let s = state(json!({ "phaseNames": [], "phases": [] }));
    let events = [
        stored(1, 100, json!({ "type": "run-stalled" })),
        stored(2, 200, json!({ "type": "phase-entered", "name": "x" })),
    ];
    let out = roster(&facts(Some(&s), &events, &[], &[], false));
    assert!(
        !out["health"]
            .as_object()
            .unwrap()
            .contains_key("stalledSince")
    );
    assert_eq!(out["health"]["lastProgressAt"], 200);
}

#[test]
fn a_terminal_run_counts_its_running_rows_as_leftovers_and_a_live_run_does_not() {
    let s = state(json!({ "phaseNames": [], "phases": [] }));
    let rows = [ask("a", 1, ("agent", 1), 0, NodeStatus::Running)];
    let live = roster(&facts(Some(&s), &[], &rows, &[], false));
    assert!(
        !live["health"]
            .as_object()
            .unwrap()
            .contains_key("leftoverRunning")
    );
    let done = roster(&facts(Some(&s), &[], &rows, &[], true));
    assert_eq!(done["health"]["leftoverRunning"], 1);
}

#[test]
fn concurrency_is_reported_only_when_the_effective_cap_is_below_the_run_limit() {
    // Node `concurrencyField`: `effective = min(cap, limit ?? ceiling)`, present only when effective < that cap.
    let below = state(
        json!({ "phaseNames": [], "phases": [], "concurrency": { "cap": 2, "ceiling": 4, "limit": 4 } }),
    );
    let events = [stored(
        1,
        50,
        json!({ "type": "concurrency-changed", "reason": "rate_limit" }),
    )];
    let out = roster(&facts(Some(&below), &events, &[], &[], false));
    assert_eq!(
        out["health"]["concurrency"],
        json!({ "effective": 2, "cap": 4, "reason": "rate_limit", "since": 50 })
    );
    let at_limit =
        state(json!({ "phaseNames": [], "phases": [], "concurrency": { "cap": 3, "ceiling": 3 } }));
    let out = roster(&facts(Some(&at_limit), &[], &[], &[], false));
    assert!(
        !out["health"]
            .as_object()
            .unwrap()
            .contains_key("concurrency")
    );
}

#[test]
fn log_tail_is_the_last_twenty_log_lines_in_sequence_order_with_their_times() {
    let s = state(json!({ "phaseNames": [], "phases": [] }));
    let events: Vec<StoredEvent> = (1..=25)
        .map(|n| {
            stored(
                n,
                if n == 25 { 0 } else { n * 10 },
                json!({ "type": "log", "message": format!("line {n}") }),
            )
        })
        .collect();
    let out = roster(&facts(Some(&s), &events, &[], &[], false));
    let tail = out["logTail"].as_array().expect("logTail");
    assert_eq!(tail.len(), 20);
    assert_eq!(
        tail[0],
        json!({ "sequence": 6, "message": "line 6", "at": 60 })
    );
    assert_eq!(tail[19], json!({ "sequence": 25, "message": "line 25" }));
}

#[test]
fn a_run_without_log_lines_has_an_empty_tail_and_every_actor_is_listed() {
    let out = roster(&facts(
        None,
        &[],
        &[],
        &[actor("agent", 1, Some("poet")), actor("beta", 2, None)],
        false,
    ));
    assert_eq!(out["logTail"], json!([]));
    assert_eq!(
        out["actors"],
        json!([{ "siteId": "agent", "ordinal": 1, "name": "poet" }, { "siteId": "beta", "ordinal": 2 }])
    );
    // Without the projected state, pending questions are unknown and no subagent can be parked.
    assert_eq!(out["health"]["pendingQuestionsKnown"], false);
}

#[test]
fn the_subagent_roster_is_capped_at_sixty_four_and_says_so() {
    let s = state(json!({ "phaseNames": [], "phases": [] }));
    let actors: Vec<ActorRecord> = (1..=65).map(|n| actor("agent", n, None)).collect();
    let out = roster(&facts(Some(&s), &[], &[], &actors, false));
    assert_eq!(out["subagents"].as_array().unwrap().len(), 64);
    assert_eq!(out["subagentsTruncated"], true);
}

#[test]
fn model_bindings_and_script_path_come_from_the_run_launched_event() {
    let s = state(json!({ "phaseNames": [], "phases": [] }));
    let events = [stored(
        1,
        10,
        json!({ "type": "run-launched", "scriptPath": "/work/flow.js", "modelBindings": { "poet": "openai/gpt-x" } }),
    )];
    let out = roster(&facts(Some(&s), &events, &[], &[], false));
    assert_eq!(out["modelBindings"], json!({ "poet": "openai/gpt-x" }));
    assert_eq!(out["scriptPath"], "/work/flow.js");
    let bare = roster(&facts(
        Some(&s),
        &[stored(
            1,
            10,
            json!({ "type": "run-launched", "modelBindings": {} }),
        )],
        &[],
        &[],
        false,
    ));
    assert!(!bare.contains_key("modelBindings"));
    assert!(!bare.contains_key("scriptPath"));
}

#[test]
fn a_log_message_is_bounded_to_2048_utf16_units() {
    let s = state(json!({ "phaseNames": [], "phases": [] }));
    let long = "a".repeat(3_000);
    let events = [stored(1, 10, json!({ "type": "log", "message": long }))];
    let out = roster(&facts(Some(&s), &events, &[], &[], false));
    assert_eq!(out["logTail"][0]["message"].as_str().unwrap().len(), 2_048);
}

#[test]
fn a_hole_fill_minted_script_path_wins_over_the_launch_record() {
    // Node readRunScriptPath: the last hole-filled scriptPath wins over the run-launched one.
    let s = state(json!({ "phaseNames": [], "phases": [] }));
    let events = [
        stored(
            1,
            10,
            json!({ "type": "run-launched", "scriptPath": "/w/launch.js" }),
        ),
        stored(
            2,
            20,
            json!({ "type": "hole-filled", "scriptPath": "/w/minted.js" }),
        ),
        stored(
            3,
            30,
            json!({ "type": "hole-filled", "scriptPath": "/w/minted-2.js" }),
        ),
    ];
    let out = roster(&facts(Some(&s), &events, &[], &[], false));
    assert_eq!(out["scriptPath"], "/w/minted-2.js");
}

#[test]
fn a_log_message_of_astral_characters_is_bounded_by_utf16_units_not_characters() {
    // 1,100 emoji are 2,200 UTF-16 units: the bound keeps 1,024 whole characters (2,048 units), never a split pair.
    let s = state(json!({ "phaseNames": [], "phases": [] }));
    let long = "\u{1F600}".repeat(1_100);
    let events = [stored(1, 10, json!({ "type": "log", "message": long }))];
    let out = roster(&facts(Some(&s), &events, &[], &[], false));
    let message = out["logTail"][0]["message"].as_str().unwrap();
    assert_eq!(message.encode_utf16().count(), 2_048);
    assert_eq!(message.chars().count(), 1_024);
}

/// Node `pendingQuestionsOf`: a run another session holds live has its parked table in that session's memory, so this read
/// reports the questions as unknown and parks nobody, though the journal's projection names the question (DWL-02).
#[test]
fn a_run_live_in_another_session_has_unknown_questions_and_no_parked_subagent() {
    let s = state(json!({
        "phaseNames": [], "phases": [],
        "pendingQuestions": [{ "qid": "q-1", "actorSiteId": "agent", "actorOrdinal": 1, "askedAt": 900, "question": "which?" }],
        "nodes": [{ "siteId": "w", "ordinal": 1, "actorSiteId": "agent", "actorOrdinal": 1, "phase": "executing", "phaseName": "fetch" }]
    }));
    let actors = [actor("agent", 1, Some("poet"))];
    let rows = [ask("w", 1, ("agent", 1), 0, NodeStatus::Running)];
    let events = [stored(
        1,
        1_000,
        json!({ "type": "node-dispatched", "instance": { "siteId": "w", "ordinal": 1 } }),
    )];
    let mut elsewhere = facts(Some(&s), &events, &rows, &actors, false);
    elsewhere.questions_known = false;
    let out = roster(&elsewhere);
    let subs = out["subagents"].as_array().expect("subagents");
    assert_eq!(subs[0]["state"], "executing");
    assert!(subs[0].get("parkedOn").is_none());
    assert_eq!(out["health"]["pendingQuestionsKnown"], false);
}
