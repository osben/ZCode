//! dwf_* 的跨运行时 golden（W2，specs/fork-rust-workflow-engine.md §5.1、§8）。
//!
//! 同一份场景（`fixtures/dwf/scenario.json`）由两边分别写入：
//! - `node-written.sqlite` 与 `node-expected.json` 由 Node 生成（`scripts/rust-cli/dwf-journal-goldens.ts`，
//!   Node 的仓储写库，Node 的读取给出期望值）。本文件方向一：Rust 读 Node 写的库，逐项与期望比对。
//! - `rust-written.sqlite` 由本文件的 `#[ignore]` 测试（`regenerate_rust_written_golden`）用 Rust 仓储写出。
//!   Node 侧的 `apps/zcode-cli/packages/adapters/tests/dwf-rust-goldens.test.ts` 方向二读它，与同一份期望比对。
//!
//! 时间列不比对（墙上时钟）；期望值里的事件只带 sequence 与 event。
use super::*;
use serde_json::{Map, Value, json};
use std::time::Duration;

const SCENARIO: &str = include_str!("../../../fixtures/dwf/scenario.json");
const NODE_EXPECTED: &str = include_str!("../../../fixtures/dwf/node-expected.json");
const NODE_WRITTEN: &str = "fixtures/dwf/node-written.sqlite";
const RUST_WRITTEN: &str = "fixtures/dwf/rust-written.sqlite";

fn manifest(relative: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn int(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(Value::as_i64)
}

/// Node `undefined`-or-value: a JSON `null` in the scenario is an explicit value (not absent), mirroring `encodeResultJson`.
fn present(v: &Value, key: &str) -> Option<Value> {
    v.get(key).cloned()
}

fn run_status(name: &str) -> RunStatus {
    match name {
        "pending" => RunStatus::Pending,
        "running" => RunStatus::Running,
        "completed" => RunStatus::Completed,
        "errored" => RunStatus::Errored,
        "stopped" => RunStatus::Stopped,
        other => panic!("scenario status {other}"),
    }
}

fn stop_reason(name: &str) -> StopReason {
    match name {
        "user" => StopReason::User,
        "model" => StopReason::Model,
        "provider" => StopReason::Provider,
        "interrupted" => StopReason::Interrupted,
        "superseded" => StopReason::Superseded,
        other => panic!("scenario stop reason {other}"),
    }
}

fn node_kind(name: &str) -> NodeKind {
    match name {
        "ask" => NodeKind::Ask,
        "world-read" => NodeKind::WorldRead,
        "world-run" => NodeKind::WorldRun,
        "report" => NodeKind::Report,
        "artifact" => NodeKind::Artifact,
        other => panic!("scenario kind {other}"),
    }
}

fn node_status(name: &str) -> NodeStatus {
    match name {
        "running" => NodeStatus::Running,
        "completed" => NodeStatus::Completed,
        "failed" => NodeStatus::Failed,
        other => panic!("scenario node status {other}"),
    }
}

fn settlement_of(v: &Value) -> Settlement {
    Settlement {
        stop_reason: text(v, "stopReason").map(|s| stop_reason(&s)),
        superseded_by: text(v, "supersededBy"),
        failure: present(v, "failure"),
        result: present(v, "result"),
    }
}

fn run_from(v: &Value) -> RunRecord {
    RunRecord {
        run_id: text(v, "runId").unwrap(),
        parent_session_id: text(v, "parentSessionId"),
        cwd: text(v, "cwd"),
        name: text(v, "name"),
        tool_call_id: text(v, "toolCallId"),
        script_text: text(v, "scriptText"),
        script_hash: text(v, "scriptHash"),
        args: present(v, "args"),
        resumed_from: text(v, "resumedFrom"),
        max_concurrency: v
            .get("caps")
            .and_then(|c| int(c, "maxConcurrency"))
            .unwrap_or(1),
        spent_tokens: int(v, "spentTokens").unwrap_or(0),
        status: run_status(&text(v, "status").unwrap()),
        stop_reason: text(v, "stopReason").map(|s| stop_reason(&s)),
        superseded_by: text(v, "supersededBy"),
        failure: present(v, "failure"),
        result: present(v, "result"),
    }
}

fn actor_from(v: &Value) -> ActorRecord {
    ActorRecord {
        run_id: text(v, "runId").unwrap(),
        site_id: text(v, "siteId").unwrap(),
        ordinal: int(v, "ordinal").unwrap(),
        name: text(v, "name"),
        persona: present(v, "persona"),
        session_id: text(v, "sessionId"),
        resolved_model: text(v, "resolvedModel"),
    }
}

fn node_from(v: &Value) -> NodeRecord {
    NodeRecord {
        run_id: text(v, "runId").unwrap(),
        site_id: text(v, "siteId").unwrap(),
        ordinal: int(v, "ordinal").unwrap(),
        kind: node_kind(&text(v, "kind").unwrap()),
        actor_site_id: text(v, "actorSiteId"),
        actor_ordinal: int(v, "actorOrdinal"),
        actor_seq: int(v, "actorSeq"),
        input_hash: text(v, "inputHash").unwrap(),
        status: node_status(&text(v, "status").unwrap()),
        result: present(v, "result"),
        error: present(v, "error"),
        stats: present(v, "stats"),
        artifact_id: text(v, "artifactId"),
        input: present(v, "input"),
        message_boundary: int(v, "messageBoundary"),
    }
}

/// A private copy of a fixture, taken with `VACUUM INTO` from a read-only handle so the fixture is never
/// written. The returned directory must outlive the path.
fn copy_of(fixture: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("copy.sqlite");
    let source = Connection::open_with_flags(
        manifest(fixture),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    source
        .execute("vacuum into ?1", [path.to_str().unwrap()])
        .unwrap();
    (dir, path)
}

/// Applies the shared scenario through the Rust repository, in order.
fn apply_scenario(conn: &Connection) {
    let scenario: Value = serde_json::from_str(SCENARIO).unwrap();
    for op in scenario["ops"].as_array().unwrap() {
        let now = int(op, "now").unwrap_or(0);
        match op["op"].as_str().unwrap() {
            "createSession" => {
                let input = &op["input"];
                conn.execute(
                    "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
                     values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rusqlite::params![
                        text(input, "id").unwrap(),
                        text(input, "projectID").unwrap(),
                        text(input, "parentID"),
                        text(input, "slug").unwrap(),
                        text(input, "directory").unwrap(),
                        text(input, "title").unwrap(),
                        text(input, "version").unwrap(),
                        now,
                        now,
                    ],
                )
                .unwrap();
            }
            "createRun" => create_run(conn, &run_from(&op["record"]), now).unwrap(),
            "updateRunStatus" => {
                let settlement = op.get("settlement").map(settlement_of);
                update_run_status(
                    conn,
                    op["runId"].as_str().unwrap(),
                    run_status(op["status"].as_str().unwrap()),
                    settlement.as_ref(),
                    now,
                )
                .unwrap();
            }
            "updateRunUsage" => {
                update_run_usage(
                    conn,
                    op["runId"].as_str().unwrap(),
                    int(op, "spentTokens").unwrap(),
                    now,
                )
                .unwrap();
            }
            "updateRunCaps" => {
                let max = int(&op["caps"], "maxConcurrency").unwrap();
                update_run_caps(conn, op["runId"].as_str().unwrap(), max, now).unwrap();
            }
            "updateRunScript" => update_run_script(
                conn,
                op["runId"].as_str().unwrap(),
                op["scriptText"].as_str().unwrap(),
                op["scriptHash"].as_str().unwrap(),
                now,
            )
            .unwrap(),
            "putActor" => put_actor(conn, &actor_from(&op["record"]), now).unwrap(),
            "putNode" => put_node(conn, &node_from(&op["record"]), now).unwrap(),
            "appendEvent" => {
                append_event(conn, op["runId"].as_str().unwrap(), &op["event"], now).unwrap();
            }
            "workflowActorLink" => insert_workflow_actor_link(
                conn,
                &WorkflowActorLink {
                    id: op["id"].as_str().unwrap(),
                    child_session_id: op["childSessionId"].as_str().unwrap(),
                    parent_session_id: op["parentSessionId"].as_str(),
                    path: op["path"].as_str().unwrap(),
                    status: op["status"].as_str().unwrap(),
                },
                now,
            )
            .unwrap(),
            other => panic!("scenario op {other}"),
        }
    }
}

// ---- Record → Node JSON (the shape Node's readers return; absent keys, not nulls, for unset optionals).

fn put_some(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value);
    }
}

fn run_json(r: &RunRecord) -> Value {
    let (status, stop_reason) = match r.status {
        RunStatus::Stopped => ("stopped", r.stop_reason),
        other => (
            match other {
                RunStatus::Pending => "pending",
                RunStatus::Running => "running",
                RunStatus::Completed => "completed",
                RunStatus::Errored => "errored",
                RunStatus::Stopped => unreachable!(),
            },
            None,
        ),
    };
    let mut m = Map::new();
    m.insert("runId".into(), json!(r.run_id));
    m.insert(
        "caps".into(),
        json!({ "maxConcurrency": r.max_concurrency }),
    );
    m.insert("spentTokens".into(), json!(r.spent_tokens));
    m.insert("status".into(), json!(status));
    put_some(
        &mut m,
        "stopReason",
        stop_reason.map(stop_reason_name).map(|s| json!(s)),
    );
    put_some(
        &mut m,
        "supersededBy",
        r.superseded_by.as_ref().map(|s| json!(s)),
    );
    put_some(
        &mut m,
        "parentSessionId",
        r.parent_session_id.as_ref().map(|s| json!(s)),
    );
    put_some(&mut m, "cwd", r.cwd.as_ref().map(|s| json!(s)));
    put_some(&mut m, "name", r.name.as_ref().map(|s| json!(s)));
    put_some(
        &mut m,
        "toolCallId",
        r.tool_call_id.as_ref().map(|s| json!(s)),
    );
    put_some(
        &mut m,
        "scriptText",
        r.script_text.as_ref().map(|s| json!(s)),
    );
    put_some(
        &mut m,
        "scriptHash",
        r.script_hash.as_ref().map(|s| json!(s)),
    );
    put_some(&mut m, "args", r.args.clone());
    put_some(
        &mut m,
        "resumedFrom",
        r.resumed_from.as_ref().map(|s| json!(s)),
    );
    put_some(&mut m, "failure", r.failure.clone());
    put_some(&mut m, "result", r.result.clone());
    Value::Object(m)
}

fn stop_reason_name(reason: StopReason) -> &'static str {
    match reason {
        StopReason::User => "user",
        StopReason::Model => "model",
        StopReason::Provider => "provider",
        StopReason::Interrupted => "interrupted",
        StopReason::Superseded => "superseded",
    }
}

fn actor_json(a: &ActorRecord) -> Value {
    let mut m = Map::new();
    m.insert("runId".into(), json!(a.run_id));
    m.insert("siteId".into(), json!(a.site_id));
    m.insert("ordinal".into(), json!(a.ordinal));
    put_some(&mut m, "name", a.name.as_ref().map(|s| json!(s)));
    put_some(&mut m, "persona", a.persona.clone());
    put_some(&mut m, "sessionId", a.session_id.as_ref().map(|s| json!(s)));
    put_some(
        &mut m,
        "resolvedModel",
        a.resolved_model.as_ref().map(|s| json!(s)),
    );
    Value::Object(m)
}

fn node_json(n: &NodeRecord) -> Value {
    let kind = match n.kind {
        NodeKind::Ask => "ask",
        NodeKind::WorldRead => "world-read",
        NodeKind::WorldRun => "world-run",
        NodeKind::Report => "report",
        NodeKind::Artifact => "artifact",
    };
    let status = match n.status {
        NodeStatus::Running => "running",
        NodeStatus::Completed => "completed",
        NodeStatus::Failed => "failed",
    };
    let mut m = Map::new();
    m.insert("runId".into(), json!(n.run_id));
    m.insert("siteId".into(), json!(n.site_id));
    m.insert("ordinal".into(), json!(n.ordinal));
    m.insert("kind".into(), json!(kind));
    m.insert("inputHash".into(), json!(n.input_hash));
    m.insert("status".into(), json!(status));
    put_some(
        &mut m,
        "actorSiteId",
        n.actor_site_id.as_ref().map(|s| json!(s)),
    );
    put_some(&mut m, "actorOrdinal", n.actor_ordinal.map(|v| json!(v)));
    put_some(&mut m, "actorSeq", n.actor_seq.map(|v| json!(v)));
    put_some(&mut m, "result", n.result.clone());
    put_some(&mut m, "error", n.error.clone());
    put_some(&mut m, "stats", n.stats.clone());
    put_some(
        &mut m,
        "messageBoundary",
        n.message_boundary.map(|v| json!(v)),
    );
    put_some(
        &mut m,
        "artifactId",
        n.artifact_id.as_ref().map(|s| json!(s)),
    );
    put_some(&mut m, "input", n.input.clone());
    Value::Object(m)
}

fn expected() -> Value {
    serde_json::from_str(NODE_EXPECTED).unwrap()
}

/// Reads every golden surface of `conn` in the shape of `node-expected.json`.
fn read_back(conn: &Connection) -> Value {
    let expected_ids: Vec<String> = expected()["runIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let mut out = Map::new();
    out.insert("runIds".into(), json!(expected_ids));
    out.insert(
        "runs".into(),
        Value::Array(
            expected_ids
                .iter()
                .map(|id| run_json(&get_run(conn, id).unwrap().unwrap()))
                .collect(),
        ),
    );
    let mut actors = Map::new();
    let mut nodes = Map::new();
    let mut events = Map::new();
    for id in &expected_ids {
        actors.insert(
            id.clone(),
            Value::Array(
                list_actors(conn, id)
                    .unwrap()
                    .iter()
                    .map(actor_json)
                    .collect(),
            ),
        );
        nodes.insert(
            id.clone(),
            Value::Array(
                list_nodes(conn, id)
                    .unwrap()
                    .iter()
                    .map(node_json)
                    .collect(),
            ),
        );
        events.insert(
            id.clone(),
            Value::Array(
                list_events(conn, id)
                    .unwrap()
                    .into_iter()
                    .map(|e| json!({ "sequence": e.sequence, "event": e.event }))
                    .collect(),
            ),
        );
    }
    out.insert("actors".into(), Value::Object(actors));
    out.insert("nodes".into(), Value::Object(nodes));
    out.insert("events".into(), Value::Object(events));
    let live: Vec<Value> = list_non_terminal_runs(conn, "sess_parent")
        .unwrap()
        .iter()
        .map(run_json)
        .collect();
    out.insert("nonTerminalByParent".into(), json!({ "sess_parent": live }));
    out.insert("taskLinks".into(), task_links(conn));
    out.insert("checksums".into(), json!({ "0019_dwf_journal": crate::repo::migrations::checksum(
        crate::repo::migrations::MIGRATIONS.iter().find(|m| m.id == "0019_dwf_journal").unwrap().sql,
    ) }));
    Value::Object(out)
}

fn task_links(conn: &Connection) -> Value {
    let mut stmt = conn
        .prepare(
            "select id, root_workflow_run_id, parent_link_id, activity_id, parent_session_id, child_session_id,
                    role, depth, path, phase, label, agent_type, model, status
             from session_task_link order by id",
        )
        .unwrap();
    let names = [
        "id",
        "root_workflow_run_id",
        "parent_link_id",
        "activity_id",
        "parent_session_id",
        "child_session_id",
        "role",
        "depth",
        "path",
        "phase",
        "label",
        "agent_type",
        "model",
        "status",
    ];
    let rows = stmt
        .query_map([], |row| {
            let mut m = Map::new();
            for (index, name) in names.iter().enumerate() {
                let value: rusqlite::types::Value = row.get(index)?;
                m.insert(
                    (*name).into(),
                    match value {
                        rusqlite::types::Value::Null => Value::Null,
                        rusqlite::types::Value::Integer(i) => json!(i),
                        rusqlite::types::Value::Text(s) => json!(s),
                        other => panic!("unexpected column value {other:?}"),
                    },
                );
            }
            Ok(Value::Object(m))
        })
        .unwrap();
    Value::Array(rows.map(Result::unwrap).collect())
}

/// Compares only the surfaces Node writes into `node-expected.json`; Node's keys are the reference.
fn assert_matches_node(actual: &Value) {
    let expected = expected();
    for key in [
        "runIds",
        "runs",
        "actors",
        "nodes",
        "events",
        "nonTerminalByParent",
        "taskLinks",
        "checksums",
    ] {
        assert_eq!(
            actual[key], expected[key],
            "golden surface `{key}` differs from node-expected.json"
        );
    }
}

// ---- Direction 1: Rust reads the database Node wrote.

#[test]
fn rust_reads_what_node_wrote() {
    let (_dir, copy) = copy_of(NODE_WRITTEN);
    let (conn, _) = crate::repo::open::open(&copy, Duration::from_secs(1), 0).unwrap();
    assert_matches_node(&read_back(&conn));
}

// ---- Rust writes the scenario itself; the file is then read by Node (direction 2).

#[test]
fn rust_writes_the_scenario_and_reads_it_back_in_node_shape() {
    let dir = tempfile::tempdir().unwrap();
    let (conn, _) =
        crate::repo::open::open(&dir.path().join("rust.sqlite"), Duration::from_secs(1), 0)
            .unwrap();
    apply_scenario(&conn);
    assert_matches_node(&read_back(&conn));
}

/// Regenerates `fixtures/dwf/rust-written.sqlite` for Node's direction-2 test. Run explicitly:
/// `cargo test -p rust-cli-node-store regenerate_rust_written_golden -- --ignored`.
#[tokio::test]
#[ignore = "writes fixtures/dwf/rust-written.sqlite; run on purpose"]
async fn regenerate_rust_written_golden() {
    let path = manifest(RUST_WRITTEN);
    rust_cli_fs::remove_path_force(&path).await.unwrap();
    let (conn, _) = crate::repo::open::open(&path, Duration::from_secs(1), 0).unwrap();
    apply_scenario(&conn);
    assert_matches_node(&read_back(&conn));
    drop(conn);
}
