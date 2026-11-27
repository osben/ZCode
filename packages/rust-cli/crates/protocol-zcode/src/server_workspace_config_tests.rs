//! Fork (specs/fork-rust-workspace-config-topic.md): the state a `workspace-config/<workspaceId>` snapshot carries,
//! read from the open sessions of that workspace.

use super::*;

#[tokio::test]
async fn an_open_session_gives_its_workspace_the_mode_option_and_the_built_in_commands() {
    let (_scope, server, _handle, _queries) = open(false).await;
    let state = server.workspace_config("/w").await;
    let mode = &state["configOptions"][0];
    assert_eq!(mode["id"], "mode");
    // The session runs in the default permission mode, which Node calls `build`.
    assert_eq!(mode["currentValue"], "build");
    let names: Vec<&str> = state["slashCommands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|command| command["name"].as_str().unwrap())
        .collect();
    assert_eq!(names.first(), Some(&"goal"));
    assert!(names.contains(&"compact"), "{names:?}");
}

#[tokio::test]
async fn a_workspace_without_an_open_session_has_the_empty_state() {
    let (_scope, server, _handle, _queries) = open(false).await;
    assert_eq!(
        server.workspace_config("/other").await,
        json!({"configOptions": [], "slashCommands": []})
    );
}

#[tokio::test]
async fn the_slash_commands_are_the_ones_read_presentation_answers() {
    let (_scope, server, _handle, _queries) = open(false).await;
    let presentation = server
        .read_presentation(&json!({"workspace": {"workspacePath": "/w"}}))
        .await;
    let state = server.workspace_config("/w").await;
    assert_eq!(state["slashCommands"], presentation["slashCommands"]);
}
