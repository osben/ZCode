use super::*;

fn names(commands: &[Value]) -> Vec<&str> {
    commands
        .iter()
        .map(|command| command["name"].as_str().unwrap())
        .collect()
}

/// A custom command entry (not the runtime's built-in skill).
fn custom(name: &str) -> (Value, bool) {
    (
        json!({"name": name, "description": "a custom command", "source": "custom"}),
        false,
    )
}

/// The runtime's own built-in skill, as the skill catalog reports it (`builtin: true`).
fn built_in_skill(name: &str) -> (Value, bool) {
    (
        json!({"name": name, "description": "a built-in skill", "source": "custom"}),
        true,
    )
}

#[test]
fn the_built_ins_the_runtime_runs_are_listed_with_node_help_text() {
    let commands = catalog_commands(true, Vec::new());
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
    assert_eq!(
        names(&catalog_commands(false, Vec::new())),
        ["goal", "compact"]
    );
    assert!(names(&catalog_commands(true, Vec::new())).contains(&"workflow"));
}

#[test]
fn built_ins_come_before_the_custom_commands() {
    let commands = catalog_commands(true, [custom("review")]);
    assert_eq!(names(&commands), ["goal", "workflow", "compact", "review"]);
}

#[test]
fn a_custom_command_with_a_reserved_name_is_dropped_whatever_its_case_or_slash() {
    // Node's reserved filter: `model`, `Plan` and `/GOAL` are reserved (normalized), `review` is free.
    let commands = catalog_commands(
        true,
        [
            custom("model"),
            custom("Plan"),
            custom("/GOAL"),
            custom("review"),
        ],
    );
    assert_eq!(names(&commands), ["goal", "workflow", "compact", "review"]);
}

#[test]
fn a_reserved_custom_workflow_stays_out_while_the_gate_is_closed() {
    let commands = catalog_commands(false, [custom("workflow")]);
    assert_eq!(names(&commands), ["goal", "compact"]);
}

/// W9b-2 (9.57, ocr round 2 on #615): the runtime's built-in `init` skill is listed, though `init` is reserved, because it is
/// not a user skill and `/init` still runs (ext `user.rs`). A user skill named `init` is still dropped.
#[test]
fn the_built_in_init_skill_is_listed_and_a_user_init_is_not() {
    let listed = catalog_commands(true, [built_in_skill("init")]);
    assert_eq!(names(&listed), ["goal", "workflow", "compact", "init"]);
    let dropped = catalog_commands(true, [custom("init")]);
    assert_eq!(names(&dropped), ["goal", "workflow", "compact"]);
}
