//! Fork: the row fields `feedback` and `pinnedAt` (specs/fork-rust-feedback-and-pins.md; Node `onAssistantFeedbackUpdated`
//! and `onRowPinnedUpdated`, `transcript-hydration.ts`), and the target a `setAssistantFeedback` / `setRowPinned` command
//! resolves to (Node `resolveRowActionTarget`).
//!
//! A message has one `assistantText` row per text block here, all carrying its id as `assistantResponseId` (Node shares
//! the `entityId` instead). Feedback and the pin go on the last of them, the row the App's action toolbar reads
//! (`latestAssistantTextRow`), so a message is marked once.

use rust_cli_kernel_api::message_mark::{Feedback, Mark, Marks};
use serde_json::{Map, Value, json};

use super::{Projection, RowKind, TargetMiss, actions::RowAction};

/// Which mark a command addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkKind {
    Feedback,
    Pin,
}

fn text_row_of(row: &Map<String, Value>, message: &str) -> bool {
    RowKind::of(row) == Some(RowKind::AssistantText)
        && row.get("assistantResponseId").and_then(Value::as_str) == Some(message)
}

fn user_row_of(row: &Map<String, Value>, message: &str) -> bool {
    RowKind::of(row) == Some(RowKind::UserInput)
        && row["origin"] == "realUser"
        && row.get("guided").is_none()
        && row["entityId"] == message
}

impl Projection {
    /// The stored message a mark command addresses: the row must exist with this `entityId` (else stale), and be
    /// markable (else `guard.actionUnavailable`).
    ///
    /// - feedback: an `assistantText` row that already names its message;
    /// - pin: a completed `assistantText` row, or the typed input of a real user (Node refuses system-generated user
    ///   rows and streaming or failed replies).
    pub fn mark_target(
        &self,
        row_id: u64,
        entity: &str,
        kind: MarkKind,
    ) -> Result<String, TargetMiss> {
        let row = self.offered_row(row_id, entity, RowAction::Mark)?;
        let assistant = row
            .get("assistantResponseId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        match (RowKind::of(row), kind) {
            (Some(RowKind::AssistantText), MarkKind::Feedback) => assistant,
            (Some(RowKind::AssistantText), MarkKind::Pin) => {
                assistant.filter(|_| row["state"] == "complete")
            }
            (Some(RowKind::UserInput), MarkKind::Pin) => {
                user_row_of(row, entity).then(|| entity.to_owned())
            }
            _ => None,
        }
        .ok_or(TargetMiss::Unavailable)
    }

    /// Cold open and rebuild: the stored marks of `message` go on its rows right after they exist (Node replays the
    /// metadata after the row-creating event, with no state check). No delta: the snapshot carries the rows.
    pub(super) fn cold_marks(&mut self, message: &str, marks: &Marks) {
        let mut ignored = Vec::new();
        if let Some(feedback) = marks.feedback {
            self.mark_message(message, &Mark::Feedback(Some(feedback)), &mut ignored);
        }
        if let Some(pinned_at) = marks.pinned_at {
            self.mark_message(message, &Mark::Pinned(Some(pinned_at)), &mut ignored);
        }
    }

    /// `KernelEvent::MessageMarked`: sets or clears the row field and reports the row when it changed. A message with
    /// no row (cut from the view, or not shown) changes nothing.
    pub(super) fn mark_message(&mut self, message: &str, mark: &Mark, out: &mut Vec<Value>) {
        let at = match mark {
            Mark::Feedback(_) => self.rows.iter().rposition(|row| text_row_of(row, message)),
            Mark::Pinned(_) => self
                .rows
                .iter()
                .rposition(|row| text_row_of(row, message) || user_row_of(row, message)),
        };
        let Some(at) = at else {
            return;
        };
        let row = &mut self.rows[at];
        let before = row.clone();
        let (field, value) = match mark {
            Mark::Feedback(feedback) => ("feedback", feedback.map(|f: Feedback| json!(f.as_str()))),
            Mark::Pinned(pinned_at) => ("pinnedAt", pinned_at.map(|at| json!(at))),
        };
        match value {
            Some(value) => {
                row.insert(field.to_owned(), value);
            }
            None => {
                row.remove(field);
            }
        }
        if *row != before {
            out.push(json!({"op": "row.upserted", "row": row.clone()}));
        }
    }
}
