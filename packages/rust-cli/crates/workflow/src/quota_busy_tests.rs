//! 9.31 (ocr re-review): a module is idle only when no call of its own is in flight. Each test reads `is_idle()` from
//! inside the port's call (the probe), so the answer is taken at the point where a concurrent eviction could land.

use crate::model::{Caps, RunRow, RunStatus, StopReason};
use crate::quota_resume::{QuotaAutoResume, QuotaResumePort, ResumeAnswer};
use crate::test_clock::AdvancingClock;
use serde_json::json;
use std::sync::{Arc, Mutex};

const START: u64 = 1_792_051_200_000;
const HOUR: u64 = 3_600_000;

fn quota_row(run: &str, reset_at: u64) -> RunRow {
    RunRow {
        run_id: run.into(),
        parent_session_id: Some("ses_p".into()),
        cwd: None,
        name: None,
        tool_call_id: None,
        script_text: None,
        script_hash: None,
        args: None,
        resumed_from: None,
        caps: Caps::default(),
        spent_tokens: 0.0,
        status: RunStatus::Stopped,
        stop_reason: Some(StopReason::Provider),
        superseded_by: None,
        failure: Some(json!({
            "providerStop": { "kind": "quota", "reason": "rate_limited", "resetAt": reset_at },
        })),
        result: None,
    }
}

/// A port over fixed rows. Each call records whether the module it serves is idle, as seen inside that call.
#[derive(Default)]
struct ProbePort {
    rows: Vec<RunRow>,
    module: Mutex<Option<Arc<QuotaAutoResume>>>,
    seen: Mutex<Vec<(&'static str, bool)>>,
}

impl ProbePort {
    fn note(&self, call: &'static str) {
        let idle = self
            .module
            .lock()
            .unwrap()
            .as_ref()
            .map(|module| module.is_idle());
        if let Some(idle) = idle {
            self.seen.lock().unwrap().push((call, idle));
        }
    }

    /// Every probe of `call`, in order. Empty if the call never ran.
    fn idle_during(&self, call: &str) -> Vec<bool> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| *name == call)
            .map(|(_, idle)| *idle)
            .collect()
    }
}

impl QuotaResumePort for ProbePort {
    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>, String> {
        self.note("get_run");
        Ok(self.rows.iter().find(|row| row.run_id == run_id).cloned())
    }

    fn list_session_runs(&self, _limit: usize) -> Result<Vec<RunRow>, String> {
        self.note("list");
        Ok(self.rows.clone())
    }

    fn resume(&self, _run_id: &str) -> Result<ResumeAnswer, String> {
        self.note("resume");
        Ok(ResumeAnswer::Resumed)
    }
}

fn module_over(rows: Vec<RunRow>) -> (Arc<QuotaAutoResume>, Arc<ProbePort>, Arc<AdvancingClock>) {
    let port = Arc::new(ProbePort {
        rows,
        ..Default::default()
    });
    let clock = AdvancingClock::new(START);
    let module = Arc::new(QuotaAutoResume::new(port.clone(), clock.clone()));
    *port.module.lock().unwrap() = Some(module.clone());
    (module, port, clock)
}

/// A settlement reads its row while it is in flight: a concurrent eviction must not see the module as idle.
#[test]
fn a_settlement_is_not_idle_while_it_reads_its_row() {
    let (module, port, _clock) = module_over(vec![quota_row("run_a", START + 2 * HOUR)]);
    module.on_run_settled("run_a");
    assert_eq!(
        port.idle_during("get_run"),
        [false],
        "the module is busy while the settlement reads the row"
    );
}

/// A session scan reads its runs while it is in flight: the module is not idle then either.
#[test]
fn a_scan_is_not_idle_while_it_lists_the_session() {
    let (module, port, _clock) = module_over(vec![quota_row("run_a", START + 2 * HOUR)]);
    module.scan();
    assert_eq!(
        port.idle_during("list"),
        [false],
        "the module is busy while the scan lists the session"
    );
}

/// A timer job that resumes its run is not idle between taking its timer and finishing: a stale-disposal there would
/// lose the retry it may need.
#[test]
fn a_timer_job_is_not_idle_while_it_resumes() {
    let (module, port, clock) = module_over(vec![quota_row("run_due", START - HOUR)]);
    module.scan();
    clock.advance(0);
    assert_eq!(
        port.idle_during("resume"),
        [false],
        "the module is busy while its timer's resume is in flight"
    );
}
