//! Fork: the parse of `helper/elicitation` (specs/fork-rust-node-helper.md F3b(c), PR 2).

use rust_cli_kernel_api::ids::SessionId;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::parse;

fn request(tool_use: Option<&str>) -> serde_json::Value {
    let mut params = json!({
        "requestKey": "e1",
        "sessionId": "s1",
        "turnId": "run_1",
        "serverName": "plugin:calc:app",
        "message": "Name?",
        "requestedSchema": {"type": "object"},
    });
    if let Some(tool_use) = tool_use {
        params["toolUseId"] = json!(tool_use);
    }
    params
}

#[test]
fn a_request_of_an_in_flight_call_is_parsed_with_its_question() {
    let call = parse(&request(Some("toolu_1")), CancellationToken::new())
        .expect("a valid request")
        .expect("the call is in flight");
    assert_eq!(call.session, SessionId::new("s1"));
    assert_eq!(call.tool_use.as_str(), "toolu_1");
    assert_eq!(call.server, "plugin:calc:app");
    assert_eq!(call.params["message"], json!("Name?"));
    assert_eq!(call.params["requestedSchema"], json!({"type": "object"}));
}

/// No in-flight call: the helper names no tool call, so nothing can be attributed and the question is declined.
#[test]
fn a_request_without_a_tool_use_has_no_call_to_ask_for() {
    assert!(
        parse(&request(None), CancellationToken::new())
            .expect("a valid request")
            .is_none()
    );
    assert!(
        parse(&request(Some("")), CancellationToken::new())
            .expect("a valid request")
            .is_none()
    );
}

#[test]
fn a_request_without_its_session_or_server_is_refused() {
    let mut no_session = request(Some("toolu_1"));
    no_session.as_object_mut().unwrap().remove("sessionId");
    assert!(parse(&no_session, CancellationToken::new()).is_err());
    let mut no_server = request(Some("toolu_1"));
    no_server.as_object_mut().unwrap().remove("serverName");
    assert!(parse(&no_server, CancellationToken::new()).is_err());
}

/// The contract both runtimes read (helper_elicitation_contract.json; the TS relay test reads the same file).
const CONTRACT: &str = include_str!("helper_elicitation_contract.json");

fn contract() -> Value {
    serde_json::from_str(CONTRACT).expect("the contract is JSON")
}

/// The params the helper sends are the contract's request plus the key the client adds; Rust parses them to the call the
/// contract names.
#[test]
fn the_contract_request_parses_to_the_call_it_names() {
    let mut params = contract()["request"].clone();
    params["requestKey"] = json!("helper-key-1");
    let call = parse(&params, CancellationToken::new())
        .expect("the contract is valid")
        .expect("the contract names a call");
    let named = contract()["call"].clone();
    assert_eq!(
        call.session,
        SessionId::new(named["sessionId"].as_str().unwrap())
    );
    assert_eq!(call.tool_use.as_str(), named["toolUseId"]);
    assert_eq!(call.server, contract()["question"]["serverName"]);
    assert_eq!(call.params["message"], contract()["question"]["message"]);
}
