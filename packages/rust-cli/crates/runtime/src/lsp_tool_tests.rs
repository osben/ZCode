use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::abort::Abort;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{AgentId, EnvironmentId, RunId, SessionId};
use rust_cli_kernel_api::lsp::{
    CodeIntelligence, FileMutation, LspOutput, LspQuery, LspQueryError,
};
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::model::{ApiMessage, ModelSelection, QuerySource};
use rust_cli_kernel_api::orchestration::{
    QueryError, QueryRequest, QueryRunner, QueryStop, RunSink,
};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::RecordingSink;
use tokio_util::sync::CancellationToken;

use super::LspToolRefresh;

type Events = Arc<Mutex<Vec<String>>>;

struct Recorder(Events);

#[async_trait]
impl CodeIntelligence for Recorder {
    async fn prewarm(&self, _session: &SessionId, _workspace: &WorkspaceRef, _path: &str) {}
    async fn file_mutated(
        &self,
        _session: &SessionId,
        _workspace: &WorkspaceRef,
        _mutation: FileMutation,
    ) {
    }
    async fn edit_diagnostics(&self, _session: &SessionId) -> Option<String> {
        None
    }
    fn session_closed(&self, _session: &SessionId) {}
    async fn refresh_tool(&self, session: &SessionId, workspace: &WorkspaceRef) {
        self.0.lock().unwrap().push(format!(
            "refresh {} {}",
            session.as_str(),
            workspace.root.as_str()
        ));
    }
    fn tool_offered(&self, _session: &SessionId) -> bool {
        false
    }
    async fn query(
        &self,
        _session: &SessionId,
        _workspace: &WorkspaceRef,
        _query: LspQuery,
        _cancel: &CancellationToken,
    ) -> Result<LspOutput, LspQueryError> {
        unreachable!("the runner never queries")
    }
}

struct Inner(Events);

#[async_trait]
impl QueryRunner for Inner {
    async fn run(
        &self,
        _request: QueryRequest,
        _sink: Arc<dyn RunSink>,
        _abort: Abort,
    ) -> Result<QueryStop, QueryError> {
        self.0.lock().unwrap().push("run".to_owned());
        Ok(QueryStop::Completed)
    }

    fn transcript(
        &self,
        _history: &[Message],
        _selection: &ModelSelection,
        _mid_system: Option<bool>,
    ) -> Vec<ApiMessage> {
        Vec::new()
    }
}

fn request() -> QueryRequest {
    QueryRequest::new(
        SessionId::new("s1"),
        RunId::new("r1"),
        WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/w"),
        },
        Vec::new(),
        ModelSelection::new("anthropic", "model"),
        PermissionMode::Default,
        QuerySource::MainThread,
    )
}

#[tokio::test]
async fn a_main_thread_run_refreshes_the_fact_before_it_starts_and_a_child_run_does_not() {
    let events = Events::default();
    let runner = LspToolRefresh {
        inner: Arc::new(Inner(events.clone())),
        code: Arc::new(Recorder(events.clone())),
    };
    runner
        .run(request(), Arc::new(RecordingSink::default()), Abort::new())
        .await
        .unwrap();
    let mut child = request();
    child.agent = Some(AgentId::new("agent_1"));
    runner
        .run(child, Arc::new(RecordingSink::default()), Abort::new())
        .await
        .unwrap();
    assert_eq!(*events.lock().unwrap(), ["refresh s1 /w", "run", "run"]);
}
