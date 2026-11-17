//! JavaScript-compatible helpers for the workflowRuns reducer.
//!
//! The reducer is a port of Node's `workflow-runs-*.ts`, whose behaviour depends on JS semantics in
//! four places: `typeof` / truthiness checks, `.length` and `.slice` counting UTF-16 code units,
//! `Number.isInteger`, and structural equality that ignores key order. Each helper below states the
//! JS rule it reproduces.

use serde_json::{Map, Number, Value};

/// A JSON object whose key order is insertion order (serde_json `preserve_order`). Node's reducer
/// builds entries with `{...obj, key: v}`, so key order is part of the byte-identical contract.
pub type Obj = Map<String, Value>;

/// JS `isPlainRecord`: a non-null, non-array object.
pub fn plain(value: Option<&Value>) -> Option<&Obj> {
    match value {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// JS `nonEmptyString`: a string with length above zero, else absent.
pub fn non_empty(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

/// The value as a JS number (`typeof v === "number"`), if it is one.
pub fn js_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64(),
        _ => None,
    }
}

/// JS `Number.isInteger`.
pub fn is_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0
}

/// A JSON number for an integer-valued f64: integers print without a fraction, as in JS.
pub fn number_value(number: f64) -> Value {
    if is_integer(number) && number.abs() < 9.0e15 {
        Value::Number(Number::from(number as i64))
    } else {
        Number::from_f64(number).map_or(Value::Null, Value::Number)
    }
}

/// JS `String(number)` for the instance-key string (`siteId\0ordinal`).
pub fn number_key(number: f64) -> String {
    if is_integer(number) && number.abs() < 9.0e15 {
        format!("{}", number as i64)
    } else {
        format!("{number}")
    }
}

/// JS `.length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// JS `text.slice(0, n)` counted in UTF-16 code units, rounded **down** when the cut would split a
/// surrogate pair. A lone surrogate cannot be held in a Rust `String` (see the spec, section 9.2).
pub fn utf16_prefix(text: &str, n: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        let width = ch.len_utf16();
        if units + width > n {
            break;
        }
        units += width;
        end = index + ch.len_utf8();
    }
    text[..end].to_string()
}

/// The reducer's `text.slice(0, limit)` with no marker (`boundedText`, `boundedPhaseName`, ...).
pub fn bounded(text: &str, limit: usize) -> String {
    utf16_prefix(text, limit)
}

/// The reducer's `text.length <= limit ? text : text.slice(0, limit - 1) + "…"`.
pub fn ellipsized(text: &str, limit: usize) -> String {
    if utf16_len(text) <= limit {
        text.to_string()
    } else {
        format!("{}…", utf16_prefix(text, limit.saturating_sub(1)))
    }
}

/// JS `jsonValueEqual`: structural equality that ignores object key order. Numbers compare by value,
/// so `5` and `5.0` are equal, as they are in JS.
pub fn json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| json_equal(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| json_equal(value, other)))
        }
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => left == right,
    }
}

/// Byte length of the compact JSON text, the measure the reducer's size tests use.
pub fn utf8_json_len(value: &Value) -> usize {
    serde_json::to_string(value).map_or(0, |text| text.len())
}

/// Copy of a run object with keys in the schema's declaration order first, then any other keys in
/// their original order (Node's `canonicalWorkflowRun`).
pub fn canonical(run: Obj) -> Obj {
    let mut out = Obj::new();
    for key in super::RUN_KEY_ORDER {
        if let Some(value) = run.get(*key) {
            out.insert((*key).to_string(), value.clone());
        }
    }
    for (key, value) in &run {
        if !super::RUN_KEY_ORDER.contains(&key.as_str()) {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

/// Deletes a key from an object, keeping the order of the others (`const {k, ...rest} = obj`).
pub fn without(mut run: Obj, key: &str) -> Obj {
    run.shift_remove(key);
    run
}

/// Shared JS semantics for `{ ...obj, key: value }`: an existing key keeps its position; a new key is
/// appended. `IndexMap::insert` has the same behaviour, so this is a named alias for readers.
pub fn spread_set(mut obj: Obj, key: &str, value: Value) -> Obj {
    obj.insert(key.to_string(), value);
    obj
}

/// The instance key used by the tables: `siteId + "\0" + ordinal`.
pub fn entry_key(site_id: &str, ordinal: f64) -> String {
    format!("{site_id}\0{}", number_key(ordinal))
}

/// A `{siteId, ordinal}` pair read from an entry, or from an instance / actor payload.
#[derive(Debug, Clone, PartialEq)]
pub struct InstanceRef {
    pub site_id: String,
    pub ordinal: f64,
}

impl InstanceRef {
    pub fn key(&self) -> String {
        entry_key(&self.site_id, self.ordinal)
    }

    pub fn same(&self, other: &InstanceRef) -> bool {
        self.site_id == other.site_id && self.ordinal == other.ordinal
    }

    pub fn to_value(&self) -> Value {
        let mut map = Obj::new();
        map.insert("siteId".into(), Value::String(self.site_id.clone()));
        map.insert("ordinal".into(), number_value(self.ordinal));
        Value::Object(map)
    }
}

/// JS `workflowInstanceRef`: an object with a non-empty `siteId` and a numeric `ordinal`.
pub fn instance_ref(value: Option<&Value>) -> Option<InstanceRef> {
    let record = plain(value)?;
    let site_id = non_empty(record.get("siteId"))?;
    let ordinal = js_number(record.get("ordinal"))?;
    Some(InstanceRef { site_id, ordinal })
}

/// Reads an entry's `siteId` and `ordinal` (the deduplication key of the instance tables).
pub fn entry_ref(entry: &Obj) -> Option<InstanceRef> {
    let site_id = entry.get("siteId")?.as_str()?.to_string();
    let ordinal = js_number(entry.get("ordinal"))?;
    Some(InstanceRef { site_id, ordinal })
}
