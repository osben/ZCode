//! The execution worktree notice, byte for byte as Node (`formatExecutionWorktreeSentence`,
//! `buildExecutionWorktreeSection`, `buildSubagentExecutionWorktreeContext`).

use super::{section, sentence, subagent_block};

#[test]
fn a_healthy_worktree_names_the_parent_and_the_branch() {
    assert_eq!(
        sentence("/w/.wt/a", "/w", Some("feat/a"), false).as_deref(),
        Some(
            "Execution worktree: this session runs in a linked git worktree of /w (branch feat/a); file changes stay in the worktree until they are merged."
        )
    );
}

#[test]
fn a_worktree_without_a_branch_leaves_the_clause_out() {
    let expected = "Execution worktree: this session runs in a linked git worktree of /w; file changes stay in the worktree until they are merged.";
    assert_eq!(
        sentence("/w/.wt/a", "/w", None, false).as_deref(),
        Some(expected)
    );
    assert_eq!(
        sentence("/w/.wt/a", "/w", Some(""), false).as_deref(),
        Some(expected)
    );
}

#[test]
fn a_missing_worktree_says_actions_are_blocked() {
    assert_eq!(
        sentence("/w/.wt/a", "/w", Some("feat/a"), true).as_deref(),
        Some(
            "Execution worktree: the requested worktree /w/.wt/a is missing; filesystem and terminal actions are blocked until it is restored. The parent workspace is /w."
        )
    );
}

#[test]
fn without_a_parent_workspace_nothing_is_said() {
    assert_eq!(sentence("/w/.wt/a", "", Some("a"), false), None);
    assert_eq!(section("/w/.wt/a", "", Some("a"), false), None);
    assert_eq!(subagent_block("/w/.wt/a", "", Some("a"), true), None);
}

#[test]
fn the_main_section_is_an_environment_heading_and_one_dash_line() {
    assert_eq!(
        section("/w/.wt/a", "/w", None, false).as_deref(),
        Some(
            "# Environment\n- Execution worktree: this session runs in a linked git worktree of /w; file changes stay in the worktree until they are merged."
        )
    );
}

#[test]
fn a_subagent_gets_the_sentence_in_env_tags() {
    assert_eq!(
        subagent_block("/w/.wt/a", "/w", Some("a"), false).as_deref(),
        Some(
            "<env>\nExecution worktree: this session runs in a linked git worktree of /w (branch a); file changes stay in the worktree until they are merged.\n</env>"
        )
    );
}

#[test]
fn paths_are_written_as_they_are() {
    let text = sentence("/w/<x>", "/w/{{y}}\n", None, false).unwrap();
    assert!(text.contains("/w/{{y}}\n;"), "{text}");
}
