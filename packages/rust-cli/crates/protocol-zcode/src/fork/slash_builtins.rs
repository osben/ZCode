//! W9b-2 (9.57, divergence 830): the app protocol's built-in slash commands in the presentation catalog. Node's
//! `listAppProtocolBuiltinSlashCommands` (`packages/bootstrap/src/zcode-protocol/slash-commands.ts`) puts them before the
//! custom commands, so the `/` panel and the `+` menu show `goal` and `workflow` (the desktop barrier of the workflow
//! E2E). Rust lists the built-ins it runs. `workflow` is listed only while the gate is open, as Node drops it when the
//! gate is closed (DWG-03).

use serde_json::{Value, json};

#[cfg(test)]
#[path = "slash_builtins_tests.rs"]
mod tests;

/// `(name, summary, usage)`, the text of `packages/shared/src/zcode-slash-command-help.ts`, in Node's order
/// (`APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES`: goal, workflow, compact, init, dream).
const BUILTINS: [(&str, &str, &str); 3] = [
    (
        "goal",
        "Show or set the current session goal.",
        "/goal [pause|resume|clear|replace <objective>|<objective>]",
    ),
    (
        "workflow",
        "Design and launch a dynamic workflow for a task.",
        "/workflow [what the workflow should accomplish]",
    ),
    (
        "compact",
        "Compact the current conversation with optional instructions.",
        "/compact [instructions]",
    ),
];

/// Names Node reserves from custom commands (the built-in help entries and `compress` and `plan`). Only the names
/// this module knows are listed here; `init` and `dream` are reserved in Node and are not run by Rust (divergence 830).
const RESERVED: [&str; 7] = [
    "goal", "compact", "workflow", "init", "dream", "compress", "plan",
];

/// The built-ins for the presentation catalog, `workflow` only while `workflow_enabled`.
pub(crate) fn builtin_slash_commands(workflow_enabled: bool) -> Vec<Value> {
    BUILTINS
        .iter()
        .filter(|(name, _, _)| *name != "workflow" || workflow_enabled)
        .map(|(name, summary, usage)| {
            json!({"name": name, "description": summary, "inputHint": usage, "source": "builtin"})
        })
        .collect()
}

/// Whether a custom command may not take this name (Node's reserved filter in `slash-commands.ts`).
pub(crate) fn is_reserved_slash_name(name: &str) -> bool {
    RESERVED.contains(&name)
}
