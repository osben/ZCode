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

fn integer(value: f64, what: &str) -> Result<i64> {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= i64::MAX as f64 {
        return Ok(value as i64);
    }
    bail!("dwf_run stores integers: {what} is {value}")
}

fn ordinal_to_column(ordinal: u64) -> Result<i64> {
    Ok(i64::try_from(ordinal)?)
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
        ordinal: ordinal_to_column(row.ordinal)?,
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
        ordinal: ordinal_to_column(row.ordinal)?,
        kind: kind_to_dwf(row.kind),
        actor_site_id: row.actor_site_id.clone(),
        actor_ordinal: row.actor_ordinal.map(ordinal_to_column).transpose()?,
        actor_seq: row.actor_seq.map(ordinal_to_column).transpose()?,
        input_hash: row.input_hash.clone(),
        status: node_status_to_dwf(row.status),
        result: row.result.clone(),
        error: row.error.clone(),
        stats: row.stats.clone(),
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
            ordinal_to_column(actor.ordinal)?,
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
        dwf::put_node(self.conn, &node_to_dwf(&row)?, (self.clock)())
    }

    fn get_node(&self, run_id: &str, instance: &Ref) -> Result<Option<NodeRow>> {
        dwf::get_node(
            self.conn,
            run_id,
            &instance.site_id,
            ordinal_to_column(instance.ordinal)?,
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
