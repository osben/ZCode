//! Fork: `hookInvocation` rows and the blocked-prompt banner (specs/fork-rust-agent-parity.md HK-UP-01).

use rust_cli_kernel_api::hooks::{
    HookEventName, HookInvocation, HookInvocationRecord, HookRunOutcome, HookRunRecord,
    HookSourceKind,
};

use super::*;

/// HK-UP-01's two hooks: an async command (reported as it starts) and a process hook that blocks with stderr.
fn blocked_dispatch() -> HookInvocation {
    HookInvocation {
        id: "hookinv_1".into(),
        hook_event: HookEventName::UserPromptSubmit,
        tool_use: None,
        tool_name: None,
        runs: vec![
            HookRunRecord {
                run: "hookrun_1".into(),
                index: 0,
                outcome: HookRunOutcome::Success,
                block_reason: None,
                error_message: None,
                stderr_preview: None,
                stdout_preview: None,
                started_at_ms: 1000,
                duration_ms: 0,
                source_kind: HookSourceKind::User,
                plugin_name: None,
                display: "node /hooks/async-record.js".into(),
            },
            HookRunRecord {
                run: "hookrun_2".into(),
                index: 1,
                outcome: HookRunOutcome::Blocked,
                block_reason: Some("hooks_prompt_block".into()),
                error_message: Some("prompt blocked by the E2E hook".into()),
                stderr_preview: Some("prompt blocked by the E2E hook".into()),
                stdout_preview: None,
                started_at_ms: 1001,
                duration_ms: 40,
                source_kind: HookSourceKind::User,
                plugin_name: None,
                display: "node /hooks/block.js --mode prompt".into(),
            },
        ],
    }
}

fn last_error(deltas: &[Value]) -> Option<&Value> {
    deltas
        .iter()
        .rev()
        .filter(|delta| delta["op"] == "state.updated")
        .find_map(|delta| delta["patch"]["control"].get("lastError"))
}

fn blocked_turn(feed: &mut Feed) -> Vec<Value> {
    let turn = TurnId::new("turn_1");
    let mut deltas = feed.apply(KernelEvent::TurnStarted {
        turn: turn.clone(),
        command: Some(CommandId::new("c1")),
    });
    deltas.extend(feed.apply(KernelEvent::PromptBlocked {
        turn: turn.clone(),
        message: user("msg_u1", "E2E_HOOKS_PROMPT_BLOCK: blocked"),
    }));
    deltas.extend(feed.apply(KernelEvent::HookInvocation {
        turn: turn.clone(),
        invocation: blocked_dispatch(),
    }));
    deltas.extend(feed.apply(KernelEvent::TurnFinished {
        turn,
        outcome: TurnOutcome::Success,
        usage: None,
    }));
    deltas
}

/// The golden the fork Vitest parses with the App's `hookInvocationRowSchema` and `sessionErrorInfoSchema`.
fn golden() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/hook-invocation-blocked.json"
    ))
    .unwrap()
}

#[test]
fn a_blocked_prompt_shows_its_input_its_hook_row_and_the_banner() {
    let mut feed = Feed::new();
    let deltas = blocked_turn(&mut feed);
    let appended: Vec<&Value> = deltas
        .iter()
        .filter(|delta| delta["op"] == "row.appended")
        .map(|delta| &delta["row"])
        .collect();
    let input = appended
        .iter()
        .find(|row| row["kind"] == "userInput")
        .expect("the blocked input's row");
    assert_eq!(input["turnId"], "turn_1");
    assert_eq!(input["text"], "E2E_HOOKS_PROMPT_BLOCK: blocked");
    let hook = appended
        .iter()
        .find(|row| row["kind"] == "hookInvocation")
        .expect("the hook row");
    assert_eq!(hook["turnId"], "turn_1");
    let golden = golden();
    let mut row = (*hook).clone();
    for volatile in ["rowId", "createdAt", "createdAtSeq"] {
        row.as_object_mut().unwrap().remove(volatile);
    }
    assert_eq!(
        row,
        golden["row"],
        "{}",
        serde_json::to_string_pretty(&row).unwrap()
    );
    let mut error = last_error(&deltas).expect("the banner").clone();
    error.as_object_mut().unwrap().remove("at");
    assert_eq!(
        error,
        golden["lastError"],
        "{}",
        serde_json::to_string_pretty(&error).unwrap()
    );
    // The turn completed (Node `TurnComplete(success)`) and kept the banner.
    let snapshot = feed.projection.snapshot(feed.seq, "e");
    assert_eq!(snapshot["control"]["phase"], "completedSuccess");
    assert_eq!(
        snapshot["control"]["lastError"]["code"],
        "fault.runtime.hookBlocked"
    );
    let header = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "turnHeader")
        .unwrap();
    assert_eq!(header["state"], "completedSuccess");
}

#[test]
fn the_next_turn_clears_the_banner() {
    let mut feed = Feed::new();
    blocked_turn(&mut feed);
    let deltas = feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_2"),
        command: Some(CommandId::new("c2")),
    });
    assert_eq!(last_error(&deltas), Some(&Value::Null));
}

#[test]
fn an_allowed_dispatch_is_a_row_without_a_banner() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("c1")),
    });
    let mut dispatch = blocked_dispatch();
    dispatch.runs.truncate(1);
    let deltas = feed.apply(KernelEvent::HookInvocation {
        turn: TurnId::new("turn_1"),
        invocation: dispatch,
    });
    let row = deltas
        .iter()
        .find(|delta| delta["op"] == "row.appended")
        .map(|delta| &delta["row"])
        .expect("the hook row");
    assert_eq!(row["state"], "completed");
    assert_eq!(row["hookCount"], 1);
    assert_eq!(
        row["executions"][0]["displayName"],
        "node · async-record.js"
    );
    assert!(last_error(&deltas).is_none_or(Value::is_null));
}

/// Node `hookBlockErrorDelta`: a diagnostic equal to the block reason is not repeated, and the last block wins.
#[test]
fn the_banner_reads_the_last_blocked_run() {
    let mut dispatch = blocked_dispatch();
    let mut first = dispatch.runs[1].clone();
    first.index = 0;
    first.run = "hookrun_0".into();
    first.block_reason = Some("first reason".into());
    let mut last = dispatch.runs[1].clone();
    last.stderr_preview = Some("hooks_prompt_block".into());
    last.error_message = None;
    dispatch.runs = vec![first, last];
    let error = super::super::hook_rows::block_error(&dispatch, 7).unwrap();
    assert_eq!(error.message, "hooks_prompt_block");
    assert_eq!(
        error.detail.as_deref(),
        Some("Hook block reason: hooks_prompt_block")
    );
}

/// Other faults keep their shape: recoverable, no detail.
#[test]
fn a_failed_turn_keeps_the_recoverable_turn_fault() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("c1")),
    });
    let deltas = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Failed {
            message: "boom".into(),
            code: None,
        },
        usage: None,
    });
    let error = last_error(&deltas).unwrap();
    assert_eq!(error["recoverable"], true);
    assert_eq!(error["code"], "fault.turn.failed");
    assert!(error.get("detail").is_none());
    assert!(error.get("attribution").is_none());
}

/// Fork: a resubscribe rebuilds a stored turn's dispatch through its user message (HK-UP-01 Design 7): the row sits in
/// that turn, after its input's row, and the banner of a blocked run is not rebuilt cold.
#[test]
fn from_view_re_anchors_a_stored_turns_dispatch() {
    let mut cold = view(vec![
        user("msg_u1", "hello"),
        assistant("msg_a1", vec![ContentBlock::Text { text: "hi".into() }]),
    ]);
    cold.hook_invocations = vec![HookInvocationRecord {
        anchor_message: Some(MessageId::new("msg_u1")),
        invocation: blocked_dispatch(),
    }];
    let projection = Projection::from_view(&cold, Followup::Queue, Vec::new());
    let snapshot = projection.snapshot(0, "e");
    let rows = snapshot["rows"]["window"].as_array().unwrap();
    let input_at = rows
        .iter()
        .position(|row| row["kind"] == "userInput")
        .expect("the input's row");
    let hook_at = rows
        .iter()
        .position(|row| row["kind"] == "hookInvocation")
        .expect("the re-anchored hook row");
    assert!(hook_at > input_at);
    assert_eq!(rows[hook_at]["turnId"], rows[input_at]["turnId"]);
    assert_eq!(rows[hook_at]["entityId"], "hookinv_1");
    assert_eq!(rows[hook_at]["state"], "completed");
    assert_eq!(rows[hook_at]["executions"].as_array().unwrap().len(), 2);
    assert!(snapshot["control"]["lastError"].is_null());
}

/// A record whose turn stored no prompt (a blocked prompt, dropped with its turn) yields no row cold.
#[test]
fn from_view_drops_a_dispatch_without_a_stored_anchor() {
    let mut cold = view(vec![user("msg_u1", "hello")]);
    cold.hook_invocations = vec![HookInvocationRecord {
        anchor_message: Some(MessageId::new("msg_gone")),
        invocation: blocked_dispatch(),
    }];
    let projection = Projection::from_view(&cold, Followup::Queue, Vec::new());
    let snapshot = projection.snapshot(0, "e");
    assert!(
        snapshot["rows"]["window"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["kind"] != "hookInvocation")
    );
}

/// Fork: a SessionStart dispatch that waited for its turn (HK-UP-01, Node's pending SessionStart rows) is reported
/// when that turn starts, so cold places its row before the turn's input row, where the live flush appended it.
#[test]
fn from_view_places_a_waiting_session_start_dispatch_before_its_turns_input() {
    let mut cold = view(vec![
        user("msg_u1", "hello"),
        assistant("msg_a1", vec![ContentBlock::Text { text: "hi".into() }]),
    ]);
    let mut dispatch = blocked_dispatch();
    dispatch.hook_event = HookEventName::SessionStart;
    cold.hook_invocations = vec![HookInvocationRecord {
        anchor_message: Some(MessageId::new("msg_u1")),
        invocation: dispatch,
    }];
    let projection = Projection::from_view(&cold, Followup::Queue, Vec::new());
    let snapshot = projection.snapshot(0, "e");
    let rows = snapshot["rows"]["window"].as_array().unwrap();
    let input_at = rows
        .iter()
        .position(|row| row["kind"] == "userInput")
        .expect("the input's row");
    let hook_at = rows
        .iter()
        .position(|row| row["kind"] == "hookInvocation")
        .expect("the waiting hook row");
    assert!(hook_at < input_at, "rows: {rows:?}");
    assert_eq!(rows[hook_at]["turnId"], rows[input_at]["turnId"]);
    assert_eq!(rows[hook_at]["hookEventName"], "SessionStart");
}

/// The live flush position: a SessionStart dispatch arriving right after a turn started lands inside that turn.
#[test]
fn a_session_start_dispatch_flushes_into_the_turn_that_started() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("c1")),
    });
    let mut dispatch = blocked_dispatch();
    dispatch.hook_event = HookEventName::SessionStart;
    let deltas = feed.apply(KernelEvent::HookInvocation {
        turn: TurnId::new("turn_1"),
        invocation: dispatch,
    });
    let row = deltas
        .iter()
        .find(|delta| delta["op"] == "row.appended")
        .map(|delta| &delta["row"])
        .expect("the hook row");
    assert_eq!(row["turnId"], "turn_1");
    assert_eq!(row["hookEventName"], "SessionStart");
    assert!(last_error(&deltas).is_none_or(Value::is_null));
}
