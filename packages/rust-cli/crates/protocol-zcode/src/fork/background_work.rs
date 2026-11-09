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
    // Re-read the ledger so a stopped command leaves the list before its killed notice arrives.
    // Subagents settle from the subagent table.
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

/// Node's status names: a stopped command is `cancelled`.
fn node_status(status: &str) -> &str {
    match status {
        "killed" => "cancelled",
        other => other,
    }
}

/// Fork: `v4/conversation/backgroundBashOutput` (Node `readBackgroundBashOutput`): the tail of a background
/// Bash command's output file. The ledger gives the status while it lists the command; afterwards the
/// status its notification reported. Unknown, a Monitor, or no status at all is `unavailable`.
pub(super) async fn bash_output(
    server: &crate::server::Server,
    params: &serde_json::Value,
) -> Result<serde_json::Value, rust_cli_protocol_core::rpc::RpcError> {
    use rust_cli_kernel_api::panels::BashOutputRead;
    use serde_json::json;
    let session = super::methods::session_id(params)?;
    let work = params["workId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            rust_cli_protocol_core::rpc::RpcError::invalid_params("workId is required")
        })?;
    let live = server
        .live(&session)
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    let read = live
        .handle
        .background_bash_output(work)
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    let unavailable = json!({"kind": "unavailable", "workId": work});
    Ok(match read {
        None => unavailable,
        Some(BashOutputRead::ReadFailed { code }) => {
            let mut value = json!({"kind": "read_failed", "workId": work});
            if let Some(code) = code {
                value["code"] = json!(code);
            }
            value
        }
        Some(BashOutputRead::Window {
            status,
            text,
            truncated,
            path,
        }) => {
            let status = status
                .map(|status| status.as_str().to_owned())
                .or_else(|| live.sink.notified_status(work));
            match status {
                Some(status) => json!({
                    "kind": "output",
                    "workId": work,
                    "status": node_status(&status),
                    "output": text,
                    "truncated": truncated,
                    "outputPath": path.as_str(),
                }),
                None => unavailable,
            }
        }
    })
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
