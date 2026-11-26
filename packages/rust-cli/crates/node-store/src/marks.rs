//! Fork: the like and pin of a stored message (specs/fork-rust-feedback-and-pins.md), Node's `metadata.assistantFeedback`
//! and `metadata.pinnedAt` (`assistant-feedback-persistence.ts`, `row-pin-persistence.ts`, `transcript-hydration.ts`).

use std::collections::BTreeMap;

use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::message_mark::{Feedback, Mark, Marks};
use rust_cli_kernel_api::store::StoreError;
use serde_json::Value;

use crate::facts::Commit;
use crate::repo::messages::{self, WithParts};
use crate::{OrStorage, storage};

const FEEDBACK: &str = "assistantFeedback";
const PINNED_AT: &str = "pinnedAt";

/// `Fact::MessageMarked`: edits the stored record in place, as Node does (`saveMessage` of the info with the metadata
/// key set or deleted; an empty metadata is dropped and a written one goes last, `{...info, metadata}`).
pub fn apply(ctx: &Commit<'_>, message: &MessageId, mark: &Mark) -> Result<(), StoreError> {
    let id = message.as_str();
    let missing = || storage(format!("message {id} is not stored in this session"));
    let data = messages::message_data(ctx.conn, ctx.session, id)
        .storage()?
        .ok_or_else(missing)?;
    let mut info = decode(&data, id, ctx.session)?;
    let role = info["role"].as_str().unwrap_or_default().to_owned();
    let (key, value) = match mark {
        Mark::Feedback(feedback) => (
            FEEDBACK,
            feedback.map(|feedback| Value::from(feedback.as_str())),
        ),
        Mark::Pinned(pinned_at) => (PINNED_AT, pinned_at.map(Value::from)),
    };
    let takes = match mark {
        Mark::Feedback(_) => role == "assistant",
        Mark::Pinned(_) => role == "assistant" || role == "user",
    };
    if !takes {
        return Err(storage(format!(
            "message {id} ({role}) does not take this mark"
        )));
    }
    let object = info
        .as_object_mut()
        .ok_or_else(|| storage(format!("message {id} is not an object")))?;
    let mut metadata = match object.shift_remove("metadata") {
        Some(Value::Object(metadata)) => metadata,
        _ => serde_json::Map::new(),
    };
    match value {
        Some(value) => {
            metadata.insert(key.to_owned(), value);
        }
        None => {
            metadata.shift_remove(key);
        }
    }
    if !metadata.is_empty() {
        object.insert("metadata".to_owned(), Value::Object(metadata));
    }
    messages::save_message(ctx.conn, &info, ctx.now as i64).storage()?;
    Ok(())
}

fn decode(data: &str, id: &str, session: &str) -> Result<Value, StoreError> {
    rust_cli_node_records::codecs::decode_message(data, id, session).storage()
}

/// The marks the stored records carry: a like on an assistant message, a pin on an assistant or a user message. Like
/// Node's hydration, any other stored value is ignored.
pub fn load(records: &[WithParts]) -> BTreeMap<MessageId, Marks> {
    records
        .iter()
        .filter_map(|record| {
            let role = record.info["role"].as_str()?;
            let metadata = &record.info["metadata"];
            let feedback = (role == "assistant")
                .then(|| metadata[FEEDBACK].as_str().and_then(Feedback::parse))
                .flatten();
            let pinned_at = (role == "assistant" || role == "user")
                .then(|| pinned_at(&metadata[PINNED_AT]))
                .flatten();
            let marks = Marks {
                feedback,
                pinned_at,
            };
            (!marks.is_empty()).then(|| (MessageId::new(record.id()), marks))
        })
        .collect()
}

/// Node `pinnedAtOfMessage`: any stored number is a pin time; a fractional or negative one cannot be a clock reading
/// and is cut to a whole, non-negative millisecond count.
fn pinned_at(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    Some(number.max(0.0) as u64)
}

#[cfg(test)]
#[path = "marks_tests.rs"]
mod tests;
