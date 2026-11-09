//! Fork (desktop App): goal completion verification steps as Node `target_completion_verification` session entries
//! (core `methods/events.ts` `persistDurableSessionEvent`; specs/fork-rust-goal-verifier.md). One entry per step; a cold
//! load reads the latest step per target and iteration.

use rusqlite::Connection;
use rust_cli_kernel_api::goal::{GoalVerification, RecordedVerification, latest_steps};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::StoreError;
use serde_json::json;

use crate::OrStorage;
use crate::facts::Commit;
use crate::repo::entries::{self, Entry};

/// Node `SessionEntryType` of a verifier step.
pub(crate) const ENTRY: &str = "target_completion_verification";

pub(crate) fn save(
    ctx: &Commit<'_>,
    verification: &GoalVerification,
    at_ms: u64,
) -> Result<(), StoreError> {
    let sequence = entries::max_sequence(ctx.conn, ctx.session, (ENTRY, ENTRY))
        .storage()?
        .unwrap_or(0)
        + 1;
    let id = (ctx.uuid)();
    let at = i64::try_from(at_ms).unwrap_or(i64::MAX);
    let mut data = json!({
        "eventId": id,
        "payload": verification,
        "sequenceNumber": sequence,
    });
    if let Some(turn) = &verification.anchor_turn_id {
        data["turnId"] = json!(turn);
    }
    entries::save(
        ctx.conn,
        &Entry {
            id,
            session_id: ctx.session.to_owned(),
            kind: ENTRY.to_owned(),
            time_created: at,
            time_updated: at,
            data,
            touch_session: false,
        },
    )
    .storage()
}

/// The stored steps (Node's and this kernel's), the latest per target and iteration; rows that do not parse are skipped
/// like Node `readTargetCompletionVerificationPayload`.
pub(crate) fn load(
    conn: &Connection,
    session: &SessionId,
) -> Result<Vec<RecordedVerification>, StoreError> {
    let rows = entries::list(conn, session.as_str(), Some(ENTRY)).storage()?;
    Ok(latest_steps(rows.into_iter().filter_map(|row| {
        let verification = serde_json::from_value(row.data["payload"].clone()).ok()?;
        Some(RecordedVerification {
            verification,
            at_ms: u64::try_from(row.time_created).unwrap_or(0),
        })
    })))
}
