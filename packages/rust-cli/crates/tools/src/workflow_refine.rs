//! Fork (specs/fork-rust-workflow-engine.md 9.66, divergence 141): the workflow confirmation window's Refine (Node
//! `withWorkflowRefineDeniedFollowUp`, `turn-control.ts`). The user answers the window with a revision request instead of
//! approving or refusing: the call is refused with the standard "not approved" text, and the request follows the result as
//! a real user message, so the model revises the script and asks again in the same turn.

use rust_cli_kernel_api::hooks::{SteerSender, queued_command};
use rust_cli_kernel_api::ids::{MessageId, ToolUseId};
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::tool::ToolCallOutput;

use crate::pipeline::rejected;

/// Node `WORKFLOW_REFINE_DENIED_BY_USER_MESSAGE`: the result can only say the run was not approved. It never promises the
/// feedback, or a provider that sees no steer would see a user message that does not exist.
pub(crate) const NOT_APPROVED: &str = "The workflow run was not approved by the user.";

/// The refusal and the message that follows it, or `None` for empty feedback (an ordinary refusal then).
pub(crate) fn follow_up(tool_use: &ToolUseId, feedback: &str) -> Option<ToolCallOutput> {
    let feedback = feedback.trim();
    if feedback.is_empty() {
        return None;
    }
    let steer = queued_command::steer_attachment(
        MessageId::new(format!("msg_refine_{}", tool_use.as_str())),
        feedback,
        SteerSender::User,
        None,
        Some(queued_command::WORKFLOW_REFINE_FEEDBACK),
    );
    Some(ToolCallOutput {
        output: rejected(NOT_APPROVED.to_owned()),
        new_messages: vec![Message::Attachment(steer)],
        stop_turn: false,
    })
}
