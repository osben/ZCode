//! Fork (W7-11, 9.44): the late slot of the snippet port. Before the composition sets it, every call is a failure that
//! names the missing port; after it, the calls reach the port.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use super::{
    LateSnippetPort, SnippetCheck, SnippetOutcome, SnippetRequest, WorkflowSnippetError,
    WorkflowSnippetPort,
};

/// A port that names itself in its eval's logs, so a test can tell which port answered.
struct Marked(&'static str);

#[async_trait]
impl WorkflowSnippetPort for Marked {
    async fn check(&self, _code: &str) -> Result<SnippetCheck, WorkflowSnippetError> {
        Ok(SnippetCheck::Diagnostics(Vec::new()))
    }

    async fn eval(&self, _request: SnippetRequest) -> Result<SnippetOutcome, WorkflowSnippetError> {
        Ok(SnippetOutcome::Completed {
            value: None,
            logs: vec![self.0.to_owned()],
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
    assert!(slot.set(Arc::new(Marked("first"))));
    assert!(
        !slot.set(Arc::new(Marked("second"))),
        "a second set is refused"
    );
    // The refused second port must not answer: the first one's marker comes back.
    let outcome = slot.eval(request()).await.expect("delegated");
    match outcome {
        SnippetOutcome::Completed { logs, .. } => assert_eq!(logs, ["first"]),
        other => panic!("expected the first port's completed outcome, got {other:?}"),
    }
    assert!(matches!(
        slot.check("x").await,
        Ok(SnippetCheck::Diagnostics(_))
    ));
}
