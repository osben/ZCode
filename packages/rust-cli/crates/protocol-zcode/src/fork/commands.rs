//! Fork: v4 command kinds beyond the upstream P1 set. `None` means the kind is not ported, and the
//! caller answers `proto.unsupportedCommand`.

use std::sync::Arc;

use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, Command, GOAL_ACTIVE_TURN, GOAL_PLAN_EXCLUSIVE,
};
use rust_cli_protocol_core::sessions::Bridged;

use super::{background_work, file_summary, queue, row_commands, session_config, session_delete};
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::projection::state::Phase;
use crate::server::Server;

pub(crate) async fn decide(
    server: &Server,
    live: &Arc<Bridged<Live>>,
    envelope: &Envelope,
    phase: Phase,
    revision: u64,
) -> Option<Ack> {
    Some(match envelope.kind.as_str() {
        "renameSession" => session_config::rename(live, envelope, revision).await,
        "switchModelConfig" => session_config::switch_model(live, envelope, revision).await,
        "switchCollaborationMode" => session_config::switch_mode(live, envelope, revision).await,
        "compact" => session_config::compact(live, envelope, phase, revision).await,
        "editUserQuery" => row_commands::edit(server, live, envelope, revision).await,
        "retryTurn" => row_commands::retry(live, envelope, revision).await,
        "forkAssistant" => row_commands::fork(server, live, envelope, revision).await,
        // Fork: the per-turn summary rewind (specs/fork-rust-agent-parity.md).
        "applyFileRewind" => file_summary::apply(live, envelope, revision).await,
        "deleteSession" => session_delete::delete(server, live, envelope, revision).await,
        "deleteQueueItem" => queue::delete_queue_item(live, envelope, revision).await,
        "editQueueItem" => queue::edit_queue_item(live, envelope, revision).await,
        "reorderQueueItem" => queue::reorder_queue_item(live, envelope, revision).await,
        "setAutoDrain" => queue::set_auto_drain(live, envelope, revision).await,
        "sendQueuedNow" => queue::send_queued_now(live, envelope, revision).await,
        "pauseGoal" => goal(live, envelope, revision, Command::PauseGoal).await,
        "resumeGoal" => goal(live, envelope, revision, Command::ResumeGoal).await,
        "cancelBackgroundWork" => background_work::cancel(live, envelope, revision).await,
        _ => return None,
    })
}

/// Fork: Node `pauseGoal` / `resumeGoal`. The kernel owns the goal; a refused resume carries Node's
/// reason code (`activeTurn`, `guard.planGoalMutuallyExclusive`).
async fn goal(live: &Bridged<Live>, envelope: &Envelope, revision: u64, command: Command) -> Ack {
    match crate::commands::send(live.handle.as_ref(), &envelope.command_id, command).await {
        KernelAck::Rejected { reason } => {
            let code = if reason == GOAL_ACTIVE_TURN || reason == GOAL_PLAN_EXCLUSIVE {
                reason.clone()
            } else {
                "fault.command.inputRejected".to_owned()
            };
            Ack::refused(
                &envelope.command_id,
                Status::Rejected,
                &code,
                reason,
                revision,
            )
        }
        _ => Ack::accepted(&envelope.command_id, revision, None),
    }
}
