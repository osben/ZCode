//! Fork: the `mcp_tool` display of an MCP tool result (specs/fork-rust-plugin-ui-tool-result.md). Port of Node
//! `createMcpToolDisplay` (core `tool/executor/result-display.ts`) and `normalizeMcpToolUiMeta` (shared
//! `mcp-apps/toolMeta.ts`). The `ui` block is strict on the desktop side: a key outside Node's list fails the whole
//! display, so this module writes exactly Node's keys.

use rust_cli_base::js::json::stringify;
use serde_json::{Map, Value, json};

/// Node `MCP_TOOL_DISPLAY_MAX_NAME_CHARS` and `MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS` (UTF-16 units).
const MAX_NAME_UNITS: usize = 256;
const MAX_DESCRIPTION_UNITS: usize = 4 * 1024;
/// Node `MCP_APPS_RESOURCE_URI_MAX_CHARS`, `MCP_APPS_SURFACE_ID_MAX_CHARS`.
const MAX_RESOURCE_URI_UNITS: usize = 2048;
const MAX_SURFACE_UNITS: usize = 128;
/// Node `MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES`, `MCP_APPS_WIDGET_META_MAX_BYTES`, `MCP_APPS_CONTENT_MAX_BYTES`.
const STRUCTURED_MAX_BYTES: usize = 64 * 1024;
const WIDGET_META_MAX_BYTES: usize = 16 * 1024;
const CONTENT_MAX_BYTES: usize = 32 * 1024;

/// A tool's UI descriptor, normalised once from its listed `_meta` (Node `McpToolUiDescriptor` without `visibility`,
/// which is never part of the display).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ToolUi {
    resource_uri: String,
    preferred_display_mode: Option<&'static str>,
    /// Domain lists by key, in Node's order; a present list counts even when empty.
    csp: Vec<(&'static str, Vec<String>)>,
    prefers_border: Option<bool>,
    surface: Option<String>,
    show_inline: Option<bool>,
}

/// What a tool's display is built from (Node `McpToolDisplayMetadata`).
pub(crate) struct Presentation<'a> {
    pub server: &'a str,
    pub tool: &'a str,
    pub description: Option<&'a str>,
    /// The owning plugin's id; `None` for a server no plugin declares (the server name stands in).
    pub plugin_id: Option<&'a str>,
    pub ui: Option<&'a ToolUi>,
}

/// Node `normalizeMcpToolUiMeta`.
pub(crate) fn tool_ui(meta: Option<&Value>) -> Option<ToolUi> {
    let root = meta?.as_object()?;
    let ui = root.get("ui").and_then(Value::as_object);
    let resource_uri = resource_uri(ui.and_then(|ui| ui.get("resourceUri")))
        .or_else(|| resource_uri(root.get("ui/resourceUri")))
        .or_else(|| resource_uri(root.get("openai/outputTemplate")))?;
    let preferred_display_mode = root
        .get("openai/ui")
        .and_then(Value::as_object)
        .and_then(|openai| openai.get("preferredModelDisplayMode"))
        .and_then(Value::as_str)
        .and_then(|mode| {
            ["inline", "fullscreen", "pip"]
                .into_iter()
                .find(|m| *m == mode)
        });
    let modern = ui.and_then(|ui| ui.get("csp")).and_then(Value::as_object);
    let legacy = root.get("openai/widgetCSP").and_then(Value::as_object);
    let csp = [
        ("connectDomains", "connect_domains"),
        ("resourceDomains", "resource_domains"),
        ("frameDomains", "frame_domains"),
        ("baseUriDomains", "base_uri_domains"),
    ]
    .into_iter()
    .filter_map(|(camel, snake)| {
        let pick = |map: Option<&Map<String, Value>>, key: &str| {
            map.and_then(|map| map.get(key)).and_then(origin_list)
        };
        pick(modern, camel)
            .or_else(|| pick(legacy, camel))
            .or_else(|| pick(legacy, snake))
            .map(|list| (camel, list))
    })
    .collect();
    let flag = |own: &str, alias: &str| {
        ui.and_then(|ui| ui.get(own))
            .and_then(Value::as_bool)
            .or_else(|| root.get(alias).and_then(Value::as_bool))
    };
    Some(ToolUi {
        resource_uri,
        preferred_display_mode,
        csp,
        prefers_border: flag("prefersBorder", "openai/widgetPrefersBorder"),
        surface: surface_id(ui.and_then(|ui| ui.get("surface"))),
        show_inline: flag("showInline", "openai/widgetShowCodexWidgetInline"),
    })
}

/// Node `createMcpToolDisplay`: `Null` when the server or tool name is empty. `output` is the raw `tools/call` result.
pub(crate) fn display(presentation: &Presentation<'_>, output: &Value) -> Value {
    let (Some(server), Some(tool)) = (
        bounded(presentation.server, MAX_NAME_UNITS),
        bounded(presentation.tool, MAX_NAME_UNITS),
    ) else {
        return Value::Null;
    };
    let mut shown = Map::new();
    shown.insert("kind".into(), json!("mcp_tool"));
    shown.insert("serverName".into(), json!(server));
    shown.insert("toolName".into(), json!(tool));
    if let Some(description) = presentation
        .description
        .and_then(|text| bounded(text, MAX_DESCRIPTION_UNITS))
    {
        shown.insert("description".into(), json!(description));
    }
    if let Some(ui) = presentation
        .ui
        .and_then(|ui| ui_block(presentation, ui, output))
    {
        shown.insert("ui".into(), ui);
    }
    Value::Object(shown)
}

/// Node `createMcpToolDisplayUi`.
fn ui_block(presentation: &Presentation<'_>, ui: &ToolUi, output: &Value) -> Option<Value> {
    let plugin_id = bounded(
        presentation.plugin_id.unwrap_or(presentation.server),
        MAX_NAME_UNITS,
    )?;
    let structured = bound_json(output.get("structuredContent"), STRUCTURED_MAX_BYTES);
    let meta = bound_json(output.get("_meta"), WIDGET_META_MAX_BYTES);
    let content = bound_json(
        output.get("content").filter(|value| value.is_array()),
        CONTENT_MAX_BYTES,
    );
    let dropped: usize = [&structured, &meta, &content]
        .into_iter()
        .filter_map(|field| match field {
            Some(Bounded::Over(bytes)) => Some(*bytes),
            _ => None,
        })
        .sum();
    let any_dropped = [&structured, &meta, &content]
        .into_iter()
        .any(|field| matches!(field, Some(Bounded::Over(_))));
    let mut block = Map::new();
    block.insert("pluginId".into(), json!(plugin_id));
    block.insert("resourceUri".into(), json!(ui.resource_uri));
    if let Some(mode) = ui.preferred_display_mode {
        block.insert("preferredDisplayMode".into(), json!(mode));
    }
    if let Some(border) = ui.prefers_border {
        block.insert("prefersBorder".into(), json!(border));
    }
    if !ui.csp.is_empty() {
        let csp: Map<String, Value> = ui
            .csp
            .iter()
            .map(|(key, list)| ((*key).to_owned(), json!(list)))
            .collect();
        block.insert("csp".into(), Value::Object(csp));
    }
    for (key, field) in [
        ("structuredContent", structured),
        ("widgetMeta", meta),
        ("content", content),
    ] {
        if let Some(Bounded::Text(text)) = field {
            block.insert(key.into(), json!(text));
        }
    }
    if any_dropped {
        block.insert("truncated".into(), json!(true));
        block.insert("truncatedBytes".into(), json!(dropped));
    }
    if output.get("isError") == Some(&json!(true)) {
        block.insert("isError".into(), json!(true));
    }
    if let Some(surface) = &ui.surface {
        block.insert("surface".into(), json!(surface));
    }
    if ui.show_inline == Some(true) {
        block.insert("showInline".into(), json!(true));
    }
    Some(Value::Object(block))
}

enum Bounded {
    Text(String),
    /// Over the limit: only the byte length is kept.
    Over(usize),
}

/// Node `boundJsonText`: JSON text up to `max` UTF-8 bytes; above it only the byte count. Missing and null: `None`.
fn bound_json(value: Option<&Value>, max: usize) -> Option<Bounded> {
    let value = value.filter(|value| !value.is_null())?;
    let text = stringify(value);
    Some(if text.len() <= max {
        Bounded::Text(text)
    } else {
        Bounded::Over(text.len())
    })
}

/// Node `boundMcpDisplayText`: trimmed, cut to `max` UTF-16 units, never inside a surrogate pair; empty is `None`.
fn bounded(value: &str, max: usize) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut units = 0;
    let mut out = String::new();
    for ch in trimmed.chars() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        out.push(ch);
    }
    Some(out)
}

/// Node `readResourceUri`.
fn resource_uri(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    (trimmed.starts_with("ui://") && trimmed.encode_utf16().count() <= MAX_RESOURCE_URI_UNITS)
        .then(|| trimmed.to_owned())
}

/// Node `readSurfaceId`.
fn surface_id(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    let mut chars = trimmed.chars();
    let valid = chars
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
        && trimmed.len() <= MAX_SURFACE_UNITS;
    valid.then(|| trimmed.to_owned())
}

/// Node `readOriginList`: `None` when the value is not an array; invalid origins are dropped, duplicates removed.
fn origin_list(value: &Value) -> Option<Vec<String>> {
    let items = value.as_array()?;
    let mut origins: Vec<String> = Vec::new();
    for origin in items.iter().filter_map(|item| origin_of(item.as_str()?)) {
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    Some(origins)
}

/// Node `normalizeCspOrigin`: https and wss any host, http and ws only `127.0.0.1`; no credentials, query, fragment
/// or path.
fn origin_of(value: &str) -> Option<String> {
    let url = url::Url::parse(value.trim()).ok()?;
    let loopback = url.host_str() == Some("127.0.0.1") && matches!(url.scheme(), "http" | "ws");
    if !matches!(url.scheme(), "https" | "wss") && !loopback {
        return None;
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "/" | "")
    {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

#[cfg(test)]
#[path = "display_tests.rs"]
mod tests;
