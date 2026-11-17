//! The journal port over the W2 repository (`rust-cli-node-store`, `dwf_*` in Node's row format).
//!
//! The engine core never sees SQL. This adapter maps the port's records onto the repository's records
//! and converts numbers: `dwf_run` and `dwf_node` store integers, so a non-integer cap, token count or
//! ordinal is an error here, not a silent truncation. `now` is the row timestamp source (the caller's
//! clock); it never feeds a decision in the engine.
use crate::event::RunEvent;
use crate::journal::JournalPort;
use crate::model::{
    ActorRow, Caps, NodeKind, NodeRow, NodeStatus, Ref, RunRow, RunStatus, Settlement, StopReason,
    StoredEvent,
};
use anyhow::{Result, bail};
use rusqlite::Connection;
use rust_cli_base::js::json::stringify;
use rust_cli_node_store::dwf::{
    self, ActorRecord as DwfActor, NodeKind as DwfNodeKind, NodeRecord as DwfNode,
    NodeStatus as DwfNodeStatus, RunRecord as DwfRun, RunStatus as DwfStatus,
    Settlement as DwfSettlement, StopReason as DwfStop,
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

/// `what` names the field in the error, as `integer` does for caps and tokens.
fn ordinal_to_column(ordinal: u64, what: &str) -> Result<i64> {
    match i64::try_from(ordinal) {
        Ok(value) => Ok(value),
        Err(_) => bail!("dwf tables store integers: {what} is {ordinal}, above i64::MAX"),
    }
}

fn ordinal_from_column(ordinal: i64) -> Result<u64> {
    Ok(u64::try_from(ordinal)?)
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

fn kind_to_dwf(kind: NodeKind) -> DwfNodeKind {
    match kind {
        NodeKind::Ask => DwfNodeKind::Ask,
        NodeKind::WorldRead => DwfNodeKind::WorldRead,
        NodeKind::WorldRun => DwfNodeKind::WorldRun,
        NodeKind::Report => DwfNodeKind::Report,
        NodeKind::Artifact => DwfNodeKind::Artifact,
    }
}

fn kind_from_dwf(kind: DwfNodeKind) -> NodeKind {
    match kind {
        DwfNodeKind::Ask => NodeKind::Ask,
        DwfNodeKind::WorldRead => NodeKind::WorldRead,
        DwfNodeKind::WorldRun => NodeKind::WorldRun,
        DwfNodeKind::Report => NodeKind::Report,
        DwfNodeKind::Artifact => NodeKind::Artifact,
    }
}

fn node_status_to_dwf(status: NodeStatus) -> DwfNodeStatus {
    match status {
        NodeStatus::Running => DwfNodeStatus::Running,
        NodeStatus::Completed => DwfNodeStatus::Completed,
        NodeStatus::Failed => DwfNodeStatus::Failed,
    }
}

fn node_status_from_dwf(status: DwfNodeStatus) -> NodeStatus {
    match status {
        DwfNodeStatus::Running => NodeStatus::Running,
        DwfNodeStatus::Completed => NodeStatus::Completed,
        DwfNodeStatus::Failed => NodeStatus::Failed,
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

fn actor_to_dwf(row: &ActorRow) -> Result<DwfActor> {
    Ok(DwfActor {
        run_id: row.run_id.clone(),
        site_id: row.site_id.clone(),
        ordinal: ordinal_to_column(row.ordinal, "actor ordinal")?,
        name: row.name.clone(),
        persona: row.persona.clone(),
        session_id: row.session_id.clone(),
        resolved_model: row.resolved_model.clone(),
    })
}

fn actor_from_dwf(actor: DwfActor) -> Result<ActorRow> {
    Ok(ActorRow {
        run_id: actor.run_id,
        site_id: actor.site_id,
        ordinal: ordinal_from_column(actor.ordinal)?,
        name: actor.name,
        persona: actor.persona,
        session_id: actor.session_id,
        resolved_model: actor.resolved_model,
    })
}

fn node_to_dwf(row: &NodeRow) -> Result<DwfNode> {
    Ok(DwfNode {
        run_id: row.run_id.clone(),
        site_id: row.site_id.clone(),
        ordinal: ordinal_to_column(row.ordinal, "node ordinal")?,
        kind: kind_to_dwf(row.kind),
        actor_site_id: row.actor_site_id.clone(),
        actor_ordinal: row
            .actor_ordinal
            .map(|value| ordinal_to_column(value, "actor ordinal"))
            .transpose()?,
        actor_seq: row
            .actor_seq
            .map(|value| ordinal_to_column(value, "actor seq"))
            .transpose()?,
        input_hash: row.input_hash.clone(),
        status: node_status_to_dwf(row.status),
        result: row.result.clone(),
        error: row.error.clone(),
        stats: row.stats.clone(),
        // Placeholders: `put_node` fills these from the stored row before the full-row upsert.
        artifact_id: None,
        input: None,
        message_boundary: None,
    })
}

fn node_from_dwf(node: DwfNode) -> Result<NodeRow> {
    Ok(NodeRow {
        run_id: node.run_id,
        site_id: node.site_id,
        ordinal: ordinal_from_column(node.ordinal)?,
        kind: kind_from_dwf(node.kind),
        actor_site_id: node.actor_site_id,
        actor_ordinal: node.actor_ordinal.map(ordinal_from_column).transpose()?,
        actor_seq: node.actor_seq.map(ordinal_from_column).transpose()?,
        input_hash: node.input_hash,
        status: node_status_from_dwf(node.status),
        result: node.result,
        error: node.error,
        stats: node.stats,
    })
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

    fn put_actor(&mut self, row: ActorRow) -> Result<()> {
        dwf::put_actor(self.conn, &actor_to_dwf(&row)?, (self.clock)())
    }

    fn get_actor(&self, run_id: &str, actor: &Ref) -> Result<Option<ActorRow>> {
        dwf::get_actor(
            self.conn,
            run_id,
            &actor.site_id,
            ordinal_to_column(actor.ordinal, "actor ordinal")?,
        )?
        .map(actor_from_dwf)
        .transpose()
    }

    fn list_actors(&self, run_id: &str) -> Result<Vec<ActorRow>> {
        dwf::list_actors(self.conn, run_id)?
            .into_iter()
            .map(actor_from_dwf)
            .collect()
    }

    fn put_node(&mut self, row: NodeRow) -> Result<()> {
        // The repository's upsert rewrites every column. NodeRow has no artifact, input or boundary
        // field, so carry the stored values through; otherwise a full-row write erases what Node wrote.
        let mut node = node_to_dwf(&row)?;
        let stored = dwf::get_node(
            self.conn,
            &row.run_id,
            &row.site_id,
            ordinal_to_column(row.ordinal, "node ordinal")?,
        )?;
        if let Some(stored) = stored {
            node.artifact_id = stored.artifact_id;
            node.input = stored.input;
            node.message_boundary = stored.message_boundary;
        }
        dwf::put_node(self.conn, &node, (self.clock)())
    }

    fn get_node(&self, run_id: &str, instance: &Ref) -> Result<Option<NodeRow>> {
        dwf::get_node(
            self.conn,
            run_id,
            &instance.site_id,
            ordinal_to_column(instance.ordinal, "node ordinal")?,
        )?
        .map(node_from_dwf)
        .transpose()
    }

    fn list_nodes(&self, run_id: &str) -> Result<Vec<NodeRow>> {
        dwf::list_nodes(self.conn, run_id)?
            .into_iter()
            .map(node_from_dwf)
            .collect()
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

    #[test]
    fn an_ordinal_out_of_range_names_its_field() {
        let message = super::ordinal_to_column(u64::MAX, "node ordinal")
            .unwrap_err()
            .to_string();
        assert!(message.contains("node ordinal"), "{message}");
    }

    /// Node writes `artifact_id`, `input` and `message_boundary` on the node row. A full-row upsert from
    /// the port must not erase them.
    #[test]
    fn a_full_row_upsert_keeps_the_columns_the_port_does_not_carry() {
        use crate::journal::JournalPort;
        use crate::model::{Caps, NodeKind, NodeRow, NodeStatus, RunRow, RunStatus};
        use rust_cli_node_store::dwf::{NodeKind as DwfKind, NodeRecord, NodeStatus as DwfStatus};
        use std::path::Path;
        use std::time::Duration;

        let (conn, _) = rust_cli_node_store::open_session_database(
            Path::new(":memory:"),
            Duration::from_secs(1),
            0,
        )
        .expect("session database");
        let mut journal = super::DwfJournal::new(&conn, || 0);
        journal
            .create_run(RunRow {
                run_id: "run_keep".to_owned(),
                parent_session_id: None,
                cwd: None,
                name: None,
                tool_call_id: None,
                script_text: None,
                script_hash: None,
                args: None,
                resumed_from: None,
                caps: Caps {
                    max_concurrency: 4.0,
                },
                spent_tokens: 0.0,
                status: RunStatus::Running,
                stop_reason: None,
                superseded_by: None,
                failure: None,
                result: None,
            })
            .expect("run");
        rust_cli_node_store::dwf::put_node(
            &conn,
            &NodeRecord {
                run_id: "run_keep".to_owned(),
                site_id: "s".to_owned(),
                ordinal: 1,
                kind: DwfKind::Ask,
                actor_site_id: None,
                actor_ordinal: None,
                actor_seq: None,
                input_hash: "h".to_owned(),
                status: DwfStatus::Running,
                result: None,
                error: None,
                stats: None,
                message_boundary: Some(3),
                artifact_id: Some("a1".to_owned()),
                input: Some(serde_json::json!({"k": 1})),
            },
            0,
        )
        .expect("seed node written by Node-shaped code");
        journal
            .put_node(NodeRow {
                run_id: "run_keep".to_owned(),
                site_id: "s".to_owned(),
                ordinal: 1,
                kind: NodeKind::Ask,
                actor_site_id: None,
                actor_ordinal: None,
                actor_seq: None,
                input_hash: "h".to_owned(),
                status: NodeStatus::Completed,
                result: Some(serde_json::json!("ok")),
                error: None,
                stats: None,
            })
            .expect("full-row upsert");
        let stored = rust_cli_node_store::dwf::get_node(&conn, "run_keep", "s", 1)
            .expect("read")
            .expect("row");
        assert_eq!(stored.artifact_id.as_deref(), Some("a1"));
        assert_eq!(stored.input, Some(serde_json::json!({"k": 1})));
        assert_eq!(stored.message_boundary, Some(3));
        assert_eq!(stored.status, DwfStatus::Completed);
    }
}
