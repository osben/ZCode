//! `session/subagents` tests: the projection and pagination as pure functions (Node
//! `subagent-session-query.ts` parity), then the handler's params and session-unavailable
//! paths on the test server. The store documents come from the `StoreQueries` port; the
//! in-memory store answers the parent lookup (missing -> Node's error) and empty rows.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{AgentId, EnvironmentId, MachineName, SessionId, TraceId};
use rust_cli_kernel_api::panels::{SubagentEntry, SubagentStatus};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{CreateSession, Kernel, KernelError, SessionHandle};
use rust_cli_kernel_api::store::{
    SessionFilter, SessionKind, SessionMeta, SessionStore, SessionSummary, StoreQueries,
};
use rust_cli_kernel_api::testing::{FixedClock, MemoryStore, selection};
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::json;

use super::*;
use crate::context::Context;
use crate::server::Defaults;

fn part(tool: &str, status: &str) -> PartRow {
    PartRow {
        tool: tool.to_owned(),
        status: status.to_owned(),
        ..Default::default()
    }
}

fn child(id: &str) -> ChildRow {
    ChildRow {
        id: id.to_owned(),
        task_type: "subagent_child".to_owned(),
        time_updated: 5_000,
        last_assistant: None,
    }
}

fn entry(
    status: SubagentStatus,
    child: &str,
    background: bool,
    waiting: bool,
    elapsed_ms: u64,
    ended_ago_ms: Option<u64>,
) -> SubagentEntry {
    SubagentEntry {
        agent: AgentId::new("agent_x"),
        child: SessionId::new(child),
        agent_type: "Explore".to_owned(),
        description: "scan the repo".to_owned(),
        status,
        background,
        waiting,
        elapsed_ms,
        ended_ago_ms,
        version: 3,
        owner: None,
        activity: None,
        parked: false,
        machine: MachineName::primary(),
    }
}

/// A settled foreground Agent part, the common shape every classification test starts from.
fn base_candidate() -> Candidate {
    candidate_from_part(&PartRow {
        call_id: "toolu_1".to_owned(),
        tool: "Agent".to_owned(),
        status: "completed".to_owned(),
        metadata: json!({"childSessionId": "sess_c1", "agentId": "agent_1"}),
        ..Default::default()
    })
    .unwrap()
}

/// Node `candidateFromToolPart`: the output object wins, the launch ACK recovers the agent, the
/// metadata carries what the runtime linked, and every display field falls back through input
/// and metadata. A non-subagent tool or a part without any child id is never a candidate, and a
/// later part for the same child replaces the earlier candidate in place.
#[test]
fn candidates_follow_node_s_fallback_chains() {
    let output = json!({
        "agentId": "agent_1",
        "childSessionId": "sess_c1",
        "description": "scan the tree",
        "agentType": "Explore",
        "result": "found 3 files",
    })
    .to_string();
    let from_output = candidate_from_part(&PartRow {
        call_id: "toolu_1".to_owned(),
        tool: "Agent".to_owned(),
        status: "completed".to_owned(),
        input: json!({"description": "input desc", "prompt": "look", "subagent_type": "general"}),
        output: Some(output),
        metadata: json!({"agentId": "agent_meta"}),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(from_output.agent_id, "agent_1");
    assert_eq!(from_output.child_session_id, "sess_c1");
    assert_eq!(from_output.title, "scan the tree");
    assert_eq!(from_output.subagent_type, "Explore");
    assert_eq!(from_output.summary.as_deref(), Some("found 3 files"));

    // A background launch ACK as the output: the agentId line recovers the agent and the child
    // falls back to the runtime's spawn id.
    let acknowledged = candidate_from_part(&PartRow {
        tool: "Agent".to_owned(),
        status: "completed".to_owned(),
        input: json!({"description": "bg", "agent": "Explore"}),
        output: Some("Task started in background\nagentId: agent_7 (background)\n".to_owned()),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(acknowledged.agent_id, "agent_7");
    assert_eq!(acknowledged.child_session_id, "sess_subagent_agent_7");
    assert_eq!(acknowledged.title, "bg");
    assert_eq!(acknowledged.subagent_type, "Explore");
    // Node reads `run_in_background` from the input only; the ACK text does not set it.
    assert!(!acknowledged.run_in_background);

    // Only the output text of a settled part is parsed.
    let pending = candidate_from_part(&PartRow {
        tool: "Agent".to_owned(),
        status: "pending".to_owned(),
        output: Some(json!({"childSessionId": "ignored"}).to_string()),
        metadata: json!({"childSessionId": "sess_c9"}),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(pending.child_session_id, "sess_c9");

    assert!(candidate_from_part(&part("Bash", "completed")).is_none());
    assert!(candidate_from_part(&part("Agent", "completed")).is_none());

    // Map semantics: same child id -> the later part replaces the value, keeps the position.
    let candidates = collect_candidates(&[
        PartRow {
            call_id: "toolu_1".to_owned(),
            tool: "Agent".to_owned(),
            status: "completed".to_owned(),
            metadata: json!({"childSessionId": "sess_c1", "agentId": "agent_1"}),
            ..Default::default()
        },
        PartRow {
            tool: "subagent".to_owned(),
            status: "completed".to_owned(),
            metadata: json!({"childSessionId": "sess_c2"}),
            ..Default::default()
        },
        PartRow {
            call_id: "toolu_3".to_owned(),
            tool: "Task".to_owned(),
            status: "completed".to_owned(),
            metadata: json!({"childSessionId": "sess_c1", "agentId": "agent_new"}),
            ..Default::default()
        },
    ]);
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0].child_session_id, "sess_c1");
    assert_eq!(candidates[0].agent_id, "agent_new");
    assert_eq!(candidates[0].call_id, "toolu_3");
    assert_eq!(candidates[1].child_session_id, "sess_c2");
}

/// Node `parseParams` through the zod schema: trimmed non-empty strings, an integer limit in
/// 1..=100 with 20 as the default, and `-32602` for anything else (including unknown keys).
#[test]
fn parse_params_validates_the_zod_schema() {
    let ok = |params: Value| parse_params(&params).unwrap();
    assert_eq!(
        ok(json!({"sessionId": " s1 "})),
        ("s1".to_owned(), None, 20)
    );
    assert_eq!(
        ok(json!({"sessionId": "s1", "endedCursor": " c "})),
        ("s1".to_owned(), Some("c".to_owned()), 20)
    );
    assert_eq!(
        ok(json!({"sessionId": "s1", "endedLimit": 100})),
        ("s1".to_owned(), None, 100)
    );
    // JS Number.isInteger accepts integral floats.
    assert_eq!(
        ok(json!({"sessionId": "s1", "endedLimit": 20.0})),
        ("s1".to_owned(), None, 20)
    );

    let err = |params: Value| parse_params(&params).unwrap_err();
    for params in [
        json!({}),
        json!({"sessionId": ""}),
        json!({"sessionId": "   "}),
        json!({"sessionId": 5}),
        json!({"sessionId": "s1", "endedCursor": ""}),
        json!({"sessionId": "s1", "endedCursor": null}),
        json!({"sessionId": "s1", "endedCursor": 3}),
        json!({"sessionId": "s1", "endedLimit": 0}),
        json!({"sessionId": "s1", "endedLimit": 101}),
        json!({"sessionId": "s1", "endedLimit": 1.5}),
        json!({"sessionId": "s1", "endedLimit": "20"}),
        json!({"sessionId": "s1", "unknown": 1}),
    ] {
        assert_eq!(err(params).code, -32602, "params must be rejected");
    }
}

/// Node `runningStatus`: the live entry decides first (waiting splits into blocked for
/// background and waiting for foreground), then the recoverable background input, then a
/// pending part on a live parent. A cold parent with a pending part is not running.
#[test]
fn running_status_follows_node_s_precedence() {
    let candidate = base_candidate();
    let outcome = Outcome::default();
    let running = entry(SubagentStatus::Running, "sess_c1", false, false, 100, None);
    let waiting = entry(SubagentStatus::Running, "sess_c1", false, true, 100, None);
    let blocked = entry(SubagentStatus::Running, "sess_c1", true, true, 100, None);

    assert_eq!(
        running_status(
            &candidate,
            Some(&LiveChild::of(&running, 1_000)),
            true,
            &outcome
        ),
        Some("running")
    );
    assert_eq!(
        running_status(
            &candidate,
            Some(&LiveChild::of(&waiting, 1_000)),
            true,
            &outcome
        ),
        Some("waiting")
    );
    assert_eq!(
        running_status(
            &candidate,
            Some(&LiveChild::of(&blocked, 1_000)),
            true,
            &outcome
        ),
        Some("blocked")
    );

    // A live-but-finished entry no longer marks the input running.
    let finished = entry(
        SubagentStatus::Completed,
        "sess_c1",
        false,
        false,
        100,
        Some(50),
    );
    assert_eq!(
        running_status(
            &candidate,
            Some(&LiveChild::of(&finished, 1_000)),
            true,
            &outcome
        ),
        None
    );

    // The background input itself is a recoverable running fact until something terminal.
    let mut background = base_candidate();
    background.run_in_background = true;
    assert_eq!(
        running_status(&background, None, false, &outcome),
        Some("running")
    );
    let terminal = Outcome {
        status: Some("success"),
        ..Default::default()
    };
    assert_eq!(running_status(&background, None, false, &terminal), None);

    let mut pending = base_candidate();
    pending.part_status = "pending".to_owned();
    assert_eq!(
        running_status(&pending, None, true, &outcome),
        Some("running")
    );
    assert_eq!(running_status(&pending, None, false, &outcome), None);
}

/// Node `endedStatus` and `lastChildOutcome`: the live terminal status wins, then the part
/// error, then the output status field, then the part state, and the child's own outcome
/// decides the async-launched and unknown cases.
#[test]
fn ended_status_and_the_child_outcome_follow_node() {
    let candidate = base_candidate();
    let outcome = Outcome::default();

    let live = |status: SubagentStatus| {
        LiveChild::of(
            &entry(status, "sess_c1", false, false, 100, Some(50)),
            1_000,
        )
    };
    assert_eq!(
        ended_status(&candidate, Some(&live(SubagentStatus::Completed)), &outcome),
        "success"
    );
    assert_eq!(
        ended_status(&candidate, Some(&live(SubagentStatus::Failed)), &outcome),
        "failed"
    );
    assert_eq!(
        ended_status(&candidate, Some(&live(SubagentStatus::Killed)), &outcome),
        "cancelled"
    );

    let mut errored = base_candidate();
    errored.part_status = "error".to_owned();
    errored.error = Some("Request was aborted by the user".to_owned());
    assert_eq!(ended_status(&errored, None, &outcome), "cancelled");
    errored.error = Some("model connection failed".to_owned());
    assert_eq!(ended_status(&errored, None, &outcome), "failed");

    let mut launched = base_candidate();
    launched.output = Some(
        json!({"agentId": "agent_1", "childSessionId": "sess_c1", "status": "async_launched"})
            .as_object()
            .cloned()
            .unwrap(),
    );
    let success = Outcome {
        status: Some("success"),
        ..Default::default()
    };
    assert_eq!(ended_status(&launched, None, &success), "success");
    assert_eq!(ended_status(&launched, None, &outcome), "lost");

    let mut stopped = base_candidate();
    stopped.output = Some(json!({"status": "stopped"}).as_object().cloned().unwrap());
    assert_eq!(ended_status(&stopped, None, &outcome), "cancelled");

    assert_eq!(ended_status(&candidate, None, &outcome), "success");
    let mut pending = base_candidate();
    pending.part_status = "pending".to_owned();
    assert_eq!(ended_status(&pending, None, &outcome), "lost");

    // The child's last assistant: no error and no tool part with a completion is a success; an
    // error is cancelled or failed by its name; a tool part means it is not terminal.
    let answered = LastAssistant {
        completed_at: Some(900),
        finish: Some("stop".to_owned()),
        text: Some("done".to_owned()),
        has_tool_part: false,
        ..Default::default()
    };
    let outcome = last_child_outcome(Some(&answered));
    assert_eq!(outcome.status, Some("success"));
    assert_eq!(outcome.ended_at, Some(900));
    assert_eq!(outcome.summary.as_deref(), Some("done"));

    let mut tooling = answered;
    tooling.has_tool_part = true;
    assert_eq!(last_child_outcome(Some(&tooling)).status, None);

    let aborted = LastAssistant {
        completed_at: Some(900),
        error: Some(json!({"name": "AbortError", "data": {"message": "user stopped it"}})),
        ..Default::default()
    };
    let outcome = last_child_outcome(Some(&aborted));
    assert_eq!(outcome.status, Some("cancelled"));
    assert_eq!(outcome.summary.as_deref(), Some("user stopped it"));

    let failed = LastAssistant {
        error: Some(json!({"name": "ApiError"})),
        ..Default::default()
    };
    let outcome = last_child_outcome(Some(&failed));
    assert_eq!(outcome.status, Some("failed"));
    assert_eq!(outcome.summary.as_deref(), Some("ApiError"));

    // A stream-recovery discard is not terminal: the child resends from the anchor.
    let discarded = LastAssistant {
        error: Some(json!({"name": "StreamRecoveryDiscarded"})),
        ..Default::default()
    };
    assert_eq!(last_child_outcome(Some(&discarded)).status, None);

    assert_eq!(last_child_outcome(None).status, None);
}

/// The live table's counters recover the registry timestamps Node keeps: started is now minus
/// the elapsed time, ended is now minus the ended-ago time.
#[test]
fn live_children_recover_timestamps_from_the_counters() {
    let running = LiveChild::of(
        &entry(SubagentStatus::Running, "sess_c1", false, false, 300, None),
        1_000,
    );
    assert_eq!(running.started_at, Some(700));
    assert_eq!(running.ended_at, None);
    assert!(running.running);
    assert_eq!(running.terminal, None);

    let done = LiveChild::of(
        &entry(
            SubagentStatus::Completed,
            "sess_c1",
            false,
            false,
            400,
            Some(200),
        ),
        1_000,
    );
    assert_eq!(done.started_at, Some(600));
    assert_eq!(done.ended_at, Some(800));
    assert_eq!(done.terminal, Some("success"));
}

/// The whole projection: candidates only survive with a `subagent_child` row, the live table
/// seeds a candidate for a just-spawned subagent, running and ended split by the status rules,
/// optional fields are omitted when empty, and both lists sort newest-first (then id
/// descending on ties).
#[test]
fn the_projection_splits_running_and_ended_like_node() {
    let parts = vec![
        PartRow {
            call_id: "toolu_1".to_owned(),
            tool: "Agent".to_owned(),
            status: "completed".to_owned(),
            metadata: json!({"childSessionId": "sess_c1", "agentId": "agent_1", "agentType": "Explore"}),
            started_at: Some(100),
            ended_at: Some(200),
            ..Default::default()
        },
        PartRow {
            call_id: "toolu_2".to_owned(),
            tool: "Agent".to_owned(),
            status: "pending".to_owned(),
            metadata: json!({"childSessionId": "sess_c2", "agentId": "agent_2"}),
            ..Default::default()
        },
        PartRow {
            call_id: "toolu_3".to_owned(),
            tool: "Agent".to_owned(),
            status: "completed".to_owned(),
            metadata: json!({"childSessionId": "sess_c4"}),
            ..Default::default()
        },
        PartRow {
            tool: "Agent".to_owned(),
            status: "completed".to_owned(),
            metadata: json!({"childSessionId": "sess_fork"}),
            ..Default::default()
        },
    ];
    let answered = LastAssistant {
        completed_at: Some(900),
        finish: Some("stop".to_owned()),
        text: Some("done".to_owned()),
        has_tool_part: false,
        ..Default::default()
    };
    let children = vec![
        ChildRow {
            last_assistant: Some(answered),
            ..child("sess_c1")
        },
        child("sess_c2"),
        child("sess_c3"),
        child("sess_c4"),
        ChildRow {
            id: "sess_fork".to_owned(),
            task_type: "fork".to_owned(),
            time_updated: 1,
            last_assistant: None,
        },
    ];
    let live = vec![entry(
        SubagentStatus::Running,
        "sess_c3",
        false,
        false,
        300,
        None,
    )];

    let projection = project(ProjectionInput {
        parts: &parts,
        children: &children,
        live: &live,
        parent_live: true,
        now_ms: 1_000,
    });

    // The fork's copied parts point at a non-child row: dropped; the live subagent seeds a
    // candidate at the end.
    assert_eq!(
        projection.child_session_ids,
        ["sess_c1", "sess_c2", "sess_c4", "sess_c3"]
    );

    assert_eq!(projection.running.len(), 2);
    assert_eq!(projection.running[0]["childSessionId"], "sess_c3");
    assert_eq!(projection.running[0]["agentId"], "agent_x");
    assert_eq!(projection.running[0]["subagentType"], "Explore");
    assert_eq!(projection.running[0]["title"], "scan the repo");
    assert_eq!(projection.running[0]["startedAt"], 700);
    // A synthetic candidate has no part, so no toolCallId and no agentId-less omission test here.
    assert!(projection.running[0].get("toolCallId").is_none());
    assert_eq!(projection.running[1]["childSessionId"], "sess_c2");
    assert_eq!(projection.running[1]["toolCallId"], "toolu_2");
    assert_eq!(projection.running[1]["status"], "running");
    // The pending part has no state time and no live entry: startedAt stays absent.
    assert!(projection.running[1].get("startedAt").is_none());

    assert_eq!(projection.ended.len(), 2);
    assert_eq!(projection.ended[0].child_session_id, "sess_c4");
    assert_eq!(projection.ended[0].value["endedAt"], 5_000);
    assert_eq!(projection.ended[0].value["status"], "success");
    assert_eq!(projection.ended[1].child_session_id, "sess_c1");
    // The part's settled end time outranks the child's completion time (Node's chain).
    assert_eq!(projection.ended[1].value["endedAt"], 200);
    assert_eq!(projection.ended[1].value["summary"], "done");
    assert_eq!(projection.ended[1].value["startedAt"], 100);
    assert_eq!(projection.ended[1].value["agentId"], "agent_1");
}

/// Node `paginateEndedSubagents`: the cursor is the last returned item, the next page starts at
/// the first item sorting strictly before it (id descending breaks ties), a malformed cursor
/// restarts from the top, and a cursor past everything yields an empty page.
#[test]
fn pagination_round_trips_the_cursors() {
    let item = |id: &str, ended_at: u64| EndedItem {
        child_session_id: id.to_owned(),
        ended_at,
        value: json!({"childSessionId": id, "endedAt": ended_at}),
    };
    // Sorted as the projection leaves it: newest first, id descending on ties.
    let ended = vec![
        item("sess_z", 300),
        item("sess_a", 300),
        item("sess_b", 100),
    ];

    let (page, next) = paginate_ended(&ended, &None, 2);
    assert_eq!(page.len(), 2);
    assert_eq!(page[0]["childSessionId"], "sess_z");
    assert_eq!(page[1]["childSessionId"], "sess_a");
    let next = next.unwrap();
    assert_eq!(
        decode_cursor(Some(&next)),
        Some(("sess_a".to_owned(), 300.0))
    );

    // The tie moves past sess_a to sess_b.
    let (page, next) = paginate_ended(&ended, &Some(next), 2);
    assert_eq!(page.len(), 1);
    assert_eq!(page[0]["childSessionId"], "sess_b");
    assert!(next.is_none());

    // A limit covering everything returns no cursor.
    let (page, next) = paginate_ended(&ended, &None, 10);
    assert_eq!(page.len(), 3);
    assert!(next.is_none());

    // A malformed cursor restarts from the top, like Node's null decode.
    let (page, _) = paginate_ended(&ended, &Some("not-a-cursor".to_owned()), 2);
    assert_eq!(page.len(), 2);

    // A cursor older than everything: no item sorts before it, so the page is empty.
    let bottom = encode_cursor("sess_a", 0);
    let (page, next) = paginate_ended(&ended, &Some(bottom), 2);
    assert!(page.is_empty());
    assert!(next.is_none());

    // A cursor newer than everything behaves like the first page.
    let top = encode_cursor("sess_zzz", 999);
    let (page, _) = paginate_ended(&ended, &Some(top), 2);
    assert_eq!(page.len(), 2);
}

/// The kernel double: only the query port is used (the handler never opens a session here).
struct QueriesKernel {
    store: Arc<MemoryStore>,
}

#[async_trait]
impl Kernel for QueriesKernel {
    fn queries(&self) -> Arc<dyn StoreQueries> {
        self.store.clone()
    }

    async fn create_session(&self, _request: CreateSession) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "create".to_owned(),
        })
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Err(KernelError::Unsupported {
            what: "open".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }

    async fn delete_session(&self, _session: &SessionId) -> Result<(), KernelError> {
        Ok(())
    }
}

fn meta(id: &str) -> SessionMeta {
    SessionMeta {
        id: SessionId::new(id),
        kind: SessionKind::Interactive,
        parent: None,
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/w"),
        },
        title: String::new(),
        trace: TraceId::new("trace"),
        created_at_ms: 1000,
    }
}

/// Builds the server like the other fork handler tests; the scope must outlive the test.
fn server(store: Arc<MemoryStore>) -> (TaskScope, Arc<Server>) {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let kernel = Arc::new(QueriesKernel { store });
    let server = Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    (scope, server)
}

/// An unknown parent answers Node's session-unavailable error; a stored cold parent answers
/// the empty document with the parent row's updated time as the revision; invalid params
/// answer `-32602`.
#[tokio::test]
async fn the_handler_validates_params_and_answers_the_cold_document() {
    let store = Arc::new(MemoryStore::default());
    let (_scope, server) = server(store.clone());

    let error = subagents(&server, &json!({"sessionId": "s1"}))
        .await
        .unwrap_err();
    assert_eq!(error.code, SESSION_UNAVAILABLE);
    assert_eq!(error.message, "Session not found: s1");

    let error = subagents(&server, &json!({})).await.unwrap_err();
    assert_eq!(error.code, -32602);

    store.create(meta("s2")).await.unwrap();
    let result = subagents(&server, &json!({"sessionId": "s2"}))
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({
            "revision": 1000,
            "childSessionIds": [],
            "running": [],
            "ended": {"total": 0, "items": []},
        })
    );
}
