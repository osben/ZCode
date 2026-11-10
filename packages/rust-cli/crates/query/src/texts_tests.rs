// The wrapper moved to kernel-api (`queued_command::steer_text`); the query loop commits it at tool boundaries.
use rust_cli_kernel_api::hooks::SteerSender;
use rust_cli_kernel_api::hooks::queued_command::steer_text as queued_prompt;

#[test]
fn a_coordinator_steer_uses_the_node_coordinator_wrapper() {
    let text = queued_prompt("check the logs", SteerSender::Coordinator);
    assert!(text.contains(
        "The coordinator sent a message while you were working:\ncheck the logs\n\nAddress this before completing your current task."
    ));
    assert!(!text.contains("The user sent a new message"));
}

#[test]
fn a_user_steer_keeps_the_user_wrapper() {
    let text = queued_prompt("also b", SteerSender::User);
    assert!(text.contains("The user sent a new message while you were working:\nalso b\n\n"));
}
