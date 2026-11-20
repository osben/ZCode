//! Fork: the quota auto-resume port over the run service (specs/fork-rust-workflow-engine.md, 9.31, W7-5b).
//!
//! The module that decides when a quota-stopped run resumes is `rust_cli_workflow::quota_resume`. This file is what it
//! needs from the world: the run rows (a narrow read trait, so the run list of 5a-4 can implement it later without a
//! second by-parent query), and the resume itself. There is no run-level resume in Rust yet (kernel-api's `resume` is
//! unsupported, and `workflow/src/resume.rs` has only the settle order), so production answers through
//! [`UnwiredResume`], a refusal the module logs and does not retry (9.31, divergence 232).

use std::sync::Arc;

use rust_cli_workflow::model::RunRow;
use rust_cli_workflow::quota_resume::{QuotaResumePort, Refusal, ResumeAnswer};

/// The run rows the quota module reads. A read that fails is logged by the module and ends the attempt.
pub trait QuotaRunReads: Send + Sync {
    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>, String>;
    /// The session's recent runs, newest first, at most `limit` (Node `listRunsByParentSession`).
    fn list_session_runs(
        &self,
        parent_session_id: &str,
        limit: usize,
    ) -> Result<Vec<RunRow>, String>;
}

/// The resume a quota auto-resume asks for. Answers as the module's port does: resumed, or refused.
pub trait QuotaRunResumer: Send + Sync {
    fn resume(&self, run_id: &str) -> Result<ResumeAnswer, String>;
}

/// The production resumer until a run-level resume exists. It refuses with a reason that no retry matches, so the
/// module logs the refusal once per timer and moves on.
pub struct UnwiredResume;

/// The refusal reason [`UnwiredResume`] gives (logged as `dynamic_workflow.quota_resume.refused`).
pub const RESUME_NOT_WIRED: &str = "resume_not_wired";

impl QuotaRunResumer for UnwiredResume {
    fn resume(&self, _run_id: &str) -> Result<ResumeAnswer, String> {
        Ok(ResumeAnswer::Refused(Refusal::Other(
            RESUME_NOT_WIRED.to_owned(),
        )))
    }
}

/// One session's view of the quota port: its runs, and the resume.
pub struct SessionQuotaPort {
    session: String,
    reads: Arc<dyn QuotaRunReads>,
    resumer: Arc<dyn QuotaRunResumer>,
}

impl SessionQuotaPort {
    pub fn new(
        session: String,
        reads: Arc<dyn QuotaRunReads>,
        resumer: Arc<dyn QuotaRunResumer>,
    ) -> Self {
        Self {
            session,
            reads,
            resumer,
        }
    }
}

impl QuotaResumePort for SessionQuotaPort {
    /// Only this session's rows are read through the port (finding 9): another session's run is absent here.
    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>, String> {
        Ok(self
            .reads
            .get_run(run_id)?
            .filter(|row| row.parent_session_id.as_deref() == Some(self.session.as_str())))
    }

    fn list_session_runs(&self, limit: usize) -> Result<Vec<RunRow>, String> {
        self.reads.list_session_runs(&self.session, limit)
    }

    /// A resume is forwarded only for this session's run (finding 9). Any other run is refused without reaching the
    /// resumer, with the reason Node gives for a run that cannot be resumed.
    fn resume(&self, run_id: &str) -> Result<ResumeAnswer, String> {
        if self.get_run(run_id)?.is_none() {
            return Ok(ResumeAnswer::Refused(Refusal::Other(
                "run_not_in_session".to_owned(),
            )));
        }
        self.resumer.resume(run_id)
    }
}
