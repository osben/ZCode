# Task hover card layout

Status: implemented (2026-10-15). Covers the sidebar task-row hover card (`TaskSidebarHoverCard`,
`data-task-hover-card`). Supersedes the previous status/workspace/diff stacked layout.
Regression 2026-10-22 (fixed): the grouped row hid its run-state dot on hover/focus, and the regular
row replaced its run-state slot with the Pin action (`hidden` status span). Both are restored by
the leading-slot rule below and acceptance #8-#9.

## Contract

The hover card is a three-line detail view of one task; the sidebar row itself stays the owner of
run-state signaling (spinner, unread dot, markers). Card layout, top to bottom:

1. `[session title] [worktree marker when the task has an execution worktree] [relative time]`
   - Empty titles use the same localized Untitled or Forked Untitled label as the sidebar row.
   - Title truncates; the worktree marker reuses the shared `WorktreeTaskMarker` (glyph, missing
     state, and branch+directory tooltip ownership; specs/worktree-icon-visibility.md).
   - Relative time keeps the existing `formatTaskRelativeTime` format and stays right-aligned.
   - The run-status chip moved out of the card: the row already shows status; the card keeps the
     `data-task-hover-status` attribute for probes.
2. `[branch name] [git change stats]`
   - The branch comes only from `task.executionWorktree.branchName`; workspace-level branch and
     merge probes do not describe an individual task. Change stats (`+N −N`, existing
     `getTaskChangeSummary` source) are right-aligned in the same row and render whenever available.
   - If the task has no execution-worktree branch, the row falls back to the stats-only row with
     the FileDiff glyph so diff facts never disappear silently.
3. `[provider icon when known, else the Cpu chip] [model name] [thought level]`
   - Provider icon resolution is renderer-local: the providerId parsed from `task.model`
     (`parseModelPickerValue`) maps to a bundled brand asset (`providerBrandIconSrc` in
     `@/lib/oauthProviderIcon.tsx`); unknown providers keep the Cpu glyph. The config-driven
     `ProviderLogo` (settings, logo refs) stays the authority for settings surfaces; the sidebar
     does not load provider configs for a hover card.

The workspace row (folder + workspace label) is removed: the card lives inside one workspace
group, so the workspace is context, not content.

Run-state indicators remain visible on the sidebar row while hover/focus actions are shown; opening
the detail card must not hide the running spinner or error/unread marker.
For a mobile-active task, the phone marker occupies the leading status slot while visible; when
hover/focus actions suppress that marker, restore the task's leading run-state indicator in the slot.

Leading-slot owner (regular `TaskListItem` row): the left slot shows one of the phone marker, the
run-state indicator (error, unread, spinner), or the Pin action. One decision picks the Pin position:

- No run state: Pin stays in the left slot on hover/focus (pinned tasks keep it), as before.
- Run state present: the slot keeps the indicator. Pin sits in the right-side action cluster next to
  Archive whenever the cluster is mounted: hover/focus, and always on touch devices (`hover:none`),
  so Pin stays reachable without hover.
- When the run state toggles while Pin has keyboard focus, Pin remounts in its new place. Focus then
  moves to the task row, so keyboard position is kept.
  The grouped row keeps its run-state dot in the trailing metadata cluster beside the action cluster on
  hover/focus. Grouped rows have no phone marker.

## Acceptance scenarios

1. Hovering a completed task shows title + time on line 1, branch + `+N −N` on line 2, provider
   icon + model + thought level on line 3.
2. A worktree task shows the Split marker next to the title; its tooltip still names branch and
   directory; the branch line names the worktree branch even without a merge-status fetch.
3. A task with no branch facts but with diff stats keeps a stats-only line (FileDiff).
4. An unknown provider id falls back to the Cpu glyph; known ids render the brand asset.
5. The run-status chip no longer renders; `data-task-hover-status` still reflects the resolved
   state for tests/probes.
6. Workspace merge status never adds a branch or merged tag to a task hover card; an execution
   worktree displays its own branch.
7. An empty normal or forked task title uses the same localized fallback as its row.
8. Hovering or focusing a running/error task keeps its row status indicator visible beside actions
   in both grouped and regular task rows.
9. A mobile-active unread/error/running task shows its phone marker at rest and its run-state
   indicator when hover/focus actions take the leading slot. Regular task rows only: grouped rows
   have no phone marker.
