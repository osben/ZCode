# Git Auto Refresh

## Background

The top Git action entry and the bottom Git branch switcher both depend on the `GitRepositorySummary` read by `useGitRepository`. The historical implementation re-pulled state only on workspace switch, Git pane open, user manual refresh and Git operation completion; if the user edited files or switched branches in an external editor, the UI stayed on the old state.

## Implementation

When the current workspace is visible and Git is available, `useGitAutoRefresh` registers `fileWatcherService.watch()` according to the workspace Host's platform and `gitSummary.autoRefreshWatchPaths`. The Git service returns only the gitdir/common-dir metadata paths resolved by Git itself, so workspace content paths are not the cross-platform shared source of fact for recursive watching; this also supports monorepo subdirectories and linked worktrees.

- macOS / Windows workspace: keep the recursive watcher on workspace content paths and add the Git metadata paths.
- Linux workspace (including local Linux, SSH, WSL, Docker): watch only the Git metadata paths and do not recursively watch the whole workspace. A recursive `fs.watch` on Linux must traverse subdirectories and, on slow mounts or large generated directories, blocks the workspace Host and delays task/session RPC.
- When the workspace Host platform has not returned yet, or an old server summary still carries workspace content paths: handle it with the conservative Linux strategy and register no workspace recursive watcher; manual refresh and the refresh chain after Git operations are unchanged.

When an event arrives the hook triggers the existing `onRefreshGit()` under the throttling contract below, reusing the original `gitRefreshVersion` refresh chain.

### Throttling contract

- A single file event: refresh once after about 500ms.
- A continuous event stream (for example the agent writing files in bulk): a pure debounce that restarts on every event never fires while the stream continues, so a max-wait is required. A refresh within one event stream runs at the latest 5s after the first event of that batch, and at most once every 5s afterwards, so `git status` does not run repeatedly during bulk writes; after the stream ends a 500ms trailing debounce adds one more refresh so the final state is refreshed.
- At least 5s between two refreshes. A single event arriving within 5s of the last refresh has its refresh deferred to 5s after the last refresh; this is the accepted cost of keeping the 5s cap.
- After quiet for long enough (beyond the 5s throttle window; the 30s quiet required by the contract is far longer), the next single event resumes the 500ms fast path. Throttle state belongs only to the current watcher subscription: re-registering the watcher starts from a clean state.

This chain covers:

- On macOS / Windows, after an external editor modifies, creates or deletes files, the top Git action entry re-evaluates the dirty state.
- On all platforms, after an external command switches branch, commits, or stages/unstages, the bottom branch name and the push/commit entries update in sync.
- On a Linux workspace, external edits of the working tree do not trigger an immediate dirty refresh from a workspace watcher; the user can refresh manually, and the existing refresh chain after ZCode/Git operations is unchanged.
- A remote workspace keeps registering the watcher through workspace-scoped services; the platform fact of WSL/SSH/Docker comes from the remote Host's `systemService.info()`, and the desktop platform must not be used to decide. When a remote disconnects or the platform does not support watch, a watch failure only logs a warn and the manual refresh and post-operation refresh chain is kept.

## Trade-offs

Fixed-interval polling is not used. Polling keeps generating Git CLI/RPC cost on large repos and remote workspaces; event-triggered refresh runs only when the file system actually changes, which fits the workspace model shared by desktop and Web remote control better.

Throttling replaces the earlier 1-minute debounce: a 1-minute debounce postponed the refresh indefinitely under continuous writes (QA observed the refresh count never changing within a 10-45s window), while the 5s cap still protects `git status` from being triggered repeatedly by bulk writes.

## Large-repo status degradation

The detailed output of `git status --untracked-files=all` may exceed the Git command's output budget because a cache directory or generated artifacts contain tens of thousands of untracked files. The budget must not simply be raised: after the detailed status returns, each untracked file is read to count lines, which would amplify one UI refresh into tens of thousands of concurrent file reads.

After the first discovery that the detailed status exceeds the limit, the Git repo must apply a runtime capability degradation for the current `repoRoot`:

- Rerun `git status --untracked-files=normal`, collapsing untracked directories into directory-level records, so branch, tracked changes, dirty state and actionable untracked entries can still be returned.
- Later refreshes within the same repo instance use the collapsed mode directly and do not repeat a detailed command that is certain to exceed the limit.
- The degradation is keyed only by the `repoRoot` with real path semantics and does not use `workspaceIdentity`; Git service processes of different remote servers are naturally isolated.
- A normal-size repo still uses `--untracked-files=all`, keeping the per-file display semantics.
- The first degradation logs one `warn`, and later refreshes do not repeat the same warning; if the collapsed mode still exceeds the limit it is treated as a real failure and the truncated Git output is not parsed.
