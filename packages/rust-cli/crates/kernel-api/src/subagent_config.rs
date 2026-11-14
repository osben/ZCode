//! Fork (desktop App): the subagent profiles the Host's Settings define (specs/fork-rust-subagent-runtime-config.md).
//!
//! The Host owns the snapshot (`subagents/readRuntimeConfig`): the user and project profiles with the disabled ones
//! already dropped, and the model chosen for the built-in `Explore` and `general-purpose` agents. The agent catalog
//! reads it through [`SubagentConfigSource`]; only the desktop app-server installs one.

use std::collections::BTreeMap;

use async_trait::async_trait;

use crate::ids::SessionId;
use crate::model::ModelSelection;
use crate::permission::PermissionMode;

/// Where a snapshot profile was defined (the Host never sends built-in profiles).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileSource {
    User,
    Project,
}

/// One subagent profile as the Host resolved it. Node fields without a Rust counterpart (`path`, `color`, `memory`,
/// `skills`, `mcpServers`, `injectAgentsMd`) are not carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentProfile {
    pub name: String,
    pub description: String,
    pub source: ProfileSource,
    pub system_prompt: String,
    /// The full selection (provider, model, reasoning level); None inherits the parent's model.
    pub selection: Option<ModelSelection>,
    pub tools: Option<Vec<String>>,
    pub disallowed_tools: Vec<String>,
    pub max_turns: Option<u32>,
    pub background: bool,
    pub permission_mode: Option<PermissionMode>,
    /// `injectAgentsMd`: false gives the child no project instructions; absent means true (Node `!== false`).
    pub inject_agents_md: bool,
}

/// The Host's answer. One value per root session, read at most once per root turn, so the unboxed `Ready` is not worth
/// boxing (clippy `large_enum_variant`).
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubagentSnapshot {
    /// The profiles replace the agent files; the overrides set the built-ins' model.
    Ready {
        profiles: Vec<SubagentProfile>,
        explore: Option<ModelSelection>,
        general_purpose: Option<ModelSelection>,
        /// Node `pluginAgentModelSelectionOverrides`, keyed `plugin:<plugin id>:<bare name lowercased>`.
        plugins: BTreeMap<String, ModelSelection>,
    },
    /// The Host could not load a scope: the built-in agents only, no plugin agents.
    BuiltInFallback,
}

#[async_trait]
pub trait SubagentConfigSource: Send + Sync {
    /// The snapshot for the root session `session`. `Ok(None)`: the Host does not offer one (the agent files apply).
    /// `Err` is the reason the read failed; the turn that needed it fails.
    async fn read(&self, session: &SessionId) -> Result<Option<SubagentSnapshot>, String>;

    /// The root session `session` closed: drop what was remembered for it (the gate).
    fn forget(&self, _session: &SessionId) {}
}
