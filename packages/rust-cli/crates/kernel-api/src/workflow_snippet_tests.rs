//! Fork (W7-11, 9.44): the late slot of the snippet port. Before the composition sets it, every call is a failure that
//! names the missing port; after it, the calls reach the port.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use super::{
    LateSnippetPort, SnippetCheck, SnippetOutcome, SnippetRequest, WorkflowSnippetError,
    WorkflowSnippetPort,
};

struct Fixed;

#[async_trait]
impl WorkflowSnippetPort for Fixed {
    async fn check(&self, _code: &str) -> Result<SnippetCheck, WorkflowSnippetError> {
        Ok(SnippetCheck::Diagnostics(Vec::new()))
    }

    async fn eval(&self, _request: SnippetRequest) -> Result<SnippetOutcome, WorkflowSnippetError> {
        Ok(SnippetOutcome::Completed {
            value: None,
            logs: vec!["from the port".to_owned()],
            logs_truncated: false,
        })
    }
}

fn request() -> SnippetRequest {
    SnippetRequest {
        code: "return 1".to_owned(),
        cwd: PathBuf::from("/work"),
        timeout_ms: 1_000,
    }
}

#[tokio::test]
async fn an_unset_slot_fails_each_call_with_the_missing_port_named() {
    let slot = LateSnippetPort::default();
    let check = slot.check("return 1").await.expect_err("no port yet");
    assert!(check.message.contains("not composed"), "{check}");
    let eval = slot.eval(request()).await.expect_err("no port yet");
    assert!(eval.message.contains("not composed"), "{eval}");
}

#[tokio::test]
async fn a_set_slot_delegates_to_its_port_and_keeps_the_first() {
    let slot = LateSnippetPort::default();
    assert!(slot.set(Arc::new(Fixed)));
    assert!(!slot.set(Arc::new(Fixed)), "a second set is refused");
    let outcome = slot.eval(request()).await.expect("delegated");
    assert!(matches!(outcome, SnippetOutcome::Completed { .. }));
    assert!(matches!(
        slot.check("x").await,
        Ok(SnippetCheck::Diagnostics(_))
    ));
}
