//! Anthropic `strict: true` tool schemas (Node `adapters/src/model/strict-tool-schema.ts`).
//!
//! Strict mode constrains decoding to the tool's `input_schema`, but accepts only a subset of JSON Schema. A schema is
//! folded into that subset: numeric, length and item-count constraints, `default`, and formats strict mode does not know
//! move into the description (the model still reads them, and the engine's own validator still enforces them). A shape the
//! subset cannot express (`$ref`, `$defs`, `prefixItems`, a schema-valued `additionalProperties`, an empty schema)
//! makes the whole schema ineligible, and the tool is then sent without `strict`.
//!
//! Strict needs both gates Node applies. The id must be a direct first-party one, a bare `claude-` prefix
//! (`isAnthropicFirstPartyModelId`), so routed ids such as `anthropic/claude-...` or `us.anthropic.claude-...` never get it.
//! And the model must be on the AI SDK's structured-output capability list (`supportsStrictTools`, substring match), which
//! omits the flag for every other id, an unknown model included.

use serde_json::{Map, Value};

/// String formats strict mode accepts. Other formats are folded into the description.
const STRICT_STRING_FORMATS: [&str; 10] = [
    "date-time",
    "time",
    "date",
    "duration",
    "email",
    "hostname",
    "uri",
    "ipv4",
    "ipv6",
    "uuid",
];

/// Whether strict tools are kept for `model`: a bare `claude-` id that is on the AI SDK's structured-output list.
pub(crate) fn supports_strict_tools(model: &str) -> bool {
    model.starts_with("claude-")
        && rust_cli_base::models::ANTHROPIC_STRUCTURED_OUTPUT_MODELS
            .iter()
            .any(|name| model.contains(name))
}

/// The schema in the strict subset, or None when it has a shape the subset cannot express.
pub(crate) fn to_strict_schema(schema: &Value) -> Option<Value> {
    strict_node(schema.as_object()?).map(Value::Object)
}

/// JS `String(value)` for the keyword values that are folded. Whole numbers print without a fraction, as JS does.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 1e21 => format!("{float:.0}"),
            _ => number.to_string(),
        },
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".to_owned(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// The note a folded keyword adds to the description, or None for a keyword that is not folded.
fn folded_note(key: &str, value: &Value) -> Option<String> {
    let text = js_string(value);
    Some(match key {
        "minimum" => format!("minimum {text}"),
        "maximum" => format!("maximum {text}"),
        "exclusiveMinimum" => format!("greater than {text}"),
        "exclusiveMaximum" => format!("less than {text}"),
        "multipleOf" => format!("multiple of {text}"),
        "minLength" => format!("at least {text} characters"),
        "maxLength" => format!("at most {text} characters"),
        "pattern" => format!("must match /{text}/"),
        "minItems" => format!("at least {text} items"),
        "maxItems" => format!("at most {text} items"),
        "default" => format!("default {value}"),
        _ => return None,
    })
}

fn strict_node(node: &Map<String, Value>) -> Option<Map<String, Value>> {
    if ["$ref", "$defs", "prefixItems"]
        .iter()
        .any(|key| node.contains_key(*key))
    {
        return None;
    }
    let mut notes: Vec<String> = Vec::new();
    let mut out = Map::new();
    for (key, value) in node {
        if let Some(note) = folded_note(key, value) {
            notes.push(note);
            continue;
        }
        if key == "format"
            && let Some(format) = value.as_str()
            && !STRICT_STRING_FORMATS.contains(&format)
        {
            notes.push(format!("format {format}"));
            continue;
        }
        out.insert(key.clone(), value.clone());
    }

    if let Some(Value::Object(properties)) = out.get("properties") {
        let mut strict = Map::new();
        for (name, child) in properties {
            strict.insert(
                name.clone(),
                Value::Object(strict_node(child.as_object()?)?),
            );
        }
        out.insert("properties".to_owned(), Value::Object(strict));
    }
    if let Some(Value::Object(items)) = out.get("items") {
        let strict = strict_node(items)?;
        out.insert("items".to_owned(), Value::Object(strict));
    }
    for combinator in ["anyOf", "allOf"] {
        if let Some(Value::Array(branches)) = out.get(combinator) {
            let mut strict = Vec::new();
            for branch in branches {
                strict.push(Value::Object(strict_node(branch.as_object()?)?));
            }
            out.insert(combinator.to_owned(), Value::Array(strict));
        }
    }

    let is_object = match out.get("type") {
        Some(Value::String(kind)) => kind == "object",
        Some(Value::Array(kinds)) => kinds.iter().any(|kind| kind == "object"),
        _ => false,
    };
    if is_object {
        // `Record<string, T>`: a schema-valued additionalProperties is not expressible.
        if out
            .get("additionalProperties")
            .is_some_and(Value::is_object)
        {
            return None;
        }
        if out.get("additionalProperties") != Some(&Value::Bool(false)) {
            out.insert("additionalProperties".to_owned(), Value::Bool(false));
        }
        if !out.get("properties").is_some_and(Value::is_object) {
            out.insert("properties".to_owned(), Value::Object(Map::new()));
        }
    }
    // An empty schema (`unknown`) has nothing to constrain, and strict mode does not accept it.
    if out.is_empty() && notes.is_empty() {
        return None;
    }
    if !notes.is_empty() {
        let existing = out
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let folded = notes.join("; ");
        let description = if existing.is_empty() {
            folded
        } else {
            format!("{existing} ({folded})")
        };
        out.insert("description".to_owned(), Value::String(description));
    }
    Some(out)
}

#[cfg(test)]
#[path = "strict_schema_tests.rs"]
mod tests;
