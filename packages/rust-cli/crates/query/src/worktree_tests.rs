//! Fork: the step's context request carries the session's execution worktree fact, so the model is told about it
//! (specs/fork-rust-execution-worktree-context.md).

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::abort::Abort;
use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::message::{AttachmentMessage, Message};
use rust_cli_kernel_api::model::SystemBlock;
use rust_cli_kernel_api::orchestration::{
    BuiltContext, ContextBuilder, ContextRequest, OrchestrationError, RunSink, RunView,
};
use rust_cli_kernel_api::session_ops::ExecutionWorktreeFact;
use rust_cli_kernel_api::testing::{RecordingSink, ScriptedModel, text_response};

use crate::RunScope;
use crate::run::tests::{parts, request};

/// Records the execution worktree fact of every `build` request.
#[derive(Default)]
struct Recording {
    seen: Mutex<Vec<Option<ExecutionWorktreeFact>>>,
}

#[async_trait]
impl ContextBuilder for Recording {
    async fn build(
        &self,
        request: ContextRequest,
        _history: &[Message],
    ) -> Result<BuiltContext, OrchestrationError> {
        self.seen.lock().unwrap().push(request.execution_worktree);
        Ok(BuiltContext {
            system: vec![SystemBlock {
                text: "system".to_owned(),
                cache_control: None,
            }],
            attachments: Vec::<AttachmentMessage>::new(),
        })
    }
}

/// A session that runs in an execution worktree (or does not).
struct Sink {
    inner: RecordingSink,
    fact: Option<ExecutionWorktreeFact>,
}

#[async_trait]
impl rust_cli_kernel_api::testing::OpsOverride for Sink {
    async fn view(&self) -> Option<RunView> {
        let request = request("");
        Some(RunView {
            execution_worktree: self.fact.clone(),
            ..RunView::new(request.mode, request.workspace)
        })
    }
}

impl rust_cli_kernel_api::testing::AskOverride for Sink {}

impl rust_cli_kernel_api::testing::SinkOverride for Sink {
    fn sink(&self) -> &dyn RunSink {
        &self.inner
    }
}

async fn seen(fact: Option<ExecutionWorktreeFact>) -> Vec<Option<ExecutionWorktreeFact>> {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["done"])]));
    let context = Arc::new(Recording::default());
    let mut parts = parts(model, Vec::new());
    parts.context = context.clone();
    let request = request("go");
    let sink = Arc::new(Sink {
        inner: RecordingSink::default(),
        fact,
    });
    let scope = Arc::new(RunScope::new(&request, sink, parts, Abort::new()));
    crate::run::run(scope, request).await.unwrap();
    context.seen.lock().unwrap().clone()
}

#[tokio::test]
async fn the_request_carries_the_sessions_worktree() {
    let fact = ExecutionWorktreeFact {
        path: EnvPath::new("/w/.wt/a"),
        workspace: EnvPath::new("/w"),
        branch: Some("a".to_owned()),
        missing: false,
    };
    assert_eq!(seen(Some(fact.clone())).await, [Some(fact)]);
    assert_eq!(seen(None).await, [None]);
}
