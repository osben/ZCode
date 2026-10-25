# BUG-GWT-007: "Open worktree" for a stale branch silently opens a nonexistent directory as a project

- Status: FIXED (retest 2026-10-18, merge b67cc63f; UI-confirmed; marker removed / covered by upstream test)
- Severity: S3 (workaround: close the ghost project and press "Prune stale" on the setup page)
- Cases: E4
- Environment: macOS 27.2, commit `bd6a05b3b7dd045d10a47bc7a193a27f86e8f355` (branch `qa/git-worktree-20261017`), isolated QA instance (production build)

## Repro

1. Fixture R11 (`make-fixtures.sh R11`): repo `$QA_ROOT/repos/has-worktrees` with worktree entries `live`, `stale` (folder removed with `rm -rf` without `git worktree prune`, so the entry is prunable) and `locked`.
2. Settings -> Worktrees: set the `has-worktrees` project override `branchPrefix = sta` (so the typed name `stale` composes to the existing branch `stale`).
3. Open `has-worktrees` -> `Cmd+K` -> "New task in worktree" -> pick `has-worktrees` -> type `stale` in Branch name.
4. The hint "This branch already exists; the new worktree will check it out." appears with an "Open worktree" button (pointing at `has-worktrees-wt/stale`); Start is disabled (branch held by a prunable entry).
5. Click "Open worktree".

Actual: the palette closes and the sidebar shows a project `stale` with an empty-state composer. No error or warning about the missing directory (no toast, no missing badge). A v4-conversation subscription is created for the nonexistent path. `git worktree list` is unchanged (no auto-prune, which is correct).

## Expected

- `docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md`, WT-04: "Worktree created but opening the workspace/draft failed: the existing path is shown and a retry is available without creating a second worktree". Opening a nonexistent directory must count as an error and be shown as recoverable (path + retry), not pass silently.
- Matrix E4 (`QA-PROMPT.md` §6, block E): "Branch `stale` (folder deleted) -> recoverable error, no automatic prune".
- `docs/git/worktree-operations.md` §pruneWorktrees: stale entries are removed only by an explicit prune; opening must neither prune nor pretend the directory exists.

## Actual

- Git before/after: 4 entries in `git worktree list --porcelain`, `stale` stays prunable; the disk keeps only `live/` and `locked/`. No auto-prune (OK).
- UI: ghost project `stale` opened as a normal workspace, no error or badge; a draft session and a `v4-conversation` subscription to the nonexistent path were created.
- No new `error`/`warn` log lines: no layer treats the open as an error.

## Cause (confirmed in code)

- `packages/ui/src/command-center/CommandCenterDialog.tsx:1049-1090`: the existing-branch offer effect takes `listWorktrees` -> `findWorktreeForBranch(...)` (`worktreeTaskFlow.ts:387-392`) and stores `match.path` in `worktreeExistingBranchWorktreePath` without checking that the directory exists. The porcelain list legitimately contains stale/prunable entries (`docs/git/worktree-operations.md` §listWorktrees Parsing Rules: `prunable` is ignored at that layer; `GitWorktreeEntry` has no stale flag).
- `CommandCenterDialog.tsx:2050-2063`: the "Open worktree" click calls `closeDialog(); openTaskWorkspace(worktreeExistingBranchWorktreePath)` directly, without path validation.
- `CommandCenterDialog.tsx:1271-1298`: `openTaskWorkspace` only handles a reject of `onCreateTaskInWorkspace`; opening a nonexistent directory succeeds, so the WT-04 contract never triggers.
- Contrast: the sibling creation-recovery path already checks: `worktreeCreation.ts:108-135` calls `gitService.verifyWorktreeUsable` (`packages/shared/src/git.ts:203-214`, returns `{ok:false, reason:"missing-directory"|"missing-git-link"}`) and returns the recoverable error `commandCenter.worktree.error.worktreeMissing`. The palette offer bypasses it.
- Hypothesis (unverified): the workspace-open layer (`handleCreateTaskInWorkspace` in `packages/ui/src/App.tsx` and below) also does not check directory existence; Host/main not investigated.

## Fix direction

In the existing-branch offer, verify the real directory before opening: reuse `gitService.verifyWorktreeUsable` on the `CommandCenterDialog.tsx:1049-1090` / `2050-2063` paths. On `{ok:false}` do not call `onCreateTaskInWorkspace` with the nonexistent path; show a recoverable error per WT-04 (path + retry) with a hint about "Prune stale" / recreating the worktree. Do not add auto-prune. Optionally mark stale entries in the worktree list (requires extending `listWorktrees` with a prunable flag, a separate spec change to `docs/git/worktree-operations.md`).

## Test

`packages/ui/test/commandCenterWorktreeFlow.test.ts`, describe `BUG-GWT-007 existing-branch offer vs stale registered worktree` (UI orchestration level; git RPC mocked, self-contained, no sleeps). `listWorktrees` returns a stale entry for branch `zcode/stale`, `verifyWorktreeUsable` returns `{ok:false, reason:"missing-directory"}`; clicking "Open worktree" must not silently call `onCreateTaskInWorkspace` with the nonexistent path (blocked or visible error). The `it.fails` marker was removed after the fix.
