//! Fork: the stored form of an App input's intent (specs/fork-agent-runtime-selection.md, Conversation quotes in Rust
//! mode). Node writes it on the user message (`persistUserPrompt`, `core/src/runtime/methods/message-persistence.ts`)
//! and reads it back for the row (`inputIntentOfMessage`, `bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`).

use rust_cli_kernel_api::input_intent::InputIntent;
use serde_json::{Map, Value};

/// JavaScript truthiness of a JSON value (`...(x ? {x} : {})`).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// The message `metadata` Node writes for an input with an intent: `inputIntent`, `conversationInputIntent` and
/// `inputClientId`.
pub fn message_metadata(intent: &InputIntent, text: &str) -> Value {
    let mut metadata = Map::new();
    metadata.insert(
        "inputIntent".to_owned(),
        Value::Object(intent.fields().clone()),
    );
    metadata.insert(
        "conversationInputIntent".to_owned(),
        persisted(intent, text, "drained"),
    );
    if let Some(client) = intent.str("clientId").filter(|client| !client.is_empty()) {
        metadata.insert("inputClientId".to_owned(), Value::String(client.to_owned()));
    }
    Value::Object(metadata)
}

/// Node `buildPersistedConversationInputIntent(text, intent, dispatchState)`, key for key.
pub fn persisted(intent: &InputIntent, text: &str, dispatch: &str) -> Value {
    let fields = intent.fields();
    let get = |key: &str| fields.get(key);
    let mut out = Map::new();
    let mut put = |key: &str, value: Value| {
        out.insert(key.to_owned(), value);
    };
    // `intent.x ? {x} : {}`.
    let if_truthy = |key: &str, out: &mut dyn FnMut(&str, Value)| {
        if truthy(get(key)) {
            out(key, get(key).cloned().unwrap_or_default());
        }
    };
    // A key JavaScript would serialize (`undefined` is left out).
    let defined = |key: &str, out: &mut dyn FnMut(&str, Value)| {
        if let Some(value) = get(key) {
            out(key, value.clone());
        }
    };
    let fallback = get("fallbackReasonCode").filter(|_| truthy(get("fallbackReasonCode")));
    let steer = match fallback {
        Some(reason) => serde_json::json!({"state": "fellBack", "reasonCode": reason}),
        None if get("admittedDelivery").and_then(Value::as_str) == Some("guide") => {
            let state = if dispatch == "drained" {
                "guided"
            } else {
                "steering"
            };
            serde_json::json!({"state": state})
        }
        None => serde_json::json!({"state": "notRequested"}),
    };
    if_truthy("inputOrigin", &mut put);
    if_truthy("conversationQuotes", &mut put);
    if_truthy("botGroupSource", &mut put);
    defined("sourceCommandId", &mut put);
    defined("queueItemId", &mut put);
    defined("clientId", &mut put);
    defined("kind", &mut put);
    put(
        "text",
        match get("text") {
            Some(value) if !value.is_null() => value.clone(),
            _ => Value::String(text.to_owned()),
        },
    );
    put(
        "attachments",
        match get("attachmentRefs") {
            Some(value) if !value.is_null() => value.clone(),
            _ => Value::Array(Vec::new()),
        },
    );
    if_truthy("modelSelection", &mut put);
    if_truthy("mode", &mut put);
    defined("planEnabled", &mut put);
    defined("genUiContext", &mut put);
    if_truthy("sharedContextRefs", &mut put);
    let mut delivery = Map::new();
    for (key, from) in [
        ("requested", "requestedDelivery"),
        ("admitted", "admittedDelivery"),
    ] {
        if let Some(value) = get(from) {
            delivery.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(reason) = fallback {
        delivery.insert("fallbackReasonCode".to_owned(), reason.clone());
    }
    put("delivery", Value::Object(delivery));
    let mut order = Map::new();
    for key in ["admissionSeq", "queuePosition"] {
        if let Some(value) = get(key) {
            order.insert(key.to_owned(), value.clone());
        }
    }
    put("order", Value::Object(order));
    put("steer", steer);
    put("dispatch", serde_json::json!({"state": dispatch}));
    defined("admittedAt", &mut put);
    if_truthy("highspeed", &mut put);
    if_truthy("provenance", &mut put);
    if_truthy("source", &mut put);
    Value::Object(out)
}

/// Node `inputIntentOfMessage`: the intent of a stored user message (its `info`). A `conversationInputIntent` with
/// Node's schema shape wins; else a legacy `inputIntent` with the fields Node checks; else none.
pub fn of_message(info: &Value) -> Option<InputIntent> {
    let metadata = info.get("metadata")?;
    if let Some(full) = metadata.get("conversationInputIntent")
        && let Some(intent) = from_persisted(full)
    {
        return Some(intent);
    }
    let legacy = metadata.get("inputIntent")?.as_object()?;
    let string = |key: &str| legacy.get(key).is_some_and(Value::is_string);
    let number = |key: &str| legacy.get(key).is_some_and(Value::is_number);
    let one_of = |key: &str, allowed: &[&str]| {
        legacy
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| allowed.contains(&value))
    };
    let valid = string("sourceCommandId")
        && string("queueItemId")
        && string("clientId")
        && one_of("kind", &["sendText", "sendGoalCommand"])
        && number("admissionSeq")
        && number("admittedAt")
        && one_of("requestedDelivery", &["auto", "startNow", "queue", "guide"])
        && one_of("admittedDelivery", &["startNow", "queue", "guide"]);
    valid.then(|| InputIntent::from_fields(legacy.clone()))
}

/// The flat intent of a stored `conversationInputIntent` that has the shape of Node's strict schema (its required
/// fields and enums; nested schemas are Node's to check).
fn from_persisted(full: &Value) -> Option<InputIntent> {
    let full = full.as_object()?;
    let text_min1 = |key: &str| {
        full.get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
    };
    let one_of = |value: Option<&Value>, allowed: &[&str]| {
        value
            .and_then(Value::as_str)
            .is_some_and(|value| allowed.contains(&value))
    };
    let delivery = full.get("delivery")?.as_object()?;
    let order = full.get("order")?.as_object()?;
    let steer = full.get("steer")?.as_object()?;
    let dispatch = full.get("dispatch")?.as_object()?;
    let non_negative_int = |value: Option<&Value>| value.and_then(Value::as_u64).is_some();
    let valid = text_min1("sourceCommandId")
        && text_min1("queueItemId")
        && text_min1("clientId")
        && one_of(
            full.get("kind"),
            &["sendText", "sendGoalCommand", "compact"],
        )
        && full.get("text").is_some_and(Value::is_string)
        && full.get("attachments").is_none_or(Value::is_array)
        && one_of(
            delivery.get("requested"),
            &["auto", "startNow", "queue", "guide"],
        )
        && one_of(delivery.get("admitted"), &["startNow", "queue", "guide"])
        && non_negative_int(order.get("admissionSeq"))
        && order
            .get("queuePosition")
            .is_none_or(|value| value.as_u64().is_some())
        && one_of(
            steer.get("state"),
            &[
                "notRequested",
                "submitting",
                "steering",
                "guided",
                "fellBack",
            ],
        )
        && one_of(
            dispatch.get("state"),
            &["admitted", "queued", "reserved", "promoting", "drained"],
        )
        && full.get("admittedAt").is_some_and(Value::is_number);
    if !valid {
        return None;
    }
    let mut out = Map::new();
    let mut copy = |key: &str, value: Option<&Value>| {
        if let Some(value) = value {
            out.insert(key.to_owned(), value.clone());
        }
    };
    copy("sourceCommandId", full.get("sourceCommandId"));
    copy("queueItemId", full.get("queueItemId"));
    copy("clientId", full.get("clientId"));
    copy("kind", full.get("kind"));
    copy("text", full.get("text"));
    copy("genUiContext", full.get("genUiContext"));
    copy(
        "modelSelection",
        full.get("modelSelection").filter(|v| truthy(Some(v))),
    );
    copy("mode", full.get("mode").filter(|v| truthy(Some(v))));
    copy("planEnabled", full.get("planEnabled"));
    copy("admissionSeq", order.get("admissionSeq"));
    copy("admittedAt", full.get("admittedAt"));
    copy("requestedDelivery", delivery.get("requested"));
    copy("admittedDelivery", delivery.get("admitted"));
    copy("queuePosition", order.get("queuePosition"));
    copy(
        "fallbackReasonCode",
        delivery
            .get("fallbackReasonCode")
            .filter(|v| truthy(Some(v))),
    );
    copy(
        "attachmentRefs",
        full.get("attachments")
            .filter(|v| v.as_array().is_some_and(|refs| !refs.is_empty())),
    );
    for key in [
        "highspeed",
        "inputOrigin",
        "conversationQuotes",
        "botGroupSource",
        "provenance",
        "source",
    ] {
        copy(key, full.get(key).filter(|v| truthy(Some(v))));
    }
    Some(InputIntent::from_fields(out))
}

#[cfg(test)]
#[path = "input_intent_tests.rs"]
mod tests;
