use super::subagent_stop_rejected;

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
