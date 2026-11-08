//! Fork: v4 `cancelBackgroundWork` (Node `interaction-background.ts`). The work id is the kernel's task id
//! (a subagent's agentId, a background command's task id); the stop is the user's `Command::StopTask`, the
//! same path as the TUI `/tasks` stop. The snapshot `backgroundWorks` settles from the kernel subagent table,
//! not from this ack.

use rust_cli_kernel_api::session_api::Command;
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;

use crate::commands::{ack_of, payload, send};
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;

/// Node `BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX`.
const CANCEL_REJECTED: &str = "fault.command.backgroundWorkCancelRejected.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelPayload {
    work_id: String,
}

/// Node's rejection reason for the kernel's refusal text: a task that already ended is `not_running`,
/// anything else (unknown id) is `not_found`.
fn reason_code(reason: &str) -> String {
    let code = if reason.contains("is not running") {
        "not_running"
    } else {
        "not_found"
    };
    format!("{CANCEL_REJECTED}{code}")
}

pub(super) async fn cancel(live: &Bridged<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let body: CancelPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let command = Command::StopTask { task: body.work_id };
    let kernel = send(live.handle.as_ref(), &envelope.command_id, command).await;
    // A stopped command sends no notification: re-read the ledger so its work leaves the list. Subagents
    // settle from the subagent table.
    let sink = live.sink.clone();
    live.run(Box::pin(async move { sink.shells_changed().await }));
    ack_of(
        kernel,
        Ack::accepted(&envelope.command_id, revision, None),
        |reason| {
            Ack::refused(
                &envelope.command_id,
                Status::Rejected,
                &reason_code(&reason),
                reason,
                revision,
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::reason_code;

    #[test]
    fn kernel_refusals_map_to_node_reason_codes() {
        assert_eq!(
            reason_code("Task agent_1 is not running (status: killed)"),
            "fault.command.backgroundWorkCancelRejected.not_running"
        );
        assert_eq!(
            reason_code("No task found with ID: agent_9"),
            "fault.command.backgroundWorkCancelRejected.not_found"
        );
    }
}
