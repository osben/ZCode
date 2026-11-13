//! Fork: the `${…}` resolver for plugin-declared language servers (specs/fork-rust-lsp.md "Templates"), Node
//! adapters `plugins/template.ts`. Node shares it with MCP servers; Rust's MCP path keeps its own narrower expansion
//! (ext.md D13), so this one is used by [`super::lsp`] only.

use rust_cli_base::secret::EnvSnapshot;
use serde_json::{Map, Value};

use super::Plugin;

/// What a template can name. `env` is the process environment (names compare like Node's `process.env`).
pub struct VariableContext<'a> {
    pub plugin: &'a Plugin,
    /// `<plugin storage>/data/<sanitized id>` (Node `dataPath`).
    pub data_path: String,
    pub env: &'a EnvSnapshot,
    /// The merged config's `plugins.options[id]`.
    pub options: &'a Map<String, Value>,
    /// The requested workspace path (Node `workingDirectory`).
    pub working_directory: String,
}

/// Node `PluginVariableError`: the message of a template that cannot be expanded.
pub type TemplateError = String;

impl VariableContext<'_> {
    /// Node `buildPluginEnvBase`, in Node's key order.
    pub fn env_base(&self) -> Vec<(String, String)> {
        let root = self.plugin.dir.clone();
        vec![
            ("CLAUDE_PROJECT_DIR".into(), self.working_directory.clone()),
            ("ZCODE_PLUGIN_DATA".into(), self.data_path.clone()),
            ("ZCODE_PLUGIN_ROOT".into(), root.clone()),
            ("ZCODE_PROJECT_DIR".into(), self.working_directory.clone()),
            ("CLAUDE_PLUGIN_DATA".into(), self.data_path.clone()),
            ("CLAUDE_PLUGIN_ROOT".into(), root),
        ]
    }

    /// Node `resolveTemplate`: every `${name}` (the name runs to the next `}`) is replaced, left to right.
    pub fn resolve(&self, value: &str, allow_sensitive: bool) -> Result<String, TemplateError> {
        let mut out = String::with_capacity(value.len());
        let mut rest = value;
        while let Some(start) = rest.find("${") {
            let after = &rest[start + 2..];
            // `[^}]+`: at least one character before the closing brace.
            let Some(end) = after.find('}').filter(|end| *end > 0) else {
                out.push_str(&rest[..start + 2]);
                rest = after;
                continue;
            };
            out.push_str(&rest[..start]);
            let name = &after[..end];
            match self.variable(name, allow_sensitive)? {
                Some(text) => out.push_str(&text),
                None => out.push_str(&rest[start..start + 2 + end + 1]),
            }
            rest = &after[end + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }

    /// `None` leaves `${name}` as written.
    fn variable(&self, name: &str, allow_sensitive: bool) -> Result<Option<String>, TemplateError> {
        match name {
            "CLAUDE_PLUGIN_ROOT" | "ZCODE_PLUGIN_ROOT" => return Ok(Some(self.plugin.dir.clone())),
            "CLAUDE_PLUGIN_DATA" | "ZCODE_PLUGIN_DATA" => return Ok(Some(self.data_path.clone())),
            "CLAUDE_PROJECT_DIR" | "ZCODE_PROJECT_DIR" => {
                return Ok(Some(self.working_directory.clone()));
            }
            "CLAUDE_CODE_SESSION_ID" | "CLAUDE_SESSION_ID" | "ZCODE_SESSION_ID" => {
                return Err(format!(
                    "Plugin variable requires a runtime session context: {name}"
                ));
            }
            "CLAUDE_SKILL_DIR" | "ZCODE_SKILL_DIR" => {
                return Err(format!("Plugin variable requires a skill context: {name}"));
            }
            _ => {}
        }
        if let Some(key) = name.strip_prefix("user_config.") {
            let option = &self.plugin.manifest["userConfig"][key];
            if option["sensitive"] == Value::Bool(true) && !allow_sensitive {
                return Err(format!(
                    "Sensitive plugin user_config value cannot be used in this field: {key}"
                ));
            }
            let value = self
                .options
                .get(key)
                .filter(|value| option_value(value))
                .or_else(|| Some(&option["default"]).filter(|value| option_value(value)));
            return match value {
                Some(value) => Ok(Some(js_string(value))),
                None => Err(format!("Missing plugin user_config value: {key}")),
            };
        }
        if name.starts_with("ZCODE_") || (allow_sensitive && environment_name(name)) {
            // Only at the sensitive sink is any other variable expanded, so a secret never lands in args.
            return match self.env.get(name) {
                Some(value) => Ok(Some(value.to_owned())),
                None => Err(format!("Missing environment variable: {name}")),
            };
        }
        Ok(None)
    }
}

/// Node `isPluginOptionValue`.
fn option_value(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_))
}

/// JS `String(value)` for an option value.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => match (number.as_i64(), number.as_u64(), number.as_f64()) {
            (Some(int), _, _) => int.to_string(),
            (_, Some(int), _) => int.to_string(),
            // JS prints an integral double below 1e21 without a fraction.
            (_, _, Some(float)) if float.fract() == 0.0 && float.abs() < 1e21 => {
                format!("{float:.0}")
            }
            (_, _, Some(float)) => float.to_string(),
            _ => number.to_string(),
        },
        other => other.to_string(),
    }
}

/// `^[A-Za-z_][A-Za-z0-9_]*$`.
fn environment_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Node `sanitizePluginId`: `[^a-zA-Z0-9_.@-]` becomes `-`.
pub fn sanitize_plugin_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '@' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect()
}
