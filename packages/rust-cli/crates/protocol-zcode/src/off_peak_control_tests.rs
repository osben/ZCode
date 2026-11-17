//! The off-peak runs of a session and `v4/conversation/offPeakControl` (Node `off-peak/runtime.ts` `controlOffPeakRuntime`).
use serde_json::json;

use super::*;

fn runs_with_one() -> OffPeakRuns {
    let runs = OffPeakRuns::default();
    runs.start("sess_1", "exe_1", "oft_1", "tkt_1", "prov", "3105")
        .unwrap();
    runs
}

#[test]
fn a_session_holds_one_active_run_and_a_second_start_is_refused() {
    let runs = runs_with_one();
    assert_eq!(
        runs.start("sess_1", "exe_2", "oft_2", "tkt_2", "prov", "3105"),
        Err(StartError::AlreadyActive)
    );
    // Another session is independent.
    runs.start("sess_2", "exe_2", "oft_2", "tkt_2", "prov", "3105")
        .unwrap();
}

#[test]
fn control_matches_the_session_and_the_execution_or_answers_false() {
    let runs = runs_with_one();
    let cancel = json!({"sessionId": "sess_1", "executionId": "exe_1", "action": "cancel"});
    assert!(!runs.control("sess_2", &cancel).accepted, "another session");
    let other = json!({"sessionId": "sess_1", "executionId": "exe_9", "action": "cancel"});
    assert!(
        !runs.control("sess_1", &other).accepted,
        "another execution"
    );
    assert!(runs.control("sess_1", &cancel).accepted);
}

#[test]
fn cancel_reports_the_state_the_ticket_and_the_completion_with_identity() {
    let runs = runs_with_one();
    let cancel = json!({"sessionId": "sess_1", "executionId": "exe_1", "action": "cancel"});
    let control = runs.control("sess_1", &cancel);
    assert_eq!(
        control.notifications,
        vec![
            json!({"sessionId": "sess_1", "executionId": "exe_1", "offPeakTaskId": "oft_1",
                   "type": "state_changed", "state": "cancelled"}),
            json!({"sessionId": "sess_1", "executionId": "exe_1", "offPeakTaskId": "oft_1",
                   "type": "ticket_released", "ticketId": "tkt_1"}),
            json!({"sessionId": "sess_1", "executionId": "exe_1", "offPeakTaskId": "oft_1",
                   "type": "completed", "outcome": "stopped"}),
        ]
    );
    // A repeated cancel is accepted again with no new notifications.
    let again = runs.control("sess_1", &cancel);
    assert!(again.accepted);
    assert!(again.notifications.is_empty());
}

#[test]
fn replace_ticket_takes_the_renewal_the_run_asked_for_and_refuses_a_stale_one() {
    let runs = runs_with_one();
    // The run has not asked for a renewal yet: nothing to replace.
    let replace = json!({
        "sessionId": "sess_1", "executionId": "exe_1", "action": "replace_ticket",
        "renewalId": 1, "ticketId": "tkt_2", "requestAuth": {"apiKey": "k"},
    });
    assert!(!runs.control("sess_1", &replace).accepted);
    // The run's ticket expires: the lifecycle asks for renewal 1.
    let Expiry::Renewing(asked) = runs.expire_ticket("sess_1", "exe_1", "tkt_1") else {
        panic!("the current ticket asks for a renewal");
    };
    assert_eq!(asked.len(), 2);
    assert_eq!(asked[1]["type"], "ticket_needed");
    assert_eq!(asked[1]["renewalId"], 1);
    let control = runs.control("sess_1", &replace);
    assert!(control.accepted);
    assert_eq!(control.notifications[0]["type"], "ticket_released");
    assert!(
        !runs
            .control(
                "sess_1",
                &json!({
                    "sessionId": "sess_1", "executionId": "exe_1", "action": "replace_ticket",
                    "renewalId": 7, "ticketId": "tkt_3", "requestAuth": {"apiKey": "k"},
                })
            )
            .accepted
    );
}

#[test]
fn a_finished_run_leaves_a_new_one_free_to_start() {
    let runs = runs_with_one();
    let cancel = json!({"sessionId": "sess_1", "executionId": "exe_1", "action": "cancel"});
    runs.control("sess_1", &cancel);
    runs.start("sess_1", "exe_2", "oft_2", "tkt_2", "prov", "3105")
        .unwrap();
}

/// Node `offPeakToolEnabled`: a session's create or resume flag wins, the workspace policy is the default. The policy
/// answer itself stays `enabled: false` until the flip.
#[test]
fn the_tools_follow_the_session_flag_and_fall_back_to_the_policy() {
    let runs = OffPeakRuns::default();
    assert!(
        !runs.tools_enabled("sess_1"),
        "off until the Host enables them"
    );
    runs.set_session_enabled("sess_1", true);
    assert!(runs.tools_enabled("sess_1"));
    runs.set_session_enabled("sess_1", false);
    assert!(
        !runs.tools_enabled("sess_1"),
        "an explicit false overrides the policy"
    );
    runs.set_policy(true);
    assert!(
        runs.tools_enabled("sess_2"),
        "a session without a flag takes the policy"
    );
    assert!(!runs.tools_enabled("sess_1"));
}

/// Fork (slice 3 layer B): the open run is found by its execution from any session (a subagent of the turn asks with its
/// own session); an ended run is not.
#[test]
fn an_open_run_is_found_by_its_execution_and_an_ended_one_is_not() {
    let runs = runs_with_one();
    assert_eq!(runs.open_session("exe_1").as_deref(), Some("sess_1"));
    assert_eq!(runs.open_session("exe_9"), None);
    let _ = runs.control(
        "sess_1",
        &json!({"sessionId": "sess_1", "executionId": "exe_1", "action": "cancel"}),
    );
    assert_eq!(runs.open_session("exe_1"), None);
}

fn pending(session: &str, execution: &str) -> crate::off_peak_control::PendingRun {
    crate::off_peak_control::PendingRun {
        session: session.to_owned(),
        execution_id: execution.to_owned(),
        off_peak_task_id: "oft_1".to_owned(),
        ticket_id: "tkt_1".to_owned(),
        provider_id: "prov".to_owned(),
        provider_error_code: "3105".to_owned(),
    }
}

/// Node `prepareOffPeakTurn`: an admitted off-peak input opens no run; its turn's start does. An input that is refused
/// after admission, or dropped from the queue, leaves no run and wedges nothing.
#[test]
fn admission_opens_no_run_until_its_turn_starts() {
    let runs = OffPeakRuns::default();
    runs.admit("sess_1", "cmd_1", pending("sess_1", "exe_1"))
        .unwrap();
    assert_eq!(runs.open_session("exe_1"), None, "admitted only");
    runs.turn_started("sess_1", "turn_1", Some("cmd_1"));
    assert_eq!(runs.open_session("exe_1").as_deref(), Some("sess_1"));
}

#[test]
fn a_dropped_admission_does_not_block_the_next_one() {
    let runs = OffPeakRuns::default();
    runs.admit("sess_1", "cmd_dropped", pending("sess_1", "exe_1"))
        .unwrap();
    // The first input never starts (refused or dropped); a new admission is accepted and starts normally.
    runs.admit("sess_1", "cmd_2", pending("sess_1", "exe_2"))
        .unwrap();
    runs.turn_started("sess_1", "turn_2", Some("cmd_2"));
    assert_eq!(runs.open_session("exe_2").as_deref(), Some("sess_1"));
    assert_eq!(runs.open_session("exe_1"), None);
}

#[test]
fn a_turn_of_another_command_or_session_opens_nothing() {
    let runs = OffPeakRuns::default();
    runs.admit("sess_1", "cmd_1", pending("sess_1", "exe_1"))
        .unwrap();
    runs.turn_started("sess_2", "turn_x", Some("cmd_1"));
    runs.turn_started("sess_1", "turn_x", Some("cmd_other"));
    runs.turn_started("sess_1", "turn_x", None);
    assert_eq!(runs.open_session("exe_1"), None);
}

#[test]
fn an_open_run_refuses_another_admission() {
    let runs = OffPeakRuns::default();
    runs.admit("sess_1", "cmd_1", pending("sess_1", "exe_1"))
        .unwrap();
    runs.turn_started("sess_1", "turn_1", Some("cmd_1"));
    assert_eq!(
        runs.admit("sess_1", "cmd_2", pending("sess_1", "exe_2")),
        Err(crate::off_peak_control::StartError::AlreadyActive)
    );
}
