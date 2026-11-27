//! Fork (specs/fork-rust-workspace-config-topic.md): the value of a `workspace-config/<workspaceId>` snapshot. Node's
//! `toV4WorkspaceConfigState` (`bootstrap/src/zcode-protocol/v4-workspace-config.ts`) puts one `mode` option and the
//! slash-command catalog there while a session of the workspace is open, and nothing otherwise. Pure builders: the
//! session choice and the command discovery live in `Server::workspace_config`.

use serde_json::{Value, json};

#[cfg(test)]
#[path = "workspace_config_tests.rs"]
mod tests;

/// `(id, name, description)`: `ZCODE_AGENT_MODE_OPTIONS` of `packages/shared/src/zcode-agent-model-state.ts`, in order.
const MODES: [(&str, &str, &str); 4] = [
    (
        "build",
        "Ask before changes",
        "Ask before each file changes.",
    ),
    ("guarded", "Autonomous mode", "Ask when there\u{2019}s risk"),
    (
        "plan",
        "Plan mode",
        "Inspect the code and present a plan before editing.",
    ),
    (
        "yolo",
        "Full access",
        "Edit and run commands with fewer confirmations.",
    ),
];

/// The state of a workspace with no open session (Node's null seed): no options, no commands.
pub(crate) fn empty() -> Value {
    json!({"configOptions": [], "slashCommands": []})
}

/// Node's `normalizeAvailableZCodeMode`: the four menu modes and the historical `edit` stay, anything else is `build`.
fn normalize(mode: Option<&str>) -> &'static str {
    match mode {
        Some("guarded") => "guarded",
        Some("plan") => "plan",
        Some("yolo") => "yolo",
        Some("edit") => "edit",
        _ => "build",
    }
}

/// The state of a workspace with an open session in `mode` (a Node mode name) and the given slash-command catalog.
pub(crate) fn state(mode: Option<&str>, slash_commands: Vec<Value>) -> Value {
    let options: Vec<Value> = MODES
        .iter()
        .map(|(id, name, description)| {
            json!({"value": id, "name": name, "description": description})
        })
        .collect();
    json!({
        "configOptions": [{
            "id": "mode",
            "name": "Mode",
            "category": "mode",
            "type": "select",
            "currentValue": normalize(mode),
            "options": options,
        }],
        "slashCommands": slash_commands,
    })
}
