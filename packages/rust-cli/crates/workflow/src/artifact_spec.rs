//! Predeclared artifact spec validation (Node `engine/artifact-spec.ts`; spec 9.6).
//!
//! The first problem found is returned as the message the script sees (`ArtifactSpecInvalid`). Messages
//! and checks follow Node's order: options, then the shape of the preset, then the serialized size, so a
//! malformed spec is reported before an oversized one. Lengths count UTF-16 units, as JavaScript does.
use crate::canon::canonical_json;
use rust_cli_base::js::json::{js_double, stringify};
use rust_cli_base::js::string::{trim, utf16_len, utf16_prefix};
use serde_json::{Map, Value};

/// Node `ARTIFACT_CAPS` (facade/artifact-caps.ts), the limits the spec check reads.
pub const MAX_TITLE_LENGTH: usize = 120;
pub const MAX_DESCRIPTION_LENGTH: usize = 500;
pub const MAX_SPEC_SERIALIZED_BYTES: usize = 8 * 1024;

/// The first problem with a predeclared spec, or `None` when the spec is valid. `spec` is `None` when the
/// script passed no spec (JavaScript `undefined`).
pub fn validate_artifact_spec(op: &str, spec: Option<&Value>) -> Option<String> {
    if !matches!(op, "chart" | "table" | "metrics" | "board") {
        return Some(format!("unknown artifact preset {op}"));
    }
    let Some(map) = spec.and_then(Value::as_object) else {
        return Some(format!(
            "{op} spec must be an object literal, got {}",
            describe(spec)
        ));
    };
    if let Some(problem) = check_options(map) {
        return Some(problem);
    }
    if let Some(problem) = check_shape(op, map) {
        return Some(problem);
    }
    // Reached only with an object: the checks above refuse anything else.
    let bytes = spec.map_or(0, |whole| canonical_json(whole).len());
    if bytes > MAX_SPEC_SERIALIZED_BYTES {
        return Some(format!(
            "{op} spec is {bytes} bytes serialized, over the {MAX_SPEC_SERIALIZED_BYTES}-byte limit"
        ));
    }
    None
}

fn check_shape(op: &str, spec: &Map<String, Value>) -> Option<String> {
    match op {
        "chart" => check_chart(spec),
        "table" => {
            if let Some(problem) = check_field_list(spec.get("columns"), "columns") {
                return Some(problem);
            }
            match spec.get("key") {
                Some(key) if !is_non_empty_string(Some(key)) => Some(
                    "table spec key must be a non-empty string (the field that identifies a row)"
                        .to_owned(),
                ),
                _ => None,
            }
        }
        "metrics" => check_field_list(spec.get("metrics"), "metrics"),
        "board" => check_board(spec),
        _ => Some(format!("unknown artifact preset {op}")),
    }
}

fn check_chart(spec: &Map<String, Value>) -> Option<String> {
    if let Some(problem) = check_field(spec.get("x"), "x") {
        return Some(problem);
    }
    match spec.get("y") {
        Some(Value::Array(series)) => {
            if series.is_empty() {
                return Some(
                    "chart spec y is an empty array; give it at least one series".to_owned(),
                );
            }
            for (index, entry) in series.iter().enumerate() {
                if let Some(problem) = check_field(Some(entry), &format!("y[{index}]")) {
                    return Some(problem);
                }
            }
        }
        other => {
            if let Some(problem) = check_field(other, "y") {
                return Some(problem);
            }
        }
    }
    if let Some(kind) = spec.get("type")
        && !matches!(js_string(kind).as_str(), "line" | "bar" | "scatter")
    {
        return Some(format!(
            "chart spec type must be \"line\", \"bar\" or \"scatter\", got {}",
            describe(Some(kind))
        ));
    }
    if let Some(scale) = spec.get("scale")
        && !matches!(js_string(scale).as_str(), "linear" | "log")
    {
        return Some(format!(
            "chart spec scale must be \"linear\" or \"log\", got {}",
            describe(Some(scale))
        ));
    }
    spec.get("baseline")
        .and_then(|baseline| check_field(Some(baseline), "baseline"))
}

fn check_board(spec: &Map<String, Value>) -> Option<String> {
    if !is_non_empty_string(spec.get("key")) {
        return Some(
            "board spec key must be a non-empty string (the field that identifies a card)"
                .to_owned(),
        );
    }
    if !is_non_empty_string(spec.get("status")) {
        return Some(
            "board spec status must be a non-empty string (the field that picks a card's column)"
                .to_owned(),
        );
    }
    let columns = match spec.get("columns") {
        Some(Value::Array(columns)) if !columns.is_empty() => columns,
        _ => {
            return Some(
                "board spec columns must be a non-empty array of strings (the column order)"
                    .to_owned(),
            );
        }
    };
    for (index, column) in columns.iter().enumerate() {
        if !is_non_empty_string(Some(column)) {
            return Some(format!(
                "board spec columns[{index}] must be a non-empty string"
            ));
        }
    }
    if let Some(card_title) = spec.get("cardTitle")
        && !is_non_empty_string(Some(card_title))
    {
        return Some(
            "board spec cardTitle must be a non-empty string (the field used as the card title)"
                .to_owned(),
        );
    }
    spec.get("detail")
        .and_then(|detail| check_field_list(Some(detail), "detail"))
}

fn check_options(spec: &Map<String, Value>) -> Option<String> {
    if let Some(title) = spec.get("title") {
        let Some(text) = title.as_str() else {
            return Some(format!(
                "spec title must be a string, got {}",
                describe(Some(title))
            ));
        };
        let length = utf16_len(text);
        if length > MAX_TITLE_LENGTH {
            return Some(format!(
                "spec title is {length} characters, over the {MAX_TITLE_LENGTH} limit"
            ));
        }
    }
    if let Some(description) = spec.get("description") {
        let Some(text) = description.as_str() else {
            return Some(format!(
                "spec description must be a string, got {}",
                describe(Some(description))
            ));
        };
        let length = utf16_len(text);
        if length > MAX_DESCRIPTION_LENGTH {
            return Some(format!(
                "spec description is {length} characters, over the {MAX_DESCRIPTION_LENGTH} limit"
            ));
        }
    }
    if let Some(primary) = spec.get("primary")
        && !primary.is_boolean()
    {
        return Some(format!(
            "spec primary must be a boolean, got {}",
            describe(Some(primary))
        ));
    }
    None
}

fn check_field_list(value: Option<&Value>, where_: &str) -> Option<String> {
    match value {
        Some(Value::Array(entries)) if !entries.is_empty() => {
            for (index, entry) in entries.iter().enumerate() {
                if let Some(problem) = check_field(Some(entry), &format!("{where_}[{index}]")) {
                    return Some(problem);
                }
            }
            None
        }
        _ => Some(format!(
            "spec {where_} must be a non-empty array of fields ({{ field: \"…\" }})"
        )),
    }
}

fn check_field(value: Option<&Value>, where_: &str) -> Option<String> {
    let Some(map) = value.and_then(Value::as_object) else {
        return Some(format!(
            "spec {where_} must be {{ field: \"…\" }}, got {}",
            describe(value)
        ));
    };
    if !is_non_empty_string(map.get("field")) {
        return Some(format!(
            "spec {where_}.field must be a non-empty string (a dot path into the item, e.g. \"timing.after\")"
        ));
    }
    for key in ["label", "unit"] {
        if let Some(entry) = map.get(key)
            && !entry.is_string()
        {
            return Some(format!(
                "spec {where_}.{key} must be a string, got {}",
                describe(Some(entry))
            ));
        }
    }
    None
}

fn is_non_empty_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !trim(text).is_empty())
}

/// Node `describe`: a short rendering of a value for a message. `None` is JavaScript `undefined`.
fn describe(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Array(items)) => format!("array ({} items)", items.len()),
        Some(Value::Object(_)) => "object".to_owned(),
        Some(Value::String(text)) => stringify(&Value::String(utf16_prefix(text, 40).to_owned())),
        Some(Value::Number(number)) => js_double(number.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(flag)) => flag.to_string(),
    }
}

/// JavaScript `String(value)` for the values a spec can hold (used by the `includes` checks).
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_double(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}
