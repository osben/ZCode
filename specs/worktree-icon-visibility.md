# Worktree icon visibility

Status: implemented. This is option 2 of the 2026-10-15 badge study (colored icon + improved
tooltip); the slot was reserved by `execution-worktree-missing-handling.md` §4.

## Problem

The task-row worktree marker (`packages/ui/src/workspace-grouped-tasks/task-row.tsx`) must
distinguish healthy worktree sessions from plain rows at a glance, and the healthy tooltip must say
which worktree the session runs in. The missing state (destructive color +
`taskList.worktreeTaskLabelMissing`) is the distinct state on top of the healthy coloring.

## Decisions

1. **Color vehicle — semantic token, not raw palette classes.** Token `--color-worktree-task`,
   following the `--color-idle-task` pattern with full theme coverage: `@theme` (light default,
   styles.css) `var(--color-violet-600)`; `.dark` `var(--color-violet-400)`; `.theme-zai-light`
   `#9e77ed` (the value idle-task uses in that theme); `.theme-zai-dark` `#7b5ce5`. Registered in
   `@theme` so Tailwind generates `text-worktree-task`; components never hardcode violet scale
   classes. The healthy sidebar marker is not colored: it inherits the row's muted meta color (the
   `text-foreground-subtle` metadata container); only the missing state keeps `text-destructive` (an
   error disclosure, not decoration). The token stays in use by the destination control
   (worktree-mode trigger + "New worktree" row). The one raw-palette precedent in task-row
   (`bg-sky-500 dark:bg-sky-400` unread dot) is left as-is; new semantic colors take the token route.
2. **Collision with `--color-idle-task` (both violet) — accepted for v1** where both markers are
   colored: the Moon (off-peak) and GitBranch (worktree) are independent marker slots that can
   appear on the same row, and same hue with different glyphs was the approved mockup direction.
   Moot for the row marker after the no-color amendment: an un-colored marker has nothing to collide
   with. A distinct hue can be revisited if real rows show confusion.
3. **Precedence — missing wins, never additive.** `worktreeIconClassName = cn("size-3.5 shrink-0
rotate-90", isWorktreeMissing && "text-destructive")` — healthy adds no color class at all. Both
   render chains render through this one shared const. Position: in the meta group next to the
   clock/off-peak icons — after them, before the time label — styled exactly like them (`size-3.5`,
   the row's muted meta color, hides on hover with the whole group).
4. **Healthy tooltip names the worktree directory.** The last path segment of
   `task.executionWorktree.path` (the fork names worktrees `zcode-<slug>`; the absolute path is too
   long for a marker tooltip) is passed as a new `{directory}` placeholder:
   `taskList.worktreeTaskLabel`: "Worktree session · {branch} · {directory}";
   `taskList.worktreeTaskLabelNoBranch`: "Worktree session · {directory}". The healthy accessible
   name reuses the no-branch message and therefore also names the directory. The missing tooltip
   retains the branch/directory label and appends the blocked-actions error, so the unavailable
   target stays identifiable. The segment helper (both separators, trailing slashes) lives as the
   shared `worktreeDirectoryNameOf` in `components/WorktreeTaskMarker.tsx`, reused by the status
   panel and branch-occupancy hints.
5. **Glyph — lucide `Split` rotated 90° clockwise.** Every worktree-marker slot renders `<Split>`
   with `rotate-90` (stem on the left, arrows forking to the right — "a separate checkout forking
   off the project"): the task-row marker (both render chains, rotation folded into the shared
   `worktreeIconClassName`) and the destination control's worktree-mode trigger + "New worktree"
   row. `GitBranch` stays the glyph for plain branch contexts (project-mode trigger, branch rows,
   queued-message label).
6. **Durability — the fact is persisted in task meta; the live overlay stays the freshness source.**
   `executionWorktree` is an optional field of `zcodeTaskMetaSchema`
   (`packages/shared/src/validation.ts`, shape reused from `zcodeExecutionWorktreeSchema`) and is
   converged into tasks-index `meta_json` at the Host sessions-index boundary
   (`windowHostControllerService` overlay ingest, local scopes; idempotent `meta_json`-only update
   through the task service read path). The live sessions-index overlay remains the source of
   freshness while the workspace host runs; persisted meta is the source of durability. Later
   runtime snapshot syncs preserve the fact (preserve-on-absent in `syncTaskMeta`, same strategy as
   cron/off-peak identity), so a restart no longer drops the marker for sessions of closed
   workspaces. `executionWorktreeMissing` stays a live-only projection (computed against disk by the
   running host) and is not persisted. Convergence acknowledgement is per fact and bound to the
   task-service instance: a fact is marked synced only after the returned task row carries it (a
   sessions-index summary that arrives before its task-index row stays pending and is retried on the
   next publish), a replaced task service starts from an empty acknowledgement set, and the observer
   resolves the current task service at publish time. The repo applies each fact in a
   `BEGIN IMMEDIATE` transaction so a concurrent Host's newer `meta_json` is never overwritten by a
   stale read.

## Scope

Render-only for the marker: token, task-row shared consts, and the three locale catalogs (`en-US`,
`zh-CN`, `uk-UA`). No protocol, schema, or row-equality changes (`useWorkspaceActiveTaskState.ts`
does not compare color or tooltip fields). Decision 6 adds the optional `executionWorktree`
persistence field to `zcodeTaskMetaSchema` — an additive meta-key; no wire protocol, migration, or
row-equality change.

## Validation

- Source-contract test `packages/ui/test/worktreeTaskRowMarker.test.ts`: both chains render the
  shared marker; the missing state selects `text-destructive` and the healthy state selects no color
  class at all.
- i18n catalog parity (`i18nCatalogParity.test.ts`): the new `{directory}` placeholder must match
  across locales.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, oxfmt on touched files.

## Out of scope

- A distinct hue for the worktree marker (moot — the marker is un-colored; only missing stays
  destructive).
- A `-surface` companion token (the marker is a text-colored icon; no chip background).
- Changing the glyph size, or the missing-state treatment (the glyph itself is decided — Decision 5).
- Realtime/E2E coverage of the tooltip content beyond the source contract.
