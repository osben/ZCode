use serde_json::json;

use super::*;

#[test]
fn select_options_flatten_groups_and_skip_other_types() {
    let raw = json!([
        {"id": "model", "name": "Model", "type": "select", "currentValue": "a", "category": "model",
         "options": [
            {"name": "Fast", "options": [{"value": "a", "name": "A", "description": "first"}]},
            {"value": "b", "name": "B"},
            {"value": 3, "name": "bad"}
         ]},
        {"id": "flag", "name": "Flag", "type": "boolean", "currentValue": true}
    ]);
    let options = normalize_options(Some(&raw));
    assert_eq!(options.len(), 1);
    assert_eq!(
        options[0].to_json(),
        json!({"id": "model", "name": "Model", "description": null, "category": "model", "currentValue": "a",
        "options": [
          {"value": "a", "name": "A", "description": "first", "group": "Fast"},
          {"value": "b", "name": "B", "description": null, "group": null}
        ]})
    );
    assert_eq!(options_from_json(&options_to_json(&options)), Some(options));
}

#[test]
fn legacy_modes_become_one_mode_option_set_through_set_mode() {
    let mut state = ConfigState::default();
    state.reset(
        &json!({"modes": {"currentModeId": "build", "availableModes": [
        {"id": "build", "name": "Build"}, {"id": "plan", "name": "Plan"}]}}),
    );
    assert_eq!(state.options().len(), 1);
    assert_eq!(state.options()[0].id, "mode");
    assert_eq!(state.options()[0].category.as_deref(), Some("mode"));
    assert_eq!(state.plan_set("mode", "plan"), Ok(ConfigRequest::SetMode));
    assert_eq!(
        state
            .plan_set("mode", "ask")
            .expect_err("not offered")
            .message,
        "Config option \"mode\" does not offer \"ask\""
    );
    assert_eq!(
        state.plan_set("model", "x").expect_err("unknown").message,
        "Unknown config option \"model\""
    );
    state.applied("mode", "plan", &json!({}));
    assert_eq!(state.options()[0].current_value, "plan");
    assert_eq!(state.handshake_options()[0].current_value, "build");
}

#[test]
fn updates_replace_or_set_the_mode() {
    let mut state = ConfigState::default();
    state.reset(&json!({"configOptions": [
        {"id": "mode", "name": "Mode", "type": "select", "currentValue": "agent", "category": "mode",
         "options": [{"value": "agent", "name": "Agent"}, {"value": "plan", "name": "Plan"}]}]}));
    assert_eq!(
        state.surface(&json!({"sessionUpdate": "current_mode_update", "currentModeId": "plan"})),
        Some(true)
    );
    assert_eq!(state.options()[0].current_value, "plan");
    assert_eq!(
        state.surface(&json!({"sessionUpdate": "config_option_update", "configOptions": []})),
        Some(true)
    );
    assert!(state.options().is_empty());
    assert_eq!(
        state.surface(&json!({"sessionUpdate": "current_mode_update", "currentModeId": "plan"})),
        Some(false)
    );
    assert_eq!(state.surface(&json!({"sessionUpdate": "plan"})), None);
}
