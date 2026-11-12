//! Fork: Node's `session_input` ledger (adapters `session-store/repositories/session-inputs.ts`,
//! specs/fork-rust-agent-parity.md, Input ledger). The session actor commits the changes of its queue as facts;
//! `commands/query` reads the settled rows.
//!
//! Every write only touches `admitted` rows (Node's `where status = 'admitted'`) and never `session.time_updated`.
use rusqlite::{Connection, OptionalExtension, params};
use rust_cli_kernel_api::ids::CommandId;
use rust_cli_kernel_api::store::{AdmittedInput, SettledInput, StoreError};
use serde_json::json;

use crate::OrStorage;
use crate::facts::Commit;

/// Node `queueItemIdForCommand`.
pub fn row_id(command: &CommandId) -> String {
    format!("queue_{}", command.as_str())
}

/// The ledger rows are observations (the usage rule, usage.md §2.5): a failed write rolls back only itself and is
/// logged; the rest of the batch commits.
pub fn observe(
    ctx: &Commit<'_>,
    write: impl FnOnce() -> rusqlite::Result<()>,
) -> Result<(), StoreError> {
    ctx.conn
        .execute_batch("savepoint rust_cli_session_input")
        .storage()?;
    let Err(error) = write() else {
        return ctx
            .conn
            .execute_batch("release rust_cli_session_input")
            .storage();
    };
    if ctx
        .conn
        .execute_batch("rollback to rust_cli_session_input; release rust_cli_session_input")
        .is_err()
    {
        return Err(crate::storage(error));
    }
    tracing::warn!(event = "session_input.write_failed", session = %ctx.session, reason = %error, "the input ledger row was not stored");
    Ok(())
}

/// Node `saveSessionInput`: insert `admitted` with the next `admitted_sequence`, or update an existing row in place.
pub fn admit(ctx: &Commit<'_>, input: &AdmittedInput) -> rusqlite::Result<()> {
    let id = row_id(&input.command);
    let kind = input.kind.as_str();
    let delivery = input.delivery.as_str();
    let payload = json!({
        "text": input.text,
        "conversationInputIntent": {
            "sourceCommandId": input.command.as_str(),
            "queueItemId": id,
            "kind": kind,
            "text": input.text,
            "delivery": {"requested": delivery, "admitted": delivery},
            "steer": {"state": "notRequested"},
            "dispatch": {"state": "queued"},
            "admittedAt": ctx.now,
        },
    })
    .to_string();
    let now = ctx.now as i64;
    ctx.conn.execute(
        "insert into session_input (id, session_id, kind, delivery, payload, admitted_sequence, status, time_created, time_updated)
         values (?1, ?2, ?3, ?4, ?5, (select coalesce(max(admitted_sequence), -1) + 1 from session_input where session_id = ?2), 'admitted', ?6, ?6)
         on conflict(id) do update set kind = excluded.kind, delivery = excluded.delivery, payload = excluded.payload, time_updated = excluded.time_updated
         where session_input.status = 'admitted'",
        params![id, ctx.session, kind, delivery, payload, now],
    )?;
    Ok(())
}

/// Node `markSessionInputPromoted` without the message id (the turn writes the message, not the actor).
pub fn promote(ctx: &Commit<'_>, command: &CommandId) -> rusqlite::Result<()> {
    promote_row(ctx.conn, ctx.session, &row_id(command), ctx.now as i64)
}

fn promote_row(conn: &Connection, session: &str, id: &str, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "update session_input set status = 'promoted',
           promoted_sequence = (select coalesce(max(promoted_sequence), -1) + 1 from session_input where session_id = ?1),
           time_updated = ?2
         where id = ?3 and session_id = ?1 and status = 'admitted'",
        params![session, now, id],
    )?;
    Ok(())
}

/// Node `settleSessionInput`.
pub fn settle(
    ctx: &Commit<'_>,
    command: &CommandId,
    status: &str,
    reason: &str,
) -> rusqlite::Result<()> {
    settle_row(
        ctx.conn,
        ctx.session,
        &row_id(command),
        status,
        reason,
        ctx.now as i64,
    )
}

fn settle_row(
    conn: &Connection,
    session: &str,
    id: &str,
    status: &str,
    reason: &str,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "update session_input set status = ?1, status_reason = ?2, time_updated = ?3
         where id = ?4 and session_id = ?5 and status = 'admitted'",
        params![status, reason, now, id, session],
    )?;
    Ok(())
}

/// The open sweep: the queue lived in memory only. A row whose command reached the transcript is promoted, the rest
/// discarded (`session_resumed`), in admission order.
pub fn resumed(ctx: &Commit<'_>, transcript: &[CommandId]) -> rusqlite::Result<()> {
    let admitted = {
        let mut statement = ctx.conn.prepare(
            "select id from session_input where session_id = ?1 and status = 'admitted'
             order by admitted_sequence",
        )?;
        statement
            .query_map([ctx.session], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let now = ctx.now as i64;
    for id in admitted {
        if transcript.iter().any(|command| row_id(command) == id) {
            promote_row(ctx.conn, ctx.session, &id, now)?;
        } else {
            settle_row(
                ctx.conn,
                ctx.session,
                &id,
                "discarded",
                "session_resumed",
                now,
            )?;
        }
    }
    Ok(())
}

/// The `discarded` or `cancelled` row of a command, if any.
pub fn settled(
    conn: &Connection,
    session: &str,
    command: &CommandId,
) -> Result<Option<SettledInput>, StoreError> {
    conn.query_row(
        "select status, status_reason, delivery from session_input
         where id = ?1 and session_id = ?2 and status in ('discarded', 'cancelled')",
        params![row_id(command), session],
        |row| {
            Ok(SettledInput {
                status: row.get(0)?,
                reason: row.get(1)?,
                delivery: row.get(2)?,
            })
        },
    )
    .optional()
    .storage()
}

#[cfg(test)]
#[path = "session_inputs_tests.rs"]
mod tests;
