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

/// Node `resolveDynamicWorkflowRuntimeGate`. The create parameters win; the cached preference is the fallback; with
/// neither the gate is closed (fail-closed). The mode is read only while enabled, and it defaults to `alwaysOn`.
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
