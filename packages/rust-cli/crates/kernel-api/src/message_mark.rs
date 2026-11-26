//! Fork: the display marks of a stored message, a like or dislike on an assistant reply and a pin on an assistant or a
//! typed user message (specs/fork-rust-feedback-and-pins.md). Node keeps them in the message record's `metadata`
//! (`assistantFeedback`, `pinnedAt`); they are never model context.

use serde::{Deserialize, Serialize};

/// The App's thumbs on an assistant reply (Node `metadata.assistantFeedback`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Feedback {
    Like,
    Dislike,
}

impl Feedback {
    /// The wire and stored word.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Like => "like",
            Self::Dislike => "dislike",
        }
    }

    /// Reads the stored word; any other value is no feedback (Node's cold hydration ignores it too).
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "like" => Some(Self::Like),
            "dislike" => Some(Self::Dislike),
            _ => None,
        }
    }
}

/// What a message is marked with now.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Marks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<Feedback>,
    /// When it was pinned, epoch milliseconds (Node `metadata.pinnedAt`); present means pinned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<u64>,
}

impl Marks {
    pub fn is_empty(&self) -> bool {
        self.feedback.is_none() && self.pinned_at.is_none()
    }

    /// The marks after `mark`.
    #[must_use]
    pub fn with(mut self, mark: Mark) -> Self {
        match mark {
            Mark::Feedback(feedback) => self.feedback = feedback,
            Mark::Pinned(pinned_at) => self.pinned_at = pinned_at,
        }
        self
    }
}

/// One change of a message's marks: the value the store writes, `None` clears it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mark", content = "value", rename_all = "snake_case")]
pub enum Mark {
    Feedback(Option<Feedback>),
    Pinned(Option<u64>),
}

/// What a command asks for. The session decides the pin time ([`Mark::Pinned`]) from its clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mark", content = "value", rename_all = "snake_case")]
pub enum MarkRequest {
    Feedback(Option<Feedback>),
    Pin(bool),
}

/// [`crate::session_api::Command::MarkMessage`] refusal: the message is not in the active history, or its role does
/// not take the mark (Node `proto.staleTarget`).
pub const MARK_STALE: &str = "proto.staleTarget";

#[cfg(test)]
#[path = "message_mark_tests.rs"]
mod tests;
