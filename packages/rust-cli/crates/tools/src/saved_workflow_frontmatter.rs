//! Fork: the frontmatter codec of saved workflows (Node `saved-workflows/frontmatter.ts`; the file format is documented there).
//!
//! A saved file starts with a `/* zcode-workflow` block holding YAML, closed by a line `*/`; the script follows byte for
//! byte. Writing matches Node's `yaml` 2.9 output for the shapes a definition has (plain scalars, quoted strings, nested
//! maps and sequences). Where Node folds a long plain line or writes a block scalar, this writes one double-quoted line:
//! the same value, different bytes (divergence 103 in the fork spec).

use serde_json::{Map, Value};
use yaml_rust2::{Yaml, YamlLoader};

use super::{ArgDecl, ArgType, Meta};

/// Opening marker for frontmatter. Must be the first non-blank content in the file.
pub const SENTINEL: &str = "/* zcode-workflow";
const TERMINATOR: &str = "*/";

/// Why a file is not a saved workflow. Each reason needs different guidance from the model, so each has its own name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    MissingFrontmatter,
    UnterminatedFrontmatter,
    InvalidYaml(String),
    InvalidMetadata(String),
}

impl ParseError {
    /// Node's reason literal.
    pub fn reason(&self) -> &'static str {
        match self {
            Self::MissingFrontmatter => "missing_frontmatter",
            Self::UnterminatedFrontmatter => "unterminated_frontmatter",
            Self::InvalidYaml(_) => "invalid_yaml",
            Self::InvalidMetadata(_) => "invalid_metadata",
        }
    }

    /// Node's detail text.
    pub fn detail(&self) -> String {
        match self {
            Self::MissingFrontmatter => {
                format!("file does not start with the `{SENTINEL}` metadata block")
            }
            Self::UnterminatedFrontmatter => {
                format!("metadata block is never closed with `{TERMINATOR}`")
            }
            Self::InvalidYaml(detail) | Self::InvalidMetadata(detail) => detail.clone(),
        }
    }
}

/// A parsed file: its metadata, its script, and the number of lines before the script (diagnostics in file lines add it).
#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub meta: Meta,
    pub script: String,
    pub body_line_offset: usize,
}

/// Metadata and script to file text. Key order is fixed (description, whenToUse, args), so two saves of one definition
/// are byte-identical.
pub fn serialize(meta: &Meta, script: &str) -> String {
    let mut root = Map::new();
    root.insert(
        "description".to_owned(),
        Value::String(meta.description.clone()),
    );
    if let Some(when) = &meta.when_to_use {
        root.insert("whenToUse".to_owned(), Value::String(when.clone()));
    }
    if let Some(args) = &meta.args {
        let mut declared = Map::new();
        for (name, decl) in args {
            declared.insert(name.clone(), decl_value(decl));
        }
        root.insert("args".to_owned(), Value::Object(declared));
    }
    let mut text = String::from(SENTINEL);
    text.push('\n');
    for line in render_entries(0, &root) {
        text.push_str(&line);
        text.push('\n');
    }
    text.push_str(TERMINATOR);
    text.push('\n');
    text.push_str(script);
    text
}

fn decl_value(decl: &ArgDecl) -> Value {
    let mut object = Map::new();
    object.insert(
        "type".to_owned(),
        Value::String(decl.ty.as_str().to_owned()),
    );
    if let Some(description) = &decl.description {
        object.insert("description".to_owned(), Value::String(description.clone()));
    }
    if let Some(required) = decl.required {
        object.insert("required".to_owned(), Value::Bool(required));
    }
    if let Some(default) = &decl.default {
        object.insert("default".to_owned(), default.clone());
    }
    Value::Object(object)
}

/// File text to metadata and script. Lines are split on `\n` and compared trimmed, as Node does.
pub fn parse(source: &str) -> Result<Parsed, ParseError> {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let lines: Vec<&str> = source.split('\n').collect();
    let mut start = 0;
    while start < lines.len() && lines[start].trim().is_empty() {
        start += 1;
    }
    if start >= lines.len() || lines[start].trim() != SENTINEL {
        return Err(ParseError::MissingFrontmatter);
    }
    let mut end = start + 1;
    while end < lines.len() && lines[end].trim() != TERMINATOR {
        end += 1;
    }
    if end >= lines.len() {
        return Err(ParseError::UnterminatedFrontmatter);
    }
    let body_text = lines[start + 1..end].join("\n");
    let script = lines[end + 1..].join("\n");
    let meta = parse_metadata(&body_text)?;
    Ok(Parsed {
        meta,
        script,
        body_line_offset: end + 1,
    })
}

/// Whether a saved file starts with the block marker: the first non-blank line is `/* zcode-workflow`.
pub fn starts_with_sentinel(source: &str) -> bool {
    source
        .strip_prefix('\u{feff}')
        .unwrap_or(source)
        .split('\n')
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| line.trim() == SENTINEL)
}

fn parse_metadata(body_text: &str) -> Result<Meta, ParseError> {
    let documents = YamlLoader::load_from_str(body_text)
        .map_err(|error| ParseError::InvalidYaml(error.to_string()))?;
    if documents.len() > 1 {
        return Err(ParseError::InvalidYaml(multiple_documents_text(body_text)));
    }
    let root = documents.into_iter().next().unwrap_or(Yaml::Null);
    let mut issues = Issues::new();
    let meta = meta_from(&root, &mut issues);
    match (meta, issues.into_detail()) {
        (Some(meta), None) => Ok(meta),
        (_, Some(detail)) => Err(ParseError::InvalidMetadata(detail)),
        (None, None) => Err(ParseError::InvalidMetadata(
            "(root): Invalid metadata".to_owned(),
        )),
    }
}

/// Collected validation messages, `path: message`, joined with `; ` as Node's zod failure does.
struct Issues(Vec<String>);

impl Issues {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn add(&mut self, path: &str, message: &str) {
        self.0.push(format!("{path}: {message}"));
    }

    fn into_detail(self) -> Option<String> {
        (!self.0.is_empty()).then(|| self.0.join("; "))
    }
}

/// yaml 2.9's text for a second document: the line of its `---` marker, then the text up to that line.
fn multiple_documents_text(body_text: &str) -> String {
    let lines: Vec<&str> = body_text.split('\n').collect();
    let marker = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| line.starts_with("---"))
        .map_or(lines.len().saturating_sub(1), |(index, _)| index);
    format!(
        "Source contains multiple documents; please use YAML.parseAllDocuments() at line {}, column 1:\n\n{}\n^\n",
        marker + 1,
        lines[..=marker].join("\n")
    )
}

fn meta_from(root: &Yaml, issues: &mut Issues) -> Option<Meta> {
    let Yaml::Hash(entries) = root else {
        issues.add(
            "(root)",
            &format!("Expected object, received {}", describe(root)),
        );
        return None;
    };
    unknown_keys(
        "(root)",
        entries.keys(),
        &["description", "whenToUse", "args"],
        issues,
    );
    let description = match entries.get(&key("description")) {
        None => {
            issues.add("description", "Required");
            None
        }
        Some(value) => non_empty_string("description", value, issues),
    };
    let when_to_use = entries
        .get(&key("whenToUse"))
        .and_then(|value| non_empty_string("whenToUse", value, issues));
    let args = match entries.get(&key("args")) {
        None => None,
        Some(value) => args_from(value, issues),
    };
    Some(Meta {
        description: description?,
        when_to_use,
        args,
    })
}

fn args_from(value: &Yaml, issues: &mut Issues) -> Option<Vec<(String, ArgDecl)>> {
    let Yaml::Hash(entries) = value else {
        issues.add(
            "args",
            &format!("Expected object, received {}", describe(value)),
        );
        return None;
    };
    let mut declared = Vec::new();
    for (name, decl) in entries {
        let name = scalar_text(name).unwrap_or_default();
        let path = format!("args.{name}");
        if let Some(parsed) = arg_from(&path, decl, issues) {
            declared.push((name, parsed));
        }
    }
    Some(declared)
}

fn arg_from(path: &str, value: &Yaml, issues: &mut Issues) -> Option<ArgDecl> {
    let Yaml::Hash(entries) = value else {
        issues.add(
            path,
            &format!("Expected object, received {}", describe(value)),
        );
        return None;
    };
    unknown_keys(
        path,
        entries.keys(),
        &["type", "description", "required", "default"],
        issues,
    );
    let ty = match entries.get(&key("type")) {
        None => {
            issues.add(&format!("{path}.type"), "Required");
            None
        }
        Some(Yaml::String(text)) => match ArgType::parse(text) {
            Some(ty) => Some(ty),
            None => {
                issues.add(
                    &format!("{path}.type"),
                    &format!(
                        "Invalid enum value. Expected 'string' | 'number' | 'boolean' | 'json', received '{text}'"
                    ),
                );
                None
            }
        },
        Some(other) => {
            issues.add(
                &format!("{path}.type"),
                &format!("Expected string, received {}", describe(other)),
            );
            None
        }
    };
    let description = entries
        .get(&key("description"))
        .and_then(|value| plain_string(&format!("{path}.description"), value, issues));
    let required = match entries.get(&key("required")) {
        None => None,
        Some(Yaml::Boolean(flag)) => Some(*flag),
        Some(other) => {
            issues.add(
                &format!("{path}.required"),
                &format!("Expected boolean, received {}", describe(other)),
            );
            None
        }
    };
    let default = entries.get(&key("default")).map(yaml_to_json);
    Some(ArgDecl {
        ty: ty?,
        description,
        required,
        default,
    })
}

fn unknown_keys<'a>(
    path: &str,
    keys: impl Iterator<Item = &'a Yaml>,
    known: &[&str],
    issues: &mut Issues,
) {
    let unknown: Vec<String> = keys
        .filter_map(scalar_text)
        .filter(|name| !known.contains(&name.as_str()))
        .collect();
    if !unknown.is_empty() {
        let names: Vec<String> = unknown.iter().map(|name| format!("'{name}'")).collect();
        issues.add(
            path,
            &format!("Unrecognized key(s) in object: {}", names.join(", ")),
        );
    }
}

fn non_empty_string(path: &str, value: &Yaml, issues: &mut Issues) -> Option<String> {
    match value {
        Yaml::String(text) if text.is_empty() => {
            issues.add(path, "String must contain at least 1 character(s)");
            None
        }
        Yaml::String(text) => Some(text.clone()),
        other => {
            issues.add(
                path,
                &format!("Expected string, received {}", describe(other)),
            );
            None
        }
    }
}

/// A string that may be empty (an argument's description is `z.string().optional()`, with no minimum length).
fn plain_string(path: &str, value: &Yaml, issues: &mut Issues) -> Option<String> {
    match value {
        Yaml::String(text) => Some(text.clone()),
        other => {
            issues.add(
                path,
                &format!("Expected string, received {}", describe(other)),
            );
            None
        }
    }
}

fn key(name: &str) -> Yaml {
    Yaml::String(name.to_owned())
}

fn scalar_text(value: &Yaml) -> Option<String> {
    match value {
        Yaml::String(text) => Some(text.clone()),
        Yaml::Integer(number) => Some(number.to_string()),
        Yaml::Boolean(flag) => Some(flag.to_string()),
        Yaml::Real(text) => Some(text.clone()),
        _ => None,
    }
}

/// zod's name for a received value, as its validation messages use it.
fn describe(value: &Yaml) -> &'static str {
    match value {
        Yaml::Null | Yaml::BadValue => "null",
        Yaml::Boolean(_) => "boolean",
        Yaml::Integer(_) | Yaml::Real(_) => "number",
        Yaml::String(_) => "string",
        Yaml::Array(_) => "array",
        Yaml::Hash(_) => "object",
        Yaml::Alias(_) => "alias",
    }
}

/// A YAML value as the JSON value a default is: keys keep their order, numbers keep their value.
fn yaml_to_json(value: &Yaml) -> Value {
    match value {
        Yaml::Null | Yaml::BadValue | Yaml::Alias(_) => Value::Null,
        Yaml::Boolean(flag) => Value::Bool(*flag),
        Yaml::Integer(number) => Value::from(*number),
        Yaml::Real(text) => text
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map_or_else(|| Value::String(text.clone()), Value::Number),
        Yaml::String(text) => Value::String(text.clone()),
        Yaml::Array(items) => Value::Array(items.iter().map(yaml_to_json).collect()),
        Yaml::Hash(entries) => {
            let mut object = Map::new();
            for (name, item) in entries {
                if let Some(name) = scalar_text(name) {
                    object.insert(name, yaml_to_json(item));
                }
            }
            Value::Object(object)
        }
    }
}

impl ArgType {
    fn as_str(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Json => "json",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "string" => Self::String,
            "number" => Self::Number,
            "boolean" => Self::Boolean,
            "json" => Self::Json,
            _ => return None,
        })
    }
}

/// Lines of a mapping at `indent`, in the layout `yaml` 2.x writes.
fn render_entries(indent: usize, object: &Map<String, Value>) -> Vec<String> {
    let mut lines = Vec::new();
    for (name, value) in object {
        lines.extend(render_entry(indent, &scalar(name), value));
    }
    lines
}

fn render_entry(indent: usize, key: &str, value: &Value) -> Vec<String> {
    let pad = " ".repeat(indent);
    match value {
        Value::Object(object) if object.is_empty() => vec![format!("{pad}{key}: {{}}")],
        Value::Array(items) if items.is_empty() => vec![format!("{pad}{key}: []")],
        Value::Object(object) => {
            let mut lines = vec![format!("{pad}{key}:")];
            lines.extend(render_entries(indent + 2, object));
            lines
        }
        Value::Array(items) => {
            let mut lines = vec![format!("{pad}{key}:")];
            lines.extend(render_sequence(indent + 2, items));
            lines
        }
        scalar_value => vec![format!("{pad}{key}: {}", scalar_value_text(scalar_value))],
    }
}

fn render_sequence(indent: usize, items: &[Value]) -> Vec<String> {
    let pad = " ".repeat(indent);
    let mut lines = Vec::new();
    for item in items {
        match item {
            Value::Object(object) if !object.is_empty() => {
                let mut block = render_entries(indent + 2, object);
                block[0] = format!("{pad}- {}", block[0].trim_start());
                lines.extend(block);
            }
            Value::Array(inner) if !inner.is_empty() => {
                let mut block = render_sequence(indent + 2, inner);
                block[0] = format!("{pad}- {}", block[0].trim_start());
                lines.extend(block);
            }
            other => lines.push(format!("{pad}- {}", scalar_value_text(other))),
        }
    }
    lines
}

fn scalar_value_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_text(number),
        Value::String(text) => scalar(text),
        Value::Object(_) => "{}".to_owned(),
        Value::Array(_) => "[]".to_owned(),
    }
}

fn number_text(number: &serde_json::Number) -> String {
    if let Some(integer) = number.as_i64() {
        return integer.to_string();
    }
    let Some(float) = number.as_f64() else {
        return "null".to_owned();
    };
    let magnitude = float.abs();
    if (1e-6..1e21).contains(&magnitude) {
        return format!("{float}");
    }
    // Rust writes the exponent without a sign for positive exponents; JavaScript writes `e+`.
    let exponent_form = format!("{float:e}");
    match exponent_form.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => exponent_form,
    }
}

/// A string as a YAML scalar: plain when YAML reads it back as the same string, otherwise quoted.
fn scalar(text: &str) -> String {
    if plain_is_safe(text) {
        return text.to_owned();
    }
    let has_control = text.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f);
    if text.contains('"') && !has_control {
        return format!("'{}'", text.replace('\'', "''"));
    }
    let mut quoted = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\t' => quoted.push_str("\\t"),
            '\r' => quoted.push_str("\\r"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                quoted.push_str(&format!("\\x{:02X}", c as u32));
            }
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

fn plain_is_safe(text: &str) -> bool {
    let Some(first) = text.chars().next() else {
        return false;
    };
    if text.contains('\u{85}') {
        return false;
    }
    if text.trim() != text
        || text
            .chars()
            .any(|c| c == '\n' || c == '\r' || (c as u32) < 0x20 || c as u32 == 0x7f)
    {
        return false;
    }
    let second = text.chars().nth(1);
    if matches!(first, '-' | '?' | ':') && second.is_none_or(|c| c == ' ') {
        return false;
    }
    if ",[]{}#&*!|>'\"%@`".contains(first) {
        return false;
    }
    if text.contains(": ") || text.ends_with(':') || text.contains(" #") {
        return false;
    }
    !resolves_as_non_string(text)
}

/// Whether YAML 1.2 reads the plain text as a boolean, null, number or special float (so it must be quoted).
fn resolves_as_non_string(text: &str) -> bool {
    matches!(
        text,
        "true" | "True" | "TRUE" | "false" | "False" | "FALSE" | "null" | "Null" | "NULL" | "~"
    ) || is_yaml_number(text)
}

/// The YAML 1.2 core-schema number forms: decimal (with an optional fraction and exponent), hex, octal, and the
/// special floats `.inf` and `.nan`.
fn is_yaml_number(text: &str) -> bool {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if matches!(text, ".nan" | ".NaN" | ".NAN") || matches!(unsigned, ".inf" | ".Inf" | ".INF") {
        return true;
    }
    if let Some(hex) = unsigned.strip_prefix("0x") {
        return !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    if let Some(octal) = unsigned.strip_prefix("0o") {
        return !octal.is_empty() && octal.chars().all(|c| ('0'..='7').contains(&c));
    }
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let exponent_ok = exponent.is_none_or(|exp| {
        let digits = exp.strip_prefix(['+', '-']).unwrap_or(exp);
        !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
    });
    let (whole, fraction) = match mantissa.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (mantissa, None),
    };
    let fraction_ok = fraction.is_none_or(|fraction| fraction.chars().all(|c| c.is_ascii_digit()));
    let digits = whole.chars().all(|c| c.is_ascii_digit()) && fraction_ok;
    let has_digit = whole.chars().any(|c| c.is_ascii_digit())
        || fraction.is_some_and(|fraction| fraction.chars().any(|c| c.is_ascii_digit()));
    digits && has_digit && exponent_ok
}
