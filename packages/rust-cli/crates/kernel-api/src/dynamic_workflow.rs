//! Fork: the dynamic-workflow rollout gate (specs/fork-rust-workflow-engine.md 9.2; Node
//! `bootstrap/src/zcode-protocol/dynamic-workflow-policy.ts`). The Host owns the decision and sends `enabled` and `mode`
//! through `workspace/updateDynamicWorkflowPolicy` (the workspace fact) and through the create parameters (the record).
//! The rules here are pure: the record copies the resolved gate, and nothing registers a tool from it before W7.

use serde::{Deserialize, Serialize};

/// The rollout mode from the Host. `onDemand` is the only value that defers the workflow tools (Node
/// `dynamicWorkflowToolsOnDemand`); `disabled` with the gate open behaves as `alwaysOn`, as in Node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DynamicWorkflowMode {
    #[serde(rename = "disabled")]
    Disabled,
    #[serde(rename = "onDemand")]
    OnDemand,
    #[serde(rename = "alwaysOn")]
    AlwaysOn,
}

/// The workspace fact the Host cached (Node `appRuntimePreferences.dynamicWorkflowEnabled` / `dynamicWorkflowMode`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DynamicWorkflowPreferences {
    enabled: bool,
    mode: Option<DynamicWorkflowMode>,
}

impl DynamicWorkflowPreferences {
    /// Node `updateDynamicWorkflowPolicy`: the mode is kept only while enabled, so a boolean-only enable after a
    /// disable never carries an old `onDemand`.
    pub fn set(&mut self, enabled: bool, mode: Option<DynamicWorkflowMode>) {
        self.enabled = enabled;
        self.mode = if enabled { mode } else { None };
    }
}

/// The two rollout fields a record is created with (Node `DynamicWorkflowRuntimeGate`: both are always explicit).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DynamicWorkflowGate {
    pub enabled: bool,
    pub tools_on_demand: bool,
}

/// The per-session gate the Host recorded at create (Node `runtimeConfig.dynamicWorkflowEnabled` and
/// `dynamicWorkflowMode`), read by the tool registry. `None` means no record: the gate is closed (fail-closed).
/// `protocol-zcode`'s `Server` implements it; the runtime only sees this trait.
pub trait DynamicWorkflowGates: Send + Sync {
    fn gate(&self, session: &crate::ids::SessionId) -> Option<DynamicWorkflowGate>;

    /// Fork (W7-11, 9.44): whether an on-demand session has activated its workflow tools (Node
    /// `dynamicWorkflowToolsActivated`). Only an on-demand session's activation changes what it sees; the default is no.
    fn activated(&self, session: &crate::ids::SessionId) -> bool {
        let _ = session;
        false
    }
}

/// Fork (W7-7a, specs/fork-rust-workflow-engine.md 9.36, divergence 56): the one table of the sessions' recorded gates.
/// The protocol server records and forgets through it, and the entry point hands the same table to the kernel's
/// extensions as the gate source, so both read one record per session.
///
/// Fork (W7-11, 9.44): the table also holds the sessions that activated their workflow tools. The set is separate from the
/// record, so activation never rewrites the gate the session was created with.
#[derive(Debug, Default)]
pub struct SessionGates {
    /// One lock over the record and the activation, so a forget removes a session's both at once: an activation cannot
    /// land between the two removals and outlive the session.
    state: std::sync::Mutex<GateState>,
}

#[derive(Debug, Default)]
struct GateState {
    records: std::collections::HashMap<crate::ids::SessionId, DynamicWorkflowGate>,
    activated: std::collections::HashSet<crate::ids::SessionId>,
}

impl SessionGates {
    /// Records the gate a session was created with, replacing any earlier record.
    pub fn record(&self, session: &crate::ids::SessionId, gate: DynamicWorkflowGate) {
        self.state().records.insert(session.clone(), gate);
    }

    /// Activates a session's workflow tools. `true` when this call activated it. A session already active is `false`, and so
    /// is a session with no record (never recorded, or forgotten at delete): the record check and the insert are one step
    /// under the lock, so a forget cannot land between them and leave an activation behind.
    pub fn activate(&self, session: &crate::ids::SessionId) -> bool {
        let mut state = self.state();
        if !state.records.contains_key(session) {
            return false;
        }
        state.activated.insert(session.clone())
    }

    /// Drops the record and the activation of a deleted session, under one lock.
    pub fn forget(&self, session: &crate::ids::SessionId) {
        let mut state = self.state();
        state.records.remove(session);
        state.activated.remove(session);
    }

    fn state(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl DynamicWorkflowGates for SessionGates {
    fn gate(&self, session: &crate::ids::SessionId) -> Option<DynamicWorkflowGate> {
        self.state().records.get(session).copied()
    }

    fn activated(&self, session: &crate::ids::SessionId) -> bool {
        self.state().activated.contains(session)
    }
}

/// Node `resolveDynamicWorkflowRuntimeGate`. `enabled` is an OR: a `true` parameter or an enabled preference opens the
/// gate, and a `false` parameter does not close an enabled preference. The mode is read only while the gate is open:
/// the parameter mode wins over the preference mode, and with neither it is `alwaysOn`. With no open source the gate
/// is closed (fail-closed).
pub fn resolve_gate(
    params_enabled: Option<bool>,
    params_mode: Option<DynamicWorkflowMode>,
    preferences: &DynamicWorkflowPreferences,
) -> DynamicWorkflowGate {
    let enabled = params_enabled == Some(true) || preferences.enabled;
    if !enabled {
        return DynamicWorkflowGate {
            enabled: false,
            tools_on_demand: false,
        };
    }
    let mode = params_mode
        .or(preferences.mode)
        .unwrap_or(DynamicWorkflowMode::AlwaysOn);
    DynamicWorkflowGate {
        enabled: true,
        tools_on_demand: mode == DynamicWorkflowMode::OnDemand,
    }
}

#[cfg(test)]
#[path = "dynamic_workflow_tests.rs"]
mod tests;
