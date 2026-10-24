# Manage sessions: full-screen sessions table (ZCO-34, Copilot /recent analog)

Status: implemented 2026-10-16 on feat/zco34-manage-sessions.

## Problem

Session management is scattered across per-workspace sidebar sections (pinned, active, archived flat lists) and `TaskSearchDialog`: no columns (status, changes, branch, environment, model), no bulk archive/delete, no cross-workspace grouping. Copilot's full-screen `/recent` table is the reference UX. The existing data layer suffices:

- `listTaskList(ZCodeTaskListQuery)` — `packages/services/src/session/zcodeTaskListTypes.ts`: kinds `pinned | archived | timeline | active`, multi-workspace `workspaceScopes`, `search`, `sortBy: created | updated`, `limit`/`hasMore`. UI hook `useGlobalTaskList` (`packages/ui/src/hooks/useGlobalTaskList.ts`); shared cache/delta invalidation `windowControllerTaskListRegistry.ts` (subscribes `CONTROLLER_TASKS_INDEX_TOPIC`, invalidates cached queries per membership kind). `queryTaskList` (`packages/services/src/session/taskIndexRepo.ts`) matches `LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?` — a case-insensitive substring scan, not FTS5.
- Row shape `WindowHostControllerTaskRow` — `packages/shared/src/zcode-protocol-v4/controller.ts`: `meta` (title, createdAt/updatedAt, model, provider, `changeSummary {fileCount, added, removed}`, `executionWorktree {path, branchName?}` + top-level `executionWorktreeMissing`, cronAutomationId, offPeakTaskId), `membership {pinned, archived, active}`, `sourceAvailability online|offline`, `liveStatus idle|running|waiting|completed|error`, `activity`.
- Membership semantics (`matchesTaskListMembershipKind`, `controller.ts`): `active = !archived` (includes pinned), `pinned = pinned && !archived`, `archived = archived`.
- Controller mutations `WindowHostControllerMutation` (`windowController.ts`): `pin | archive | delete | delete-archived | mark-read | mark-unread | open | resume`; `open`/`resume` are source-validation no-ops Host-side. The UI mutates through per-workspace `zcodeTaskService` (`setTaskPinned`, `archiveTask`, `unarchiveTask`, `deleteTask`, `deleteArchivedTask(s)`, `renameTask`), resolved via `buildWorkspaceServiceLookup` (`packages/ui/src/lib/workspaceServiceResolver.ts`); local workspaces resolve through base services, remote ones require a live remote session.
- Known gaps (drive the non-goals): no PR data, no `archived_at` timestamp (boolean only), no per-task disk size, token usage is per-session RPC only, no table primitive in `components/ui` (heavy lists use `@tanstack/react-virtual`).

## Goals

- One full-screen surface in the main window to browse, filter, and manage sessions across workspaces, scoped to one workspace when entered from its project menu.
- v1 column set, filters, grouping, row actions, bulk archive/delete with Copilot-parity pinned-exclusion; read-only over existing RPC (mutations only through existing task-service ops).
- Per-device view-state persistence (localStorage), zero new stores, zero DB/protocol changes.

## Non-goals (v1)

- PR columns (Branch-or-PR, Checks, Approval) — no GitHub data layer exists.
- Disk usage column — follow-up slice (§12).
- Automatic-cleanup settings entry — separate issue, blocked on `archived_at`.
- Token usage column (per-session RPC only; would be N calls).
- Search-snippet rendering in rows.
- Any change to sidebar behavior, task-list wire schema, or database.

## Contract

### 1. Hosting and entry points

- The manager is a Settings section: `sessions` in the `dataAndStats` group. The settings shell owns sidebar, back-to-workspace, breadcrumb, title, window chrome; the section renders scope chip, search, columns menu, filter bar, table, bulk bar, delete dialog. No dedicated back contract — the Settings shell's "Back to workspace" is it.
- Navigation uses the settings intent mechanism (`packages/ui/src/lib/settingsNavigation.ts`): `setPendingSettingsSectionIntent("sessions", { sessionsScope })` + the same-window intent event, mirroring the plugin/usage intents.
- Entries:
  1. Project action menu (workspace `⋯` menu, `WorkspaceSidebarItem.tsx`) → **"Manage sessions"**: intent with **workspace scope** `{workspacePath, workspaceIdentity}`, opens Settings on the sessions section (Copilot parity).
  2. **Command Center / quick pick**: `manage-sessions` command opens the section **unscoped**.
- Reopening re-uses the live Settings page through the intent event and replaces the scope. Scope is ephemeral navigation state (sessionStorage intent consumed once, then section-local until cleared with the chip ✕); it does not survive leaving Settings. Workspace-tab persistence is untouched (the manager is not a tab); table view state lives in `zcode.sessionManager.view.v1` (§5).

### 2. Data flow (read-only, single owner)

- Rows come from the existing sessions-index projection through **`useGlobalTaskList` reused as-is**: one multi-scope `listTaskList` query per membership kind via the shared registry (caches per query key, invalidates by membership). The manager creates no second store.
- Workspace universe:
  - _Scoped mode_ (project-menu entry): exactly one scope — the entry workspace `{workspacePath, workspaceIdentity}`.
  - _Unscoped mode_ (Command Center entry): open workspace tabs ∪ the entry workspace (if any) ∪ `recentProjects` from app settings (local paths, capped at 10). Deliberate v1 bound: no UI-side enumeration of "all workspaces with sessions" exists (`queryTaskList` returns empty for empty scopes; the registry discards `CONTROLLER_WORKSPACES_TOPIC` payloads). Consequence: a workspace whose sessions exist but was never opened or recent is not listed until opened. A true all-workspaces enumeration is a follow-up (§12).
  - Pseudo-tab shapes feed `useGlobalTaskList.workspaceTabs` (needs only `{workspacePath, workspaceIdentity?, remoteSessionId?}`).
- Status filter maps to list kinds: `Active` (default) → `kind: "active"` (pinned included); `Archived` → `kind: "archived"`; `All` → both hooks merged and tagged by row `membership.archived`.
- Search forwards to the query's `search` param (debounced 250 ms). It is a LIKE scan over `title`/`searchable_text`, not an FTS index.
- Load strategy: unbounded within the universe (`expanded: true`) — universe is small and `sortBy` orders server-side. No load-more UI in v1.
- Live updates: no polling — registry revision bumps on controller frames re-run the hooks; externally deleted rows disappear from table and selection.
- Worktree fact durability: `meta.executionWorktree` is persisted in tasks-index `meta_json` (optional `zcodeTaskMetaSchema` field) and converged from the live sessions-index overlay at the Host boundary while the workspace host runs (local scopes; idempotent, `meta_json`-only, preserved by later runtime syncs). The Environment filter (§3) and Branch/Environment columns classify worktree sessions correctly after restart even for still-closed workspaces: the live overlay is the freshness source, persisted meta the durability source.
- Mutations go through per-workspace `zcodeTaskService` resolved by `buildWorkspaceServiceLookup(scopes, baseServices, remoteSessionSessionStoreState)` — the `WorkspaceArchivedTasksFlatSection.tsx` pattern — followed by `applyTaskQueryCacheMutation` / `removeTaskFromTaskCaches` so sidebar caches stay coherent. `sourceAvailability: "offline"` rows render dimmed with mutations disabled (`isWorkspaceReadOnly` reason pattern, `tabStore.ts`). Rows whose workspace resolves to no services (remote workspace with no live session) render but are action-disabled.
- Sorting: `sortBy` supports `created | updated` end-to-end; **Name** sort is client-side within groups. Default: Updated desc.

### 3. Layout

The section renders inside the Settings content frame; the section-local header keeps scope chip, search, Columns menu. Three stacked regions (toolbar row, filter bar ~44px, table flex-1):

1. **Toolbar row** (`bg-header`, `border-b border-border`): removable **scope chip** when workspace-scoped (folder icon + workspace name; ✕ clears scope → unscoped view; not persisted), spacer, search input (~230px, `/` shortcut focus), Columns button (popover with per-column checkboxes, persisted). Title and Back belong to the Settings shell.
2. **Filter bar**: segmented dropdowns **Status** (Active/Archived/All; default Active), **Environment** (All/Local/Worktree; client-side on `executionWorktree` presence), **Type** (All/Session/Cron/Off-peak; client-side on `cronAutomationId`/`offPeakTaskId`), **Pinned** toggle chip (client-side `membership.pinned`; no-op under Status=Archived), **Reset filters** (appears when any filter deviates from default), right-aligned count "N sessions · X running" (running = liveStatus `running|waiting`).
3. **Table**: grouped rows (§6), virtualized with `@tanstack/react-virtual` over the flattened group-header+row model; sticky thead (`bg-header`, 32px, `text-ui-xs text-foreground-subtle`); dense single-line rows (34px, `border-b border-border`), hover `bg-surface-hover`, selected `bg-selected`. Minimum table width ~1060px with horizontal scroll below that.

Empty states: zero workspaces in scope → centered hint with the unscoped explanation; no sessions after filters → "No sessions match these filters"; no sessions at all → "No sessions yet"; loading → the existing `TaskListLoadingHint` idiom.

Accessibility: real `<table>`-shaped grid with `role="row"` on virtualized rows; every row focusable (`tabIndex={0}` in DOM order — no roving-tabindex machinery) and activates on Enter/Space; checkboxes, menu buttons, pin toggle are standard controls with `aria-label`s; selection count bar is `aria-live="polite"`.

### 4. Columns (v1)

| #   | Column      | Source                                      | Rendering                                                                                                                   | Default                                     | Sort   |
| --- | ----------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------ |
| 1   | Selection   | —                                           | Checkbox; header = select-all-in-view (indeterminate on partial)                                                            | always                                      | —      |
| 2   | Pinned      | `membership.pinned`                         | Pin icon button; filled amber when pinned; click = `setTaskPinned` toggle                                                   | on                                          | —      |
| 3   | Name        | `meta.title` (fallback `taskList.untitled`) | `text-ui-base`; inline rename (§7)                                                                                          | on                                          | client |
| 4   | Status      | `liveStatus`                                | Pill 20px: Running (success, pulsing dot) / Waiting (warning) / Idle (neutral) / Done (subtle) / Error (destructive)        | on                                          | —      |
| 5   | Type        | `cronAutomationId` / `offPeakTaskId`        | Icon+label, sidebar vocabulary: message-square Session / clock Cron / moon Off-peak                                         | on                                          | —      |
| 6   | Changes     | `meta.changeSummary`                        | Mono tabular `+added −removed` in success/destructive; `—` when both zero or summary absent                                 | on                                          | —      |
| 7   | Branch      | `executionWorktree.branchName`              | Mono `text-ui-xs` + git-branch glyph; `—` when absent; `executionWorktreeMissing` → destructive "missing" text with tooltip | on                                          | —      |
| 8   | Environment | `executionWorktree` presence                | `Worktree` bordered chip / `Local` plain text — **neutral colors** (violet stays reserved per the worktree-icon decision)   | on                                          | —      |
| 9   | Model       | `meta.model` display name                   | `text-ui-sm text-foreground-subtle`                                                                                         | on                                          | —      |
| 10  | Updated     | `meta.updatedAt`                            | Relative time (`formatTaskRelativeTime`)                                                                                    | on                                          | server |
| 11  | Created     | `meta.createdAt`                            | Short date                                                                                                                  | on                                          | server |
| 12  | Path        | `meta.workspacePath`                        | Mono `text-ui-xs` truncated, full path in tooltip                                                                           | **off when workspace-scoped**, on otherwise | —      |
| 13  | Row menu    | —                                           | `⋯` ghost button → context menu (§7)                                                                                        | always                                      | —      |

Column visibility persists per device (§5). Child-session counts and workflow-run lines are not columns in v1.

**Model label.** `meta.model` is the raw selection `providerId/modelName` (e.g. `account:zai-individual-coding-plan/GLM-5.3`). The cell renders only the model name (part after the last `/`, via `formatSessionManagerModelLabel`); the full raw value stays in the tooltip. Values without `/` render unchanged; empty values render `—`.

**Empty data columns auto-hide.** `changes`, `branch` and `pullRequests` are hidden from the rendered grid while no row in the current view has data for them (`changes`: some row has non-zero `changeSummary`; `branch`/`pullRequests`: some row has `executionWorktree` — the only rows PR probing targets, `useSessionManagerPullRequests`). Render-time reduction of the persisted `columns` list (`resolveSessionManagerVisibleColumns`): persisted state is never rewritten, the Columns menu still lists the user's choice, and the column returns as soon as a row with data appears. PR probing stays inactive while its column is hidden.

### 5. View state ownership

One namespaced localStorage JSON key `zcode.sessionManager.view.v1` (per device, never broadcast, never `setting.json` — fork-unsafe storage rule): `{ status, environment, type, pinnedOnly, sort: {column, direction}, columns: string[], collapsedGroups: string[] }`. Search deliberately not persisted (ephemeral, like Copilot's session filter typing). Parse is defensive (unknown fields dropped, defaults per §3/§4); malformed JSON falls back to defaults silently on read.

### 6. Grouping

- Rows group by workspace key `buildTaskWorkspaceKey(workspacePath, workspaceIdentity)` (`packages/ui/src/lib/taskQueryCache.ts`) — identity-first with path fallback, the uniform repo rule.
- Group header row (34px, `bg-background`): chevron, folder glyph, workspace name (medium), path (mono, subtlest), count "N sessions · X active". Click toggles collapse.
- Groups sort by most recent row `updatedAt` desc; rows inside a group follow the active sort. Collapsed state persists in the view key.
- Workspace-scoped view: exactly one group, header still rendered (counts stay truthful), not collapsible.
- Pinned sessions are not a separate section — rows with a filled pin; the Pinned filter isolates them.

### 7. Row actions

Context menu on the row / `⋯` button:

- **Open** — standard select path (`activateTabByPath(path, {workspaceIdentity})` + task selection, the `useWorkspaceTaskNavigation` composition). Open navigates the session's workspace; Settings stays open, the user returns via the shell's back control. Disabled for offline rows. Offered for archived rows too (opening history is read-only).
- **Rename** — inline input replacing the Name cell; Enter/blur commits via `zcodeTaskService.renameTask`, Esc cancels; empty commits fall back to the untitled label. Allowed for running sessions: rename rewrites the indexed title (`title_overridden`); a running session's auto-titling may overwrite a manual name on its next turn — accepted caveat.
- **Pin / Unpin** — `setTaskPinned` toggle.
- _separator_
- **Show in Finder / File Manager** (platform label) — `useTaskListItemContextActions` path.
- **Copy path** — workspace path copy idiom.
- _separator_
- **Archive** / **Restore** (archived rows) — `archiveTask` / `unarchiveTask`; reversible, no confirmation.
- **Delete** — destructive, always confirmed via the §8 dialog. Persists an internal tombstone, then permanently erases the conversation tree and removes eligible execution worktree folders; branches and aggregate usage remain. Full ownership, running guards, remote gating and partial-result semantics: `specs/session-deletion-cascade.md`. No optional erase checkbox.

### 8. Bulk selection

- Checkbox selection is ephemeral; deleting/archiving a selected row removes it from selection; externally removed rows drop out via projection deltas.
- With ≥1 selected, a floating bulk bar (`bg-card border border-border rounded-lg shadow-lg`, bottom-center) shows: "N selected" · **Archive** · **Delete** · clear (✕).
- **Bulk Archive**: no confirmation (reversible). Loops `archiveTask`; partial failures surface one error toast and keep the bar.
- **Bulk Delete**: always opens the confirm dialog (Copilot `BulkDeleteSessionsDialog` parity: `bulk-delete.includePinned` flag, pinned excluded by default):
  - Title "Delete N sessions?"; body explains permanent conversation-tree deletion, eligible worktree cleanup, retained Git branches and aggregate usage. Child counts and dirty-file previews follow the shared deletion spec.
  - Compact list of up to 5 selected rows (icon: pin when pinned / git-branch when worktree / message-square otherwise) + "+N more".
  - Pinned rows in the selection: checkbox "Include N pinned session(s)", **unchecked by default**; confirming with it unchecked deletes only the non-pinned subset (counts update). Pinned rows cannot be deleted without the explicit opt-in.
  - Execution: non-archived rows → loop `deleteTask` (no plural tombstone op exists; per-task failures collected); archived rows → `deleteArchivedTasks` batch per workspace (its still-archived guard makes it race-safe: rows restored elsewhere are skipped and reported). Successfully tombstoned rows then pass through the shared permanent erase and worktree-cleanup flow. Known running trees block before the mutation; late failures are reported by category and remain retryable. Remote/read-only/unsupported selections cannot silently fall back to hiding. The table reflects persisted tombstones.
  - Confirm button label "Delete K" (K = rows actually deleted), destructive styling.

### 9. i18n

All user-facing strings under the `sessionManager.*` namespace in `en-US`, `zh-CN`, `uk-UA`: title, filter labels and values, column headers, count sentences (correct plurals — uk-UA three-form Slavic), row-menu items, bulk bar, delete dialog (title, body, pinned-inclusion with plural categories, confirm/cancel), empty states, offline reason (reuses existing `workspaceSidebar.unavailableLocalDirectory`). The `i18nCatalogParity` test enforces key parity across locales. No hardcoded strings in components.

### 10. Performance

- Virtualization over the flattened row model; row components memoized on stable row identity (`workspaceKey::taskId`) + the fields each cell renders.
- Search debounce 250 ms; LIKE scans are the Host's cost, one per debounce tick per kind.
- No polling, no timers; all updates ride registry revisions.

### 11. Tests

- **Unit** (colocated vitest, `*.test.ts`): view-state parse/defaults/unknown-field dropping; model reductions — status-kind mapping, client filters (environment/type/pinned), sorts, identity-key grouping incl. remote identity fallback, select-all keys; delete-candidate arithmetic (mixed pinned selection, pinned-only selection → confirm disabled until opt-in, archived/non-archived split).
- **Contract**: `zcode.sessionManager.view.v1` shape snapshot (guards accidental key renames).
- **E2E**: bulk flows deferred to the CI e2e lane (local mac e2e blocked by onboarding harness constraints); tracked in the issue.

### 12. Follow-up slices (same issue, after v1)

- **Disk column**: per-task disk size (Host-side async stat of `v2/sessions/<hash>/<taskId>.json` + worktree dir for visible rows only; Copilot-style relative bars; tooltip "Files: x · Conversation: y"). Needs its own spec addendum.
- **True all-workspaces enumeration**: consume workspace-fact frames or add a `listTaskList` wildcard (protocol change) — replaces the §2 universe bound.

### 13. Compatibility

- Read-only over existing RPC; all mutations are existing task-service ops — additive UI only, no wire/DB changes, no migrations.
- Old CLI + new UI: all consumed fields already exist; remote/offline workspaces render action-disabled, not hidden.
- Fork safety: single namespaced localStorage key; no `setting.json` keys; no fork\_/upstream DB surface.

## Acceptance scenarios

1. Project menu "Manage sessions" on workspace W opens Settings on the sessions section scoped to W (chip visible, Path column hidden); clearing the chip shows the universe grouped by workspace key; nothing view-related persists across app restart except §5 preferences.
2. Status=Archived shows only archived rows with Restore in the menu; Restore returns the row to the Active view without reload.
3. Deleting a stopped session erases its session content, removes the row immediately, and the tombstone keeps it from resurrecting after restart.
   3a. Deleting a session whose tree is known to be running is blocked before tombstoning; the row and its content are untouched.
4. Bulk-selecting 3 rows of which 1 is pinned: dialog shows "Include 1 pinned session" unchecked; confirming deletes 2 rows and keeps the pinned row.
5. Filter/sort/columns/collapse state survives an app restart on the same device and does not appear on another device (no broadcast).
6. Offline remote workspace: rows render dimmed with disabled mutations and a read-only reason; nothing throws.
7. A workspace in `recentProjects` that has no open tab appears in the unscoped view (read + local mutations); a remote workspace without a live session renders rows action-disabled.

## Resolved open questions

Opening a row delegates to the shared existing-session navigation callback. A closed local project is validated and opened before selecting its existing task; no new draft is created. Remote targets require their exact live attachment and never probe the local filesystem. An unavailable project leaves Settings visible with an error. Archived disables Pinned and ignores its predicate while retaining the Active preference for the return transition. Inline rename for running sessions: allowed (§7), auto-title overwrite caveat accepted. Sorts: default Updated desc; server sorts on Updated/Created, client sort on Name; no Status sort in v1. Hosting: `sessions` section in `dataAndStats`, not a main-window tab, not persisted (§1).
