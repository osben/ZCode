# Worktree icon visibility

Status: implemented (2026-10-15). This is option 2 of the 2026-10-15 badge study (colored icon + improved tooltip); the slot was reserved by `execution-worktree-missing-handling.md` §4.

## Problem

The task-row worktree marker (GitBranch, `packages/ui/src/workspace-grouped-tasks/task-row.tsx`) inherits the muted row text color, so healthy worktree sessions are nearly indistinguishable from plain rows at a glance. The missing state (destructive color + `taskList.worktreeTaskLabelMissing`) is already implemented and must stay the distinct state on top of the healthy coloring. The healthy tooltip (`taskList.worktreeTaskLabel` "Worktree session · {branch}") also does not say WHICH worktree the session runs in.

## Decisions

1. **Color vehicle — semantic token, not raw palette classes.** New token `--color-worktree-task`, following the `--color-idle-task` pattern and mirroring its full theme coverage:
   - `@theme` (light default, styles.css): `var(--color-violet-600)`
   - `.dark`: `var(--color-violet-400)`
   - `.theme-zai-light`: `#9e77ed` (same value idle-task uses in that theme)
   - `.theme-zai-dark`: `#7b5ce5`
     Registered in `@theme` so Tailwind generates `text-worktree-task`; the component never hardcodes violet scale classes. The one raw-palette precedent in task-row (`bg-sky-500 dark:bg-sky-400` unread dot) is left as-is; new semantic colors take the token route.
     **2026-10-15 amendment (user decision): the sidebar marker is no longer colored.** The healthy marker inherits the row's muted meta color (the `text-foreground-subtle` metadata container) — the glyph (Decision 5, `Split` rotated 90°) carries the distinction on its own; only the missing state keeps `text-destructive` (an error disclosure, not decoration). The `--color-worktree-task` token stays in use by the destination control (worktree-mode trigger + "New worktree" row).
2. **Collision with `--color-idle-task` (both violet) — accepted for v1.** The Moon (off-peak) and GitBranch (worktree) are independent marker slots and can appear on the same row; same hue with different glyphs was the user-approved mockup direction (violet ≈ violet-600 light). A distinct hue can be revisited if real rows show confusion. _(Superseded for the row marker by the 2026-10-15 no-color amendment — an un-colored marker has nothing to collide with.)_
3. **Precedence — missing wins, never additive.** `worktreeIconClassName = cn("size-3.5 shrink-0 rotate-90", isWorktreeMissing && "text-destructive")` — healthy adds no color class at all (it inherits the container's `text-foreground-subtle`). Both chains render through this one shared const. **Position (2026-10-15 user decision, same-day revision):** the marker sits in the meta group next to the clock/off-peak icons — after them, before the time label — styled exactly like them (`size-3.5`, the row's muted meta color, hides on hover with the whole group). An earlier same-day placement ("immediately before the merged badge") was revised to this.
4. **Healthy tooltip names the worktree directory.** The last path segment of `task.executionWorktree.path` (the fork names worktrees `zcode-<slug>`; the absolute path is too long for a marker tooltip) is passed as a new `{directory}` placeholder:
   - `taskList.worktreeTaskLabel`: "Worktree session · {branch} · {directory}"
   - `taskList.worktreeTaskLabelNoBranch`: "Worktree session · {directory}"
     The healthy accessible name reuses the no-branch message and therefore also names the directory. The missing tooltip is unchanged. No existing path-shortening helper in `packages/ui` covered basename display, so the segment helper (both separators, trailing slashes) was added — since extracted to the shared `worktreeDirectoryNameOf` in `components/WorktreeTaskMarker.tsx` and reused by the status panel and branch-occupancy hints.
5. **Glyph — lucide `Split` rotated 90° clockwise (2026-10-15 user decision).** Every worktree-marker slot renders `<Split>` with `rotate-90` (stem on the left, arrows forking to the right — reads as "a separate checkout forking off the project"): the sidebar task-row marker (both render chains, rotation folded into the shared `worktreeIconClassName`) and the destination control's worktree-mode trigger + "New worktree" row (formerly `GitBranchPlus`). `GitBranch` stays the glyph for plain branch contexts (project-mode trigger, branch rows, queued-message label); missing/healthy coloring and tooltips are unchanged.

## Scope

Render-only: token, task-row shared consts, and the three locale catalogs (`en-US`, `zh-CN`, `uk-UA`). No protocol, schema, or row-equality changes (`useWorkspaceActiveTaskState.ts` untouched — color and tooltip are not compared fields).

## Validation

- Source-contract test `packages/ui/test/worktreeTaskRowMarker.test.ts`: both chains render the shared marker; the missing state selects `text-destructive` and the healthy state selects no color class at all (per the 2026-10-15 no-color amendment, superseding the earlier `text-worktree-task` healthy treatment).
- i18n catalog parity (`i18nCatalogParity.test.ts`) — the new `{directory}` placeholder must match across locales.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, oxfmt on touched files.

## Out of scope

- A distinct hue for the worktree marker (moot — the marker is un-colored since 2026-10-15; only missing stays destructive).
- A `-surface` companion token (the marker is a text-colored icon; no chip background).
- Changing the glyph size, or the missing-state treatment (the glyph itself is decided — Decision 5).
- Realtime/E2E coverage of the tooltip content beyond the source contract.
