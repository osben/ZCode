//! The agent records the Host writes to `fork_acp_agents.json` next to `provider_config.json` (Node
//! `NodeForkAcpAgentStore`, `forkAcpAgentsFileSchema`). `zcode-rs` only reads them, once per turn.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Deserialize;

/// One stored agent (Node `forkAcpAgentRecordSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRecord {
    pub(crate) agent_id: String,
    /// Validated like Node; the turn errors use the registry name.
    pub(crate) provider_name: String,
    pub(crate) enabled: bool,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    #[serde(default)]
    pub(crate) env: Option<BTreeMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentsFile {
    schema_version: u32,
    agents: Vec<AgentRecord>,
}

impl AgentsFile {
    /// The refinements of the Node schema that serde does not express.
    fn is_valid(&self) -> bool {
        let mut seen = std::collections::HashSet::new();
        self.schema_version == 1
            && self.agents.iter().all(|agent| {
                // `agentId: /^\S+$/`, `providerName: min(1)`, env keys `ACP_ENV_KEY_PATTERN`, no duplicate ids.
                !agent.agent_id.is_empty()
                    && !agent.agent_id.chars().any(char::is_whitespace)
                    && !agent.provider_name.is_empty()
                    && agent
                        .env
                        .as_ref()
                        .is_none_or(|env| env.keys().all(|key| is_env_key(key)))
                    && seen.insert(agent.agent_id.as_str())
            })
    }
}

/// `ACP_ENV_KEY_PATTERN`: `^[A-Za-z_][A-Za-z0-9_]*$`.
fn is_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|rest| rest.is_ascii_alphanumeric() || rest == '_')
}

/// The sidecar file.
#[derive(Debug, Clone)]
pub(crate) struct AgentRecords {
    pub(crate) file: PathBuf,
}

impl AgentRecords {
    /// The record of `agent_id`. A missing file has no agents; an unreadable or invalid one is read as empty, like
    /// Node `read()` (the file is left for the user to repair).
    pub(crate) async fn find(&self, agent_id: &str) -> Option<AgentRecord> {
        let bytes = match rust_cli_fs::read_optional(&self.file).await {
            Ok(bytes) => bytes?,
            Err(error) => {
                tracing::warn!(event = "acp.records_unreadable", %error, "ACP agent records could not be read");
                return None;
            }
        };
        let file = match serde_json::from_slice::<AgentsFile>(&bytes) {
            Ok(file) if file.is_valid() => file,
            Ok(_) | Err(_) => {
                tracing::warn!(
                    event = "acp.records_invalid",
                    "ACP agent records are invalid; read as empty"
                );
                return None;
            }
        };
        file.agents
            .into_iter()
            .find(|record| record.agent_id == agent_id)
    }
}

#[cfg(test)]
#[path = "records_tests.rs"]
mod tests;
