//! Fork: conversation quotes (`conversationQuotes` on `sendText` / `editUserQuery`), Node `withConversationQuotes`
//! (`core/src/runtime/helpers/conversation-quotes.ts`; specs/fork-agent-runtime-selection.md, Conversation quotes in
//! Rust mode).
//!
//! The quotes reach the model as a block after the typed text ([`compose`]). They are owned by the input intent
//! ([`crate::input_intent`]); nothing parses them back out of a message's text.

use serde::{Deserialize, Serialize};

/// `CONVERSATION_SELECTION_MAX_COUNT`.
pub const MAX_COUNT: usize = 8;
/// `CONVERSATION_SELECTION_MAX_TEXT_LENGTH` (zod counts code points).
pub const MAX_TEXT_CHARS: usize = 8_000;
/// `CONVERSATION_SELECTION_MAX_TOTAL_LENGTH` (the schema's refine sums JS `.length`, UTF-16 units).
pub const MAX_TOTAL_UTF16: usize = 16_000;

const OPEN: &str = "<conversation_quote>\n";
const CLOSE: &str = "\n</conversation_quote>";
pub const SEPARATOR: &str = "\n\n";

/// One `conversationQuoteSchema` item. The field order is the schema's, so the serialized array equals Node's
/// `JSON.stringify` of the parsed quotes (absent keys left out, unknown keys stripped as zod does).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<String>,
}

/// `conversationQuotesSchema`'s limits; the message names the broken one.
pub fn validate(quotes: &[Quote]) -> Result<(), String> {
    if quotes.len() > MAX_COUNT {
        return Err(format!("conversationQuotes: at most {MAX_COUNT} quotes"));
    }
    let mut total = 0;
    for quote in quotes {
        if quote.text.chars().count() > MAX_TEXT_CHARS {
            return Err(format!(
                "conversationQuotes: a quote's text is over {MAX_TEXT_CHARS} characters"
            ));
        }
        total += quote.text.encode_utf16().count();
        if let Some(sent_at) = &quote.sent_at
            && !is_offset_date_time(sent_at)
        {
            return Err("conversationQuotes: sentAt is not an ISO date-time".to_owned());
        }
    }
    if total > MAX_TOTAL_UTF16 {
        return Err(format!(
            "conversationQuotes: the quotes' text is over {MAX_TOTAL_UTF16} characters in total"
        ));
    }
    Ok(())
}

/// Node `withConversationQuotes(text, quotes)`: the typed text, then the block; an empty part is dropped.
pub fn compose(text: &str, quotes: &[Quote]) -> String {
    if quotes.is_empty() {
        return text.to_owned();
    }
    // Serializing plain strings cannot fail.
    let json = serde_json::to_string(quotes).unwrap_or_default();
    let block = format!("{OPEN}{json}{CLOSE}");
    if text.is_empty() {
        block
    } else {
        format!("{text}{SEPARATOR}{block}")
    }
}

/// zod `z.string().datetime({ offset: true })`: `YYYY-MM-DDTHH:MM:SS[.fraction]` then `Z` or `±HH:MM`, with a real
/// calendar date.
fn is_offset_date_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    let digits = |from: usize, len: usize| -> Option<u32> {
        let slice = bytes.get(from..from + len)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(
            slice
                .iter()
                .fold(0, |acc, digit| acc * 10 + u32::from(digit - b'0')),
        )
    };
    let at = |index: usize, byte: u8| bytes.get(index) == Some(&byte);
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        digits(0, 4),
        digits(5, 2),
        digits(8, 2),
        digits(11, 2),
        digits(14, 2),
        digits(17, 2),
    ) else {
        return false;
    };
    if !(at(4, b'-') && at(7, b'-') && at(10, b'T') && at(13, b':') && at(16, b':')) {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    if day == 0 || day > days || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let mut rest = 19;
    if at(rest, b'.') {
        let fraction = bytes[rest + 1..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if fraction == 0 {
            return false;
        }
        rest += 1 + fraction;
    }
    match bytes.get(rest) {
        Some(b'Z') => rest + 1 == bytes.len(),
        Some(b'+' | b'-') => {
            let (Some(hours), Some(minutes)) = (digits(rest + 1, 2), digits(rest + 4, 2)) else {
                return false;
            };
            at(rest + 3, b':') && rest + 6 == bytes.len() && hours <= 23 && minutes <= 59
        }
        _ => false,
    }
}

#[cfg(test)]
#[path = "conversation_quote_tests.rs"]
mod tests;
