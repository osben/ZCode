//! W8d (9.51, closes 723): a run settled through the run service posts exactly one terminal notice to its parent. The
//! owner is the production one over a real session database in a temp directory, so the settlement writes the row the
//! hook reads; the child is `FakeChildRunner`, as in `workflow_run_resume_tests`. Without `configure_terminal_notices`
//! the run settles and nothing is posted (the gate-off default).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use rust_cli_kernel_api::agents::{AgentSignal, AgentSignals};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::testing::FakeChildRunner;
use rust_cli_kernel_api::workflow_child::{
    ChildHandler, Completion, LaunchError, LaunchInput, Outcome, RunningChild, WorkflowChildRunner,
};
use rust_cli_workflow::engine::{AskSpec, EngineConfig};
use rust_cli_workflow::residency::SessionResidency;
use rust_cli_workflow::run_concurrency::{ConcurrencyListener, RunConcurrency};
use rust_cli_workflow::run_store::SqliteRunStore;
use serde_json::{Map, Value, json};

use crate::workflow_owner::{OwnerStores, UnwiredRelease, UnwiredTurns, production_owner_factory};
use crate::workflow_run::WorkflowRunService;

const PARENT: &str = "ses_p";

/// The notices the parent's channel was handed: session, text and origin fragment, in order.
#[derive(Default)]
struct Recorder(Mutex<Vec<(String, String, Option<Value>)>>);

#[async_trait]
impl AgentSignals for Recorder {
    fn signals(&self, _session: &SessionId) -> BoxStream<'static, AgentSignal> {
        Box::pin(futures_util::stream::pending())
    }

    async fn ack(&self, _session: &SessionId, _seq: u64) {}

    async fn background(&self, _session: &SessionId) -> Vec<rust_cli_kernel_api::ids::AgentId> {
        Vec::new()
    }

    fn workflow_notice(&self, session: &SessionId, text: String, workflow: Option<Value>) {
        self.0
            .lock()
            .expect("notices")
            .push((session.as_str().to_owned(), text, workflow));
    }
}

/// The compile's tables a healthy script reports (the helper's `askSpecs` and `sitePhases`).
fn compiled_facts() -> Value {
    json!({
        "askSpecs": { "plain": { "typed": false } },
        "sitePhases": { "plain": "main" },
        "scriptHash": "fake-0",
    })
}

/// The fake child with the compiled facts a launch needs. Everything else is the fake's.
struct WithCompiled {
    fake: Arc<FakeChildRunner>,
    compiled: Value,
}

#[async_trait]
impl WorkflowChildRunner for WithCompiled {
    async fn start(
        &self,
        input: LaunchInput,
        handler: Arc<dyn ChildHandler>,
    ) -> Result<RunningChild, LaunchError> {
        let mut running = self.fake.start(input, handler).await?;
        running.compiled = self.compiled.clone();
        Ok(running)
    }
}

struct NoConcurrency;

impl RunConcurrency for NoConcurrency {
    fn set_run_bound(&self, _run_id: &str, _bound: u64) {}
    fn clear_run_bound(&self, _run_id: &str) {}
    fn subscribe(&self, _run_id: &str, _listener: ConcurrencyListener) -> Box<dyn FnOnce() + Send> {
        Box::new(|| {})
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    service: WorkflowRunService,
    fake: Arc<FakeChildRunner>,
    recorder: Arc<Recorder>,
}

/// A service over a temp session database with the parent row. The recorder is the terminal sink only when `configured`.
fn fixture(configured: bool) -> Fixture {
    let dir = tempfile::tempdir().expect("temp dir");
    let path: PathBuf = dir.path().join("session.db");
    let conn = rust_cli_node_store::open_session_database(&path, Duration::from_secs(1), 0)
        .expect("session database")
        .0;
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values (?, 'proj', null, ?, '/work', 'title', '0.0.0', 1, 1)",
        rusqlite::params![PARENT, PARENT],
    )
    .expect("session row for the run's parent");
    let store = Arc::new(SqliteRunStore::new(conn, || 500));
    let fake = Arc::new(FakeChildRunner::new());
    let runner: Arc<dyn WorkflowChildRunner> = Arc::new(WithCompiled {
        fake: fake.clone(),
        compiled: compiled_facts(),
    });
    let factory = production_owner_factory(
        OwnerStores {
            database: path.clone(),
            directory: "project".to_owned(),
            version: "test".to_owned(),
            clock: || 1,
        },
        Arc::new(UnwiredTurns),
        Arc::new(UnwiredRelease),
    );
    let service = WorkflowRunService::new(
        Arc::new(SessionResidency::new()),
        Arc::new(NoConcurrency),
        runner,
        factory,
    );
    service.set_store(store);
    let recorder = Arc::new(Recorder::default());
    if configured {
        service.configure_terminal_notices(recorder.clone());
    }
    Fixture {
        _dir: dir,
        path: path.clone(),
        service,
        fake,
        recorder,
    }
}

fn input(run_id: &str) -> LaunchInput {
    LaunchInput {
        script_text: "return 1\n".to_owned(),
        run_id: run_id.to_owned(),
        args: Some(Map::new()),
        resumed_from: None,
        cwd: PathBuf::from("project"),
    }
}

fn config(run_id: &str) -> EngineConfig {
    let mut config = EngineConfig {
        run_id: run_id.to_owned(),
        parent_session_id: Some(PARENT.to_owned()),
        cwd: Some("project".to_owned()),
        ..Default::default()
    };
    config.caps.max_concurrency = 4.0;
    config.ask_specs.insert(
        "plain".into(),
        AskSpec {
            typed: false,
            schema: None,
        },
    );
    config
}

fn completed(value: Value) -> Outcome {
    Outcome::Completed(Completion {
        ok: true,
        value: Some(value),
        error: None,
    })
}

async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn a_settled_run_posts_exactly_one_terminal_notice_to_its_parent() {
    let f = fixture(true);
    f.service
        .launch(input("wf_1"), config("wf_1"))
        .await
        .expect("launched");
    f.fake.finish(0, completed(json!("done")));

    wait_until("the terminal notice", || {
        !f.recorder.0.lock().expect("notices").is_empty()
    })
    .await;
    // The owner settles once per launch and its settle path posts once, so the count is exact once the notice is in.
    wait_until("the run to be collected", || f.service.run_count() == 0).await;

    let posted = f.recorder.0.lock().expect("notices").clone();
    assert_eq!(posted.len(), 1, "one notice per settlement: {posted:?}");
    let (session, text, workflow) = &posted[0];
    assert_eq!(session, PARENT);
    assert!(
        text.starts_with("<task-notification>\n<task-id>wf_1</task-id>"),
        "{text}"
    );
    assert!(text.contains("<status>completed</status>"), "{text}");
    let workflow = workflow.as_ref().expect("the terminal payload");
    assert_eq!(workflow["workflowNotification"]["kind"], "terminal");
    assert_eq!(workflow["workflowNotification"]["status"], "completed");
}

#[tokio::test]
async fn a_service_without_terminal_notices_settles_the_run_and_posts_nothing() {
    let f = fixture(false);
    f.service
        .launch(input("wf_1"), config("wf_1"))
        .await
        .expect("launched");
    f.fake.finish(0, completed(json!("done")));

    wait_until("the run to be collected", || f.service.run_count() == 0).await;
    assert!(
        f.recorder.0.lock().expect("notices").is_empty(),
        "an unconfigured service has no sink, so nothing is posted"
    );
}

/// 9.61: the terminal payload carries the run's artifact chips, read from the journal's published records, with the
/// deliverable's description.
#[tokio::test]
async fn the_terminal_notice_carries_the_runs_published_artifact_chips() {
    let f = fixture(true);
    f.service
        .launch(input("wf_1"), config("wf_1"))
        .await
        .expect("launched");
    let conn = rust_cli_node_store::open_session_database(&f.path, Duration::from_secs(1), 0)
        .expect("a second connection")
        .0;
    wait_until("the run row", || {
        rust_cli_node_store::dwf::get_run(&conn, "wf_1")
            .ok()
            .flatten()
            .is_some()
    })
    .await;
    for (id, primary) in [("notes", false), ("board", true)] {
        let mut artifact = json!({"id": id, "kind": "markdown", "version": 1, "title": id});
        if primary {
            artifact["primary"] = json!(true);
            artifact["description"] = json!("the deliverable");
        }
        rust_cli_node_store::dwf::append_event(
            &conn,
            "wf_1",
            &json!({"type": "artifact-published", "instance": {"siteId": id, "ordinal": 1}, "artifact": artifact}),
            3,
        )
        .expect("an artifact event");
    }
    f.fake.finish(0, completed(json!("done")));

    wait_until("the terminal notice", || {
        !f.recorder.0.lock().expect("notices").is_empty()
    })
    .await;
    let posted = f.recorder.0.lock().expect("notices").clone();
    let workflow = posted[0].2.as_ref().expect("the terminal payload");
    assert_eq!(
        workflow["workflowNotification"]["artifacts"],
        json!([
            {"id": "board", "kind": "markdown", "title": "board", "version": 1, "primary": true, "description": "the deliverable"},
            {"id": "notes", "kind": "markdown", "title": "notes", "version": 1},
        ])
    );
}
