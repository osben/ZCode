//! Fork (desktop App): incognito sessions (specs/fork-rust-agent-parity.md, "Incognito sessions"; the product
//! rules are Node's specs/incognito-session.md).
//!
//! An incognito session has a profile of 13 capabilities frozen at creation and stored in the session row's
//! `fork_incognito` column. `true` keeps a capability, `false` removes it from the session. A normal session has
//! no profile. [`IncognitoProfiles`] is the one in-memory owner the gates read by session id.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

use crate::ids::SessionId;

/// One capability of [`IncognitoProfile`], in Node's key order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IncognitoKey {
    ProjectInstructions,
    Skills,
    Hooks,
    Plugins,
    Mcp,
    CustomAgents,
    Memory,
    OutputStyle,
    SystemPromptOverrides,
    Identity,
    Harness,
    Environment,
    AutomationTools,
}

/// Node's `IncognitoProfile` (`packages/shared/src/incognito-profile.ts`): flat, strict, no version key. The field
/// order is Node's schema order, so [`IncognitoProfile::to_stored`] writes the same JSON as Node's
/// `JSON.stringify`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IncognitoProfile {
    pub project_instructions: bool,
    pub skills: bool,
    pub hooks: bool,
    pub plugins: bool,
    pub mcp: bool,
    pub custom_agents: bool,
    pub memory: bool,
    pub output_style: bool,
    pub system_prompt_overrides: bool,
    pub identity: bool,
    pub harness: bool,
    pub environment: bool,
    pub automation_tools: bool,
}

impl IncognitoProfile {
    /// Every capability off (Node `INCOGNITO_LOCKDOWN_PROFILE`); also the reading of a stored value this build
    /// cannot parse.
    pub const LOCKDOWN: Self = Self {
        project_instructions: false,
        skills: false,
        hooks: false,
        plugins: false,
        mcp: false,
        custom_agents: false,
        memory: false,
        output_style: false,
        system_prompt_overrides: false,
        identity: false,
        harness: false,
        environment: false,
        automation_tools: false,
    };

    /// Whether the session keeps `key`.
    pub fn includes(&self, key: IncognitoKey) -> bool {
        match key {
            IncognitoKey::ProjectInstructions => self.project_instructions,
            IncognitoKey::Skills => self.skills,
            IncognitoKey::Hooks => self.hooks,
            IncognitoKey::Plugins => self.plugins,
            IncognitoKey::Mcp => self.mcp,
            IncognitoKey::CustomAgents => self.custom_agents,
            IncognitoKey::Memory => self.memory,
            IncognitoKey::OutputStyle => self.output_style,
            IncognitoKey::SystemPromptOverrides => self.system_prompt_overrides,
            IncognitoKey::Identity => self.identity,
            IncognitoKey::Harness => self.harness,
            IncognitoKey::Environment => self.environment,
            IncognitoKey::AutomationTools => self.automation_tools,
        }
    }

    /// The protocol value (`createSession.incognito`): all 13 keys and no other. Any other shape is an error, so an
    /// invalid request fails before a row exists instead of running as a normal session.
    pub fn from_wire(value: &serde_json::Value) -> Result<Self, String> {
        Self::deserialize(value).map_err(|error| format!("invalid incognito profile: {error}"))
    }

    /// Decode `session.fork_incognito` (Node `parseStoredIncognitoProfile`): anything that is not exactly the
    /// current profile (damaged JSON, an unknown or missing key, a `version` key) reads as [`Self::LOCKDOWN`], so a
    /// stored incognito session never runs as a normal one.
    pub fn from_stored(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or(Self::LOCKDOWN)
    }

    /// The column value, byte-identical to Node's `JSON.stringify(profile)`.
    pub fn to_stored(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// True when the session is incognito and does not keep `key` (Node `incognitoExcludes`).
pub fn excludes(profile: Option<&IncognitoProfile>, key: IncognitoKey) -> bool {
    profile.is_some_and(|profile| !profile.includes(key))
}

/// Process-wide map from session to profile: the one in-memory owner every gate reads. Filled from
/// `SessionMeta::incognito` where a session's meta is materialized (kernel create and open, subagent spawn). A
/// session's profile is frozen at creation, so an entry never changes and is never removed.
#[derive(Debug, Clone, Default)]
pub struct IncognitoProfiles(Arc<RwLock<HashMap<SessionId, IncognitoProfile>>>);

impl IncognitoProfiles {
    /// Record the profile of `session` (nothing for a normal session).
    pub fn record(&self, session: &SessionId, profile: Option<IncognitoProfile>) {
        let Some(profile) = profile else {
            return;
        };
        let mut map = self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        map.insert(session.clone(), profile);
    }

    pub fn get(&self, session: &SessionId) -> Option<IncognitoProfile> {
        let map = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        map.get(session).copied()
    }

    /// True when `session` is incognito and does not keep `key`.
    pub fn excludes(&self, session: &SessionId, key: IncognitoKey) -> bool {
        excludes(self.get(session).as_ref(), key)
    }
}

/// Fork: whether a session's incognito profile removes a tool. One predicate for the tool snapshot, ToolSearch and
/// the call-time check in the executor, so a removed tool can neither be listed nor called.
pub trait IncognitoToolGate: Send + Sync {
    fn hides(&self, session: &SessionId, tool: &dyn crate::tool::Tool) -> bool;
}

#[cfg(test)]
#[path = "incognito_tests.rs"]
mod tests;
