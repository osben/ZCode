use super::*;

/// The packaged Agent prompt still carries the line this module replaces; otherwise the
/// desktop would silently keep the background guidance.
#[test]
fn the_packaged_prompt_gets_nodes_foreground_guidance() {
    let definition = rust_cli_prompts::definition("Agent");
    assert!(
        definition
            .description
            .split('\n')
            .any(|line| line.starts_with(BACKGROUND_DEFAULT_LINE))
    );
    let desktop = description(&definition.description);
    assert!(desktop.contains(NODE_BACKGROUND_LINE));
    assert!(!desktop.contains("run in the background by default"));
    let schema = input_schema(&definition.schema);
    assert_eq!(
        schema["properties"]["run_in_background"]["description"],
        NODE_PARAMETER
    );
    assert_eq!(schema["properties"]["run_in_background"]["type"], "boolean");
}
