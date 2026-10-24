# Composer destination control

This is the detailed contract for [§4 of composer branch switcher semantics](composer-branch-switcher-semantics.md#4-unified-destination-control).
Section references below refer to that parent specification; its acceptance scenarios, validation
and scope exclusions still apply.

Replaces the header `GitBranchSwitcher` chip AND the `ChatEmptyWorktreeTaskToggle` checkbox behind a
renderer-local feature flag (`localStorage` key `zcode.fork.composerDestinationControl`, **default
on** — the new control ships visible; setting `"0"` renders the old pair untouched, so rollback is
instant and per-device). New component: `v4/composer/ComposerDestinationControl.tsx`.

- **Trigger chip**: project mode → the task branch (`intent ?? current`; the detached-HEAD label
  only when no branch can be named — an explicit intent is actionable at send and wins over the
  detached label); worktree mode → violet `Worktree` (never the auto-generated name). Pipeline
  `creating` keeps the chip usable (it reflects state, does not block). The popover opens **upward**
  (`side="top"`) — it hangs under the app header.
- **Popover row 1 — New worktree + switch**: quiet at rest (the at-rest location note and the
  dirty-tree note were removed by user decision; the location still applies from settings, it is
  just not displayed). The sub shows pipeline states only: "Creating worktree…", "Ready → <path>",
  "Failed — send again to retry"; turning the switch OFF while creating = withdraw ("Withdrawing —
  worktree left on disk"), never disabled.
- **Popover row 2 — Task branch / Base branch** (project mode names the branch the checkout switches
  to; worktree mode names the base the worktree forks from): value = the mode's effective selection
  ("detached" only when no branch can be named). The row value and the inline list checkmark render
  one per-mode derived selection — project mode: `draftBranchIntent ?? live current branch`;
  worktree mode: `base override ?? draftBranchIntent ?? live current branch`. The base override is
  worktree-mode state and never names the project-mode task branch; the row, the chip and the
  send-time checkout must always agree on that selection. The row is quiet at rest in both modes;
  only the failed-list disclosure shows: "Couldn't load branches — base defaults to HEAD" (disclosed
  before send). The send-time confirm guard remains the authoritative check.
- **Inline branch list** (same popover): search, current check + dirty count, and the base switcher's
  footer actions — "Create and switch to new branch…" (existing `GitBranchCreateDialog` +
  create-and-switch semantics, unchanged) and "View branch graph" (existing `GitGraphDialog`). The
  checkmark marks the same per-mode selection (the current branch is marked when no explicit
  selection exists — it is the value shown).
- **Worktree-occupied branches**: a branch checked out in another worktree cannot be checked out
  here (git refuses), so every switch surface (`GitBranchSwitcher` and the destination list in
  project mode) renders it disabled with a "Checked out in <directory>" hint instead of failing on
  click/at send; in worktree BASE mode the branch stays selectable — a base only needs to exist.
  Occupancy comes from `git worktree list` via `useGitBranchSwitcher` (`worktreeOccupancy`,
  refreshed on open; failures degrade to the old behavior).
- **Semantics**: switch ON registers the worktree intent in the existing slot (`beginCreation` with
  the selected base override — falling back to the workspace's **live** current branch from the git
  summary; HEAD only when no branch can be named, i.e. detached HEAD; a failed branch list does not
  degrade the base to HEAD because the live summary still names the current branch); branch
  selection writes the existing `draftBranchIntent` store; the composer send path, guard (§2), and
  pipeline (composer-worktree-setup-steps.md) are unchanged consumers. Toggling the mode re-labels
  the **shared draft intent** (Task ↔ Base) instead of clearing it; the explicit Base override is
  worktree-mode-only — hidden while the mode is off (it re-defaults on every ON, see the main-branch
  default below) and never applied to the shared checkout.
- **Main-branch default (user decision)**: switching the mode ON immediately **selects** the
  repository's main branch in the Base row — the point the worktree potentially forks from; a
  selection only, never a checkout mutation. Resolution: the project override `defaultBaseBranch`
  when present in the loaded local list, else the default branch derived from the merge-status
  probe's `baseRef` (`origin/HEAD`, e.g. `origin/main` → local `main`) when that branch exists
  locally, else no selection change (the existing current-branch/HEAD fallback stands). The
  popover-open load fetches `getBranchMergeStatus` alongside `getLocalBranches` (the service
  TTL-caches it; a failure degrades to no default and is debug-logged). A manual base pick survives
  while the mode stays on; every OFF→ON transition re-selects the main branch (a deliberate
  re-default of the previous stint's pick). The toggle itself issues no git RPC; detached HEAD with
  a resolvable main branch selects the main branch instead of the HEAD fallback.
- **Workspace isolation**: the control lives in the shell header and stays mounted across workspace
  tab switches, so all per-draft state derived from a workspace's git (cached branch list, base
  selection, list-failure flag, open popover/list views) resets when `workspaceKey` changes.
  Otherwise the previous project's cached branch list survives the switch and its
  `currentBranchName` leaks into the next project's worktree creation as the base branch. The base
  fallback additionally reads the live git summary instead of the cached list, so a base can never
  name a branch the current repo does not have. The reused `useGitBranchSwitcher` machinery receives
  the control's workspace-resolved Git service (never the ambient context service), and its cached
  branch, occupancy, create, and switch-assist state also reset when that Git target changes, since
  remote workspaces on different hosts can share the same path.
- **Git repository visibility**: project selection becomes active first; the composer renders its
  Git destination management only after the shell's Git state belongs to that selected workspace
  identity and reports Git available plus a repository. Initial loading, unknown state, and non-Git
  projects do not render the controls. A previously confirmed repository stays rendered during a
  same-workspace refresh so queued worktree intent is retained; a late response for a previously
  selected workspace cannot satisfy the active workspace key check. Per this presence rule the chip
  must appear for a git-project workspace without a manual reload: if the workspace's initial Git
  refresh is dropped (e.g. a services identity swap during the programmatic open-workspace burst) or
  rejected, the Git hook self-heals — it re-applies or re-issues the refresh on its next evaluation
  (BUG-GWT-013). Refresh failure isolation and same-target stale-state retention follow
  [Git refresh resilience](git-refresh-resilience.md). A rejected refresh is re-issued at most twice
  in a row per workspace identity/path pair (the failure changes no effect dependency, so the hook
  bumps an internal retry tick); after that the error state stands until the next trigger.
- **Branch list freshness**: the destination popover reloads `getLocalBranches` on every open, not
  once per mount. A branch created and switched to through the popover must appear, and be marked
  current, the next time the popover opens. The previous snapshot stays rendered while the reload
  runs (stale-while-revalidate: no loading flicker and no empty state replace it). A response from a
  superseded open or from a previous workspace is dropped by a cancelled flag and never overwrites a
  newer result. A list-failure flag resets on each open, so a failed open retries on the next one.
  The reload is keyed to the open transition and the Git target only; it must not depend on the
  branch-list result itself, or every result would trigger another fetch.
- **Reuse**: `useGitBranchSwitcher` powers branches/create/graph machinery — the control simply
  never calls its `switchBranch` for list selections (intent instead).
- Mockup (visual reference, variant 2):
  `~/.zcode/v2/visualizations/<session>/branch-destination-variants.html`.
