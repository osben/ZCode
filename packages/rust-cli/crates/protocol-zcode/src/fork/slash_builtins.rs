//! W9b-2 (9.57, divergence 830): the presentation catalog's slash commands. Node's `listAppProtocolBuiltinSlashCommands`
//! (`packages/bootstrap/src/zcode-protocol/slash-commands.ts`) puts the built-ins before the custom commands, so the `/` panel
//! and the `+` menu show `goal` and `workflow` (the desktop barrier of the workflow E2E). Rust lists the built-ins it runs.
//! `workflow` is listed only while the gate is open (DWG-03). A custom command or skill with a reserved name is dropped
//! (Node's reserved filter), except the runtime's own built-in skills (`init`, `loop`, `security-review`), which Rust runs.
//! The reserved set itself lives in `rust_cli_kernel_api::slash_names`, shared with the expansion.

use rust_cli_kernel_api::slash_names::is_reserved_slash_name;
use serde_json::{Value, json};

#[cfg(test)]
#[path = "slash_builtins_tests.rs"]
mod tests;

/// `(name, summary, usage)`, the text of `packages/shared/src/zcode-slash-command-help.ts`, in Node's order
/// (`APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES`: goal, workflow, compact, init, dream). This table holds the three
/// built-in commands Rust runs itself. `init` is not here: Rust runs `/init` as its built-in skill, and that skill reaches the
/// catalog through the custom-command list with its built-in flag. `dream` is not run by Rust, so it is not listed (divergence 893).
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

/// The catalog: the built-ins (`workflow` only while `workflow_enabled`), then the custom entries. Each custom entry is a
/// catalog object with a `name`, and a flag that is true for the runtime's own built-in skill. A reserved name is dropped
/// unless its entry is a built-in skill.
pub(crate) fn catalog_commands(
    workflow_enabled: bool,
    custom: impl IntoIterator<Item = (Value, bool)>,
) -> Vec<Value> {
    let builtins = BUILTINS
        .iter()
        .filter(|(name, _, _)| *name != "workflow" || workflow_enabled)
        .map(|(name, summary, usage)| {
            json!({"name": name, "description": summary, "inputHint": usage, "source": "builtin"})
        });
    let custom = custom
        .into_iter()
        .filter(|(command, builtin)| {
            *builtin || !command["name"].as_str().is_some_and(is_reserved_slash_name)
        })
        .map(|(command, _)| command);
    builtins.chain(custom).collect()
}
