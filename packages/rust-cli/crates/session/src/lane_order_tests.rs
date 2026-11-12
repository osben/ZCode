//! Node `orderTaskNotificationsForParsing`: a batch's terminal notices come first, in arrival order; a stall reminder is
//! never terminal, so it comes after them.

use rust_cli_kernel_api::agents::{AgentNotice, AgentStall};
use rust_cli_kernel_api::env_shell::BackgroundStatus;
use rust_cli_kernel_api::ids::AgentId;

use super::{Waiting, order_for_parsing};

fn terminal(agent: &str) -> Waiting {
    Waiting::Agent(AgentNotice {
        seq: 1,
        agent: AgentId::new(agent),
        status: BackgroundStatus::Completed,
        text: format!("<task-notification>{agent}</task-notification>"),
    })
}

fn stall(agent: &str) -> Waiting {
    Waiting::Stall(AgentStall {
        agent: AgentId::new(agent),
        text: format!("[SYSTEM NOTIFICATION - NOT USER INPUT] {agent}"),
        execution: 0,
        progress_ms: 0,
    })
}

fn texts(notices: &[Waiting]) -> Vec<String> {
    notices.iter().map(Waiting::text).collect()
}

#[test]
fn a_stall_reminder_that_arrived_first_comes_after_the_terminal_notices() {
    let mut notices = vec![stall("a"), terminal("bash"), terminal("b")];
    order_for_parsing(&mut notices);
    assert_eq!(
        texts(&notices),
        [
            "<task-notification>bash</task-notification>",
            "<task-notification>b</task-notification>",
            "[SYSTEM NOTIFICATION - NOT USER INPUT] a",
        ],
        "terminal first, in arrival order; the stall reminder last"
    );
}

#[test]
fn an_order_that_is_already_right_stays_put() {
    let mut notices = vec![terminal("a"), stall("b"), terminal("c")];
    order_for_parsing(&mut notices);
    assert_eq!(
        texts(&notices),
        [
            "<task-notification>a</task-notification>",
            "<task-notification>c</task-notification>",
            "[SYSTEM NOTIFICATION - NOT USER INPUT] b",
        ]
    );
}
