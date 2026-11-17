//! dwf_* 仓储的单元测试（W2）：Node 的物理 ↔ 逻辑编解码表，写读语义（建run、结算、actor、node、事件序号），
//! 以及 session_task_link 的 `workflow_actor` 行。跨运行时的逐行比对在 `golden_tests.rs`。
use super::codecs::{
    PhysicalStatus, RunSettlementFields, decode_run_settlement, encode_run_settlement,
};
use super::*;
use serde_json::json;
use std::time::Duration;

fn database() -> Connection {
    let (conn, _) = crate::repo::open::open(Path::new(":memory:"), Duration::from_secs(1), 0)
        .expect("in-memory session database with every Node migration");
    conn
}

/// The codec on well-formed input; corrupt input has its own test.
fn decode(status: PhysicalStatus, failure_json: Option<&str>) -> RunSettlementFields {
    decode_run_settlement(status, failure_json).expect("well-formed failure_json")
}

fn add_session(conn: &Connection, id: &str, parent: Option<&str>) {
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values (?, 'proj', ?, ?, '/work', 'title', '0.0.0', 1, 1)",
        rusqlite::params![id, parent, id],
    )
    .expect("session row for the task link foreign key");
}

fn run(id: &str, status: RunStatus) -> RunRecord {
    RunRecord {
        run_id: id.to_owned(),
        status,
        max_concurrency: 2,
        ..RunRecord::default()
    }
}

// ---- Codec table (Node dwf-journal-codecs.ts: encodeRunSettlement / decodeRunSettlement).

#[test]
fn stopped_settles_as_cancelled_with_the_envelope() {
    let encoded = encode_run_settlement(
        RunStatus::Stopped,
        &Settlement {
            stop_reason: Some(StopReason::Superseded),
            superseded_by: Some("run_d".into()),
            ..Settlement::default()
        },
    );
    assert_eq!(encoded.status, PhysicalStatus::Cancelled);
    assert_eq!(
        serde_json::from_str::<Value>(encoded.failure_json.as_deref().unwrap()).unwrap(),
        json!({ "stopReason": "superseded", "supersededBy": "run_d" })
    );
}

#[test]
fn stopped_without_a_reason_writes_user() {
    let encoded = encode_run_settlement(RunStatus::Stopped, &Settlement::default());
    assert_eq!(encoded.status, PhysicalStatus::Cancelled);
    assert_eq!(
        serde_json::from_str::<Value>(encoded.failure_json.as_deref().unwrap()).unwrap(),
        json!({ "stopReason": "user" })
    );
}

#[test]
fn errored_settles_as_failed_with_the_failure_as_is() {
    let failure = json!({ "code": "ScriptError", "message": "boom" });
    let encoded = encode_run_settlement(
        RunStatus::Errored,
        &Settlement {
            failure: Some(failure.clone()),
            ..Settlement::default()
        },
    );
    assert_eq!(encoded.status, PhysicalStatus::Failed);
    assert_eq!(
        encoded
            .failure_json
            .as_deref()
            .map(serde_json::from_str::<Value>)
            .unwrap()
            .unwrap(),
        failure
    );
}

#[test]
fn completed_and_non_terminal_states_keep_their_physical_names() {
    assert_eq!(
        encode_run_settlement(RunStatus::Completed, &Settlement::default()),
        codecs::Encoded {
            status: PhysicalStatus::Completed,
            failure_json: None
        }
    );
    assert_eq!(
        encode_run_settlement(RunStatus::Pending, &Settlement::default()),
        codecs::Encoded {
            status: PhysicalStatus::Pending,
            failure_json: None
        }
    );
    assert_eq!(
        encode_run_settlement(RunStatus::Running, &Settlement::default()),
        codecs::Encoded {
            status: PhysicalStatus::Running,
            failure_json: None
        }
    );
}

#[test]
fn decoding_cancelled_reads_the_envelope_and_defaults_to_user() {
    let with_envelope = decode(
        PhysicalStatus::Cancelled,
        Some(r#"{"stopReason":"model","error":{"code":"X","message":"y"}}"#),
    );
    assert_eq!(
        with_envelope,
        RunSettlementFields {
            status: RunStatus::Stopped,
            stop_reason: Some(StopReason::Model),
            superseded_by: None,
            failure: Some(json!({ "code": "X", "message": "y" })),
        }
    );
    // Older rows have no envelope, and an unknown reason is not in the allowlist: both decode as user.
    for raw in [None, Some(r#"{"stopReason":"unknown"}"#)] {
        let fields = decode(PhysicalStatus::Cancelled, raw);
        assert_eq!(fields.status, RunStatus::Stopped);
        assert_eq!(fields.stop_reason, Some(StopReason::User));
        assert_eq!(fields.failure, None);
    }
}

#[test]
fn decoding_failed_splits_interrupted_from_errored() {
    let interrupted = decode(
        PhysicalStatus::Failed,
        Some(r#"{"code":"Interrupted","message":"gone"}"#),
    );
    assert_eq!(interrupted.status, RunStatus::Stopped);
    assert_eq!(interrupted.stop_reason, Some(StopReason::Interrupted));
    assert_eq!(
        interrupted.failure,
        Some(json!({ "code": "Interrupted", "message": "gone" }))
    );

    let errored = decode(PhysicalStatus::Failed, None);
    assert_eq!(errored.status, RunStatus::Errored);
    assert_eq!(errored.failure, None);
}

// ---- Repository behaviour.

#[test]
fn a_run_round_trips_every_optional_column() {
    let conn = database();
    let created = RunRecord {
        parent_session_id: Some("sess_p".into()),
        cwd: Some("/work".into()),
        name: Some("Alpha".into()),
        tool_call_id: Some("call_1".into()),
        script_text: Some("export default 1".into()),
        script_hash: Some("hash".into()),
        args: Some(json!({ "n": 2 })),
        resumed_from: Some("run_0".into()),
        spent_tokens: 7,
        ..run("run_1", RunStatus::Running)
    };
    create_run(&conn, &created, 10).unwrap();
    assert_eq!(get_run(&conn, "run_1").unwrap(), Some(created));
    assert_eq!(get_run(&conn, "missing").unwrap(), None);
}

#[test]
fn a_duplicate_run_is_a_clear_error() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    let error = create_run(&conn, &run("run_1", RunStatus::Running), 11).unwrap_err();
    assert!(
        error.to_string().contains("run already exists: run_1"),
        "{error}"
    );
}

#[test]
fn an_update_to_an_unknown_run_fails_loudly() {
    let conn = database();
    let error = update_run_usage(&conn, "nope", 1, 10).unwrap_err();
    assert!(error.to_string().contains("unknown run: nope"), "{error}");
    assert!(update_run_status(&conn, "nope", RunStatus::Running, None, 10).is_err());
}

#[test]
fn settling_replaces_failure_and_keeps_an_earlier_result() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    update_run_status(
        &conn,
        "run_1",
        RunStatus::Completed,
        Some(&Settlement {
            result: Some(json!({ "ok": 1 })),
            ..Settlement::default()
        }),
        11,
    )
    .unwrap();
    // A later settlement without a result leaves the stored result (coalesce), and failure is rewritten whole.
    update_run_status(
        &conn,
        "run_1",
        RunStatus::Errored,
        Some(&Settlement {
            failure: Some(json!({ "code": "E", "message": "m" })),
            ..Settlement::default()
        }),
        12,
    )
    .unwrap();
    let got = get_run(&conn, "run_1").unwrap().unwrap();
    assert_eq!(got.status, RunStatus::Errored);
    assert_eq!(got.result, Some(json!({ "ok": 1 })));
    assert_eq!(got.failure, Some(json!({ "code": "E", "message": "m" })));
}

#[test]
fn going_back_to_running_clears_the_settlement() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    update_run_status(
        &conn,
        "run_1",
        RunStatus::Errored,
        Some(&Settlement {
            failure: Some(json!({ "code": "E", "message": "m" })),
            ..Settlement::default()
        }),
        11,
    )
    .unwrap();
    update_run_status(&conn, "run_1", RunStatus::Running, None, 12).unwrap();
    let got = get_run(&conn, "run_1").unwrap().unwrap();
    assert_eq!(got.status, RunStatus::Running);
    assert_eq!(got.failure, None);
    assert_eq!(got.result, None);
}

#[test]
fn usage_caps_and_script_have_their_own_narrow_writers() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    update_run_usage(&conn, "run_1", 512, 11).unwrap();
    update_run_caps(&conn, "run_1", 6, 12).unwrap();
    update_run_script(&conn, "run_1", "export default 2", "hash_2", 13).unwrap();
    let got = get_run(&conn, "run_1").unwrap().unwrap();
    assert_eq!(got.spent_tokens, 512);
    assert_eq!(got.max_concurrency, 6);
    assert_eq!(got.script_text.as_deref(), Some("export default 2"));
    assert_eq!(got.script_hash.as_deref(), Some("hash_2"));
    assert_eq!(got.status, RunStatus::Running);
}

#[test]
fn events_are_numbered_per_run_and_kept_verbatim() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    create_run(&conn, &run("run_2", RunStatus::Running), 10).unwrap();
    let first = append_event(
        &conn,
        "run_1",
        &json!({ "type": "log", "message": "a" }),
        11,
    )
    .unwrap();
    let second = append_event(
        &conn,
        "run_1",
        &json!({ "type": "log", "message": "b" }),
        12,
    )
    .unwrap();
    let other = append_event(
        &conn,
        "run_2",
        &json!({ "type": "log", "message": "c" }),
        13,
    )
    .unwrap();
    assert_eq!((first.sequence, second.sequence, other.sequence), (0, 1, 0));
    let events = list_events(&conn, "run_1").unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].event, json!({ "type": "log", "message": "b" }));
    assert_eq!(events[1].time_created, 12);
}

/// The stored text must be `JSON.stringify`'s, byte for byte: serde writes `1e21`, JavaScript `1e+21`.
#[test]
fn the_stored_payload_text_is_javascript_json_text() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    let big = serde_json::Number::from_f64(1e21).unwrap();
    append_event(
        &conn,
        "run_1",
        &json!({ "type": "usage-updated", "spentTokens": big }),
        11,
    )
    .unwrap();
    let text: String = conn
        .query_row(
            "select payload_json from dwf_event where run_id = 'run_1' and sequence = 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(text, r#"{"type":"usage-updated","spentTokens":1e+21}"#);
}

#[test]
fn an_actor_upsert_keeps_the_identity_it_is_given() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    let actor = ActorRecord {
        run_id: "run_1".into(),
        site_id: "site#1".into(),
        ordinal: 0,
        name: Some("researcher".into()),
        persona: Some(json!({ "name": "researcher", "budget": { "webSearch": 8 } })),
        session_id: Some("sess_child".into()),
        resolved_model: None,
    };
    put_actor(&conn, &actor, 11).unwrap();
    put_actor(
        &conn,
        &ActorRecord {
            resolved_model: Some("zai/glm".into()),
            ..actor.clone()
        },
        12,
    )
    .unwrap();
    assert_eq!(
        get_actor(&conn, "run_1", "site#1", 0).unwrap(),
        Some(ActorRecord {
            resolved_model: Some("zai/glm".into()),
            ..actor
        })
    );
    assert_eq!(list_actors(&conn, "run_1").unwrap().len(), 1);
}

#[test]
fn a_node_upsert_replaces_the_row_and_keeps_the_identity_columns() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    let admitted = NodeRecord {
        run_id: "run_1".into(),
        site_id: "site#1".into(),
        ordinal: 0,
        kind: NodeKind::Ask,
        actor_site_id: Some("site#1".into()),
        actor_ordinal: Some(0),
        actor_seq: Some(1),
        input_hash: "ih".into(),
        status: NodeStatus::Running,
        ..NodeRecord::default()
    };
    put_node(&conn, &admitted, 11).unwrap();
    let settled = NodeRecord {
        status: NodeStatus::Completed,
        result: Some(json!({ "answer": null })),
        stats: Some(json!({ "tokens": 3, "toolCalls": 0, "turns": 1 })),
        message_boundary: Some(0),
        ..admitted
    };
    put_node(&conn, &settled, 12).unwrap();
    assert_eq!(
        get_node(&conn, "run_1", "site#1", 0).unwrap(),
        Some(settled)
    );
    assert_eq!(list_nodes(&conn, "run_1").unwrap().len(), 1);
}

#[test]
fn a_world_node_keeps_its_bounded_input_through_settlement() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    let admitted = NodeRecord {
        run_id: "run_1".into(),
        site_id: "site#2".into(),
        ordinal: 0,
        kind: NodeKind::WorldRead,
        input_hash: "ih".into(),
        status: NodeStatus::Running,
        input: Some(json!({ "op": "glob", "args": ["**/*.ts"] })),
        ..NodeRecord::default()
    };
    put_node(&conn, &admitted, 11).unwrap();
    put_node(
        &conn,
        &NodeRecord {
            status: NodeStatus::Completed,
            result: Some(json!(["a.ts"])),
            ..admitted.clone()
        },
        12,
    )
    .unwrap();
    let got = get_node(&conn, "run_1", "site#2", 0).unwrap().unwrap();
    assert_eq!(got.input, admitted.input);
    assert_eq!(got.result, Some(json!(["a.ts"])));
}

#[test]
fn the_non_terminal_query_is_scoped_to_one_parent_session() {
    let conn = database();
    add_session(&conn, "sess_p", None);
    create_run(
        &conn,
        &RunRecord {
            parent_session_id: Some("sess_p".into()),
            ..run("run_live", RunStatus::Running)
        },
        10,
    )
    .unwrap();
    create_run(
        &conn,
        &RunRecord {
            parent_session_id: Some("sess_p".into()),
            ..run("run_done", RunStatus::Completed)
        },
        10,
    )
    .unwrap();
    create_run(&conn, &run("run_orphan_no_parent", RunStatus::Running), 10).unwrap();
    let live = list_non_terminal_runs(&conn, "sess_p").unwrap();
    assert_eq!(
        live.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(),
        ["run_live"]
    );
}

// ---- session_task_link role `workflow_actor` (Node createSessionTaskLink, script-workflow-activities.ts).

#[test]
fn a_workflow_actor_link_is_written_in_node_format() {
    let conn = database();
    add_session(&conn, "sess_p", None);
    add_session(&conn, "sess_child", Some("sess_p"));
    insert_workflow_actor_link(
        &conn,
        &WorkflowActorLink {
            id: "tasklink_1",
            child_session_id: "sess_child",
            parent_session_id: Some("sess_p"),
            path: "dwf/run_1/site#1@0",
            status: "running",
        },
        10,
    )
    .unwrap();
    let row: (Option<String>, Option<String>, String, i64, String, String) = conn
        .query_row(
            "select root_workflow_run_id, parent_link_id, role, depth, path, status
             from session_task_link where child_session_id = 'sess_child'",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        row,
        (
            None,
            None,
            "workflow_actor".into(),
            0,
            "dwf/run_1/site#1@0".into(),
            "running".into()
        )
    );

    // Node upserts on child_session_id: a second write only moves status and time.
    insert_workflow_actor_link(
        &conn,
        &WorkflowActorLink {
            id: "tasklink_2",
            child_session_id: "sess_child",
            parent_session_id: Some("sess_p"),
            path: "dwf/run_1/site#1@0",
            status: "completed",
        },
        11,
    )
    .unwrap();
    let count: i64 = conn
        .query_row(
            "select count(*) from session_task_link where child_session_id = 'sess_child'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let status: String = conn
        .query_row(
            "select status from session_task_link where child_session_id = 'sess_child'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!((count, status.as_str()), (1, "completed"));
}

#[test]
fn the_0019_checksum_is_pinned_to_the_upstream_ledger() {
    // fork-upstream-migrations.json, cli set, 0019_dwf_journal (specs/upstream-migration-freeze.md).
    const PINNED: &str = "1c8da5568d2357f25c392be486fae80e1f3ad3ebc830dab1bee941634573e8ba";
    let migration = crate::repo::migrations::MIGRATIONS
        .iter()
        .find(|m| m.id == "0019_dwf_journal")
        .expect("0019 is embedded");
    assert_eq!(crate::repo::migrations::checksum(migration.sql), PINNED);
}

// ---- Fail closed: a corrupt column is an error, never an absent value (Node's decodeJson / JSON.parse throw).

/// A connection that accepts the CHECK-violating values a corrupt database could hold.
fn corrupt_writes(conn: &Connection) {
    conn.execute_batch("pragma ignore_check_constraints = 1")
        .unwrap();
}

#[test]
fn a_corrupt_run_failure_column_is_an_error() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    conn.execute(
        "update dwf_run set status = 'failed', failure_json = '{' where id = 'run_1'",
        [],
    )
    .unwrap();
    assert!(get_run(&conn, "run_1").is_err());
}

#[test]
fn a_corrupt_run_result_column_is_an_error() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Completed), 10).unwrap();
    conn.execute(
        "update dwf_run set result_json = '[1,' where id = 'run_1'",
        [],
    )
    .unwrap();
    assert!(get_run(&conn, "run_1").is_err());
}

#[test]
fn a_corrupt_run_args_column_is_an_error() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    conn.execute(
        "update dwf_run set args_json = 'nope' where id = 'run_1'",
        [],
    )
    .unwrap();
    assert!(get_run(&conn, "run_1").is_err());
}

#[test]
fn a_corrupt_actor_persona_column_is_an_error() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    let actor = ActorRecord {
        run_id: "run_1".into(),
        site_id: "s".into(),
        ordinal: 0,
        ..ActorRecord::default()
    };
    put_actor(&conn, &actor, 11).unwrap();
    conn.execute(
        "update dwf_actor set persona_json = '{\"name\":' where run_id = 'run_1'",
        [],
    )
    .unwrap();
    assert!(get_actor(&conn, "run_1", "s", 0).is_err());
    assert!(list_actors(&conn, "run_1").is_err());
}

#[test]
fn corrupt_node_columns_are_errors() {
    for (column, text) in [
        ("result_json", "{"),
        ("error_json", "{"),
        ("stats_json", "x"),
        ("input_json", "["),
    ] {
        let conn = database();
        create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
        let node = NodeRecord {
            run_id: "run_1".into(),
            site_id: "s".into(),
            ordinal: 0,
            input_hash: "ih".into(),
            ..NodeRecord::default()
        };
        put_node(&conn, &node, 11).unwrap();
        conn.execute(&format!("update dwf_node set {column} = ?1"), [text])
            .unwrap();
        assert!(get_node(&conn, "run_1", "s", 0).is_err(), "{column}");
        assert!(list_nodes(&conn, "run_1").is_err(), "{column}");
    }
}

#[test]
fn an_unknown_node_status_is_an_error_like_an_unknown_kind() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    let node = NodeRecord {
        run_id: "run_1".into(),
        site_id: "s".into(),
        ordinal: 0,
        input_hash: "ih".into(),
        ..NodeRecord::default()
    };
    put_node(&conn, &node, 11).unwrap();
    corrupt_writes(&conn);
    conn.execute("update dwf_node set status = 'bogus'", [])
        .unwrap();
    assert!(get_node(&conn, "run_1", "s", 0).is_err());
    conn.execute("update dwf_node set status = 'running', kind = 'bogus'", [])
        .unwrap();
    assert!(get_node(&conn, "run_1", "s", 0).is_err());
}

#[test]
fn a_duplicate_run_keeps_the_underlying_sqlite_error_as_its_cause() {
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    let error = create_run(&conn, &run("run_1", RunStatus::Running), 11).unwrap_err();
    let chain: Vec<String> = error.chain().map(ToString::to_string).collect();
    assert!(chain[0].contains("run already exists: run_1"), "{chain:?}");
    assert!(
        chain
            .iter()
            .any(|link| link.contains("UNIQUE constraint failed")),
        "{chain:?}"
    );
}

// ---- A failing column is named, at its real index (never column 0).

/// The index and message of the conversion failure in an error chain.
fn conversion_failure(error: &anyhow::Error) -> (usize, String) {
    error
        .chain()
        .find_map(|link| match link.downcast_ref::<rusqlite::Error>() {
            Some(rusqlite::Error::FromSqlConversionFailure(index, _, source)) => {
                Some((*index, source.to_string()))
            }
            _ => None,
        })
        .expect("a sqlite conversion failure in the error chain")
}

#[test]
fn a_corrupt_run_column_is_reported_at_its_own_index() {
    // Positions in RUN_COLUMNS: status is 11, failure_json is 12.
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    corrupt_writes(&conn);
    conn.execute("update dwf_run set status = 'bogus' where id = 'run_1'", [])
        .unwrap();
    let (index, message) = conversion_failure(&get_run(&conn, "run_1").unwrap_err());
    assert_eq!(index, 11);
    assert!(message.contains("column status"), "{message}");

    conn.execute(
        "update dwf_run set status = 'failed', failure_json = '{' where id = 'run_1'",
        [],
    )
    .unwrap();
    let (index, message) = conversion_failure(&get_run(&conn, "run_1").unwrap_err());
    assert_eq!(index, 12);
    assert!(message.contains("column failure_json"), "{message}");
}

#[test]
fn an_unknown_node_status_and_kind_are_named_at_their_own_index() {
    // Positions in NODE_COLUMNS: kind is 3, status is 8.
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    let node = NodeRecord {
        run_id: "run_1".into(),
        site_id: "s".into(),
        ordinal: 0,
        input_hash: "ih".into(),
        ..NodeRecord::default()
    };
    put_node(&conn, &node, 11).unwrap();
    corrupt_writes(&conn);
    conn.execute("update dwf_node set status = 'bogus'", [])
        .unwrap();
    let (index, message) = conversion_failure(&get_node(&conn, "run_1", "s", 0).unwrap_err());
    assert_eq!(index, 8);
    assert!(message.contains("column status"), "{message}");

    conn.execute("update dwf_node set status = 'running', kind = 'bogus'", [])
        .unwrap();
    let (index, message) = conversion_failure(&get_node(&conn, "run_1", "s", 0).unwrap_err());
    assert_eq!(index, 3);
    assert!(message.contains("column kind"), "{message}");
}

#[test]
fn args_text_null_is_a_present_value_like_nodes_json_parse() {
    // Node: `if (row.args_json !== null) record.args = JSON.parse(row.args_json)`. The text "null" is a
    // present null, not an absent key.
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    conn.execute(
        "update dwf_run set args_json = 'null' where id = 'run_1'",
        [],
    )
    .unwrap();
    assert_eq!(
        get_run(&conn, "run_1").unwrap().unwrap().args,
        Some(Value::Null)
    );
}

#[test]
fn an_empty_args_text_is_corrupt_like_nodes_json_parse() {
    // Node parses args_json whenever it is not SQL NULL, and JSON.parse("") throws. It is not falsy-skipped.
    let conn = database();
    create_run(&conn, &run("run_1", RunStatus::Running), 10).unwrap();
    conn.execute("update dwf_run set args_json = '' where id = 'run_1'", [])
        .unwrap();
    assert!(get_run(&conn, "run_1").is_err());
}
