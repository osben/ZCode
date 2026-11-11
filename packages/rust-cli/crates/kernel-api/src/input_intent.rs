//! Fork: Node's input intent (`TurnInputIntentMetadata`, built by `inputIntentMetadata` in
//! `bootstrap/src/zcode-protocol-v4/commands/input-intent.ts`): the admitted facts of one App input (its typed text,
//! quotes, command, client, deliveries, attachments). It travels with the input through the queue, a steer and the
//! turn, is stored on the user message (`metadata.inputIntent` and `metadata.conversationInputIntent`), and is the
//! only source of a row's typed text and quotes (specs/fork-agent-runtime-selection.md, Conversation quotes in Rust
//! mode). The fields stay Node's flat JSON object so either runtime reads what the other wrote.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::conversation_quote::{self, Quote};

/// The typed text (a goal's objective).
pub const TEXT: &str = "text";
/// The quotes as sent: absent, `[]` or quotes.
pub const QUOTES: &str = "conversationQuotes";
/// A bot-group input's source; kept as stored, never produced here.
pub const BOT_GROUP_SOURCE: &str = "botGroupSource";

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct InputIntent(Map<String, Value>);

impl InputIntent {
    pub fn from_fields(fields: Map<String, Value>) -> Self {
        Self(fields)
    }

    pub fn fields(&self) -> &Map<String, Value> {
        &self.0
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key).filter(|value| !value.is_null())
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    /// The typed text.
    pub fn text(&self) -> Option<&str> {
        self.str(TEXT)
    }

    /// Node `editPendingInputById`: an edited queue item's text; the quotes stay.
    pub fn set_text(&mut self, text: &str) {
        self.0
            .insert(TEXT.to_owned(), Value::String(text.to_owned()));
    }

    /// The quotes, `Some([])` when the input sent an empty list (Node keeps it: `[]` is truthy).
    pub fn quotes(&self) -> Option<Vec<Quote>> {
        let quotes = self.get(QUOTES)?;
        Some(serde_json::from_value(quotes.clone()).unwrap_or_default())
    }

    /// Node's rows show `intent.text` instead of the message text when the intent has quotes or a bot source
    /// (`[]` included).
    pub fn shows_intent_text(&self) -> bool {
        self.get(QUOTES).is_some() || self.get(BOT_GROUP_SOURCE).is_some()
    }

    /// Node `withConversationQuotes(text, intent.conversationQuotes)`: the text the model reads.
    pub fn compose(&self, text: &str) -> String {
        conversation_quote::compose(text, &self.quotes().unwrap_or_default())
    }

    /// The text before this intent's own quote block in a text [`Self::compose`] wrote; the text itself when it has
    /// no such block.
    pub fn typed<'a>(&self, composed: &'a str) -> &'a str {
        let block = self.compose("");
        if block.is_empty() {
            return composed;
        }
        match composed.strip_suffix(block.as_str()) {
            Some("") => "",
            Some(typed) => typed
                .strip_suffix(conversation_quote::SEPARATOR)
                .unwrap_or(composed),
            None => composed,
        }
    }
}

#[cfg(test)]
#[path = "input_intent_tests.rs"]
mod tests;
