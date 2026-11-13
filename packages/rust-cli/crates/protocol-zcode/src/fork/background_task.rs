//! Fork: legacy `session/cancelBackgroundTask` (Node `server-operations.ts` `cancelBackgroundTask`,
//! specs/fork-rust-agent-parity.md "Legacy `session/cancelBackgroundTask`"). The stop is the user's `Command::StopTask`,
//! the same path as v4 `cancelBackgroundWork`; the answer has Node's `zcodeSessionCancelBackgroundTaskResultSchema` shape.

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::manage::{BackgroundEntry, BackgroundKind};
use rust_cli_kernel_api::session_api::{Ack as KernelAck, Command};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::server::{SESSION_UNAVAILABLE, Server};

/// Node `toBackgroundTaskInfoStatus` for the kernel's terminal status: a stopped task is `cancelled`, an unknown
/// status is `lost`.
fn info_status(status: &str) -> &'static str {
    match status {
        "killed" | "cancelled" | "stopped" => "cancelled",
        "completed" => "completed",
        "failed" => "failed",
        "running" => "running",
        "timed_out" => "timed_out",
        "spawn_error" => "spawn_error",
        _ => "lost",
    }
}

/// The terminal status in the kernel's refusal `Task <id> is not running (status: <status>)`; `None` for any other
/// refusal (an unknown task).
fn not_running_status(reason: &str) -> Option<&str> {
    let (_, rest) = reason.split_once(" is not running (status: ")?;
    rest.strip_suffix(')')
}

/// The task as the session listed it before the stop (`zcodeBackgroundTaskInfoSchema`), now cancelled.
fn snapshot(entry: &BackgroundEntry) -> Value {
    let mut info = json!({
        "taskId": entry.id,
        "status": "cancelled",
        "cancellable": false,
    });
    match entry.kind {
        BackgroundKind::Shell => {
            info["taskKind"] = json!("bash");
            info["command"] = json!(entry.description);
        }
        BackgroundKind::Agent => {
            info["taskKind"] = json!("subagent");
            info["description"] = json!(entry.description);
        }
        BackgroundKind::Monitor => info["command"] = json!(entry.description),
    }
    info
}

/// The result for the kernel's answer to the stop.
fn result(task: &str, kernel: KernelAck, listed: Option<&BackgroundEntry>) -> Value {
    match kernel {
        KernelAck::Accepted { .. } | KernelAck::Duplicate => {
            let mut value = json!({"cancelled": true, "status": "cancelled", "taskId": task});
            if let Some(entry) = listed {
                value["snapshot"] = snapshot(entry);
            }
            value
        }
        KernelAck::Rejected { reason } => match not_running_status(&reason) {
            Some(status) => {
                let status = info_status(status);
                json!({
                    "cancelled": status == "cancelled",
                    "reason": "background_task_not_running",
                    "status": status,
                    "taskId": task,
                })
            }
            None => json!({
                "cancelled": false,
                "reason": "background_task_not_found",
                "status": "lost",
                "taskId": task,
            }),
        },
    }
}

pub(super) async fn cancel(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let session = super::methods::session_id(params)?;
    let task = params["taskId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| RpcError::invalid_params("taskId is required"))?;
    // Node `requireSession` reads only active runtimes: a session that is not resident is not opened.
    let Some(live) = server.bridge.get(&session) else {
        return Err(not_active(&session));
    };
    tracing::info!(
        event = "protocol.session.cancel_background_task",
        session = session.as_str(),
        task,
        "session/cancelBackgroundTask received"
    );
    let listed = live
        .handle
        .background_tasks()
        .await
        .ok()
        .and_then(|entries| entries.into_iter().find(|entry| entry.id == task));
    let id = server.context.fresh("cancel-background-task");
    let command = Command::StopTask {
        task: task.to_owned(),
    };
    let kernel = crate::commands::send(live.handle.as_ref(), &id, command).await;
    // Re-read the ledger so a stopped command leaves the list before its killed notice arrives (as
    // `cancelBackgroundWork`).
    let sink = live.sink.clone();
    live.run(Box::pin(async move { sink.shells_changed().await }));
    Ok(result(task, kernel, listed.as_ref()))
}

/// Node `requireSession` (`sessionUnavailable`).
fn not_active(session: &SessionId) -> RpcError {
    RpcError::new(
        SESSION_UNAVAILABLE,
        format!("Session is not active: {}", session.as_str()),
    )
}

#[cfg(test)]
#[path = "background_task_tests.rs"]
mod tests;
