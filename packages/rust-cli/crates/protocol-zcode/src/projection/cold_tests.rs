//! A cold read has no live display: a stored tool result carries only its text. The RespondToCoordinator card reads its
//! status from the display, so the reply text (`agents` `respond.rs` `reply_text`) is read back into the same display.

use serde_json::json;

use super::cold_display;

#[test]
fn a_stored_respond_to_coordinator_reply_reads_back_its_status() {
    assert_eq!(
        cold_display(
            "Response response_1 was queued for the coordinator. Continue the current task unless the coordinator explicitly changed or ended it."
        ),
        json!({"kind": "respond_to_coordinator", "status": "success"})
    );
    assert_eq!(
        cold_display(
            "Response response_1 failed to queue for the coordinator. Continue the current task unless the coordinator explicitly changed or ended it. Failure: boom."
        ),
        json!({"kind": "respond_to_coordinator", "status": "failed"})
    );
}

#[test]
fn other_tool_text_has_no_display() {
    assert!(cold_display("Response was queued").is_null());
    assert!(cold_display("ok").is_null());
}
