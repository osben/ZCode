# Task hover card layout

Status: implemented (2026-10-15). Covers the sidebar task-row hover card (`TaskSidebarHoverCard`,
`data-task-hover-card`). Supersedes the previous status/workspace/diff stacked layout.

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
   - Branch source precedence: `task.executionWorktree.branchName` (authoritative for worktree
     sessions) then `branchMergeStatus.headRef`. Merged state keeps the GitMerge glyph and the
     merged tag only when the merge status head matches the selected worktree branch. Otherwise
     show the worktree branch as unmerged. Change stats (`+N −N`, existing `getTaskChangeSummary` source) are right-aligned
     in the same row and render whenever available, not only when merged.
   - If no branch source exists, the row falls back to the stats-only row with the FileDiff glyph
     so diff facts never disappear silently.
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

## Acceptance scenarios

1. Hovering a completed task shows title + time on line 1, branch + `+N −N` on line 2, provider
   icon + model + thought level on line 3.
2. A worktree task shows the Split marker next to the title; its tooltip still names branch and
   directory; the branch line names the worktree branch even without a merge-status fetch.
3. A task with no branch facts but with diff stats keeps a stats-only line (FileDiff).
4. An unknown provider id falls back to the Cpu glyph; known ids render the brand asset.
5. The run-status chip no longer renders; `data-task-hover-status` still reflects the resolved
   state for tests/probes.
6. A worktree whose branch differs from the workspace merge-status head displays its own branch and
   no merged tag; a matching worktree branch displays the merged tag.
7. An empty normal or forked task title uses the same localized fallback as its row.
8. Hovering or focusing a running/error task keeps its row status indicator visible beside actions
   in both grouped and regular task rows.
