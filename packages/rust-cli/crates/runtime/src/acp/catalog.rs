//! The per-agent catalog of the last offered options, `fork_acp_agent_catalog.json` next to `provider_config.json`
//! (Node `NodeForkAcpAgentCatalogStore`, `acp-agent-derivation.ts`; specs/fork-rust-agent-parity.md "ACP external
//! agents", rule 16). It feeds the composer before a session's first turn. The Host's Settings test and the turn
//! reconcile both write it, so every write takes the file lock and rereads under it; reads take no lock and are
//! tolerant, since the catalog is a cache that the next write repairs.

use std::io;
use std::path::{Path, PathBuf};

use rust_cli_fs::{FileMode, LockOptions, ParentDir, TempName, WriteOptions};
use rust_cli_kernel_api::external_agent_config::{ExternalAgentConfigOption, options_from_json};
use serde::Serialize;
use serde_json::Value;

pub(crate) const CATALOG_FILE: &str = "fork_acp_agent_catalog.json";
const SCHEMA_VERSION: u64 = 1;

/// Node `atomicWritePrivateTextFile`.
const PRIVATE_WRITE: WriteOptions = WriteOptions {
    mode: FileMode::Private,
    temp_name: TempName::Hidden,
    parent: ParentDir::Existing,
    rename_retry: rust_cli_fs::NODE_RENAME_RETRY,
};

/// One agent's entry, in Node's `forkAcpAgentCatalogEntrySchema` key order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    agent_id: String,
    captured_at: u64,
    options: Vec<ExternalAgentConfigOption>,
}

/// The file in Node's `encodeForkAcpAgentCatalogFile` key order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct File<'a> {
    schema_version: u64,
    agents: &'a [Entry],
}

#[derive(Debug, Clone)]
pub(crate) struct AgentCatalog {
    file: PathBuf,
}

impl AgentCatalog {
    /// The catalog beside the agent records (`fork_acp_agents.json`), both next to `provider_config.json`.
    pub(crate) fn beside(records_file: &Path) -> Self {
        let directory = records_file.parent().unwrap_or_else(|| Path::new("."));
        Self {
            file: directory.join(CATALOG_FILE),
        }
    }

    /// Node `readAgent`: the agent's last offered options, `None` when it was never run or tested.
    pub(crate) async fn read_agent(&self, agent: &str) -> Option<Vec<ExternalAgentConfigOption>> {
        self.read()
            .await
            .into_iter()
            .find(|entry| entry.agent_id == agent)
            .map(|entry| entry.options)
    }

    /// Node `write`: stores the agent's offered options. `false` (and no write) when the stored options are equal.
    pub(crate) async fn write(
        &self,
        agent: &str,
        options: &[ExternalAgentConfigOption],
        captured_at: u64,
    ) -> io::Result<bool> {
        rust_cli_fs::with_file_lock(&self.file, &LockOptions::default(), async || {
            let current = self.read().await;
            if current
                .iter()
                .any(|entry| entry.agent_id == agent && entry.options == options)
            {
                return Ok(false);
            }
            let mut agents: Vec<Entry> = current
                .into_iter()
                .filter(|entry| entry.agent_id != agent)
                .collect();
            agents.push(Entry {
                agent_id: agent.to_owned(),
                captured_at,
                options: options.to_vec(),
            });
            let text = serde_json::to_string_pretty(&File {
                schema_version: SCHEMA_VERSION,
                agents: &agents,
            })
            .map_err(io::Error::other)?;
            rust_cli_fs::atomic_write(&self.file, text.as_bytes(), PRIVATE_WRITE).await?;
            Ok(true)
        })
        .await
    }

    /// Node `read`: any failure reads as an empty catalog.
    async fn read(&self) -> Vec<Entry> {
        let Ok(Some(bytes)) = rust_cli_fs::read_optional(&self.file).await else {
            return Vec::new();
        };
        serde_json::from_slice::<Value>(&bytes)
            .ok()
            .map(|file| parse(&file))
            .unwrap_or_default()
    }
}

/// Node `parseForkAcpAgentCatalogFile`: not a version 1 document reads as empty; an invalid entry, and a later
/// duplicate of an agent id, is dropped.
fn parse(file: &Value) -> Vec<Entry> {
    if file.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
        return Vec::new();
    }
    let Some(raw) = file.get("agents").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut agents: Vec<Entry> = Vec::new();
    for entry in raw.iter().filter_map(entry) {
        if agents.iter().all(|seen| seen.agent_id != entry.agent_id) {
            agents.push(entry);
        }
    }
    agents
}

/// One entry of `forkAcpAgentCatalogEntrySchema`: an agent id without whitespace, a non-negative integer time and
/// options whose ids are not empty.
fn entry(raw: &Value) -> Option<Entry> {
    let agent_id = raw.get("agentId")?.as_str()?;
    if agent_id.is_empty() || agent_id.chars().any(char::is_whitespace) {
        return None;
    }
    let captured_at = integer(raw.get("capturedAt")?)?;
    let options = options_from_json(raw.get("options")?)?;
    if options.iter().any(|option| option.id.is_empty()) {
        return None;
    }
    Some(Entry {
        agent_id: agent_id.to_owned(),
        captured_at,
        options,
    })
}

/// A JSON number that zod's `.int().nonnegative()` accepts (`1000.0` is an integer in JavaScript).
fn integer(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        let number = value.as_f64()?;
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "checked: a non-negative whole number within u64"
        )]
        ((number >= 0.0 && number.fract() == 0.0 && number < u64::MAX as f64)
            .then_some(number as u64))
    })
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
