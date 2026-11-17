//! The journal port over the W2 repository (`rust-cli-node-store`, `dwf_*` in Node's row format).
//!
//! The engine core never sees SQL. This adapter maps the port's records onto the repository's records
//! and converts numbers: `dwf_run` stores integers, so a non-integer cap or token count is an error
//! here, not a silent truncation. `now` is the row timestamp source (the caller's clock); it never
//! feeds a decision in the engine.
use crate::event::RunEvent;
use crate::journal::JournalPort;
use crate::model::{Caps, RunRow, RunStatus, Settlement, StopReason, StoredEvent};
use anyhow::{Result, bail};
use rusqlite::Connection;
use rust_cli_base::js::json::stringify;
use rust_cli_node_store::dwf::{
    self, RunRecord as DwfRun, RunStatus as DwfStatus, Settlement as DwfSettlement,
    StopReason as DwfStop,
};

pub struct DwfJournal<'a> {
    conn: &'a Connection,
    clock: fn() -> i64,
}

impl<'a> DwfJournal<'a> {
    /// `conn` is a session database with Node's migrations applied (`open_session_database`).
    pub fn new(conn: &'a Connection, clock: fn() -> i64) -> Self {
        Self { conn, clock }
    }
}

/// Accepts the integers an `i64` holds: `[-2^63, 2^63)`. The upper bound is `2^63` written as an
/// exact `f64` literal, because `i64::MAX as f64` rounds up to `2^63` and would let `2^63` through.
fn integer(value: f64, what: &str) -> Result<i64> {
    const LOWER: f64 = i64::MIN as f64;
    const UPPER_EXCLUSIVE: f64 = 9_223_372_036_854_775_808.0;
    if value.is_finite() && value.fract() == 0.0 && (LOWER..UPPER_EXCLUSIVE).contains(&value) {
        return Ok(value as i64);
    }
    bail!("dwf_run stores integers: {what} is {value}")
}

fn status_to_dwf(status: RunStatus) -> DwfStatus {
    match status {
        RunStatus::Pending => DwfStatus::Pending,
        RunStatus::Running => DwfStatus::Running,
        RunStatus::Completed => DwfStatus::Completed,
        RunStatus::Errored => DwfStatus::Errored,
        RunStatus::Stopped => DwfStatus::Stopped,
    }
}

fn status_from_dwf(status: DwfStatus) -> RunStatus {
    match status {
        DwfStatus::Pending => RunStatus::Pending,
        DwfStatus::Running => RunStatus::Running,
        DwfStatus::Completed => RunStatus::Completed,
        DwfStatus::Errored => RunStatus::Errored,
        DwfStatus::Stopped => RunStatus::Stopped,
    }
}

fn stop_to_dwf(reason: StopReason) -> DwfStop {
    match reason {
        StopReason::User => DwfStop::User,
        StopReason::Model => DwfStop::Model,
        StopReason::Provider => DwfStop::Provider,
        StopReason::Interrupted => DwfStop::Interrupted,
        StopReason::Superseded => DwfStop::Superseded,
    }
}

fn stop_from_dwf(reason: DwfStop) -> StopReason {
    match reason {
        DwfStop::User => StopReason::User,
        DwfStop::Model => StopReason::Model,
        DwfStop::Provider => StopReason::Provider,
        DwfStop::Interrupted => StopReason::Interrupted,
        DwfStop::Superseded => StopReason::Superseded,
    }
}

fn row_to_dwf(row: &RunRow) -> Result<DwfRun> {
    Ok(DwfRun {
        run_id: row.run_id.clone(),
        parent_session_id: row.parent_session_id.clone(),
        cwd: row.cwd.clone(),
        name: row.name.clone(),
        tool_call_id: row.tool_call_id.clone(),
        script_text: row.script_text.clone(),
        script_hash: row.script_hash.clone(),
        args: row.args.clone(),
        resumed_from: row.resumed_from.clone(),
        max_concurrency: integer(row.caps.max_concurrency, "maxConcurrency")?,
        spent_tokens: integer(row.spent_tokens, "spentTokens")?,
        status: status_to_dwf(row.status),
        stop_reason: row.stop_reason.map(stop_to_dwf),
        superseded_by: row.superseded_by.clone(),
        failure: row.failure.clone(),
        result: row.result.clone(),
    })
}

fn row_from_dwf(run: DwfRun) -> RunRow {
    RunRow {
        run_id: run.run_id,
        parent_session_id: run.parent_session_id,
        cwd: run.cwd,
        name: run.name,
        tool_call_id: run.tool_call_id,
        script_text: run.script_text,
        script_hash: run.script_hash,
        args: run.args,
        resumed_from: run.resumed_from,
        caps: Caps {
            max_concurrency: run.max_concurrency as f64,
        },
        spent_tokens: run.spent_tokens as f64,
        status: status_from_dwf(run.status),
        stop_reason: run.stop_reason.map(stop_from_dwf),
        superseded_by: run.superseded_by,
        failure: run.failure,
        result: run.result,
    }
}

impl JournalPort for DwfJournal<'_> {
    fn create_run(&mut self, row: RunRow) -> Result<()> {
        dwf::create_run(self.conn, &row_to_dwf(&row)?, (self.clock)())
    }

    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>> {
        Ok(dwf::get_run(self.conn, run_id)?.map(row_from_dwf))
    }

    fn update_run_status(
        &mut self,
        run_id: &str,
        status: RunStatus,
        settlement: &Settlement,
    ) -> Result<()> {
        let dwf_settlement = DwfSettlement {
            stop_reason: settlement.stop_reason.map(stop_to_dwf),
            superseded_by: settlement.superseded_by.clone(),
            failure: settlement.failure.clone(),
            result: settlement.result.clone(),
        };
        dwf::update_run_status(
            self.conn,
            run_id,
            status_to_dwf(status),
            Some(&dwf_settlement),
            (self.clock)(),
        )
    }

    fn update_run_usage(&mut self, run_id: &str, spent_tokens: f64) -> Result<()> {
        dwf::update_run_usage(
            self.conn,
            run_id,
            integer(spent_tokens, "spentTokens")?,
            (self.clock)(),
        )
    }

    fn update_run_caps(&mut self, run_id: &str, caps: Caps) -> Result<()> {
        dwf::update_run_caps(
            self.conn,
            run_id,
            integer(caps.max_concurrency, "maxConcurrency")?,
            (self.clock)(),
        )
    }

    fn append_event(&mut self, run_id: &str, event: &RunEvent) -> Result<StoredEvent> {
        let stored = dwf::append_event(self.conn, run_id, &event.to_json(), (self.clock)())?;
        Ok(StoredEvent {
            sequence: u64::try_from(stored.sequence)?,
            payload_json: stringify(&stored.event),
        })
    }

    fn list_events(&self, run_id: &str) -> Result<Vec<StoredEvent>> {
        dwf::list_events(self.conn, run_id)?
            .into_iter()
            .map(|stored| {
                Ok(StoredEvent {
                    sequence: u64::try_from(stored.sequence)?,
                    payload_json: stringify(&stored.event),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::integer;

    #[test]
    fn integer_bounds_are_half_open_at_two_to_the_63() {
        assert_eq!(
            integer(-9_223_372_036_854_775_808.0, "x").unwrap(),
            i64::MIN
        );
        assert!(integer(9_223_372_036_854_775_808.0, "x").is_err());
        assert_eq!(
            integer(9_223_372_036_854_774_784.0, "x").unwrap(),
            9_223_372_036_854_774_784
        );
    }

    #[test]
    fn non_integers_and_non_finite_values_are_rejected() {
        assert!(integer(2.5, "x").is_err());
        assert!(integer(f64::NAN, "x").is_err());
        assert!(integer(f64::INFINITY, "x").is_err());
        assert!(integer(-9_223_372_036_854_777_856.0, "x").is_err());
    }
}
