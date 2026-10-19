# Terminal working directory for worktree sessions

## Behavior

When a terminal is newly created while a session with an execution worktree is active, its initial working directory is that session's `executionWorktree.path`. When the active session has no execution worktree, the terminal starts in the workspace path.

This applies to newly created terminals in both the bottom workspace panel and the right side pane. The workspace identity remains the terminal's ownership and cleanup boundary; the execution worktree path only selects the terminal's initial directory.

An already running terminal keeps its current process and working directory when the active task changes. Creating another terminal after switching tasks uses the newly active task's execution directory.

## Acceptance scenarios

1. Active worktree session → create a bottom-panel terminal → its PTY starts in the execution worktree directory.
2. Active worktree session → open a right-side terminal tab → its PTY starts in the execution worktree directory.
3. Active session without a worktree → create either terminal → its PTY starts in the workspace directory.
4. Switch tasks while a terminal is running → the existing PTY remains alive at its original directory; a newly created terminal uses the active task's directory.
5. Remote workspace with an active worktree session → terminal creation preserves the existing workspace identity and remote-session routing while using the execution worktree path.
