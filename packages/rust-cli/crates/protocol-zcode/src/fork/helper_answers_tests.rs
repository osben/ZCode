//! Fork: specs/fork-rust-node-helper.md F3, `helper/authorizeAppTool`.

use rust_cli_kernel_api::app_tool::{AppToolError, AppToolRefusal};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::KernelError;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{answer, parse};

#[test]
fn the_request_names_the_session_the_server_the_tool_and_its_prompt_id() {
    let params = json!({
        "requestKey": "helper-1",
        "sessionId": "s1",
        "serverName": "plugin:viewer:view",
        "toolName": "search",
        "input": {"query": "q"},
        "tool": {"inputSchema": {"type": "object"}},
    });
    let call = parse(&params, CancellationToken::new()).unwrap();
    assert_eq!(call.session, SessionId::new("s1"));
    assert_eq!(
        (call.server.as_str(), call.tool.as_str()),
        ("plugin:viewer:view", "search")
    );
    assert_eq!(call.input, json!({"query": "q"}));
    assert_eq!(call.descriptor, json!({"inputSchema": {"type": "object"}}));
    assert_eq!(call.tool_use.as_str(), "helper-1");
    // Node's `args ?? {}`.
    let bare = json!({"requestKey": "k", "sessionId": "s1", "serverName": "a", "toolName": "b"});
    assert_eq!(
        parse(&bare, CancellationToken::new()).unwrap().input,
        json!({})
    );
    for missing in ["requestKey", "sessionId", "serverName", "toolName"] {
        let mut params = params.clone();
        params.as_object_mut().unwrap().remove(missing);
        let error = parse(&params, CancellationToken::new()).unwrap_err();
        assert_eq!(error.message, format!("{missing} is required"));
    }
}

#[test]
fn the_answer_is_the_input_or_a_typed_refusal() {
    assert_eq!(
        answer(Ok(json!({"query": "q"}))).unwrap(),
        json!({"input": {"query": "q"}})
    );
    let denied = answer(Err(AppToolError::Refused(
        AppToolRefusal::PermissionDenied("denied".to_owned()),
    )))
    .unwrap_err();
    assert_eq!(denied.message, "denied");
    assert_eq!(denied.data, Some(json!({"type": "permission_denied"})));
    let invalid = answer(Err(AppToolError::Refused(AppToolRefusal::InvalidInput(
        "bad".to_owned(),
    ))))
    .unwrap_err();
    assert_eq!(invalid.data, Some(json!({"type": "invalid_input"})));
    // Any other failure carries no type: the helper reports it as a failed call, not a denial.
    let missing = answer(Err(AppToolError::Kernel(KernelError::NotFound {
        session: SessionId::new("s1"),
    })))
    .unwrap_err();
    assert_eq!(missing.data, None);
}
