//! Fork: the `LSP` tool's query path (specs/fork-rust-lsp.md "Tool (D2)"), Node core `lsp/operations.ts`,
//! `lsp/position.ts`, `lsp/results.ts` and `lsp/operation-output.ts`: positions, the request of each operation, and
//! the projection of raw answers into Node's `LspOutput`.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use rust_cli_base::js::json::js_double;
use rust_cli_kernel_api::lsp::{
    LspDiagnosticItem, LspHover, LspLocation, LspOperation, LspOutput, LspResultStatus, LspSymbol,
};
use serde_json::{Map, Value, json};

use super::LspError;
use super::documents::Disk;
use super::edits::{Diagnostic, column, model_path, split_lines};
use super::uri::path_of;

/// Node `LSP_MAX_RESULTS`.
pub(crate) const MAX_RESULTS: usize = 200;
/// Node `LSP_PREVIEW_MAX_CHARS` (code points).
const PREVIEW_MAX_CHARS: usize = 200;
/// Node `LSP_HOVER_MAX_CHARS` (UTF-16 units).
const HOVER_MAX_UNITS: usize = 2_000;
const HOVER_SEPARATOR: &str = "\n\n";
const HOVER_TRUNCATION_MARKER: &str = "\n...(truncated)";
/// Node `LSP_SYMBOL_KIND_NAMES`, kinds 1 to 26.
const SYMBOL_KIND_NAMES: [&str; 26] = [
    "file",
    "module",
    "namespace",
    "package",
    "class",
    "method",
    "property",
    "field",
    "constructor",
    "enum",
    "interface",
    "function",
    "variable",
    "constant",
    "string",
    "number",
    "boolean",
    "array",
    "object",
    "key",
    "null",
    "enumMember",
    "struct",
    "event",
    "operator",
    "typeParameter",
];
/// Node `OPERATION_CAPABILITY`: the initialize capability that must be truthy; none for diagnostics.
pub(crate) fn capability(operation: LspOperation) -> Option<&'static str> {
    Some(match operation {
        LspOperation::GoToDefinition => "definitionProvider",
        LspOperation::GoToImplementation => "implementationProvider",
        LspOperation::FindReferences => "referencesProvider",
        LspOperation::Hover => "hoverProvider",
        LspOperation::DocumentSymbol => "documentSymbolProvider",
        LspOperation::WorkspaceSymbol => "workspaceSymbolProvider",
        LspOperation::Diagnostics => return None,
    })
}

/// Node `buildOperationRequest` for the operations that send one.
pub(crate) fn request(
    operation: LspOperation,
    uri: &str,
    position: (u32, u32),
    include_declaration: Option<bool>,
    query: Option<&str>,
) -> Option<(&'static str, Value)> {
    let text_document = json!({"uri": uri});
    let position = json!({"line": position.0, "character": position.1});
    Some(match operation {
        LspOperation::GoToDefinition => (
            "textDocument/definition",
            json!({"textDocument": text_document, "position": position}),
        ),
        LspOperation::GoToImplementation => (
            "textDocument/implementation",
            json!({"textDocument": text_document, "position": position}),
        ),
        LspOperation::FindReferences => (
            "textDocument/references",
            json!({
                "textDocument": text_document,
                "position": position,
                "context": {"includeDeclaration": include_declaration.unwrap_or(false)},
            }),
        ),
        LspOperation::Hover => (
            "textDocument/hover",
            json!({"textDocument": text_document, "position": position}),
        ),
        LspOperation::DocumentSymbol => (
            "textDocument/documentSymbol",
            json!({"textDocument": text_document}),
        ),
        LspOperation::WorkspaceSymbol => {
            ("workspace/symbol", json!({"query": query.unwrap_or("")}))
        }
        LspOperation::Diagnostics => return None,
    })
}

fn invalid_position(message: String) -> LspError {
    LspError::new("lsp_invalid_position", message)
}

/// Node `LSP_IDENTIFIER_CHAR_SOURCE`.
fn identifier_char(char: char) -> bool {
    static CLASS: OnceLock<Regex> = OnceLock::new();
    let class = CLASS.get_or_init(|| {
        Regex::new(r"^[\p{L}\p{N}_$]$")
            .unwrap_or_else(|error| unreachable!("the identifier class compiles: {error}"))
    });
    let mut buffer = [0_u8; 4];
    class.is_match(char.encode_utf8(&mut buffer))
}

/// Node `findSymbolColumn`: the first occurrence whose neighbours are not identifier characters, as a 1-based
/// code-point column. Every start is tried, as the regex does, so an overlapping later occurrence is not skipped.
pub(crate) fn find_symbol_column(line: &str, symbol: &str) -> Option<u32> {
    if symbol.is_empty() {
        return None;
    }
    let mut previous: Option<char> = None;
    for (points, (at, char)) in line.char_indices().enumerate() {
        if line[at..].starts_with(symbol)
            && !previous.is_some_and(identifier_char)
            && !line[at + symbol.len()..]
                .chars()
                .next()
                .is_some_and(identifier_char)
        {
            return u32::try_from(points + 1).ok();
        }
        previous = Some(char);
    }
    None
}

/// Node `codePointColumnToUtf16`: columns 1 to code points + 1 (the end of the line) are valid.
fn column_to_utf16(line: &str, column: f64) -> Result<u32, LspError> {
    if column.fract() != 0.0 || !column.is_finite() || column < 1.0 {
        return Err(invalid_position(format!(
            "Column must be a positive integer, got {}",
            js_double(column)
        )));
    }
    let mut units = 0_usize;
    let mut current = 1_f64;
    for char in line.chars() {
        if current == column {
            return Ok(u32::try_from(units).unwrap_or(u32::MAX));
        }
        units += char.len_utf16();
        current += 1.0;
    }
    if current == column {
        return Ok(u32::try_from(units).unwrap_or(u32::MAX));
    }
    Err(invalid_position(format!(
        "Column {} is past the end of the line",
        js_double(column)
    )))
}

/// Node `resolveModelPosition`: the 0-based line and UTF-16 column; `symbol` wins over `character`.
pub(crate) fn resolve_position(
    lines: &[&str],
    line: f64,
    character: Option<f64>,
    symbol: Option<&str>,
) -> Result<(u32, u32), LspError> {
    #[allow(clippy::cast_precision_loss)]
    let count = lines.len() as f64;
    if line.fract() != 0.0 || !line.is_finite() || line < 1.0 || line > count {
        return Err(invalid_position(format!(
            "Line {} is outside the file (1-{})",
            js_double(line),
            lines.len()
        )));
    }
    // The guard above keeps the cast exact.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let index = line as usize - 1;
    let text = lines.get(index).copied().unwrap_or("");
    let column = match (symbol, character) {
        (Some(symbol), _) => f64::from(find_symbol_column(text, symbol).ok_or_else(|| {
            LspError::new(
                "lsp_symbol_not_found_on_line",
                format!(
                    "Symbol \"{symbol}\" does not occur as a whole word on line {}",
                    js_double(line)
                ),
            )
        })?),
        (None, Some(character)) => character,
        (None, None) => {
            return Err(invalid_position(
                "Give either character or symbol".to_owned(),
            ));
        }
    };
    Ok((
        u32::try_from(index).unwrap_or(u32::MAX),
        column_to_utf16(text, column)?,
    ))
}

struct Range {
    start: (f64, f64),
    end: (f64, f64),
}

/// Node `isRange`: four numbers.
fn range(value: Option<&Value>) -> Option<Range> {
    let value = value?;
    let point = |key: &str| -> Option<(f64, f64)> {
        let position = value.get(key)?.as_object()?;
        Some((
            position.get("line")?.as_f64()?,
            position.get("character")?.as_f64()?,
        ))
    };
    Some(Range {
        start: point("start")?,
        end: point("end")?,
    })
}

/// Node `normalizeLocations`: `Location | Location[] | LocationLink[] | null`; malformed items are skipped.
fn normalize_locations(raw: &Value) -> Vec<(String, Range)> {
    let items: Vec<&Value> = match raw {
        Value::Array(items) => items.iter().collect(),
        Value::Null => Vec::new(),
        other => vec![other],
    };
    let mut result = Vec::new();
    for item in items {
        let Some(item) = item.as_object() else {
            continue;
        };
        if let Some(target) = item.get("targetUri").and_then(Value::as_str) {
            // `??`: a null selection range falls back to the target range.
            let selection = item
                .get("targetSelectionRange")
                .filter(|value| !value.is_null())
                .or_else(|| item.get("targetRange"));
            if let Some(range) = range(selection) {
                result.push((target.to_owned(), range));
            }
            continue;
        }
        if let (Some(uri), Some(range)) = (
            item.get("uri").and_then(Value::as_str),
            range(item.get("range")),
        ) {
            result.push((uri.to_owned(), range));
        }
    }
    result
}

/// Node `hoverContentsToText`.
fn hover_text(contents: Option<&Value>) -> String {
    match contents {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(entries)) => entries
            .iter()
            .map(|entry| hover_text(Some(entry)))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(HOVER_SEPARATOR),
        Some(Value::Object(record)) => record
            .get("value")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// Node `normalizeHover`: trimmed text, cut to 2000 UTF-16 units; empty is none.
fn normalize_hover(raw: &Value) -> Option<String> {
    let record = raw.as_object()?;
    let text = js_trim(&hover_text(record.get("contents"))).to_owned();
    if text.is_empty() {
        return None;
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= HOVER_MAX_UNITS {
        return Some(text);
    }
    // `slice` may cut a surrogate pair; the lone half becomes U+FFFD, as it does when Node encodes it.
    Some(format!(
        "{}{HOVER_TRUNCATION_MARKER}",
        String::from_utf16_lossy(&units[..HOVER_MAX_UNITS])
    ))
}

/// Node `symbolKindName`.
fn symbol_kind(kind: Option<&Value>) -> &'static str {
    kind.and_then(Value::as_f64)
        .filter(|kind| kind.fract() == 0.0 && *kind >= 1.0)
        // The filter keeps the cast exact.
        .and_then(|kind| {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            SYMBOL_KIND_NAMES.get(kind as usize - 1).copied()
        })
        .unwrap_or("unknown")
}

struct RawSymbol {
    name: String,
    kind: &'static str,
    container: Option<String>,
    uri: String,
    line: f64,
}

/// Node `collectSymbol`: a DocumentSymbol tree flattened depth first, or a SymbolInformation.
fn collect_symbol(
    item: &Value,
    document_uri: &str,
    container: Option<&str>,
    out: &mut Vec<RawSymbol>,
) {
    let Some(record) = item.as_object() else {
        return;
    };
    let Some(name) = record.get("name").and_then(Value::as_str) else {
        return;
    };
    let kind = symbol_kind(record.get("kind"));
    if let Some(selection) = range(record.get("selectionRange")) {
        out.push(RawSymbol {
            name: name.to_owned(),
            kind,
            container: container.map(str::to_owned),
            uri: document_uri.to_owned(),
            line: selection.start.0,
        });
        if let Some(children) = record.get("children").and_then(Value::as_array) {
            for child in children {
                collect_symbol(child, document_uri, Some(name), out);
            }
        }
        return;
    }
    let location = record.get("location").and_then(Value::as_object);
    let uri = location
        .and_then(|location| location.get("uri"))
        .and_then(Value::as_str);
    let found = location.and_then(|location| range(location.get("range")));
    if let (Some(uri), Some(found)) = (uri, found) {
        let own = record.get("containerName").and_then(Value::as_str);
        out.push(RawSymbol {
            name: name.to_owned(),
            kind,
            container: own.or(container).map(str::to_owned),
            uri: uri.to_owned(),
            line: found.start.0,
        });
    }
}

/// JS `String.prototype.trim`: ECMAScript WhiteSpace and LineTerminator, which is Unicode White_Space without NEL
/// (U+0085, a control) plus the BOM.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|char: char| (char.is_whitespace() && char != '\u{85}') || char == '\u{feff}')
}

/// Node `previewOf`.
fn preview(line: Option<&str>) -> String {
    js_trim(line.unwrap_or(""))
        .chars()
        .take(PREVIEW_MAX_CHARS)
        .collect()
}

/// A JS number plus one as the tool reports it; servers send integers.
fn model_index(value: f64) -> i64 {
    // Saturating float-to-int, as an integer field cannot carry Node's fractional garbage.
    #[allow(clippy::cast_possible_truncation)]
    let index = value as i64;
    index.saturating_add(1)
}

/// Node `toModelPosition`'s column: the UTF-16 index clamped to the line.
fn model_column(lines: &[String], line: f64, character: f64) -> i64 {
    let text = if line >= 0.0 && line.fract() == 0.0 {
        // The guard keeps the cast exact.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        lines.get(line as usize).map_or("", String::as_str)
    } else {
        ""
    };
    i64::from(column(text, character.max(0.0)))
}

/// Node `SourceLineReader`: each file is read once per call; an unreadable file has no lines.
pub(crate) struct LineReader<'a> {
    disk: &'a dyn Disk,
    cache: HashMap<String, Option<Vec<String>>>,
}

impl<'a> LineReader<'a> {
    pub(crate) fn new(disk: &'a dyn Disk) -> Self {
        Self {
            disk,
            cache: HashMap::new(),
        }
    }

    async fn lines(&mut self, path: &str) -> Option<&Vec<String>> {
        if !self.cache.contains_key(path) {
            let lines = self
                .disk
                .read(path)
                .await
                .ok()
                .map(|text| split_lines(&text).into_iter().map(str::to_owned).collect());
            self.cache.insert(path.to_owned(), lines);
        }
        self.cache.get(path).and_then(Option::as_ref)
    }
}

/// What a projection needs besides the raw answer.
pub(crate) struct Projection<'a> {
    pub(crate) operation: LspOperation,
    pub(crate) server_id: &'a str,
    pub(crate) document_uri: &'a str,
    pub(crate) workspace: &'a str,
    pub(crate) windows: bool,
    pub(crate) status: LspResultStatus,
}

fn file_path(uri: &str, windows: bool) -> Result<String, LspError> {
    // Node `fromFileUri` lets `fileURLToPath` throw: the model sees its message.
    path_of(uri, windows).map_err(|error| LspError::new(error.code, error.message))
}

fn cap<T>(mut items: Vec<T>) -> (Vec<T>, bool, usize) {
    let total = items.len();
    items.truncate(MAX_RESULTS);
    (items, total > MAX_RESULTS, total)
}

/// Node `projectOperationResult` for every operation but diagnostics.
pub(crate) async fn project(
    input: &Projection<'_>,
    raw: &Value,
    reader: &mut LineReader<'_>,
) -> Result<LspOutput, LspError> {
    let mut output = LspOutput {
        operation: input.operation,
        server: input.server_id.to_owned(),
        status: input.status,
        locations: None,
        symbols: None,
        hover: None,
        diagnostics: None,
        truncated: false,
        total: None,
    };
    match input.operation {
        LspOperation::GoToDefinition
        | LspOperation::GoToImplementation
        | LspOperation::FindReferences => {
            let mut locations = Vec::new();
            for (uri, found) in normalize_locations(raw) {
                let path = file_path(&uri, input.windows)?;
                let lines = reader.lines(&path).await;
                let start_line = found.start.0;
                let (character, end_character) = match lines {
                    Some(lines) => (
                        model_column(lines, start_line, found.start.1),
                        model_column(lines, found.end.0, found.end.1),
                    ),
                    None => (model_index(found.start.1), model_index(found.end.1)),
                };
                let preview_line = lines.and_then(|lines| {
                    (start_line >= 0.0 && start_line.fract() == 0.0)
                        .then(|| {
                            // The guard keeps the cast exact.
                            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                            lines.get(start_line as usize).map(String::as_str)
                        })
                        .flatten()
                });
                locations.push(LspLocation {
                    path: model_path(&path, input.workspace, input.windows),
                    line: model_index(start_line),
                    character,
                    end_line: model_index(found.end.0),
                    end_character,
                    preview: preview(preview_line),
                });
            }
            let (items, truncated, total) = cap(locations);
            output.locations = Some(items);
            output.truncated = truncated;
            output.total = Some(total);
        }
        LspOperation::Hover => {
            output.hover = normalize_hover(raw).map(|contents| LspHover { contents });
        }
        LspOperation::DocumentSymbol | LspOperation::WorkspaceSymbol => {
            let mut raw_symbols = Vec::new();
            if let Some(items) = raw.as_array() {
                for item in items {
                    collect_symbol(item, input.document_uri, None, &mut raw_symbols);
                }
            }
            let mut symbols = Vec::new();
            for symbol in raw_symbols {
                let path = file_path(&symbol.uri, input.windows)?;
                symbols.push(LspSymbol {
                    name: symbol.name,
                    kind: symbol.kind.to_owned(),
                    path: model_path(&path, input.workspace, input.windows),
                    line: model_index(symbol.line),
                    container_name: symbol.container,
                });
            }
            let (items, truncated, total) = cap(symbols);
            output.symbols = Some(items);
            output.truncated = truncated;
            output.total = Some(total);
        }
        LspOperation::Diagnostics => {
            unreachable!("diagnostics are projected by project_diagnostics")
        }
    }
    Ok(output)
}

/// Node `projectDiagnostics`: errors and warnings of one file, capped.
pub(crate) fn project_diagnostics(
    server_id: &str,
    path: &str,
    items: &[Diagnostic],
    workspace: &str,
    windows: bool,
    status: LspResultStatus,
) -> LspOutput {
    let reportable: Vec<&Diagnostic> = items
        .iter()
        .filter(|item| item.severity.reportable())
        .collect();
    let (items, truncated, total) = cap(reportable);
    let model = model_path(path, workspace, windows);
    LspOutput {
        operation: LspOperation::Diagnostics,
        server: server_id.to_owned(),
        status,
        locations: None,
        symbols: None,
        hover: None,
        diagnostics: Some(
            items
                .into_iter()
                .map(|item| LspDiagnosticItem {
                    path: model.clone(),
                    line: item.line,
                    character: item.character,
                    severity: item.severity.as_str().to_owned(),
                    message: item.message.clone(),
                    code: item.code.clone(),
                    source: item.source.clone(),
                })
                .collect(),
        ),
        truncated,
        total: Some(total),
    }
}

/// JS truthiness of a capability value (Node `!connection.capabilities[capability]`).
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

/// The capabilities map's truthiness for an operation.
pub(crate) fn supports(capabilities: &Map<String, Value>, operation: LspOperation) -> bool {
    capability(operation).is_none_or(|name| truthy(capabilities.get(name)))
}

#[cfg(test)]
#[path = "query_tests.rs"]
mod tests;
