//! What the trust prompt shows for a workspace MCP declaration (Node `displayConfig` in
//! `bootstrap/src/workspace-mcp-trust/index.ts`), with secrets masked by Node `sanitizeHookDisplayText`
//! (`core/src/hooks/display-metadata.ts`). The text must match Node byte for byte: the Settings panel shows it
//! and the golden fixture pins it.

use std::sync::LazyLock;

use regex::Regex;
use rust_cli_base::js::json::{properties, write_str};
use serde_json::{Map, Value};

const SENSITIVE_KEY: &str =
    "(?:access[_-]?token|api[_-]?key|credential|password|private[_-]?key|secret|token)";
const MASK: &str = "••••";

fn identifier() -> String {
    format!("(?:[A-Za-z0-9]+[_-])*{SENSITIVE_KEY}(?:[_-][A-Za-z0-9]+)*")
}

/// The seven replacements in Node's order. JS `\b` without the `v` flag is the ASCII word boundary.
static RULES: LazyLock<Vec<(Regex, String)>> = LazyLock::new(|| {
    let id = identifier();
    let rule = |pattern: String, replacement: &str| {
        (
            Regex::new(&pattern).unwrap_or_else(|error| panic!("{pattern}: {error}")),
            replacement.replace('M', MASK),
        )
    };
    vec![
        rule(
            r"(?i)([a-z][a-z0-9+.-]*://)[^\s/:@]+:[^\s/@]+@".to_owned(),
            "${1}M:M@",
        ),
        rule(
            r#"(?i)(authorization\s*:\s*(?:basic|bearer)\s+)(?:"[^"]*"|'[^']*'|[^\s,;"']+)"#
                .to_owned(),
            "${1}M",
        ),
        rule(
            format!(r#"(?i)([?&](?:authorization|{id})=)[^&\s"']+"#),
            "${1}M",
        ),
        rule(
            r#"(?i)((?-u:\b)authorization(?-u:\b)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,"']+)"#.to_owned(),
            "${1}M",
        ),
        rule(
            format!(r#"(?i)((?:"{id}"|'{id}')\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,"']+)"#),
            "${1}M",
        ),
        rule(
            format!(r#"(?im)(^|[^A-Za-z0-9_])({id}\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,"']+)"#),
            "${1}${2}M",
        ),
        rule(
            format!(r#"(?i)((?:--)?{id})(\s+)(?:"[^"]*"|'[^']*'|[^\s]+)"#),
            "${1}${2}M",
        ),
    ]
});

/// Node `sanitizeHookDisplayText`.
pub(crate) fn sanitize(text: &str) -> String {
    let mut out = text.to_owned();
    for (pattern, replacement) in RULES.iter() {
        out = pattern.replace_all(&out, replacement.as_str()).into_owned();
    }
    out
}

/// `Object.keys(record ?? {})`: JS property order (array-index keys first).
fn keys(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_object)
        .map(|object| properties(object).map(|(key, _)| key.clone()).collect())
        .unwrap_or_default()
}

/// `JSON.stringify(object, null, 2)` for a flat object of strings and string arrays.
fn pretty(fields: &[(&str, Field)]) -> String {
    let mut out = String::from("{");
    for (index, (key, field)) in fields.iter().enumerate() {
        out.push_str(if index == 0 { "\n  " } else { ",\n  " });
        write_str(&mut out, key);
        out.push_str(": ");
        match field {
            Field::Text(text) => write_str(&mut out, text),
            Field::List(items) if items.is_empty() => out.push_str("[]"),
            Field::List(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    out.push_str(if index == 0 { "\n    " } else { ",\n    " });
                    write_str(&mut out, item);
                }
                out.push_str("\n  ]");
            }
        }
    }
    out.push_str("\n}");
    out
}

enum Field {
    Text(String),
    List(Vec<String>),
}

/// Node `displayConfig`; `config` is a validated declaration. A URL that does not parse has no display (Node
/// throws there, which empties the whole review).
pub(crate) fn display(config: &Map<String, Value>, working_directory: &str) -> Option<String> {
    let text = |key: &str| config.get(key).and_then(Value::as_str);
    if text("type") == Some("stdio") {
        let mut command = vec![text("command")?.to_owned()];
        if let Some(args) = config.get("args").and_then(Value::as_array) {
            command.extend(args.iter().filter_map(Value::as_str).map(str::to_owned));
        }
        let fields = [
            ("command", Field::Text(sanitize(&command.join(" ")))),
            (
                "cwd",
                Field::Text(text("cwd").unwrap_or(working_directory).to_owned()),
            ),
            ("env", Field::List(keys(config.get("env")))),
        ];
        return Some(sanitize(&pretty(&fields)));
    }
    let mut url = url::Url::parse(text("url")?).ok()?;
    // Node clears username, password, search and hash before `toString()`.
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    let mut fields = vec![
        ("type", Field::Text(text("type")?.to_owned())),
        ("url", Field::Text(url.to_string())),
        ("headers", Field::List(keys(config.get("headers")))),
    ];
    if let Some(kind) = config
        .get("oauth")
        .and_then(|oauth| oauth.get("type"))
        .and_then(Value::as_str)
    {
        fields.push(("oauth", Field::Text(kind.to_owned())));
    }
    Some(pretty(&fields))
}

#[cfg(test)]
#[path = "mcp_trust_display_tests.rs"]
mod tests;
