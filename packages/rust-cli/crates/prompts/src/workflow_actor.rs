//! The identity prompt of a dynamic workflow subagent (Node `core/src/context/sections/workflow-actor.ts`,
//! `buildWorkflowActorIdentitySection`). It replaces the main identity: the opening sentence names the run and says who
//! reads the output, then the persona, the security notice, the `# Harness` block and the workflow contract.

use crate::texts::{self, render};

// Node's `DEFAULT_HARNESS_PROMPT` (the `# Harness` block, mid-conversation system turns on) is its own text file, not the
// main lean body: the lean body's bullets are indented, and Node's workflow identity does not indent them.

/// The identity prompt for an actor named `name` (None or blank: anonymous) with `persona` (None or blank: none).
/// Harness on, mid-conversation system turns on: Node's defaults for a workflow actor.
pub fn identity(name: Option<&str>, persona: Option<&str>) -> String {
    let named = match name.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => format!(", named \"{name}\""),
        None => String::new(),
    };
    let opening = render(texts::workflow_actor_opening(), &[("named", &named)]);
    let mut parts = vec![opening];
    if let Some(persona) = persona.map(str::trim).filter(|persona| !persona.is_empty()) {
        parts.push(persona.to_owned());
    }
    parts.push(texts::security().to_owned());
    parts.push(texts::workflow_actor_harness().to_owned());
    parts.push(texts::workflow_actor_contract().to_owned());
    parts.join("\n\n")
}

#[cfg(test)]
#[path = "workflow_actor_tests.rs"]
mod tests;
