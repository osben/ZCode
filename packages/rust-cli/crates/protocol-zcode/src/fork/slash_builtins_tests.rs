use super::*;

fn names(commands: &[Value]) -> Vec<&str> {
    commands
        .iter()
        .map(|command| command["name"].as_str().unwrap())
        .collect()
}

#[test]
fn the_built_ins_the_runtime_runs_are_listed_with_node_help_text() {
    let commands = builtin_slash_commands(true);
    // Node's order (APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES): workflow directly follows goal.
    assert_eq!(names(&commands), ["goal", "workflow", "compact"]);
    let goal = &commands[0];
    assert_eq!(goal["description"], "Show or set the current session goal.");
    assert_eq!(
        goal["inputHint"],
        "/goal [pause|resume|clear|replace <objective>|<objective>]"
    );
    assert_eq!(goal["source"], "builtin");
}

#[test]
fn workflow_is_listed_only_while_the_gate_is_open() {
    assert_eq!(names(&builtin_slash_commands(false)), ["goal", "compact"]);
    assert!(names(&builtin_slash_commands(true)).contains(&"workflow"));
}

#[test]
fn the_built_in_names_are_reserved_from_custom_commands() {
    for name in ["goal", "workflow", "compact", "init", "dream", "plan"] {
        assert!(is_reserved_slash_name(name), "{name} is reserved");
    }
    assert!(!is_reserved_slash_name("review"), "a custom name is free");
}
