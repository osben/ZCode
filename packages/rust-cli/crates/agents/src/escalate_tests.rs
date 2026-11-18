//! `escalate` for a workflow actor (Node `tool/handlers/escalate.ts`): the answer or the refusal is the tool's text, a
//! refusal is an ordinary result (not an error), and a failed port fails the call.
use crate::actor_turn::{ActorEscalation, ActorPort, ActorQuestion, ActorSubmit};
use crate::escalate;
use async_trait::async_trait;
use rust_cli_kernel_api::ids::{RunId, SessionId};
use rust_cli_kernel_api::tool::ToolUseContext;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// The port, scripted for escalation: it records each question and answers with the reply it was given.
struct ScriptedPort {
    asked: Mutex<Vec<ActorQuestion>>,
    reply: Mutex<Result<ActorEscalation, String>>,
}

impl ScriptedPort {
    fn replying(reply: Result<ActorEscalation, String>) -> Arc<Self> {
        Arc::new(Self {
            asked: Mutex::new(Vec::new()),
            reply: Mutex::new(reply),
        })
    }
}

#[async_trait]
impl ActorPort for ScriptedPort {
    async fn submit(&self, _result: Value) -> Result<ActorSubmit, String> {
        Err("submit is not under test".to_owned())
    }

    async fn escalate(&self, question: ActorQuestion) -> Result<ActorEscalation, String> {
        self.asked.lock().expect("asked").push(question);
        self.reply.lock().expect("reply").clone()
    }
}

fn context() -> ToolUseContext {
    crate::test_support::tool_context(&SessionId::new("sess_a"), &RunId::new("run_1"))
}

async fn call(
    port: &Arc<ScriptedPort>,
    input: Value,
) -> Result<rust_cli_kernel_api::tool::ToolCallOutput, rust_cli_kernel_api::tool::ToolError> {
    let port: Arc<dyn ActorPort> = port.clone();
    let tool = escalate::tool(port);
    let (progress, _) = mpsc::channel(4);
    tool.call_with_messages(input, context(), progress).await
}

#[test]
fn the_escalate_tool_is_named_escalate() {
    let port: Arc<dyn ActorPort> = ScriptedPort::replying(Ok(ActorEscalation::Refused {
        reason: "budget".to_owned(),
        message: String::new(),
    }));
    assert_eq!(escalate::tool(port).name(), "escalate");
}

#[tokio::test]
async fn an_answer_is_the_tool_text_and_the_question_reaches_the_port_with_its_context() {
    let port = ScriptedPort::replying(Ok(ActorEscalation::Answered {
        qid: "q1".to_owned(),
        answer: "use the second gate".to_owned(),
    }));
    let output = call(
        &port,
        json!({"question": "which gate?", "context": "I tried both"}),
    )
    .await
    .expect("answered");
    assert_eq!(
        crate::test_support::text(&output.output),
        "use the second gate"
    );
    assert!(!output.stop_turn, "an answer does not end the turn");
    let asked = port.asked.lock().expect("asked");
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].question, "which gate?");
    assert_eq!(asked[0].context.as_deref(), Some("I tried both"));
}

#[tokio::test]
async fn a_refusal_is_the_tool_text_and_not_an_error() {
    let port = ScriptedPort::replying(Ok(ActorEscalation::Refused {
        reason: "budget".to_owned(),
        message: "Escalation budget exhausted; proceed on your own best judgement.".to_owned(),
    }));
    let output = call(&port, json!({"question": "again?"}))
        .await
        .expect("a refusal is an ordinary result");
    assert_eq!(
        crate::test_support::text(&output.output),
        "Escalation budget exhausted; proceed on your own best judgement."
    );
    assert_eq!(
        port.asked.lock().expect("asked")[0].context,
        None,
        "the context is optional"
    );
}

#[tokio::test]
async fn a_question_is_required() {
    let port = ScriptedPort::replying(Ok(ActorEscalation::Refused {
        reason: "budget".to_owned(),
        message: String::new(),
    }));
    let error = call(&port, json!({"context": "no question"}))
        .await
        .expect_err("the question is required");
    assert!(error.to_string().contains("question"), "{error}");
    assert!(port.asked.lock().expect("asked").is_empty());
}

#[tokio::test]
async fn a_failed_port_fails_the_call_with_its_text() {
    let port = ScriptedPort::replying(Err("the turn is gone".to_owned()));
    let error = call(&port, json!({"question": "anyone?"}))
        .await
        .expect_err("a failed port fails the call");
    assert!(error.to_string().contains("the turn is gone"), "{error}");
}

#[tokio::test]
async fn a_call_with_an_unknown_key_is_refused_before_the_port_as_node_strict_schema_refuses_it() {
    // Node's EscalateInputSchema is `.strict()`: an unknown key is refused, and the port is not asked.
    let port = ScriptedPort::replying(Ok(ActorEscalation::Refused {
        reason: "budget".to_owned(),
        message: String::new(),
    }));
    let error = call(&port, json!({"question": "q", "extra": 1}))
        .await
        .expect_err("an unknown key is refused");
    assert!(error.to_string().contains("extra"), "{error}");
    assert!(port.asked.lock().expect("asked").is_empty());
}

#[tokio::test]
async fn an_empty_question_is_refused_as_node_min_one_refuses_it() {
    let port = ScriptedPort::replying(Ok(ActorEscalation::Refused {
        reason: "budget".to_owned(),
        message: String::new(),
    }));
    let error = call(&port, json!({"question": ""}))
        .await
        .expect_err("Node's question has min(1)");
    assert!(error.to_string().contains("question"), "{error}");
    assert!(port.asked.lock().expect("asked").is_empty());
}

#[test]
fn the_declaration_refuses_unknown_keys_as_node_strict_schema_does() {
    let port: Arc<dyn ActorPort> = ScriptedPort::replying(Ok(ActorEscalation::Refused {
        reason: "budget".to_owned(),
        message: String::new(),
    }));
    assert_eq!(
        escalate::tool(port).input_schema()["additionalProperties"],
        json!(false)
    );
}

#[test]
fn a_cancelled_escalate_reports_nodes_text() {
    let port: Arc<dyn ActorPort> = ScriptedPort::replying(Ok(ActorEscalation::Refused {
        reason: "budget".to_owned(),
        message: String::new(),
    }));
    assert_eq!(
        escalate::tool(port)
            .cancel_message()
            .as_deref()
            .map(str::to_owned),
        Some("escalate was cancelled before the main agent answered".to_owned())
    );
}
