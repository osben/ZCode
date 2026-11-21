//! Tests of the run service's host reads and its orphan reconciliation over the dwf journal (W7-5a-4). The journal
//! is a real session database (`SqliteRunStore`); the child is `FakeChildRunner`, as in `workflow_run_tests`.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::testing::FakeChildRunner;
use rust_cli_kernel_api::workflow_child::LaunchInput;
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, DynamicWorkflowRunPort, DynamicWorkflowRunSessions, LifecycleStatus,
    ListQuery,
};
use rust_cli_node_store::dwf::{self, RunRecord, RunStatus as DwfStatus, StopReason as DwfStop};
use rust_cli_workflow::actor_mailbox::ActorMailbox;
use rust_cli_workflow::driver_owner::ActorDriverOwner;
use rust_cli_workflow::engine::{AskSpec, EngineConfig};
use rust_cli_workflow::import_build::{BuildOutcome, ImportRefusal};
use rust_cli_workflow::journal::MemoryJournal;
use rust_cli_workflow::model::RunRow;
use rust_cli_workflow::residency::SessionResidency;
use rust_cli_workflow::run_concurrency::{ConcurrencyListener, RunConcurrency};
use rust_cli_workflow::run_store::{RunListQuery, RunListRow, RunStore, SqliteRunStore};
use serde_json::{Map, Value, json};

use super::{Hosted, HostedOwner, OwnerFactory, WorkflowRunService};

const PARENT: &str = "ses_p";

/// The start time of every launch in these tests.
const START_MS: u64 = 1_000;

struct FixedClock;

impl rust_cli_kernel_api::clock::Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        START_MS
    }
    fn time_zone(&self) -> String {
        "UTC".to_owned()
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

#[derive(Default)]
struct Sessions;

impl rust_cli_workflow::driver_owner::ActorSessions for Sessions {
    fn create_session(
        &mut self,
        _request: &rust_cli_workflow::driver_owner::ActorSessionRequest,
    ) -> Result<String> {
        Ok("sess_1".to_owned())
    }
    fn start_turn(
        &mut self,
        _session: &str,
        _instance: &rust_cli_workflow::model::Ref,
        _message: &rust_cli_workflow::engine::AskMessage,
        _input: &rust_cli_workflow::actor_turns::TurnInput,
        _interaction: &str,
    ) -> Result<()> {
        Ok(())
    }
    fn cancel_turn(
        &mut self,
        _session: &str,
        _instance: &rust_cli_workflow::model::Ref,
    ) -> Result<()> {
        Ok(())
    }
    fn reject_parked(&mut self, _session: &str, _qid: &str) -> Result<()> {
        Ok(())
    }
    fn deliver_answer(&mut self, _session: &str, _qid: &str, _answer: &str) -> Result<()> {
        Ok(())
    }
    fn close_session(&mut self, _session: &str) -> Result<()> {
        Ok(())
    }
}

fn factory() -> OwnerFactory {
    Arc::new(|config: EngineConfig, mailbox: ActorMailbox, _handle| {
        let owner = ActorDriverOwner::new(config, MemoryJournal::new(), Sessions)?;
        Ok(Box::new(Hosted::new(owner, mailbox)) as Box<dyn HostedOwner>)
    })
}

fn database() -> rusqlite::Connection {
    let (conn, _) = rust_cli_node_store::open_session_database(
        Path::new(":memory:"),
        Duration::from_secs(1),
        0,
    )
    .expect("session database");
    conn
}

fn add_session(conn: &rusqlite::Connection, id: &str) {
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values (?, 'proj', null, ?, '/work', 'title', '0.0.0', 1, 1)",
        rusqlite::params![id, id],
    )
    .expect("session row for the run's parent");
}

/// A journal row as the engine would write it: parent, cwd "project", the given script and name.
fn seed(
    conn: &rusqlite::Connection,
    parent: Option<&str>,
    id: &str,
    status: DwfStatus,
    name: Option<&str>,
    script: &str,
    time: i64,
) {
    let run = RunRecord {
        run_id: id.to_owned(),
        parent_session_id: parent.map(str::to_owned),
        cwd: Some("project".to_owned()),
        name: name.map(str::to_owned),
        script_text: Some(script.to_owned()),
        max_concurrency: 4,
        status,
        ..RunRecord::default()
    };
    dwf::create_run(conn, &run, time).expect("seed run row");
}

struct Fixture {
    service: WorkflowRunService,
    runner: Arc<FakeChildRunner>,
    store: Arc<SqliteRunStore>,
}

/// A service with a store over a session database that `seed_rows` has filled.
fn fixture(seed_rows: impl FnOnce(&rusqlite::Connection)) -> Fixture {
    let conn = database();
    add_session(&conn, PARENT);
    add_session(&conn, "ses_other");
    seed_rows(&conn);
    let store = Arc::new(SqliteRunStore::new(conn, || 500));
    let runner = Arc::new(FakeChildRunner::new());
    let residency = Arc::new(SessionResidency::new());
    let service = WorkflowRunService::new(
        residency,
        Arc::new(NoConcurrency),
        runner.clone(),
        factory(),
    );
    service.set_store(store.clone());
    service.set_clock(Arc::new(FixedClock));
    Fixture {
        service,
        runner,
        store,
    }
}

fn input(run_id: &str) -> LaunchInput {
    LaunchInput {
        script_text: "return 1\n".to_owned(),
        run_id: run_id.to_owned(),
        args: Some(Map::new()),
        resumed_from: None,
        cwd: std::path::PathBuf::from("project"),
    }
}

fn config(run_id: &str) -> EngineConfig {
    config_in(run_id, PARENT)
}

fn config_in(run_id: &str, parent: &str) -> EngineConfig {
    let mut config = EngineConfig {
        run_id: run_id.to_owned(),
        parent_session_id: Some(parent.to_owned()),
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

fn port(service: &WorkflowRunService, session: &str) -> Arc<dyn DynamicWorkflowRunPort> {
    service.for_session(&SessionId::new(session))
}

async fn session_list(service: &WorkflowRunService) -> Value {
    port(service, PARENT)
        .list_runs_for_session(16)
        .await
        .expect("session list")
}

fn run_named<'a>(list: &'a Value, run_id: &str) -> &'a Value {
    list["runs"]
        .as_array()
        .expect("runs array")
        .iter()
        .find(|run| run["runId"] == run_id)
        .unwrap_or_else(|| panic!("run {run_id} is listed: {list}"))
}

async fn list_cwd(service: &WorkflowRunService, session: &str, limit: usize) -> Value {
    port(service, session)
        .list_runs(ListQuery {
            cwd: "project".to_owned(),
            limit,
            statuses: None,
        })
        .await
        .expect("list runs")
}

// ---- Orphan reconciliation (Node dynamic-workflow-run-reconcile.ts; service tests "构造时把本会话的非终态 run 收敛成 failed").

/// The production quota reads (9.31, divergence 231): one session's rows, read from the journal, and one row by id. A
/// sibling session's run is not in the session's list.
#[test]
fn the_quota_reads_list_one_sessions_runs_and_read_one_row() {
    use crate::workflow_quota::{QuotaRunReads, StoreQuotaReads};
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "dwfrun-mine",
            DwfStatus::Running,
            None,
            "return 1",
            1,
        );
        seed(
            conn,
            Some("ses_other"),
            "dwfrun-theirs",
            DwfStatus::Running,
            None,
            "return 2",
            1,
        );
    });
    let reads = StoreQuotaReads::new(fx.store);

    let mut ids: Vec<String> = reads
        .list_session_runs(PARENT, 10)
        .expect("the session's rows")
        .into_iter()
        .map(|row| row.run_id)
        .collect();
    ids.sort();
    assert_eq!(ids, vec!["dwfrun-mine".to_owned()]);

    let row = reads
        .get_run("dwfrun-mine")
        .expect("the row read")
        .expect("the row exists");
    assert_eq!(row.run_id, "dwfrun-mine");
    assert!(reads.get_run("dwfrun-missing").expect("read").is_none());
}

/// A cold session open runs the start-up sweep of its parent before anything else (9.30 item 212): the orphan a previous
/// process left running is settled as interrupted, and the other session's orphan is not touched.
#[tokio::test]
async fn a_session_open_settles_its_parents_orphans() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "dwfrun-orphan",
            DwfStatus::Running,
            None,
            "return 1",
            1,
        );
        seed(
            conn,
            Some("ses_other"),
            "dwfrun-sibling",
            DwfStatus::Running,
            None,
            "return 2",
            1,
        );
    });

    rust_cli_kernel_api::workflow_run::WorkflowRunHost::session_opened(&fx.service, PARENT).await;

    let orphan = fx.store.get_run("dwfrun-orphan").unwrap().expect("row");
    assert_eq!(orphan.status.as_str_for_test(), "stopped");
    let sibling = fx.store.get_run("dwfrun-sibling").unwrap().expect("row");
    assert_eq!(sibling.status.as_str_for_test(), "running");
}

#[tokio::test]
async fn reconcile_settles_the_sessions_non_terminal_runs_as_interrupted() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "dwfrun-running",
            DwfStatus::Running,
            None,
            "return 1",
            1,
        );
        seed(
            conn,
            Some(PARENT),
            "dwfrun-pending",
            DwfStatus::Pending,
            None,
            "return 2",
            1,
        );
    });

    let report = fx.service.reconcile_session(PARENT);

    assert_eq!(report.skipped, None);
    assert_eq!(report.reconciled.len(), 2);
    for run_id in ["dwfrun-running", "dwfrun-pending"] {
        let row = fx.store.get_run(run_id).unwrap().expect("row");
        assert_eq!(row.status.as_str_for_test(), "stopped");
        assert_eq!(
            row.stop_reason,
            Some(rust_cli_workflow::model::StopReason::Interrupted)
        );
        assert_eq!(
            row.failure.as_ref().and_then(|f| f["code"].as_str()),
            Some("Interrupted")
        );
        let message = row
            .failure
            .as_ref()
            .and_then(|f| f["message"].as_str())
            .unwrap();
        assert!(message.contains(run_id), "{message}");
    }
    let previous: Vec<&str> = report
        .reconciled
        .iter()
        .map(|(_, status)| status.as_str_for_test())
        .collect();
    assert!(previous.contains(&"pending") && previous.contains(&"running"));
}

#[tokio::test]
async fn reconcile_reports_each_converted_run_once() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "dwfrun-logged",
            DwfStatus::Running,
            None,
            "return 1",
            1,
        );
    });

    let report = fx.service.reconcile_session(PARENT);
    assert_eq!(
        report
            .reconciled
            .iter()
            .filter(|(id, _)| id == "dwfrun-logged")
            .count(),
        1
    );
    // A second construction finds nothing left to converge (Node: the second construction is idempotent).
    let again = fx.service.reconcile_session(PARENT);
    assert!(again.reconciled.is_empty());
}

#[tokio::test]
async fn reconcile_leaves_the_sessions_terminal_runs_alone() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "dwfrun-terminal-completed",
            DwfStatus::Completed,
            None,
            "return 1",
            1,
        );
        seed(
            conn,
            Some(PARENT),
            "dwfrun-terminal-errored",
            DwfStatus::Errored,
            None,
            "return 1",
            1,
        );
        seed(
            conn,
            Some(PARENT),
            "dwfrun-terminal-stopped",
            DwfStatus::Stopped,
            None,
            "return 1",
            1,
        );
    });

    let report = fx.service.reconcile_session(PARENT);

    assert!(report.reconciled.is_empty());
    assert_eq!(
        fx.store
            .get_run("dwfrun-terminal-completed")
            .unwrap()
            .unwrap()
            .status
            .as_str_for_test(),
        "completed"
    );
    assert_eq!(
        fx.store
            .get_run("dwfrun-terminal-stopped")
            .unwrap()
            .unwrap()
            .stop_reason,
        Some(rust_cli_workflow::model::StopReason::User),
        "stopped stays stopped(user): it is not reconciled as interrupted"
    );
    assert!(
        fx.store
            .get_run("dwfrun-terminal-completed")
            .unwrap()
            .unwrap()
            .failure
            .is_none()
    );
}

#[tokio::test]
async fn reconcile_leaves_sibling_sessions_and_parentless_runs_alone() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some("ses_other"),
            "dwfrun-sibling-live",
            DwfStatus::Running,
            None,
            "return 1",
            1,
        );
        seed(
            conn,
            None,
            "dwfrun-parentless",
            DwfStatus::Running,
            None,
            "return 1",
            1,
        );
    });

    let report = fx.service.reconcile_session(PARENT);

    assert!(report.reconciled.is_empty());
    assert_eq!(
        fx.store
            .get_run("dwfrun-sibling-live")
            .unwrap()
            .unwrap()
            .status
            .as_str_for_test(),
        "running"
    );
    assert_eq!(
        fx.store
            .get_run("dwfrun-parentless")
            .unwrap()
            .unwrap()
            .status
            .as_str_for_test(),
        "running"
    );
}

#[tokio::test]
async fn reconcile_does_not_touch_a_run_this_process_has_live() {
    // Spec 3.6: reconciliation runs only when this process holds no live run for the session. A row for a run
    // this process is executing is the engine's own write, never an orphan.
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "wf_live",
            DwfStatus::Running,
            None,
            "return 1",
            1,
        );
    });
    fx.service
        .launch(input("wf_live"), config("wf_live"))
        .await
        .expect("launched");

    let report = fx.service.reconcile_session(PARENT);

    assert!(report.reconciled.is_empty(), "{report:?}");
    assert_eq!(
        fx.store
            .get_run("wf_live")
            .unwrap()
            .unwrap()
            .status
            .as_str_for_test(),
        "running"
    );
    fx.service.close().await;
}

#[tokio::test]
async fn a_launch_after_reconcile_is_unaffected_and_the_orphan_stays_interrupted() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "dwfrun-orphan-before-submit",
            DwfStatus::Running,
            None,
            "return 1",
            1,
        );
    });
    fx.service.reconcile_session(PARENT);

    fx.service
        .launch(input("wf_new"), config("wf_new"))
        .await
        .expect("a new run launches after the sweep");
    assert_eq!(fx.runner.launches().len(), 1);
    assert_eq!(
        fx.store
            .get_run("dwfrun-orphan-before-submit")
            .unwrap()
            .unwrap()
            .status
            .as_str_for_test(),
        "stopped"
    );
    fx.service.close().await;
}

#[tokio::test]
async fn reconcile_without_a_store_is_skipped_with_a_reason() {
    let runner = Arc::new(FakeChildRunner::new());
    let service = WorkflowRunService::new(
        Arc::new(SessionResidency::new()),
        Arc::new(NoConcurrency),
        runner,
        factory(),
    );
    let report = service.reconcile_session(PARENT);
    assert_eq!(
        report.skipped,
        Some(super::orphans::SkipReason::JournalMissing)
    );
    assert_eq!(
        super::orphans::SkipReason::JournalMissing.code(),
        "journal_missing_list_non_terminal_runs"
    );
    assert!(report.reconciled.is_empty());
}

#[tokio::test]
async fn an_orphan_reads_back_as_stopped_interrupted_in_the_session_list() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "dwfrun-orphan-snapshot",
            DwfStatus::Running,
            None,
            "return 1",
            1,
        );
    });
    fx.service.reconcile_session(PARENT);

    let list = session_list(&fx.service).await;
    let run = run_named(&list, "dwfrun-orphan-snapshot");
    assert_eq!(run["status"], "stopped");
    assert_eq!(run["stopReason"], "interrupted");
    assert_eq!(run["failureCode"], "Interrupted");
    assert!(
        run["failureMessage"]
            .as_str()
            .unwrap()
            .contains("dwfrun-orphan-snapshot")
    );
    assert_eq!(run["resumable"], true, "an interrupted run can be resumed");
}

// ---- The session list (Node listRunsForSession and toSessionSummary).

#[tokio::test]
async fn the_session_list_is_the_sessions_rows_newest_first_in_the_v4_summary_shape() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "run_old",
            DwfStatus::Completed,
            Some("  Nightly  "),
            "return 1",
            10,
        );
        seed(
            conn,
            Some(PARENT),
            "run_new",
            DwfStatus::Running,
            None,
            "\n   \n  return   2\nmore",
            20,
        );
        seed(
            conn,
            Some("ses_other"),
            "run_foreign",
            DwfStatus::Running,
            None,
            "return 3",
            30,
        );
    });

    let list = session_list(&fx.service).await;
    let runs = list["runs"].as_array().unwrap();
    let ids: Vec<&str> = runs
        .iter()
        .map(|run| run["runId"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        ["run_new", "run_old"],
        "the sibling's run is not listed"
    );

    let new = run_named(&list, "run_new");
    assert_eq!(
        new["label"], "return   2",
        "first non-empty script line, trimmed"
    );
    assert_eq!(new["updatedAt"], 20);
    assert_eq!(new["status"], "running");
    assert_eq!(new["resumable"], false);
    assert!(new.get("stopReason").is_none() && new.get("failureCode").is_none());
    assert!(new.get("toolCallId").is_none() && new.get("resumedFrom").is_none());

    let old = run_named(&list, "run_old");
    assert_eq!(old["label"], "Nightly", "a name wins and is trimmed");
    assert_eq!(old["status"], "completed");
    assert_eq!(old["resumable"], false);
    assert!(
        old.get("labelSource").is_none(),
        "the session summary has no labelSource"
    );
}

#[tokio::test]
async fn a_live_run_with_a_terminal_row_reports_running_and_no_stop_fields() {
    // Node synthesizeRunStatus: an active entry with a terminal row is an external write; the entry wins.
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "wf_live",
            DwfStatus::Running,
            None,
            "return 1",
            1,
        );
    });
    fx.service
        .launch(input("wf_live"), config("wf_live"))
        .await
        .expect("launched");
    fx.store.interrupt_run("wf_live").unwrap();

    let list = session_list(&fx.service).await;
    let run = run_named(&list, "wf_live");
    assert_eq!(run["status"], "running");
    assert!(run.get("stopReason").is_none());
    assert!(run.get("failureCode").is_none() && run.get("failureMessage").is_none());
    assert_eq!(run["resumable"], false);
    fx.service.close().await;
}

#[tokio::test]
async fn a_run_stopped_by_the_user_is_resumable_and_a_superseded_one_is_not() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "run_user",
            DwfStatus::Stopped,
            None,
            "return 1",
            1,
        );
        let mut superseded = RunRecord {
            run_id: "run_superseded".to_owned(),
            parent_session_id: Some(PARENT.to_owned()),
            cwd: Some("project".to_owned()),
            script_text: Some("return 2".to_owned()),
            status: DwfStatus::Stopped,
            stop_reason: Some(DwfStop::Superseded),
            superseded_by: Some("run_successor".to_owned()),
            max_concurrency: 4,
            ..RunRecord::default()
        };
        superseded.failure = None;
        dwf::create_run(conn, &superseded, 2).unwrap();
    });

    let list = session_list(&fx.service).await;
    let user = run_named(&list, "run_user");
    assert_eq!(user["stopReason"], "user");
    assert_eq!(user["resumable"], true);
    let superseded = run_named(&list, "run_superseded");
    assert_eq!(superseded["stopReason"], "superseded");
    assert_eq!(superseded["supersededBy"], "run_successor");
    assert_eq!(superseded["resumable"], false);
}

#[tokio::test]
async fn the_session_list_is_empty_without_a_store() {
    let service = WorkflowRunService::new(
        Arc::new(SessionResidency::new()),
        Arc::new(NoConcurrency),
        Arc::new(FakeChildRunner::new()),
        factory(),
    );
    assert_eq!(session_list(&service).await, json!({"runs": []}));
}

// ---- The run list (Node listRuns): the gap complement, the probe row and the ownership markers.

#[tokio::test]
async fn a_launched_run_without_a_row_is_listed_as_pending_from_the_run_map() {
    // Node registryRunSummary: the gap between submit and the engine's first write.
    let fx = fixture(|_| {});
    fx.service
        .launch(input("wf_gap"), config("wf_gap"))
        .await
        .expect("launched");

    let list = list_cwd(&fx.service, PARENT, 10).await;
    let run = run_named(&list, "wf_gap");
    assert_eq!(run["status"], "pending");
    assert_eq!(run["label"], "return 1");
    assert_eq!(run["labelSource"], "script");
    assert_eq!(run["ownedByThisSession"], true);
    assert_eq!(run["spentTokens"].as_f64(), Some(0.0));
    assert_eq!(run["createdAt"], START_MS, "the start is the clock's");
    assert_eq!(run["updatedAt"], START_MS);
    assert!(run.get("possiblyInterrupted").is_none());
    fx.service.close().await;
}

#[tokio::test]
async fn the_run_list_marks_a_foreign_unsettled_run_as_possibly_interrupted() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some("ses_other"),
            "run_foreign",
            DwfStatus::Running,
            Some("Other"),
            "return 1",
            5,
        );
        seed(
            conn,
            Some(PARENT),
            "run_mine",
            DwfStatus::Completed,
            Some("Mine"),
            "return 2",
            6,
        );
    });

    let list = list_cwd(&fx.service, PARENT, 10).await;
    let foreign = run_named(&list, "run_foreign");
    assert_eq!(foreign["ownedByThisSession"], false);
    assert_eq!(foreign["possiblyInterrupted"], true);
    assert_eq!(foreign["labelSource"], "name");
    let mine = run_named(&list, "run_mine");
    assert_eq!(mine["ownedByThisSession"], true);
    assert!(
        mine.get("possiblyInterrupted").is_none(),
        "present only when true"
    );
}

#[tokio::test]
async fn the_run_list_pages_with_one_probe_row_and_reports_truncation_only_when_it_is_true() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "run_1",
            DwfStatus::Completed,
            None,
            "return 1",
            1,
        );
        seed(
            conn,
            Some(PARENT),
            "run_2",
            DwfStatus::Completed,
            None,
            "return 2",
            2,
        );
        seed(
            conn,
            Some(PARENT),
            "run_3",
            DwfStatus::Completed,
            None,
            "return 3",
            3,
        );
    });

    let page = list_cwd(&fx.service, PARENT, 2).await;
    assert_eq!(page["runs"].as_array().unwrap().len(), 2);
    assert_eq!(page["truncated"], true);

    let exact = list_cwd(&fx.service, PARENT, 3).await;
    assert_eq!(exact["runs"].as_array().unwrap().len(), 3);
    assert!(
        exact.get("truncated").is_none(),
        "an exact page is not truncated"
    );
}

#[tokio::test]
async fn the_run_list_with_an_empty_status_set_matches_nothing() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "run_1",
            DwfStatus::Completed,
            None,
            "return 1",
            1,
        );
    });
    let list = port(&fx.service, PARENT)
        .list_runs(ListQuery {
            cwd: "project".to_owned(),
            limit: 10,
            statuses: Some(Vec::new()),
        })
        .await
        .unwrap();
    assert_eq!(list, json!({"runs": []}));

    let stopped = port(&fx.service, PARENT)
        .list_runs(ListQuery {
            cwd: "project".to_owned(),
            limit: 10,
            statuses: Some(vec![LifecycleStatus::Stopped]),
        })
        .await
        .unwrap();
    assert_eq!(stopped, json!({"runs": []}));
}

#[tokio::test]
async fn the_run_list_without_a_store_is_unsupported_and_the_session_list_is_empty() {
    let service = WorkflowRunService::new(
        Arc::new(SessionResidency::new()),
        Arc::new(NoConcurrency),
        Arc::new(FakeChildRunner::new()),
        factory(),
    );
    let error: DynamicWorkflowRunError = port(&service, PARENT)
        .list_runs(ListQuery {
            cwd: "project".to_owned(),
            limit: 5,
            statuses: None,
        })
        .await
        .expect_err("unsupported without a store");
    assert!(error.message.contains("listRuns"), "{error}");
}

#[tokio::test]
async fn a_closed_service_still_lists_its_rows_and_its_sweep_is_skipped() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "run_1",
            DwfStatus::Running,
            None,
            "return 1",
            1,
        );
    });
    fx.service.close().await;
    let report = fx.service.reconcile_session(PARENT);
    assert_eq!(report.skipped, Some(super::orphans::SkipReason::Closed));
    assert!(report.reconciled.is_empty());
    assert_eq!(
        fx.store
            .get_run("run_1")
            .unwrap()
            .unwrap()
            .status
            .as_str_for_test(),
        "running",
        "a closed service does not write"
    );
}

// ---- Review round (ocr on #588): per-session registry, the orphan sweep's lock, the blocking reads, the gap order.

#[tokio::test]
async fn a_sibling_sessions_live_run_is_neither_listed_nor_owned_here() {
    // Node's registry is per parent session: a sibling's just-launched run is not this session's gap item, and a
    // sibling's unsettled row is not owned here (so it is possibly interrupted here).
    let fx = fixture(|conn| {
        seed(
            conn,
            Some("ses_other"),
            "wf_sib_row",
            DwfStatus::Running,
            None,
            "return 9",
            5,
        );
    });
    fx.service
        .launch(input("wf_sib_gap"), config_in("wf_sib_gap", "ses_other"))
        .await
        .expect("launched");

    let list = list_cwd(&fx.service, PARENT, 10).await;
    let ids: Vec<&str> = list["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|run| run["runId"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        ["wf_sib_row"],
        "the sibling's launch is not listed here"
    );
    let row = run_named(&list, "wf_sib_row");
    assert_eq!(row["ownedByThisSession"], false);
    assert_eq!(row["possiblyInterrupted"], true);

    let session = session_list(&fx.service).await;
    assert_eq!(
        session["runs"],
        json!([]),
        "the session list is this session's rows only"
    );
    fx.service.close().await;
}

/// A store that records the thread each read runs on, and that can probe the service's lock during a settlement.
struct Probe {
    inner: SqliteRunStore,
    service: std::sync::OnceLock<WorkflowRunService>,
    probe_during_interrupt: bool,
    read_threads: Mutex<Vec<std::thread::ThreadId>>,
}

impl Probe {
    fn note_read(&self) {
        self.read_threads
            .lock()
            .expect("read threads")
            .push(std::thread::current().id());
    }
}

impl RunStore for Probe {
    fn session_progress(
        &self,
        _parent_session_id: &str,
        _exclude: &std::collections::HashSet<String>,
        _default_concurrency: f64,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        Ok(Vec::new())
    }

    fn non_terminal_runs(&self, parent_session_id: &str) -> Result<Vec<RunRow>> {
        self.note_read();
        self.inner.non_terminal_runs(parent_session_id)
    }
    fn interrupt_run(&self, run_id: &str) -> Result<bool> {
        if self.probe_during_interrupt {
            // A call into the service from another thread: it needs the run map's lock, which a settlement must not hold.
            let service = self.service.get().expect("the service is set").clone();
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = sender.send(service.run_count());
            });
            receiver
                .recv_timeout(Duration::from_secs(2))
                .expect("the run map is not locked during the orphan write");
        }
        self.inner.interrupt_run(run_id)
    }
    fn runs_of_session(&self, parent_session_id: &str, limit: usize) -> Result<Vec<RunListRow>> {
        self.note_read();
        self.inner.runs_of_session(parent_session_id, limit)
    }
    fn list_runs(&self, query: &RunListQuery) -> Result<Vec<RunListRow>> {
        self.note_read();
        self.inner.list_runs(query)
    }
    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>> {
        self.note_read();
        self.inner.get_run(run_id)
    }

    fn amend_preflight(&self, predecessor_run_id: &str) -> Result<Result<RunRow, ImportRefusal>> {
        self.note_read();
        self.inner.amend_preflight(predecessor_run_id)
    }

    fn amend_import(&self, predecessor_run_id: &str) -> Result<BuildOutcome> {
        self.note_read();
        self.inner.amend_import(predecessor_run_id)
    }
}

fn probed(
    seed_rows: impl FnOnce(&rusqlite::Connection),
    probe_during_interrupt: bool,
) -> (WorkflowRunService, Arc<Probe>) {
    let conn = database();
    add_session(&conn, PARENT);
    add_session(&conn, "ses_other");
    seed_rows(&conn);
    let probe = Arc::new(Probe {
        inner: SqliteRunStore::new(conn, || 500),
        service: std::sync::OnceLock::new(),
        probe_during_interrupt,
        read_threads: Mutex::new(Vec::new()),
    });
    let service = WorkflowRunService::new(
        Arc::new(SessionResidency::new()),
        Arc::new(NoConcurrency),
        Arc::new(FakeChildRunner::new()),
        factory(),
    );
    probe.service.set(service.clone()).ok();
    service.set_store(probe.clone());
    service.set_clock(Arc::new(FixedClock));
    (service, probe)
}

#[tokio::test]
async fn the_orphan_sweep_does_not_hold_the_run_map_during_its_writes() {
    let (service, _probe) = probed(
        |conn| {
            seed(
                conn,
                Some(PARENT),
                "dwfrun-lock",
                DwfStatus::Running,
                None,
                "return 1",
                1,
            )
        },
        true,
    );
    let report = service.reconcile_session(PARENT);
    assert_eq!(report.reconciled.len(), 1, "{report:?}");
}

#[tokio::test]
async fn the_journal_reads_run_off_the_async_worker() {
    // A blocking SQLite read must not occupy the runtime's worker (Node's reads are synchronous, but this port is
    // async): the read runs on the blocking pool.
    let (service, probe) = probed(
        |conn| {
            seed(
                conn,
                Some(PARENT),
                "run_1",
                DwfStatus::Completed,
                None,
                "return 1",
                1,
            )
        },
        false,
    );
    let me = std::thread::current().id();
    session_list(&service).await;
    list_cwd(&service, PARENT, 5).await;
    let threads = probe.read_threads.lock().expect("read threads").clone();
    assert!(!threads.is_empty(), "the store was read");
    assert!(
        threads.iter().all(|thread| *thread != me),
        "a read ran on the async worker"
    );
}

#[tokio::test]
async fn gap_items_with_the_same_start_keep_their_submit_order() {
    // Node sorts the gap by createdAt with a stable sort over its registry, which is in submit order.
    let fx = fixture(|_| {});
    let names: Vec<String> = (0..8).map(|i| format!("wf_tie_{i}")).collect();
    for name in &names {
        fx.service
            .launch(input(name), config(name))
            .await
            .expect("launched");
    }
    let list = list_cwd(&fx.service, PARENT, 20).await;
    let ids: Vec<String> = list["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|run| run["runId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, names, "ties keep the order the runs were launched in");
    fx.service.close().await;
}

// ---- Re-review round (ocr on #588, second pass).

/// A store whose enumeration is followed by a settlement from another connection to the same database: the race
/// between a run's own settlement and the orphan sweep.
struct Racing {
    inner: SqliteRunStore,
    other: Mutex<rusqlite::Connection>,
    settle: String,
}

impl RunStore for Racing {
    fn session_progress(
        &self,
        _parent_session_id: &str,
        _exclude: &std::collections::HashSet<String>,
        _default_concurrency: f64,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        Ok(Vec::new())
    }

    fn non_terminal_runs(&self, parent_session_id: &str) -> Result<Vec<RunRow>> {
        let rows = self.inner.non_terminal_runs(parent_session_id)?;
        dwf::update_run_status(
            &self.other.lock().expect("other connection"),
            &self.settle,
            DwfStatus::Completed,
            None,
            2,
        )?;
        Ok(rows)
    }
    fn interrupt_run(&self, run_id: &str) -> Result<bool> {
        self.inner.interrupt_run(run_id)
    }
    fn runs_of_session(&self, parent_session_id: &str, limit: usize) -> Result<Vec<RunListRow>> {
        self.inner.runs_of_session(parent_session_id, limit)
    }
    fn list_runs(&self, query: &RunListQuery) -> Result<Vec<RunListRow>> {
        self.inner.list_runs(query)
    }
    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>> {
        self.inner.get_run(run_id)
    }

    fn amend_preflight(&self, predecessor_run_id: &str) -> Result<Result<RunRow, ImportRefusal>> {
        self.inner.amend_preflight(predecessor_run_id)
    }

    fn amend_import(&self, predecessor_run_id: &str) -> Result<BuildOutcome> {
        self.inner.amend_import(predecessor_run_id)
    }
}

fn open_on_disk(path: &Path) -> rusqlite::Connection {
    rust_cli_node_store::open_session_database(path, Duration::from_secs(1), 0)
        .expect("session database on disk")
        .0
}

#[test]
fn a_run_that_settles_after_it_was_listed_keeps_its_settlement() {
    // The engine writes `completed` between the orphan query and the orphan write. The guarded write leaves it.
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("session.db");
    let conn = open_on_disk(&path);
    add_session(&conn, PARENT);
    seed(
        &conn,
        Some(PARENT),
        "dwfrun-raced",
        DwfStatus::Running,
        None,
        "return 1",
        1,
    );
    let racing = Arc::new(Racing {
        inner: SqliteRunStore::new(conn, || 500),
        other: Mutex::new(open_on_disk(&path)),
        settle: "dwfrun-raced".to_owned(),
    });
    let service = WorkflowRunService::new(
        Arc::new(SessionResidency::new()),
        Arc::new(NoConcurrency),
        Arc::new(FakeChildRunner::new()),
        factory(),
    );
    service.set_store(racing.clone());

    let report = service.reconcile_session(PARENT);

    assert!(report.reconciled.is_empty(), "{report:?}");
    assert_eq!(report.raced, ["dwfrun-raced"]);
    let row = racing.get_run("dwfrun-raced").unwrap().expect("row");
    assert_eq!(row.status.as_str_for_test(), "completed");
    assert_eq!(row.stop_reason, None);
    assert!(row.failure.is_none());
}

#[tokio::test]
async fn the_orphan_sweep_runs_off_the_async_worker_on_request() {
    let fx = fixture(|conn| {
        seed(
            conn,
            Some(PARENT),
            "dwfrun-off-thread",
            DwfStatus::Running,
            None,
            "return 1",
            1,
        );
    });
    let report = fx.service.reconcile_session_off_thread(PARENT).await;
    assert_eq!(report.reconciled.len(), 1, "{report:?}");
}

#[tokio::test]
async fn a_second_store_or_clock_is_refused_and_the_first_one_stays() {
    let fx = fixture(|_| {});
    let other = Arc::new(SqliteRunStore::new(database(), || 9));
    assert!(!fx.service.set_store(other), "the store is set once");
    assert!(
        !fx.service.set_clock(Arc::new(FixedClock)),
        "the clock is set once"
    );
}

#[tokio::test]
async fn a_live_run_still_reports_the_successor_of_its_stopped_row() {
    // Node supersededByOf reads the row for an active entry too: only the terminal entry overrides it.
    let fx = fixture(|conn| {
        let run = RunRecord {
            run_id: "wf_live_succ".to_owned(),
            parent_session_id: Some(PARENT.to_owned()),
            cwd: Some("project".to_owned()),
            script_text: Some("return 1".to_owned()),
            status: DwfStatus::Stopped,
            stop_reason: Some(DwfStop::Superseded),
            superseded_by: Some("run_successor".to_owned()),
            max_concurrency: 4,
            ..RunRecord::default()
        };
        dwf::create_run(conn, &run, 1).expect("seed");
    });
    fx.service
        .launch(input("wf_live_succ"), config("wf_live_succ"))
        .await
        .expect("launched");

    let list = session_list(&fx.service).await;
    let run = run_named(&list, "wf_live_succ");
    assert_eq!(run["status"], "running");
    assert_eq!(run["supersededBy"], "run_successor");
    assert_eq!(run["resumable"], false);
    let listed = list_cwd(&fx.service, PARENT, 10).await;
    assert_eq!(
        run_named(&listed, "wf_live_succ")["supersededBy"],
        "run_successor"
    );
    fx.service.close().await;
}

// ---- Labels (Node resolveDynamicWorkflowRunLabel): JS trim, the 80-unit cut, and the fallbacks.

#[test]
fn a_label_is_the_trimmed_name_then_the_first_script_line_then_the_run_id() {
    use super::list::run_label;
    // U+FEFF is JS whitespace but not Rust's: a name of only a BOM is blank.
    assert_eq!(
        run_label("run_1", Some("\u{feff} Nightly \u{feff}"), Some("return 1")),
        ("Nightly".to_owned(), "name")
    );
    assert_eq!(
        run_label(
            "run_1",
            Some("\u{feff}"),
            Some("\n\u{feff}\n  return 2  \nmore")
        ),
        ("return 2".to_owned(), "script"),
        "a blank name falls through to the first non-blank script line"
    );
    assert_eq!(
        run_label("run_1", None, Some("  \n \n")),
        ("run_1".to_owned(), "script")
    );
    assert_eq!(
        run_label("run_1", None, None),
        ("run_1".to_owned(), "script")
    );
}

#[test]
fn a_label_is_cut_at_80_utf16_units_and_never_inside_a_character() {
    use super::list::run_label;
    let exact = "a".repeat(80);
    assert_eq!(run_label("r", None, Some(&exact)).0, exact);

    let over = "a".repeat(81);
    assert_eq!(run_label("r", None, Some(&over)).0, "a".repeat(80));

    // 79 ASCII units, then an astral character (two units): the pair straddles the cut and is dropped whole.
    let straddle = format!("{}😀", "a".repeat(79));
    assert_eq!(run_label("r", None, Some(&straddle)).0, "a".repeat(79));
}

/// The status name a list reports, for assertions on journal rows.
trait StatusName {
    fn as_str_for_test(&self) -> &'static str;
}

impl StatusName for rust_cli_workflow::model::RunStatus {
    fn as_str_for_test(&self) -> &'static str {
        use rust_cli_workflow::model::RunStatus as S;
        match self {
            S::Pending => "pending",
            S::Running => "running",
            S::Completed => "completed",
            S::Errored => "errored",
            S::Stopped => "stopped",
        }
    }
}
