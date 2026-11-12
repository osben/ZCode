use super::{subagent_stop_refused, subagent_stop_rejected};
use crate::inbox::Status;

/// Node `V4SubagentStopRejectedError`: the code drops the `background_task_` prefix, the message keeps it.
#[test]
fn a_refused_subagent_stop_carries_nodes_code() {
    assert_eq!(
        subagent_stop_rejected("agent_1", "not_running"),
        (
            "fault.command.subagentStopRejected.not_running".to_owned(),
            "subagent agent_1 was not stopped: background_task_not_running".to_owned()
        )
    );
    assert_eq!(
        subagent_stop_rejected("agent_9", "not_found").0,
        "fault.command.subagentStopRejected.not_found"
    );
}

/// Node answers a refused stop with a `failed` ack (the gateway's mapping of a thrown domain error), not `rejected`, and
/// keeps the reason code and the message.
#[test]
fn a_refused_subagent_stop_is_a_failed_ack() {
    let ack = subagent_stop_refused("cmd-1", "agent_1", "not_found", 4);
    assert_eq!(ack.status, Status::Failed);
    assert_eq!(
        ack.reason_code.as_deref(),
        Some("fault.command.subagentStopRejected.not_found")
    );
    assert_eq!(
        ack.message.as_deref(),
        Some("subagent agent_1 was not stopped: background_task_not_found")
    );
}
