//! 工具输入校验：JSON Schema 子集，报错格式见 spec rust-cli/tools.md。
//!
//! 能归类的三种问题：缺少必填参数、多出的参数（`additionalProperties: false`）、
//! 类型不符，用文字列出。其余问题（Node 的 `too_small` 与 `invalid_value`）整体输出为一个 JSON 数组，
//! 与 Node `formatToolInputValidationError` 一致（issues 按 schema 的属性顺序排列）。

use serde::Serialize;
use serde_json::{Map, Value};

enum Issue {
    Missing(String),
    Unexpected(String),
    Mismatch {
        path: String,
        expected: String,
        received: &'static str,
    },
    /// A string shorter than its `minLength` (zod `too_small`).
    TooSmall {
        segments: Vec<Value>,
        minimum: u64,
    },
    /// A value outside its `enum`, or a missing required property whose schema has an `enum` (zod `invalid_value`).
    InvalidValue {
        segments: Vec<Value>,
        values: Vec<Value>,
    },
}

/// Node's `createTooSmallIssue` for a string: the key order is Node's, since the JSON is what the model reads.
#[derive(Serialize)]
struct TooSmallIssue {
    origin: &'static str,
    code: &'static str,
    minimum: u64,
    inclusive: bool,
    path: Vec<Value>,
    message: String,
}

/// Node's `invalid_value` issue: no `origin`, and `values` before `path`.
#[derive(Serialize)]
struct InvalidValueIssue {
    code: &'static str,
    values: Vec<Value>,
    path: Vec<Value>,
    message: String,
}

/// One entry of the JSON array, in the issues' order.
#[derive(Serialize)]
#[serde(untagged)]
enum JsonIssue {
    TooSmall(TooSmallIssue),
    InvalidValue(InvalidValueIssue),
}

/// zod 的 `received` 用 JavaScript 的类型名。
fn received(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn matches_type(expected: &str, value: &Value) -> bool {
    match expected {
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_f64().is_some_and(|number| number.fract() == 0.0),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_owned()
    } else {
        format!("{path}.{key}")
    }
}

/// Node's `formatIssueValue`: strings quoted, the rest as text.
fn format_issue_value(value: &Value) -> String {
    match value {
        Value::String(text) => format!("\"{text}\""),
        other => other.to_string(),
    }
}

/// Node's `createInvalidValueIssue` message: a single allowed value reads `Invalid input: expected "x"`, several read
/// `Invalid option: expected one of "x"|"y"`.
fn invalid_value_message(values: &[Value]) -> String {
    match values {
        [only] => format!("Invalid input: expected {}", format_issue_value(only)),
        _ => {
            let options: Vec<String> = values.iter().map(format_issue_value).collect();
            format!("Invalid option: expected one of {}", options.join("|"))
        }
    }
}

fn child_segments(segments: &[Value], key: &str) -> Vec<Value> {
    let mut child = segments.to_vec();
    child.push(Value::String(key.to_owned()));
    child
}

/// `segments` is the path as Node's issues carry it (keys, and numbers for array items); `path` is the dotted text.
fn check(schema: &Value, value: &Value, path: &str, segments: &[Value], issues: &mut Vec<Issue>) {
    // Node's `validateNode` reports a value outside the enum as `invalid_value`, whatever its type, and then goes on: a
    // type mismatch is reported only when no value constraint failed, and a type mismatch returns before the string,
    // number, array and object constraints run. So an enum failure on a string still reports its `minLength`.
    let mut value_constraint_failed = false;
    if let Some(options) = schema.get("enum").and_then(Value::as_array)
        && !options.contains(value)
    {
        issues.push(Issue::InvalidValue {
            segments: segments.to_vec(),
            values: options.clone(),
        });
        value_constraint_failed = true;
    }
    if let Some(expected) = schema.get("type").and_then(Value::as_str)
        && !matches_type(expected, value)
    {
        if !value_constraint_failed {
            issues.push(Issue::Mismatch {
                path: path.to_owned(),
                expected: expected.to_owned(),
                received: received(value),
            });
        }
        return;
    }
    if let Value::String(text) = value
        && let Some(minimum) = schema.get("minLength").and_then(Value::as_u64)
        && (text.encode_utf16().count() as u64) < minimum
    {
        // JavaScript's `length` counts UTF-16 code units, as Node's check does.
        issues.push(Issue::TooSmall {
            segments: segments.to_vec(),
            minimum,
        });
    }
    match value {
        Value::Object(object) => check_object(schema, object, path, segments, issues),
        Value::Array(items) => {
            if let Some(item_schema) = schema.get("items") {
                for (index, item) in items.iter().enumerate() {
                    let mut child = segments.to_vec();
                    child.push(Value::from(index));
                    check(
                        item_schema,
                        item,
                        &format!("{path}[{index}]"),
                        &child,
                        issues,
                    );
                }
            }
        }
        _ => {}
    }
}

/// Properties are visited in the schema's order, as Node's validator visits them, so the issues follow the schema.
fn check_object(
    schema: &Value,
    object: &Map<String, Value>,
    path: &str,
    segments: &[Value],
    issues: &mut Vec<Issue>,
) {
    let properties = schema.get("properties").and_then(Value::as_object);
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if let Some(properties) = properties {
        for (key, property) in properties {
            // 有 `default` 的字段在 zod 的输入校验里可以缺省（输出形的 JSON Schema 仍把它列进 required，
            // 例如 ToolSearch 的 `max_results`、AskUserQuestion 的 `multiSelect`）。
            let defaulted = property.get("default").is_some();
            match object.get(key) {
                Some(value) => check(
                    property,
                    value,
                    &join(path, key),
                    &child_segments(segments, key),
                    issues,
                ),
                None if required.contains(&key.as_str()) && !defaulted => {
                    match property.get("enum").and_then(Value::as_array) {
                        // Node reports a missing enum property as `invalid_value`, not as a missing parameter.
                        Some(options) => issues.push(Issue::InvalidValue {
                            segments: child_segments(segments, key),
                            values: options.clone(),
                        }),
                        None => issues.push(Issue::Missing(join(path, key))),
                    }
                }
                None => {}
            }
        }
    }
    for name in &required {
        let declared = properties.is_some_and(|properties| properties.contains_key(*name));
        if !declared && !object.contains_key(*name) {
            issues.push(Issue::Missing(join(path, name)));
        }
    }
    let closed = schema.get("additionalProperties") == Some(&Value::Bool(false));
    if closed {
        for key in object.keys() {
            if !properties.is_some_and(|properties| properties.contains_key(key)) {
                issues.push(Issue::Unexpected(key.clone()));
            }
        }
    }
}

/// zod `z.object` 的 strip（修复线 F51，agents.md §2）：去掉 schema `properties` 以外的顶层键；不是对象、或 schema
/// 没有 `properties` 时原样返回。
pub(crate) fn strip_unknown(schema: &Value, mut input: Value) -> Value {
    if let (Value::Object(object), Some(properties)) = (
        &mut input,
        schema.get("properties").and_then(Value::as_object),
    ) {
        object.retain(|key, _| properties.contains_key(key));
    }
    input
}

/// 校验通过时为 None；否则是 `<tool_use_error>InputValidationError: …</tool_use_error>` 里的正文。
pub(crate) fn validate(tool: &str, schema: &Value, input: &Value) -> Option<String> {
    let mut issues = Vec::new();
    check(schema, input, "", &[], &mut issues);
    if issues.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for issue in &issues {
        if let Issue::Missing(param) = issue {
            parts.push(format!("The required parameter `{param}` is missing"));
        }
    }
    for issue in &issues {
        if let Issue::Unexpected(param) = issue {
            parts.push(format!("An unexpected parameter `{param}` was provided"));
        }
    }
    for issue in &issues {
        if let Issue::Mismatch {
            path,
            expected,
            received,
        } = issue
        {
            parts.push(format!(
                "The parameter `{path}` type is expected as `{expected}` but provided as `{received}`"
            ));
        }
    }
    if parts.is_empty() {
        // Node prints every remaining issue as one JSON array, in the order the issues were found.
        let json: Vec<JsonIssue> = issues
            .iter()
            .filter_map(|issue| match issue {
                Issue::TooSmall { segments, minimum } => Some(JsonIssue::TooSmall(TooSmallIssue {
                    origin: "string",
                    code: "too_small",
                    minimum: *minimum,
                    inclusive: true,
                    path: segments.clone(),
                    message: format!("Too small: expected string to have >={minimum} characters"),
                })),
                Issue::InvalidValue { segments, values } => {
                    Some(JsonIssue::InvalidValue(InvalidValueIssue {
                        code: "invalid_value",
                        values: values.clone(),
                        path: segments.clone(),
                        message: invalid_value_message(values),
                    }))
                }
                _ => None,
            })
            .collect();
        #[expect(
            clippy::expect_used,
            reason = "the issues hold only strings, numbers and booleans, which always serialize"
        )]
        let text = serde_json::to_string_pretty(&json).expect("plain JSON values serialize");
        return Some(text);
    }
    let noun = if parts.len() > 1 { "issues" } else { "issue" };
    Some(format!(
        "{tool} failed due to the following {noun}:\n{}",
        parts.join("\n")
    ))
}

#[cfg(test)]
#[path = "validate_tests.rs"]
mod tests;
