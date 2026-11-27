//! Fork (specs/fork-rust-plugin-ui-tool-result.md): the `v4/plugin-ui/tool-result` notification. Port of the emit in Node
//! `V4Gateway.ingestNormalizedEvent` (`zcode-protocol-v4/v4-gateway.ts`): after a live tool result is projected, a
//! successful MCP UI tool row becomes `{sessionId, toolCallId, serverName, ui, input?}`.

use serde_json::{Map, Value};

/// The notification method (Node `V4_NOTIFICATIONS.pluginUiToolResult`).
pub(crate) const METHOD: &str = "v4/plugin-ui/tool-result";

/// The notification's params for `row`, or `None` when the row does not qualify (rule 6).
pub(crate) fn of_row(session: &str, row: &Map<String, Value>) -> Option<Value> {
    if session.is_empty() || row.get("kind")? != "toolCall" || row.get("status")? != "success" {
        return None;
    }
    let display = row.get("display")?.as_object()?;
    if display.get("kind")? != "mcp_tool" {
        return None;
    }
    let server = display
        .get("serverName")?
        .as_str()
        .filter(|name| !name.is_empty())?;
    // Node's schema refuses `ui.isError`: the call completed but the tool reported an error.
    let ui = display.get("ui")?.as_object()?;
    if ui.get("isError") == Some(&Value::Bool(true)) {
        return None;
    }
    let tool_call = row
        .get("toolCallId")?
        .as_str()
        .filter(|id| !id.is_empty())?;
    let mut params = Map::new();
    params.insert("sessionId".into(), session.into());
    params.insert("toolCallId".into(), tool_call.into());
    params.insert("serverName".into(), server.into());
    params.insert("ui".into(), Value::Object(ui.clone()));
    if let Some(input) = row.get("input").filter(|input| input.is_object()) {
        params.insert("input".into(), input.clone());
    }
    Some(Value::Object(params))
}

#[cfg(test)]
#[path = "plugin_ui_result_tests.rs"]
mod tests;
