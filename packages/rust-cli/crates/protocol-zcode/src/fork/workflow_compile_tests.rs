//! Reply parsing of the compile and format client (specs/fork-rust-workflow-engine.md, 4.1). The helper's answer is
//! the contract; a reply that does not match it is an error, never a guess.

use serde_json::json;

use super::*;

/// A ready fill reply as the helper sends it (9.45).
fn ready_fill() -> Value {
    json!({
        "ok": true,
        "effectiveText": "return 'approved';\n",
        "scriptHash": "hash-2",
        "code": "return 'approved';",
        "askSpecs": {},
        "sitePhases": {},
        "phaseNames": ["main"],
        "phasesAdded": [],
    })
}

#[test]
fn a_ready_fill_reply_keeps_the_code_and_the_effective_script() {
    assert_eq!(
        parse_fill_prepare(&ready_fill()).expect("a ready reply"),
        FillPrepareOutcome::Ready(ready_fill())
    );
}

#[test]
fn a_ready_fill_reply_without_its_code_is_malformed() {
    let mut reply = ready_fill();
    reply.as_object_mut().expect("object").remove("code");
    assert!(parse_fill_prepare(&reply).is_err());
}

#[test]
fn a_ready_fill_reply_with_a_non_text_phase_name_is_malformed() {
    let mut reply = ready_fill();
    reply["phaseNames"] = json!(["main", 3]);
    assert!(parse_fill_prepare(&reply).is_err());
}

#[test]
fn a_refused_fill_keeps_its_reason_message_and_diagnostics() {
    let reply = json!({
        "ok": false,
        "reason": "compile_failed",
        "message": "does not compile",
        "diagnostics": [{"line": 3, "column": 5, "message": "bad", "code": 9001}],
    });
    assert!(matches!(
        parse_fill_prepare(&reply),
        Ok(FillPrepareOutcome::Refused { reason, message, diagnostics: Some(_) })
            if reason == "compile_failed" && message == "does not compile"
    ));
}

#[test]
fn a_refused_fill_with_null_diagnostics_has_none() {
    let reply =
        json!({"ok": false, "reason": "hole_not_waiting", "message": "m", "diagnostics": null});
    assert!(matches!(
        parse_fill_prepare(&reply),
        Ok(FillPrepareOutcome::Refused {
            diagnostics: None,
            ..
        })
    ));
}

#[test]
fn a_refused_fill_with_non_list_diagnostics_is_malformed() {
    let reply =
        json!({"ok": false, "reason": "compile_failed", "message": "m", "diagnostics": "oops"});
    assert!(parse_fill_prepare(&reply).is_err());
}

#[test]
fn a_refused_fill_without_a_reason_is_malformed() {
    let reply = json!({"ok": false, "message": "m"});
    assert!(parse_fill_prepare(&reply).is_err());
}

#[test]
fn a_fill_reply_without_ok_is_malformed() {
    assert!(parse_fill_prepare(&json!({"code": "x"})).is_err());
}

#[test]
fn the_fill_params_send_bindings_only_when_they_are_a_record() {
    let base = FillPrepareInput {
        script_text: "s".to_owned(),
        run_id: "r".to_owned(),
        hole_id: "hole#1".to_owned(),
        body: "b".to_owned(),
        model_bindings: None,
    };
    assert!(fill_prepare_params(&base).get("modelBindings").is_none());
    let null = FillPrepareInput {
        model_bindings: Some(Value::Null),
        ..base.clone()
    };
    assert!(fill_prepare_params(&null).get("modelBindings").is_none());
    let bound = FillPrepareInput {
        model_bindings: Some(json!({"fast": "model-x"})),
        ..base
    };
    assert_eq!(
        fill_prepare_params(&bound)["modelBindings"],
        json!({"fast": "model-x"})
    );
}

#[test]
fn a_ready_fill_reply_with_hole_indexes_keeps_them_and_rejects_other_items() {
    let mut reply = ready_fill();
    reply["holes"] = json!([1, 2]);
    assert_eq!(
        parse_fill_prepare(&reply).expect("a ready reply with indexes"),
        FillPrepareOutcome::Ready(reply.clone())
    );
    reply["holes"] = json!(["x"]);
    assert!(parse_fill_prepare(&reply).is_err());
}

#[test]
fn a_ready_fill_reply_needs_its_ask_and_site_tables_to_be_objects() {
    let mut reply = ready_fill();
    reply["askSpecs"] = json!([]);
    assert!(parse_fill_prepare(&reply).is_err());
    let mut reply = ready_fill();
    reply["sitePhases"] = json!("main");
    assert!(parse_fill_prepare(&reply).is_err());
}

#[test]
fn a_refused_fill_with_a_diagnostic_missing_its_position_is_malformed() {
    let reply = json!({
        "ok": false,
        "reason": "compile_failed",
        "message": "m",
        "diagnostics": [{"message": "no position"}],
    });
    assert!(parse_fill_prepare(&reply).is_err());
}

#[test]
fn a_non_record_model_binding_is_not_sent() {
    let base = FillPrepareInput {
        script_text: "s".to_owned(),
        run_id: "r".to_owned(),
        hole_id: "hole#1".to_owned(),
        body: "b".to_owned(),
        model_bindings: Some(json!("fast")),
    };
    assert!(fill_prepare_params(&base).get("modelBindings").is_none());
}

#[test]
fn a_ready_compile_keeps_the_hash_the_compiled_facts_and_the_entry() {
    let reply = json!({
        "ok": true,
        "scriptHash": "abc",
        "compiled": {"phases": ["review"], "holes": []},
        "entrySource": "export const payload = {};\n",
    });
    assert_eq!(
        parse_compile(&reply).unwrap(),
        Compiled::Ready {
            script_hash: "abc".to_owned(),
            compiled: json!({"phases": ["review"], "holes": []}),
            entry_source: "export const payload = {};\n".to_owned(),
        }
    );
}

#[test]
fn a_rejected_compile_keeps_positioned_diagnostics() {
    let reply = json!({
        "ok": false,
        "diagnostics": [{"code": 2322, "line": 1, "column": 7, "message": "Type string is not assignable"}],
    });
    assert_eq!(
        parse_compile(&reply).unwrap(),
        Compiled::Rejected {
            diagnostics: vec![Diagnostic {
                code: 2322,
                line: 1,
                column: 7,
                message: "Type string is not assignable".to_owned(),
            }],
            message: None,
        }
    );
}

#[test]
fn a_rejected_compile_that_threw_carries_its_message() {
    let reply = json!({"ok": false, "diagnostics": [], "message": "unsupported ask result types"});
    let Compiled::Rejected {
        diagnostics,
        message,
    } = parse_compile(&reply).unwrap()
    else {
        panic!("expected a rejection");
    };
    assert!(diagnostics.is_empty());
    assert_eq!(message.as_deref(), Some("unsupported ask result types"));
}

#[test]
fn a_ready_reply_without_its_entry_is_malformed() {
    let reply = json!({"ok": true, "scriptHash": "abc", "compiled": {}});
    assert!(parse_compile(&reply).is_err());
}

#[test]
fn a_reply_without_ok_is_malformed() {
    assert!(parse_compile(&json!({"diagnostics": []})).is_err());
}

#[test]
fn a_format_reply_is_the_analysis_object() {
    assert_eq!(
        parse_analysis(&json!({"analysis": {"ok": true, "diagnostics": []}})).unwrap(),
        json!({"ok": true, "diagnostics": []})
    );
    assert!(parse_analysis(&json!({"analysis": "text"})).is_err());
    assert!(parse_analysis(&json!({})).is_err());
}

#[test]
fn the_request_carries_the_run_identity_and_only_the_optional_fields_given() {
    let params = compile_params(&CompileRequest {
        script_text: "return 1;",
        run_id: "run-1",
        args: None,
        resumed_from: None,
    });
    assert_eq!(params, json!({"scriptText": "return 1;", "runId": "run-1"}));
    let args = serde_json::Map::from_iter([("topic".to_owned(), json!("x"))]);
    let params = compile_params(&CompileRequest {
        script_text: "return 1;",
        run_id: "run-2",
        args: Some(&args),
        resumed_from: Some("run-1"),
    });
    assert_eq!(
        params,
        json!({"scriptText": "return 1;", "runId": "run-2", "args": {"topic": "x"}, "resumedFrom": "run-1"})
    );
}

// W7-2 (specs/fork-rust-workflow-engine.md, 9.17): the window display and the run list and run detail text.

#[test]
fn a_display_reply_is_the_window_or_none() {
    let window = json!({"kind": "create_workflow", "nodes": []});
    assert_eq!(
        parse_display(&json!({"display": window})).unwrap(),
        Some(json!({"kind": "create_workflow", "nodes": []}))
    );
    assert_eq!(parse_display(&json!({"display": null})).unwrap(), None);
    assert!(parse_display(&json!({"display": "text"})).is_err());
    assert!(parse_display(&json!({})).is_err());
}

#[test]
fn a_text_reply_is_the_formatted_string() {
    assert_eq!(
        parse_text(&json!({"text": "<workflow_runs count=\"0\">"})).unwrap(),
        "<workflow_runs count=\"0\">"
    );
    assert!(parse_text(&json!({"text": 1})).is_err());
    assert!(parse_text(&json!({})).is_err());
}

#[test]
fn the_run_list_request_carries_the_query_the_listed_rows_and_the_cwd() {
    let input = serde_json::Map::from_iter([("limit".to_owned(), json!(5))]);
    let listed = json!({"runs": [], "truncated": false});
    assert_eq!(
        run_list_params(&input, &listed, "/work/project"),
        json!({
            "kind": "runList",
            "input": {"limit": 5},
            "listed": {"runs": [], "truncated": false},
            "workingDirectory": "/work/project",
        })
    );
}

// ocr findings on PR #571: the window needs the script's model bindings, and an unknown run sends `detail: null`.

#[test]
fn the_display_request_carries_the_model_bindings_only_when_given() {
    assert_eq!(
        display_params("return 1;", None),
        json!({"kind": "display", "scriptText": "return 1;"})
    );
    let bindings = serde_json::Map::from_iter([("gpt-5".to_owned(), json!("zhipu/gpt-5"))]);
    assert_eq!(
        display_params("return 1;", Some(&bindings)),
        json!({
            "kind": "display",
            "scriptText": "return 1;",
            "modelBindings": {"gpt-5": "zhipu/gpt-5"},
        })
    );
}

#[test]
fn an_unknown_run_is_sent_as_a_null_detail() {
    assert_eq!(
        run_detail_params("dwfrun-gone", None, "/work/project"),
        json!({
            "kind": "runDetail",
            "runId": "dwfrun-gone",
            "detail": null,
            "workingDirectory": "/work/project",
        })
    );
}

#[test]
fn the_run_detail_request_carries_the_run_id_the_detail_and_the_cwd() {
    let detail = json!({"runId": "dwfrun-1", "status": "running"});
    assert_eq!(
        run_detail_params("dwfrun-1", Some(&detail), "/work/project"),
        json!({
            "kind": "runDetail",
            "runId": "dwfrun-1",
            "detail": {"runId": "dwfrun-1", "status": "running"},
            "workingDirectory": "/work/project",
        })
    );
}

#[test]
fn a_format_analysis_maps_to_the_checker_verdict_and_ignores_the_graph() {
    use rust_cli_kernel_api::workflow_analysis::{WorkflowAnalysis, WorkflowDiagnostic};
    let reply = json!({
        "ok": false,
        "diagnostics": [{"code": 2322, "line": 1, "column": 7, "message": "Type 'string' is not assignable to type 'number'.", "extra": true}],
        "declaredArtifacts": [],
        "modelReferences": []
    });
    assert_eq!(
        analysis_from_value(&reply).unwrap(),
        WorkflowAnalysis {
            ok: false,
            diagnostics: vec![WorkflowDiagnostic {
                code: 2322,
                line: 1,
                column: 7,
                message: "Type 'string' is not assignable to type 'number'.".to_owned(),
            }],
        }
    );
    assert!(analysis_from_value(&json!({"ok": "yes", "diagnostics": []})).is_err());
    assert!(analysis_from_value(&json!({"diagnostics": []})).is_err());
}

#[test]
fn a_malformed_analysis_reply_carries_the_serde_cause() {
    let error = analysis_from_value(&json!({"diagnostics": []})).unwrap_err();
    assert!(
        error.message.contains("missing field `ok`"),
        "the cause is missing: {}",
        error.message
    );
}

#[test]
fn a_failed_helper_call_and_a_malformed_reply_both_mean_the_checker_cannot_answer() {
    use rust_cli_protocol_core::rpc::RpcError;
    let down = analysis_verdict(Err(RpcError::internal("the helper is not running")))
        .expect_err("a failed call");
    assert_eq!(down.message, "the helper is not running");
    let malformed = analysis_verdict(Ok(json!({"diagnostics": []}))).expect_err("no ok flag");
    assert!(
        malformed.message.contains("does not match its contract"),
        "{}",
        malformed.message
    );
    let clean = analysis_verdict(Ok(json!({"ok": true, "diagnostics": []}))).expect("a verdict");
    assert!(clean.ok);
}

// W7-8c (specs/fork-rust-workflow-engine.md, 9.28): the snippet compile client.

#[test]
fn the_eval_snippet_request_carries_the_code_and_the_run_id_only() {
    assert_eq!(
        eval_snippet_params("return 1;", "dwfeval-1"),
        json!({"scriptText": "return 1;", "runId": "dwfeval-1"})
    );
}

#[test]
fn a_ready_snippet_keeps_the_world_run_flag_and_the_entry() {
    let reply =
        json!({"ok": true, "worldRun": true, "entrySource": "export const payload = {};\n"});
    assert_eq!(
        parse_eval_snippet(&reply).unwrap(),
        SnippetCompiled::Ready {
            world_run: true,
            entry_source: "export const payload = {};\n".to_owned(),
        }
    );
}

#[test]
fn a_rejected_snippet_keeps_its_diagnostics_as_workflow_diagnostics() {
    let reply = json!({
        "ok": false,
        "diagnostics": [{"code": 2304, "line": 2, "column": 3, "message": "Cannot find name 'agent'."}],
    });
    assert_eq!(
        parse_eval_snippet(&reply).unwrap(),
        SnippetCompiled::Rejected {
            diagnostics: vec![rust_cli_kernel_api::workflow_analysis::WorkflowDiagnostic {
                code: 2304,
                line: 2,
                column: 3,
                message: "Cannot find name 'agent'.".to_owned(),
            }],
        }
    );
}

#[test]
fn a_snippet_reply_without_its_ok_flag_or_entry_is_malformed() {
    let no_flag = parse_eval_snippet(&json!({"worldRun": false})).expect_err("no ok flag");
    assert!(no_flag.message.contains("does not match its contract"));
    let no_entry = parse_eval_snippet(&json!({"ok": true, "worldRun": false}))
        .expect_err("a ready snippet needs its entry");
    assert!(no_entry.message.contains("does not match its contract"));
}
