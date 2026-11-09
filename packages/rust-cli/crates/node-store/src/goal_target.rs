//! Fork (desktop App): the goal's Node `session_target` row (specs/fork-rust-agent-parity.md, Goals). The session
//! actor writes the whole row whenever its goal changes; a cold load reads the summary title and the time used back.

use rusqlite::Connection;
use rust_cli_kernel_api::goal::{GoalPhase, GoalState};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::StoreError;

use crate::OrStorage;
use crate::facts::Commit;
use crate::repo::sessions::{self, SavedTarget};

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// Node's `session_target.status` check allows `active`, `paused`, `budget_limited` and `complete`; a met or impossible
/// goal is `complete`.
fn status(phase: GoalPhase) -> &'static str {
    match phase {
        GoalPhase::Active => "active",
        GoalPhase::Paused => "paused",
        GoalPhase::Verified | GoalPhase::Failed => "complete",
    }
}

pub(crate) fn save(ctx: &Commit<'_>, goal: &GoalState, seen_at_ms: u64) -> Result<(), StoreError> {
    let target = SavedTarget {
        target_id: &goal.target,
        objective: &goal.objective,
        summary_title: goal.summary_title.as_deref(),
        status: status(goal.status),
        time_used_seconds: to_i64(goal.time_used_seconds),
        active_run: goal
            .active_run_started_at_ms
            .map(|started| (to_i64(started), to_i64(seen_at_ms.max(started)))),
        now: ctx.now as i64,
    };
    sessions::save_target(ctx.conn, ctx.session, &target).storage()
}

/// The stored row; a stretch that was running when the process stopped counts up to its last write (Node
/// `recoverInterruptedSessionTargetRun`).
pub(crate) fn load(
    conn: &Connection,
    session: &SessionId,
) -> Result<Option<GoalState>, StoreError> {
    let Some(stored) = sessions::stored_target(conn, session.as_str()).storage()? else {
        return Ok(None);
    };
    let target = stored.target;
    let interrupted = stored.active_run.map_or(0, |(started, seen)| {
        seen.unwrap_or(started).saturating_sub(started).max(0) / 1000
    });
    let status = match target.status.as_str() {
        "active" => GoalPhase::Active,
        "complete" => GoalPhase::Verified,
        _ => GoalPhase::Paused,
    };
    Ok(Some(GoalState {
        target: target.target_id,
        objective: target.objective,
        status,
        iteration: 0,
        time_used_seconds: u64::try_from(target.time_used_seconds.saturating_add(interrupted))
            .unwrap_or(0),
        active_run_started_at_ms: None,
        summary_title: target.summary_title,
    }))
}
