//! Known ACP agents (Node `packages/acp-agent-runtime/src/registry.ts`): the display name used in turn errors and
//! the sign-in command of the "requires sign-in" error. An agent id outside the registry shows as itself.

/// One known agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentDefinition {
    pub agent_id: &'static str,
    pub display_name: &'static str,
    /// The first binary Node probes for the agent.
    pub binary: &'static str,
    pub login_args: &'static [&'static str],
}

pub const AGENT_DEFINITIONS: &[AgentDefinition] = &[
    AgentDefinition {
        agent_id: "opencode",
        display_name: "opencode",
        binary: "opencode",
        login_args: &["auth", "login"],
    },
    AgentDefinition {
        agent_id: "cursor",
        display_name: "Cursor",
        binary: "cursor-agent",
        login_args: &["login"],
    },
    AgentDefinition {
        agent_id: "qwen",
        display_name: "Qwen Code",
        binary: "qwen",
        login_args: &[],
    },
    AgentDefinition {
        agent_id: "codex",
        display_name: "Codex",
        binary: "codex-acp",
        login_args: &[],
    },
    AgentDefinition {
        agent_id: "claude",
        display_name: "Claude Code",
        binary: "claude-agent-acp",
        login_args: &[],
    },
    AgentDefinition {
        agent_id: "gemini",
        display_name: "Gemini CLI",
        binary: "gemini",
        login_args: &[],
    },
];

pub fn definition(agent_id: &str) -> Option<&'static AgentDefinition> {
    AGENT_DEFINITIONS
        .iter()
        .find(|definition| definition.agent_id == agent_id)
}

/// Node `displayName`: the registry name, or the agent id.
pub fn display_name(agent_id: &str) -> &str {
    definition(agent_id).map_or(agent_id, |definition| definition.display_name)
}

/// The command the sign-in error asks the user to run (Node `authRequiredError`).
pub fn login_command(agent_id: &str) -> String {
    let mut words = vec![definition(agent_id).map_or(agent_id, |definition| definition.binary)];
    if let Some(definition) = definition(agent_id) {
        words.extend(definition.login_args.iter().copied());
    }
    words.join(" ")
}

/// Node `AUTH_FAILURE_PATTERN` (`/\bauth(?:entication|orization|orized)?\b|sign[ -]?in|log[ -]?in|unauthori[sz]ed|credential/i`).
pub fn is_auth_failure(message: &str) -> bool {
    let text = message.to_ascii_lowercase();
    if ["credential", "unauthorized", "unauthorised"]
        .iter()
        .any(|word| text.contains(word))
    {
        return true;
    }
    for stem in ["sign", "log"] {
        for joiner in ["", " ", "-"] {
            if text.contains(&format!("{stem}{joiner}in")) {
                return true;
            }
        }
    }
    let bytes = text.as_bytes();
    let word = |at: usize| {
        bytes
            .get(at)
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
    };
    text.match_indices("auth").any(|(at, _)| {
        if at > 0 && word(at - 1) {
            return false;
        }
        let rest = &text[at + "auth".len()..];
        ["entication", "orization", "orized", ""]
            .iter()
            .any(|suffix| rest.starts_with(suffix) && !word(at + "auth".len() + suffix.len()))
    })
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
