//! `lsp/*` answers (specs/fork-rust-agent-parity.md, "Language servers" row): Node's order, the strict params check
//! first, then the no-LSP-host error.
use rust_cli_protocol_core::rpc::codes;
use serde_json::{Value, json};

use super::*;
use crate::inbound::Inbound;

const METHODS: [&str; 3] = ["lsp/preferences/get", "lsp/preferences/set", "lsp/status"];

fn workspace() -> Value {
    json!({"workspacePath": "/w", "workspaceKey": "/w"})
}

fn valid(method: &str) -> Value {
    match method {
        "lsp/preferences/set" => json!({"workspace": workspace(),
            "patch": {"enabled": false, "diagnosticsAfterEdit": {"p/ts": null, "p/rs": true}}}),
        _ => json!({"workspace": workspace()}),
    }
}

/// Node `Handler::request` order: [`Inbound::method`] runs before the dispatch.
fn answer(method: &str, params: &Value) -> Result<Value, RpcError> {
    Inbound::get().method(method, params)?;
    dispatch(method).expect("an lsp method is answered")
}

#[test]
fn a_valid_call_answers_that_the_runtime_has_no_lsp_host() {
    for method in METHODS {
        let error = answer(method, &valid(method)).expect_err(method);
        assert_eq!(error.code, -32000, "{method}");
        assert_eq!(
            error.message, "Language server support is not available in this runtime",
            "{method}"
        );
    }
}

#[test]
fn invalid_params_are_refused_before_the_host_check() {
    for method in METHODS {
        for params in [
            Value::Null,
            json!({}),
            json!({"workspace": {"workspacePath": "/w"}}),
            json!({"workspace": {"workspacePath": "", "workspaceKey": "/w"}}),
            json!({"workspace": workspace(), "extra": 1}),
        ] {
            let error = answer(method, &params).expect_err(method);
            assert_eq!(error.code, codes::INVALID_PARAMS, "{method} {params}");
        }
    }
    for patch in [
        Value::Null,
        json!({"enabled": "yes"}),
        json!({"diagnosticsAfterEdit": {"": true}}),
        json!({"diagnosticsAfterEdit": {"p/ts": 1}}),
        json!({"other": true}),
    ] {
        let params = json!({"workspace": workspace(), "patch": patch});
        let error = answer("lsp/preferences/set", &params).expect_err("bad patch");
        assert_eq!(error.code, codes::INVALID_PARAMS, "{patch}");
    }
    let missing = answer("lsp/preferences/set", &json!({"workspace": workspace()}));
    assert_eq!(missing.unwrap_err().code, codes::INVALID_PARAMS);
}

#[test]
fn other_methods_are_not_answered_here() {
    assert!(dispatch("lsp/restart").is_none());
    assert!(dispatch("plugins/list").is_none());
}
