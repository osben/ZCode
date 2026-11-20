//! Fork: the dynamic-workflow gate rules (Node `resolveDynamicWorkflowRuntimeGate`, `updateDynamicWorkflowPolicy`) and
//! the ten workflow tool names (Node `DYNAMIC_WORKFLOW_TOOL_NAMES`, `core/src/tool/handlers/index.ts`).

use super::{
    DynamicWorkflowGate, DynamicWorkflowGates, DynamicWorkflowMode, DynamicWorkflowPreferences,
    SessionGates, resolve_gate,
};
use crate::ids::SessionId;
use crate::tool_names::DYNAMIC_WORKFLOW_TOOLS;

const ON_DEMAND: DynamicWorkflowMode = DynamicWorkflowMode::OnDemand;
const ALWAYS_ON: DynamicWorkflowMode = DynamicWorkflowMode::AlwaysOn;

fn prefs(enabled: bool, mode: Option<DynamicWorkflowMode>) -> DynamicWorkflowPreferences {
    let mut cached = DynamicWorkflowPreferences::default();
    cached.set(enabled, mode);
    cached
}

#[test]
fn the_gate_is_closed_when_neither_the_record_nor_the_host_enables_it() {
    let gate = resolve_gate(None, None, &prefs(false, None));
    assert!(!gate.enabled);
    assert!(!gate.tools_on_demand);
}

#[test]
fn the_create_parameters_enable_over_a_closed_preference() {
    let gate = resolve_gate(Some(true), None, &prefs(false, None));
    assert!(gate.enabled);
    assert!(!gate.tools_on_demand, "no mode anywhere means alwaysOn");
}

#[test]
fn a_false_parameter_does_not_close_an_enabled_preference() {
    // Node: `params.dynamicWorkflowEnabled === true || preferences.dynamicWorkflowEnabled`.
    let gate = resolve_gate(Some(false), None, &prefs(true, None));
    assert!(gate.enabled);
}

#[test]
fn the_preference_mode_applies_when_the_parameters_carry_none() {
    let gate = resolve_gate(None, None, &prefs(true, Some(ON_DEMAND)));
    assert!(gate.enabled);
    assert!(gate.tools_on_demand);
}

#[test]
fn the_parameter_mode_wins_over_the_preference_mode() {
    let gate = resolve_gate(Some(true), Some(ALWAYS_ON), &prefs(true, Some(ON_DEMAND)));
    assert!(gate.enabled);
    assert!(!gate.tools_on_demand);
}

#[test]
fn only_on_demand_defers_tools_and_disabled_is_not_on_demand() {
    let gate = resolve_gate(
        Some(true),
        Some(DynamicWorkflowMode::Disabled),
        &prefs(false, None),
    );
    assert!(
        gate.enabled,
        "enabled is decided by the boolean, not by the mode"
    );
    assert!(!gate.tools_on_demand);
}

#[test]
fn a_closed_gate_is_off_even_when_the_parameters_name_on_demand() {
    let gate = resolve_gate(Some(false), Some(ON_DEMAND), &prefs(false, None));
    assert!(!gate.enabled);
    assert!(!gate.tools_on_demand);
}

#[test]
fn the_parameter_mode_wins_when_the_gate_opened_from_the_preference() {
    let gate = resolve_gate(None, Some(ALWAYS_ON), &prefs(true, Some(ON_DEMAND)));
    assert!(gate.enabled);
    assert!(!gate.tools_on_demand);
}

#[test]
fn enabling_again_without_a_mode_clears_a_stale_on_demand() {
    // Node: updateDynamicWorkflowPolicy clears the mode when disabled, so a boolean-only enable is alwaysOn.
    let mut cached = prefs(true, Some(ON_DEMAND));
    cached.set(false, Some(ON_DEMAND));
    cached.set(true, None);
    let gate = resolve_gate(None, None, &cached);
    assert!(gate.enabled);
    assert!(!gate.tools_on_demand);
}

#[test]
fn the_mode_takes_only_the_three_wire_values() {
    assert_eq!(
        serde_json::from_str::<DynamicWorkflowMode>("\"onDemand\"").unwrap(),
        ON_DEMAND
    );
    assert_eq!(
        serde_json::from_str::<DynamicWorkflowMode>("\"alwaysOn\"").unwrap(),
        ALWAYS_ON
    );
    assert_eq!(
        serde_json::from_str::<DynamicWorkflowMode>("\"disabled\"").unwrap(),
        DynamicWorkflowMode::Disabled
    );
    assert!(serde_json::from_str::<DynamicWorkflowMode>("\"sometimes\"").is_err());
}

// W7-7a (specs/fork-rust-workflow-engine.md 9.36, divergence 56): the one table of the sessions' recorded gates.

const OPEN: DynamicWorkflowGate = DynamicWorkflowGate {
    enabled: true,
    tools_on_demand: false,
};

#[test]
fn a_session_with_no_record_has_no_gate() {
    let table = SessionGates::default();
    assert_eq!(table.gate(&SessionId::new("ses_a")), None);
}

#[test]
fn a_recorded_gate_is_read_back_for_its_session_only() {
    let table = SessionGates::default();
    table.record(&SessionId::new("ses_a"), OPEN);
    assert_eq!(table.gate(&SessionId::new("ses_a")), Some(OPEN));
    assert_eq!(table.gate(&SessionId::new("ses_b")), None);
}

#[test]
fn a_later_record_replaces_the_earlier_one_and_forget_removes_it() {
    let table = SessionGates::default();
    let id = SessionId::new("ses_a");
    table.record(&id, OPEN);
    let closed = DynamicWorkflowGate {
        enabled: false,
        tools_on_demand: false,
    };
    table.record(&id, closed);
    assert_eq!(table.gate(&id), Some(closed));
    table.forget(&id);
    assert_eq!(table.gate(&id), None);
}

#[test]
fn a_shared_table_is_one_source_for_every_holder() {
    let table = std::sync::Arc::new(SessionGates::default());
    let source: std::sync::Arc<dyn DynamicWorkflowGates> = table.clone();
    table.record(&SessionId::new("ses_a"), OPEN);
    assert_eq!(source.gate(&SessionId::new("ses_a")), Some(OPEN));
}

#[test]
fn the_workflow_tool_set_is_exactly_the_ten_node_names() {
    // Node's declaration order (`DYNAMIC_WORKFLOW_TOOL_NAMES`, core/src/tool/handlers/index.ts).
    assert_eq!(
        DYNAMIC_WORKFLOW_TOOLS,
        [
            "CreateWorkflow",
            "AmendWorkflow",
            "SaveWorkflow",
            "ListSavedWorkflows",
            "EvalWorkflowSnippet",
            "ListWorkflowRuns",
            "GetWorkflowRun",
            "ResumeWorkflowRun",
            "ResolveWorkflowQuestion",
            "FillWorkflowHole",
        ]
    );
}
