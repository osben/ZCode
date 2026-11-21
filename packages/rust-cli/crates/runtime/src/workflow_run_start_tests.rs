//! Tests of the hub's direct start (specs/fork-rust-workflow-engine.md, 9.53, W9a). The journal is a real session database in
//! a temp directory and the owner is the production owner factory; the child is `FakeChildRunner`, which answers the compile
//! with the tables of a healthy script. The sink records what the parent is told.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::FakeChildRunner;
use rust_cli_kernel_api::workflow_analysis::{
    WorkflowAnalysis, WorkflowAnalysisError, WorkflowAnalyzer, WorkflowDiagnostic,
};
use rust_cli_kernel_api::workflow_child::{
    ChildHandler, LaunchError, LaunchInput, RunningChild, WorkflowChildRunner,
};
use rust_cli_kernel_api::workflow_run::{
    LaunchTurn, SettingsTurn, StartRefusal, StartSavedOutcome, StartSavedRequest, WorkflowTurnSink,
};
use rust_cli_node_store::dwf;
use rust_cli_tools::workflow_start::Scope;
use rust_cli_workflow::residency::SessionResidency;
use rust_cli_workflow::run_concurrency::{ConcurrencyListener, RunConcurrency};
use rust_cli_workflow::run_store::SqliteRunStore;
use serde_json::{Map, Value, json};

use super::start::{bounded_diagnostics, launch_text};
use crate::workflow_owner::{
    ActorBindingsPort, OwnerStores, ParentBindings, UnwiredRelease, UnwiredTurns,
    production_owner_factory,
};
use crate::workflow_run::WorkflowRunService;

const PARENT: &str = "ses_p";
const DEFAULT: usize = 6;

/// A metadata block and a one-line script, as a saved file holds them.
const SAVED: &str = "/* zcode-workflow\ndescription: test\n*/\nreturn 2\n";

fn compiled_facts() -> Value {
    json!({
        "askSpecs": { "plain": { "typed": false } },
        "sitePhases": { "plain": "main" },
        "scriptHash": "fake-0",
    })
}

struct WithCompiled {
    fake: Arc<FakeChildRunner>,
}

#[async_trait]
impl WorkflowChildRunner for WithCompiled {
    async fn start(
        &self,
        input: LaunchInput,
        handler: Arc<dyn ChildHandler>,
    ) -> Result<RunningChild, LaunchError> {
        let mut running = self.fake.start(input, handler).await?;
        running.compiled = compiled_facts();
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

struct Mode;

impl ActorBindingsPort for Mode {
    fn parent_bindings(&self, _parent: &str) -> Result<Option<ParentBindings>, String> {
        Ok(None)
    }

    fn parent_permission_mode(&self, _parent: &str) -> Result<Option<PermissionMode>, String> {
        Ok(Some(PermissionMode::Default))
    }
}

/// The compile checker a test gives the service: a fixed verdict.
struct Verdict(WorkflowAnalysis);

#[async_trait]
impl WorkflowAnalyzer for Verdict {
    async fn analyze(&self, _script: &str) -> Result<WorkflowAnalysis, WorkflowAnalysisError> {
        Ok(self.0.clone())
    }
}

fn clean() -> Arc<dyn WorkflowAnalyzer> {
    Arc::new(Verdict(WorkflowAnalysis {
        model_references: Vec::new(),
        display: None,
        ok: true,
        diagnostics: Vec::new(),
    }))
}

/// The sink a test reads: how many activations and which launch turns the parent was given.
#[derive(Default)]
struct Recorder {
    activated: Mutex<usize>,
    launches: Mutex<Vec<LaunchTurn>>,
}

impl WorkflowTurnSink for Recorder {
    fn activate(&self) -> bool {
        *self.activated.lock().expect("the recorder") += 1;
        true
    }

    fn settings_turn(&self, _turn: SettingsTurn) {}

    fn launch_turn(&self, turn: LaunchTurn) {
        self.launches.lock().expect("the recorder").push(turn);
    }
}

fn open(path: &Path) -> rusqlite::Connection {
    rust_cli_node_store::open_session_database(path, Duration::from_secs(1), 0)
        .expect("session database")
        .0
}

fn add_session(conn: &rusqlite::Connection, id: &str) {
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values (?, 'proj', null, ?, '/work', 'title', '0.0.0', 1, 1)",
        rusqlite::params![id, id],
    )
    .expect("session row for the run's parent");
}

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    service: WorkflowRunService,
    fake: Arc<FakeChildRunner>,
}

/// A service over a temp session database, with the saved-start ports set to `analyzer` (none when `None`).
fn fixture(analyzer: Option<Arc<dyn WorkflowAnalyzer>>) -> Fixture {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("session.db");
    let conn = open(&path);
    add_session(&conn, PARENT);
    let store = Arc::new(SqliteRunStore::new(conn, || 500));
    let fake = Arc::new(FakeChildRunner::new());
    let runner: Arc<dyn WorkflowChildRunner> = Arc::new(WithCompiled { fake: fake.clone() });
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
    service.configure_concurrency(DEFAULT as f64);
    service.configure_bindings(Arc::new(Mode));
    let home = dir.path().join("home");
    let cwd = dir.path().join("cwd");
    if let Some(analyzer) = analyzer {
        service.configure_saved_start(home.clone(), analyzer);
    }
    Fixture {
        _dir: dir,
        path,
        home,
        cwd,
        service,
        fake,
    }
}

/// Writes a saved workflow in the user's home, where the global scope reads it.
fn save_global(fx: &Fixture, name: &str, text: &str) {
    let dir = fx.home.join(".zcode/workflows");
    rust_cli_fs::ensure_dir(&dir).expect("the global scope");
    rust_cli_fs::write_text(&dir.join(format!("{name}.dwf.ts")), text).expect("the saved file");
}

fn request(cwd: &Path, name: &str) -> StartSavedRequest {
    StartSavedRequest {
        cwd: cwd.display().to_string(),
        name: name.to_owned(),
        scope: Some("global".to_owned()),
        args: None,
    }
}

#[tokio::test]
async fn a_service_without_its_saved_start_ports_is_unsupported() {
    let fx = fixture(None);
    let error = fx
        .service
        .start_saved(PARENT, request(&fx.cwd, "digest"), &Recorder::default())
        .await
        .expect_err("the capability is absent");
    assert!(error.is_unsupported(), "{}", error.message);
    assert!(fx.fake.launches().is_empty());
}

#[tokio::test]
async fn an_unknown_name_is_refused_and_the_parent_is_not_touched() {
    let fx = fixture(Some(clean()));
    let sink = Recorder::default();
    let answer = fx
        .service
        .start_saved(PARENT, request(&fx.cwd, "missing"), &sink)
        .await
        .expect("the refusal is an answer");
    assert_eq!(
        answer,
        StartSavedOutcome::Refused(StartRefusal::NotFound {
            message: "No global workflow named 'missing'.".to_owned()
        })
    );
    assert_eq!(*sink.activated.lock().expect("sink"), 0);
    assert!(sink.launches.lock().expect("sink").is_empty());
    assert!(fx.fake.launches().is_empty());
}

#[tokio::test]
async fn a_script_with_diagnostics_is_refused_before_anything_starts() {
    let analyzer = Arc::new(Verdict(WorkflowAnalysis {
        model_references: Vec::new(),
        display: None,
        ok: false,
        diagnostics: vec![WorkflowDiagnostic {
            code: 1,
            line: 3,
            column: 5,
            message: "boom".to_owned(),
        }],
    }));
    let fx = fixture(Some(analyzer));
    save_global(&fx, "digest", SAVED);
    let sink = Recorder::default();
    let answer = fx
        .service
        .start_saved(PARENT, request(&fx.cwd, "digest"), &sink)
        .await
        .expect("the refusal is an answer");
    assert_eq!(
        answer,
        StartSavedOutcome::Refused(StartRefusal::CompileFailed {
            message: "The saved workflow 'digest' has errors:\nL3:C5 boom".to_owned()
        })
    );
    assert_eq!(
        *sink.activated.lock().expect("sink"),
        0,
        "no activation before a clean compile"
    );
    assert!(fx.fake.launches().is_empty());
}

#[tokio::test]
async fn a_clean_start_activates_the_parent_submits_and_records_the_launch_turn() {
    let fx = fixture(Some(clean()));
    save_global(&fx, "digest", SAVED);
    let sink = Recorder::default();
    let answer = fx
        .service
        .start_saved(PARENT, request(&fx.cwd, "digest"), &sink)
        .await
        .expect("the start answers");
    let StartSavedOutcome::Started {
        run_id,
        tool_call_id,
    } = answer
    else {
        panic!("a clean script starts: {answer:?}");
    };
    assert!(tool_call_id.starts_with("launch-"), "{tool_call_id}");
    assert!(
        run_id.as_str().starts_with("dwfrun-"),
        "{}",
        run_id.as_str()
    );
    assert_eq!(*sink.activated.lock().expect("sink"), 1);
    let launches = sink.launches.lock().expect("sink");
    assert_eq!(launches.len(), 1);
    assert_eq!(launches[0].run_id, run_id);
    assert_eq!(launches[0].tool_call_id, tool_call_id);
    assert_eq!(launches[0].name, "digest");
    assert_eq!(
        launches[0].text,
        format!(
            "Started the saved workflow \"digest\" (global) from the workflows hub as run {}.\n\nProgress and results arrive as background notifications; do not start it again.",
            run_id.as_str()
        )
    );
    assert_eq!(fx.fake.launches().len(), 1, "the run is submitted once");
}

/// 9.65 (closes 916): the launch turn carries Node's `workflowLaunch` facts: the definition's scope, path and
/// description, its script, and the analysis display only when it is a create window (Node
/// `display?.kind === "create_workflow"`).
#[tokio::test]
async fn the_launch_turn_carries_the_definition_and_its_create_window() {
    let window = json!({"kind": "create_workflow", "causalityGraph": {"steps": []}});
    for (display, carried) in [
        (Some(window.clone()), Some(window.clone())),
        (Some(json!({"kind": "other"})), None),
        (None, None),
    ] {
        let analyzer: Arc<dyn WorkflowAnalyzer> = Arc::new(Verdict(WorkflowAnalysis {
            model_references: Vec::new(),
            display,
            ok: true,
            diagnostics: Vec::new(),
        }));
        let fx = fixture(Some(analyzer));
        save_global(&fx, "digest", SAVED);
        let sink = Recorder::default();
        fx.service
            .start_saved(PARENT, request(&fx.cwd, "digest"), &sink)
            .await
            .expect("the start answers");
        let launches = sink.launches.lock().expect("sink");
        let turn = &launches[0];
        assert_eq!(turn.scope, "global");
        assert!(turn.path.ends_with("digest.dwf.ts"), "{}", turn.path);
        assert_eq!(turn.description, "test");
        assert!(turn.script.contains("return 2"), "{}", turn.script);
        assert_eq!(turn.args, None, "a workflow without arguments sends none");
        assert_eq!(turn.display, carried);
    }
}

#[test]
fn the_launch_text_carries_the_arguments_as_a_json_block_when_there_are_some() {
    let mut args = Map::new();
    args.insert("topic".to_owned(), json!("rust"));
    let resolved = rust_cli_tools::workflow_start::ResolvedStart {
        name: "digest".to_owned(),
        scope: Scope::Project,
        script: "return 1".to_owned(),
        source: String::new(),
        args,
        path: "digest.ts".to_owned(),
        description: String::new(),
    };
    let text = launch_text(&resolved, "dwfrun-1");
    assert!(
        text.contains("Arguments:\n```json\n{\n  \"topic\": \"rust\"\n}\n```"),
        "{text}"
    );
    assert!(text.starts_with(
        "Started the saved workflow \"digest\" (project) from the workflows hub as run dwfrun-1."
    ));
}

#[test]
fn a_long_compile_message_is_cut_at_the_limit_with_an_ellipsis() {
    let diagnostics: Vec<WorkflowDiagnostic> = (0..200)
        .map(|line| WorkflowDiagnostic {
            code: 1,
            line,
            column: 1,
            message: "a diagnostic with a long message that repeats".to_owned(),
        })
        .collect();
    let text = bounded_diagnostics("heading", &diagnostics);
    assert_eq!(text.chars().count(), 2_000);
    assert!(text.ends_with('…'));
}

#[tokio::test]
async fn a_clean_start_puts_its_v7_anchor_and_its_draft_on_the_run_row() {
    let fx = fixture(Some(clean()));
    save_global(&fx, "digest", SAVED);
    let answer = fx
        .service
        .start_saved(PARENT, request(&fx.cwd, "digest"), &Recorder::default())
        .await
        .expect("the start answers");
    let StartSavedOutcome::Started { run_id, .. } = answer else {
        panic!("a clean script starts: {answer:?}");
    };
    let conn = open(&fx.path);
    let payload = dwf::run_launched_payload(&conn, run_id.as_str())
        .expect("the journal reads")
        .expect("the run has its launched event");
    let input_id = payload["inputId"].as_str().expect("the launch anchor");
    assert_eq!(input_id.as_bytes()[14], b'7', "a v7 anchor: {input_id}");
    let script_path = payload["scriptPath"]
        .as_str()
        .expect("the draft copy is recorded");
    assert!(script_path.contains("digest"), "{script_path}");
}

/// Divergence 760 (W9a, corrected with #609): a hub-started run is a live run of its session, so it is listed as a background
/// work, titled by its saved name.
#[tokio::test]
async fn a_hub_started_run_is_listed_as_a_background_work_of_its_session() {
    use rust_cli_kernel_api::ids::SessionId;
    use rust_cli_kernel_api::workflow_run::DynamicWorkflowRunSessions;
    let fx = fixture(Some(clean()));
    save_global(&fx, "digest", SAVED);
    let answer = fx
        .service
        .start_saved(PARENT, request(&fx.cwd, "digest"), &Recorder::default())
        .await
        .expect("the start answers");
    let StartSavedOutcome::Started { run_id, .. } = answer else {
        panic!("a clean script starts: {answer:?}");
    };
    let listed = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .background_runs()
        .await
        .expect("the works are listed");
    let work = listed
        .iter()
        .find(|work| work.run_id == run_id)
        .unwrap_or_else(|| panic!("the hub run is a work of its session: {listed:?}"));
    assert_eq!(work.title, "digest");
}

/// 9.65 (closes 911), over the production owner and journal: the settled row is written before the settlement reads it,
/// so a completed run stays listed as `resultPending` with its end, not as `failed`.
#[tokio::test]
async fn a_completed_hub_run_stays_listed_as_result_pending_over_the_real_journal() {
    use rust_cli_kernel_api::ids::SessionId;
    use rust_cli_kernel_api::workflow_child::{Completion, Outcome};
    use rust_cli_kernel_api::workflow_run::{BackgroundRunStatus, DynamicWorkflowRunSessions};
    let fx = fixture(Some(clean()));
    save_global(&fx, "digest", SAVED);
    fx.service
        .start_saved(PARENT, request(&fx.cwd, "digest"), &Recorder::default())
        .await
        .expect("the start answers");
    fx.fake.finish(
        0,
        Outcome::Completed(Completion {
            ok: true,
            value: Some(json!(2)),
            error: None,
        }),
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while fx.service.run_count() > 0 {
        assert!(
            std::time::Instant::now() < deadline,
            "the completed run settles"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let listed = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .background_runs()
        .await
        .expect("the works are listed");
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0].status, BackgroundRunStatus::ResultPending);
    assert!(listed[0].ended_at_ms.is_some());
}
