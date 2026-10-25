# BUG-GWT-009: composer popover does not refresh the branch list after create-and-switch

- Status: FIXED (retest 2026-10-18, merge b67cc63f; UI-confirmed; marker removed / covered by upstream test)
- Severity: S3 (workaround: reload the window or switch workspace resets the cache; no data loss, but the branch list and current mark are wrong until then)
- Cases: B4
- Environment: macOS 27.2, commit `bd6a05b3b7dd045d10a47bc7a193a27f86e8f355` (branch `qa/git-worktree-20261017`), isolated QA instance (production build)

## Repro

1. Fixture R1 (basic): `main` with commits, branches `feature/a` / `main` / `release` (QA-PROMPT §4).
2. QA app: open project `basic`, destination chip (`aria-label="Choose where this task runs"`) -> "Task branch" row -> embedded branch list (`[main, feature/a, release]`, `main` marked current).
3. Footer action "Create and switch to new branch…" -> enter `qa/b4-valid` -> "Create and switch".
4. The dialog closes; the chip correctly shows `qa/b4-valid` (live git summary updated via `onRefreshGit`).
5. Reopen the chip -> branch list (`listOpen` survives popover close, so it opens immediately).

Git equivalent: `git checkout -b qa/b4-valid` (the UI list stays `[feature/a, main, release]`).

## Expected

`specs/composer-branch-switcher-semantics.md` §4, Popover row 2: the embedded branch list inherits the base switcher semantics: "Create and switch to new branch…" (existing `GitBranchCreateDialog` + create-and-switch semantics, unchanged) and "current check + dirty count"; §4 "Reuse": branch machinery comes from `useGitBranchSwitcher`. The status-panel `GitBranchSwitcher` refetches the list on every open (`useGitBranchSwitcher.ts:126-134`), so after create-and-switch the reopened list shows the new current branch. The composer's embedded copy must do the same.

## Actual

After create-and-switch (RPC `git.createBranchAndSwitch` ok, repo state correct) the reopened list is the stale `[main, feature/a, release]`: no `qa/b4-valid` row, and no row is marked current (live `currentBranchName` is not in the cached list, so "Uncommitted changes: N files" renders on no row). The chip is correct; only the embedded list is wrong. The cache lives until window reload or workspace change (reset effect keyed on `workspaceKey`). No log errors.

## Cause (confirmed by code trace and a red test)

`packages/ui/src/v4/composer/ComposerDestinationControl.tsx` keeps its own list cache, separate from the hook's:

- `:114` `branchesResult` (local state);
- `:186-220` the load effect exits when `branchesResult !== null` (`:188`), so the fetch runs exactly once (`setBranchesResult(result)` at `:194`);
- the only reset is the workspace/service-target effect (`:123-130`, `setBranchesResult(null)` at `:127`, deps `[workspaceKey, workspacePath, resolution.remoteSessionId, baseServices.gitService]`);
- `handleCreateBranchAndSwitch` (`:141-151`) does not invalidate `branchesResult` after a successful `switcher.createBranchAndSwitch()`;
- rendering uses the cache (`:315`), and the current mark is `branch.name === currentBranchName` from the live git summary (`:447`): the new branch is missing from the cache, so there is no row and no mark.
- The hook's `handleMutationResult` cache patch (`useGitBranchSwitcher.ts:255-268`) updates only the hook's own `branchesResult`, a different state instance. The status-panel switcher is correct because the hook has the post-mutation patch, the snapshot reset on HEAD change (`:111-124`) and the refetch on every open (`:126-154`); the composer has none of these.

## Fix direction and outcome

Proposed: invalidate the list after create-and-switch (`setBranchesResult(null)` plus reset `branchListFailed`), or mirror the hook strategy (reset when `gitSummary.branchName`/`headRefType` change while the popover is closed, without issuing RPC from the reset).

## Test (superseded)

`packages/ui/test/composerDestinationControl.test.ts`, `it.fails("BUG-GWT-009: reopening the branch list after create-and-switch shows the new current branch")`: renderer level (jsdom, @testing-library/react, `gitService` RPC mocked, no sleeps). Open popover -> list (`main` current via dirty hint) -> footer "Create and switch..." -> `qa/b4-valid` -> submit; mock `createBranchAndSwitch` mutates repo state and returns ok, `onRefreshGit` updates the live summary; reopen must list `qa/b4-valid` with the current-branch hint.
