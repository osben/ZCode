//! Fork: the dynamic-workflow gate rules (Node `resolveDynamicWorkflowRuntimeGate`, `updateDynamicWorkflowPolicy`) and
//! the ten workflow tool names (Node `DYNAMIC_WORKFLOW_TOOL_NAMES`, `core/src/tool/handlers/index.ts`).

use super::{DynamicWorkflowMode, DynamicWorkflowPreferences, resolve_gate};
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
fn a_mode_is_ignored_while_the_gate_is_closed() {
    let gate = resolve_gate(Some(false), Some(ON_DEMAND), &prefs(false, Some(ON_DEMAND)));
    assert!(!gate.enabled);
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

#[test]
fn the_workflow_tool_set_is_exactly_the_ten_node_names() {
    let mut names = DYNAMIC_WORKFLOW_TOOLS.to_vec();
    names.sort_unstable();
    let mut expected = vec![
        "AmendWorkflow",
        "CreateWorkflow",
        "EvalWorkflowSnippet",
        "FillWorkflowHole",
        "GetWorkflowRun",
        "ListSavedWorkflows",
        "ListWorkflowRuns",
        "ResolveWorkflowQuestion",
        "ResumeWorkflowRun",
        "SaveWorkflow",
    ];
    expected.sort_unstable();
    assert_eq!(names, expected);
}
