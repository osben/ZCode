//! Fork: the execution worktree notice in the main session's system prompt (specs/fork-rust-execution-worktree-context.md;
//! Node `buildExecutionWorktreeSection` and the position in `ContextBuilder.build`).

use rust_cli_kernel_api::incognito::IncognitoProfile;
use rust_cli_kernel_api::model::CacheControl;
use rust_cli_prompts::texts::{self, render};

use crate::config::Surface;
use crate::system::{PromptFacts, sections, system_blocks};

const WORKTREE: &str = "# Environment\n- Execution worktree: this session runs in a linked git worktree of /w (branch a); file changes stay in the worktree until they are merged.";

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|name| (*name).to_owned()).collect()
}

fn facts(tool_names: &[String]) -> PromptFacts<'_> {
    PromptFacts {
        surface: Surface::Interactive,
        system_turns: true,
        tool_names,
        has_skills: true,
        memory_dir: Some("/m/"),
        output_style: None,
        custom: None,
        append: None,
        token_budget: true,
        incognito: None,
        desktop: None,
        worktree: None,
    }
}

fn ephemeral() -> Option<CacheControl> {
    Some(CacheControl {
        kind: "ephemeral".to_owned(),
        ttl: None,
        scope: None,
    })
}

/// Node's dynamic system sections put the notice after Memory and before Context management, and `/context` lists it as
/// "Execution Worktree". A session without it is byte for byte what it was.
#[test]
fn the_section_sits_between_memory_and_context_management() {
    let tools = names(&["Skill"]);
    let plain = system_blocks(&facts(&tools));
    let mut worktree = facts(&tools);
    worktree.worktree = Some(WORKTREE);
    let blocks = system_blocks(&worktree);
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[..2], plain[..2]);
    let session = &blocks[2].text;
    let at = |text: &str| session.find(text).unwrap_or_else(|| panic!("{text}"));
    let memory = render(texts::memory_lean(), &[("memory_dir", "/m/")]);
    assert!(at(&memory) < at(WORKTREE));
    assert!(at(WORKTREE) < at(texts::context_management()));
    assert_eq!(
        session.replace(&format!("{WORKTREE}\n\n"), ""),
        plain[2].text
    );
    let named: Vec<&str> = sections(&worktree)
        .iter()
        .map(|section| section.name)
        .collect();
    let position = |name: &str| named.iter().position(|found| *found == name).unwrap();
    assert!(position("Memory") < position("Execution Worktree"));
    assert!(position("Execution Worktree") < position("Context management"));
}

/// The notice is isolation context, not environment or harness text, so no incognito toggle drops it.
#[test]
fn the_section_survives_a_lockdown_profile() {
    let tools = names(&["Skill"]);
    let mut locked = facts(&tools);
    locked.worktree = Some(WORKTREE);
    locked.incognito = Some(IncognitoProfile::LOCKDOWN);
    assert!(
        system_blocks(&locked)
            .iter()
            .any(|block| block.text.contains(WORKTREE))
    );
    assert!(
        sections(&locked)
            .iter()
            .any(|section| section.name == "Execution Worktree")
    );
}

/// With `--system-prompt` Node still sends the notice, as its own dynamic system message after the custom text.
#[test]
fn a_custom_prompt_keeps_the_section_as_a_trailing_block() {
    let tools = names(&["Skill"]);
    let mut custom = facts(&tools);
    custom.custom = Some("CUSTOM");
    custom.append = Some("APPENDED");
    let plain = system_blocks(&custom);
    custom.worktree = Some(WORKTREE);
    let blocks = system_blocks(&custom);
    assert_eq!(blocks.len(), plain.len() + 1);
    assert_eq!(blocks[..plain.len()], plain[..]);
    let last = blocks.last().unwrap();
    assert_eq!(last.text, WORKTREE);
    assert_eq!(last.cache_control, ephemeral());
    let named: Vec<&str> = sections(&custom)
        .iter()
        .map(|section| section.name)
        .collect();
    assert_eq!(
        named,
        ["Custom prompt", "Execution Worktree", "Appended prompt"]
    );
}
