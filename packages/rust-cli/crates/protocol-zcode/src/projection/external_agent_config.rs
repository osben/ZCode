//! Fork: `config.externalAgentConfig`, the selects of the session's ACP agent (specs/fork-rust-agent-parity.md
//! "ACP external agents", rule 13; Node `onExternalAgentConfigUpdated`, `seedExternalAgentConfig`).

use rust_cli_kernel_api::external_agent_config::{ExternalAgentConfigOption, options_to_json};
use serde_json::{Map, Value, json};

use super::Projection;

/// Node `externalAgentConfigStateSchema`: `{agentId, options}`.
fn state(agent: &str, options: &[ExternalAgentConfigOption]) -> Value {
    json!({"agentId": agent, "options": options_to_json(options)})
}

impl Projection {
    /// The stored display copy of a cold open: no delta, and never over a value an event already set.
    pub fn seed_external_agent_config(
        &mut self,
        agent: &str,
        options: &[ExternalAgentConfigOption],
    ) {
        if self.external_agent_config_from_event || agent.is_empty() {
            return;
        }
        self.external_agent_config = Some(state(agent, options));
    }

    /// An `ExternalAgentConfig` event is authoritative over the seed; an identical state patches nothing.
    pub(super) fn external_agent_config_event(
        &mut self,
        agent: &str,
        options: &[ExternalAgentConfigOption],
        patch: &mut Map<String, Value>,
    ) {
        // Node's schema needs an agent id; a payload without one is dropped.
        if agent.is_empty() {
            return;
        }
        self.external_agent_config_from_event = true;
        let next = state(agent, options);
        if self.external_agent_config.as_ref() == Some(&next) {
            return;
        }
        self.external_agent_config = Some(next);
        patch.insert("config".into(), self.config());
    }
}
