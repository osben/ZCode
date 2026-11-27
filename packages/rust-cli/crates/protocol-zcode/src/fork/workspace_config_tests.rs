use super::*;

fn command(name: &str) -> Value {
    json!({"name": name, "description": "d", "source": "builtin"})
}

#[test]
fn the_empty_state_has_no_options_and_no_commands() {
    assert_eq!(empty(), json!({"configOptions": [], "slashCommands": []}));
}

#[test]
fn the_mode_option_lists_the_four_fixed_modes_with_node_text() {
    let state = state(Some("build"), vec![command("goal")]);
    let options = state["configOptions"].as_array().unwrap();
    assert_eq!(options.len(), 1);
    let mode = &options[0];
    assert_eq!(mode["id"], "mode");
    assert_eq!(mode["name"], "Mode");
    assert_eq!(mode["category"], "mode");
    assert_eq!(mode["type"], "select");
    assert_eq!(mode["currentValue"], "build");
    assert_eq!(
        mode["options"],
        json!([
            {"value": "build", "name": "Ask before changes", "description": "Ask before each file changes."},
            {"value": "guarded", "name": "Autonomous mode", "description": "Ask when there\u{2019}s risk"},
            {"value": "plan", "name": "Plan mode",
                "description": "Inspect the code and present a plan before editing."},
            {"value": "yolo", "name": "Full access",
                "description": "Edit and run commands with fewer confirmations."},
        ])
    );
    assert_eq!(state["slashCommands"], json!([command("goal")]));
}

#[test]
fn the_current_mode_is_normalized_like_node() {
    let current =
        |mode: Option<&str>| state(mode, Vec::new())["configOptions"][0]["currentValue"].clone();
    for kept in ["build", "guarded", "plan", "yolo", "edit"] {
        assert_eq!(current(Some(kept)), kept);
    }
    // `auto` is not in Node's mode list, and an unknown value falls back like it.
    assert_eq!(current(Some("auto")), "build");
    assert_eq!(current(Some("nonsense")), "build");
    assert_eq!(current(None), "build");
}
