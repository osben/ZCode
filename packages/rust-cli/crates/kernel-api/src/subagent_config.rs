//! Fork (desktop App): the subagent profiles the Host's Settings define (specs/fork-rust-subagent-runtime-config.md).
//!
//! The Host owns the snapshot (`subagents/readRuntimeConfig`): the user and project profiles with the disabled ones
//! already dropped, and the model chosen for the built-in `Explore` and `general-purpose` agents. The agent catalog
//! reads it through [`SubagentConfigSource`]; only the desktop app-server installs one.

use std::collections::BTreeMap;

use async_trait::async_trait;

use crate::env::WorkspaceRef;
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
    /// `mcpServers` (rule 16): None or empty means every parent server.
    pub mcp_servers: Option<Vec<String>>,
    /// `skills` (rule 17): None means the profile declares no skill list.
    pub skills: Option<Vec<String>>,
    /// `memory` (rule 18).
    pub memory: Option<AgentMemoryScope>,
}

/// Node `AgentMemoryScope`: where the persistent agent memory of a profile lives (rule 18).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentMemoryScope {
    User,
    Project,
    Local,
}

impl AgentMemoryScope {
    /// The frontmatter and Host value (`user`, `project` or `local`); any other value is no scope.
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "user" => Some(Self::User),
            "project" => Some(Self::Project),
            "local" => Some(Self::Local),
            _ => None,
        }
    }
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

/// Fork (rule 17): the skills a subagent's `skills` list grants its child run. The skill catalog (ext) resolves the list
/// against its discovery and filters the child's skill tool, listing and loads to the grant.
#[async_trait]
pub trait SubagentSkillGrants: Send + Sync {
    /// Freezes the grant of `entries` for the run of the child session `child` in `workspace`. Returns the entries that
    /// matched no skill, in the order given.
    async fn grant(
        &self,
        child: &SessionId,
        workspace: &WorkspaceRef,
        entries: &[String],
    ) -> Vec<String>;

    /// The run of `child` ended: drop its grant and its enrolment.
    fn forget(&self, child: &SessionId);

    /// Marks `child` as a subagent child for its run: its skill view never shows the official Computer Use plugin's
    /// skills (Node `FilteredSkillPort` with `cuaPolicy`, applied to every child whether or not it declares `skills`).
    /// Called before the first request; `forget` ends it. No-op for a catalog that has no such skills.
    fn enroll(&self, _child: &SessionId) {}

    /// Node `validateSubagentComputerUseConfiguration` for the `skills` list: the refusal text when an entry names the
    /// official Computer Use plugin's skill (a qualified name, or a bare name that matches exactly one skill, which is
    /// official), checked before the child starts. `None` when no entry does.
    async fn computer_use_refusal(
        &self,
        _workspace: &WorkspaceRef,
        _entries: &[String],
    ) -> Option<String> {
        None
    }
}

/// Node `SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE`.
pub const COMPUTER_USE_UNAVAILABLE: &str = "Computer Use is not available in subagent";
