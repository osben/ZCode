//! The off-peak runs of a session and `v4/conversation/offPeakControl` (Node `off-peak/runtime.ts` `controlOffPeakRuntime`).
use serde_json::json;

use super::*;

fn runs_with_one() -> OffPeakRuns {
    let runs = OffPeakRuns::default();
    runs.start("sess_1", "exe_1", "oft_1", "tkt_1").unwrap();
    runs
}

#[test]
fn a_session_holds_one_active_run_and_a_second_start_is_refused() {
    let runs = runs_with_one();
    assert_eq!(
        runs.start("sess_1", "exe_2", "oft_2", "tkt_2"),
        Err(StartError::AlreadyActive)
    );
    // Another session is independent.
    runs.start("sess_2", "exe_2", "oft_2", "tkt_2").unwrap();
}

#[test]
fn control_matches_the_session_and_the_execution_or_answers_false() {
    let runs = runs_with_one();
    let cancel = json!({"sessionId": "sess_1", "executionId": "exe_1", "action": "cancel"});
    assert!(!runs.control("sess_2", &cancel).accepted, "another session");
    let other = json!({"sessionId": "sess_1", "executionId": "exe_9", "action": "cancel"});
    assert!(!runs.control("sess_1", &other).accepted, "another execution");
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
    let asked = runs.ticket_expired("sess_1", "tkt_1");
    assert_eq!(asked.len(), 2);
    assert_eq!(asked[1]["type"], "ticket_needed");
    assert_eq!(asked[1]["renewalId"], 1);
    let control = runs.control("sess_1", &replace);
    assert!(control.accepted);
    assert_eq!(control.notifications[0]["type"], "ticket_released");
    assert!(!runs.control("sess_1", &json!({
        "sessionId": "sess_1", "executionId": "exe_1", "action": "replace_ticket",
        "renewalId": 7, "ticketId": "tkt_3", "requestAuth": {"apiKey": "k"},
    })).accepted);
}

#[test]
fn a_finished_run_leaves_a_new_one_free_to_start() {
    let runs = runs_with_one();
    let cancel = json!({"sessionId": "sess_1", "executionId": "exe_1", "action": "cancel"});
    runs.control("sess_1", &cancel);
    runs.start("sess_1", "exe_2", "oft_2", "tkt_2").unwrap();
}
