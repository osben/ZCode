//! The run lifecycle of the workflow engine (Node `engine/engine.ts` with `engine-settlement.ts`):
//! creation or resume, the run-level settlement paths, retune and usage. The engine has no clock and
//! no I/O of its own; the journal and the driver are injected (`JournalPort`, `WorkflowDriver`).
//!
//! Not here yet (spec 9.2, "remaining"): the ask scheduler, site ordinals, hold rules and replay
//! order, settlement of in-flight asks, holes, artifacts, reports, the import cache and the resume
//! restore of counters from journal rows. Settlement with no asks in flight is complete.
use crate::error::{ErrorCode, WorkflowError};
use crate::event::{LaunchFields, RunEvent};
use crate::journal::JournalPort;
use crate::model::{Caps, RunRow, RunStatus, Settlement, StopReason};
use anyhow::Result;
use serde_json::Value;

/// Node `EngineConfig`, for the fields the lifecycle uses.
#[derive(Debug, Clone, Default)]
pub struct EngineConfig {
    pub run_id: String,
    pub caps: Caps,
    pub script_text: Option<String>,
    pub script_hash: Option<String>,
    pub name: Option<String>,
    pub args: Option<Value>,
    pub parent_session_id: Option<String>,
    pub cwd: Option<String>,
    pub tool_call_id: Option<String>,
    pub resumed_from: Option<String>,
    /// Host metadata for `run-launched`; the origin fields come from this config (as in Node).
    pub launch: Option<LaunchFields>,
    pub inherited_tokens: Option<f64>,
}

/// The driver side of the port: where events go (Node `WorkflowDriver.emit`) and the release hook
/// (`WorkflowDriver.dispose`, called once per settlement after `run-settled`).
pub trait WorkflowDriver {
    fn emit(&mut self, event: &RunEvent);
    fn dispose(&mut self) {}
}

impl<T: WorkflowDriver + ?Sized> WorkflowDriver for &mut T {
    fn emit(&mut self, event: &RunEvent) {
        (**self).emit(event);
    }

    fn dispose(&mut self) {
        (**self).dispose();
    }
}

/// Final settlement (Node `RunSettlement`). `error` is the journal shape of the run error.
#[derive(Debug, Clone, PartialEq)]
pub enum RunSettlement {
    Completed {
        artifact: Value,
    },
    Errored {
        error: Value,
    },
    Stopped {
        reason: StopReason,
        superseded_by: Option<String>,
        error: Option<Value>,
    },
}

pub struct WorkflowEngine<J: JournalPort, D: WorkflowDriver> {
    run_id: String,
    journal: J,
    driver: D,
    caps: Caps,
    spent_tokens: f64,
    settlement: Option<RunSettlement>,
}

impl<J: JournalPort, D: WorkflowDriver> WorkflowEngine<J, D> {
    /// Create the run, or resume it when the journal already has a row for `run_id` (Node constructor).
    ///
    /// Fails with `ScriptHashMismatch` before any write when a resumed script differs from the recorded
    /// one. The check runs only when both hashes are present.
    pub fn new(config: EngineConfig, mut journal: J, driver: D) -> Result<Self> {
        let existing = journal.get_run(&config.run_id)?;
        let spent_tokens = match &existing {
            None => {
                let spent_tokens = normalize_inherited(config.inherited_tokens);
                journal.create_run(RunRow {
                    run_id: config.run_id.clone(),
                    parent_session_id: config.parent_session_id.clone(),
                    cwd: config.cwd.clone(),
                    name: config.name.clone(),
                    tool_call_id: config.tool_call_id.clone(),
                    script_text: config.script_text.clone(),
                    script_hash: config.script_hash.clone(),
                    args: config.args.clone(),
                    resumed_from: config.resumed_from.clone(),
                    caps: config.caps,
                    spent_tokens,
                    status: RunStatus::Running,
                    stop_reason: None,
                    superseded_by: None,
                    failure: None,
                    result: None,
                })?;
                spent_tokens
            }
            Some(row) => {
                if let (Some(recorded), Some(got)) = (&row.script_hash, &config.script_hash)
                    && recorded != got
                {
                    return Err(WorkflowError::new(
                        ErrorCode::ScriptHashMismatch,
                        format!(
                            "Cannot resume run {}: its script changed (recorded hash {recorded}, got {got}). Resume needs the byte-identical script; to run a revised script, start a new run with resume_from instead.",
                            config.run_id
                        ),
                    )
                    .with_mismatch(recorded, got)
                    .into());
                }
                journal.update_run_status(
                    &config.run_id,
                    RunStatus::Running,
                    &Settlement::default(),
                )?;
                row.spent_tokens
            }
        };
        let mut engine = Self {
            run_id: config.run_id.clone(),
            journal,
            driver,
            caps: config.caps,
            spent_tokens,
            settlement: None,
        };
        engine.record(&RunEvent::RunStarted {
            run_id: config.run_id.clone(),
            caps: config.caps,
        })?;
        if existing.is_none()
            && let Some(mut launch) = config.launch
        {
            launch.tool_call_id = config.tool_call_id.clone();
            launch.parent_session_id = config.parent_session_id.clone();
            engine.record(&RunEvent::RunLaunched(Box::new(launch)))?;
        }
        if spent_tokens > 0.0 {
            engine.record(&RunEvent::UsageUpdated { spent_tokens })?;
        }
        Ok(engine)
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn caps(&self) -> Caps {
        self.caps
    }

    pub fn spent_tokens(&self) -> f64 {
        self.spent_tokens
    }

    pub fn settlement(&self) -> Option<&RunSettlement> {
        self.settlement.as_ref()
    }

    /// Node `log`: a no-op after settlement.
    pub fn log(&mut self, message: &str) -> Result<()> {
        if self.is_settled() {
            return Ok(());
        }
        self.record(&RunEvent::Log {
            message: message.to_owned(),
        })
    }

    /// Node `askStats` for the run-level usage: the total is persisted at once; the event is emitted only
    /// while the run is live. Late stats after settlement update accounting only.
    ///
    /// The total is added before the journal write, as Node does (`spentTokens += tokens`, then
    /// `updateRunUsage`). When the write fails, the in-memory total stays ahead of the row until the
    /// next successful usage write; the next call writes the full total again. Do not move the add
    /// after the write: that changes which total a retry persists.
    pub fn record_usage(&mut self, tokens: f64) -> Result<()> {
        self.spent_tokens += tokens;
        self.journal
            .update_run_usage(&self.run_id, self.spent_tokens)?;
        if self.is_settled() {
            return Ok(());
        }
        self.record(&RunEvent::UsageUpdated {
            spent_tokens: self.spent_tokens,
        })
    }

    /// Node `setMaxConcurrency`. Returns whether anything changed. A non-finite value, a settled run,
    /// and an unchanged value are no-ops. The value is floored and raised to at least 1.
    ///
    /// The caps are replaced before the journal write, as Node does (`this.caps = caps`, then
    /// `updateRunCaps`). When the write fails, the engine keeps the new value and the row keeps the old
    /// one, and a retry with the same value returns `Ok(false)` because the engine already holds it.
    /// The row then stays stale until the next change of the value. This matches Node; a caller that
    /// needs the row to converge must retry with a different value.
    pub fn set_max_concurrency(&mut self, max_concurrency: f64) -> Result<bool> {
        if self.is_settled() || !max_concurrency.is_finite() {
            return Ok(false);
        }
        let previous = self.caps;
        let next = Caps {
            max_concurrency: max_concurrency.floor().max(1.0),
        };
        if next.max_concurrency == previous.max_concurrency {
            return Ok(false);
        }
        self.caps = next;
        self.journal.update_run_caps(&self.run_id, next)?;
        self.record(&RunEvent::RunCapsChanged {
            run_id: self.run_id.clone(),
            caps: next,
            previous,
        })?;
        Ok(true)
    }

    /// Node `complete`: the script returned. First settlement wins.
    pub fn complete(&mut self, artifact: Value) -> Result<()> {
        if self.is_settled() {
            return Ok(());
        }
        self.settlement = Some(RunSettlement::Completed {
            artifact: artifact.clone(),
        });
        self.finish_run(
            RunStatus::Completed,
            None,
            None,
            None,
            Settlement {
                result: Some(artifact),
                ..Settlement::default()
            },
        )
    }

    /// Node `stop`: settle as `stopped(reason)`. Completed work stays resumable. First settlement wins.
    pub fn stop(
        &mut self,
        reason: StopReason,
        error: Option<WorkflowError>,
        superseded_by: Option<String>,
    ) -> Result<()> {
        if self.is_settled() {
            return Ok(());
        }
        let failure = error.as_ref().map(WorkflowError::to_json);
        self.settlement = Some(RunSettlement::Stopped {
            reason,
            superseded_by: superseded_by.clone(),
            error: failure.clone(),
        });
        self.finish_run(
            RunStatus::Stopped,
            Some(reason),
            superseded_by.clone(),
            failure.clone(),
            Settlement {
                stop_reason: Some(reason),
                superseded_by,
                failure,
                result: None,
            },
        )
    }

    /// Node `fail`: the run failed (script error or host failure). First settlement wins.
    pub fn fail(&mut self, error: WorkflowError) -> Result<()> {
        if self.is_settled() {
            return Ok(());
        }
        let failure = error.to_json();
        self.settlement = Some(RunSettlement::Errored {
            error: failure.clone(),
        });
        self.finish_run(
            RunStatus::Errored,
            None,
            None,
            Some(failure.clone()),
            Settlement {
                failure: Some(failure),
                ..Settlement::default()
            },
        )
    }

    fn is_settled(&self) -> bool {
        self.settlement.is_some()
    }

    /// Node `finishRun`: the journal status first, then `run-settled`, then dispose. The event carries
    /// only the stop reason, successor and error, never the artifact.
    ///
    /// The settlement latch is set by the caller before this runs (`complete`, `stop` and `fail` write
    /// `self.settlement` first), as Node's `markSettled()` precedes `finishRun`. So when the status write
    /// fails, the engine is still settled: `run-settled` is not appended, dispose is not called, and a
    /// retry of the same settlement is a no-op returning `Ok(())`. The journal row keeps its previous
    /// status until someone else writes it. Do not reorder the latch after the write: a retry would then
    /// settle twice. Pinned by `engine_tests`.
    fn finish_run(
        &mut self,
        status: RunStatus,
        stop_reason: Option<StopReason>,
        superseded_by: Option<String>,
        error: Option<Value>,
        settlement: Settlement,
    ) -> Result<()> {
        self.journal
            .update_run_status(&self.run_id, status, &settlement)?;
        self.record(&RunEvent::RunSettled {
            status,
            stop_reason,
            superseded_by,
            error,
        })?;
        self.driver.dispose();
        Ok(())
    }

    fn record(&mut self, event: &RunEvent) -> Result<()> {
        self.journal.append_event(&self.run_id, event)?;
        self.driver.emit(event);
        Ok(())
    }
}

/// Node: `Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0`.
fn normalize_inherited(value: Option<f64>) -> f64 {
    match value {
        Some(tokens) if tokens.is_finite() => tokens.floor().max(0.0),
        _ => 0.0,
    }
}
