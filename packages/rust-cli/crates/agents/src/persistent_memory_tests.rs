//! Fork (rule 18, specs/fork-rust-subagent-runtime-config.md): a subagent's persistent memory.

use std::path::{Path, PathBuf};

use rust_cli_kernel_api::subagent_config::AgentMemoryScope;

use super::{project_memory_tools, prompt, root, sanitize_key};
use crate::definitions::builtins;

#[test]
fn the_scope_names_are_user_project_and_local() {
    assert_eq!(
        AgentMemoryScope::from_name("user"),
        Some(AgentMemoryScope::User)
    );
    assert_eq!(
        AgentMemoryScope::from_name("project"),
        Some(AgentMemoryScope::Project)
    );
    assert_eq!(
        AgentMemoryScope::from_name("local"),
        Some(AgentMemoryScope::Local)
    );
    assert_eq!(AgentMemoryScope::from_name("global"), None);
}

#[test]
fn the_key_keeps_word_characters_and_replaces_the_rest() {
    assert_eq!(sanitize_key("code reviewer!"), "code-reviewer-");
    assert_eq!(sanitize_key("docs_writer-2"), "docs_writer-2");
    assert_eq!(sanitize_key(""), "unknown");
}

#[test]
fn each_scope_has_its_own_root() {
    let storage = Path::new("/store");
    let workspace = Path::new("/work");
    assert_eq!(
        root(AgentMemoryScope::User, storage, workspace, "rev"),
        PathBuf::from("/store/agent-memory/rev")
    );
    assert_eq!(
        root(AgentMemoryScope::Project, storage, workspace, "rev"),
        PathBuf::from("/work/.zcode/agent-memory/rev")
    );
    assert_eq!(
        root(AgentMemoryScope::Local, storage, workspace, "rev"),
        PathBuf::from("/work/.zcode/agent-memory-local/rev")
    );
}

#[test]
fn the_prompt_names_the_root_the_scope_and_the_index() {
    let text = prompt(
        "- [Style](style.md) — terse",
        Path::new("/work/.zcode/agent-memory/rev"),
        AgentMemoryScope::Project,
    );
    assert!(text.starts_with("# Persistent Agent Memory\n"), "{text}");
    assert!(
        text.contains("persistent, file-based memory system at `/work/.zcode/agent-memory/rev/`"),
        "{text}"
    );
    assert!(
        text.contains("- Since this memory is project-scope and shared with your team via version control, tailor your memories to this project"),
        "{text}"
    );
    assert!(!text.contains("<SCOPE_GUIDANCE>"), "{text}");
    assert!(
        text.ends_with("## MEMORY.md\n\n- [Style](style.md) — terse"),
        "{text}"
    );
}

#[test]
fn an_empty_index_says_so() {
    let text = prompt("  ", Path::new("/s"), AgentMemoryScope::User);
    assert!(
        text.ends_with("## MEMORY.md\n\nYour MEMORY.md is currently empty. When you save new memories, they will appear here."),
        "{text}"
    );
}

#[test]
fn a_memory_child_with_a_tool_list_gets_write_and_edit_once() {
    let mut definition = builtins().remove(0);
    definition.tools = Some(vec!["Read".to_owned(), "Write".to_owned()]);
    definition.memory = Some(AgentMemoryScope::User);
    project_memory_tools(&mut definition);
    assert_eq!(
        definition.tools,
        Some(vec![
            "Read".to_owned(),
            "Write".to_owned(),
            "Edit".to_owned()
        ])
    );
}

#[test]
fn a_child_without_memory_or_without_a_tool_list_keeps_its_tools() {
    let mut plain = builtins().remove(0);
    plain.tools = Some(vec!["Read".to_owned()]);
    project_memory_tools(&mut plain);
    assert_eq!(plain.tools, Some(vec!["Read".to_owned()]));

    let mut inherit = builtins().remove(0);
    inherit.tools = None;
    inherit.memory = Some(AgentMemoryScope::Local);
    let wildcard_tools = Some(vec!["*".to_owned()]);
    let mut wildcard = inherit.clone();
    wildcard.tools = wildcard_tools.clone();
    project_memory_tools(&mut wildcard);
    assert_eq!(wildcard.tools, wildcard_tools);
    project_memory_tools(&mut inherit);
    assert_eq!(inherit.tools, None);
}

#[test]
fn the_storage_root_is_configured_only_when_memory_is_enabled_and_used() {
    let storage = Path::new("/store");
    assert_eq!(
        super::configured_root(true, true, Some(storage)),
        Some(PathBuf::from("/store"))
    );
    assert_eq!(super::configured_root(false, true, Some(storage)), None);
    assert_eq!(super::configured_root(true, false, Some(storage)), None);
    assert_eq!(super::configured_root(true, true, None), None);
}
