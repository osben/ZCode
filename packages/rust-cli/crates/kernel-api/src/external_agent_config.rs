//! Fork: the selects an ACP agent offers for its session (Node contract `external-agent-config.ts`,
//! specs/fork-rust-agent-parity.md "ACP external agents", rules 13 and 16).
//!
//! The session store and the event log see the options only in this shape; the ACP runtime maps its own snapshot onto
//! it, as Node's driver does (`toExternalAgentConfig`). Absent agent fields are `null`, never missing, and the field
//! order is Node's `canonicalExternalAgentConfig`, so two snapshots compare by their JSON.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::SessionId;
use crate::store::{AcpSessionConfig, StoreError};

/// One value of a select option. `group` is the agent's group label; groups are flat here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalAgentConfigValue {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
    pub group: Option<String>,
}

/// One select option the agent offers, with its current value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentConfigOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub current_value: String,
    pub options: Vec<ExternalAgentConfigValue>,
}

impl ExternalAgentConfigOption {
    /// Node `externalAgentConfigOffers`: whether `value` is one of the values this option offers.
    pub fn offers(&self, value: &str) -> bool {
        self.options
            .iter()
            .any(|candidate| candidate.value == value)
    }

    /// The display name of `value`, or the value itself when the option does not offer it.
    pub fn value_name<'a>(&'a self, value: &'a str) -> &'a str {
        self.options
            .iter()
            .find(|candidate| candidate.value == value)
            .map_or(value, |candidate| candidate.name.as_str())
    }
}

/// A list of options as contract JSON (the canonical field order).
pub fn options_to_json(options: &[ExternalAgentConfigOption]) -> Value {
    serde_json::to_value(options).unwrap_or(Value::Array(Vec::new()))
}

/// A stored list in the contract shape; `None` when it is not one.
pub fn options_from_json(value: &Value) -> Option<Vec<ExternalAgentConfigOption>> {
    serde_json::from_value(value.clone()).ok()
}

/// The config state of a session's ACP agent that the session owns: its offered options (display copy), its chosen
/// values and the agent's catalog (Node `V4ExternalAgentConfigStore`). The ACP host implements it over the session
/// store and `fork_acp_agent_catalog.json`; the `setExternalAgentConfigOption` handler and the subscribe seed use it.
#[async_trait]
pub trait ExternalAgentConfigs: Send + Sync {
    /// Node `readConfig`: the bound agent (or the agent of the pending choices), the display copy and the choices.
    async fn config(&self, session: &SessionId) -> Result<AcpSessionConfig, StoreError>;

    /// Node `readCatalog`: the agent's last offered options, `None` when it never ran or was never tested.
    async fn catalog(&self, agent: &str) -> Option<Vec<ExternalAgentConfigOption>>;

    /// Node `writeChoice`: one chosen value, pending before the first turn and in the binding after it.
    async fn choose(
        &self,
        session: &SessionId,
        agent: &str,
        config_id: &str,
        value: &str,
    ) -> Result<(), StoreError>;

    /// Node `writeOffered`: the display copy of a bound session; a session without a binding keeps none.
    async fn set_offered(
        &self,
        session: &SessionId,
        options: &[ExternalAgentConfigOption],
    ) -> Result<(), StoreError>;
}

#[cfg(test)]
#[path = "external_agent_config_tests.rs"]
mod tests;
