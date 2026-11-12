use super::steered_text;
use rust_cli_kernel_api::ids::CommandId;

#[test]
fn a_running_agent_reports_the_node_steered_text() {
    let text = steered_text(&CommandId::new("1b2c"), "agent_1");
    assert_eq!(
        text,
        "Message msg_1b2c was sent to its active turn for local agent agent_1."
    );
}
