//! Fork: `Command::MarkMessage`, the like and pin of a stored message (specs/fork-rust-feedback-and-pins.md; Node
//! `persistAssistantFeedback` / `persistRowPinned`). The actor owns the marks: it checks the message against the active
//! history, commits the fact, then updates its map and appends the kernel event, in that order, so a failed commit
//! changes nothing.

use rust_cli_kernel_api::ids::{CommandId, MessageId};
use rust_cli_kernel_api::message::{Message, UserOrigin};
use rust_cli_kernel_api::message_mark::{MARK_STALE, Mark, MarkRequest};
use rust_cli_kernel_api::session_api::{Ack, KernelEvent};
use rust_cli_kernel_api::store::Fact;

use crate::actor::{Actor, accepted, rejected};

/// The messages a pin addresses: an assistant reply, a typed user input, or a guide sent mid-turn, which is stored as an
/// attachment and shown as a real user input (Node `persistRowPinned`; the App's pin button shows on those rows only).
fn pinnable(message: &Message) -> bool {
    match message {
        Message::Assistant(_) => true,
        Message::User(user) => user.origin == UserOrigin::Human,
        Message::Attachment(attachment) => {
            rust_cli_kernel_api::hooks::queued_command::guided(attachment).is_some()
        }
        Message::System(_) => false,
    }
}

impl Actor {
    pub(crate) async fn mark_message(
        &mut self,
        command: CommandId,
        message: MessageId,
        request: MarkRequest,
    ) -> Ack {
        // A compacted session still shows its earlier history with its marks; a rewind never reaches `earlier`.
        let Some(found) = self
            .earlier
            .iter()
            .chain(self.messages.iter())
            .find(|stored| *stored.id() == message)
        else {
            return rejected(MARK_STALE);
        };
        let stored = self.marks.get(&message).copied().unwrap_or_default();
        let mark = match request {
            MarkRequest::Feedback(feedback) => {
                if !matches!(found, Message::Assistant(_)) {
                    return rejected(MARK_STALE);
                }
                // Node writes the same feedback again and the projection ignores it; nothing changes here.
                if stored.feedback == feedback {
                    return accepted();
                }
                Mark::Feedback(feedback)
            }
            MarkRequest::Pin(pinned) => {
                if !pinnable(found) {
                    return rejected(MARK_STALE);
                }
                match (pinned, stored.pinned_at) {
                    // Idempotent like Node: a repeat pin keeps the first time, an unpin of an unpinned message is a
                    // no-op.
                    (true, Some(_)) | (false, None) => return accepted(),
                    (true, None) => Mark::Pinned(Some(self.deps.clock.now_ms())),
                    (false, Some(_)) => Mark::Pinned(None),
                }
            }
        };
        let fact = Fact::MessageMarked {
            message: message.clone(),
            mark,
        };
        if let Err(error) = self.commit(Some(command), vec![fact]).await {
            return rejected(error);
        }
        let marks = stored.with(mark);
        if marks.is_empty() {
            self.marks.remove(&message);
        } else {
            self.marks.insert(message.clone(), marks);
        }
        self.log
            .append(KernelEvent::MessageMarked { message, mark });
        accepted()
    }
}

#[cfg(test)]
#[path = "mark_tests.rs"]
mod tests;
