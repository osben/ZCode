//! Reply parsing of the compile and format client (specs/fork-rust-workflow-engine.md, 4.1). The helper's answer is
//! the contract; a reply that does not match it is an error, never a guess.

use serde_json::json;

use super::*;

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
