//! `submit_result` for a workflow actor (Node `tool/handlers/submit-result.ts`): an accepted result ends the turn with
//! Node's text, a rejected one is a repairable error that names each violation, and only an actor that has a port gets
//! the tool.
use crate::actor_turn::{ActorPort, ActorSubmit, ActorViolation};
use crate::submit;
use async_trait::async_trait;
use rust_cli_kernel_api::ids::SessionId;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// The port, scripted: it records each result and answers with the reply it was given.
struct ScriptedPort {
    seen: Mutex<Vec<Value>>,
    reply: Mutex<Result<ActorSubmit, String>>,
}

impl ScriptedPort {
    fn replying(reply: Result<ActorSubmit, String>) -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(Vec::new()),
            reply: Mutex::new(reply),
        })
    }
}

#[async_trait]
impl ActorPort for ScriptedPort {
    async fn submit(&self, result: Value) -> Result<ActorSubmit, String> {
        self.seen.lock().expect("seen").push(result);
        self.reply.lock().expect("reply").clone()
    }
}

fn context() -> rust_cli_kernel_api::tool::ToolUseContext {
    crate::test_support::tool_context(
        &SessionId::new("sess_a"),
        &rust_cli_kernel_api::ids::RunId::new("run_1"),
    )
}

async fn call(
    port: &Arc<ScriptedPort>,
    input: Value,
) -> Result<rust_cli_kernel_api::tool::ToolCallOutput, rust_cli_kernel_api::tool::ToolError> {
    let port: Arc<dyn ActorPort> = port.clone();
    let tool = submit::tool(port);
    let (progress, _) = mpsc::channel(4);
    tool.call_with_messages(input, context(), progress).await
}

#[test]
fn the_submit_tool_is_named_submit_result() {
    let port: Arc<dyn ActorPort> = ScriptedPort::replying(Ok(ActorSubmit::Accepted));
    assert_eq!(submit::tool(port).name(), "submit_result");
}

#[tokio::test]
async fn an_accepted_result_ends_the_turn_with_node_text() {
    let port = ScriptedPort::replying(Ok(ActorSubmit::Accepted));
    let output = call(&port, json!({"result": {"ok": true}}))
        .await
        .expect("accepted");
    assert!(output.stop_turn, "a valid submission ends the actor's turn");
    assert_eq!(
        crate::test_support::text(&output.output),
        "The result was accepted."
    );
    assert_eq!(
        *port.seen.lock().expect("seen"),
        vec![json!({"ok": true})],
        "the result reaches the port as it was submitted"
    );
}

#[tokio::test]
async fn a_rejected_result_is_a_repairable_error_naming_each_violation() {
    let port = ScriptedPort::replying(Ok(ActorSubmit::Rejected(vec![ActorViolation {
        path: "$.ok".to_owned(),
        expected: "ok".to_owned(),
        got: "missing".to_owned(),
    }])));
    let error = call(&port, json!({"result": {}}))
        .await
        .expect_err("a rejected result is an error, so the turn goes on");
    assert_eq!(
        error.to_string(),
        "The submitted result does not match the required schema:\n$.ok: expected ok, got missing"
    );
}

#[tokio::test]
async fn a_call_with_an_unknown_key_is_refused_before_the_port_as_node_strict_schema_refuses_it() {
    let port = ScriptedPort::replying(Ok(ActorSubmit::Accepted));
    let error = call(&port, json!({"result": {"ok": true}, "extra": 1}))
        .await
        .expect_err("Node's SubmitResultInputSchema is strict: an unknown key is refused");
    assert!(error.to_string().contains("extra"), "{error}");
    assert!(port.seen.lock().expect("seen").is_empty());
}

#[test]
fn the_declaration_refuses_unknown_keys_as_node_strict_schema_does() {
    let port: Arc<dyn ActorPort> = ScriptedPort::replying(Ok(ActorSubmit::Accepted));
    assert_eq!(
        submit::tool(port).input_schema()["additionalProperties"],
        json!(false)
    );
}

#[test]
fn a_cancelled_submit_reports_nodes_text() {
    let port: Arc<dyn ActorPort> = ScriptedPort::replying(Ok(ActorSubmit::Accepted));
    assert_eq!(
        submit::tool(port)
            .cancel_message()
            .as_deref()
            .map(str::to_owned),
        Some("submit_result was cancelled before the engine returned a verdict".to_owned())
    );
}

#[tokio::test]
async fn a_call_without_a_result_is_invalid_input_and_reaches_no_port() {
    let port = ScriptedPort::replying(Ok(ActorSubmit::Accepted));
    let error = call(&port, json!({}))
        .await
        .expect_err("the result is required");
    assert!(error.to_string().contains("result"), "{error}");
    assert!(port.seen.lock().expect("seen").is_empty());
}

#[tokio::test]
async fn a_refused_port_fails_the_call_with_its_text() {
    let port = ScriptedPort::replying(Err("the turn is gone".to_owned()));
    let error = call(&port, json!({"result": 1}))
        .await
        .expect_err("a refused submit fails");
    assert!(error.to_string().contains("the turn is gone"), "{error}");
}

#[test]
fn only_an_actor_with_a_port_gets_the_submit_tool() {
    assert!(submit::tools_for(None).is_empty());
    let port: Arc<dyn ActorPort> = ScriptedPort::replying(Ok(ActorSubmit::Accepted));
    let tools = submit::tools_for(Some(&port));
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name(), "submit_result");
}
