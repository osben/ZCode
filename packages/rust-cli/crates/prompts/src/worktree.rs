//! Fork: the execution worktree notice (Node core `context/sections/env-info.ts` `formatExecutionWorktreeSentence`,
//! `buildExecutionWorktreeSection`, and `subagent/system-prompt.ts` `buildSubagentExecutionWorktreeContext`;
//! specs/fork-rust-execution-worktree-context.md). Paths are written as they are, like Node.

use crate::texts::{self, render};

/// The one-line notice. None without a parent workspace (Node `if (!worktree.workspacePath) return null`).
pub fn sentence(
    path: &str,
    workspace: &str,
    branch: Option<&str>,
    missing: bool,
) -> Option<String> {
    if workspace.is_empty() {
        return None;
    }
    if missing {
        return Some(render(
            texts::execution_worktree_missing(),
            &[("path", path), ("workspace", workspace)],
        ));
    }
    let branch = match branch.filter(|branch| !branch.is_empty()) {
        Some(branch) => render(texts::execution_worktree_branch(), &[("branch", branch)]),
        None => String::new(),
    };
    Some(render(
        texts::execution_worktree(),
        &[("workspace", workspace), ("branch", &branch)],
    ))
}

/// The main session's system section: an `# Environment` heading and the sentence as one list line.
pub fn section(path: &str, workspace: &str, branch: Option<&str>, missing: bool) -> Option<String> {
    let sentence = sentence(path, workspace, branch, missing)?;
    Some(render(
        texts::execution_worktree_section(),
        &[("sentence", &sentence)],
    ))
}

/// The subagent's last system part: the sentence in `<env>` tags.
pub fn subagent_block(
    path: &str,
    workspace: &str,
    branch: Option<&str>,
    missing: bool,
) -> Option<String> {
    let sentence = sentence(path, workspace, branch, missing)?;
    Some(render(
        texts::execution_worktree_subagent(),
        &[("sentence", &sentence)],
    ))
}

#[cfg(test)]
#[path = "worktree_tests.rs"]
mod tests;
